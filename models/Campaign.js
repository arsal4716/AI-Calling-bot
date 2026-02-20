// models/Campaign.js
const mongoose = require("mongoose");

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  twilioDid: { type: String, required: true },

  prompts: [
    {
      name: { type: String, required: true },
      content: { type: String, required: true },
      openingLine: { type: String, default: "" },

      txtPath: String,
      isActive: { type: Boolean, default: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  transferSettings: {
  enabled: { type: Boolean, default: false },
  number: { type: String },                        
},
  voiceId: { type: String, required: true },
  voiceSettings: {
    stability: { type: Number, default: 0.5, min: 0, max: 1 },
    similarity_boost: { type: Number, default: 0.75, min: 0, max: 1 },
    style: { type: Number, default: 0, min: 0, max: 1 },
    use_speaker_boost: { type: Boolean, default: true },
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  isActive: { type: Boolean, default: true },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

campaignSchema.pre("save", function () {
  this.updatedAt = Date.now();
});
campaignSchema.index({ createdBy: 1, isActive: 1 });

module.exports = mongoose.model("Campaign", campaignSchema);
