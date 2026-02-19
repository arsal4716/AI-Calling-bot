// src/hooks/useDialer.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { dialerAPI } from '../services/api';
import { socket } from '../socket';

export const useDialer = (jobId) => {
  const [job, setJob] = useState(null);
  const [liveNumbers, setLiveNumbers] = useState([]);
  const [stats, setStats] = useState({ processing: 0, completed: 0, failed: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!jobId) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const [statusRes, liveRes] = await Promise.all([
          dialerAPI.getStatus(jobId),
          dialerAPI.getLive(jobId)
        ]);
        setJob(statusRes.data);
        setStats(statusRes.data.stats);
        setLiveNumbers(liveRes.data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    // Join socket room
    socket.emit('join-job', jobId);

    // Listen for updates
    const handleUpdate = (data) => {
      if (data.type === 'processing') {
        setLiveNumbers(prev => [...prev, { phoneNumber: data.number, callSid: data.callSid }]);
      } else if (data.type === 'completed' || data.type === 'failed') {
        setLiveNumbers(prev => prev.filter(n => n.callSid !== data.callSid));
      }
    };

    const handleProgress = (newStats) => {
      setStats(newStats);
      setJob(prev => prev ? { ...prev, stats: newStats } : null);
    };

    socket.on('dialer:update', handleUpdate);
    socket.on('dialer:progress', handleProgress);

    return () => {
      socket.off('dialer:update', handleUpdate);
      socket.off('dialer:progress', handleProgress);
      socket.emit('leave-job', jobId);
    };
  }, [jobId]);

  const startJob = useCallback(async () => {
    try {
      const res = await dialerAPI.start(jobId);
      setJob(res.data);
    } catch (err) {
      setError(err.message);
    }
  }, [jobId]);

  const stopJob = useCallback(async () => {
    try {
      const res = await dialerAPI.stop(jobId);
      setJob(res.data);
    } catch (err) {
      setError(err.message);
    }
  }, [jobId]);

  return { job, liveNumbers, stats, loading, error, startJob, stopJob };
};