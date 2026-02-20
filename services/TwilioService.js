// services/TwilioService.js
const twilio = require("twilio");
const Campaign = require("../models/Campaign");
const CallLog = require("../models/callLogModel");

const baseUrl = new URL(process.env.SERVER_URL);
const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

const MAX_CONCURRENT_CALLS = 20;
const QUEUE_NAME = "ai-call-queue";

class TwilioService {
  constructor({ getActiveSessionCount } = {}) {
    this.client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    this.getActiveSessionCount = getActiveSessionCount || (() => 0);
  }

  buildStreamTwiml(wsUrl) {
    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect();
    connect.stream({ url: wsUrl, name: "ai-conversation" });
    return vr.toString();
  }

  buildEnqueueTwiml() {
    const vr = new twilio.twiml.VoiceResponse();
    vr.enqueue(
      { waitUrl: `${process.env.SERVER_URL}/api/twilio/wait`, waitUrlMethod: "POST" },
      QUEUE_NAME
    );
    return vr.toString();
  }

  buildTransferTwiml(buyerDid) {
    const vr = new twilio.twiml.VoiceResponse();
    vr.say("Please hold while I transfer you.");
    vr.dial(buyerDid);
    return vr.toString();
  }

  async transferCall(callSid, buyerDid) {
    if (!callSid) throw new Error("Missing callSid");
    if (!buyerDid) throw new Error("Missing buyerDid");

    const twiml = this.buildTransferTwiml(buyerDid);
    await this.client.calls(callSid).update({ twiml });
    return true;
  }

  async endCallHard(callSid) {
    if (!callSid) return;
    try {
      // Hard stop on Twilio
      await this.client.calls(callSid).update({ status: "completed" });
    } catch (e) {
      // ignore (already ended)
    }
  }

  async handleIncomingCall(callSid, from, to, direction = "") {
    try {
      if (!process.env.SERVER_URL) throw new Error("SERVER_URL environment variable is required");

      const isOutbound = (direction || "").toLowerCase().startsWith("outbound");

      // inbound: campaign is matched by TO (your DID)
      // outbound: campaign is matched by FROM (your DID)
      const lookupNumber = isOutbound ? from : to;

      const normalizedLookup = (lookupNumber || "").replace(/\D/g, "").slice(-10);

      const campaign = await Campaign.findOne({
        twilioDid: { $regex: new RegExp(normalizedLookup + "$") },
      });

      if (!campaign) {
        const vr = new twilio.twiml.VoiceResponse();
        vr.say({ voice: "woman" }, "No campaign configured. Goodbye.");
        vr.hangup();
        return { twiml: vr.toString() };
      }

      const callLog = await CallLog.create({
        callSid,
        campaign: campaign._id,
        fromNumber: from,
        toNumber: isOutbound ? to : normalizedLookup,
        status: "ringing",
      });

      const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLog._id}`;

      const active = this.getActiveSessionCount();
      if (active >= MAX_CONCURRENT_CALLS) {
        callLog.status = "queued";
        await callLog.save();
        return { twiml: this.buildEnqueueTwiml(), callLogId: callLog._id, campaignId: campaign._id };
      }

      callLog.status = "connecting";
      await callLog.save();

      return { twiml: this.buildStreamTwiml(wsUrl), callLogId: callLog._id, campaignId: campaign._id };
    } catch (error) {
      const vr = new twilio.twiml.VoiceResponse();
      vr.say({ voice: "woman" }, "We are experiencing technical difficulties. Please try again later.");
      vr.hangup();
      return { twiml: vr.toString() };
    }
  }

  async updateCallStatus(callSid, status, duration = null) {
    try {
      const updateData = { status };
      if (duration != null) {
        updateData.duration = Number(duration) || 0;
        updateData.endTime = new Date();
      }
      await CallLog.findOneAndUpdate({ callSid }, updateData, { new: true });
    } catch (error) {
      console.error("Update call status error:", error);
    }
  }
}

module.exports = TwilioService;