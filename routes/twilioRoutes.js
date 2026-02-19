// routes/twilioRoutes.js
const express = require("express");
const twilio = require("twilio");
const { getTwilioService } = require("../services/twilioSingleton");
const { getDialerQueueService } = require("../services/dialerQueueSingleton");
const CallLog = require("../models/callLogModel");

const router = express.Router();
function normalizeCallStatus(s) {
  return (s || "")
    .toLowerCase()
    .replace("in-progress", "in_progress")
    .replace("no-answer", "no_answer");
}

function isFinalStatus(status) {
  return ["completed", "failed", "busy", "no_answer", "canceled"].includes(status);
}

router.post("/webhook", async (req, res) => {
  try {
    const { CallSid, From, To, CallStatus, Direction } = req.body;

    const status = normalizeCallStatus(CallStatus);
    const direction = (Direction || "").toLowerCase();

    console.log("Webhook received:", {
      CallSid,
      From,
      To,
      CallStatus,
      normalizedStatus: status,
      Direction,
    });

    const twilioService = getTwilioService();

    const needsTwiml =
      status === "ringing" ||
      status === "queued" ||
      status === "initiated" ||
      status === "in_progress" ||
      (direction && direction.startsWith("outbound"));

    if (needsTwiml) {
      const result = await twilioService.handleIncomingCall(CallSid, From, To, Direction);
      console.log("Twiml response:", result.twiml);
      res.type("text/xml");
      return res.send(result.twiml);
    }

    await twilioService.updateCallStatus(CallSid, status);
    console.log("Call status updated:", status);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Twilio webhook error:", error);
    if (!res.headersSent) return res.status(500).send("Error processing webhook");
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
    const callLog = await CallLog.findById(callLogId);
    if (!callLog) throw new Error("Call log not found");

    const baseUrl = new URL(process.env.SERVER_URL);
    const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLogId}`;

    const twiml = getTwilioService().buildStreamTwiml(wsUrl);
    res.type("text/xml").send(twiml);
  } catch (err) {
    const vr = new twilio.twiml.VoiceResponse();
    vr.say("Error");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
  }
});

router.post("/outbound-status", async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    const status = normalizeCallStatus(CallStatus);

    const callLog = await CallLog.findOne({ callSid: CallSid });
    if (callLog) {
      callLog.status = status;

      if (CallDuration) callLog.duration = parseInt(CallDuration, 10);

      if (isFinalStatus(status)) callLog.endTime = new Date();

      await callLog.save();

      if (callLog.job && isFinalStatus(status)) {
        const queueService = getDialerQueueService();
        const result = status === "completed" ? "interested" : null;

        await queueService.handleCallCompletion(
          CallSid,
          status,
          callLog.duration,
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
      const url = RecordingUrl.includes(".mp3") ? RecordingUrl : `${RecordingUrl}.mp3`;

      await CallLog.findOneAndUpdate(
        { callSid: CallSid },
        { recordingUrl: url },
        { new: true }
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Recording status error:", err.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
