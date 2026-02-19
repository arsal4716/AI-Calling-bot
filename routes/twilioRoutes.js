const express = require("express");
const twilio = require("twilio");
const { getTwilioService } = require("../services/twilioSingleton");

const router = express.Router();

router.post("/webhook", async (req, res) => {
  try {
    const { CallSid, From, To, CallStatus, Direction } = req.body;
    console.log("Webhook received:", {
      CallSid,
      From,
      To,
      CallStatus,
      Direction,
    });

    const twilioService = getTwilioService();

    const needsTwiml =
      CallStatus === "ringing" ||
      CallStatus === "queued" ||
      CallStatus === "initiated" ||
      CallStatus === "in-progress" ||
      (Direction && Direction.startsWith("outbound"));

    if (needsTwiml) {
      const result = await twilioService.handleIncomingCall(
        CallSid,
        From,
        To,
        Direction,
      );
      console.log("Twiml response:", result.twiml);
      res.type("text/xml");
      return res.send(result.twiml);
    }

    await twilioService.updateCallStatus(CallSid, CallStatus);
    console.log("Call status updated:", CallStatus);

    res.status(200).send("OK");
  } catch (error) {
    console.error("Twilio webhook error:", error);
    if (!res.headersSent) res.status(500).send("Error processing webhook");
  }
});

router.post("/wait", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ voice: "woman" }, "All agents are busy. Please stay on the line.");
  vr.pause({ length: 10 });

  vr.redirect({ method: "POST" }, `${process.env.SERVER_URL}/api/twilio/wait`);

  res.type("text/xml").send(vr.toString());
});
// Outbound voice TwiML (returns stream URL)
router.post('/outbound-voice/:callLogId', async (req, res) => {
  try {
    const { callLogId } = req.params;
    const callLog = await CallLog.findById(callLogId);
    if (!callLog) throw new Error('Call log not found');

    const baseUrl = new URL(process.env.SERVER_URL);
    const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${baseUrl.host}/media-stream/${callLogId}`;
    const twiml = getTwilioService().buildStreamTwiml(wsUrl);
    res.type('text/xml').send(twiml);
  } catch (err) {
    const vr = new twilio.twiml.VoiceResponse();
    vr.say('Error'); vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
});

// Outbound status callback
router.post('/outbound-status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;
    const callLog = await CallLog.findOne({ callSid: CallSid });
    if (callLog) {
      callLog.status = CallStatus;
      if (CallDuration) callLog.duration = parseInt(CallDuration);
      if (['completed','failed','busy','no-answer'].includes(CallStatus)) callLog.endTime = new Date();
      await callLog.save();

      if (callLog.job) {
        const queueService = getDialerQueueService();
        // Map status to result (can be refined later by AI)
        const result = CallStatus === 'completed' ? 'interested' : null;
        await queueService.handleCallCompletion(CallSid, CallStatus, CallDuration, result);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});
module.exports = router;
