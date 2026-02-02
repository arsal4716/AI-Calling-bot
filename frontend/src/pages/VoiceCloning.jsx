import React, { useState, useEffect } from "react";
import { Upload, Copy, Trash2, Play, Volume2, Download } from "lucide-react";
import { motion } from "framer-motion";
import toast from "react-hot-toast";
import { voiceAPI } from "../services/api";
import VoiceCloneForm from "../components/VoiceCloneForm";
import { useAuth } from "../store/authContext";

const VoiceCloning = () => {
  const { user } = useAuth();
  const [voices, setVoices] = useState({ cloned: [], prebuilt: [] });
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playingVoice, setPlayingVoice] = useState(null);

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    setLoading(true);
    try {
      const response = await voiceAPI.getAll();
      setVoices(response.data);
    } catch (error) {
      toast.error("Failed to load voices");
    } finally {
      setLoading(false);
    }
  };

  const handleCloneSuccess = () => {
    setShowForm(false);
    loadVoices();
    toast.success("Voice cloned successfully!");
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this voice?")) return;

    try {
      await voiceAPI.delete(id);
      toast.success("Voice deleted successfully");
      loadVoices();
    } catch (error) {
      toast.error("Failed to delete voice");
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success("Voice ID copied to clipboard");
  };

 const playVoiceSample = async (voiceId, text = "Hello, this is a sample of my voice.") => {
  if (playingVoice === voiceId) {
    setPlayingVoice(null);
    return;
  }

  setPlayingVoice(voiceId);

  try {
    const res = await voiceAPI.play(voiceId, text);
    const audioBlob = new Blob([res.data], { type: 'audio/mpeg' });
    const audioUrl = URL.createObjectURL(audioBlob);

    const audio = new Audio(audioUrl);
    audio.play();

    audio.onended = () => setPlayingVoice(null);
  } catch (err) {
    console.error(err);
    toast.error('Failed to play voice sample');
    setPlayingVoice(null);
  }
};


  if (showForm) {
    return (
      <VoiceCloneForm
        onSuccess={handleCloneSuccess}
        onCancel={() => setShowForm(false)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Voice Cloning</h1>
          <p className="text-gray-600 mt-1">
            Clone voices and manage AI voices for campaigns
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 flex items-center space-x-2"
        >
          <Upload className="h-5 w-5" />
          <span>Clone New Voice</span>
        </button>
      </div>

      {/* Cloned Voices Section */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          Your Cloned Voices
        </h2>
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
          </div>
        ) : voices.cloned.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center"
          >
            <Volume2 className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No cloned voices yet
            </h3>
            <p className="text-gray-600 mb-6">
              Clone your first voice to use in campaigns
            </p>
            <button
              onClick={() => setShowForm(true)}
              className="bg-purple-600 text-white px-6 py-2 rounded-lg hover:bg-purple-700"
            >
              Clone Voice
            </button>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {voices.cloned.map((voice, index) => (
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
                    <p className="text-sm text-gray-500 mt-1">Cloned Voice</p>
                  </div>
                  <button
                    onClick={() => handleDelete(voice._id)}
                    className="p-2 text-gray-400 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-3 mb-6">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      Voice ID
                    </p>
                    <div className="flex items-center space-x-2">
                      <code className="text-sm bg-gray-100 px-2 py-1 rounded flex-1 truncate">
                        {voice.voiceId}
                      </code>
                      <button
                        onClick={() => copyToClipboard(voice.voiceId)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700">Created</p>
                    <p className="text-sm text-gray-500">
                      {new Date(voice.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex space-x-2">
                  <button
                    onClick={() => playVoiceSample(voice.voiceId)}
                    className="flex-1 bg-purple-50 text-purple-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-purple-100 flex items-center justify-center space-x-2"
                  >
                    <Play className="h-4 w-4" />
                    <span>
                      {playingVoice === voice.voiceId
                        ? "Playing..."
                        : "Play Sample"}
                    </span>
                  </button>
                  <button
                    onClick={() => copyToClipboard(voice.voiceId)}
                    className="flex-1 bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 flex items-center justify-center space-x-2"
                  >
                    <Copy className="h-4 w-4" />
                    <span>Copy ID</span>
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Prebuilt Voices Section */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          Prebuilt Voices
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {voices.prebuilt?.slice(0, 6).map((voice, index) => (
            <motion.div
              key={voice.voice_id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
            >
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {voice.name}
                </h3>
                <p className="text-sm text-gray-500 mt-1">Prebuilt Voice</p>
              </div>

              <div className="space-y-3 mb-6">
                <div>
                  <p className="text-sm font-medium text-gray-700">Voice ID</p>
                  <div className="flex items-center space-x-2">
                    <code className="text-sm bg-gray-100 px-2 py-1 rounded flex-1 truncate">
                      {voice.voice_id}
                    </code>
                    <button
                      onClick={() => copyToClipboard(voice.voice_id)}
                      className="p-1 text-gray-400 hover:text-gray-600"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-700">Category</p>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    {voice.category}
                  </span>
                </div>
              </div>

              <div className="flex space-x-2">
                <button
                  onClick={() => playVoiceSample(voice.voice_id)}
                  className="flex-1 bg-blue-50 text-blue-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-100 flex items-center justify-center space-x-2"
                >
                  <Play className="h-4 w-4" />
                  <span>
                    {playingVoice === voice.voice_id
                      ? "Playing..."
                      : "Play Sample"}
                  </span>
                </button>
                <button
                  onClick={() => copyToClipboard(voice.voice_id)}
                  className="flex-1 bg-gray-100 text-gray-700 px-3 py-2 rounded-lg text-sm font-medium hover:bg-gray-200 flex items-center justify-center space-x-2"
                >
                  <Copy className="h-4 w-4" />
                  <span>Copy ID</span>
                </button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VoiceCloning;
