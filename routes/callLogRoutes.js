const express = require("express");
const router = express.Router();
const callLogController = require("../controllers/callLogController");

router.get("/", callLogController.getCallLogs);
router.get("/:id/recording", callLogController.getCallLogRecording);

module.exports = router;