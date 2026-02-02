const express = require("express");
const {
  cloneVoice,
  getVoices,
  getVoiceById,
  deleteVoice,
  playVoice,
} = require("../controllers/voiceCloneController");
const { protect } = require("../middlewares/authMiddleware");
const upload = require("../middlewares/uploadMiddleware");
const router = express.Router();

router
  .route("/")
  .get(protect, getVoices)
  .post(protect, upload.single("audio"), cloneVoice);
router.post("/:id/play", protect, playVoice);

router.route("/:id").get(protect, getVoiceById).delete(protect, deleteVoice);

module.exports = router;
