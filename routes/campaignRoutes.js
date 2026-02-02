const express = require('express');
const {
  createCampaign,
  getCampaigns,
  getCampaignById,
  updateCampaign,
  deleteCampaign,
} = require('../controllers/campaignController');
const { protect } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');
const router = express.Router();

router
  .route('/')
  .get(protect, getCampaigns)
  .post(protect, upload.single('prompts'), createCampaign);

router
  .route('/:id')
  .get(protect, getCampaignById)
  .put(protect, upload.single('prompts'), updateCampaign)
  .delete(protect, deleteCampaign);

module.exports = router;