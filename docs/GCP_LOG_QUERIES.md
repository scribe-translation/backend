# GCP Cloud Logging - Useful Queries for Scribe

Now that all logs are structured JSON, here are the most useful queries for GCP Cloud Logging.

## Quick Access

1. Go to [GCP Cloud Logging](https://console.cloud.google.com/logs)
2. Select your project
3. Use the **Query Builder** (not the basic search)
4. Copy/paste queries below

## Essential Queries

### 1. Hide Debug Noise (Most Important!)

Show only important logs (info, warn, error):

```
jsonPayload.level="info" OR jsonPayload.level="warn" OR jsonPayload.level="error"
```

Or to see ONLY errors and warnings:

```
jsonPayload.level="warn" OR jsonPayload.level="error"
```

### 2. See All Errors

```
jsonPayload.level="error"
```

### 3. See Errors for a Specific User

```
jsonPayload.level="error" AND jsonPayload.userId="USER_ID_HERE"
```

Or by email:

```
jsonPayload.level="error" AND jsonPayload.userEmail="user@example.com"
```

### 4. See Socket Connection Issues

```
jsonPayload.msg=~"disconnected|Disconnect|connection.*failed|timeout"
```

### 5. See Translation Activity

```
jsonPayload.msg=~"[Tt]ranslation" AND jsonPayload.level!="debug"
```

### 6. See Slow Requests (>1 second)

```
jsonPayload.duration>1000
```

### 7. See Stream Issues (Deepgram/Google)

```
jsonPayload.provider!="" AND (jsonPayload.level="error" OR jsonPayload.level="warn")
```

### 8. See Activity for a Specific Session

```
jsonPayload.sessionCode="SESSION_CODE_HERE"
```

### 9. See HTTP Request Errors

```
jsonPayload.statusCode>=400
```

### 10. See Recent Activity (Last 1 Hour)

```
timestamp>"2024-11-06T10:00:00Z"
```

(Replace with your desired timestamp)

## Advanced Queries

### Find Translation Failures

```
jsonPayload.msg=~"[Tt]ranslation.*failed" OR (jsonPayload.msg=~"[Tt]ranslation" AND jsonPayload.error!="")
```

### Find Stream Restarts

```
jsonPayload.msg=~"restart|Restart|rotation"
```

### Find Balance/Billing Issues

```
jsonPayload.msg=~"balance|Balance|billing|Billing|depleted"
```

### Find All Activity for a User (Last 24 Hours)

```
jsonPayload.userId="USER_ID_HERE"
timestamp>="2024-11-06T00:00:00Z"
```

### Find High Error Rate Connections

```
jsonPayload.errorRate>10
```

## Combining Queries

Use `AND` and `OR` to combine conditions:

```
jsonPayload.level="error" 
AND jsonPayload.userId="user123" 
AND timestamp>"2024-11-06T10:00:00Z"
```

```
(jsonPayload.provider="deepgram" OR jsonPayload.provider="google") 
AND jsonPayload.level="error"
```

## Creating Saved Queries

1. Build your query in the Query Builder
2. Click **"⋮"** (three dots) → **"Save query"**
3. Give it a name like "Errors - Last Hour" or "User Activity"
4. Access it from the left sidebar under "Saved queries"

## Recommended Saved Queries

Create these for quick access:

1. **"Errors Only"**
   ```
   jsonPayload.level="error"
   ```

2. **"Important Logs"**
   ```
   jsonPayload.level="info" OR jsonPayload.level="warn" OR jsonPayload.level="error"
   ```

3. **"Socket Issues"**
   ```
   jsonPayload.socketId!="" AND (jsonPayload.level="error" OR jsonPayload.level="warn")
   ```

4. **"Translation Errors"**
   ```
   jsonPayload.msg=~"[Tt]ranslation" AND jsonPayload.level="error"
   ```

5. **"Slow Requests"**
   ```
   jsonPayload.duration>1000
   ```

## Creating Alerts

1. Build a query (e.g., for errors)
2. Click **"Create metric"** → **"Counter"**
3. Add filters for the specific condition
4. Go to **Monitoring** → **Alerting** → **Create Policy**
5. Select your log-based metric
6. Set threshold (e.g., alert if >10 errors in 5 minutes)

## Log-Based Metrics for Dashboards

Create these metrics for visualization:

### 1. Error Rate
- **Type:** Counter
- **Query:** `jsonPayload.level="error"`
- **Use:** Track error trends over time

### 2. Request Duration
- **Type:** Distribution
- **Query:** `jsonPayload.duration>0`
- **Field:** `jsonPayload.duration`
- **Use:** Create latency percentile charts

### 3. Active Users
- **Type:** Counter
- **Query:** `jsonPayload.userId!=""`
- **Labels:** `userId`
- **Use:** Track active user count

## Excluding Noise

If you want to exclude health checks or specific messages:

```
jsonPayload.msg!~"health|Health|ping|Ping"
```

Or exclude specific log levels:

```
NOT jsonPayload.level="debug"
```

## Field Reference

Here are the structured fields now available in logs:

**Request Context:**
- `jsonPayload.requestId` - Unique request identifier
- `jsonPayload.method` - HTTP method (GET, POST, etc.)
- `jsonPayload.path` - Request path
- `jsonPayload.statusCode` - HTTP status code
- `jsonPayload.duration` - Request duration in milliseconds

**Socket Context:**
- `jsonPayload.socketId` - Socket connection ID
- `jsonPayload.sessionCode` - Session code
- `jsonPayload.isStreaming` - Whether socket is streaming

**User Context:**
- `jsonPayload.userId` - User ID
- `jsonPayload.userEmail` - User email

**Provider Context (STT):**
- `jsonPayload.provider` - "deepgram" or "google"
- `jsonPayload.languageCode` - Language being processed
- `jsonPayload.model` - Model being used

**Translation:**
- `jsonPayload.sourceLanguage` - Source language
- `jsonPayload.targetLanguage` - Target language
- `jsonPayload.transcriptLength` - Length of text
- `jsonPayload.languageCount` - Number of target languages

**Common:**
- `jsonPayload.level` - Log level (error, warn, info, debug)
- `jsonPayload.msg` - Log message
- `jsonPayload.error` - Error message (when present)
- `jsonPayload.duration` - Operation duration

## Tips

1. **Use the Query Builder**, not the basic search box
2. **Save frequently-used queries** for quick access
3. **Create log-based metrics** for dashboards and alerting
4. **Use regex** with `=~` for pattern matching
5. **Filter by timestamp** to narrow down time windows
6. **Exclude debug logs** to reduce noise: `NOT jsonPayload.level="debug"`

## Example Workflow

1. Start with: `jsonPayload.level="error"` to see all errors
2. If too many, add context: `jsonPayload.userId="user123"`
3. Narrow time window: `timestamp>"2024-11-06T10:00:00Z"`
4. Save the query for future use
5. Create an alert if this is something to monitor

## Still Too Noisy?

If GCP Cloud Logging is still difficult, consider the local log viewer or Better Stack:

- **Local viewer:** `npm run logs` (instant, beautiful)
- **Better Stack:** [betterstack.com/logs](https://betterstack.com/logs) (5-minute setup, modern UI)

See [LOG_VIEWING.md](LOG_VIEWING.md) for complete alternatives.
