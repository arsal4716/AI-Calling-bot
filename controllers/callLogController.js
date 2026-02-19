// backend/controllers/callLogController.js
const CallLog = require("../models/callLogModel");
const mongoose = require("mongoose");

exports.getCallLogs = async (req, res) => {
  try {
    let {
      search = "",
      status = "",
      campaign = "",
      from = "",
      to = "",
      cursor = "",
      limit = 20,
    } = req.query;

    limit = Math.min(parseInt(limit, 10) || 20, 100);

    const query = {};

    // search by toNumber or callSid
    if (search && String(search).trim()) {
      const s = String(search).trim();
      query.$or = [
        { toNumber: { $regex: s, $options: "i" } },
        { callSid: { $regex: s, $options: "i" } },
      ];
    }

    // status must match DB values (completed, failed, busy, no_answer, etc.)
    if (status && String(status).trim()) {
      query.status = String(status).trim();
    }

    // campaign filter
    if (campaign && mongoose.Types.ObjectId.isValid(campaign)) {
      query.campaign = new mongoose.Types.ObjectId(campaign);
    }

    // date range
    if (from || to) {
      query.startTime = {};
      if (from) query.startTime.$gte = new Date(from);

      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.startTime.$lte = end;
      }
    }

    // cursor pagination by _id
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    const rows = await CallLog.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("campaign", "name")
      .lean();

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    res.json({
      logs: rows,
      nextCursor: hasMore ? rows[rows.length - 1]?._id : null,
      hasMore,
      limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
