const { logger, generateRequestId } = require('../utils/logger');

class SocketEventLogger {
    constructor(socket) {
        this.socket = socket;
        this.activeEvents = new Map();
    }

    startEvent(eventName, eventData = {}) {
        const eventId = generateRequestId();
        const startTime = Date.now();
        
        this.activeEvents.set(eventId, {
            eventName,
            startTime,
            eventData,
        });

        const connection = this.socket.connection || {};
        
        logger.debug({
            eventId,
            eventName,
            socketId: this.socket.id,
            userId: this.socket.user?.id,
            userEmail: this.socket.user?.email,
            sessionCode: this.socket.sessionCode,
            isStreaming: connection.isStreaming,
            sourceLanguage: connection.sourceLanguage,
            targetLanguage: connection.targetLanguage,
            ...eventData,
        }, `Socket event started: ${eventName}`);

        return eventId;
    }

    completeEvent(eventId, outcome = {}) {
        const event = this.activeEvents.get(eventId);
        if (!event) {
            logger.warn({ eventId }, 'Attempted to complete unknown event');
            return;
        }

        const duration = Date.now() - event.startTime;
        const connection = this.socket.connection || {};
        const logLevel = outcome.error ? 'error' : 'info';

        logger[logLevel]({
            eventId,
            eventName: event.eventName,
            socketId: this.socket.id,
            userId: this.socket.user?.id,
            userEmail: this.socket.user?.email,
            sessionCode: this.socket.sessionCode,
            duration,
            isStreaming: connection.isStreaming,
            sourceLanguage: connection.sourceLanguage,
            targetLanguage: connection.targetLanguage,
            ...event.eventData,
            ...outcome,
        }, `Socket event completed: ${event.eventName}`);

        this.activeEvents.delete(eventId);
    }

    logConnectionLifecycle(phase, data = {}) {
        const connection = this.socket.connection || {};
        
        logger.info({
            phase,
            socketId: this.socket.id,
            userId: this.socket.user?.id,
            userEmail: this.socket.user?.email,
            sessionCode: this.socket.sessionCode,
            isStreaming: connection.isStreaming,
            sourceLanguage: connection.sourceLanguage,
            targetLanguage: connection.targetLanguage,
            connectionAge: connection.connectedAt 
                ? Math.round((Date.now() - connection.connectedAt) / 1000) 
                : null,
            ...data,
        }, `Socket connection lifecycle: ${phase}`);
    }

    logStreamLifecycle(phase, data = {}) {
        const connection = this.socket.connection || {};
        
        logger.info({
            phase,
            socketId: this.socket.id,
            userId: this.socket.user?.id,
            userEmail: this.socket.user?.email,
            sessionCode: this.socket.sessionCode,
            sourceLanguage: connection.sourceLanguage,
            speechEndTimeout: connection.speechEndTimeout,
            streamAge: connection.streamStartTime 
                ? Math.round((Date.now() - connection.streamStartTime) / 1000) 
                : null,
            ...data,
        }, `Stream lifecycle: ${phase}`);
    }

    logTranscription(data) {
        logger.info({
            socketId: this.socket.id,
            userId: this.socket.user?.id,
            sessionCode: this.socket.sessionCode,
            ...data,
        }, 'Transcription processed');
    }

    logTranslation(data) {
        logger.info({
            socketId: this.socket.id,
            sessionCode: this.socket.sessionCode,
            ...data,
        }, 'Translation delivered');
    }
}

function attachSocketLogger(socket, connection) {
    const eventLogger = new SocketEventLogger(socket);
    socket.eventLogger = eventLogger;
    socket.connection = connection;
    return eventLogger;
}

module.exports = {
    SocketEventLogger,
    attachSocketLogger,
};
