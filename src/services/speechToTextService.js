const fs = require('fs');
const { v2: speechV2 } = require('@google-cloud/speech');
const config = require('../config');
const { spawn } = require('child_process');
const {
  selectStreamingModel,
  buildStreamingConfigRequest,
  buildAudioRequest,
  parseStreamingResponse,
} = require('./streamingRecognitionConfig');
// No normalization needed - frontend sends proper locale codes (en-US, fr-FR, etc.)

class SpeechToTextService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
    // Note: Client initialization is deferred to getSpeechClient() for faster startup
    
    // Rotation armed at 3:00; new Google stream opens on next final or forced at 4:40
    this.rotationArmedBySocket = new Map(); // socketId -> true
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

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';
      
      if (isProduction) {
        // Production: always use service account (ADC)
        this.credentials = null;
        return this.credentials;
      }
      
      // Development: try local credentials file
      if (fs.existsSync('./google-credentials.json')) {
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      // Fallback to ADC
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
          private_key: credentials.private_key
        }
      });
    } else {
      this.client = new speechV2.SpeechClient({
        projectId: this.projectId
      });
    }

    return this.client;
  }

  /**
   * Convert WebM audio to LINEAR16 format using FFmpeg
   */
  async convertWebMToLinear16(webmBuffer) {
    return new Promise((resolve, reject) => {
      
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',           // Read from stdin
        '-f', 's16le',            // Output format: signed 16-bit little endian
        '-ar', '16000',           // Sample rate: 16kHz
        '-ac', '1',               // Mono channel
        '-y',                     // Overwrite output
        'pipe:1'                  // Write to stdout
      ]);

      let outputBuffer = Buffer.alloc(0);
      let errorBuffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (data) => {
        outputBuffer = Buffer.concat([outputBuffer, data]);
      });

      ffmpeg.stderr.on('data', (data) => {
        errorBuffer = Buffer.concat([errorBuffer, data]);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(outputBuffer);
        } else {
          const error = errorBuffer.toString();
          console.log('❌ FFmpeg conversion failed:', error);
          reject(new Error(`FFmpeg conversion failed: ${error}`));
        }
      });

      ffmpeg.on('error', (error) => {
        console.log('❌ FFmpeg spawn error:', error.message);
        reject(error);
      });

      // Send WebM data to FFmpeg
      ffmpeg.stdin.write(webmBuffer);
      ffmpeg.stdin.end();
    });
  }

  /**
   * Test LINEAR16 format with Google Cloud Speech-to-Text
   */
  async testLinear16Format(audioBuffer) {
    
    const client = await this.getSpeechClient();
    
    const request = {
      recognizer: `projects/${this.projectId}/locations/global/recognizers/_`,
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          audioChannelCount: 1,
        },
        languageCodes: ['en-CA'],
        model: 'telephony',
      },
      content: audioBuffer,
    };

    try {
      const [response] = await client.recognize(request);
      return response;
    } catch (error) {
      console.log('❌ LINEAR16 format test failed:', error.message);
      return null;
    }
  }

  /**
   * Start streaming recognition with Google Cloud Speech-to-Text V2 API.
   * speechEndTimeout is retained so existing callers keep the same signature.
   * Phrase length is controlled by v2 endpointing sensitivity.
   */
  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    void speechEndTimeout;
    const client = await this.getSpeechClient();
    
    // Verify project ID is set
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

    // Stream health tracking
    const streamHealth = {
      lastDataTime: Date.now(),
      lastAudioTime: Date.now(),
      createdAt: Date.now()
    };
    recognizeStream._health = streamHealth;

    // Google Cloud streaming limit is ~5 minutes (305 seconds)
    const ROTATION_ARM_TIME = 180000; // 3:00 — arm rotation, wait for finalization boundary
    const FORCE_FINALIZE_TIME = 280000; // 4:40 — force-finalize if speaker never pauses
    const HEALTH_CHECK_INTERVAL = 10000; // Check every 10 seconds
    const DATA_TIMEOUT = 30000; // 30 seconds without data = problem

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

    // Health check - detect silent stream failures
    const healthCheckInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceData = now - streamHealth.lastDataTime;
      const timeSinceAudio = now - streamHealth.lastAudioTime;
      const streamAge = now - streamHealth.createdAt;
      
      // If we've received audio recently but no data for 30+ seconds, stream may be dead
      if (timeSinceAudio < 5000 && timeSinceData > DATA_TIMEOUT) {
        console.warn(`⚠️ [STREAM] Health check failed: No data for ${timeSinceData / 1000}s while audio still flowing. Forcing restart.`);
        clearInterval(healthCheckInterval);
        if (callbacks && callbacks.onRestart && typeof callbacks.onRestart === 'function') {
          callbacks.onRestart();
        }
      }
      
      // Log health status periodically (every minute)
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
        metadata: error.metadata
      });
      
      clearTimeout(rotationArmTimer);
      clearTimeout(forceFinalizeTimer);
      clearInterval(healthCheckInterval);
      
      // Mark stream as destroyed on error
      if (recognizeStream) {
        recognizeStream.destroyed = true;
      }
      
      // Check if this is a recoverable error that should trigger restart
      const isRecoverable = error.code === 14 || // UNAVAILABLE
                           error.code === 13 || // INTERNAL
                           error.code === 11 || // OUT_OF_RANGE (Audio Timeout Error)
                           error.code === 4 ||  // DEADLINE_EXCEEDED
                           error.code === 2 ||  // UNKNOWN (often 408 Request Timeout)
                           (error.message && (
                             error.message.includes('UNAVAILABLE') ||
                             error.message.includes('RST_STREAM') ||
                             error.message.includes('GOAWAY') ||
                             error.message.includes('deadline') ||
                             error.message.includes('timeout') ||
                             error.message.includes('Audio Timeout') ||
                             error.message.includes('Request Timeout')
                           ));
      
      if (isRecoverable && callbacks && callbacks.onRestart) {
        // Delay restart slightly to avoid rapid reconnection
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
        callbacks.onEnd();
      }
    });

    recognizeStream.write(configRequest);

    return recognizeStream;
  }

  /**
   * Send audio data to streaming recognition.
   */
  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
        // Update health tracking - we're sending audio
        if (recognizeStream._health) {
          recognizeStream._health.lastAudioTime = Date.now();
        }
        recognizeStream.write(buildAudioRequest(audioBuffer));
      } catch (error) {
        console.error('❌ Error writing to stream:', error);
      }
    }
  }

  /**
   * End streaming recognition
   */
  endStreamingRecognition(recognizeStream) {
    if (recognizeStream && !recognizeStream.destroyed) {
      // Clear all timers
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
      
      // Remove all event listeners to prevent further events
      recognizeStream.removeAllListeners();
      
      // End the stream
      recognizeStream.end();
      
      // Mark as destroyed to prevent further use
      recognizeStream.destroyed = true;
    }
  }

  /**
   * Clear rotation flag (disconnect / language change / client restart)
   */
  cleanupRotation(socketId) {
    this.rotationArmedBySocket.delete(socketId);
  }


}

module.exports = new SpeechToTextService();
