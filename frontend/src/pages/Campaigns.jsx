import React, { useState, useEffect } from "react";
import {
  Plus,
  Edit2,
  Trash2,
  Play,
  Pause,
  MoreVertical,
  Phone,
} from "lucide-react";
import { motion } from "framer-motion";
import toast from "react-hot-toast";
import { campaignAPI } from "../services/api";
import CampaignForm from "../components/CampaignForm";
import { useAuth } from "../store/authContext";

const Campaigns = () => {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadCampaigns();
  }, []);

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const response = await campaignAPI.getAll();
      setCampaigns(response.data);
    } catch (error) {
      toast.error("Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setSelectedCampaign(null);
    setShowForm(true);
  };

  const handleEdit = (campaign) => {
    setSelectedCampaign(campaign);
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this campaign?"))
      return;

    try {
      await campaignAPI.delete(id);
      toast.success("Campaign deleted successfully");
      loadCampaigns();
    } catch (error) {
      toast.error("Failed to delete campaign");
    }
  };

  const handleToggleStatus = async (campaign) => {
    try {
      const updatedCampaign = { ...campaign, isActive: !campaign.isActive };
      await campaignAPI.update(campaign._id, updatedCampaign);
      toast.success(
        `Campaign ${updatedCampaign.isActive ? "activated" : "paused"}`,
      );
      loadCampaigns();
    } catch (error) {
      toast.error("Failed to update campaign status");
    }
  };

  const handleFormSuccess = () => {
    setShowForm(false);
    setSelectedCampaign(null);
    loadCampaigns();
    toast.success(
      `Campaign ${selectedCampaign ? "updated" : "created"} successfully`,
    );
  };

  if (showForm) {
    return (
      <CampaignForm
        campaign={selectedCampaign}
        onSuccess={handleFormSuccess}
        onCancel={() => {
          setShowForm(false);
          setSelectedCampaign(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Campaigns</h1>
          <p className="text-gray-600 mt-1">Manage your AI calling campaigns</p>
        </div>
        <button
          onClick={handleCreate}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 flex items-center space-x-2"
        >
          <Plus className="h-5 w-5" />
          <span>Create Campaign</span>
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
      ) : campaigns.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
        >
          <Phone className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            No campaigns yet
          </h3>
          <p className="text-gray-600 mb-6">
            Create your first AI calling campaign to get started
          </p>
          <button
            onClick={handleCreate}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700"
          >
            Create Campaign
          </button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {campaigns.map((campaign, index) => (
            <motion.div
              key={campaign._id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden"
            >
              <div className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {campaign.name}
                    </h3>
                    <p className="text-sm text-gray-500 mt-1">
                      {campaign.twilioDid}
                    </p>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleToggleStatus(campaign)}
                      className={`p-2 rounded-full ${campaign.isActive ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-600"}`}
                    >
                      {campaign.isActive ? (
                        <Play className="h-4 w-4" />
                      ) : (
                        <Pause className="h-4 w-4" />
                      )}
                    </button>
                    <div className="relative">
                      <button className="p-2 rounded-full hover:bg-gray-100">
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 mb-6">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      Voice ID
                    </p>
                    <p className="text-sm text-gray-500 truncate">
                      {campaign.voiceId}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">Prompts</p>
                    <p className="text-sm text-gray-500">
                      {campaign.prompts?.length || 0} prompt(s)
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">Status</p>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${campaign.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}`}
                    >
                      {campaign.isActive ? "Active" : "Paused"}
                    </span>
                  </div>
                </div>

                <div className="flex space-x-2">
                  <button
                    onClick={() => handleEdit(campaign)}
                    className="flex-1 bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 flex items-center justify-center space-x-2"
                  >
                    <Edit2 className="h-4 w-4" />
                    <span>Edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(campaign._id)}
                    className="flex-1 bg-red-50 text-red-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-100 flex items-center justify-center space-x-2"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

export default Campaigns;
