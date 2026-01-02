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
    
    // Use default credentials if no explicit credentials found
    if (credentials) {
      this.client = new speech.SpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      // Use default service account (Cloud Run)
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
   * Start streaming recognition with Google Cloud Speech-to-Text
   */
  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    const client = await this.getSpeechClient();
    
    // Frontend sends proper locale codes (en-US, fr-FR, etc.) - use directly
    
    // Enhanced configuration for better accuracy and word detection
    // Try 'latest_long' model first for better accuracy, fallback to 'default' if not supported
    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 48000, // Match frontend sample rate
        languageCode: languageCode,
        enableAutomaticPunctuation: true,
        enableWordTimeOffsets: true, // Helps with word boundary detection
        useEnhanced: true, // Use enhanced model for better accuracy
        model: 'latest_long', // Use latest long model for better accuracy (supports most languages)
        // Alternative language codes can help with mixed language scenarios
        // but may reduce accuracy, so we'll leave it out for now
      },
      interimResults: true, // Get interim results for real-time display
      singleUtterance: false // Allow continuous streaming
    };

    // Create streaming recognition request with fallback for unsupported models
    let recognizeStream;
    try {
      recognizeStream = client.streamingRecognize(request);
    } catch (error) {
      // If latest_long model fails, try with default model (better language compatibility)
      if (error.message && error.message.includes('model')) {
        console.warn(`⚠️ Enhanced model not supported for ${languageCode}, falling back to default model`);
        request.config.model = 'default';
        request.config.useEnhanced = false; // Disable enhanced when using default model
        try {
          recognizeStream = client.streamingRecognize(request);
        } catch (fallbackError) {
          console.error('❌ Failed to create recognize stream with fallback:', fallbackError);
          throw new Error(`Failed to create recognition stream: ${fallbackError.message}`);
        }
      } else {
        console.error('❌ Failed to create recognize stream:', error);
        throw new Error(`Failed to create recognition stream: ${error.message}`);
      }
    }

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

    // Handle streaming responses
    recognizeStream.on('data', (response) => {
      if (response.results && response.results.length > 0) {
        const result = response.results[0];
        const transcript = result.alternatives[0].transcript;
        const isFinal = result.isFinal;
        const confidence = result.alternatives[0].confidence || 0.8;
        
        if (callbacks && callbacks.onResult) {
          callbacks.onResult({
            transcript: transcript,
            isFinal: isFinal,
            confidence: confidence,
            resultEndTime: result.resultEndTime
          });
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
   */
  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      try {
        recognizeStream.write(audioBuffer);
      } catch (error) {
        console.error('❌ Error writing to stream:', error);
      }
    } else {
      console.error('❌ Cannot send audio - stream is null or destroyed');
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
