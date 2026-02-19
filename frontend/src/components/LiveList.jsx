// src/pages/Dialer/components/LiveList.jsx
import React from 'react';

const LiveList = ({ numbers }) => {
  return (
    <div className="bg-white p-4 rounded shadow">
      <h3 className="font-semibold mb-2">Currently Processing ({numbers.length})</h3>
      <ul className="max-h-60 overflow-y-auto">
        {numbers.map((n, idx) => (
          <li key={n.callSid || idx} className="py-1 border-b">
            {n.phoneNumber} {n.callSid && `(SID: ${n.callSid})`}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default React.memo(LiveList);