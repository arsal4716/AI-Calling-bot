// src/pages/Dialer/components/Progress.jsx
import React from 'react';

const Progress = ({ stats, total }) => {
  const { processing, completed, failed } = stats;
  const totalProcessed = completed + failed;
  const percent = total ? (totalProcessed / total) * 100 : 0;

  return (
    <div className="bg-white p-4 rounded shadow mb-4">
      <div className="grid grid-cols-4 gap-4 mb-2">
        <div>Total: {total}</div>
        <div>Processing: {processing}</div>
        <div>Completed: {completed}</div>
        <div>Failed: {failed}</div>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className="bg-blue-600 h-2.5 rounded-full"
          style={{ width: `${percent}%` }}
        ></div>
      </div>
    </div>
  );
};

export default React.memo(Progress);