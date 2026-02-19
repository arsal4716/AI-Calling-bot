// src/hooks/useCallLogs.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { callLogsAPI } from '../services/api';
import debounce from 'lodash/debounce';

export const useCallLogs = (initialFilters = {}) => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState(initialFilters);

const fetchLogs = useCallback(async (cursor = null) => {
  setLoading(true);
  try {
    const params = { ...filters };
    if (cursor) params.cursor = cursor;
    const res = await callLogsAPI.get(params);
    const newLogs = res.data.logs || []; 
    setNextCursor(res.data.nextCursor);
    setHasMore(res.data.hasMore);
    if (cursor) {
      setLogs(prev => [...prev, ...newLogs]);
    } else {
      setLogs(newLogs);
    }
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
}, [filters]);
  const debouncedFetch = useRef(debounce(fetchLogs, 300)).current;

  useEffect(() => {
    debouncedFetch(null);
    return () => debouncedFetch.cancel();
  }, [filters, debouncedFetch]);

  const loadMore = useCallback(() => {
    if (hasMore && !loading) {
      fetchLogs(nextCursor);
    }
  }, [hasMore, loading, nextCursor, fetchLogs]);

  const updateFilter = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  return {
    logs,
    loading,
    error,
    hasMore,
    loadMore,
    filters,
    updateFilter
  };
};