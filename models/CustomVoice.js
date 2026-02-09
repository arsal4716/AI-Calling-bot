const mongoose = require('mongoose');

const customVoiceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a voice name'],
    trim: true,
    unique: true, 
  },
  voiceId: {
    type: String,
    required: [true, 'ElevenLabs Voice ID is required'],
    trim: true,
  },
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

customVoiceSchema.index({ name: 1, createdBy: 1 }, { unique: true });

module.exports = mongoose.model('CustomVoice', customVoiceSchema);