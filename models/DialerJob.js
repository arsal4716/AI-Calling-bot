const mongoose = require('mongoose');

const dialerJobSchema = new mongoose.Schema({
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    fileName: String,
    totalNumbers: { type: Number, default: 0 },
    maxConcurrency: { type: Number, default: 20, min: 1, max: 20 },
    status: { type: String, enum: ['pending', 'running', 'completed', 'stopped'], default: 'pending', index: true },
    stats: {
        processing: { type: Number, default: 0 },
        completed: { type: Number, default: 0 },
        failed: { type: Number, default: 0 }
    },
    createdAt: { type: Date, default: Date.now, index: true },
    startedAt: Date,
    completedAt: Date
});

dialerJobSchema.index({ campaign: 1, status: 1 });
dialerJobSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('DialerJob', dialerJobSchema);