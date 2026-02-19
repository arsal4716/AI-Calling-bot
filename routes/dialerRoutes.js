const express = require('express');
const router = express.Router();
const dialerController = require('../controllers/dialerController');

router.post('/upload', dialerController.uploadCSV);
router.post('/:id/start', dialerController.startJob);
router.post('/:id/stop', dialerController.stopJob);
router.get('/:id/status', dialerController.getStatus);
router.get('/:id/live', dialerController.getLive);

module.exports = router;