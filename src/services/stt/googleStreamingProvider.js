const fs = require('fs');
const { v2: speechV2 } = require('@google-cloud/speech');
const config = require('../../config');
const {
  selectStreamingModel,
  buildStreamingConfigRequest,
  buildAudioRequest,
  parseStreamingResponse,
} = require('../streamingRecognitionConfig');

class GoogleStreamingProvider {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
    this.rotationArmedBySocket = new Map();
  }

  getProviderName() {
    return 'google';
  }

  supportsStreamRotation() {
    return true;
  }

  armRotation(socketId) {
    this.rotationArmedBySocket.set(socketId, true);
  }

  isRotationArmed(socketId) {
    return this.rotationArmedBySocket.get(socketId) === true;
  }

  clearRotation(socketId) {
    this.rotationArmedBySocket.delete(socketId);
  }

  cleanupRotation(socketId) {
    this.rotationArmedBySocket.delete(socketId);
  }

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';

      if (isProduction) {
        this.credentials = null;
        return this.credentials;
      }

      if (fs.existsSync('./google-credentials.json')) {
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      this.credentials = null;
      return this.credentials;
    } catch (error) {
      console.error('❌ Failed to load credentials:', error);
      console.log('⚠️ Falling back to default service account');
      this.credentials = null;
      return this.credentials;
    }
  }

  async getSpeechClient() {
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();

    if (credentials) {
      this.client = new speechV2.SpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
      });
    } else {
      this.client = new speechV2.SpeechClient({
        projectId: this.projectId,
      });
    }

    return this.client;
  }

  async warmClient() {
    return this.getSpeechClient();
  }

  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    void speechEndTimeout;
    const client = await this.getSpeechClient();

    if (!this.projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT_ID is not set');
    }

    const model = selectStreamingModel(languageCode);
    const configRequest = buildStreamingConfigRequest({
      projectId: this.projectId,
      languageCode,
      sampleRateHertz: 48000,
    });

    console.log(`🔍 [V2 API] Selected model for ${languageCode}: ${model} (interim results)`);

    const recognizeStream = client._streamingRecognize();

    console.log(`✅ [V2 API] Stream created with model "${model}" for ${languageCode}`);

    const streamHealth = {
      lastDataTime: Date.now(),
      lastAudioTime: Date.now(),
      createdAt: Date.now(),
    };
    recognizeStream._health = streamHealth;
    recognizeStream._sttProvider = 'google';

    const ROTATION_ARM_TIME = 180000;
    const FORCE_FINALIZE_TIME = 280000;
    const HEALTH_CHECK_INTERVAL = 10000;
    const DATA_TIMEOUT = 30000;

    const rotationArmTimer = setTimeout(() => {
      console.log(`⏰ [STREAM] Rotation arm timer fired at ${(Date.now() - streamHealth.createdAt) / 1000}s`);
      if (callbacks && callbacks.onRotationArm && typeof callbacks.onRotationArm === 'function') {
        callbacks.onRotationArm();
      }
    }, ROTATION_ARM_TIME);

    const forceFinalizeTimer = setTimeout(() => {
      console.log(`⏰ [STREAM] Force-finalize timer fired at ${(Date.now() - streamHealth.createdAt) / 1000}s`);
      if (callbacks && callbacks.onForceFinalize && typeof callbacks.onForceFinalize === 'function') {
        callbacks.onForceFinalize();
      }
    }, FORCE_FINALIZE_TIME);

    const healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceData = now - streamHealth.lastDataTime;
      const timeSinceAudio = now - streamHealth.lastAudioTime;
      const streamAge = now - streamHealth.createdAt;

      if (timeSinceAudio < 5000 && timeSinceData > DATA_TIMEOUT) {
        console.warn(`⚠️ [STREAM] Health check failed: No data for ${timeSinceData / 1000}s while audio still flowing. Forcing restart.`);
        clearInterval(healthCheckInterval);
        if (callbacks && callbacks.onRestart && typeof callbacks.onRestart === 'function') {
          callbacks.onRestart();
        }
      }

      if (streamAge > 0 && streamAge % 60000 < HEALTH_CHECK_INTERVAL) {
        console.log(`📊 [STREAM] Health: age=${Math.round(streamAge / 1000)}s, lastData=${Math.round(timeSinceData / 1000)}s ago, lastAudio=${Math.round(timeSinceAudio / 1000)}s ago`);
      }
    }, HEALTH_CHECK_INTERVAL);

    recognizeStream._rotationArmTimer = rotationArmTimer;
    recognizeStream._forceFinalizeTimer = forceFinalizeTimer;
    recognizeStream._healthCheckInterval = healthCheckInterval;

    recognizeStream.on('data', (response) => {
      if (recognizeStream._health) {
        recognizeStream._health.lastDataTime = Date.now();
      }

      const parsedResults = parseStreamingResponse(response);
      if (callbacks && callbacks.onResult) {
        for (const parsed of parsedResults) {
          callbacks.onResult(parsed);
        }
      }
    });

    recognizeStream.on('error', (error) => {
      console.error('❌ Google Cloud streaming error:', error);
      console.error('Error details:', {
        code: error.code,
        message: error.message,
        details: error.details,
        metadata: error.metadata,
      });

      clearTimeout(rotationArmTimer);
      clearTimeout(forceFinalizeTimer);
      clearInterval(healthCheckInterval);

      if (recognizeStream) {
        recognizeStream.destroyed = true;
      }

      const isRecoverable =
        error.code === 14 ||
        error.code === 13 ||
        error.code === 11 ||
        error.code === 4 ||
        error.code === 2 ||
        (error.message &&
          (error.message.includes('UNAVAILABLE') ||
            error.message.includes('RST_STREAM') ||
            error.message.includes('GOAWAY') ||
            error.message.includes('deadline') ||
            error.message.includes('timeout') ||
            error.message.includes('Audio Timeout') ||
            error.message.includes('Request Timeout')));

      if (isRecoverable && callbacks && callbacks.onRestart) {
        setTimeout(() => {
          callbacks.onRestart();
        }, 500);
      } else if (callbacks && callbacks.onError) {
        callbacks.onError(error);
      }
    });

    recognizeStream.on('end', () => {
      console.log(`📊 [STREAM] Stream ended after ${(Date.now() - streamHealth.createdAt) / 1000}s`);
      recognizeStream.destroyed = true;
      clearTimeout(rotationArmTimer);
      clearTimeout(forceFinalizeTimer);
      clearInterval(healthCheckInterval);
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd(recognizeStream);
      }
    });

    recognizeStream.write(configRequest);

    return recognizeStream;
  }

  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
        if (recognizeStream._health) {
          recognizeStream._health.lastAudioTime = Date.now();
        }
        recognizeStream.write(buildAudioRequest(audioBuffer));
      } catch (error) {
        console.error('❌ Error writing to stream:', error);
      }
    }
  }

  endStreamingRecognition(recognizeStream) {
    if (recognizeStream && !recognizeStream.destroyed) {
      if (recognizeStream._restartTimer) {
        clearTimeout(recognizeStream._restartTimer);
        recognizeStream._restartTimer = null;
      }
      if (recognizeStream._rotationArmTimer) {
        clearTimeout(recognizeStream._rotationArmTimer);
        recognizeStream._rotationArmTimer = null;
      }
      if (recognizeStream._forceFinalizeTimer) {
        clearTimeout(recognizeStream._forceFinalizeTimer);
        recognizeStream._forceFinalizeTimer = null;
      }
      if (recognizeStream._healthCheckInterval) {
        clearInterval(recognizeStream._healthCheckInterval);
        recognizeStream._healthCheckInterval = null;
      }

      recognizeStream.removeAllListeners();
      recognizeStream.end();
      recognizeStream.destroyed = true;
    }
  }
}

module.exports = GoogleStreamingProvider;
