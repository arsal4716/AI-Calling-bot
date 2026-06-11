# Removing Twilio — Implementation Plan (review-first scaffold)

Goal: run the entire call **inside Asterisk** — VICIdial → Asterisk → AI bot →
transfer to agent — with **no Twilio** anywhere. This eliminates the caller-ID
problem at the root: the customer stays a native Asterisk channel, so the agent
always sees the real number, and there is no PSTN/caller-ID restriction to fight.

This document + the scaffolded modules are for **review before cut-over**. The
live Twilio path keeps working until we flip a switch.

---

## 1. Target architecture

```
VICIdial (144.76.120.120)
  │  dials SIP/77777@Testpeers  (adds X-VICIdial-Lead-Id, X-VICIdial-Caller-Id)
  ▼
Asterisk (76.13.192.150)
  │  exten 77777 → Stasis(ai-bot, ${LEADID}, ${AGENTUSER}, ${CALLERID(num)})
  ▼
Node ARI app "ai-bot"  (services/AriService.js)
  │  • answers caller, reads X-VICIdial-Caller-Id  = REAL customer #
  │  • mixing bridge: [caller] + [AudioSocket leg]
  ▼
AudioSocket TCP server (websockets/AudioSocketServer.js, port 9092)
  │  slin 8 kHz audio  ⇄  TwilioCompatAdapter  ⇄  existing MediaStreamHandler
  │  (Deepgram STT · OpenAI · ElevenLabs TTS — UNCHANGED)
  ▼  qualified →
AriService.transfer():
     originate PJSIP/${AGENTUSER}@vicidial-outbound  callerId = REAL customer #
     add agent to bridge, drop AudioSocket leg
  ▼
VICIdial → Agent rings, sees REAL customer number ✅  (no Twilio, no spoofing)
```

### Why almost nothing in the bot changes
The `MediaStreamHandler` only touches its socket through a tiny surface
(`ws.on("message")` for `start`/`media`/`stop`, `ws.send()` for `media`/`clear`).
`TwilioCompatAdapter` reproduces that surface on top of an AudioSocket
connection, translating slin ⇄ µ-law at the edge. So the ~2,500 lines of
qualification/conversation logic, Deepgram, ElevenLabs, OpenAI, dispositions —
**all reused as-is**.

---

## 2. New files (scaffolded in this branch)

| File | Purpose | Status |
|---|---|---|
| `utils/g711.js` | µ-law ⇄ slin conversion | ✅ done + unit-tested |
| `websockets/AudioSocketServer.js` | TCP AudioSocket transport | ✅ done |
| `websockets/TwilioCompatAdapter.js` | makes AudioSocket look like a Twilio WS | ✅ done |
| `services/AriService.js` | ARI control + native transfer | ✅ scaffold (verify ARI params) |

These are **not yet wired into `server.js`** — wiring is Phase 3 below.

---

## 3. Wiring (Phase 3 — small, in `server.js`)

```js
const { AudioSocketServer } = require("./websockets/AudioSocketServer");
const TwilioCompatAdapter = require("./websockets/TwilioCompatAdapter");
const AriService = require("./services/AriService");

if (process.env.CALL_TRANSPORT === "asterisk") {
  const audioServer = new AudioSocketServer().listen(9092, "127.0.0.1");
  const ari = new AriService();

  // pendingAudioUuid -> resolve the AudioSocket connection to a call
  const waiting = new Map();          // audioUuid -> { callLogId, channelId }

  ari.onCall = async (channelId, meta) => {
    // create/find the CallLog for this VICIdial call (leadId = meta.leadId)
    const callLog = await CallLog.create({
      leadId: meta.leadId,
      fromNumber: meta.customerCid,
      status: "in_progress",
      direction: "outbound",
      // campaign lookup as today
    });
    waiting.set(meta.audioUuid, { callLogId: callLog._id, channelId });
  };

  audioServer.on("call", (conn) => {
    const w = waiting.get(conn.id);
    if (!w) { conn.hangup(); return; }
    waiting.delete(conn.id);
    const adapter = new TwilioCompatAdapter(conn, { streamSid: conn.id });
    // Reuse the existing handler exactly as if Twilio connected:
    mediaHandler.wss.emit("connection", adapter, { url: `/media-stream/${w.callLogId}` });
    adapter.begin({ customParameters: { "X-Asterisk-UniqueID": w.channelId } });
    adapter._ariChannelId = w.channelId;   // for transfer
  });

  ari.start();
}
```

`MediaStreamHandler` needs **one** transport-aware branch in `_maybeTransferCall`
(already mode-switched): when `TRANSFER_MODE === "ari"`, call
`ari.transfer(channelId, agentUser)` instead of Twilio. Pass the `ari` instance
+ channel id into the handler (constructor option or via the adapter).

No other handler changes are required for the happy path.

---

## 4. Asterisk-side changes

### 4a. Dialplan — `[from-vicidial]` (already Stasis; keep it)
```asterisk
[from-vicidial]
exten => 77777,1,NoOp(=== VICIDIAL CALL IN uid=${UNIQUEID} ===)
 same => n,Answer()                       ; (ARI also answers; harmless)
 same => n,Stasis(ai-bot,${PJSIP_HEADER(read,X-VICIdial-Lead-Id)},${FILTER(0-9,${CALLERID(num)})},${CALLERID(num)})
 same => n,Hangup()
```
The `h` extension dispo-update block stays exactly as you have it (the bot still
writes `/tmp/ai_dispo/lead_<id>` before hangup).

### 4b. `[from-twilio-transfer]` → rename mentally to "agent transfer"
Still used: `AriService.transfer()` dials `PJSIP/<agent>@vicidial-outbound`
directly, so the `from-twilio-transfer` context is no longer on the path. Keep it
for the interim SIP fallback; it does no harm.

### 4c. Enable ARI — `/etc/asterisk/ari.conf`
```ini
[general]
enabled = yes
[ai-bot]
type = user
password = <set ARI_PASS to this>
```

### 4d. HTTP server — `/etc/asterisk/http.conf`
```ini
[general]
enabled = yes
bindaddr = 127.0.0.1
bindport = 8088
```

### 4e. Modules
Ensure `res_ari.so`, `res_ari_channels.so`, `res_stasis.so`,
`chan_audiosocket.so` / `res_audiosocket.so`, and `app_audiosocket.so` are
loaded (`asterisk -rx "module show like audiosocket"`,
`... like ari"`). AudioSocket needs Asterisk 18+.

### 4f. Env (Node, AI box)
```
CALL_TRANSPORT=asterisk        # opt-in switch; absent/“twilio” = current path
TRANSFER_MODE=ari
ARI_HOST=127.0.0.1
ARI_PORT=8088
ARI_USER=ai-bot
ARI_PASS=<ari.conf password>
ARI_APP=ai-bot
AUDIOSOCKET_HOST=127.0.0.1:9092
```

---

## 5. Features Twilio provided that we must rebuild

| Feature | Twilio did it via | Asterisk replacement |
|---|---|---|
| **AMD** (answering-machine detection) | `machineDetection` on the call | `AMD()` in dialplan **before** `Stasis()`, set a channel var, read it in `AriService._onStasisStart` and pass to the session; the bot already has AMD-style heuristics as backup. |
| **Call recording** | `startCallRecording()` | `MixMonitor(/var/spool/asterisk/monitor/${UNIQUEID}.wav)` in dialplan, or ARI `POST /channels/{id}/record`. |
| **Hangup** | Twilio call update | `conn.hangup()` (AudioSocket) or ARI `DELETE /channels/{id}`. |
| **Barge-in "clear"** | Twilio `clear` flushes playout | AudioSocket has no flush; stopping new frames already cuts Anna off (a few buffered frames drain). If tighter barge-in is needed, switch the media leg to ARI external-media RTP + `POST /channels/{id}/play` control. Note as a known minor difference. |

`TwilioService` stays in the repo but is **only** used when
`CALL_TRANSPORT !== "asterisk"`.

---

## 6. Phased rollout

1. **Phase 0 (done):** scaffold modules + this plan. Twilio path untouched.
2. **Phase 1:** stand up ARI + AudioSocket on a **test** DID/extension. Verify a
   call reaches `onCall`, the AudioSocket connects with the right UUID, and
   two-way audio works (echo test before wiring the AI).
3. **Phase 2:** wire `TwilioCompatAdapter` → `MediaStreamHandler`; run a full AI
   conversation Twilio-free on the test extension.
4. **Phase 3:** implement/verify `AriService.transfer()` end-to-end; confirm the
   agent sees the real customer number on VICIdial.
5. **Phase 4:** rebuild AMD + recording.
6. **Phase 5:** flip `CALL_TRANSPORT=asterisk` for production; keep Twilio code
   as instant rollback.

---

## 7. Rollback

Everything is behind `CALL_TRANSPORT`. Set it back to `twilio` (or unset) and
restart — the original Twilio Media Streams path runs unchanged. No data model
or VICIdial dispo changes are involved.

---

## 8. VERIFY checklist (things I can't test from here)

- [ ] Exact ARI `externalMedia` params for AudioSocket on **your** Asterisk
      version (`encapsulation`, `transport`, `connection_type`, how the UUID is
      conveyed — `data` vs channel id). Adjust `AriService._onStasisStart`.
- [ ] AudioSocket slin endianness on your build (we assume 16-bit LE).
- [ ] `X-VICIdial-Caller-Id` actually carries the customer number at the AI box
      (confirm with `${PJSIP_HEADER(read,X-VICIdial-Caller-Id)}` in a NoOp).
- [ ] VICIdial routes `PJSIP/<agentUser>@vicidial-outbound` to the agent and
      displays the inbound CallerID (same open question as the SIP fix).
- [ ] Asterisk 18+ with AudioSocket + ARI modules loaded.
