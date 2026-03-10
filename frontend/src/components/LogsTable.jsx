import React, { useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import RecordingModal from "./RecordingModal";
import LogDetailsModal from "./LogDetailsModal";

const ROW_HEIGHT = 52;

const normalizeStatus = (status) => String(status || "").toLowerCase();

const statusPillClass = (status) => {
  switch (normalizeStatus(status)) {
    case "completed":
      return "bg-emerald-100 text-emerald-700";
    case "failed":
      return "bg-rose-100 text-rose-700";
    case "busy":
      return "bg-amber-100 text-amber-700";
    case "no_answer":
      return "bg-slate-100 text-slate-700";
    case "in_progress":
    case "connecting":
    case "ringing":
    case "queued":
      return "bg-indigo-100 text-indigo-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
};

const LogsTable = ({
  logs = [],
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
}) => {
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  const safeLogs = Array.isArray(logs) ? logs : [];
  const parentRef = useRef(null);

  const handlePlay = useCallback((recordingUrl) => {
    if (recordingUrl) setSelectedRecording(recordingUrl);
  }, []);

  const handleDetails = useCallback((log) => {
    setSelectedLog(log);
  }, []);

  const closeRecordingModal = useCallback(() => setSelectedRecording(null), []);
  const closeDetailsModal = useCallback(() => setSelectedLog(null), []);

  const rowVirtualizer = useVirtualizer({
    count: safeLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  if (safeLogs.length === 0 && !loading) {
    return <div className="p-6 text-gray-500">No Calls to display</div>;
  }

  return (
    <div className="bg-white rounded shadow overflow-hidden">
      <div className="min-w-[1600px]">
        <div className="flex font-semibold bg-indigo-50 text-[12px] text-gray-800 border-b">
          <div className="w-[220px] px-2 py-2">Call SID</div>
          <div className="w-[140px] px-2 py-2">To</div>
          <div className="w-[140px] px-2 py-2">From</div>
          <div className="w-[160px] px-2 py-2">Campaign</div>
          <div className="w-[80px] px-2 py-2">Dur</div>
          <div className="w-[120px] px-2 py-2">Status</div>
          <div className="w-[130px] px-2 py-2">Disposition</div>
          <div className="w-[120px] px-2 py-2">Stage</div>
          <div className="w-[120px] px-2 py-2">Recording</div>
          <div className="w-[160px] px-2 py-2">Date</div>
          <div className="w-[100px] px-2 py-2">Details</div>
        </div>

        <div ref={parentRef} style={{ height: 600, overflow: "auto" }}>
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const log = safeLogs[virtualRow.index];
              if (!log) return null;

              return (
                <div
                  key={log._id || log.callSid || virtualRow.key}
                  className="flex items-center border-b hover:bg-indigo-50 text-[12px] text-gray-700"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div className="w-[220px] px-2 truncate">{log.callSid || "-"}</div>
                  <div className="w-[140px] px-2 truncate">{log.toNumber || "-"}</div>
                  <div className="w-[140px] px-2 truncate">{log.fromNumber || "-"}</div>
                  <div className="w-[160px] px-2 truncate">
                    {log.campaign?.name || "-"}
                  </div>
                  <div className="w-[80px] px-2">{log.duration ?? 0}s</div>
                  <div className="w-[120px] px-2">
                    <span
                      className={`px-2 py-[2px] rounded-full text-[11px] font-medium ${statusPillClass(
                        log.status
                      )}`}
                    >
                      {log.status || "-"}
                    </span>
                  </div>
                  <div className="w-[130px] px-2 truncate">
                    {log.disposition || log.dispositionDetail?.status || "-"}
                  </div>
                  <div className="w-[120px] px-2 truncate">
                    {log.dispositionDetail?.stage || "-"}
                  </div>
                  <div className="w-[120px] px-2 truncate">
                    {log.recordingProxyUrl ? (
                      <button
                        onClick={() => handlePlay(log.recordingProxyUrl)}
                        className="text-indigo-700 underline"
                      >
                        Play
                      </button>
                    ) : (
                      "No recording"
                    )}
                  </div>
                  <div className="w-[160px] px-2 truncate">
                    {log.startTime
                      ? new Date(log.startTime).toLocaleString()
                      : "-"}
                  </div>
                  <div className="w-[100px] px-2">
                    <button
                      onClick={() => handleDetails(log)}
                      className="text-indigo-700 underline"
                    >
                      View
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {loading && <div className="p-2 text-center text-sm">Loading…</div>}

      <div className="p-3 flex items-center justify-between border-t bg-white">
        <div className="text-xs text-gray-500">
          Showing <span className="font-semibold">{safeLogs.length}</span> records
        </div>

        <button
          disabled={!hasMore || loading || loadingMore}
          onClick={onLoadMore}
          className="px-4 py-2 rounded bg-indigo-600 text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingMore ? "Loading..." : hasMore ? "Load More (20)" : "No More"}
        </button>
      </div>

      {selectedRecording && (
        <RecordingModal url={selectedRecording} onClose={closeRecordingModal} />
      )}

      {selectedLog && (
        <LogDetailsModal log={selectedLog} onClose={closeDetailsModal} />
      )}
    </div>
  );
};

export default React.memo(LogsTable);