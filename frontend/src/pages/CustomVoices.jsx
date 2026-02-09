import React, { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Plus, Edit2, Trash2, Volume2, Save, X } from "lucide-react";
import toast from "react-hot-toast";
import { customVoiceAPI } from "../services/api";
import { useAuth } from "../store/authContext";

const CustomVoices = () => {
  const { user } = useAuth();
  const [voices, setVoices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({ name: "", voiceId: "" });
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    setLoading(true);
    try {
      const response = await customVoiceAPI.getAll();
      setVoices(response.data);
    } catch (error) {
      toast.error("Failed to load custom voices");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.voiceId.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    try {
      if (editingId) {
        await customVoiceAPI.update(editingId, formData);
        toast.success("Voice updated successfully");
        setEditingId(null);
      } else {
        await customVoiceAPI.create(formData);
        toast.success("Voice added successfully");
        setShowForm(false);
      }
      setFormData({ name: "", voiceId: "" });
      loadVoices();
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to save voice");
    }
  };

  const handleEdit = (voice) => {
    setEditingId(voice._id);
    setFormData({ name: voice.name, voiceId: voice.voiceId });
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this voice?")) return;

    try {
      await customVoiceAPI.delete(id);
      toast.success("Voice deleted successfully");
      loadVoices();
    } catch (error) {
      toast.error("Failed to delete voice");
    }
  };

  const handleCancel = () => {
    setEditingId(null);
    setShowForm(false);
    setFormData({ name: "", voiceId: "" });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Custom Voices</h1>
          <p className="text-gray-600 mt-1">
            Manage your custom ElevenLabs voice mappings
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 flex items-center space-x-2"
        >
          <Plus className="h-5 w-5" />
          <span>Add Custom Voice</span>
        </button>
      </div>

      {/* Add/Edit Form */}
      {(showForm || editingId) && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
        >
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            {editingId ? "Edit Custom Voice" : "Add Custom Voice"}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Display Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., My Professional Voice"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                ElevenLabs Voice ID *
              </label>
              <input
                type="text"
                value={formData.voiceId}
                onChange={(e) =>
                  setFormData({ ...formData, voiceId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., 21m00Tcm4TlvDq8ikWAM"
              />
              <p className="text-xs text-gray-500 mt-1">
                Get this from your ElevenLabs account
              </p>
            </div>
            <div className="flex justify-end space-x-3">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center space-x-2"
              >
                <Save className="h-4 w-4" />
                <span>{editingId ? "Update Voice" : "Add Voice"}</span>
              </button>
            </div>
          </form>
        </motion.div>
      )}

      {/* Voices List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-600"></div>
        </div>
      ) : voices.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
        >
          <Volume2 className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            No custom voices yet
          </h3>
          <p className="text-gray-600 mb-6">
            Add your first custom voice mapping to get started
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700"
          >
            Add Custom Voice
          </button>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {voices.map((voice, index) => (
            <motion.div
              key={voice._id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {voice.name}
                  </h3>
                  <p className="text-sm text-gray-500 mt-1">Custom Voice</p>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleEdit(voice)}
                    className="p-2 text-gray-400 hover:text-blue-600"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(voice._id)}
                    className="p-2 text-gray-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium text-gray-700">
                    ElevenLabs Voice ID
                  </p>
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded block truncate">
                    {voice.voiceId}
                  </code>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700">Created</p>
                  <p className="text-sm text-gray-500">
                    {new Date(voice.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
};

export default CustomVoices;