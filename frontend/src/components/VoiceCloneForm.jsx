import React, { useState } from "react";
import { Upload, X, Volume2, AlertCircle } from "lucide-react";
import { motion } from "framer-motion";
import { voiceAPI } from "../services/api";
import toast from "react-hot-toast";

const VoiceCloneForm = ({ onSuccess, onCancel }) => {
  const [name, setName] = useState("");
  const [audioFile, setAudioFile] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!name.trim() || !audioFile) {
      toast.error("Please provide a voice name and audio file");
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append("name", name);
      formData.append("audio", audioFile);

      // Simulate upload progress
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return prev;
          }
          return prev + 10;
        });
      }, 300);

      const response = await voiceAPI.clone(formData);

      clearInterval(progressInterval);
      setUploadProgress(100);

      setTimeout(() => {
        onSuccess(response.data);
        toast.success("Voice cloned successfully!");
      }, 500);
    } catch (error) {
      console.error("Voice cloning error:", error);
      toast.error(error.response?.data?.message || "Voice cloning failed");
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    const allowedTypes = ["audio/mpeg", "audio/wav", "audio/m4a", "audio/ogg"];
    if (!allowedTypes.includes(file.type)) {
      toast.error("Please upload a valid audio file (MP3, WAV, M4A, OGG)");
      return;
    }

    // Validate file size (50MB max)
    if (file.size > 50 * 1024 * 1024) {
      toast.error("File size must be less than 50MB");
      return;
    }

    setAudioFile(file);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-2xl mx-auto"
    >
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="p-6 border-b border-gray-200">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">
                Clone a Voice
              </h2>
              <p className="text-gray-600 mt-1">
                Upload an audio sample to create a custom AI voice
              </p>
            </div>
            <button
              onClick={onCancel}
              className="p-2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Voice Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Voice Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              placeholder="e.g., John's Voice"
              disabled={isUploading}
            />
          </div>

          {/* Audio Upload */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Audio Sample *
            </label>

            <div className="mt-1">
              {audioFile ? (
                <div className="border border-gray-300 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <Volume2 className="h-8 w-8 text-purple-500" />
                      <div>
                        <p className="font-medium text-gray-900">
                          {audioFile.name}
                        </p>
                        <p className="text-sm text-gray-500">
                          {(audioFile.size / (1024 * 1024)).toFixed(2)} MB
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAudioFile(null)}
                      className="text-gray-400 hover:text-gray-600"
                      disabled={isUploading}
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex justify-center px-6 pt-5 pb-6 border-2 border-gray-300 border-dashed rounded-lg">
                  <div className="space-y-1 text-center">
                    <Upload className="mx-auto h-12 w-12 text-gray-400" />
                    <div className="flex text-sm text-gray-600">
                      <label className="relative cursor-pointer bg-white rounded-md font-medium text-purple-600 hover:text-purple-500">
                        <span>Upload audio file</span>
                        <input
                          type="file"
                          className="sr-only"
                          accept="audio/*"
                          onChange={handleFileChange}
                          disabled={isUploading}
                        />
                      </label>
                      <p className="pl-1">or drag and drop</p>
                    </div>
                    <p className="text-xs text-gray-500">
                      MP3, WAV, M4A, or OGG up to 50MB
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Upload Progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium text-gray-700">
                  Cloning voice...
                </span>
                <span className="text-gray-500">{uploadProgress}%</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
            </div>
          )}

          {/* Tips */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex">
              <AlertCircle className="h-5 w-5 text-blue-400 mr-3 flex-shrink-0" />
              <div className="text-sm text-blue-800">
                <p className="font-medium">Tips for best results:</p>
                <ul className="mt-2 space-y-1">
                  <li>• Use 1-3 minutes of clear audio</li>
                  <li>• Record in a quiet environment</li>
                  <li>• Speak naturally and clearly</li>
                  <li>• Avoid background music or noise</li>
                </ul>
              </div>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              disabled={isUploading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isUploading || !name.trim() || !audioFile}
            >
              {isUploading ? "Cloning..." : "Clone Voice"}
            </button>
          </div>
        </form>
      </div>
    </motion.div>
  );
};

export default VoiceCloneForm;
