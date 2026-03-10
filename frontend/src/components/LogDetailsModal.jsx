import React, { useCallback } from "react";

const FieldRow = ({ label, value }) => {
  const displayValue =
    value === null || value === undefined || value === ""
      ? "-"
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : String(value);

  return (
    <div className="grid grid-cols-12 gap-3 py-2 border-b border-gray-100">
      <div className="col-span-4 md:col-span-3 font-medium text-gray-700">
        {label}
      </div>
      <div className="col-span-8 md:col-span-9 text-gray-900 break-all">
        {displayValue}
      </div>
    </div>
  );
};

const JsonBlock = ({ title, data }) => {
  return (
    <div className="mt-4">
      <div className="font-semibold text-gray-800 mb-2">{title}</div>
      <pre className="bg-gray-50 border rounded-lg p-3 text-xs text-gray-800 overflow-auto whitespace-pre-wrap break-words">
        {JSON.stringify(data ?? {}, null, 2)}
      </pre>
    </div>
  );
};

const LogDetailsModal = ({ log, onClose }) => {
  const handleOverlayClick = useCallback(
    (e) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  if (!log) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={handleOverlayClick}
    >
      <div className="w-full max-w-5xl bg-white rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">
              Call Log Details
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {log.callSid || "No Call SID"}
            </p>
          </div>

          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-800 text-2xl leading-none"
            aria-label="Close details modal"
          >
            &times;
          </button>
        </div>

        <div className="max-h-[80vh] overflow-y-auto p-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-lg border p-4">
              <div className="font-semibold text-gray-800 mb-3">
                Basic Information
              </div>

              <FieldRow label="ID" value={log._id} />
              <FieldRow label="Call SID" value={log.callSid} />
              <FieldRow
                label="Campaign"
                value={log.campaign?.name || log.campaign}
              />
              <FieldRow label="From Number" value={log.fromNumber} />
              <FieldRow label="To Number" value={log.toNumber} />
              <FieldRow label="Status" value={log.status} />
              <FieldRow
                label="Duration"
                value={log.duration ? `${log.duration}s` : "0s"}
              />
              <FieldRow label="Disposition" value={log.disposition} />
              <FieldRow label="Stage" value={log.dispositionDetail?.stage} />
              <FieldRow label="Result" value={log.result} />
              <FieldRow label="TwiML Served" value={log.twimlServed} />
            </div>

            <div className="rounded-lg border p-4">
              <div className="font-semibold text-gray-800 mb-3">
                Timeline & Recording
              </div>

              <FieldRow label="Start Time" value={log.startTime} />
              <FieldRow label="End Time" value={log.endTime} />
              <FieldRow label="Created At" value={log.createdAt} />
              <FieldRow label="Recording URL" value={log.recordingUrl} />
              <FieldRow
                label="Recording Proxy URL"
                value={log.recordingProxyUrl}
              />

              <div className="pt-4">
                {log.recordingProxyUrl ? (
                  <a
                    href={log.recordingProxyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    Open Recording
                  </a>
                ) : (
                  <div className="text-sm text-gray-500">
                    No recording available
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-lg border p-4">
            <div className="font-semibold text-gray-800 mb-3">
              Qualification / Outcome
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <FieldRow
                  label="Detail Status"
                  value={log.dispositionDetail?.status}
                />
                <FieldRow
                  label="Qualified"
                  value={log.dispositionDetail?.qualified}
                />
                <FieldRow
                  label="Interest Confirmed"
                  value={log.dispositionDetail?.interestConfirmed}
                />
                <FieldRow
                  label="Govt Coverage Checked"
                  value={log.dispositionDetail?.govtCoverageChecked}
                />
              </div>

              <div>
                <FieldRow
                  label="Ended By"
                  value={log.dispositionDetail?.endedBy}
                />
                <FieldRow
                  label="Duration Ms"
                  value={log.dispositionDetail?.durationMs}
                />
                <FieldRow
                  label="Transcript Summary"
                  value={log.dispositionDetail?.transcriptSummary}
                />
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-lg border p-4">
            <div className="font-semibold text-gray-800 mb-3">AI Responses</div>

            {Array.isArray(log.aiResponses) && log.aiResponses.length > 0 ? (
              <div className="space-y-3">
                {log.aiResponses.map((response, index) => (
                  <div
                    key={index}
                    className="rounded-md bg-gray-50 border p-3 text-sm text-gray-800"
                  >
                    <div className="text-xs font-semibold text-gray-500 mb-1">
                      Response #{index + 1}
                    </div>
                    <div>{response}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-500">
                No AI responses found.
              </div>
            )}
          </div>

          <JsonBlock title="Stream Data" data={log.stream} />
          <JsonBlock title="Disposition Detail" data={log.dispositionDetail} />
        </div>
      </div>
    </div>
  );
};

export default React.memo(LogDetailsModal);
