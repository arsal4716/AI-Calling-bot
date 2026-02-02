const mongoose = require("mongoose");

const callLogSchema = new mongoose.Schema({
  callSid: {
    type: String,
    required: true,
    unique: true,
  },
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Campaign",
    required: true,
  },
  fromNumber: {
    type: String,
    required: true,
  },
  toNumber: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: [
      "initiated",
      "ringing",
      "queued",
      "connecting",
      "in_progress",
      "completed",
      "failed",
      "busy",
      "no_answer",
      "canceled",
      "queue_failed",
    ],
    default: "initiated",
  },
  duration: {
    type: Number,
    default: 0,
  },
  recordingUrl: String,
  transcript: String,
  aiResponses: [String],
  startTime: {
    type: Date,
    default: Date.now,
  },
  endTime: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});
callLogSchema.index({ startTime: -1 });
callLogSchema.index({ campaign: 1, startTime: -1 });
callLogSchema.index({ status: 1, startTime: -1 });
module.exports = mongoose.model("CallLogs", callLogSchema);
