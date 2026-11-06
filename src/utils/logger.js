const pino = require('pino');
const config = require('../config');

const isDevelopment = config.NODE_ENV === 'dev';

const logger = pino({
    level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
    formatters: {
        level: (label) => {
            return { level: label };
        },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
        env: config.NODE_ENV,
        service: 'scribe-backend',
        pid: process.pid,
    },
    transport: isDevelopment ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'SYS:standard',
            singleLine: false,
        }
    } : undefined,
});

function createRequestLogger(requestType = 'http') {
    return (context) => {
        const startTime = Date.now();
        const requestId = context.requestId || generateRequestId();
        
        return {
            requestId,
            log: logger.child({
                requestId,
                requestType,
                ...context,
            }),
            complete: (outcome) => {
                const duration = Date.now() - startTime;
                const logLevel = outcome.error ? 'error' : 'info';
                
                logger[logLevel]({
                    requestId,
                    requestType,
                    duration,
                    ...context,
                    ...outcome,
                }, `${requestType} request completed`);
            }
        };
    };
}

function generateRequestId() {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
    logger,
    createRequestLogger,
    generateRequestId,
};
