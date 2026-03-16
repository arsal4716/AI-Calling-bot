const CallLog = require("../models/callLogModel");
const mongoose = require("mongoose");
const axios = require("axios");

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

    if (search && String(search).trim()) {
      const s = String(search).trim();
      query.$or = [
        { toNumber: { $regex: s, $options: "i" } },
        { callSid: { $regex: s, $options: "i" } },
        { fromNumber: { $regex: s, $options: "i" } },
         { rawFrom:                    { $regex: s, $options: "i" } }, 
        { disposition: { $regex: s, $options: "i" } },
        { "dispositionDetail.stage": { $regex: s, $options: "i" } },
      ];
    }

    if (status && String(status).trim()) {
      query.status = String(status).trim();
    }

    if (campaign && mongoose.Types.ObjectId.isValid(campaign)) {
      query.campaign = new mongoose.Types.ObjectId(campaign);
    }

    if (from || to) {
      query.startTime = {};
      if (from) query.startTime.$gte = new Date(from);

      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.startTime.$lte = end;
      }
    }

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

    const logs = rows.map((row) => ({
      ...row,
      recordingProxyUrl: row.recordingUrl
        ? `/api/call-logs/${row._id}/recording`
        : null,
    }));

    res.json({
      logs,
      nextCursor: hasMore ? logs[logs.length - 1]?._id : null,
      hasMore,
      limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getCallLogRecording = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid call log id" });
    }

    const log = await CallLog.findById(id).lean();

    if (!log) {
      return res.status(404).json({ error: "Call log not found" });
    }

    if (!log.recordingUrl) {
      return res.status(404).json({ error: "Recording not available" });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).json({ error: "Twilio credentials missing" });
    }

    const twilioResponse = await axios.get(log.recordingUrl, {
      responseType: "stream",
      auth: {
        username: accountSid,
        password: authToken,
      },
    });

    res.setHeader(
      "Content-Type",
      twilioResponse.headers["content-type"] || "audio/mpeg"
    );

    const contentLength = twilioResponse.headers["content-length"];
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    res.setHeader("Accept-Ranges", "bytes");
    twilioResponse.data.pipe(res);
  } catch (err) {
    const status = err?.response?.status || 500;
    const message =
      err?.response?.data?.message ||
      err.message ||
      "Failed to stream recording";

    res.status(status).json({ error: message });
  }
};