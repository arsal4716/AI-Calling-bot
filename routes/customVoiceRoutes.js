const express = require("express");
const {
  getCustomVoices,
  createCustomVoice,
  updateCustomVoice,
  deleteCustomVoice,
} = require("../controllers/customVoiceController");
const { protect } = require("../middlewares/authMiddleware");

const router = express.Router();

router
  .route("/")
  .get(protect, getCustomVoices)
  .post(protect, createCustomVoice);

router
  .route("/:id")
  .put(protect, updateCustomVoice)
  .delete(protect, deleteCustomVoice);

module.exports = router;