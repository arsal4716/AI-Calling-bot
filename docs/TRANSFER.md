# Qualified-Lead Transfer — Preserving the Customer Caller ID

## The problem

When Anna qualifies a lead and transfers the call, the agent on VICIdial was
seeing the **Twilio DID (`6084108427`)** instead of the **real customer
number**.

### Why

The old transfer dialed the agent over **Twilio PSTN** (`<Dial><Number>`):

```
Node bot → Twilio → dials +18138819762 (PSTN), callerId = Twilio DID
```

Twilio **does not allow** an arbitrary caller ID on a PSTN dial — the caller ID
must be a Twilio-owned or verified number. So Twilio substitutes your Twilio
DID, and that DID is what VICIdial logs and shows to the agent. This is a hard
Twilio/PSTN restriction; it cannot be fixed by changing a caller-ID value on the
PSTN path.

## The fix — transfer over SIP back into Asterisk

Instead of dialing the agent over PSTN, Twilio re-dials the call over **SIP**
back into **this** Asterisk box's `from-twilio-transfer` context, which forwards
the call to VICIdial. Twilio **does** allow an arbitrary caller ID on
`<Dial><Sip>`, so the real customer number is preserved end-to-end:

```
Node bot
  → Twilio <Dial callerId="+1<customer>"><Sip>sip:<agent>@76.13.192.150</Sip>
  → Asterisk [from-twilio-transfer]  (CALLERID(num) = customer number)
  → Dial(PJSIP/<agent>@vicidial-outbound)
  → VICIdial 144.76.120.120   ✅ agent sees the real customer number
```

No new Asterisk configuration is required — it reuses the `twilio-transfer`
endpoint / `twilio-transfer-identify` / `from-twilio-transfer` /
`vicidial-outbound` blocks that already exist in `pjsip.conf`.

## Configuration

Transfer behaviour is controlled by two environment variables (with safe
defaults, so nothing has to change to get the fix):

| Env var                  | Default          | Meaning                                                                 |
| ------------------------ | ---------------- | ----------------------------------------------------------------------- |
| `TRANSFER_MODE`          | `sip`            | `sip` (recommended), `pstn` (legacy/broken caller ID), or `ami`.        |
| `ASTERISK_TRANSFER_HOST` | `76.13.192.150`  | Public IP of THIS Asterisk box that Twilio dials for the SIP transfer.  |

The agent destination is still taken from each campaign's
`transferSettings.number`. It may be:

- a plain number / extension (e.g. `8138819762`) — routed to
  `sip:8138819762@<ASTERISK_TRANSFER_HOST>`, or
- a full SIP URI (e.g. `sip:agent101@1.2.3.4`) — used exactly as given.

### Modes

- **`sip`** *(default, recommended)* — Twilio re-dials over SIP into Asterisk;
  the customer caller ID is preserved to VICIdial.
- **`pstn`** *(legacy)* — old behaviour; Twilio dials the agent over PSTN and the
  caller ID will be the Twilio DID. Kept only as an explicit opt-out.
- **`ami`** — originate directly on the local Asterisk via AMI (no Twilio leg).

## Asterisk requirements (already present)

For the `sip` mode the following must be true on the Asterisk box
(`76.13.192.150`) — these match the supplied `pjsip.conf` / dialplan:

1. Twilio's signalling IPs are identified to the `twilio-transfer` endpoint and
   land in the `from-twilio-transfer` context:

   ```
   [twilio-transfer-identify]
   type=identify
   endpoint=twilio-transfer
   match=54.172.60.0/23
   match=54.244.51.0/24
   match=34.203.250.0/23
   match=34.203.254.0/24
   ```

2. The transfer context forwards to VICIdial while keeping the caller ID:

   ```
   [from-twilio-transfer]
   exten => _X.,1,NoOp(=== AGENT TRANSFER exten=${EXTEN} callerid=${CALLERID(num)} ===)
    same => n,Dial(PJSIP/${EXTEN}@vicidial-outbound,45)
    same => n,Hangup()
   ```

3. `vicidial-outbound` points at the VICIdial server:

   ```
   [vicidial-outbound-aor]
   type=aor
   contact=sip:144.76.120.120:5060
   ```

> Note: the final routing of `${EXTEN}` to the logged-in agent (and the on-screen
> caller-ID display) is handled by VICIdial itself — the same destination value
> that was used on the PSTN path is reused here, so VICIdial routing is
> unchanged; only the transport (SIP instead of PSTN) and the preserved caller ID
> differ.
