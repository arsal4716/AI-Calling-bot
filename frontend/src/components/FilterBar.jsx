// src/pages/CallLogs/components/FilterBar.jsx
import React, { useState, useEffect } from 'react';
import { campaignAPI } from '../services/api';

const FilterBar = ({ onStatusChange, onCampaignChange, onDateRangeChange }) => {
  const [campaigns, setCampaigns] = useState([]);
  const [status, setStatus] = useState('');
  const [campaign, setCampaign] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    campaignAPI.getAll().then(res => setCampaigns(res.data));
  }, []);

  const handleStatus = (e) => {
    setStatus(e.target.value);
    onStatusChange(e.target.value);
  };

  const handleCampaign = (e) => {
    setCampaign(e.target.value);
    onCampaignChange(e.target.value);
  };

  const handleFromDate = (e) => {
    setFromDate(e.target.value);
    onDateRangeChange(e.target.value, toDate);
  };

  const handleToDate = (e) => {
    setToDate(e.target.value);
    onDateRangeChange(fromDate, e.target.value);
  };

  return (
    <div className="flex flex-wrap gap-4 mb-4">
      <select value={status} onChange={handleStatus} className="border rounded p-2">
        <option value="">All Statuses</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="busy">Busy</option>
        <option value="no-answer">No Answer</option>
        {/* add others */}
      </select>
      <select value={campaign} onChange={handleCampaign} className="border rounded p-2">
        <option value="">All Campaigns</option>
        {campaigns.map(c => (
          <option key={c._id} value={c._id}>{c.name}</option>
        ))}
      </select>
      <input
        type="date"
        value={fromDate}
        onChange={handleFromDate}
        className="border rounded p-2"
        placeholder="From"
      />
      <input
        type="date"
        value={toDate}
        onChange={handleToDate}
        className="border rounded p-2"
        placeholder="To"
      />
    </div>
  );
};

export default React.memo(FilterBar);