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
    
    // Standby stream management (clean handoff approach)
    this.standbyStreams = new Map(); // socketId -> { stream, callbacks, createdAt }
    this.PRE_RESTART_BUFFER = 90000; // Create standby stream 1.5 minutes before limit
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
   * V1 API models: default, phone_call, video, command_and_search, latest_long, latest_short
   * phone_call is best for conversational speech
   */
  getBestModelForLanguage(languageCode) {
    // V1 API model selection - phone_call is optimized for conversational speech
    const modelMap = {
      // English - full enhanced support
      'en-US': { model: 'telephony', useEnhanced: true },
      'en-GB': { model: 'telephony', useEnhanced: true },
      'en-AU': { model: 'telephony', useEnhanced: true },
      'en-CA': { model: 'telephony', useEnhanced: false },
      'en-IN': { model: 'telephony', useEnhanced: true },
      
      // French - phone_call for conversational
      'fr-FR': { model: 'telephony', useEnhanced: false },
      'fr-CA': { model: 'telephony', useEnhanced: false },
      'fr-BE': { model: 'telephony', useEnhanced: false },
      'fr-CH': { model: 'telephony', useEnhanced: false },
      
      // Spanish
      'es-ES': { model: 'telephony', useEnhanced: false },
      'es-MX': { model: 'telephony', useEnhanced: false },
      'es-US': { model: 'telephony', useEnhanced: false },
      'es-419': { model: 'telephony', useEnhanced: false },
      'es-CO': { model: 'telephony', useEnhanced: false },
      
      // Other languages
      'pt-BR': { model: 'telephony', useEnhanced: false },
      'de-DE': { model: 'telephony', useEnhanced: false },
      'it-IT': { model: 'telephony', useEnhanced: false },
      'ja-JP': { model: 'telephony', useEnhanced: false },
    };
    
    if (modelMap[languageCode]) {
      return modelMap[languageCode];
    }
    
    // Fallback by language prefix
    const langPrefix = languageCode.split('-')[0];
    if (['en', 'fr', 'de', 'it', 'ja', 'pt'].includes(langPrefix)) {
      return { model: 'telephony', useEnhanced: false };
    }
    
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

    // Start standby stream creation 1.5 minutes before limit (at 3.5 minutes)
    const STREAM_DURATION_LIMIT = (3.5 * 60 * 1000); // 3.5 minutes - create standby at this point

    // Set up automatic standby creation timer - attach to stream so it can be cleared
    const standbyTimer = setTimeout(() => {
      if (callbacks && callbacks.onPreRestart && typeof callbacks.onPreRestart === 'function') {
        // Signal that standby stream should be created
        callbacks.onPreRestart();
      }
    }, STREAM_DURATION_LIMIT);
    
    // Attach timer to stream so server.js can clear it
    recognizeStream._standbyTimer = standbyTimer;

    // Handle streaming responses - Works with both V1 and V2 models
    recognizeStream.on('data', (response) => {
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
      clearTimeout(standbyTimer);
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
      clearTimeout(standbyTimer);
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd();
      }
    });

    // Store standby timer for cleanup
    recognizeStream._standbyTimer = standbyTimer;

    return recognizeStream;
  }

  /**
   * Send audio data to streaming recognition
   * V1 API: Audio is sent directly as buffer
   */
  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
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
      // Clear restart timer if it exists
      if (recognizeStream._restartTimer) {
        clearTimeout(recognizeStream._restartTimer);
        recognizeStream._restartTimer = null;
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
   * Create a standby stream that will be activated when current transcription is finalized
   * This stream is created but does not receive audio until activated
   */
  async createStandbyStream(socketId, languageCode, speechEndTimeout, callbacks) {
    
    try {
      // Create the stream but don't send audio to it yet
      const standbyStream = await this.startStreamingRecognition(languageCode, speechEndTimeout, callbacks);
      
      // Store standby stream info
      this.standbyStreams.set(socketId, {
        stream: standbyStream,
        callbacks: callbacks,
        createdAt: Date.now(),
        languageCode: languageCode,
        speechEndTimeout: speechEndTimeout
      });
      
      return standbyStream;
    } catch (error) {
      console.error(`❌ [STANDBY] Failed to create standby stream for ${socketId}:`, error);
      throw error;
    }
  }

  /**
   * Activate standby stream and switch to it (closing old stream)
   * This is called when a transcription bubble is finalized
   */
  activateStandbyStream(socketId, oldStream) {
    
    const standbyInfo = this.standbyStreams.get(socketId);
    if (!standbyInfo || !standbyInfo.stream) {
      console.log(`⚠️ [STANDBY] No standby stream found for ${socketId}`);
      return null;
    }
    
    // Close the old stream cleanly
    if (oldStream && !oldStream.destroyed) {
      this.endStreamingRecognition(oldStream);
    }
    
    // Remove standby from map (it's now the active stream)
    this.standbyStreams.delete(socketId);
    
    return standbyInfo.stream;
  }

  /**
   * Check if a standby stream exists for a socket
   */
  hasStandbyStream(socketId) {
    return this.standbyStreams.has(socketId);
  }

  /**
   * Clean up standby stream if it exists (e.g., on disconnect)
   */
  cleanupStandbyStream(socketId) {
    const standbyInfo = this.standbyStreams.get(socketId);
    if (standbyInfo && standbyInfo.stream) {
      this.endStreamingRecognition(standbyInfo.stream);
    }
    this.standbyStreams.delete(socketId);
  }


}

module.exports = new SpeechToTextService();
