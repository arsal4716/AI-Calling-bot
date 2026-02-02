const express = require('express');
const { protect } = require('../middlewares/authMiddleware');
const { getDashboardSummary } = require('../controllers/dashboardController');

const router = express.Router();

router.get('/summary', protect, getDashboardSummary);

module.exports = router;
