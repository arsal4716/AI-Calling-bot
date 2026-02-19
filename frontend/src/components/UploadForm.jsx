// src/pages/Dialer/components/UploadForm.jsx
import React, { useEffect, useState } from 'react';
import { campaignAPI } from '../services/api';

const UploadForm = ({ onSubmit, register, errors }) => {
  const [campaigns, setCampaigns] = useState([]);

  useEffect(() => {
    campaignAPI.getAll().then(res => setCampaigns(res.data));
  }, []);

  return (
    <form onSubmit={onSubmit} className="space-y-4 bg-white p-6 rounded shadow">
      <div>
        <label className="block mb-1">CSV File</label>
        <input
          type="file"
          accept=".csv"
          {...register('file', { required: 'File is required' })}
          className="w-full border rounded p-2"
        />
        {errors.file && <p className="text-red-600">{errors.file.message}</p>}
      </div>
      <div>
        <label className="block mb-1">Campaign</label>
        <select
          {...register('campaign', { required: 'Campaign is required' })}
          className="w-full border rounded p-2"
        >
          <option value="">Select campaign</option>
          {campaigns.map(c => (
            <option key={c._id} value={c._id}>{c.name}</option>
          ))}
        </select>
        {errors.campaign && <p className="text-red-600">{errors.campaign.message}</p>}
      </div>
      <div>
        <label className="block mb-1">Max Concurrency (1-20)</label>
        <input
          type="number"
          min="1"
          max="20"
          defaultValue="20"
          {...register('concurrency', { min: 1, max: 20 })}
          className="w-full border rounded p-2"
        />
      </div>
      <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">
        Upload and Start
      </button>
    </form>
  );
};

export default React.memo(UploadForm);