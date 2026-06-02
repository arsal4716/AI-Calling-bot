"use strict";
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

  // ─── TWIML BUILDERS ────────────────────────────────────────────────────

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

  buildTransferTwiml(destination, callerId = null) {
    const vr = new twilio.twiml.VoiceResponse();

    const dial = vr.dial({
      callerId: process.env.TWILIO_DID, timeout: 45,
      action: `${process.env.SERVER_URL}/api/twilio/transfer-fallback`,
      method: "POST",
    });

    if (this.isSipUri(destination)) {
      dial.sip(destination);
    } else {
      dial.number(destination);
    }

    return vr.toString();
  }
  async transferCall(callSid, buyerDid, customerNum = null) {
    if (!callSid) throw new Error("Missing callSid");
    if (!buyerDid) throw new Error("Missing buyerDid");

    await new Promise(r => setTimeout(r, 300));

    const callLog = await CallLog.findOne({ callSid })
      .select("direction rawFrom").lean();

    console.log(`[transferCall] direction=${callLog?.direction} rawFrom=${callLog?.rawFrom}`);
    const isSipOriginated = this.isSipUri(callLog?.rawFrom || "");

    const callerId = isSipOriginated
      ? process.env.TWILIO_DID
      : (customerNum || process.env.TWILIO_DID);

    console.log(`[transferCall] isSipOriginated=${isSipOriginated} callerId=${callerId}`);

    await this.client.calls(callSid).update({
      twiml: this.buildTransferTwiml(buyerDid, callerId)
    });

    console.log(`[transferCall] success callerId=${callerId}`);
    return true;
  }
  buildHangupTwiml(message = null) {
    const vr = new twilio.twiml.VoiceResponse();
    if (message) vr.say(message);
    vr.hangup();
    return vr.toString();
  }

  // ─── CALL ACTIONS ──────────────────────────────────────────────────────

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


  async endCallHard(callSid) {
    if (!callSid) return;
    try {
      await this.client.calls(callSid).update({ status: "completed" });
    } catch { }
  }

  // ─── AMD DISPOSITION HELPERS ───────────────────────────────────────────

  getNonHumanDisposition(answeredBy) {
    const a = String(answeredBy || "").toLowerCase();
    if (a === "machine_end_beep" || a === "machine_end_silence" || a === "machine_end_other") return "VOICEMAIL";
    if (a === "fax") return "FAX";
    if (a === "unknown") return "AMD_UNKNOWN";
    if (a === "machine_start") return "ANSWERING_MACHINE";
    return "NON_HUMAN";
  }

  isHumanAnswered(answeredBy) {
    return String(answeredBy || "").toLowerCase() === "human";
  }

  isNonHumanAnswered(answeredBy) {
    const a = String(answeredBy || "").toLowerCase();
    return ["machine_start", "machine_end_beep", "machine_end_silence", "machine_end_other", "fax", "unknown"].includes(a);
  }

  // ─── CALLLOG UPDATERS ──────────────────────────────────────────────────

  async markAnsweredBy(callSid, answeredBy, extra = {}) {
    if (!callSid) return null;
    return CallLog.findOneAndUpdate(
      { callSid },
      { answeredBy: answeredBy || "unknown", amdAt: new Date(), ...extra },
      { new: true }
    );
  }

  async markHumanAnswered(callSid, answeredBy = "human") {
    if (!callSid) return null;
    return CallLog.findOneAndUpdate(
      { callSid },
      { answeredBy, amdAt: new Date(), status: "in_progress", disposition: "HUMAN_ANSWERED" },
      { new: true }
    );
  }

  async markNonHumanAndFinalize(callSid, answeredBy) {
    if (!callSid) return null;
    const disposition = this.getNonHumanDisposition(answeredBy);
    return CallLog.findOneAndUpdate(
      { callSid },
      { answeredBy: answeredBy || "unknown", amdAt: new Date(), status: "completed", disposition, endTime: new Date() },
      { new: true }
    );
  }

  // ─── STATUS UPDATE ─────────────────────────────────────────────────────

  async updateCallStatus(callSid, status, duration = null, extra = {}) {
    try {
      const update = { status, ...extra };
      if (duration != null) {
        update.duration = Number(duration) || 0;
        update.endTime = new Date();
      }
      await CallLog.findOneAndUpdate({ callSid }, update, { new: true });
    } catch (error) {
      console.error("updateCallStatus error:", error);
    }
  }

  // ─── SIP / PHONE HELPERS ───────────────────────────────────────────────

  isSipUri(value) {
    return /^sip:/i.test(String(value || "").trim());
  }

  extractSipUser(value) {
    const match = String(value || "").trim().match(/^sip:([^@;>]+)@/i);
    return match ? match[1].toLowerCase() : "";
  }
  extractE164FromSip(sipUri) {
    const match = String(sipUri || "").match(/^sip:\+?(\d+)@/i);
    if (!match) return sipUri;
    const digits = match[1];
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return `+${digits}`;
  }

  normalizePhone(value) {
    return String(value || "").replace(/\D/g, "").slice(-10);
  }

  // ─── CAMPAIGN LOOKUP ───────────────────────────────────────────────────

  async findSingleActiveCampaign() {
    return Campaign.findOne({ isActive: true }).sort({ createdAt: 1 });
  }

  async findCampaignForIncomingCall({ from, to, direction }) {
    const isOutbound = String(direction || "").toLowerCase().startsWith("outbound");
    const lookupValue = isOutbound ? from : to;

    if (this.isSipUri(lookupValue)) {
      const sipUser = this.extractSipUser(lookupValue);
      if (sipUser) {
        let campaign = await Campaign.findOne({ isActive: true, sipUser });
        if (campaign) return { campaign, lookupType: "sip", lookupValue: sipUser };

        if (sipUser === DEFAULT_SIP_USER) {
          campaign = await this.findSingleActiveCampaign();
          if (campaign) return { campaign, lookupType: "sip", lookupValue: sipUser };
        }
      }
    }

    const normalizedLookup = this.normalizePhone(lookupValue);
    if (normalizedLookup) {
      const campaign = await Campaign.findOne({
        isActive: true,
        twilioDid: { $regex: new RegExp(normalizedLookup + "$") },
      });
      if (campaign) return { campaign, lookupType: "phone", lookupValue: normalizedLookup };
    }

    const fallback = await this.findSingleActiveCampaign();
    if (fallback) {
      return {
        campaign: fallback,
        lookupType: this.isSipUri(lookupValue) ? "sip" : "phone",
        lookupValue: this.isSipUri(lookupValue)
          ? (this.extractSipUser(lookupValue) || DEFAULT_SIP_USER)
          : normalizedLookup,
      };
    }

    return { campaign: null, lookupType: null, lookupValue: null };
  }

  async handleIncomingCall(callSid, from, to, direction = "") {
    try {
      if (!process.env.SERVER_URL) throw new Error("SERVER_URL env var required");

      const isOutbound = String(direction || "").toLowerCase().startsWith("outbound");
      const { campaign, lookupType, lookupValue } = await this.findCampaignForIncomingCall({ from, to, direction });

      if (!campaign) {
        return { twiml: this.buildHangupTwiml("No campaign configured. Goodbye.") };
      }
      let cleanFrom;
      if (isOutbound) {
        cleanFrom = this.isSipUri(to)
          ? this.extractE164FromSip(to)
          : to.startsWith("+") ? to : `+1${this.normalizePhone(to)}`;
      } else {
        cleanFrom = this.isSipUri(from) ? this.extractE164FromSip(from) : from;
      }

      const existing = await CallLog.findOne({ callSid });
      if (existing) {
        const updateFields = {};
        if (!existing.rawFrom && from) updateFields.rawFrom = from;
        if (!existing.direction && direction) updateFields.direction = direction;
        if (isOutbound && (!existing.fromNumber || !existing.fromNumber.startsWith("+"))) {
          updateFields.fromNumber = cleanFrom;
        }
        if (Object.keys(updateFields).length > 0) {
          await CallLog.findByIdAndUpdate(existing._id, updateFields);
          Object.assign(existing, updateFields);
        }
      }
      const callLog =
        existing ||
        await CallLog.create({
          callSid,
          campaign: campaign._id,
          fromNumber: cleanFrom,
          rawFrom: from,
          toNumber: isOutbound
            ? process.env.TWILIO_DID
            : lookupType === "sip" ? String(to || "") : lookupValue,
          status: "ringing",
          direction,
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
      console.error("handleIncomingCall error:", error);
      return {
        twiml: this.buildHangupTwiml("We are experiencing technical difficulties. Please try again later."),
      };
    }
  }
}

module.exports = TwilioService;