// models/Campaign.js
const mongoose = require("mongoose");

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  twilioDid: { type: String, required: true },

  prompts: [
    {
      name: { type: String, required: true },
      content: { type: String, required: true },
      openingLine: {
        type: String,
        default: `Hey… thank you so much for taking the call.
This is ${agentname} with healthcare benefits.
I hope you're doing well.
We're calling to offer a no-obligation, no-cost health insurance plan quote designed for individuals under 65.
Some plans may involve a modest low charge, and to activate coverage the insurance company may require a small binder payment.
I just need to ask a few quick questions to see if you may qualify.
May I ask how old you are?
`,
      },

      txtPath: String,
      isActive: { type: Boolean, default: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],

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
