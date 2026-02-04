const twilio = require("twilio");
const Campaign = require("../models/Campaign");
const CallLog = require("../models/callLogModel");
const baseUrl = new URL(process.env.SERVER_URL);
const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

const MAX_CONCURRENT_CALLS = 20;
const QUEUE_NAME = "ai-call-queue";

class TwilioService {
  constructor({ getActiveSessionCount } = {}) {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );

    this.getActiveSessionCount = getActiveSessionCount || (() => 0);
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
        waitUrl: "/api/twilio/wait",
        waitUrlMethod: "POST",
      },
      QUEUE_NAME,
    );
    return vr.toString();
  }

  async handleIncomingCall(callSid, from, to, direction) {
    try {
      const isOutbound = (direction || "").startsWith("outbound");
      `${process.env.SERVER_URL}/api/twilio/wait`;
      const campaignLookupNumber = isOutbound ? from : to;
      const normalized = campaignLookupNumber.replace(/\D/g, "").slice(-10);

      console.log(
        `Searching campaign for ${isOutbound ? "FROM (twilio DID)" : "TO (DID)"}:`,
        normalized,
      );

      const campaign = await Campaign.findOne({
        twilioDid: { $regex: new RegExp(normalized + "$") },
      });

      if (!campaign) {
        console.error("No campaign found for:", normalized);
        const vr = new twilio.twiml.VoiceResponse();
        vr.say({ voice: "woman" }, "No campaign configured. Goodbye.");
        vr.hangup();
        return { twiml: vr.toString() };
      }

      console.log("Campaign found:", campaign.name);

      const callLog = await CallLog.create({
        callSid,
        campaign: campaign._id,
        fromNumber: from,
        toNumber: isOutbound ? to : normalized,
        status: CallStatusSafe(direction),
      });

      const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLog._id}`;
      console.log(" WebSocket URL:", wsUrl);

      const active = this.getActiveSessionCount();
      console.log(` Active AI calls: ${active}/${MAX_CONCURRENT_CALLS}`);

      if (active >= MAX_CONCURRENT_CALLS) {
        console.log("Capacity full → enqueue call:", callSid);

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

      return {
        twiml: this.buildStreamTwiml(wsUrl),
        callLogId: callLog._id,
        campaignId: campaign._id,
      };
    } catch (error) {
      console.error("Twilio service error:", error);

      const vr = new twilio.twiml.VoiceResponse();
      vr.say(
        { voice: "woman" },
        "We are experiencing technical difficulties. Please try again later.",
      );
      vr.hangup();

      return { twiml: vr.toString() };
    }
  }

  async updateCallStatus(callSid, status, duration = null) {
    try {
      const updateData = { status };

      if (duration) {
        updateData.duration = duration;
        updateData.endTime = new Date();
      }

      await CallLog.findOneAndUpdate({ callSid }, updateData, { new: true });
    } catch (error) {
      console.error("Update call status error:", error);
    }
  }
  async redirectCallToStream(callSid, callLogId) {
    if (!process.env.SERVER_URL) throw new Error("SERVER_URL is missing");

    const wsUrl = `wss://${process.env.SERVER_URL}/media-stream/${callLogId}`;
    const twiml = this.buildStreamTwiml(wsUrl);

    await this.client.calls(callSid).update({ twiml });
  }

  async getCallDetails(callSid) {
    try {
      const call = await this.client.calls(callSid).fetch();
      return call;
    } catch (error) {
      console.error("Get call details error:", error);
      return null;
    }
  }

  async endCall(callSid) {
    try {
      await this.client.calls(callSid).update({ status: "completed" });
      await this.updateCallStatus(callSid, "completed");
    } catch (error) {
      console.error("End call error:", error);
    }
  }
}

module.exports = TwilioService;
