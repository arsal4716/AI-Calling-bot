import React, { useEffect, useMemo, useState } from 'react';
import {
  Phone,
  Clock,
  TrendingUp,
  Activity,
  BarChart3,
  Calendar
} from 'lucide-react';
import { useAuth } from '../store/authContext';
import { dashboardAPI } from '../services/api';
import { motion } from 'framer-motion';

const formatDuration = (seconds = 0) => {
  const s = Math.max(0, Number(seconds) || 0);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
};

const formatTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};

const Dashboard = () => {
  const { user } = useAuth();

  const [campaigns, setCampaigns] = useState([]);
  const [campaignPerformance, setCampaignPerformance] = useState([]);
  const [recentCalls, setRecentCalls] = useState([]);

  const [stats, setStats] = useState({
    totalCalls: 0,
    activeCampaigns: 0,
    avgDurationSeconds: 0,
    successRate: 0,
  });

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const loadSummary = async () => {
      try {
        setLoading(true);
        const res = await dashboardAPI.getSummary();

        if (!mounted) return;

        setStats(res.data.stats || {});
        setRecentCalls(
          (res.data.recentCalls || []).map((c) => ({
            id: c._id,
            number: c.fromNumber || c.toNumber || 'Unknown',
            duration: formatDuration(c.duration),
            status: c.status || 'unknown',
            time: formatTime(c.startTime),
          }))
        );

        setCampaignPerformance(res.data.campaignPerformance || []);
        setCampaigns(res.data.campaigns || []);
      } catch (error) {
        console.error('Failed to load dashboard summary:', error);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadSummary();
    return () => {
      mounted = false;
    };
  }, []);

  const statCards = useMemo(() => ([
    {
      icon: <Phone className="h-6 w-6" />,
      label: 'Total Calls',
      value: loading ? '—' : stats.totalCalls,
      color: 'bg-blue-500'
    },
    {
      icon: <Activity className="h-6 w-6" />,
      label: 'Active Campaigns',
      value: loading ? '—' : stats.activeCampaigns,
      color: 'bg-green-500'
    },
    {
      icon: <Clock className="h-6 w-6" />,
      label: 'Avg Duration',
      value: loading ? '—' : formatDuration(stats.avgDurationSeconds),
      color: 'bg-purple-500'
    },
    {
      icon: <TrendingUp className="h-6 w-6" />,
      label: 'Success Rate',
      value: loading ? '—' : `${stats.successRate}%`,
      color: 'bg-orange-500'
    },
  ]), [loading, stats]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-gray-600 mt-1">Welcome back, {user?.name}!</p>
        </div>
        <div className="flex items-center space-x-2 text-sm text-gray-500">
          <Calendar className="h-4 w-4" />
          <span>
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            })}
          </span>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.1 }}
            className="bg-white rounded-xl shadow-sm border border-gray-200 p-6"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">{stat.label}</p>
                <p className="text-2xl font-bold text-gray-900 mt-2">{stat.value}</p>
              </div>
              <div className={`${stat.color} p-3 rounded-lg`}>
                {React.cloneElement(stat.icon, { className: 'h-6 w-6 text-white' })}
              </div>
            </div>
            <div className="mt-4">
              <div className="flex items-center text-sm text-gray-500">
                <TrendingUp className="h-4 w-4 text-green-500 mr-1" />
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Calls */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-gray-900">Recent Calls</h2>
            <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
              View All
            </button>
          </div>

          <div className="space-y-4">
            {!loading && recentCalls.length === 0 && (
              <div className="text-sm text-gray-500">No calls found.</div>
            )}

            {recentCalls.map((call) => (
              <div
                key={call.id}
                className="flex items-center justify-between p-3 hover:bg-gray-50 rounded-lg"
              >
                <div className="flex items-center space-x-3">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      call.status === 'completed' ? 'bg-green-500' : 'bg-red-500'
                    }`}
                  ></div>
                  <div>
                    <p className="font-medium text-gray-900">{call.number}</p>
                    <p className="text-sm text-gray-500">{call.time}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-medium text-gray-900">{call.duration}</p>
                  <p
                    className={`text-sm ${
                      call.status === 'completed' ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {call.status}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Campaign Performance */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-gray-900">Campaign Performance</h2>
            <BarChart3 className="h-5 w-5 text-gray-400" />
          </div>

          <div className="space-y-4">
            {!loading && campaignPerformance.length === 0 && (
              <div className="text-sm text-gray-500">No performance data.</div>
            )}

            {campaignPerformance.map((c) => (
              <div key={c._id} className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-gray-700">{c.name}</span>
                  <span className="text-gray-500">{c.successRate}% success</span>
                </div>

                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, c.successRate || 0))}%` }}
                  ></div>
                </div>

                <div className="flex justify-between text-xs text-gray-500">
                  <span>{c.twilioDid}</span>
                  <span>{c.totalCalls} calls</span>
                </div>
              </div>
            ))}
          </div>

          <div className="hidden">{campaigns.length}</div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
