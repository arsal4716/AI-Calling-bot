const express = require('express');
const router = express.Router();
const callLogController = require('../controllers/callLogController');

router.get('/', callLogController.getCallLogs);

module.exports = router;