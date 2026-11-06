# Logging System

## Overview

Scribe uses [Pino](https://getpino.io/) for structured, high-performance logging. The logging system provides:

- **Structured logs**: JSON format with rich contextual data
- **Request lifecycle tracking**: Complete request/response tracking with duration and outcomes
- **Socket event logging**: WebSocket connection and event lifecycle tracking
- **No emojis**: Professional, machine-readable logs
- **Wide logs**: Each log entry contains comprehensive contextual information

## Log Format

### Development
In development mode, logs are pretty-printed with colors for human readability:

```
[2024-01-15 10:30:15.123] INFO (12345): HTTP request completed
    requestId: "req-1705316415123-abc123"
    method: "POST"
    path: "/api/sessions"
    statusCode: 200
    duration: 45
    userId: "user123"
    userEmail: "user@example.com"
```

### Production
In production, logs are in JSON format for parsing by log aggregation tools:

```json
{
  "level": "info",
  "time": "2024-01-15T14:30:15.123Z",
  "pid": 12345,
  "env": "prod",
  "service": "scribe-backend",
  "requestId": "req-1705316415123-abc123",
  "method": "POST",
  "path": "/api/sessions",
  "statusCode": 200,
  "duration": 45,
  "userId": "user123",
  "userEmail": "user@example.com",
  "msg": "HTTP request completed"
}
```

## Usage

### Basic Logging

```javascript
const { logger } = require('./src/utils/logger');

// Info log
logger.info({ userId: '123', action: 'login' }, 'User logged in');

// Error log
logger.error({ 
  error: err.message, 
  stack: err.stack,
  userId: '123' 
}, 'Failed to process request');

// Debug log (only shown when LOG_LEVEL=debug)
logger.debug({ socketId: 'abc123' }, 'Processing audio chunk');

// Warn log
logger.warn({ userId: '123' }, 'User attempted unauthorized action');
```

### HTTP Request Logging

HTTP requests are automatically logged by the request logger middleware:

```javascript
// Automatically logged:
// - Request ID (generated per request)
// - Method, path, URL
// - Response status code
// - Duration in milliseconds
// - User information (if authenticated)
// - Error details (for 4xx/5xx responses)
```

### Socket Event Logging

Socket events can be logged using the socket event logger:

```javascript
socket.on('someEvent', async (data) => {
  const eventId = socket.eventLogger.startEvent('someEvent', { 
    dataSize: data.length 
  });
  
  try {
    // Process event...
    
    socket.eventLogger.completeEvent(eventId, { 
      success: true,
      processedItems: 10 
    });
  } catch (error) {
    socket.eventLogger.completeEvent(eventId, { 
      error: error.message,
      success: false 
    });
  }
});
```

### Connection Lifecycle Logging

```javascript
// Log connection phases
socket.eventLogger.logConnectionLifecycle('connected', {
  totalConnections: activeConnections.size
});

socket.eventLogger.logConnectionLifecycle('disconnected', {
  connectionAge: 3600,
  messageCount: 150
});
```

### Stream Lifecycle Logging

```javascript
socket.eventLogger.logStreamLifecycle('started', {
  sourceLanguage: 'en-US',
  provider: 'google'
});

socket.eventLogger.logStreamLifecycle('rotated', {
  flushedChunks: 25,
  duration: 180000
});
```

## Log Levels

Set the `LOG_LEVEL` environment variable to control verbosity:

- `error`: Only errors
- `warn`: Warnings and errors
- `info`: General information (default in production)
- `debug`: Detailed debugging information (default in development)
- `trace`: Very detailed tracing information

```bash
LOG_LEVEL=debug npm start
```

## Request Tracking

Every HTTP request gets a unique `requestId` that can be used to trace the request through logs:

```javascript
// In route handlers, access via req.requestId
app.get('/api/data', (req, res) => {
  req.requestLogger.info({ action: 'fetching' }, 'Fetching data');
  // ... handle request
});
```

## Socket Event Tracking

Socket connections and events are tracked with:
- `socketId`: Unique socket connection identifier
- `userId`: User ID (if authenticated)
- `sessionCode`: Session code for the connection
- `eventId`: Unique identifier for each socket event

## Best Practices

### 1. Include Context
Always include relevant context in log entries:

```javascript
// Good
logger.info({ 
  userId: user.id, 
  sessionCode: session.code,
  duration: Date.now() - startTime 
}, 'Session created');

// Bad
logger.info('Session created');
```

### 2. Log Outcomes, Not Progress
Focus on logging the outcome of operations:

```javascript
// Good
logger.info({ 
  userId: '123', 
  sessionId: 'abc',
  duration: 45 
}, 'Session processing completed');

// Avoid excessive progress logs
logger.debug('Starting session processing...');
logger.debug('Validating session...');
logger.debug('Saving session...');
logger.debug('Session saved');
```

### 3. Use Appropriate Log Levels
- `error`: Actual errors that need attention
- `warn`: Unexpected but handled situations
- `info`: Normal operations and outcomes
- `debug`: Detailed information for troubleshooting

### 4. Log Errors Completely
Include full error context:

```javascript
try {
  // ... operation
} catch (error) {
  logger.error({
    error: error.message,
    stack: error.stack,
    userId: user.id,
    operation: 'saveSession'
  }, 'Operation failed');
}
```

### 5. One Log Per Request/Operation
Rather than multiple logs, prefer a single comprehensive log entry:

```javascript
// Good - single log with complete context
logger.info({
  requestId: 'req-123',
  method: 'POST',
  path: '/api/translate',
  statusCode: 200,
  duration: 150,
  sourceLanguage: 'en-US',
  targetLanguage: 'fr-FR',
  textLength: 500,
  translatedLength: 485
}, 'Translation request completed');
```

## Querying Logs

### Find all errors for a user
```bash
cat logs.json | grep '"userId":"user123"' | grep '"level":"error"'
```

### Find slow requests (>1000ms)
```bash
cat logs.json | jq 'select(.duration > 1000)'
```

### Track a specific request
```bash
cat logs.json | grep '"requestId":"req-1705316415123-abc123"'
```

### Count requests by status code
```bash
cat logs.json | jq -r '.statusCode' | sort | uniq -c
```

## Integration with Log Aggregation

The structured JSON logs can be easily integrated with:
- **Elasticsearch + Kibana**: Parse JSON logs for visualization
- **Datadog**: Forward logs via agent
- **Splunk**: Index JSON logs
- **CloudWatch Logs**: Use JSON format for structured queries
- **Grafana Loki**: Query structured logs efficiently

Example Datadog query:
```
service:scribe-backend @userId:user123 @level:error
```

Example CloudWatch Insights query:
```
fields @timestamp, requestId, duration, statusCode
| filter userId = "user123"
| filter statusCode >= 500
| sort duration desc
```
