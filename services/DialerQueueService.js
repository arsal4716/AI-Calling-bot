const mongoose = require('mongoose');
const DialerJob = require('../models/DialerJob');
const DialerNumber = require('../models/DialerNumber');
const DialerSlot = require('../models/DialerSlot');
const CallLog = require('../models/callLogModel');
const { getIo } = require('../socketManager');

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

    this.processJob(jobId);

    return job;
  }

  // Stop job (no new calls)
  async stopJob(jobId) {
    return DialerJob.findByIdAndUpdate(jobId, { status: 'stopped' });
  }

  // Main processing loop: fill all free slots
  async processJob(jobId) {
    const job = await DialerJob.findOne({ _id: jobId, status: 'running' });
    if (!job) return;

    let acquired;
    do {
      acquired = await this._acquireSlotAndDial(jobId);
    } while (acquired);
  }

  // Acquire one slot and dial a number
  async _acquireSlotAndDial(jobId) {
    // 1. Atomically take a free slot
    const slot = await DialerSlot.findOneAndUpdate(
      { job: jobId, status: 'free' },
      { status: 'taken' },
      { new: true, sort: { slotId: 1 } }
    );
    if (!slot) return false;

    // 2. Atomically claim a pending number
    const numberDoc = await DialerNumber.findOneAndUpdate(
      { job: jobId, status: 'pending' },
      { status: 'processing', updatedAt: new Date() },
      { new: true, sort: { _id: 1 } }
    );

    if (!numberDoc) {
      // No numbers left → release slot
      await DialerSlot.findByIdAndUpdate(slot._id, { status: 'free' });
      return false;
    }

    try {
      // Get campaign and from number
      const jobData = await DialerJob.findById(jobId).populate('campaign').lean();
      const fromNumber = jobData.campaign.twilioNumber; // adjust field name as needed
      if (!fromNumber) throw new Error('Campaign missing Twilio number');

      // Create call log first (to have ID for WebSocket URL)
      const callLog = await CallLog.create({
        campaign: jobData.campaign._id,
        job: jobId,
        fromNumber,
        toNumber: numberDoc.phoneNumber,
        status: 'initiated'
      });

      // Initiate Twilio call
      const call = await this.twilioService.client.calls.create({
        to: numberDoc.phoneNumber,
        from: fromNumber,
        url: `${process.env.SERVER_URL}/api/twilio/outbound-voice/${callLog._id}`,
        statusCallback: `${process.env.SERVER_URL}/api/twilio/outbound-status`,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",

        record: true,
        recordingChannels: "dual",
        recordingTrack: "both",
        recordingStatusCallback: `${process.env.SERVER_URL}/api/twilio/recording-status`,
        recordingStatusCallbackMethod: "POST",
      });
      // Update number and slot
      numberDoc.callSid = call.sid;
      await numberDoc.save();
      await DialerSlot.findByIdAndUpdate(slot._id, { takenBy: call.sid });

      // Update call log with callSid
      callLog.callSid = call.sid;
      await callLog.save();

      // Increment job processing count
      await DialerJob.findByIdAndUpdate(jobId, { $inc: { 'stats.processing': 1 } });

      // Socket update
      getIo().to(`job:${jobId}`).emit('dialer:update', {
        type: 'processing',
        number: numberDoc.phoneNumber,
        callSid: call.sid
      });

      return true;
    } catch (err) {
      console.error('Dial failed:', err);
      numberDoc.status = 'failed';
      await numberDoc.save();
      await DialerSlot.findByIdAndUpdate(slot._id, { status: 'free' });
      await DialerJob.findByIdAndUpdate(jobId, { $inc: { 'stats.failed': 1 } });
      getIo().to(`job:${jobId}`).emit('dialer:update', {
        type: 'failed',
        number: numberDoc.phoneNumber
      });
      return false;
    }
  }

  // Called by Twilio webhook when a call ends
  async handleCallCompletion(callSid, finalStatus, duration, result, disposition) {
    const numberDoc = await DialerNumber.findOne({ callSid }).populate('job');
    if (!numberDoc) return;

    const jobId = numberDoc.job._id;

    numberDoc.status = finalStatus === 'completed' ? 'completed' : 'failed';
    numberDoc.result = result || null;
    numberDoc.duration = duration || 0;
    await numberDoc.save();

    await CallLog.findOneAndUpdate(
      { callSid },
      { status: finalStatus, duration, result, disposition, endTime: new Date() }
    );

    // Update job stats
    const update = { $inc: { 'stats.processing': -1 } };
    if (finalStatus === 'completed') update.$inc['stats.completed'] = 1;
    else update.$inc['stats.failed'] = 1;
    await DialerJob.findByIdAndUpdate(jobId, update);

    // Release slot
    await DialerSlot.findOneAndUpdate({ job: jobId, takenBy: callSid }, { status: 'free', takenBy: null });

    // Emit progress
    const job = await DialerJob.findById(jobId).lean();
    getIo().to(`job:${jobId}`).emit('dialer:progress', job.stats);
    getIo().to(`job:${jobId}`).emit('dialer:update', {
      type: finalStatus,
      number: numberDoc.phoneNumber,
      callSid
    });

    // If job still running, trigger next dial
    if (job.status === 'running') this.processJob(jobId);
  }
}

module.exports = DialerQueueService;