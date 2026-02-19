import React, { useMemo, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import RecordingModal from "./RecordingModal";

const ROW_HEIGHT = 40;

const LogsTable = ({ logs = [], loading, hasMore, onLoadMore }) => {
  const [selectedRecording, setSelectedRecording] = useState(null);
  const safeLogs = Array.isArray(logs) ? logs : [];

  const parentRef = useRef(null);

  const handleRowClick = useCallback((recordingUrl) => {
    if (recordingUrl) setSelectedRecording(recordingUrl);
  }, []);

  const closeModal = useCallback(() => setSelectedRecording(null), []);

  const rowVirtualizer = useVirtualizer({
    count: safeLogs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Infinite load when near end
  React.useEffect(() => {
    const items = rowVirtualizer.getVirtualItems();
    if (!items.length) return;

    const lastItem = items[items.length - 1];

    if (hasMore && !loading && lastItem.index >= safeLogs.length - 1) {
      onLoadMore?.();
    }
  }, [rowVirtualizer, hasMore, loading, safeLogs.length, onLoadMore]);

  if (safeLogs.length === 0 && !loading) {
    return <div className="p-6 text-gray-500">No Calls to display</div>;
  }

  return (
    <div className="bg-white rounded shadow overflow-hidden">
      <div className="flex items-center border-b hover:bg-indigo-50 text-[12px] text-gray-700">
        <div className="w-1/6 px-2">Call SID</div>
        <div className="w-1/6 px-2">Phone</div>
        <div className="w-1/6 px-2">Campaign</div>
        <div className="w-1/12 px-2">Duration</div>
        <div className="w-1/12 px-2">Status</div>
        <div className="w-1/6 px-2">Recording</div>
        <div className="w-1/6 px-2">Date</div>
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
                key={log.callSid || virtualRow.key}
                className="flex items-center border-b hover:bg-gray-50"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div className="w-1/6 px-2 truncate">{log.callSid}</div>
                <div className="w-1/6 px-2 truncate">{log.toNumber}</div>
                <div className="w-1/6 px-2 truncate">
                  {log.campaign?.name || ""}
                </div>
                <div className="w-1/12 px-2">{log.duration}s</div>
                <div className="w-1/12 px-2">
                  <span
                    className="
px-2 py-[2px] rounded-full text-[11px] font-medium
bg-green-100 text-green-700
"
                  >
                    {log.status}
                  </span>
                </div>
                <div className="w-1/6 px-2 truncate">
                  {log.recordingUrl ? (
                    <button
                      onClick={() => handleRowClick(log.recordingUrl)}
                      className="text-blue-600 underline"
                    >
                      Play
                    </button>
                  ) : (
                    "No recording"
                  )}
                </div>
                <div className="w-1/6 px-2 truncate">
                  {new Date(log.startTime).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {loading && <div className="p-2 text-center">Loading more…</div>}

      {selectedRecording && (
        <RecordingModal url={selectedRecording} onClose={closeModal} />
      )}
    </div>
  );
};

export default React.memo(LogsTable);
