"use strict";
// AriService — Asterisk REST Interface control plane for the Twilio-free path.
//
// Responsibilities:
//   1. Connect to ARI (WebSocket for events + REST for actions).
//   2. On StasisStart for app "ai-bot": answer the caller, read the REAL
//      customer number (X-VICIdial-Caller-Id), create a mixing bridge, and
//      attach an AudioSocket externalMedia channel so the AI gets the audio.
//   3. Expose transfer(): natively dial the VICIdial agent with the customer's
//      CallerID and bridge them — NO Twilio, so the agent always sees the real
//      number. Then drop the AI/externalMedia leg.
//   4. On StasisEnd: let the existing dispo logic run (dispo file + VICIdial API).
//
// Implemented with the existing `ws` + `axios` deps (no ari-client needed).
//
// ── ASTERISK-SIDE THINGS TO VERIFY (marked VERIFY) are collected in
//    docs/TWILIO_REMOVAL_PLAN.md. This is a review-first scaffold: it is wired
//    to be correct in shape; confirm the externalMedia/audiosocket parameters
//    against your Asterisk version before enabling in production.

const WebSocket = require("ws");
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../utils/logger");

class AriService {
  constructor({
    host = process.env.ARI_HOST || "127.0.0.1",
    port = process.env.ARI_PORT || 8088,
    username = process.env.ARI_USER || "ai-bot",
    password = process.env.ARI_PASS || "",
    app = process.env.ARI_APP || "ai-bot",
    audioSocketHost = process.env.AUDIOSOCKET_HOST || "127.0.0.1:9092",
  } = {}) {
    this.app = app;
    this.audioSocketHost = audioSocketHost;
    this.base = `http://${host}:${port}/ari`;
    this.wsUrl = `ws://${host}:${port}/ari/events?app=${app}&api_key=${username}:${password}`;
    this.http = axios.create({
      baseURL: this.base,
      auth: { username, password },
      timeout: 5000,
    });
    // channelId -> { bridgeId, emChannelId, leadId, agentUser, customerCid }
    this.calls = new Map();
    // audiosocket uuid -> channelId  (so the media pipe finds its call)
    this.pendingAudio = new Map();
    // agentChannelId -> { bridgeId, emChannelId }  (transfer in flight)
    this.pendingAgent = new Map();
    this.onCall = null; // set by orchestrator: (callChannelId, meta) => void
  }

  start() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.on("open", () => logger.info(`[ARI] connected, app=${this.app}`));
    this.ws.on("message", (raw) => this._onEvent(raw));
    this.ws.on("close", () => {
      logger.warn("[ARI] disconnected — reconnecting in 3s");
      setTimeout(() => this.start(), 3000);
    });
    this.ws.on("error", (e) => logger.error(`[ARI] ws error: ${e.message}`));
    return this;
  }

  async _onEvent(raw) {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (ev.type === "StasisStart") await this._onStasisStart(ev);
      else if (ev.type === "StasisEnd") await this._onStasisEnd(ev);
    } catch (e) {
      logger.error(`[ARI] event ${ev.type} failed: ${e.message}`);
    }
  }

  async _onStasisStart(ev) {
    const channel = ev.channel;
    const args = ev.args || [];
    const kind = args[0];

    // The agent leg we originated for a transfer — bridge it in.
    if (kind === "agentleg") return this._onAgentLegStart(channel);

    // Only the inbound caller carries the explicit "inbound" marker (set in the
    // dialplan: Stasis(ai-bot,inbound,...)). Anything else — most importantly
    // the externalMedia/AudioSocket leg — is ignored here.
    if (kind !== "inbound") {
      logger.info(`[ARI] StasisStart ignored channel=${channel.id} args=${JSON.stringify(args)}`);
      return;
    }

    // Args: Stasis(ai-bot, inbound, ${LEADID}, ${AGENTUSER}, ${CUSTID})
    const leadId = args[1] || null;
    const agentUser = args[2] || null;

    logger.info(`[ARI] StasisStart caller channel=${channel.id} lead=${leadId} agent=${agentUser}`);

    await this._post(`/channels/${channel.id}/answer`);

    // Real customer number — VICIdial sends it as X-VICIdial-Caller-Id; fall
    // back to the dialplan-provided arg, then the channel CallerID.
    const customerCid =
      (await this._getVar(channel.id, "PJSIP_HEADER(read,X-VICIdial-Caller-Id)")) ||
      (args[3] || null) ||
      (await this._getVar(channel.id, "CALLERID(num)")) ||
      null;

    // Mixing bridge holds caller + AI leg (and later the agent leg).
    const bridge = await this._post(`/bridges`, { type: "mixing" });
    await this._post(`/bridges/${bridge.id}/addChannel`, { channel: channel.id });

    const audioUuid = crypto.randomUUID();
    this.pendingAudio.set(audioUuid, channel.id);
    this.calls.set(channel.id, {
      bridgeId: bridge.id,
      emChannelId: null,
      audioUuid,
      leadId,
      agentUser,
      customerCid,
    });

    // Hand off to the orchestrator FIRST so the call is registered before the
    // AudioSocket connects (avoids a race where media arrives before the
    // session exists). onCall creates the CallLog + pending mapping.
    if (this.onCall) {
      await this.onCall(channel.id, { leadId, agentUser, customerCid, audioUuid });
    }

    // AudioSocket leg — originate a chan_audiosocket channel that connects to
    // our TCP server. This uses the standard AudioSocket *channel driver*
    // (Asterisk 18+), which is far more widely available than ARI
    // externalMedia's audiosocket encapsulation. The UUID in the dialstring is
    // what the server receives in the 0x01 ID frame.
    //   endpoint = AudioSocket/<host>:<port>/<uuid>
    const em = await this._post(`/channels`, {
      endpoint: `AudioSocket/${this.audioSocketHost}/${audioUuid}`,
      app: this.app,
      appArgs: "audiosocket",
      formats: "slin",
    });
    await this._post(`/bridges/${bridge.id}/addChannel`, { channel: em.id });
    const call = this.calls.get(channel.id);
    if (call) call.emChannelId = em.id;
  }

  /** Agent answered the transfer — drop the AI leg and bridge agent ↔ customer. */
  async _onAgentLegStart(channel) {
    const pend = this.pendingAgent.get(channel.id);
    if (!pend) {
      logger.warn(`[ARI] agent leg ${channel.id} with no pending transfer — hanging up`);
      try { await this._delete(`/channels/${channel.id}`); } catch { }
      return;
    }
    this.pendingAgent.delete(channel.id);
    // Remove the AI/externalMedia leg first so only customer + agent remain.
    if (pend.emChannelId) { try { await this._delete(`/channels/${pend.emChannelId}`); } catch { } }
    await this._post(`/bridges/${pend.bridgeId}/addChannel`, { channel: channel.id });
    logger.info(`[ARI] agent ${channel.id} bridged to customer; AI leg dropped`);
  }

  /** Hang up a channel (caller leg) — ends the whole call. */
  async hangup(channelId) {
    try { await this._delete(`/channels/${channelId}`); } catch { }
  }

  async _onStasisEnd(ev) {
    const id = ev.channel?.id;
    if (!id || !this.calls.has(id)) return;
    const call = this.calls.get(id);
    this.pendingAudio.delete(call.audioUuid);
    this.calls.delete(id);
    // Best-effort cleanup of bridge + EM leg.
    try { await this._delete(`/channels/${call.emChannelId}`); } catch { }
    try { await this._delete(`/bridges/${call.bridgeId}`); } catch { }
    logger.info(`[ARI] StasisEnd channel=${id} cleaned up`);
  }

  /**
   * Warm-transfer the customer to a VICIdial agent — fully native, no Twilio.
   * Originates PJSIP/<agentExten>@vicidial-outbound with the REAL customer
   * CallerID. The bridge-in + AI-leg drop happen when the agent ANSWERS (its
   * StasisStart, handled in _onAgentLegStart), so the customer keeps hearing
   * the bot until the agent actually picks up.
   */
  async transfer(callChannelId, agentExten) {
    const call = this.calls.get(callChannelId);
    if (!call) throw new Error(`transfer: unknown channel ${callChannelId}`);

    const cid = call.customerCid || "";
    logger.info(`[ARI] transfer channel=${callChannelId} -> agent=${agentExten} callerid=${cid}`);

    const agent = await this._post(`/channels`, {
      endpoint: `PJSIP/${agentExten}@vicidial-outbound`,
      app: this.app,
      appArgs: "agentleg",
      callerId: cid,            // <-- real customer number to VICIdial
      timeout: 45,
    });

    // Bridge happens on the agent's StasisStart (answer).
    this.pendingAgent.set(agent.id, {
      bridgeId: call.bridgeId,
      emChannelId: call.emChannelId,
    });
    return true;
  }

  // ── thin REST helpers ───────────────────────────────────────────────────
  async _post(path, params) {
    const { data } = await this.http.post(path, null, { params });
    return data;
  }
  async _delete(path) {
    const { data } = await this.http.delete(path);
    return data;
  }
  async _getVar(channelId, variable) {
    try {
      const { data } = await this.http.get(`/channels/${channelId}/variable`, { params: { variable } });
      return data?.value || null;
    } catch { return null; }
  }
}

module.exports = AriService;
