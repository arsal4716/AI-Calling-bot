const mongoose = require('mongoose');

const dialerNumberSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'DialerJob', required: true, index: true },
  phoneNumber: { type: String, required: true, index: true },
  callSid: String,
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending', index: true },
  result: { type: String, enum: ['interested', 'busy', 'not_interested', 'no_answer', null], default: null },
  recordingUrl: String,
  duration: Number,
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

dialerNumberSchema.index({ job: 1, status: 1, _id: 1 });
dialerNumberSchema.index({ callSid: 1 }, { sparse: true });
dialerNumberSchema.pre('save', function(next) { this.updatedAt = Date.now(); next(); });

module.exports = mongoose.model('DialerNumber', dialerNumberSchema);