const express = require("express");
const twilio = require("twilio");
const { getTwilioService } = require("../services/twilioSingleton");
const { getDialerQueueService } = require("../services/dialerQueueSingleton");
const CallLog = require("../models/callLogModel");

const router = express.Router();

function normalizeCallStatus(s) {
  return String(s || "")
    .toLowerCase()
    .replace("in-progress", "in_progress")
    .replace("no-answer", "no_answer");
}

function isFinalStatus(status) {
  return ["completed", "failed", "busy", "no_answer", "canceled"].includes(status);
}

function isNonHumanAnsweredBy(answeredBy) {
  const a = String(answeredBy || "").toLowerCase();

  return (
    a === "fax" ||
    a === "unknown" ||
    a === "machine_start" ||
    a === "machine_end_beep" ||
    a === "machine_end_silence" ||
    a === "machine_end_other"
  );
}

function mapAnsweredByDisposition(answeredBy) {
  const a = String(answeredBy || "").toLowerCase();

  if (a === "human") return "HUMAN_ANSWERED";
  if (a === "machine_start") return "ANSWERING_MACHINE";
  if (
    a === "machine_end_beep" ||
    a === "machine_end_silence" ||
    a === "machine_end_other"
  ) {
    return "VOICEMAIL";
  }
  if (a === "fax") return "ANSWERING_MACHINE";
  if (a === "unknown") return "ANSWERING_MACHINE";

  return null;
}

function mapFinalDisposition({ status, answeredBy, existingDisposition }) {
  if (
    existingDisposition &&
    [
      "NOT_INTERESTED",
      "MEDICAID_MEDICARE_VA_DISQUALIFIED",
      "TRANSFERRED_TO_LICENSED_AGENT",
      "VOICEMAIL",
      "ANSWERING_MACHINE",
      "HUMAN_ANSWERED",
    ].includes(existingDisposition)
  ) {
    return existingDisposition;
  }

  if (status === "no_answer") return "NO_ANSWER";
  if (status === "busy") return "NO_ANSWER";
  if (status === "failed" || status === "canceled") return "DISCONNECTED";

  return mapAnsweredByDisposition(answeredBy);
}

router.post("/webhook", async (req, res) => {
  try {
    const { CallSid, From, To, CallStatus, Direction } = req.body;
    const status = normalizeCallStatus(CallStatus);
    const twilioService = getTwilioService();

    const existing = await CallLog.findOne({ callSid: CallSid }).select(
      "_id twimlServed status"
    );
    const shouldServeTwiml = !existing || existing.twimlServed !== true;

    if (shouldServeTwiml) {
      const result = await twilioService.handleIncomingCall(
        CallSid,
        From,
        To,
        Direction
      );

      if (result.callLogId) {
        await CallLog.findByIdAndUpdate(
          result.callLogId,
          { twimlServed: true },
          { new: false }
        );
      } else if (existing?._id) {
        await CallLog.findByIdAndUpdate(
          existing._id,
          { twimlServed: true },
          { new: false }
        );
      }

      res.type("text/xml");
      return res.send(result.twiml);
    }

    await twilioService.updateCallStatus(CallSid, status);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Twilio webhook error:", error);
    if (!res.headersSent) {
      return res.status(500).send("Error processing webhook");
    }
  }
});

router.post("/wait", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ voice: "woman" }, "All agents are busy. Please stay on the line.");
  vr.pause({ length: 10 });
  vr.redirect({ method: "POST" }, `${process.env.SERVER_URL}/api/twilio/wait`);
  res.type("text/xml").send(vr.toString());
});

router.post("/outbound-voice/:callLogId", async (req, res) => {
  try {
    const { callLogId } = req.params;
    const { CallSid, AnsweredBy } = req.body;

    const callLog = await CallLog.findById(callLogId);
    if (!callLog) throw new Error("Call log not found");

    const baseUrl = new URL(process.env.SERVER_URL);
    const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLogId}`;

    const twilioService = getTwilioService();
    const answeredBy = String(AnsweredBy || "").toLowerCase();

    if (CallSid) {
      await twilioService.markAnsweredBy(CallSid, answeredBy || "unknown");
    }

    if (answeredBy === "human") {
      if (CallSid) {
        await twilioService.markHumanAnswered(CallSid, "human");
        await twilioService.startCallRecording(CallSid);
      }

      const twiml = twilioService.buildStreamTwiml(wsUrl);
      res.type("text/xml");
      return res.send(twiml);
    }

    if (isNonHumanAnsweredBy(answeredBy) || !answeredBy) {
      if (CallSid) {
        await twilioService.markNonHumanAndFinalize(
          CallSid,
          answeredBy || "unknown"
        );
      }

      const twiml = twilioService.buildHangupTwiml();
      res.type("text/xml");
      return res.send(twiml);
    }

    if (CallSid) {
      await twilioService.markNonHumanAndFinalize(CallSid, answeredBy || "unknown");
    }

    const twiml = twilioService.buildHangupTwiml();
    res.type("text/xml");
    return res.send(twiml);
  } catch (err) {
    console.error("outbound-voice error:", err);

    const vr = new twilio.twiml.VoiceResponse();
    vr.hangup();
    res.type("text/xml").send(vr.toString());
  }
});

router.post("/outbound-status", async (req, res) => {
  try {
    const {
      CallSid,
      CallStatus,
      CallDuration,
      AnsweredBy,
      RecordingUrl,
      RecordingStatus,
    } = req.body;

    const status = normalizeCallStatus(CallStatus);
    const duration = CallDuration != null ? parseInt(CallDuration, 10) : null;
    const answeredBy = String(AnsweredBy || "").toLowerCase();

    const callLog = await CallLog.findOne({ callSid: CallSid });

    if (callLog) {
      callLog.status = status;

      if (duration != null && !Number.isNaN(duration)) {
        callLog.duration = duration;
      }

      if (answeredBy) {
        callLog.answeredBy = answeredBy;
      }

      if (
        RecordingStatus === "completed" &&
        RecordingUrl &&
        !callLog.recordingUrl
      ) {
        callLog.recordingUrl = RecordingUrl.includes(".mp3")
          ? RecordingUrl
          : `${RecordingUrl}.mp3`;
      }

      if (isFinalStatus(status)) {
        callLog.endTime = new Date();
      }

      const mappedDisposition = mapFinalDisposition({
        status,
        answeredBy,
        existingDisposition: callLog.disposition,
      });

      if (mappedDisposition) {
        callLog.disposition = mappedDisposition;
      }

      await callLog.save();

      if (callLog.job && isFinalStatus(status)) {
        const queueService = getDialerQueueService();

        let result = null;
        if (callLog.disposition === "VOICEMAIL") result = "voicemail";
        else if (callLog.disposition === "ANSWERING_MACHINE") result = "amd_unknown";
        else if (callLog.disposition === "NO_ANSWER") result = "no_answer";
        else if (callLog.disposition === "NOT_INTERESTED") result = "not_interested";
        else if (callLog.disposition === "HUMAN_ANSWERED") result = "interested";

        await queueService.handleCallCompletion(
          CallSid,
          status,
          callLog.duration || duration || 0,
          result,
          callLog.disposition
        );
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("outbound-status error:", err);
    return res.sendStatus(500);
  }
});

router.post("/recording-status", async (req, res) => {
  try {
    const { CallSid, RecordingUrl, RecordingStatus } = req.body;

    if (RecordingStatus === "completed" && CallSid && RecordingUrl) {
      const url = RecordingUrl.includes(".mp3")
        ? RecordingUrl
        : `${RecordingUrl}.mp3`;

      await CallLog.findOneAndUpdate(
        { callSid: CallSid },
        { recordingUrl: url },
        { new: true }
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Recording status error:", err.message);
    return res.sendStatus(200);
  }
});

router.post("/stream-status", async (req, res) => {
  try {
    const { StreamSid, StreamStatus, CallSid, ErrorCode } = req.body;

    if (CallSid && StreamSid) {
      await CallLog.findOneAndUpdate(
        { callSid: CallSid },
        {
          "stream.sid": StreamSid,
          "stream.status": StreamStatus || "unknown",
          "stream.errorCode": ErrorCode || null,
          "stream.updatedAt": new Date(),
        },
        { new: false }
      ).catch(() => {});
    }

    return res.sendStatus(200);
  } catch (err) {
    return res.sendStatus(200);
  }
});

router.post("/transfer/:callSid", async (req, res) => {
  try {
    const { callSid } = req.params;

    const callLog = await CallLog.findOne({ callSid }).populate("campaign");
    if (!callLog?.campaign) {
      return res.status(404).json({ error: "CallLog/Campaign not found" });
    }

    const enabled = !!callLog.campaign.transferSettings?.enabled;
    const buyerDid = String(callLog.campaign.transferSettings?.number || "").trim();

    if (!enabled) {
      return res
        .status(400)
        .json({ error: "Transfer is disabled for this campaign" });
    }

    if (!buyerDid) {
      return res
        .status(400)
        .json({ error: "Buyer DID missing in campaign transferSettings" });
    }

    const twilioService = getTwilioService();
    await twilioService.transferCall(callSid, buyerDid);

    await CallLog.findOneAndUpdate(
      { callSid },
      {
        disposition: "TRANSFERRED_TO_LICENSED_AGENT",
        result: "interested",
      },
      { new: false }
    );

    return res.json({ ok: true, transferredTo: buyerDid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;