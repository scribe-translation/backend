const fs = require('fs');
const speech = require('@google-cloud/speech');
const config = require('../config');
const { spawn } = require('child_process');
// No normalization needed - frontend sends proper locale codes (en-US, fr-FR, etc.)

class SpeechToTextService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
    // Note: Client initialization is deferred to getSpeechClient() for faster startup
    
    // Lazy rotation: flag set at ~3.5m; new Google stream opens on next final or forced at ~4.5m
    this.standbyNeededBySocket = new Map(); // socketId -> true
  }

  markStandbyNeeded(socketId) {
    this.standbyNeededBySocket.set(socketId, true);
  }

  isStandbyNeeded(socketId) {
    return this.standbyNeededBySocket.get(socketId) === true;
  }

  clearStandbyNeeded(socketId) {
    this.standbyNeededBySocket.delete(socketId);
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
      this.client = new speech.SpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      this.client = new speech.SpeechClient({
        projectId: this.projectId
      });
    }

    return this.client;
  }

  /**
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
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-CA',
      },
      audio: {
        content: audioBuffer.toString('base64'),
      },
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
   * Get the best model for a given language code
   * V1 API models: default, latest_long, latest_short, telephony, telephony_short
   * latest_long is Google's newest Conformer-based model with best quality
   */
  getBestModelForLanguage(languageCode) {
    // Languages that support latest_long (highest quality, Conformer-based)
    const latestLongSupported = new Set([
      // English
      'en-US', 'en-GB', 'en-AU', 'en-IN',
      // French
      'fr-FR', 'fr-CA',
      // Spanish
      'es-ES', 'es-US',
      // German
      'de-DE',
      // Portuguese
      'pt-BR', 'pt-PT',
      // Italian
      'it-IT',
      // Japanese
      'ja-JP',
      // Korean
      'ko-KR',
      // Russian
      'ru-RU',
      // Arabic variants
      'ar-DZ', 'ar-BH', 'ar-EG', 'ar-IQ', 'ar-IL', 'ar-JO', 'ar-KW', 'ar-LB',
      'ar-MR', 'ar-MA', 'ar-OM', 'ar-QA', 'ar-SA', 'ar-PS', 'ar-TN', 'ar-AE', 'ar-YE',
      // Asian languages
      'hi-IN', 'vi-VN', 'th-TH', 'id-ID',
      // European languages
      'nl-NL', 'sv-SE', 'da-DK', 'fi-FI', 'no-NO', 'pl-PL', 'cs-CZ', 'tr-TR', 'uk-UA',
      // Indian languages
      'bn-BD', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN',
      // Other
      'ro-RO', 'bg-BG', 'hu-HU', 'km-KH'
    ]);
    
    // Languages with telephony support (good for conversational, fallback)
    const telephonySupported = new Set([
      'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN', 'en-IE', 'en-NZ', 'en-SG',
      'en-HK', 'en-PK',
      'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH',
      'es-ES', 'es-US', 'es-MX', 'es-AR', 'es-CL', 'es-CO', 'es-PE',
      'de-DE', 'de-AT', 'de-CH',
      'pt-BR', 'pt-PT',
      'it-IT', 'it-CH',
      'ja-JP',
      'ko-KR',
      'nl-NL', 'nl-BE',
      'hi-IN'
    ]);
    
    // Check for latest_long support (preferred - highest quality)
    if (latestLongSupported.has(languageCode)) {
      return { model: 'latest_long', useEnhanced: false };
    }
    
    // Check for telephony support (good quality, conversational)
    if (telephonySupported.has(languageCode)) {
      return { model: 'telephony', useEnhanced: false };
    }
    
    // Fallback by language prefix to latest_long or telephony
    const langPrefix = languageCode.split('-')[0];
    
    // Check if any variant of this language supports latest_long
    for (const lang of latestLongSupported) {
      if (lang.startsWith(langPrefix + '-')) {
        return { model: 'latest_long', useEnhanced: false };
      }
    }
    
    // Check if any variant supports telephony
    for (const lang of telephonySupported) {
      if (lang.startsWith(langPrefix + '-')) {
        return { model: 'telephony', useEnhanced: false };
      }
    }
    
    // Ultimate fallback to default (supports all languages)
    return { model: 'default', useEnhanced: false };
  }

  /**
   * Start streaming recognition with Google Cloud Speech-to-Text V1 API
   */
  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    const client = await this.getSpeechClient();
    
    // Verify project ID is set
    if (!this.projectId) {
      throw new Error('GOOGLE_CLOUD_PROJECT_ID is not set');
    }
    
    // Determine best model based on language
    const modelInfo = this.getBestModelForLanguage(languageCode);
    const model = modelInfo.model;
    const useEnhanced = modelInfo.useEnhanced;
    
    console.log(`🔍 [V1 API] Selected model for ${languageCode}: ${model} (enhanced: ${useEnhanced})`);
    
    // V1 API streaming configuration
    const streamingConfig = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 48000,
        languageCode: languageCode,
        model: model,
        useEnhanced: useEnhanced,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true
      },
      interimResults: true
    };
    
    // Create the streaming recognition request
    const recognizeStream = client.streamingRecognize(streamingConfig);
    
    console.log(`✅ [V1 API] Stream created with model "${model}" for ${languageCode}`);

    // Stream health tracking
    const streamHealth = {
      lastDataTime: Date.now(),
      lastAudioTime: Date.now(),
      createdAt: Date.now()
    };
    recognizeStream._health = streamHealth;

    // Google Cloud streaming limit is ~5 minutes (305 seconds)
    // Pre-restart: Create standby at 3.5 minutes
    const STANDBY_CREATION_TIME = (3.5 * 60 * 1000); // 3.5 minutes
    // Hard restart: Force restart at 4.5 minutes to ensure we don't hit the limit
    const HARD_RESTART_TIME = (4.5 * 60 * 1000); // 4.5 minutes
    // Health check: If no data received for 30 seconds while audio is being sent, restart
    const HEALTH_CHECK_INTERVAL = 10000; // Check every 10 seconds
    const DATA_TIMEOUT = 30000; // 30 seconds without data = problem

    // Set up automatic standby creation timer
    const standbyTimer = setTimeout(() => {
      console.log(`⏰ [STREAM] Standby timer fired at ${(Date.now() - streamHealth.createdAt) / 1000}s`);
      if (callbacks && callbacks.onPreRestart && typeof callbacks.onPreRestart === 'function') {
        callbacks.onPreRestart();
      }
    }, STANDBY_CREATION_TIME);

    // Set up HARD restart timer - force restart before hitting Google's limit
    const hardRestartTimer = setTimeout(() => {
      console.log(`⏰ [STREAM] Hard restart timer fired at ${(Date.now() - streamHealth.createdAt) / 1000}s - forcing restart`);
      if (callbacks && callbacks.onRestart && typeof callbacks.onRestart === 'function') {
        callbacks.onRestart();
      }
    }, HARD_RESTART_TIME);

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
    
    // Attach timers to stream so they can be cleared
    recognizeStream._standbyTimer = standbyTimer;
    recognizeStream._hardRestartTimer = hardRestartTimer;
    recognizeStream._healthCheckInterval = healthCheckInterval;

    // Handle streaming responses - Works with both V1 and V2 models
    recognizeStream.on('data', (response) => {
      // Update health tracking - we received data
      if (recognizeStream._health) {
        recognizeStream._health.lastDataTime = Date.now();
      }
      
      if (response.results && response.results.length > 0) {
        const result = response.results[0];
        if (result.alternatives && result.alternatives.length > 0) {
          const alternative = result.alternatives[0];
          const transcript = alternative.transcript;
          const isFinal = result.isFinal || false;
          const confidence = alternative.confidence || 0.8;
          
          if (callbacks && callbacks.onResult) {
            callbacks.onResult({
              transcript: transcript,
              isFinal: isFinal,
              confidence: confidence,
              resultEndTime: result.resultEndTime
            });
          }
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
      
      // Clear all timers
      clearTimeout(standbyTimer);
      clearTimeout(hardRestartTimer);
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
      clearTimeout(standbyTimer);
      clearTimeout(hardRestartTimer);
      clearInterval(healthCheckInterval);
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd();
      }
    });

    return recognizeStream;
  }

  /**
   * Send audio data to streaming recognition
   * Audio is sent directly as buffer to the streaming recognition
   */
  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
        // Update health tracking - we're sending audio
        if (recognizeStream._health) {
          recognizeStream._health.lastAudioTime = Date.now();
        }
        recognizeStream.write(audioBuffer);
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
      if (recognizeStream._standbyTimer) {
        clearTimeout(recognizeStream._standbyTimer);
        recognizeStream._standbyTimer = null;
      }
      if (recognizeStream._hardRestartTimer) {
        clearTimeout(recognizeStream._hardRestartTimer);
        recognizeStream._hardRestartTimer = null;
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
   * Clear lazy-rotation flag (disconnect / language change / client restart)
   */
  cleanupStandbyStream(socketId) {
    this.standbyNeededBySocket.delete(socketId);
  }


}

module.exports = new SpeechToTextService();
