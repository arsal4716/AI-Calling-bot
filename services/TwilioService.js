const twilio = require("twilio");
const Campaign = require("../models/Campaign");
const CallLog = require("../models/callLogModel");

const baseUrl = new URL(process.env.SERVER_URL);
const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";

const MAX_CONCURRENT_CALLS = 20;
const QUEUE_NAME = "ai-call-queue";

const DEFAULT_SIP_USER = "ai";

class TwilioService {
  constructor({ getActiveSessionCount } = {}) {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    this.getActiveSessionCount = getActiveSessionCount || (() => 0);
  }

  buildStreamTwiml(wsUrl) {
    const vr = new twilio.twiml.VoiceResponse();
    const connect = vr.connect();

    connect.stream({
      url: wsUrl,
      name: "ai-conversation",
      statusCallback: `${process.env.SERVER_URL}/api/twilio/stream-status`,
      statusCallbackMethod: "POST",
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

  buildTransferTwiml(buyerDid) {
    const vr = new twilio.twiml.VoiceResponse();
    vr.say("Please hold while I transfer you.");
    vr.dial(buyerDid);
    return vr.toString();
  }

  buildHangupTwiml(message = null) {
    const vr = new twilio.twiml.VoiceResponse();
    if (message) vr.say(message);
    vr.hangup();
    return vr.toString();
  }

  async startCallRecording(callSid) {
    if (!callSid) return null;

    try {
      return await this.client.calls(callSid).recordings.create({
        recordingStatusCallback: `${process.env.SERVER_URL}/api/twilio/recording-status`,
        recordingStatusCallbackMethod: "POST",
      });
    } catch (error) {
      console.error("startCallRecording error:", error.message);
      return null;
    }
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
      await this.client.calls(callSid).update({ status: "completed" });
    } catch (e) {}
  }

  getNonHumanDisposition(answeredBy) {
    const a = String(answeredBy || "").toLowerCase();

    if (a === "fax") return "ANSWERING_MACHINE";
    if (a === "unknown") return "ANSWERING_MACHINE";
    if (a === "machine_start") return "ANSWERING_MACHINE";
    if (
      a === "machine_end_beep" ||
      a === "machine_end_silence" ||
      a === "machine_end_other"
    ) {
      return "VOICEMAIL";
    }

    return "ANSWERING_MACHINE";
  }

  async markAnsweredBy(callSid, answeredBy, extra = {}) {
    if (!callSid) return null;

    return CallLog.findOneAndUpdate(
      { callSid },
      {
        answeredBy: answeredBy || "unknown",
        amdAt: new Date(),
        ...extra,
      },
      { new: true }
    );
  }

  async markHumanAnswered(callSid, answeredBy = "human") {
    if (!callSid) return null;

    return CallLog.findOneAndUpdate(
      { callSid },
      {
        answeredBy,
        amdAt: new Date(),
        status: "in_progress",
        disposition: "HUMAN_ANSWERED",
      },
      { new: true }
    );
  }

  async markNonHumanAndFinalize(callSid, answeredBy) {
    if (!callSid) return null;

    const disposition = this.getNonHumanDisposition(answeredBy);

    return CallLog.findOneAndUpdate(
      { callSid },
      {
        answeredBy: answeredBy || "unknown",
        amdAt: new Date(),
        status: "completed",
        disposition,
        endTime: new Date(),
      },
      { new: true }
    );
  }

  isSipUri(value) {
    return /^sip:/i.test(String(value || "").trim());
  }

  extractSipUser(value) {
    const str = String(value || "").trim();
    const match = str.match(/^sip:([^@;>]+)@/i);
    return match ? match[1].toLowerCase() : "";
  }

  normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(-10);
  }

  async findSingleActiveCampaign() {
    return Campaign.findOne({ isActive: true }).sort({ createdAt: 1 });
  }

  async findCampaignForIncomingCall({ from, to, direction }) {
    const isOutbound = String(direction || "")
      .toLowerCase()
      .startsWith("outbound");

    const lookupValue = isOutbound ? from : to;

    if (this.isSipUri(lookupValue)) {
      const sipUser = this.extractSipUser(lookupValue);

      if (sipUser) {
        let campaign = await Campaign.findOne({
          isActive: true,
          sipUser,
        });

        if (campaign) {
          return {
            campaign,
            lookupType: "sip",
            lookupValue: sipUser,
          };
        }

        if (sipUser === DEFAULT_SIP_USER) {
          campaign = await this.findSingleActiveCampaign();

          if (campaign) {
            return {
              campaign,
              lookupType: "sip",
              lookupValue: sipUser,
            };
          }
        }
      }
    }

    const normalizedLookup = this.normalizePhone(lookupValue);
    if (normalizedLookup) {
      const campaign = await Campaign.findOne({
        isActive: true,
        twilioDid: { $regex: new RegExp(normalizedLookup + "$") },
      });

      if (campaign) {
        return {
          campaign,
          lookupType: "phone",
          lookupValue: normalizedLookup,
        };
      }
    }

    const fallbackCampaign = await this.findSingleActiveCampaign();
    if (fallbackCampaign) {
      return {
        campaign: fallbackCampaign,
        lookupType: this.isSipUri(lookupValue) ? "sip" : "phone",
        lookupValue: this.isSipUri(lookupValue)
          ? this.extractSipUser(lookupValue) || DEFAULT_SIP_USER
          : normalizedLookup,
      };
    }

    return {
      campaign: null,
      lookupType: null,
      lookupValue: null,
    };
  }

  async handleIncomingCall(callSid, from, to, direction = "") {
    try {
      if (!process.env.SERVER_URL) {
        throw new Error("SERVER_URL environment variable is required");
      }

      const isOutbound = String(direction || "")
        .toLowerCase()
        .startsWith("outbound");

      const { campaign, lookupType, lookupValue } =
        await this.findCampaignForIncomingCall({
          from,
          to,
          direction,
        });

      if (!campaign) {
        return {
          twiml: this.buildHangupTwiml("No campaign configured. Goodbye."),
        };
      }

      const existing = await CallLog.findOne({ callSid });

      const callLog =
        existing ||
        (await CallLog.create({
          callSid,
          campaign: campaign._id,
          fromNumber: from,
          toNumber:
            lookupType === "sip"
              ? String(to || "")
              : isOutbound
              ? to
              : lookupValue,
          status: "ringing",
          direction,
        }));

      const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLog._id}`;

      const active = this.getActiveSessionCount();
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

      return {
        twiml: this.buildStreamTwiml(wsUrl),
        callLogId: callLog._id,
        campaignId: campaign._id,
      };
    } catch (error) {
      console.error("handleIncomingCall error:", error);

      return {
        twiml: this.buildHangupTwiml(
          "We are experiencing technical difficulties. Please try again later."
        ),
      };
    }
  }

  async updateCallStatus(callSid, status, duration = null, extra = {}) {
    try {
      const updateData = {
        status,
        ...extra,
      };

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