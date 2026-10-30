const config = require('../config');
const { createSttProvider } = require('./stt/createProvider');

class SpeechToTextService {
  constructor() {
    this.provider = createSttProvider(config.STT_PROVIDER);
    console.log(`🎙️ STT provider: ${this.provider.getProviderName()}`);
  }

  getProviderName() {
    return this.provider.getProviderName();
  }

  supportsStreamRotation() {
    return this.provider.supportsStreamRotation();
  }

  armRotation(socketId) {
    this.provider.armRotation(socketId);
  }

  isRotationArmed(socketId) {
    return this.provider.isRotationArmed(socketId);
  }

  clearRotation(socketId) {
    this.provider.clearRotation(socketId);
  }

  cleanupRotation(socketId) {
    this.provider.cleanupRotation(socketId);
  }

  async warmClient() {
    return this.provider.warmClient();
  }

  /** @deprecated Prefer warmClient(); kept for Google-era call sites */
  async getSpeechClient() {
    if (typeof this.provider.getSpeechClient === 'function') {
      return this.provider.getSpeechClient();
    }
    return this.provider.warmClient();
  }

  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    return this.provider.startStreamingRecognition(languageCode, speechEndTimeout, callbacks);
  }

  sendAudioToStream(recognizeStream, audioBuffer) {
    this.provider.sendAudioToStream(recognizeStream, audioBuffer);
  }

  endStreamingRecognition(recognizeStream) {
    this.provider.endStreamingRecognition(recognizeStream);
  }
}

module.exports = new SpeechToTextService();
