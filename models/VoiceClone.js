const mongoose = require('mongoose');

const voiceCloneSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a voice name'],
    trim: true,
  },
  voiceId: {
    type: String,
    required: [true, 'Voice ID is required'],
    unique: true,
  },
  audioSampleUrl: String,
  audioSamplePath: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
});

module.exports = mongoose.model('VoiceClone', voiceCloneSchema);