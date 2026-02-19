// src/hooks/useCallLogs.js
import { useState, useEffect, useCallback } from "react";
import { callLogsAPI } from "../services/api";

export const useCallLogs = (initialFilters = {}) => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState({ limit: 20, ...initialFilters });

  const fetchFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = { ...filters };
      delete params.cursor;

      const res = await callLogsAPI.get(params);

      setLogs(res.data.logs || []);
      setNextCursor(res.data.nextCursor || null);
      setHasMore(Boolean(res.data.hasMore));
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || loading || !nextCursor) return;

    setLoadingMore(true);
    setError(null);

    try {
      const params = { ...filters, cursor: nextCursor };
      const res = await callLogsAPI.get(params);
      const newLogs = res.data.logs || [];

      setLogs((prev) => [...prev, ...newLogs]);
      setNextCursor(res.data.nextCursor || null);
      setHasMore(Boolean(res.data.hasMore));
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, loading, nextCursor, filters]);

  useEffect(() => {
    setLogs([]);
    setNextCursor(null);
    setHasMore(false);
    fetchFirstPage();
  }, [fetchFirstPage]);

  const updateFilter = useCallback((key, value) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilters({ limit: 20 });
  }, []);

  return {
    logs,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    filters,
    updateFilter,
    resetFilters,
  };
};
