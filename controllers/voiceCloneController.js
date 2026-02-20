const VoiceClone = require("../models/VoiceClone");
const Campaign = require("../models/Campaign");
const ElevenLabsService = require("../services/ElevenLabsService");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const unlink = promisify(fs.unlink);

const elevenLabsService = new ElevenLabsService();
const cloneVoice = async (req, res) => {
  try {
    const { name } = req.body;
    const createdBy = req.user._id;

    if (!req.file) {
      return res.status(400).json({ message: "Please upload an audio file" });
    }

    // Clone voice using ElevenLabs
    const voiceCloneResult = await elevenLabsService.cloneVoice(name, req.file);

    // Save voice clone to database
    const voiceClone = await VoiceClone.create({
      name,
      voiceId: voiceCloneResult.voiceId,
      audioSamplePath: req.file.path,
      createdBy,
    });

    res.status(201).json(voiceClone);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message || "Voice cloning failed" });
  }
};

const getVoices = async (req, res) => {
  try {
    const voices = await VoiceClone.find({ createdBy: req.user._id })
      .populate("createdBy", "name email")
      .sort("-createdAt");

    let prebuiltVoices = [];
    try {
      const allVoices = await elevenLabsService.getVoices();
      prebuiltVoices = allVoices.filter((v) => v.category === "premade");
    } catch (error) {
      console.error(
        "ElevenLabs getVoices failed, using fallback:",
        error.message,
      );
      prebuiltVoices = [
        {
          voice_id: "CwhRBWXzGAHq8TQ4Fs17",
          name: "Rachel",
          preview_url:
            "https://api.elevenlabs.io/v1/voices/CwhRBWXzGAHq8TQ4Fs17/preview",
        },
      ];
    }

    res.json({
      cloned: voices,
      prebuilt: prebuiltVoices,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

const playVoice = async (req, res) => {
  try {
    const {
      text = `Hey… thank you so much for taking the call.
This is Anna with healthcare benefits.
I hope you're doing well`,
      type,
    } = req.body;

    let elevenVoiceId;

    if (type === "cloned") {
      const voice = await VoiceClone.findOne({
        _id: req.params.id,
        createdBy: req.user._id,
      });

      if (!voice) {
        return res.status(404).json({ message: "Voice not found" });
      }

      elevenVoiceId = voice.voiceId;
    } else {
      elevenVoiceId = req.params.id;
    }

    const audioBuffer = await elevenLabsService.textToSpeech(
      text,
      elevenVoiceId,
    );

    res.set("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    console.error("Play voice error:", err);
    res.status(500).json({ message: "Failed to play voice" });
  }
};

const getVoiceById = async (req, res) => {
  try {
    const voice = await VoiceClone.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    }).populate("createdBy", "name email");

    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    res.json(voice);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Delete voice clone
// @route   DELETE /api/voices/:id
// @access  Private
const deleteVoice = async (req, res) => {
  try {
    const voice = await VoiceClone.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    // Delete from ElevenLabs
    await elevenLabsService.deleteVoice(voice.voiceId);

    // Delete audio file
    if (voice.audioSamplePath && fs.existsSync(voice.audioSamplePath)) {
      await unlink(voice.audioSamplePath);
    }

    // Remove voice from any campaigns using it
    await Campaign.updateMany(
      { voiceId: voice.voiceId, createdBy: req.user._id },
      { $set: { voiceId: null } },
    );

    // Delete from database
    await voice.remove();

    res.json({ message: "Voice removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Assign voice to campaign
// @route   POST /api/voices/:id/assign
// @access  Private
const assignToCampaign = async (req, res) => {
  try {
    const { campaignId } = req.body;
    const voiceId = req.params.id;

    const voice = await VoiceClone.findOne({
      _id: voiceId,
      createdBy: req.user._id,
    });

    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    const campaign = await Campaign.findOne({
      _id: campaignId,
      createdBy: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    campaign.voiceId = voice.voiceId;
    await campaign.save();

    res.json({ message: "Voice assigned to campaign successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  cloneVoice,
  getVoices,
  getVoiceById,
  deleteVoice,
  assignToCampaign,
  playVoice,
};
