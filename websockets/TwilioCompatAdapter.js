"use strict";
// TwilioCompatAdapter — makes an Asterisk AudioSocket call look exactly like a
// Twilio Media Stream WebSocket to the existing MediaStreamHandler.
//
// This is the trick that lets us remove Twilio WITHOUT rewriting the ~2,500
// lines of qualification/conversation logic. The handler only ever touches the
// socket through a tiny surface:
//
//   inbound : ws.on("message", json)   // {event:"start"|"media"|"stop"}
//   outbound: ws.send(json)            // {event:"media"|"clear", ...}
//   misc    : ws.isAlive, ws.ping(), ws.terminate(), ws.on("close"/"error")
//
// We implement that surface on top of an AudioSocketConnection, translating
// slin <-> µ-law/base64 at the boundary. To the handler it is indistinguishable
// from Twilio.
//
// Integration (see docs/TWILIO_REMOVAL_PLAN.md):
//   const adapter = new TwilioCompatAdapter(audioConn);
//   mediaHandler.wss.emit("connection", adapter, { url: `/media-stream/${callLogId}` });
//   adapter.begin({ customParameters: { "X-Asterisk-UniqueID": channelId } });

const { EventEmitter } = require("events");
const { slinBufToUlaw } = require("../utils/g711");

class TwilioCompatAdapter extends EventEmitter {
  constructor(audioConn, { streamSid = null } = {}) {
    super();
    this.audioConn = audioConn;
    this.streamSid = streamSid || `AS-${audioConn.id || Date.now()}`;
    this.isAlive = true;
    this._started = false;
    // The handler gates audio on `ws.readyState === WebSocket.OPEN` (1). Mirror
    // the ws ready-state so the existing streaming code treats us as an open
    // socket. 1 = OPEN, 3 = CLOSED (same numeric values as the `ws` library).
    this.readyState = 1;

    // Asterisk audio (slin) -> Twilio-style "media" event (base64 µ-law).
    audioConn.on("audio", (slinBuf) => {
      if (!this._started) return;
      const payload = slinBufToUlaw(slinBuf).toString("base64");
      this.emit("message", JSON.stringify({
        event: "media",
        media: { payload },
      }));
    });

    audioConn.on("close", () => {
      this.readyState = 3; // CLOSED
      // Mirror Twilio's "stop" then socket close.
      this.emit("message", JSON.stringify({ event: "stop" }));
      this.emit("close");
    });
  }

  /**
   * Fire the Twilio-style "start" event so the handler begins the call.
   * Pass customParameters (e.g. the Asterisk channel id) just like Twilio's
   * <Stream><Parameter> values.
   */
  begin({ customParameters = {} } = {}) {
    if (this._started) return;
    this._started = true;
    this.emit("message", JSON.stringify({
      event: "start",
      start: {
        streamSid: this.streamSid,
        customParameters,
      },
    }));
  }

  // ── WebSocket-compatible surface the handler calls ──────────────────────
  send(str) {
    let data;
    try { data = JSON.parse(str); } catch { return; }

    if (data.event === "media" && data.media?.payload) {
      // Handler sends base64 µ-law (ElevenLabs output) -> push to Asterisk.
      const ulaw = Buffer.from(data.media.payload, "base64");
      this.audioConn.writeUlaw(ulaw);
    } else if (data.event === "clear") {
      // Barge-in. AudioSocket/Asterisk has no "flush playout" primitive the way
      // Twilio does; the handler stops generating new frames, which is what
      // actually cuts Anna off. Already-buffered audio (a few frames) drains.
      // See plan for the optional RTP/ARI playback-stop alternative.
      this.emit("clear-noop");
    }
  }

  ping() { /* AudioSocket uses TCP keepalive; nothing to do. */ }
  terminate() { this.readyState = 3; try { this.audioConn.hangup(); } catch { } }
  close() { this.terminate(); }
}

module.exports = TwilioCompatAdapter;
