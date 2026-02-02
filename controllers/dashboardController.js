const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const CallLogs = require('../models/callLogModel'); 

const toPercent = (num, den) => (den === 0 ? 0 : Math.round((num / den) * 100));

exports.getDashboardSummary = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user._id);

    const campaignsPromise = Campaign.find({ createdBy: userId })
      .select('_id name twilioDid isActive')
      .lean();

    const summaryPromise = CallLogs.aggregate([
      {
        $lookup: {
          from: 'campaigns', 
          localField: 'campaign',
          foreignField: '_id',
          as: 'campaignDoc',
        },
      },
      { $unwind: '$campaignDoc' },
      { $match: { 'campaignDoc.createdBy': userId } },

      {
        $facet: {
          stats: [
            {
              $group: {
                _id: null,
                totalCalls: { $sum: 1 },
                completedCalls: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
                },
                totalDuration: { $sum: { $ifNull: ['$duration', 0] } },
              },
            },
            {
              $project: {
                _id: 0,
                totalCalls: 1,
                completedCalls: 1,
                avgDurationSeconds: {
                  $cond: [
                    { $eq: ['$totalCalls', 0] },
                    0,
                    { $round: [{ $divide: ['$totalDuration', '$totalCalls'] }, 0] },
                  ],
                },
              },
            },
          ],

          recentCalls: [
            { $sort: { startTime: -1 } },
            { $limit: 5 },
            {
              $project: {
                _id: 1,
                fromNumber: 1,
                toNumber: 1,
                status: 1,
                duration: { $ifNull: ['$duration', 0] },
                startTime: 1,
                campaignName: '$campaignDoc.name',
              },
            },
          ],

          campaignPerformance: [
            {
              $group: {
                _id: '$campaignDoc._id',
                name: { $first: '$campaignDoc.name' },
                twilioDid: { $first: '$campaignDoc.twilioDid' },
                totalCalls: { $sum: 1 },
                completedCalls: {
                  $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
                },
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                twilioDid: 1,
                totalCalls: 1,
                successRate: {
                  $cond: [
                    { $eq: ['$totalCalls', 0] },
                    0,
                    {
                      $round: [
                        { $multiply: [{ $divide: ['$completedCalls', '$totalCalls'] }, 100] },
                        0,
                      ],
                    },
                  ],
                },
              },
            },
            { $sort: { totalCalls: -1 } },
          ],
        },
      },
    ]);

    const [campaigns, summaryArr] = await Promise.all([campaignsPromise, summaryPromise]);
    const summary = summaryArr?.[0] || {};

    const statsRow = summary.stats?.[0] || {
      totalCalls: 0,
      completedCalls: 0,
      avgDurationSeconds: 0,
    };

    const activeCampaigns = campaigns.filter((c) => c.isActive).length;

    res.json({
      stats: {
        totalCalls: statsRow.totalCalls,
        activeCampaigns,
        avgDurationSeconds: statsRow.avgDurationSeconds,
        successRate: toPercent(statsRow.completedCalls, statsRow.totalCalls),
      },
      recentCalls: summary.recentCalls || [],
      campaignPerformance: summary.campaignPerformance || [],
      campaigns,
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ message: 'Failed to load dashboard summary' });
  }
};
