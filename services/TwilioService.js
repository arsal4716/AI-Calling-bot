const twilio = require("twilio");
const Campaign = require("../models/Campaign");
const CallLog = require("../models/callLogModel");

const MAX_CONCURRENT_CALLS = 20;
const QUEUE_NAME = "ai-call-queue";

class TwilioService {
  constructor({ getActiveSessionCount } = {}) {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    this.getActiveSessionCount = getActiveSessionCount || (() => 0);

    if (!process.env.SERVER_URL) {
      throw new Error("SERVER_URL env is required (example: https://yourdomain.com)");
    }
  }

  getWsUrl(callLogId) {
    const baseUrl = new URL(process.env.SERVER_URL);
    const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${baseUrl.host}/media-stream/${callLogId}`;
  }

  buildStreamTwiml(wsUrl) {
    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect();
    connect.stream({
      url: wsUrl,
      name: "ai-conversation",
    });
    return vr.toString();
  }

  buildEnqueueTwiml() {
    const vr = new twilio.twiml.VoiceResponse();

    vr.enqueue(
      {
        waitUrl: `${process.env.SERVER_URL}/api/twilio/wait`,
        waitUrlMethod: "POST",
      },
      QUEUE_NAME
    );

    return vr.toString();
  }

  async handleVoiceWebhook({ callSid, from, to, callStatus, direction, campaignId }) {
   
    const campaign = await this.findCampaign({ from, to, direction, campaignId });

    if (!campaign) {
      const vr = new twilio.twiml.VoiceResponse();
      vr.say({ voice: "woman" }, "No campaign configured. Goodbye.");
      vr.hangup();
      return { twiml: vr.toString() };
    }

    let callLog = await CallLog.findOne({ callSid });

    if (!callLog) {
      callLog = await CallLog.create({
        callSid,
        campaign: campaign._id,
        fromNumber: from,
        toNumber: to,
        status: callStatus || "initiated",
        direction: direction || "unknown",
      });
    } else {
      if (!callLog.campaign) callLog.campaign = campaign._id;
      if (callStatus) callLog.status = callStatus;
      await callLog.save();
    }

    const active = this.getActiveSessionCount();
    console.log(`Active AI calls: ${active}/${MAX_CONCURRENT_CALLS}`);

    if (active >= MAX_CONCURRENT_CALLS) {
      callLog.status = "queued";
      await callLog.save();

      return {
        twiml: this.buildEnqueueTwiml(),
        callLogId: callLog._id,
        campaignId: campaign._id,
      };
    }

    callLog.status = "connecting";
    await callLog.save();

    const wsUrl = this.getWsUrl(callLog._id);
    console.log("WS URL:", wsUrl);

    return {
      twiml: this.buildStreamTwiml(wsUrl),
      callLogId: callLog._id,
      campaignId: campaign._id,
    };
  }

  async findCampaign({ from, to, direction, campaignId }) {
    if (campaignId) {
      return Campaign.findById(campaignId);
    }

    const norm = (n) => (n || "").replace(/\D/g, "").slice(-10);

    const isOutbound = (direction || "").startsWith("outbound");

    if (isOutbound) {
      const from10 = norm(from);
      console.log("Searching outbound campaign by FROM (Twilio DID):", from10);
      return Campaign.findOne({
        twilioDid: { $regex: new RegExp(from10 + "$") },
      });
    } else {
      const to10 = norm(to);
      console.log("Searching inbound campaign by TO (DID):", to10);
      return Campaign.findOne({
        twilioDid: { $regex: new RegExp(to10 + "$") },
      });
    }
  }

  async updateCallStatus(callSid, status, duration = null) {
    try {
      const updateData = { status };

      if (duration !== null && duration !== undefined) {
        updateData.duration = Number(duration);
        updateData.endTime = new Date();
      }

      await CallLog.findOneAndUpdate({ callSid }, updateData, { new: true });
    } catch (error) {
      console.error("Update call status error:", error);
    }
  }
}

module.exports = TwilioService;
