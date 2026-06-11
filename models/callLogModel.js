const mongoose = require("mongoose");

const callLogSchema = new mongoose.Schema({
  callSid: { type: String, unique: true, sparse: true, index: true },
  twimlServed: { type: Boolean, default: false, index: true },
  leadId: { type: String, default: null, index: true },
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Campaign",
    required: true,
    index: true,
  },

  job: { type: mongoose.Schema.Types.ObjectId, ref: "DialerJob", index: true },

  fromNumber: { type: String, required: true, index: true },
  rawFrom: { type: String, default: null },
  toNumber: { type: String, required: true, index: true },

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

  duration: { type: Number, default: 0 },
  recordingUrl: String,
  transcript: String,
  aiResponses: [String],

  startTime: { type: Date, default: Date.now, index: true },
  endTime: Date,
  createdAt: { type: Date, default: Date.now, index: true },

  result: {
    type: String,
    enum: ["interested", "busy", "not_interested", "no_answer", null],
    default: null,
  },

  disposition: {
    type: String,
    enum: [
      "SALES",
      "DNC",
      "UNRESPONSIVE",
      "DWSPI",
      "TECH_ISSUES",
      "VOICEMAIL",
      "ANSWERING_MACHINE",
      "NO_ANSWER",
      "DISCONNECTED",
      "NOT_INTERESTED",
      "NOT_QUALIFIED",
      "TARGET_HUNG_UP",
      "CALLBACK",
      "IVR",
      "MISDIALED",
      "LANGUAGE_BARRIER",
      "SUBSIDY_INCENTIVISED",
      "HUMAN_ANSWERED",
      "MEDICAID_MEDICARE_VA_DISQUALIFIED",
      "TRANSFERRED_TO_AGENT",
      "AMD_UNKNOWN",
      "FAX",
      "NON_HUMAN",
      "BUSY"
    ],
    default: null,
    index: true,
  },

  stream: {
    sid: { type: String, index: true },
    status: { type: String },
    errorCode: { type: String },
    updatedAt: { type: Date },
  },

  endedBy: { type: String },
  answeredBy: { type: String, index: true },
  amdAt: { type: Date },
  dispositionDetail: { type: mongoose.Schema.Types.Mixed },
  capturedAnswers: { type: mongoose.Schema.Types.Mixed },
});

callLogSchema.index({ toNumber: 1, startTime: -1 });
callLogSchema.index({ campaign: 1, status: 1, startTime: -1 });
callLogSchema.index({ job: 1, status: 1 });

module.exports = mongoose.model("CallLog", callLogSchema);