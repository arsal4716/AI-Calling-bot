const DialerJob = require("../models/DialerJob");
const DialerNumber = require("../models/DialerNumber");
const DialerSlot = require("../models/DialerSlot");
const CallLog = require("../models/callLogModel");
const { getIo } = require("../socketManager");

class DialerQueueService {
  constructor(twilioService) {
    this.twilioService = twilioService;
  }

  async startJob(jobId) {
    const job = await DialerJob.findOneAndUpdate(
      { _id: jobId, status: { $in: ["pending", "stopped"] } },
      { $set: { status: "running", startedAt: new Date() } },
      { new: true }
    );

    if (!job) throw new Error("Job not found or job cannot be started");

    const existingSlots = await DialerSlot.countDocuments({ job: jobId });
    if (existingSlots === 0) {
      const slots = Array.from({ length: job.maxConcurrency }, (_, i) => ({
        job: jobId,
        slotId: i + 1,
        status: "free",
      }));
      await DialerSlot.insertMany(slots, { ordered: false });
    }

    this.processJob(jobId).catch((e) => console.error("processJob error:", e));
    return job;
  }

  async stopJob(jobId) {
    return DialerJob.findByIdAndUpdate(
      jobId,
      { status: "stopped" },
      { new: true }
    );
  }

  async processJob(jobId) {
    const job = await DialerJob.findOne({ _id: jobId, status: "running" });
    if (!job) return;

    let acquired;
    do {
      acquired = await this._acquireSlotAndDial(jobId);
    } while (acquired);
  }

  async _acquireSlotAndDial(jobId) {
    const slot = await DialerSlot.findOneAndUpdate(
      { job: jobId, status: "free" },
      { status: "taken" },
      { new: true, sort: { slotId: 1 } }
    );
    if (!slot) return false;

    const numberDoc = await DialerNumber.findOneAndUpdate(
      { job: jobId, status: "pending" },
      { status: "processing", updatedAt: new Date() },
      { new: true, sort: { _id: 1 } }
    );

    if (!numberDoc) {
      await DialerSlot.findByIdAndUpdate(slot._id, {
        status: "free",
        takenBy: null,
      });
      return false;
    }

    try {
      const jobData = await DialerJob.findById(jobId)
        .populate("campaign")
        .lean();

      const fromNumber = jobData?.campaign?.twilioDid;
      if (!fromNumber) throw new Error("Campaign missing Twilio number");

      const callLog = await CallLog.create({
        campaign: jobData.campaign._id,
        job: jobId,
        fromNumber,
        toNumber: numberDoc.phoneNumber,
        status: "initiated",
        direction: "outbound-api",
      });

      const call = await this.twilioService.client.calls.create({
        to: numberDoc.phoneNumber,
        from: fromNumber,

        url: `${process.env.SERVER_URL}/api/twilio/outbound-voice/${callLog._id}`,
        method: "POST",

        statusCallback: `${process.env.SERVER_URL}/api/twilio/outbound-status`,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],

        machineDetection: "Enable",

        timeout: 20,

        record: true,
        recordingChannels: "dual",
        recordingTrack: "both",
        recordingStatusCallback: `${process.env.SERVER_URL}/api/twilio/recording-status`,
        recordingStatusCallbackMethod: "POST",
      });

      numberDoc.callSid = call.sid;
      await numberDoc.save();

      callLog.callSid = call.sid;
      await callLog.save();

      await DialerSlot.findByIdAndUpdate(slot._id, {
        takenBy: call.sid,
      });

      await DialerJob.findByIdAndUpdate(jobId, {
        $inc: { "stats.processing": 1 },
      });

      getIo().to(`job:${jobId}`).emit("dialer:update", {
        type: "processing",
        number: numberDoc.phoneNumber,
        callSid: call.sid,
      });

      return true;
    } catch (err) {
      console.error("Dial failed:", err);

      numberDoc.status = "failed";
      await numberDoc.save();

      await DialerSlot.findByIdAndUpdate(slot._id, {
        status: "free",
        takenBy: null,
      });

      await DialerJob.findByIdAndUpdate(jobId, {
        $inc: { "stats.failed": 1 },
      });

      getIo().to(`job:${jobId}`).emit("dialer:update", {
        type: "failed",
        number: numberDoc.phoneNumber,
      });

      return false;
    }
  }

  async handleCallCompletion(callSid, finalStatus, duration, result, disposition) {
    const numberDoc = await DialerNumber.findOne({ callSid }).populate("job");
    if (!numberDoc) return;

    const jobId = numberDoc.job._id;

    numberDoc.status = finalStatus === "completed" ? "completed" : "failed";
    numberDoc.result = result || null;
    numberDoc.duration = duration || 0;
    await numberDoc.save();

    await CallLog.findOneAndUpdate(
      { callSid },
      {
        status: finalStatus,
        duration: duration || 0,
        result,
        disposition,
        endTime: new Date(),
      }
    );

    const update = { $inc: { "stats.processing": -1 } };
    if (finalStatus === "completed") update.$inc["stats.completed"] = 1;
    else update.$inc["stats.failed"] = 1;

    await DialerJob.findByIdAndUpdate(jobId, update);

    await DialerSlot.findOneAndUpdate(
      { job: jobId, takenBy: callSid },
      { status: "free", takenBy: null }
    );

    const job = await DialerJob.findById(jobId).lean();

    getIo().to(`job:${jobId}`).emit("dialer:progress", job.stats);
    getIo().to(`job:${jobId}`).emit("dialer:update", {
      type: finalStatus,
      number: numberDoc.phoneNumber,
      callSid,
    });

    if (job.status === "running") {
      this.processJob(jobId).catch(() => { });
    }
  }
}

module.exports = DialerQueueService;