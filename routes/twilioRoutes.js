const express = require("express");
const twilio = require("twilio");
const { getTwilioService } = require("../services/twilioSingleton");

const router = express.Router();

router.post("/webhook", async (req, res) => {
  try {
    const { CallSid, From, To, CallStatus } = req.body;
    console.log("Webhook received:", { CallSid, From, To, CallStatus });

    const twilioService = getTwilioService();

    if (CallStatus === "ringing") {
      const result = await twilioService.handleIncomingCall(CallSid, From, To);
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
  vr.redirect({ method: "POST" }, "/api/twilio/wait");
  res.type("text/xml").send(vr.toString());
});

module.exports = router;
