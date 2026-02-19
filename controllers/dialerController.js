// controllers/dialerController.js
const multer = require('multer');
const csv = require('csv-parser');
const stream = require('stream');
const util = require('util');
const pipeline = util.promisify(stream.pipeline);
const DialerJob = require('../models/DialerJob');
const DialerNumber = require('../models/DialerNumber');
const { getDialerQueueService } = require('../services/dialerQueueSingleton');
const { getIo } = require('../socketManager');

const upload = multer({ storage: multer.memoryStorage() });

exports.uploadCSV = [
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { campaignId, maxConcurrency } = req.body;
      if (!campaignId) return res.status(400).json({ error: 'campaignId required' });
      const concurrency = Math.min(parseInt(maxConcurrency) || 20, 20);

      // Parse CSV from buffer
      const results = [];
      const readable = stream.Readable.from(req.file.buffer.toString());
      await pipeline(
        readable,
        csv({ headers: false }),
        async function* (source) {
          for await (const row of source) {
            // Assuming first column is phone number
            const phone = Object.values(row)[0]?.trim();
            if (phone) results.push(phone);
          }
        }
      );

      if (results.length === 0) {
        return res.status(400).json({ error: 'No valid phone numbers found' });
      }

      // Create job
      const job = await DialerJob.create({
        campaign: campaignId,
        fileName: req.file.originalname,
        totalNumbers: results.length,
        maxConcurrency: concurrency,
        status: 'pending',
        stats: { processing: 0, completed: 0, failed: 0 }
      });

      // Bulk insert numbers
      const numbers = results.map(phone => ({
        job: job._id,
        phoneNumber: phone,
        status: 'pending'
      }));
      await DialerNumber.insertMany(numbers, { ordered: false }); // continue on error

      res.json({ jobId: job._id, total: results.length });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
];

exports.startJob = async (req, res) => {
  try {
    const { id } = req.params;
    const queueService = getDialerQueueService();
    const job = await queueService.startJob(id);
    res.json(job);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.stopJob = async (req, res) => {
  try {
    const { id } = req.params;
    const queueService = getDialerQueueService();
    const job = await queueService.stopJob(id);
    res.json(job);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

exports.getStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const job = await DialerJob.findById(id).lean();
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getLive = async (req, res) => {
  try {
    const { id } = req.params;
    const processing = await DialerNumber.find({ job: id, status: 'processing' })
      .select('phoneNumber callSid')
      .lean();
    res.json(processing);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};