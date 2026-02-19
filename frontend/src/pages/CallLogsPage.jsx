// src/pages/CallLogs/CallLogsPage.jsx
import React, { useCallback } from "react";
import { useCallLogs } from "../hooks/useCallLogs";
import FilterBar from "../components/FilterBar";
import SearchBar from "../components/SearchBar";
import LogsTable from "../components/LogsTable";

const CallLogsPage = () => {
  const {
    logs,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    updateFilter,
  } = useCallLogs({ limit: 20 });

  const handleSearch = useCallback(
    (value) => updateFilter("search", value),
    [updateFilter]
  );

  const handleStatusChange = useCallback(
    (value) => updateFilter("status", value),
    [updateFilter]
  );

  const handleCampaignChange = useCallback(
    (value) => updateFilter("campaign", value),
    [updateFilter]
  );

  const handleDateRangeChange = useCallback(
    (from, to) => {
      updateFilter("from", from);
      updateFilter("to", to);
    },
    [updateFilter]
  );

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Call Logs</h1>

      <SearchBar onSearch={handleSearch} />

      <FilterBar
        onStatusChange={handleStatusChange}
        onCampaignChange={handleCampaignChange}
        onDateRangeChange={handleDateRangeChange}
      />

      {error && <div className="text-red-600 mt-4">{error}</div>}

      <LogsTable
        logs={logs}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />
    </div>
  );
};

export default CallLogsPage;
