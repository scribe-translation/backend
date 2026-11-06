const { logger, generateRequestId } = require('../utils/logger');

function requestLoggerMiddleware(req, res, next) {
    const startTime = Date.now();
    const requestId = generateRequestId();
    
    req.requestId = requestId;
    req.requestLogger = logger.child({ requestId });

    const originalJson = res.json;
    const originalSend = res.send;
    
    let responseBody = null;
    let responseSent = false;

    res.json = function(body) {
        if (!responseSent) {
            responseBody = body;
            responseSent = true;
        }
        return originalJson.call(this, body);
    };

    res.send = function(body) {
        if (!responseSent) {
            responseBody = body;
            responseSent = true;
        }
        return originalSend.call(this, body);
    };

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        
        const logData = {
            requestId,
            method: req.method,
            path: req.path,
            url: req.url,
            statusCode: res.statusCode,
            duration,
            userAgent: req.headers['user-agent'],
            ip: req.ip || req.connection.remoteAddress,
            userId: req.user?.id,
            userEmail: req.user?.email,
        };

        if (res.statusCode >= 400 && responseBody) {
            try {
                const errorData = typeof responseBody === 'string' 
                    ? JSON.parse(responseBody) 
                    : responseBody;
                if (errorData.error) {
                    logData.error = errorData.error;
                }
                if (errorData.message) {
                    logData.errorMessage = errorData.message;
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        logger[logLevel](logData, 'HTTP request completed');
    });

    next();
}

module.exports = requestLoggerMiddleware;
