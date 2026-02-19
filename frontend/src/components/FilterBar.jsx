// src/pages/CallLogs/components/FilterBar.jsx
import React, { useState, useEffect } from "react";
import { campaignAPI } from "../services/api";

const FilterBar = ({ onStatusChange, onCampaignChange, onDateRangeChange }) => {
  const [campaigns, setCampaigns] = useState([]);
  const [status, setStatus] = useState("");
  const [campaign, setCampaign] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    campaignAPI
      .getAll()
      .then((res) => setCampaigns(Array.isArray(res.data) ? res.data : []))
      .catch(() => setCampaigns([]));
  }, []);

  const handleStatus = (e) => {
    const v = e.target.value;
    setStatus(v);
    onStatusChange(v);
  };

  const handleCampaign = (e) => {
    const v = e.target.value;
    setCampaign(v);
    onCampaignChange(v);
  };

  const handleFromDate = (e) => {
    const v = e.target.value;
    setFromDate(v);
    onDateRangeChange(v, toDate);
  };

  const handleToDate = (e) => {
    const v = e.target.value;
    setToDate(v);
    onDateRangeChange(fromDate, v);
  };

  return (
    <div className="flex flex-wrap gap-4 mb-4">
      <select
        value={status}
        onChange={handleStatus}
        className="border rounded p-2"
      >
        <option value="">All Statuses</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
        <option value="busy">Busy</option>
        <option value="no_answer">No Answer</option>
        <option value="in_progress">In Progress</option>
        <option value="queued">Queued</option>
        <option value="ringing">Ringing</option>
        <option value="initiated">Initiated</option>
        <option value="connecting">Connecting</option>
        <option value="canceled">Canceled</option>
        <option value="queue_failed">Queue Failed</option>
      </select>

      <select
        value={campaign}
        onChange={handleCampaign}
        className="border rounded p-2"
      >
        <option value="">All Campaigns</option>
        {campaigns.map((c) => (
          <option key={c._id} value={c._id}>
            {c.name}
          </option>
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
