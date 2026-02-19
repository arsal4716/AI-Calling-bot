import React from 'react';

const RecordingModal = ({ url, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-4 rounded max-w-2xl w-full">
        <div className="flex justify-between mb-2">
          <h3 className="font-semibold">Call Recording</h3>
          <button onClick={onClose} className="text-gray-600">&times;</button>
        </div>
        <audio controls src={url} className="w-full" autoPlay />
      </div>
    </div>
  );
};

export default React.memo(RecordingModal);