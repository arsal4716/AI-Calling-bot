import React from "react";

const Row = ({ label, value }) => (
  <div className="grid grid-cols-3 gap-3 py-2 border-b">
    <div className="font-medium text-gray-700">{label}</div>
    <div className="col-span-2 text-gray-900 break-all">
      {value === null || value === undefined || value === ""
        ? "-"
        : typeof value === "object"
        ? JSON.stringify(value, null, 2)
        : String(value)}
    </div>
  </div>
);

const LogDetailsModal = ({ log, onClose }) => {
  if (!log) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h3 className="font-semibold text-lg">Call Log Details</h3>
          <button onClick={onClose} className="text-gray-600 text-2xl leading-none">
            &times;
          </button>
        </div>

        <div className="p-4 overflow-y-auto max-h-[75vh] text-sm">
          <Row label="ID" value={log._id} />
          <Row label="Call SID" value={log.callSid} />
          <Row label="Campaign" value={log.campaign?.name || log.campaign} />
          <Row label="From Number" value={log.fromNumber} />
          <Row label="To Number" value={log.toNumber} />
          <Row label="Status" value={log.status} />
          <Row label="Duration" value={log.duration} />
          <Row label="TwiML Served" value={String(log.twimlServed)} />
          <Row label="Result" value={log.result} />
          <Row label="Disposition" value={log.disposition} />
          <Row label="Start Time" value={log.startTime} />
          <Row label="End Time" value={log.endTime} />
          <Row label="Created At" value={log.createdAt} />
          <Row label="Recording URL" value={log.recordingUrl} />
          <Row label="Recording Proxy URL" value={log.recordingProxyUrl} />
          <Row label="AI Responses" value={log.aiResponses} />
          <Row label="Stream" value={log.stream} />
          <Row label="Disposition Detail" value={log.dispositionDetail} />
        </div>
      </div>
    </div>
  );
};

export default React.memo(LogDetailsModal);