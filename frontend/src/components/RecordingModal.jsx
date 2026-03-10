import React, { useState, useCallback } from "react";

const RecordingModal = ({ url, onClose }) => {
  const [hasError, setHasError] = useState(false);

  const handleOverlayClick = useCallback(
    (e) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={handleOverlayClick}
    >
      <div className="w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-lg font-semibold text-gray-800">
            Call Recording
          </h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-2xl leading-none"
            aria-label="Close recording modal"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4">
          {url ? (
            <>
              <audio
                controls
                autoPlay
                className="w-full"
                src={url}
                onError={() => setHasError(true)}
              >
                Your browser does not support the audio element.
              </audio>

              {hasError && (
                <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  Unable to load this recording in the audio player.
                </div>
              )}

              <div className="text-sm text-gray-600">
                Recording source:
              </div>

              <div className="break-all rounded-md bg-gray-50 border p-3 text-xs text-gray-700">
                {url}
              </div>

              <div className="flex justify-end">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-700 hover:text-indigo-900 underline text-sm"
                >
                  Open recording in new tab
                </a>
              </div>
            </>
          ) : (
            <div className="text-sm text-gray-500">Recording not available.</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default React.memo(RecordingModal);