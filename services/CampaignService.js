// services/CampaignService.js
const Campaign = require("../models/Campaign");
const CallLog = require("../models/callLogModel");

class CampaignService {
  async getCampaignByDID(twilioDid) {
    try {
      const campaign = await Campaign.findOne({ twilioDid, isActive: true });
      return campaign;
    } catch (error) {
      console.error("Get campaign by DID error:", error);
      throw error;
    }
  }

  async getCampaignWithPrompt(campaignId) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) return null;

      const activePrompt = campaign.prompts.find((p) => p.isActive);
      const prompt = activePrompt || campaign.prompts[0];

      const systemPrompt = (prompt?.content || "").trim();
      const openingLine = (prompt?.openingLine || "").trim();
      const agentName = (campaign.agentName || "Anna").trim();

      return { campaign, systemPrompt, openingLine, agentName };
    } catch (error) {
      console.error("Get campaign with prompt error:", error);
      throw error;
    }
  }

  async updateCampaignStats(campaignId, callDuration) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (campaign) {
      }
    } catch (error) {
      console.error("Update campaign stats error:", error);
    }
  }

  async getCampaignCallLogs(campaignId, limit = 50) {
    try {
      const callLogs = await CallLog.find({ campaign: campaignId })
        .sort("-startTime")
        .limit(limit)
        .populate("campaign", "name");

      return callLogs;
    } catch (error) {
      console.error("Get campaign call logs error:", error);
      throw error;
    }
  }

  async switchActivePrompt(campaignId, promptName) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) {
        throw new Error("Campaign not found");
      }
      campaign.prompts.forEach((prompt) => {
        prompt.isActive = prompt.name === promptName;
      });

      await campaign.save();
      return campaign;
    } catch (error) {
      console.error("Switch active prompt error:", error);
      throw error;
    }
  }

  // Validate campaign configuration
  async validateCampaign(campaignId) {
    try {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) {
        return { valid: false, error: "Campaign not found" };
      }

      const errors = [];

      if (!campaign.twilioDid) {
        errors.push("Twilio DID not configured");
      }

      if (!campaign.voiceId) {
        errors.push("Voice not configured");
      }

      if (!campaign.prompts || campaign.prompts.length === 0) {
        errors.push("No prompts configured");
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : null,
        campaign,
      };
    } catch (error) {
      console.error("Validate campaign error:", error);
      return { valid: false, error: "Validation failed" };
    }
  }
}
module.exports = CampaignService;
