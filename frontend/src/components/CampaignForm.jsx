import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { X, Upload, HelpCircle } from "lucide-react";
import { motion } from "framer-motion";
import { campaignAPI, voiceAPI, customVoiceAPI } from "../services/api";
import toast from "react-hot-toast";

const CampaignForm = ({ campaign, onSuccess, onCancel }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
  } = useForm({
    defaultValues: campaign || {
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: true,
      },
    },
  });

  const [voices, setVoices] = useState({ cloned: [], prebuilt: [] });
  const [promptFile, setPromptFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [voiceType, setVoiceType] = useState("prebuilt");
  const [customVoices, setCustomVoices] = useState([]);

  const voiceSettings = watch("voiceSettings");

  useEffect(() => {
    loadVoices();
    if (campaign?.voiceId) {
      const isCloned = campaign.voiceId.includes("clone");
      setVoiceType(isCloned ? "cloned" : "prebuilt");
    }
  }, []);

  const loadVoices = async () => {
    try {
      console.log("Loading voices...");

      const [voicesResponse, customVoicesResponse] = await Promise.all([
        voiceAPI.getAll(),
        customVoiceAPI.getAll().catch((err) => {
          console.error("Custom voices API error:", err);
          console.error("Response:", err.response);
          return { data: [] };
        }),
      ]);

      console.log("Voices response:", voicesResponse.data);
      console.log("Custom voices response:", customVoicesResponse.data);

      setVoices(voicesResponse.data);
      setCustomVoices(customVoicesResponse.data || []);
    } catch (error) {
      console.error("Failed to load voices:", error);
      toast.error("Failed to load some voice data");
    }
  };
  const onSubmit = async (data) => {
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("name", data.name);
      formData.append("twilioDid", data.twilioDid);
      formData.append("voiceId", data.voiceId);
      formData.append("voiceSettings", JSON.stringify(data.voiceSettings));

      if (promptFile) {
        formData.append("prompts", promptFile);
      }

      if (campaign?._id) {
        await campaignAPI.update(campaign._id, formData);
      } else {
        await campaignAPI.create(formData);
      }

      onSuccess();
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to save campaign");
    } finally {
      setLoading(false);
    }
  };

  const availableVoices =
    voiceType === "cloned" ? voices.cloned : voices.prebuilt;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-4xl mx-auto"
    >
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-6 border-b border-gray-200">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold text-gray-900">
              {campaign ? "Edit Campaign" : "Create New Campaign"}
            </h2>
            <button
              onClick={onCancel}
              className="p-2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-gray-600 mt-1">
            Configure your AI calling campaign with prompts and voice settings
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Basic Information
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Campaign Name *
                </label>
                <input
                  type="text"
                  {...register("name", {
                    required: "Campaign name is required",
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., Sales Outreach Q4"
                />
                {errors.name && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.name.message}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Twilio DID (Phone Number) *
                </label>
                <input
                  type="text"
                  {...register("twilioDid", {
                    required: "Twilio DID is required",
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="+1234567890"
                />
                {errors.twilioDid && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.twilioDid.message}
                  </p>
                )}
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Transfer Settings</h3>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    {...register("transferSettings.enabled")}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <label className="ml-2 text-sm text-gray-700">
                    Enable call transfer on qualification
                  </label>
                </div>
                {watch("transferSettings.enabled") && (
                  <div>
                    <label className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                      Transfer Number
                    </label>
                    <input
                      type="text"
                      {...register("transferSettings.number", {
                        required: "Transfer number required when enabled",
                      })}
                      className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="+1234567890"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Voice Selection */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">
              Voice Configuration
            </h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Voice Type
              </label>
              <div className="flex space-x-4 mb-4">
                <button
                  type="button"
                  onClick={() => setVoiceType("prebuilt")}
                  className={`px-4 py-2 rounded-lg ${voiceType === "prebuilt" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                >
                  Prebuilt Voices
                </button>
                <button
                  type="button"
                  onClick={() => setVoiceType("cloned")}
                  className={`px-4 py-2 rounded-lg ${voiceType === "cloned" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                >
                  Cloned Voices
                </button>
                <button
                  type="button"
                  onClick={() => setVoiceType("custom")}
                  className={`px-4 py-2 rounded-lg ${voiceType === "custom" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                >
                  Custom Voices
                </button>
              </div>
              <select
                {...register("voiceId", {
                  required: "Voice selection is required",
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select a voice</option>
                {voiceType === "prebuilt" &&
                  voices.prebuilt?.map((voice) => (
                    <option key={voice.voice_id} value={voice.voice_id}>
                      {voice.name}
                    </option>
                  ))}
                {voiceType === "cloned" &&
                  voices.cloned?.map((voice) => (
                    <option key={voice._id} value={voice.voiceId}>
                      {voice.name}
                    </option>
                  ))}
                {voiceType === "custom" &&
                  customVoices?.map((voice) => (
                    <option key={voice._id} value={voice.voiceId}>
                      {voice.name}
                    </option>
                  ))}
              </select>{" "}
              {errors.voiceId && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.voiceId.message}
                </p>
              )}
            </div>

            {/* Voice Settings */}
            <div className="space-y-4 p-4 bg-gray-50 rounded-lg">
              <h4 className="font-medium text-gray-900">Voice Settings</h4>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stability: {voiceSettings?.stability || 0.5}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    {...register("voiceSettings.stability")}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>More variable</span>
                    <span>More stable</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Similarity Boost: {voiceSettings?.similarity_boost || 0.75}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    {...register("voiceSettings.similarity_boost")}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>Less similar</span>
                    <span>More similar</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    {...register("voiceSettings.use_speaker_boost")}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="text-sm text-gray-700">
                    Use speaker boost (enhances voice clarity)
                  </span>
                </label>
              </div>
            </div>
          </div>

          {/* Prompts */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Prompts</h3>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Upload Prompts TXT
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
                  Optional
                </span>
              </label>
              <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-lg">
                <div className="space-y-1 text-center">
                  <Upload className="mx-auto h-12 w-12 text-gray-400" />
                  <div className="flex text-sm text-gray-600">
                    <label className="relative cursor-pointer bg-white rounded-md font-medium text-blue-600 hover:text-blue-500">
                      <span>Upload a TXT file</span>
                      <input
                        type="file"
                        className="sr-only"
                        accept=".txt"
                        onChange={(e) => setPromptFile(e.target.files[0])}
                      />
                    </label>
                    <p className="pl-1">or drag and drop</p>
                  </div>
                  <p className="text-xs text-gray-500">
                    TXT with columns: prompt_name,prompt_content
                  </p>
                  {promptFile && (
                    <p className="text-sm text-gray-900 mt-2">
                      Selected: {promptFile.name}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-2 flex items-center text-sm text-gray-500">
                <HelpCircle className="h-4 w-4 mr-1" />
                <span>Leave empty to use existing prompts from campaign</span>
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={loading}
            >
              {loading
                ? "Saving..."
                : campaign
                  ? "Update Campaign"
                  : "Create Campaign"}
            </button>
          </div>
        </form>
      </div>
    </motion.div>
  );
};

export default CampaignForm;
