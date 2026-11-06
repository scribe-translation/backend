const pino = require('pino');
const config = require('../config');
const fs = require('fs');
const path = require('path');

const isDevelopment = config.NODE_ENV === 'dev';

// Ensure logs directory exists in production
if (!isDevelopment) {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
}

const getTransport = () => {
    if (isDevelopment) {
        return {
            target: 'pino-pretty',
            options: {
                colorize: true,
                ignore: 'pid,hostname',
                translateTime: 'SYS:standard',
                singleLine: false,
            }
        };
    }
    
    // Production: write to both stdout (for GCP) and file (for easy downloading)
    if (process.env.LOG_TO_FILE === 'true') {
        return {
            targets: [
                {
                    target: 'pino/file',
                    options: {
                        destination: path.join(process.cwd(), 'logs', 'app.log'),
                    },
                    level: 'info',
                },
                {
                    target: 'pino/file',
                    options: {
                        destination: 1, // stdout for GCP Cloud Logging
                    },
                    level: 'info',
                }
            ]
        };
    }
    
    return undefined;
};

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
    transport: getTransport(),
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
