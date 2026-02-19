// backend/services/dialerQueueSingleton.js
const DialerQueueService = require("./DialerQueueService");
const { getTwilioService } = require("./twilioSingleton");

let queueService = null;

function initDialerQueueService() {
  if (!queueService) {
    const twilioService = getTwilioService();
    queueService = new DialerQueueService(twilioService);
    console.log(" DialerQueueService initialized");
  }
  return queueService;
}

function getDialerQueueService() {
  if (!queueService) {
    throw new Error(
      "DialerQueueService not initialized. Call initDialerQueueService first."
    );
  }
  return queueService;
}

module.exports = { initDialerQueueService, getDialerQueueService };
