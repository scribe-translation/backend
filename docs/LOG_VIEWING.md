# Log Viewing Guide

Since GCP Cloud Logging can be difficult to navigate, here are better options for viewing your Scribe logs.

## Quick Reference

| Method | Best For | Setup Time | Cost |
|--------|----------|------------|------|
| [Local Log Viewer](#1-local-log-viewer-simplest) | Development, Quick debugging | 1 min | Free |
| [Better Stack](#2-better-stack-recommended) | Production, Modern UI | 5 min | Free tier available |
| [jq + grep](#3-command-line-jq--grep) | Quick queries, Scripts | 0 min | Free |
| [Grafana Loki](#4-grafana-loki-self-hosted) | Self-hosted, Full control | 30 min | Infrastructure only |
| [Datadog](#5-datadog-enterprise) | Enterprise, Full observability | 15 min | Paid |

---

## 1. Local Log Viewer (Simplest) ⭐

### Setup

Enable file logging in production:
```bash
# In your environment variables
LOG_TO_FILE=true
```

This writes logs to `logs/app.log` in addition to stdout.

### View Logs

```bash
# View all logs (colored, formatted)
npm run logs

# Follow logs in real-time
npm run logs:follow

# View only errors
npm run logs:errors

# Or use the script directly
node scripts/view-logs.js logs/app.log
node scripts/view-logs.js logs/app.log -f  # follow mode
```

### Download Logs from Production

If running on Cloud Run:
```bash
# SSH into your instance or use Cloud Shell
gcloud run services proxy YOUR_SERVICE_NAME --port=8080

# In another terminal, copy the log file
gcloud compute scp YOUR_INSTANCE:~/app/logs/app.log ./production.log

# View locally
node scripts/view-logs.js production.log
```

---

## 2. Better Stack (Recommended) ⭐⭐⭐

Modern, beautiful log viewer designed for structured JSON logs.

### Setup (5 minutes)

1. Sign up at [betterstack.com/logs](https://betterstack.com/logs)
2. Create a source and get your token
3. Install the integration:

```bash
npm install @logtail/pino
```

4. Update `src/utils/logger.js`:

```javascript
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
    
    // Use Better Stack in production
    if (process.env.BETTERSTACK_SOURCE_TOKEN) {
        return {
            target: '@logtail/pino',
            options: {
                sourceToken: process.env.BETTERSTACK_SOURCE_TOKEN,
            },
        };
    }
    
    return undefined;
};
```

5. Add environment variable:
```bash
BETTERSTACK_SOURCE_TOKEN=your_token_here
```

### Features
- 🎨 Beautiful, modern UI
- 🔍 Powerful search and filtering
- 📊 Live tail
- 📈 Log analytics
- 🔔 Alerting
- 💾 1-month retention (free tier)
- 🆓 1GB/month free

### Usage

Navigate to your Better Stack dashboard and use their query language:

```
# Find errors for a specific user
level:error userId:user123

# Find slow requests
duration:>1000

# Find socket disconnections
msg:"Socket disconnected" connectionAge:>300

# Combine filters
level:error AND userId:user123 AND @timestamp:>now-1h
```

---

## 3. Command Line (jq + grep)

For quick queries without any setup.

### Install jq
```bash
# macOS
brew install jq

# Ubuntu/Debian
apt-get install jq

# Already have it? Check:
jq --version
```

### Common Queries

```bash
# Pretty print all logs
cat logs/app.log | jq '.'

# Find all errors
cat logs/app.log | jq 'select(.level == "error")'

# Find errors for a specific user
cat logs/app.log | jq 'select(.level == "error" and .userId == "user123")'

# Find slow requests (>1000ms)
cat logs/app.log | jq 'select(.duration > 1000)'

# Count requests by status code
cat logs/app.log | jq -r '.statusCode' | sort | uniq -c

# Find all logs for a specific request
cat logs/app.log | jq 'select(.requestId == "req-123")'

# Get last 10 errors
cat logs/app.log | jq 'select(.level == "error")' | tail -10

# Live tail with filtering
tail -f logs/app.log | jq 'select(.level == "error")'

# Extract specific fields
cat logs/app.log | jq '{time, level, msg, userId, duration}'

# Calculate average request duration
cat logs/app.log | jq -s 'map(select(.duration)) | add / length'

# Find all socket disconnections with high error rates
cat logs/app.log | jq 'select(.msg == "Connection quality metrics before cleanup" and .errorRate > 10)'

# Group by user and count
cat logs/app.log | jq -r '.userEmail' | sort | uniq -c | sort -rn
```

---

## 4. Grafana Loki (Self-Hosted)

Free, self-hosted log aggregation system by Grafana Labs.

### Docker Compose Setup

Create `docker-compose.loki.yml`:

```yaml
version: "3"

services:
  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    volumes:
      - loki-data:/loki

  promtail:
    image: grafana/promtail:latest
    volumes:
      - /var/log:/var/log
      - ./logs:/app/logs
      - ./promtail-config.yml:/etc/promtail/config.yml
    command: -config.file=/etc/promtail/config.yml

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  loki-data:
  grafana-data:
```

Create `promtail-config.yml`:

```yaml
server:
  http_listen_port: 9080

positions:
  filename: /tmp/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: scribe
    static_configs:
      - targets:
          - localhost
        labels:
          job: scribe-backend
          __path__: /app/logs/*.log
    pipeline_stages:
      - json:
          expressions:
            level: level
            msg: msg
            userId: userId
            requestId: requestId
      - labels:
          level:
          userId:
```

### Start
```bash
docker-compose -f docker-compose.loki.yml up -d
```

### Access
Open http://localhost:3000 and add Loki as a data source (http://loki:3100).

### Query Examples (LogQL)
```
# All logs
{job="scribe-backend"}

# Only errors
{job="scribe-backend"} | json | level="error"

# Specific user
{job="scribe-backend"} | json | userId="user123"

# Rate of errors
rate({job="scribe-backend"} | json | level="error" [5m])

# Slow requests
{job="scribe-backend"} | json | duration > 1000
```

---

## 5. Datadog (Enterprise)

Full observability platform with logs, metrics, traces, and more.

### Setup

1. Sign up at [datadoghq.com](https://www.datadoghq.com/)
2. Get your API key
3. Install:

```bash
npm install pino-datadog-logger
```

4. Update logger:

```javascript
const getTransport = () => {
    if (isDevelopment) {
        return {
            target: 'pino-pretty',
            // ...
        };
    }
    
    if (process.env.DATADOG_API_KEY) {
        return {
            target: 'pino-datadog-logger',
            options: {
                apiKey: process.env.DATADOG_API_KEY,
                service: 'scribe-backend',
                ddsource: 'nodejs',
                ddtags: `env:${process.env.NODE_ENV}`,
            },
        };
    }
    
    return undefined;
};
```

### Features
- Full APM with distributed tracing
- Real-time log correlation with metrics
- Machine learning anomaly detection
- Advanced alerting
- Retention up to 15 months

### Query Examples
```
service:scribe-backend status:error @userId:user123
service:scribe-backend @duration:>1000
service:scribe-backend "Socket disconnected" @connectionAge:>300
```

---

## 6. Improving GCP Cloud Logging

If you must use GCP, here are tips to make it better:

### Use Log Explorer with Structured Queries

Instead of the basic search, use the query builder:

```
resource.type="cloud_run_revision"
jsonPayload.level="error"
jsonPayload.userId="user123"
```

### Create Saved Views

1. Go to Logs Explorer
2. Build your query
3. Click "Save query" → "Save as saved query"
4. Access from the left sidebar

### Common GCP Queries

```
# All errors
jsonPayload.level="error"

# Specific user's logs
jsonPayload.userId="user123"

# Slow requests
jsonPayload.duration>1000

# Socket events
jsonPayload.socketId!=""

# Errors in last hour
jsonPayload.level="error"
timestamp>="2024-01-15T10:00:00Z"

# Combine conditions
jsonPayload.level="error" AND jsonPayload.userId="user123"
```

### Create Log-Based Metrics

1. Go to Logs Explorer
2. Build query
3. Click "Create metric"
4. Use for dashboards and alerting

---

## Recommendation

**For most users**: Start with the **Local Log Viewer** for development and **Better Stack** for production. It's the best balance of ease of use, features, and cost.

**For enterprise**: Use **Datadog** if you need full observability with APM and metrics.

**For self-hosted**: Use **Grafana Loki** if you want full control and no vendor lock-in.

**For quick debugging**: Use **jq + grep** - it's always available and powerful.
