const mongoose = require('mongoose');

const dialerSlotSchema = new mongoose.Schema({
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'DialerJob', required: true, index: true },
  slotId: { type: Number, required: true },
  status: { type: String, enum: ['free', 'taken'], default: 'free', index: true },
  takenBy: String, 
  createdAt: { type: Date, default: Date.now }
});

dialerSlotSchema.index({ job: 1, slotId: 1 }, { unique: true });
dialerSlotSchema.index({ job: 1, status: 1 });

module.exports = mongoose.model('DialerSlot', dialerSlotSchema);