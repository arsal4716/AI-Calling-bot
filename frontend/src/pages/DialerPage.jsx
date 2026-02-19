// src/pages/Dialer/DialerPage.jsx
import React, { useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { dialerAPI } from '../services/api';
import { useDialer } from '../hooks/useDialer';
import UploadForm from '../components/UploadForm';
import Progress from '../components/Progress';
import LiveList from '../components/LiveList';

const DialerPage = () => {
  const [jobId, setJobId] = useState(null);
  const { register, handleSubmit, formState: { errors } } = useForm();
  const { job, liveNumbers, stats, startJob, stopJob } = useDialer(jobId);

  const onSubmit = async (data) => {
    const formData = new FormData();
    formData.append('file', data.file[0]);
    formData.append('campaignId', data.campaign);
    formData.append('maxConcurrency', data.concurrency);
    try {
      const res = await dialerAPI.upload(formData);
      setJobId(res.data.jobId);
    } catch (error) {
      console.error('Upload failed', error);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Campaign Dialer</h1>
      <UploadForm
        onSubmit={handleSubmit(onSubmit)}
        register={register}
        errors={errors}
      />
      {jobId && (
        <div className="mt-8">
          <div className="flex space-x-4 mb-4">
            {job?.status === 'pending' && (
              <button
                onClick={startJob}
                className="bg-green-600 text-white px-4 py-2 rounded"
              >
                Start Job
              </button>
            )}
            {job?.status === 'running' && (
              <button
                onClick={stopJob}
                className="bg-red-600 text-white px-4 py-2 rounded"
              >
                Stop Job
              </button>
            )}
          </div>
          <Progress stats={stats} total={job?.totalNumbers} />
          <LiveList numbers={liveNumbers} />
        </div>
      )}
    </div>
  );
};

export default DialerPage;