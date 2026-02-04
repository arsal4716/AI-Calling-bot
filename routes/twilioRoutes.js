const express = require("express");
const twilio = require("twilio");
const { getTwilioService } = require("../services/twilioSingleton");

const router = express.Router();

router.post("/voice", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  try {
    const {
      CallSid,
      From,
      To,
      CallStatus,
      Direction,
    } = req.body;

    const campaignId = req.query?.campaignId || null;

    console.log("VOICE webhook:", {
      CallSid,
      From,
      To,
      CallStatus,
      Direction,
      campaignId,
    });

    const twilioService = getTwilioService();

    const result = await twilioService.handleVoiceWebhook({
      callSid: CallSid,
      from: From,
      to: To,
      callStatus: CallStatus,
      direction: Direction,
      campaignId,
    });

    res.type("text/xml");
    return res.status(200).send(result.twiml);
  } catch (error) {
    console.error("Voice webhook error:", error);

    vr.say({ voice: "woman" }, "We are experiencing technical difficulties.");
    vr.hangup();

    res.type("text/xml");
    return res.status(200).send(vr.toString());
  }
});

router.post("/status", async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;

    console.log("STATUS callback:", { CallSid, CallStatus, CallDuration });

    const twilioService = getTwilioService();
    await twilioService.updateCallStatus(CallSid, CallStatus, CallDuration);

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Status callback error:", error);
    return res.status(200).send("OK");
  }
});

router.post("/wait", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  vr.say({ voice: "woman" }, "All agents are busy. Please stay on the line.");
  vr.pause({ length: 10 });

  const serverUrl = process.env.SERVER_URL;
  vr.redirect({ method: "POST" }, `${serverUrl}/api/twilio/wait`);

  res.type("text/xml");
  res.status(200).send(vr.toString());
});

module.exports = router;
