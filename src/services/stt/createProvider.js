const GoogleStreamingProvider = require('./googleStreamingProvider');
const DeepgramStreamingProvider = require('./deepgramStreamingProvider');

function createSttProvider(providerName) {
  const name = String(providerName || 'deepgram').toLowerCase();
  if (name === 'google') {
    return new GoogleStreamingProvider();
  }
  if (name === 'deepgram') {
    return new DeepgramStreamingProvider();
  }
  throw new Error(`Invalid STT provider "${providerName}". Use "deepgram" or "google".`);
}

module.exports = {
  createSttProvider,
};
