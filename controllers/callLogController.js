const CallLog = require('../models/callLogModel');
const mongoose = require('mongoose');

exports.getCallLogs = async (req, res) => {
  try {
    let { search, status, campaign, from, to, cursor, limit = 20 } = req.query;
    limit = parseInt(limit);

    const query = {};
    if (search) {
      query.$or = [
        { toNumber: { $regex: search, $options: 'i' } },
        { callSid: { $regex: search, $options: 'i' } }
      ];
    }
    if (status) query.status = status;
    if (campaign && mongoose.Types.ObjectId.isValid(campaign)) query.campaign = campaign;
    if (from || to) {
      query.startTime = {};
      if (from) query.startTime.$gte = new Date(from);
      if (to) query.startTime.$lte = new Date(to);
    }
    if (cursor) {
      query._id = { $lt: mongoose.Types.ObjectId(cursor) };
    }

    const logs = await CallLog.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate('campaign', 'name')
      .lean();

    const hasMore = logs.length > limit;
    if (hasMore) logs.pop();

    res.json({
      logs,
      nextCursor: hasMore ? logs[logs.length - 1]._id : null,
      hasMore
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};