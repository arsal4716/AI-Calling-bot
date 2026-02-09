const CustomVoice = require("../models/CustomVoice");

// @desc    Get all custom voices for current user
// @route   GET /api/custom-voices
// @access  Private
const getCustomVoices = async (req, res) => {
  try {
    const voices = await CustomVoice.find({ createdBy: req.user._id }).sort("-createdAt");
    res.json(voices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Create a custom voice
// @route   POST /api/custom-voices
// @access  Private
const createCustomVoice = async (req, res) => {
  try {
    const { name, voiceId } = req.body;

    // Validation
    if (!name || !voiceId) {
      return res.status(400).json({ message: "Voice name and ElevenLabs ID are required" });
    }

    // Check for duplicate name for this user
    const existingVoice = await CustomVoice.findOne({
      name,
      createdBy: req.user._id,
    });

    if (existingVoice) {
      return res.status(400).json({ message: "Voice name already exists" });
    }

    // Basic ElevenLabs voice_id validation (should be alphanumeric)
    if (!/^[a-zA-Z0-9]+$/.test(voiceId)) {
      return res.status(400).json({ message: "Invalid ElevenLabs Voice ID format" });
    }

    const customVoice = await CustomVoice.create({
      name,
      voiceId,
      createdBy: req.user._id,
    });

    res.status(201).json(customVoice);
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
      return res.status(400).json({ message: "Voice name already exists" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Update a custom voice
// @route   PUT /api/custom-voices/:id
// @access  Private
const updateCustomVoice = async (req, res) => {
  try {
    const { name, voiceId } = req.body;

    if (!name || !voiceId) {
      return res.status(400).json({ message: "Voice name and ElevenLabs ID are required" });
    }

    // Find voice and ensure it belongs to user
    let voice = await CustomVoice.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!voice) {
      return res.status(404).json({ message: "Voice not found" });
    }

    // Check if new name conflicts with another voice
    const duplicate = await CustomVoice.findOne({
      name,
      createdBy: req.user._id,
      _id: { $ne: req.params.id },
    });

    if (duplicate) {
      return res.status(400).json({ message: "Voice name already exists" });
    }

    // Update voice
    voice.name = name;
    voice.voiceId = voiceId;
    await voice.save();

    res.json(voice);
  } catch (error) {
    console.error(error);
    if (error.code === 11000) {
      return res.status(400).json({ message: "Voice name already exists" });
    }
    res.status(500).json({ message: "Server error" });
  }
};

// @desc    Delete a custom voice
// @route   DELETE /api/custom-voices/:id
// @access  Private
const deleteCustomVoice = async (req, res) => {
  try {
    const result = await CustomVoice.deleteOne({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Voice not found" });
    }

    res.json({ message: "Voice removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getCustomVoices,
  createCustomVoice,
  updateCustomVoice,
  deleteCustomVoice,
};