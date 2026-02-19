const DialerQueueService = require('./DialerQueueService');
const { getTwilioService } = require('./twilioSingleton');

let queueService;

module.exports = {
  initDialerQueueService: () => {
    if (!queueService) {
      const twilioService = getTwilioService();
      queueService = new DialerQueueService(twilioService);
    }
    return queueService;
  },
  getDialerQueueService: () => {
    if (!queueService) {
      throw new Error('DialerQueueService not initialized. Call initDialerQueueService first.');
    }
    return queueService;
  }
};