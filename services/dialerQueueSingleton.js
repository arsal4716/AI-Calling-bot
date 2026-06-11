// backend/services/dialerQueueSingleton.js
const DialerQueueService = require("./DialerQueueService");

let queueService = null;

function initDialerQueueService() {
  if (!queueService) {
    // Twilio removed: the outbound-API dialer is disabled (the production flow
    // is VICIdial-driven). Constructed with no provider so the app still boots;
    // attempting to dial surfaces a clear error.
    queueService = new DialerQueueService(null);
    console.log("DialerQueueService initialized (outbound-API dialing disabled)");
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
