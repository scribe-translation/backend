const { DeepgramClient } = require('@deepgram/sdk');
const config = require('../../config');
const { mapLanguageCodeForDeepgram } = require('./deepgramLanguage');
const { parseDeepgramResultsMessage } = require('./deepgramResults');

const KEEP_ALIVE_INTERVAL_MS = 4000;
const HEALTH_CHECK_INTERVAL_MS = 10000;
const DATA_TIMEOUT_MS = 30000;
const FINALIZE_FLUSH_MS = 300;

let logger = null;
const getLogger = () => {
  if (!logger) {
    try {
      logger = require('../../utils/logger').logger;
    } catch {
      logger = console;
    }
  }
  return logger;
};

class DeepgramStreamingProvider {
  constructor() {
    this.client = null;
    this.apiKey = config.DEEPGRAM_API_KEY;
  }

  getProviderName() {
    return 'deepgram';
  }

  supportsStreamRotation() {
    return false;
  }

  armRotation() {}

  isRotationArmed() {
    return false;
  }

  clearRotation() {}

  cleanupRotation() {}

  getClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.apiKey) {
      throw new Error('DEEPGRAM_API_KEY is not set');
    }

    this.client = new DeepgramClient({ apiKey: this.apiKey });
    return this.client;
  }

  async warmClient() {
    this.getClient();
    return this.client;
  }

  async startStreamingRecognition(languageCode, speechEndTimeout = 1.0, callbacks) {
    void speechEndTimeout;
    const client = this.getClient();
    const deepgramLanguage = mapLanguageCodeForDeepgram(languageCode);

    getLogger().info({
      provider: 'deepgram',
      languageCode,
      deepgramLanguage,
      model: 'nova-3',
      interimResults: true,
    }, 'Starting Deepgram live stream');

    const connection = await client.listen.v1.connect({
      model: 'nova-3',
      language: deepgramLanguage,
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
    });

    const streamHandle = {
      destroyed: false,
      _sttProvider: 'deepgram',
      _connection: connection,
      _health: {
        lastDataTime: Date.now(),
        lastAudioTime: Date.now(),
        createdAt: Date.now(),
      },
      _keepAliveInterval: null,
      _healthCheckInterval: null,
      _finalizeTimer: null,
      _ended: false,
      _teardownStarted: false,
      _acceptingResults: true,
    };

    const clearTimers = () => {
      if (streamHandle._keepAliveInterval) {
        clearInterval(streamHandle._keepAliveInterval);
        streamHandle._keepAliveInterval = null;
      }
      if (streamHandle._healthCheckInterval) {
        clearInterval(streamHandle._healthCheckInterval);
        streamHandle._healthCheckInterval = null;
      }
      if (streamHandle._finalizeTimer) {
        clearTimeout(streamHandle._finalizeTimer);
        streamHandle._finalizeTimer = null;
      }
    };

    const markEnded = (reason) => {
      if (streamHandle._ended) {
        return;
      }
      streamHandle._ended = true;
      streamHandle.destroyed = true;
      streamHandle._acceptingResults = false;
      clearTimers();
      getLogger().info({
        provider: 'deepgram',
        reason,
        duration: Math.round((Date.now() - streamHandle._health.createdAt) / 1000),
      }, 'Deepgram stream ended');
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd(streamHandle);
      }
    };

    const forceCloseConnection = () => {
      if (!streamHandle._connection) {
        return;
      }
      try {
        streamHandle._connection.sendCloseStream();
      } catch {
        try {
          streamHandle._connection.close();
        } catch (closeError) {
          getLogger().warn({
            provider: 'deepgram',
            error: closeError.message,
            context: 'forceCloseConnection',
          }, 'Deepgram close failed');
        }
      }
    };

    connection.on('open', () => {
      getLogger().info({
        provider: 'deepgram',
        language: deepgramLanguage,
      }, 'Deepgram stream opened');
    });

    connection.on('message', (data) => {
      if (!streamHandle._acceptingResults) {
        return;
      }

      if (data?.type === 'Results') {
        streamHandle._health.lastDataTime = Date.now();
        const parsedResults = parseDeepgramResultsMessage(data);
        if (callbacks && callbacks.onResult) {
          for (const parsed of parsedResults) {
            callbacks.onResult(parsed);
          }
        }
        return;
      }

      if (data?.type === 'Error') {
        getLogger().error({
          provider: 'deepgram',
          errorType: data.type,
          errorCode: data.code,
          errorMessage: data.description || data.message,
        }, 'Deepgram stream error message received');
        const error = new Error(data.description || data.message || 'Deepgram stream error');
        error.code = data.code;
        streamHandle._acceptingResults = false;
        clearTimers();
        forceCloseConnection();
        if (callbacks && callbacks.onRestart) {
          setTimeout(() => callbacks.onRestart(), 500);
        } else if (callbacks && callbacks.onError) {
          callbacks.onError(error);
        }
      }
    });

    connection.on('error', (error) => {
      getLogger().error({
        provider: 'deepgram',
        error: error?.message || String(error),
      }, 'Deepgram streaming error occurred');
      streamHandle._acceptingResults = false;
      clearTimers();
      forceCloseConnection();
      streamHandle.destroyed = true;

      const message = error?.message || String(error);
      const isRecoverable =
        message.includes('timeout') ||
        message.includes('Timeout') ||
        message.includes('NET-0001') ||
        message.includes('closed') ||
        message.includes('ECONNRESET');

      if (isRecoverable && callbacks && callbacks.onRestart) {
        setTimeout(() => callbacks.onRestart(), 500);
      } else if (callbacks && callbacks.onError) {
        callbacks.onError(error);
      }
    });

    connection.on('close', () => {
      markEnded('close');
    });

    streamHandle._keepAliveInterval = setInterval(() => {
      if (streamHandle.destroyed || streamHandle._teardownStarted || !streamHandle._connection) {
        return;
      }
      const idleMs = Date.now() - streamHandle._health.lastAudioTime;
      if (idleMs >= KEEP_ALIVE_INTERVAL_MS) {
        try {
          streamHandle._connection.sendKeepAlive();
        } catch (error) {
          getLogger().warn({
            provider: 'deepgram',
            error: error.message,
          }, 'Deepgram KeepAlive failed');
        }
      }
    }, KEEP_ALIVE_INTERVAL_MS);

    streamHandle._healthCheckInterval = setInterval(() => {
      if (streamHandle.destroyed || streamHandle._teardownStarted) {
        return;
      }
      const now = Date.now();
      const timeSinceData = now - streamHandle._health.lastDataTime;
      const timeSinceAudio = now - streamHandle._health.lastAudioTime;
      const streamAge = now - streamHandle._health.createdAt;

      if (timeSinceAudio < 5000 && timeSinceData > DATA_TIMEOUT_MS) {
        getLogger().warn({
          provider: 'deepgram',
          timeSinceData: Math.round(timeSinceData / 1000),
          timeSinceAudio: Math.round(timeSinceAudio / 1000),
        }, 'Deepgram health check failed - no data while audio flowing, forcing restart');
        streamHandle._acceptingResults = false;
        clearTimers();
        forceCloseConnection();
        if (callbacks && callbacks.onRestart) {
          callbacks.onRestart();
        }
      }

      if (streamAge > 0 && streamAge % 60000 < HEALTH_CHECK_INTERVAL_MS) {
        getLogger().debug({
          provider: 'deepgram',
          streamAge: Math.round(streamAge / 1000),
          timeSinceData: Math.round(timeSinceData / 1000),
          timeSinceAudio: Math.round(timeSinceAudio / 1000),
        }, 'Deepgram stream health check');
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    connection.connect();
    await connection.waitForOpen();

    return streamHandle;
  }

  sendAudioToStream(streamHandle, audioBuffer) {
    if (!streamHandle || streamHandle.destroyed || streamHandle._teardownStarted || !streamHandle._connection) {
      return;
    }

    try {
      streamHandle._health.lastAudioTime = Date.now();
      streamHandle._connection.sendMedia(audioBuffer);
    } catch (error) {
      getLogger().error({
        provider: 'deepgram',
        error: error.message,
      }, 'Error writing audio to Deepgram stream');
    }
  }

  endStreamingRecognition(streamHandle) {
    if (!streamHandle || streamHandle._teardownStarted) {
      return;
    }

    streamHandle._teardownStarted = true;

    if (streamHandle._keepAliveInterval) {
      clearInterval(streamHandle._keepAliveInterval);
      streamHandle._keepAliveInterval = null;
    }
    if (streamHandle._healthCheckInterval) {
      clearInterval(streamHandle._healthCheckInterval);
      streamHandle._healthCheckInterval = null;
    }

    const connection = streamHandle._connection;
    if (!connection) {
      streamHandle.destroyed = true;
      streamHandle._acceptingResults = false;
      return;
    }

    streamHandle._acceptingResults = true;

    try {
      connection.sendFinalize();
    } catch (error) {
      getLogger().warn({
        provider: 'deepgram',
        error: error.message,
      }, 'Deepgram finalize failed');
    }

    streamHandle._finalizeTimer = setTimeout(() => {
      streamHandle._finalizeTimer = null;
      streamHandle._acceptingResults = false;
      streamHandle.destroyed = true;
      try {
        connection.sendCloseStream();
      } catch {
        try {
          connection.close();
        } catch (closeError) {
          getLogger().warn({
            provider: 'deepgram',
            error: closeError.message,
          }, 'Deepgram close failed during finalize');
        }
      }
    }, FINALIZE_FLUSH_MS);
  }
}

module.exports = DeepgramStreamingProvider;
