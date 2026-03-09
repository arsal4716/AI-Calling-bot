const Campaign = require("../models/Campaign");
const fs = require("fs");
const extractOpeningLine = require("../utils/extractOpeningLine");

const parseTxtPrompt = (filePath) => {
  const content = fs.readFileSync(filePath, "utf-8").trim();

  if (!content) {
    throw new Error("TXT file is empty");
  }

  const openingLine = extractOpeningLine(filePath);
  return {
    name: "Main Prompt",
    content,
    openingLine,
    isActive: true,
  };
};

const createCampaign = async (req, res) => {
  try {
    const { name, twilioDid, sipUser, voiceId } = req.body;
    const createdBy = req.user._id;

    let voiceSettings = {};
    if (req.body.voiceSettings) {
      voiceSettings =
        typeof req.body.voiceSettings === "string"
          ? JSON.parse(req.body.voiceSettings)
          : req.body.voiceSettings;
    }

    let transferSettings = { enabled: false, number: "" };
    if (req.body.transferSettings) {
      transferSettings =
        typeof req.body.transferSettings === "string"
          ? JSON.parse(req.body.transferSettings)
          : req.body.transferSettings;
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
      sipUser: (sipUser || "").trim().toLowerCase(),
      voiceId,
      voiceSettings,
      transferSettings,
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
        openingLine: extractOpeningLine(req.file.path),
        txtPath: req.file.path,
        isActive: true,
      });
    }

    if (req.body.name) campaign.name = req.body.name;
    if (req.body.twilioDid) campaign.twilioDid = req.body.twilioDid;

    if (req.body.sipUser !== undefined) {
      campaign.sipUser = String(req.body.sipUser || "").trim().toLowerCase();
    }

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

    if (req.body.transferSettings) {
      const parsedTransferSettings =
        typeof req.body.transferSettings === "string"
          ? JSON.parse(req.body.transferSettings)
          : req.body.transferSettings;

      campaign.transferSettings = {
        ...campaign.transferSettings,
        ...parsedTransferSettings,
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