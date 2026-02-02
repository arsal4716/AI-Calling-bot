let instance = null;

function setTwilioService(service) {
  instance = service;
}

function getTwilioService() {
  if (!instance) throw new Error("TwilioService not initialized");
  return instance;
}

module.exports = { setTwilioService, getTwilioService };
