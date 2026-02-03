const Campaign = require("../models/Campaign");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const parseTxtPrompt = (filePath) => {
  const content = fs.readFileSync(filePath, "utf-8").trim();

  if (!content) {
    throw new Error("TXT file is empty");
  }

  return {
    name: "Main Prompt",
    content,
    isActive: true,
  };
};

const createCampaign = async (req, res) => {
  try {
    const { name, twilioDid, voiceId } = req.body;
   
    const createdBy = req.user._id;
    let voiceSettings = {};
    if (req.body.voiceSettings) {
      voiceSettings =
        typeof req.body.voiceSettings === "string"
          ? JSON.parse(req.body.voiceSettings)
          : req.body.voiceSettings;
    }

    let prompts = [];

    if (req.file) {
      const prompt = parseTxtPrompt(req.file.path);
      prompts.push({
        ...prompt,
        txtPath: req.file.path,
      });
    }

    const campaign = await Campaign.create({
      name,
      twilioDid,
      voiceId,
      voiceSettings,
      prompts,
      createdBy,
    });

    res.status(201).json(campaign);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message || "Server error" });
  }
};

const getCampaigns = async (req, res) => {
  try {
    const campaigns = await Campaign.find({ createdBy: req.user._id })
      .populate("createdBy", "name email")
      .sort("-createdAt");

    res.json(campaigns);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

const getCampaignById = async (req, res) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    }).populate("createdBy", "name email");

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    res.json(campaign);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

const updateCampaign = async (req, res) => {
  try {
    const campaign = await Campaign.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    if (req.file) {
      const content = fs.readFileSync(req.file.path, "utf-8").trim();

      if (!content) {
        return res.status(400).json({ message: "TXT file is empty" });
      }

      campaign.prompts.forEach((p) => (p.isActive = false));

      campaign.prompts.push({
        name: "Main Prompt",
        content,
        txtPath: req.file.path,
        isActive: true,
      });
    }

    // Update fields
    if (req.body.name) campaign.name = req.body.name;
    if (req.body.twilioDid) campaign.twilioDid = req.body.twilioDid;
    if (req.body.voiceId) campaign.voiceId = req.body.voiceId;

    if (req.body.voiceSettings) {
      const parsedSettings =
        typeof req.body.voiceSettings === "string"
          ? JSON.parse(req.body.voiceSettings)
          : req.body.voiceSettings;

      campaign.voiceSettings = {
        ...campaign.voiceSettings,
        ...parsedSettings,
      };
    }

    await campaign.save();
    res.json(campaign);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

const deleteCampaign = async (req, res) => {
  try {
    const campaign = await Campaign.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found" });
    }

    res.json({ message: "Campaign removed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
};
