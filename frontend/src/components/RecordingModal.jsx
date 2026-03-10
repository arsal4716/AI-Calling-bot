import React, { useState } from "react";

const RecordingModal = ({ url, onClose }) => {
  const [error, setError] = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white p-4 rounded max-w-2xl w-full shadow-lg">
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-semibold">Call Recording</h3>
          <button onClick={onClose} className="text-gray-600 text-2xl leading-none">
            &times;
          </button>
        </div>

        <audio
          controls
          src={url}
          className="w-full"
          autoPlay
          onError={() => setError("Audio failed to load")}
        />

        {error && (
          <div className="mt-3 text-sm text-red-600">{error}</div>
        )}

        <div className="mt-3 text-xs break-all text-gray-500">{url}</div>
      </div>
    </div>
  );
};

export default React.memo(RecordingModal);