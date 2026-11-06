const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const crypto = require('crypto')
const path = require('path')
require('dotenv').config()
const config = require('./src/config')
const { logger } = require('./src/utils/logger')
const requestLoggerMiddleware = require('./src/middleware/requestLogger')
const { attachSocketLogger } = require('./src/middleware/socketLogger')
const { authenticateSocket, authenticateToken, requireAdmin } = require('./src/middleware/auth')
const authRoutes = require('./src/routes/auth')
const adminRoutes = require('./src/routes/admin')
const billingRoutes = require('./src/routes/billing')
const { fulfillCheckoutSession } = require('./src/routes/billing')
const { registerActiveConnections } = require('./src/services/connectionRegistry')
const User = require('./src/models/User')
const Session = require('./src/models/Session')
const AppSettings = require('./src/models/AppSettings')
const { initFirestore } = require('./src/database/firestore')
const speechToTextService = require('./src/services/speechToTextService')
const googleTranslationService = require('./src/services/googleTranslationService')
const textToSpeechService = require('./src/services/textToSpeechService')
const aiService = require('./src/services/aiService')
const { isSameLanguage } = require('./src/utils/languageCodeMapper')
const { shouldTranslateInterim } = require('./src/services/interimTranslationThrottle')
const { startMetering, reconcileMetering, stopMetering } = require('./src/services/balanceMeter')
const stripeService = require('./src/services/stripeService')
const app = express()
const server = http.createServer(app)

const corsOrigins = config.CORS_ORIGIN.split(',').map(origin => origin.trim())
const isDevEnvironment = config.NODE_ENV === 'dev'

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) {
            callback(null, true)
            return
        }
        if (isDevEnvironment) {
            const devOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|[^.]+\.localhost)(:\d+)?$/
            if (devOriginPattern.test(origin)) {
                callback(null, true)
                return
            }
        }
        if (corsOrigins.includes(origin)) {
            callback(null, true)
            return
        }
        callback(new Error(`Not allowed by CORS: ${origin}`))
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
}))

const io = socketIo(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 200
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
})

io.use(authenticateSocket)

// Stripe webhooks need the raw body for signature verification
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['stripe-signature']
    const startTime = Date.now()
    
    try {
        if (!stripeService.isStripeConfigured()) {
            logger.warn({ path: '/billing/webhook' }, 'Stripe webhook received but Stripe not configured')
            return res.status(503).send('Stripe not configured')
        }
        const event = stripeService.constructWebhookEvent(req.body, signature)

        if (
            event.type === 'checkout.session.completed' ||
            event.type === 'checkout.session.async_payment_succeeded'
        ) {
            const session = event.data.object
            const result = await fulfillCheckoutSession(session)
            logger.info({
                eventType: event.type,
                sessionId: session.id,
                result,
                duration: Date.now() - startTime,
            }, 'Stripe checkout session fulfilled')
        } else if (event.type === 'checkout.session.async_payment_failed') {
            logger.warn({
                eventType: event.type,
                sessionId: event.data.object?.id,
            }, 'Stripe async payment failed')
        }

        res.json({ received: true })
    } catch (err) {
        logger.error({
            error: err.message,
            stack: err.stack,
            path: '/billing/webhook',
            duration: Date.now() - startTime,
        }, 'Stripe webhook error')
        res.status(400).send(`Webhook Error: ${err.message}`)
    }
})

app.use(express.json({ limit: '50mb' }))
app.use(requestLoggerMiddleware)
app.use(express.static(path.join(__dirname, 'public')))

app.use('/auth', authRoutes)
app.use('/admin', authenticateToken, requireAdmin, adminRoutes)
app.use('/billing', authenticateToken, billingRoutes)

const activeConnections = new Map()
registerActiveConnections(activeConnections)
let audioChunkCounter = 0
const streamingSessions = new Map() // Track streaming sessions per socket
const sessionTranscripts = new Map() // Accumulate transcripts for the current session per socket
const processedTranscripts = new Map() // Track processed transcripts to prevent duplicates
const restartingStreams = new Map() // Track sockets that are currently restarting their stream
const audioBufferDuringRestart = new Map() // Buffer audio during stream restart
const currentBubbleIds = new Map() // Track current bubbleId per socket (updated by incoming audio)
const contentHashes = new Map() // Track content hashes for deduplication
const typingIndicatorTimeouts = new Map() // Track typing indicator timeouts per socket
const lastInterimBySocket = new Map() // Last interim transcript per socket (force-finalize fallback)
const forceFinalizeSafetyTimers = new Map() // Safety timers for force-finalize ack
const rotatingStreams = new Map() // Prevent concurrent stream rotations per socket
let __dbgAudioCount = 0

const interimTranslationThrottle = new Map()

async function endStreamingForBalance(socket, connection, reason = 'balance_depleted') {
    if (!connection) return
    connection.isStreaming = false

    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
        speechToTextService.endStreamingRecognition(recognizeStream)
        streamingSessions.delete(socket.id)
    }
    cleanupSocketStreamState(socket.id)
    stopMetering(connection)

    socket.emit('balanceDepleted', {
        message: 'Your prepaid hours have run out. Purchase more hours to continue.',
        reason,
    })
    socket.emit('error', {
        message: 'Prepaid hours depleted. Purchase more hours to continue streaming.',
        code: 'BALANCE_DEPLETED',
    })
}

async function ensureStreamingAllowed(socket, connection) {
    if (!socket.user?.id || !connection) return true
    if (connection.streamStartTime) return true

    const balance = await User.getBalance(socket.user.id)
    if (!balance) return true

    if (balance.billingTier === 'complimentary') {
        connection.streamStartTime = Date.now()
        if (!connection.sessionCounted) {
            connection.sessionCounted = true
            User.incrementSessionCount(socket.user.id).catch(() => { })
        }
        await startMetering(connection, socket, {
            onLowBalance: () => {},
            onDepleted: async () => {},
        })
        return true
    }

    if (balance.balanceSeconds <= 0) {
        socket.emit('balanceDepleted', {
            message: 'Your prepaid hours have run out. Purchase more hours to continue.',
            reason: 'no_balance',
            balanceSeconds: 0,
        })
        return false
    }

    connection.streamStartTime = Date.now()
    if (!connection.sessionCounted) {
        connection.sessionCounted = true
        User.incrementSessionCount(socket.user.id).catch(() => { })
    }

    await startMetering(connection, socket, {
        onLowBalance: (balanceSeconds, threshold) => {
            socket.emit('balanceWarning', { balanceSeconds, thresholdSeconds: threshold })
        },
        onDepleted: async () => {
            await endStreamingForBalance(socket, connection)
        },
    })
    return true
}

async function finishStreamingUsage(socket, connection) {
    if (!connection) return
    await reconcileMetering(connection, socket)
    if (connection.streamStartTime && socket.user?.id) {
        const usageMinutes = (Date.now() - connection.streamStartTime) / 60000
        if (usageMinutes >= 0.1) {
            User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => { })
        }
        connection.streamStartTime = null
    }
    stopMetering(connection)
}

// ============================================================================
// CONTENT HASH DEDUPLICATION - Prevents duplicates from overlapping streams
// ============================================================================

const CONTENT_HASH_EXPIRY = 10000; // 10 seconds
const MAX_CONTENT_HASHES = 100; // Keep last 100 hashes per socket

function generateContentHash(text) {
    return crypto.createHash('md5').update(text.trim().toLowerCase()).digest('hex');
}

function isDuplicateContent(socketId, text) {
    const hash = generateContentHash(text);
    const socketHashes = contentHashes.get(socketId) || [];
    const now = Date.now();

    // Check if this hash was seen recently
    for (const entry of socketHashes) {
        if (entry.hash === hash && (now - entry.timestamp) < CONTENT_HASH_EXPIRY) {
            return true;
        }
    }

    return false;
}

function recordContentHash(socketId, text) {
    const hash = generateContentHash(text);
    const now = Date.now();

    let socketHashes = contentHashes.get(socketId) || [];

    // Add new hash
    socketHashes.push({ hash, timestamp: now, text: text.substring(0, 50) });

    // Remove expired hashes
    socketHashes = socketHashes.filter(entry => (now - entry.timestamp) < CONTENT_HASH_EXPIRY);

    // Limit to last MAX_CONTENT_HASHES
    if (socketHashes.length > MAX_CONTENT_HASHES) {
        socketHashes = socketHashes.slice(-MAX_CONTENT_HASHES);
    }

    contentHashes.set(socketId, socketHashes);
}

function cleanupContentHashes(socketId) {
    contentHashes.delete(socketId);
}

function isDuplicateFinal(socketId, bubbleId, transcript) {
    const trimmed = (transcript || '').trim();
    if (!trimmed) {
        return true;
    }

    const contentHash = generateContentHash(trimmed);
    const dedupeKey = bubbleId
        ? `${socketId}:${bubbleId}:${contentHash}`
        : `${socketId}:text:${contentHash}`;

    const processedAt = processedTranscripts.get(dedupeKey);
    return !!(processedAt && (Date.now() - processedAt) < CONTENT_HASH_EXPIRY);
}

function recordProcessedFinal(socketId, bubbleId, transcript) {
    const trimmed = (transcript || '').trim();
    if (!trimmed) {
        return;
    }

    const contentHash = generateContentHash(trimmed);
    const dedupeKey = bubbleId
        ? `${socketId}:${bubbleId}:${contentHash}`
        : `${socketId}:text:${contentHash}`;

    processedTranscripts.set(dedupeKey, Date.now());
}

function getSessionConnectionIds(sessionCode) {
    return Array.from(activeConnections.entries())
        .filter(([_, conn]) => conn.sessionCode === sessionCode)
        .map(([socketId, _]) => socketId);
}

function getTranslationConnectionIds(sessionCode) {
    return getSessionConnectionIds(sessionCode).filter((socketId) => {
        const conn = activeConnections.get(socketId);
        return conn && !conn.isStreaming && conn.targetLanguage;
    });
}

function getListenersByLanguage(sessionCode) {
    const listenersByLanguage = new Map();

    getTranslationConnectionIds(sessionCode).forEach((socketId) => {
        const conn = activeConnections.get(socketId);
        if (conn?.targetLanguage) {
            if (!listenersByLanguage.has(conn.targetLanguage)) {
                listenersByLanguage.set(conn.targetLanguage, []);
            }
            listenersByLanguage.get(conn.targetLanguage).push(socketId);
        }
    });

    return listenersByLanguage;
}

async function processFinalTranscript({ socket, transcript, sourceLanguage, bubbleId, origin }) {
    const trimmed = (transcript || '').trim();
    if (!trimmed) {
        return { processed: false, reason: 'empty' };
    }

    if (isDuplicateFinal(socket.id, bubbleId, trimmed)) {
        logger.debug({
            socketId: socket.id,
            bubbleId: bubbleId || 'none',
            origin,
            reason: 'duplicate',
        }, 'Skipping duplicate final transcript')
        return { processed: false, reason: 'duplicate' };
    }

    // Always buffer for storage before any sessionCode check — missing sessionCode
    // must not prevent history saves, and must not mark the phrase as processed first.
    // Join bubbles with newlines so history/PDF stay readable as one phrase per line.
    const currentText = sessionTranscripts.get(socket.id) || '';
    sessionTranscripts.set(socket.id, currentText + (currentText ? '\n- ' : '') + trimmed);
    recordProcessedFinal(socket.id, bubbleId, trimmed);

    const currentConnection = activeConnections.get(socket.id);
    if (!currentConnection?.sessionCode) {
        logger.warn({
            socketId: socket.id,
            hasTranscript: !!trimmed,
            transcriptLength: trimmed.length,
        }, 'Buffered final transcript without sessionCode - storage only, no broadcast')
        return { processed: true, languages: 0, broadcast: false };
    }

    const sessionCode = currentConnection.sessionCode;
    const sessionCodeConnections = getSessionConnectionIds(sessionCode);
    const listenersByLanguage = getListenersByLanguage(sessionCode);

    logger.info({
        origin,
        socketId: socket.id,
        sessionCode,
        transcriptLength: trimmed.length,
        transcriptPreview: trimmed.substring(0, 50),
        languageCount: listenersByLanguage.size,
        bubbleId,
    }, 'Final transcript processed')

    if (listenersByLanguage.size === 0) {
        const sessionConnections = getSessionConnectionIds(sessionCode).map((socketId) => {
            const conn = activeConnections.get(socketId);
            return {
                socketId,
                isStreaming: !!conn?.isStreaming,
                targetLanguage: conn?.targetLanguage || null
            };
        });
        logger.warn({
            sessionCode,
            sessionConnections,
            connectionCount: sessionConnections.length,
        }, 'No listeners found for session')
    }

    sessionCodeConnections.forEach((socketId) => {
        const targetSocket = io.sockets.sockets.get(socketId);
        const conn = activeConnections.get(socketId);
        if (targetSocket && conn?.userId) {
            targetSocket.emit('transcriptionComplete', {
                transcription: trimmed,
                sourceLanguage,
                bubbleId,
                userId: currentConnection.userId,
                userEmail: currentConnection.userEmail
            });
        }
    });

    if (listenersByLanguage.size > 0) {
        try {
            for (const [targetLanguage, listenerSocketIds] of listenersByLanguage) {
                const translatedText = await processTranscription(trimmed, sourceLanguage, targetLanguage);

                listenerSocketIds.forEach((socketId) => {
                    const conn = activeConnections.get(socketId);
                    if (conn && messageQueue) {
                        messageQueue.queueMessage(socketId, {
                            originalText: trimmed,
                            translatedText,
                            sourceLanguage,
                            targetLanguage,
                            bubbleId,
                            userId: currentConnection.userId,
                            userEmail: currentConnection.userEmail
                        }, conn);
                    }
                });
            }
        } catch (translationError) {
            logger.error({
                origin,
                error: translationError.message,
                stack: translationError.stack,
                sessionCode,
                sourceLanguage,
                bubbleId,
            }, 'Translation failed for final transcript')
            getTranslationConnectionIds(sessionCode).forEach((socketId) => {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    targetSocket.emit('translationError', {
                        message: 'Translation failed: ' + translationError.message,
                        bubbleId
                    });
                }
            });
        }
    }

    return { processed: true, languages: listenersByLanguage.size };
}

// ============================================================================
// MESSAGE QUEUE SYSTEM - Guaranteed Delivery with Acknowledgments
// ============================================================================

class MessageQueue {
    constructor(io) {
        this.io = io
        this.queues = new Map() // listenerKey -> Map<messageId, message>
        this.retryInterval = 2000 // Retry every 2 seconds
        this.maxRetries = 5
        this.messageExpiry = 30000 // Messages expire after 30 seconds
        this.sequenceNumbers = new Map() // listenerKey -> sequence number
        this.socketToListenerKey = new Map() // socketId -> listenerKey
        this.listenerKeyToSocket = new Map() // listenerKey -> current socketId
        this.cleanupTimers = new Map() // listenerKey -> grace timer
        this.listenerCleanupGraceMs = 30000

        // Start the retry loop
        this.startRetryLoop()
    }

    static listenerKey(sessionCode, targetLanguage, socketId) {
        return `${sessionCode}:${targetLanguage}:${socketId}`
    }

    bindSocket(socketId, sessionCode, targetLanguage) {
        if (!sessionCode || !targetLanguage || !socketId) return

        const key = MessageQueue.listenerKey(sessionCode, targetLanguage, socketId)
        this.cancelScheduledCleanup(key)

        const previousKey = this.socketToListenerKey.get(socketId)
        if (previousKey && previousKey !== key) {
            if (this.listenerKeyToSocket.get(previousKey) === socketId) {
                this.listenerKeyToSocket.delete(previousKey)
            }
        }

        this.socketToListenerKey.set(socketId, key)
        this.listenerKeyToSocket.set(key, socketId)
    }

    resolveListenerKey(socketId, connection = null) {
        const mappedKey = this.socketToListenerKey.get(socketId)
        if (mappedKey) return mappedKey

        if (connection?.sessionCode && connection?.targetLanguage) {
            this.bindSocket(socketId, connection.sessionCode, connection.targetLanguage)
            return this.socketToListenerKey.get(socketId)
        }

        return null
    }

    generateMessageId() {
        return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    }

    getNextSequence(listenerKey) {
        const current = this.sequenceNumbers.get(listenerKey) || 0
        const next = current + 1
        this.sequenceNumbers.set(listenerKey, next)
        return next
    }

    // Queue a message for delivery to a specific listener
    queueMessage(socketId, message, connection = null) {
        let listenerKey = this.socketToListenerKey.get(socketId)
        if (!listenerKey) {
            listenerKey = this.resolveListenerKey(socketId, connection)
        }
            if (!listenerKey) {
            logger.warn({
                socketId,
                sessionCode: connection?.sessionCode ?? 'unknown',
                targetLanguage: connection?.targetLanguage ?? 'unknown',
                hasConnection: !!connection
            }, 'No listener key bound for socket, skipping queue')
            return null
        }

        if (!this.queues.has(listenerKey)) {
            this.queues.set(listenerKey, new Map())
        }

        const messageId = this.generateMessageId()
        const sequence = this.getNextSequence(listenerKey)

        const queuedMessage = {
            ...message,
            messageId,
            sequence,
            timestamp: Date.now(),
            attempts: 0,
            acknowledged: false
        }

        this.queues.get(listenerKey).set(messageId, queuedMessage)

        // Attempt immediate delivery
        this.deliverMessage(listenerKey, queuedMessage)

        return messageId
    }

    // Attempt to deliver a message
    deliverMessage(listenerKey, message) {
        const socketId = this.listenerKeyToSocket.get(listenerKey)
        const socket = socketId ? this.io.sockets.sockets.get(socketId) : null
        if (!socket || !socket.connected) {
            return false
        }

        message.attempts++

        socket.emit('translationComplete', {
            messageId: message.messageId,
            sequence: message.sequence,
            bubbleId: message.bubbleId,
            originalText: message.originalText,
            translatedText: message.translatedText,
            sourceLanguage: message.sourceLanguage,
            targetLanguage: message.targetLanguage,
            timestamp: message.timestamp
        })

        return true
    }

    // Acknowledge a message was received
    acknowledge(socketId, messageId) {
        const listenerKey = this.socketToListenerKey.get(socketId)
        if (!listenerKey) return false

        const queue = this.queues.get(listenerKey)
        if (!queue) return false

        const message = queue.get(messageId)
        if (!message) return false

        message.acknowledged = true
        queue.delete(messageId)
        return true
    }

    // Get pending messages for a listener (for recovery after reconnect)
    getPendingMessages(socketId, connection = null) {
        const listenerKey = this.resolveListenerKey(socketId, connection)
        if (!listenerKey) return []

        const queue = this.queues.get(listenerKey)
        if (!queue) return []

        return Array.from(queue.values())
            .filter(m => !m.acknowledged)
            .sort((a, b) => a.sequence - b.sequence)
    }

    cancelScheduledCleanup(listenerKey) {
        const timer = this.cleanupTimers.get(listenerKey)
        if (!timer) return

        clearTimeout(timer)
        this.cleanupTimers.delete(listenerKey)
    }

    // Defer queue cleanup so reconnecting listeners can recover pending messages
    scheduleListenerCleanup(socketId) {
        const listenerKey = this.socketToListenerKey.get(socketId)
        if (!listenerKey) return

        this.socketToListenerKey.delete(socketId)
        const currentOwner = this.listenerKeyToSocket.get(listenerKey)
        if (currentOwner === socketId) {
            this.listenerKeyToSocket.delete(listenerKey)
        }

        if (this.cleanupTimers.has(listenerKey)) return

        const timer = setTimeout(() => {
            this.cleanupTimers.delete(listenerKey)
            this.queues.delete(listenerKey)
            this.sequenceNumbers.delete(listenerKey)
        }, this.listenerCleanupGraceMs)

        this.cleanupTimers.set(listenerKey, timer)
    }

    // Clean up listener's queue on disconnect (deferred grace period)
    cleanupListener(socketId) {
        this.scheduleListenerCleanup(socketId)
    }

    // Retry loop for unacknowledged messages
    startRetryLoop() {
        setInterval(() => {
            const now = Date.now()

            for (const [listenerKey, queue] of this.queues.entries()) {
                for (const [messageId, message] of queue.entries()) {
                    // Check if message has expired
                    if (now - message.timestamp > this.messageExpiry) {
                        queue.delete(messageId)
                        continue
                    }

                    // Check if message needs retry
                    if (!message.acknowledged && message.attempts < this.maxRetries) {
                        const timeSinceLastAttempt = now - (message.lastAttempt || message.timestamp)
                        if (timeSinceLastAttempt >= this.retryInterval) {
                            message.lastAttempt = now
                            this.deliverMessage(listenerKey, message)
                        }
                    } else if (message.attempts >= this.maxRetries) {
                        // Max retries reached, remove message
                        queue.delete(messageId)
                    }
                }
            }
        }, 1000) // Check every second
    }
}

// Create message queue instance (will be initialized after io is ready)
let messageQueue = null

async function handleBackgroundProcessing(socketId, connectionData) {
    const accumulatedText = sessionTranscripts.get(socketId);

    // Default to opt-in if not specified (for backward compatibility)
    const prefs = connectionData?.recordingPrefs || {
        storeText: true,
        generateSummary: true
    };

    if (!accumulatedText || accumulatedText.trim().length === 0) {
        sessionTranscripts.delete(socketId);
        return;
    }

    if (!connectionData?.userId) {
        logger.debug({
            socketId,
            bufferLength: accumulatedText.length,
        }, 'Skipping transcription storage - no userId, buffer retained')
        return;
    }

    if (!prefs.storeText) {
        logger.debug({
            socketId,
            userId: connectionData.userId,
        }, 'Skipping transcription storage - user opted out')
        sessionTranscripts.delete(socketId);
        return;
    }

    // Claim buffer immediately so concurrent stop/disconnect cannot double-write.
    // Restore on failure so a later cleanup can retry.
    sessionTranscripts.delete(socketId);

    (async () => {
        const startTime = Date.now()
        try {
            logger.info({
                socketId,
                userId: connectionData.userId,
                characterCount: accumulatedText.length,
                sourceLanguage: connectionData.sourceLanguage,
            }, 'Starting background transcription processing')

            const sessionData = await Session.create({
                userId: connectionData.userId,
                fullText: accumulatedText,
                sourceLanguage: connectionData.sourceLanguage || 'en-US',
                characterCount: accumulatedText.length
            });

            let summary = null;
            if (prefs.generateSummary) {
                try {
                    summary = await aiService.generateSummary(accumulatedText);
                } catch (e) {
                    logger.warn({
                        error: e.message,
                        userId: connectionData.userId,
                        sessionId: sessionData.id,
                    }, 'AI generation error in background task')
                }
            }

            if (summary) {
                await Session.update(sessionData.id, {
                    summary
                });
                logger.info({
                    socketId,
                    userId: connectionData.userId,
                    sessionId: sessionData.id,
                    duration: Date.now() - startTime,
                    hasSummary: true,
                }, 'Transcription processed with AI summary')
            } else {
                logger.info({
                    socketId,
                    userId: connectionData.userId,
                    sessionId: sessionData.id,
                    duration: Date.now() - startTime,
                    hasSummary: false,
                }, 'Transcription saved without AI content')
            }
        } catch (error) {
            const existing = sessionTranscripts.get(socketId) || '';
            sessionTranscripts.set(
                socketId,
                existing ? `${existing}\n${accumulatedText}` : accumulatedText
            );
            logger.error({
                socketId,
                userId: connectionData.userId,
                error: error.message,
                stack: error.stack,
                duration: Date.now() - startTime,
            }, 'Background transcription processing failed')
        }
    })();
}

const buildConnectionDataForSession = (sessionCode) => {
    const connectionsByLanguage = {}
    let totalConnections = 0

    activeConnections.forEach((connection) => {
        if (connection.sessionCode !== sessionCode) {
            return
        }

        totalConnections++
        if (connection.targetLanguage) {
            connectionsByLanguage[connection.targetLanguage] = (connectionsByLanguage[connection.targetLanguage] || 0) + 1
        }
    })

    return {
        sessionCode,
        total: totalConnections,
        byLanguage: connectionsByLanguage
    }
}

const emitConnectionCountToSession = (sessionCode) => {
    if (!sessionCode) return

    const connectionData = buildConnectionDataForSession(sessionCode)

    activeConnections.forEach((conn, socketId) => {
        if (conn.sessionCode !== sessionCode) return

        const targetSocket = io.sockets.sockets.get(socketId)
        if (targetSocket) {
            targetSocket.emit('connectionCount', connectionData)
        }
    })
}

const emitConnectionCount = (sessionCode = null) => {
    if (sessionCode) {
        emitConnectionCountToSession(sessionCode)
        return
    }

    const sessionCodes = new Set()
    activeConnections.forEach((connection) => {
        if (connection.sessionCode) {
            sessionCodes.add(connection.sessionCode)
        }
    })

    for (const code of sessionCodes) {
        emitConnectionCountToSession(code)
    }
}

async function processTranslations(translationConnections, transcript, sourceLanguage, bubbleId) {
    try {
    } catch (translationError) {
        logger.error({
            error: translationError.message,
            stack: translationError.stack,
            sourceLanguage,
            bubbleId,
            listenerCount: translationConnections.length,
        }, 'Translation error in processTranslations')
        translationConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId)
            if (targetSocket) {
                targetSocket.emit('translationError', {
                    message: 'Translation failed: ' + translationError.message,
                    bubbleId
                })
            }
        })
    }
}

// Initialize the message queue
messageQueue = new MessageQueue(io)

function clearForceFinalizeSafetyTimer(socketId) {
    if (forceFinalizeSafetyTimers.has(socketId)) {
        clearTimeout(forceFinalizeSafetyTimers.get(socketId))
        forceFinalizeSafetyTimers.delete(socketId)
    }
}

function cleanupSocketStreamState(socketId) {
    speechToTextService.cleanupRotation(socketId)
    clearForceFinalizeSafetyTimer(socketId)
    rotatingStreams.delete(socketId)
    restartingStreams.delete(socketId)
    audioBufferDuringRestart.delete(socketId)
    lastInterimBySocket.delete(socketId)
    currentBubbleIds.delete(socketId)
}

async function rotateStream(socket, options = {}) {
    const { emergency = false } = options
    const socketId = socket.id

    // Google-only timed rotation; Deepgram still uses emergency restart
    if (!emergency && !speechToTextService.supportsStreamRotation()) {
        return
    }

    if (!emergency && !speechToTextService.isRotationArmed(socketId)) {
        return
    }

    if (rotatingStreams.get(socketId)) {
        return
    }
    rotatingStreams.set(socketId, true)

    const conn = activeConnections.get(socketId)
    const sourceLanguage = conn?.sourceLanguage || 'en-CA'
    const speechEndTimeout = conn?.speechEndTimeout ?? 1.0
    const oldStream = streamingSessions.get(socketId)

    restartingStreams.set(socketId, true)
    if (!audioBufferDuringRestart.has(socketId)) {
        audioBufferDuringRestart.set(socketId, [])
    }

    logger.debug({
        socketId,
        emergency,
        armed: speechToTextService.isRotationArmed(socketId),
        hasOldStream: !!oldStream,
        sourceLanguage,
    }, 'Stream rotation started')

    try {
        let newStream = null
        let retries = 0
        const maxRetries = 3

        while (!newStream && retries < maxRetries) {
            try {
                newStream = await speechToTextService.startStreamingRecognition(
                    sourceLanguage,
                    speechEndTimeout,
                    createStreamCallbacks(socket)
                )
            } catch (err) {
                retries++
                logger.error({
                    socketId,
                    attempt: retries,
                    maxRetries,
                    error: err.message,
                    sourceLanguage,
                }, 'Failed to create new stream during rotation')
                if (retries < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, 500))
                }
            }
        }

        if (!newStream) {
            logger.error({
                socketId,
                retriesAttempted: retries,
                sourceLanguage,
            }, 'All rotation retries failed, keeping old stream')
            return
        }

        if (oldStream) {
            speechToTextService.endStreamingRecognition(oldStream)
        }

        streamingSessions.set(socketId, newStream)
        speechToTextService.clearRotation(socketId)
        clearForceFinalizeSafetyTimer(socketId)

        const bufferedAudio = audioBufferDuringRestart.get(socketId) || []
        for (const audioBuffer of bufferedAudio) {
            speechToTextService.sendAudioToStream(newStream, audioBuffer)
        }

        logger.info({
            socketId,
            flushedChunks: bufferedAudio.length,
            sourceLanguage,
            emergency,
        }, 'Stream rotation completed successfully')
    } catch (err) {
        logger.error({
            socketId,
            error: err.message,
            stack: err.stack,
            sourceLanguage,
        }, 'Stream rotation failed')
    } finally {
        restartingStreams.delete(socketId)
        audioBufferDuringRestart.delete(socketId)
        rotatingStreams.delete(socketId)
    }
}

function createStreamCallbacks(socket) {
    return {
        onResult: async (result) => {
            const activeBubbleId = currentBubbleIds.get(socket.id) || ''
            const sourceLanguage =
                activeConnections.get(socket.id)?.sourceLanguage || 'en-CA'

            if (!result.isFinal && result.transcript && result.transcript.trim()) {
                lastInterimBySocket.set(socket.id, result.transcript.trim())
            }

            socket.emit('transcriptionUpdate', {
                transcript: result.transcript,
                isFinal: result.isFinal,
                confidence: result.confidence,
                bubbleId: activeBubbleId
            })

            if (!result.isFinal && result.transcript && result.transcript.trim()) {
                await notifyInterimTranscription(socket, sourceLanguage, result.transcript.trim())
            }

            if (result.isFinal && result.transcript.trim()) {
                const currentConnection = activeConnections.get(socket.id)
                if (currentConnection?.sessionCode) {
                    const sessionCodeConnections = Array.from(activeConnections.entries())
                        .filter(([_, conn]) => conn.sessionCode === currentConnection.sessionCode)
                        .map(([socketId, _]) => socketId)

                    const translationConnections = sessionCodeConnections.filter((sid) => {
                        const conn = activeConnections.get(sid)
                        return conn && !conn.isStreaming && conn.targetLanguage
                    })

                    translationConnections.forEach((socketId) => {
                        const targetSocket = io.sockets.sockets.get(socketId)
                        if (targetSocket) {
                            targetSocket.emit('speakerTyping', { isTyping: false })
                        }
                    })

                    if (typingIndicatorTimeouts.has(socket.id)) {
                        clearTimeout(typingIndicatorTimeouts.get(socket.id))
                        typingIndicatorTimeouts.delete(socket.id)
                    }
                }
                lastInterimBySocket.delete(socket.id)
                socket.emit('finalResultReceived', { bubbleId: activeBubbleId })
                await handleFinalTranscription(
                    socket,
                    result.transcript,
                    sourceLanguage,
                    activeBubbleId
                )

                if (speechToTextService.isRotationArmed(socket.id)) {
                    logger.debug({
                        socketId: socket.id,
                        bubbleId: activeBubbleId,
                    }, 'Final received, initiating stream rotation')
                    await rotateStream(socket)
                }
            }
        },
        onError: (error) => {
            logger.error({
                socketId: socket.id,
                error: error.message,
                errorCode: error.code,
                stack: error.stack,
            }, 'STT streaming error occurred')
            if (error.code === 14 || (error.message && error.message.includes('UNAVAILABLE'))) {
                setTimeout(async () => {
                    if (socket.connected) {
                        socket.emit('streamRestart', {
                            reason: 'recovery',
                            error: error.message
                        })
                        await rotateStream(socket, { emergency: true })
                    }
                }, 1000)
            }
        },
        onEnd: (endedStream) => {
            // Only clear if this socket still points at the ended stream (avoids
            // wiping a replacement stream installed during rotate/restart).
            if (!endedStream || streamingSessions.get(socket.id) === endedStream) {
                streamingSessions.delete(socket.id)
            }
        },
        onRotationArm: () => {
            if (!speechToTextService.supportsStreamRotation()) return
            if (speechToTextService.isRotationArmed(socket.id)) return
            speechToTextService.armRotation(socket.id)
            logger.debug({
                socketId: socket.id,
            }, 'Stream rotation armed at 3:00 mark')
        },
        onForceFinalize: () => {
            if (!speechToTextService.supportsStreamRotation()) return
            if (!socket.connected) return

            clearForceFinalizeSafetyTimer(socket.id)
            socket.emit('forceFinalize', { timestamp: Date.now() })

            const safetyTimer = setTimeout(async () => {
                forceFinalizeSafetyTimers.delete(socket.id)
                const lastInterim = lastInterimBySocket.get(socket.id)
                if (lastInterim && lastInterim.trim()) {
                    const activeBubbleId = currentBubbleIds.get(socket.id) || ''
                    const sourceLanguage =
                        activeConnections.get(socket.id)?.sourceLanguage || 'en-CA'
                    await handleFinalTranscription(
                        socket,
                        lastInterim,
                        sourceLanguage,
                        activeBubbleId,
                        'forceFinalizeSafety'
                    )
                    lastInterimBySocket.delete(socket.id)
                }
                if (speechToTextService.isRotationArmed(socket.id)) {
                    await rotateStream(socket)
                }
            }, 1500)

            forceFinalizeSafetyTimers.set(socket.id, safetyTimer)
        },
        onRestart: async () => {
            if (socket.connected) {
                socket.emit('streamRestart', {
                    reason: 'stream_health',
                    timestamp: Date.now()
                })
            }
            await rotateStream(socket, { emergency: true })
        }
    }
}

io.on('connection', async (socket) => {

    logger.info({
        socketId: socket.id,
        userId: socket.user?.id,
        userEmail: socket.user?.email,
        sessionCode: socket.sessionCode,
        connectionsBeforeAdd: activeConnections.size,
    }, 'New socket connection established')

    const staleConnections = [];

    activeConnections.forEach((conn, socketId) => {
        if (socketId === socket.id) return; // Skip current connection

        // Check for same authenticated user (speaker)
        const isSameAuthUser = socket.user?.id && conn.userId === socket.user.id;

        // Check for same listener (same sessionCode, both are listeners without userId)
        // Note: We identify listeners as connections with sessionCode but no userId (or no isStreaming)
        const isSameListener = !socket.user?.id && socket.sessionCode &&
            conn.sessionCode === socket.sessionCode && !conn.userId;

        if (isSameAuthUser || isSameListener) {
            // Check if the existing socket is actually disconnected
            const existingSocket = io.sockets.sockets.get(socketId);
            if (!existingSocket || !existingSocket.connected) {
                staleConnections.push(socketId);
            }
        }
    });

    if (staleConnections.length > 0) {
        logger.info({
            staleConnectionCount: staleConnections.length,
            userEmail: socket.user?.email,
            sessionCode: socket.sessionCode,
            staleSocketIds: staleConnections,
        }, 'Cleaning up stale connections')
        staleConnections.forEach(socketId => {
            const conn = activeConnections.get(socketId);
            if (conn) {
                handleBackgroundProcessing(socketId, conn);
            }
            // Clean up all associated state
            const recognizeStream = streamingSessions.get(socketId);
            if (recognizeStream) {
                speechToTextService.endStreamingRecognition(recognizeStream);
                streamingSessions.delete(socketId);
            }
            speechToTextService.cleanupRotation(socketId);
            clearForceFinalizeSafetyTimer(socketId);
            rotatingStreams.delete(socketId);
            activeConnections.delete(socketId);
            restartingStreams.delete(socketId);
            audioBufferDuringRestart.delete(socketId);
            lastInterimBySocket.delete(socketId);
            currentBubbleIds.delete(socketId);
            cleanupContentHashes(socketId);
            if (messageQueue) {
                messageQueue.cleanupListener(socketId);
            }
        });
        // Emit updated connection count immediately after cleanup
        emitConnectionCount(socket.sessionCode);
    }

    activeConnections.set(socket.id, {
        userId: socket.user?.id,
        userEmail: socket.user?.email,
        sessionCode: socket.sessionCode,
        isStreaming: false,
        sourceLanguage: null,
        targetLanguage: null,
        needsTokenRefresh: socket.needsTokenRefresh || false,
        lastPing: Date.now(),
        connectedAt: Date.now(),
        pingTimeout: null,
        connectionQuality: 'good', // good, poor, critical
        messageCount: 0,
        errorCount: 0,
        lastActivity: Date.now(),
        streamStartTime: null,  // Track when streaming session started
        sessionCounted: false   // Prevent double-counting sessions
    })

    const connection = activeConnections.get(socket.id)
    attachSocketLogger(socket, connection)

    logger.info({
        socketId: socket.id,
        userId: socket.user?.id,
        userEmail: socket.user?.email,
        sessionCode: socket.sessionCode,
        totalConnections: activeConnections.size,
    }, 'Connection added to active connections')

    if (socket.user?.id) {
        try {
            await User.updateLastActive(socket.user.id);
        } catch (err) {
            logger.warn({
                userId: socket.user.id,
                error: err.message,
            }, 'Failed to update lastActive timestamp')
        }
    }

    if (connection) {
        connection.pingTimeout = setTimeout(() => {
            logger.warn({
                socketId: socket.id,
                userId: socket.user?.id,
                sessionCode: socket.sessionCode,
            }, 'Heartbeat timeout - disconnecting socket')
            socket.disconnect(true)
        }, 45000)
    }

    if (socket.needsTokenRefresh) {
        socket.emit('tokenExpired', {
            message: 'Your session has expired. Please refresh your token.',
            code: 'TOKEN_EXPIRED'
        })
    }

    emitConnectionCount(socket.sessionCode)

    // Handle ping/pong for heartbeat
    socket.on('ping', () => {
        const connection = activeConnections.get(socket.id)
        if (connection) {
            const timeSinceLastPing = Date.now() - connection.lastPing
            connection.lastPing = Date.now()
            connection.lastActivity = Date.now()

            // Update connection quality based on ping frequency
            if (timeSinceLastPing > 20000) {
                connection.connectionQuality = 'poor'
            } else if (timeSinceLastPing > 30000) {
                connection.connectionQuality = 'critical'
            } else {
                connection.connectionQuality = 'good'
            }

            // Clear existing timeout and set new one
            if (connection.pingTimeout) {
                clearTimeout(connection.pingTimeout)
            }

            const timeoutDuration = connection.connectionQuality === 'critical' ? 25000 :
                connection.connectionQuality === 'poor' ? 35000 : 45000

            connection.pingTimeout = setTimeout(() => {
                logger.warn({
                    socketId: socket.id,
                    userId: socket.user?.id,
                    connectionQuality: connection.connectionQuality,
                    timeoutDuration,
                }, 'Heartbeat timeout - disconnecting socket')
                socket.disconnect(true)
            }, timeoutDuration)
        }
        socket.emit('pong')
    })

    socket.on('refreshToken', async (data) => {
        try {
            const { refreshToken } = data

            if (!refreshToken) {
                socket.emit('tokenRefreshError', { message: 'Refresh token required' })
                return
            }

            const jwt = require('jsonwebtoken')
            const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production'

            jwt.verify(refreshToken, JWT_SECRET, async (err, decoded) => {
                if (err) {
                    socket.emit('tokenRefreshError', { message: 'Invalid refresh token' })
                    return
                }

                try {
                    const user = await User.findUserById(decoded.userId)
                    if (!user || !user.isActive) {
                        socket.emit('tokenRefreshError', { message: 'User not found' })
                        return
                    }

                    const { generateToken, generateRefreshToken } = require('./src/middleware/auth')
                    const newAccessToken = generateToken(user)
                    const newRefreshToken = generateRefreshToken(user)

                    socket.user = user
                    socket.needsTokenRefresh = false

                    const connection = activeConnections.get(socket.id)
                    if (connection) {
                        connection.userId = user.id
                        connection.userEmail = user.email
                        connection.needsTokenRefresh = false
                    }

                    socket.emit('tokenRefreshed', {
                        accessToken: newAccessToken,
                        refreshToken: newRefreshToken
                    })

                } catch (error) {
                    logger.error({
                        socketId: socket.id,
                        error: error.message,
                        stack: error.stack,
                    }, 'Token refresh failed')
                    socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
                }
            })
        } catch (error) {
            logger.error({
                socketId: socket.id,
                error: error.message,
                stack: error.stack,
            }, 'Token refresh error')
            socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
        }
    })

    socket.on('updateRecordingPrefs', (prefs) => {
        const connection = activeConnections.get(socket.id);
        if (connection) {
            connection.recordingPrefs = {
                storeText: !!prefs.storeText,
                generateSummary: !!prefs.generateSummary
            };
            logger.info({
                socketId: socket.id,
                userId: socket.user?.id,
                storeText: connection.recordingPrefs.storeText,
                generateSummary: connection.recordingPrefs.generateSummary,
            }, 'Updated recording preferences')
        }
    });

    socket.on('speechTranscription', async (data) => {
        try {

            if (socket.needsTokenRefresh) {
                socket.emit('tokenExpired', {
                    message: 'Your session has expired. Please refresh your token.',
                    code: 'TOKEN_EXPIRED'
                })
                return
            }

            const { transcription, sourceLanguage, bubbleId } = data

            const connection = activeConnections.get(socket.id)
            if (connection) {
                connection.sourceLanguage = sourceLanguage
                connection.messageCount++
                connection.lastActivity = Date.now()

                const allowed = await ensureStreamingAllowed(socket, connection)
                if (!allowed) return
                connection.isStreaming = true
            }

            const currentConnection = activeConnections.get(socket.id)
            emitConnectionCount(currentConnection?.sessionCode)

            if (currentConnection?.sessionCode) {
                await processFinalTranscript({
                    socket,
                    transcript: transcription,
                    sourceLanguage,
                    bubbleId,
                    origin: 'speechTranscription'
                })
            } else {
                console.warn(
                    `⚠️ Skipping transcription broadcast — no sessionCode for socket ${socket.id}`
                )
            }

        } catch (error) {
            logger.error({
                socketId: socket.id,
                userId: socket.user?.id,
                error: error.message,
                stack: error.stack,
            }, 'Error processing speech transcription')

            const connection = activeConnections.get(socket.id)
            if (connection) {
                connection.errorCount++
                connection.lastActivity = Date.now()

                // Update connection quality based on error rate
                const errorRate = connection.errorCount / Math.max(connection.messageCount, 1)
                if (errorRate > 0.1) {
                    connection.connectionQuality = 'critical'
                } else if (errorRate > 0.05) {
                    connection.connectionQuality = 'poor'
                }
            }

            socket.emit('error', { message: 'Failed to process transcription: ' + error.message })
        }
    })

    // Google Cloud Speech-to-Text streaming handler
    socket.on('googleSpeechTranscription', async (data) => {
        try {
            if (socket.needsTokenRefresh) {
                socket.emit('tokenExpired', {
                    message: 'Your session has expired. Please refresh your token.',
                    code: 'TOKEN_EXPIRED'
                })
                return
            }

            const {
                audioData,
                sourceLanguage,
                bubbleId,
                isFinal,
                interimTranscript,
                finalTranscript,
                wordCount,
                maxWordsPerBubble = 15,
                speechEndTimeout = 1.0
            } = data

            const connection = activeConnections.get(socket.id)

            // Check if language has changed BEFORE updating connection.sourceLanguage
            const previousLanguage = connection?.sourceLanguage;
            const languageChanged = previousLanguage && previousLanguage !== sourceLanguage;

            // If language changed, end the existing stream and notify frontend
            if (languageChanged) {
                const existingStream = streamingSessions.get(socket.id);
                if (existingStream) {
                    speechToTextService.endStreamingRecognition(existingStream);
                    streamingSessions.delete(socket.id);
                    speechToTextService.cleanupRotation(socket.id);
                    clearForceFinalizeSafetyTimer(socket.id);
                    // Notify frontend that stream is restarting due to language change
                    socket.emit('streamRestart', {
                        reason: 'language_changed',
                        newLanguage: sourceLanguage,
                        oldLanguage: previousLanguage
                    });
                }
            }

            if (connection) {
                connection.sourceLanguage = sourceLanguage
                connection.speechEndTimeout = speechEndTimeout

                const allowed = await ensureStreamingAllowed(socket, connection)
                if (!allowed) return
                connection.isStreaming = true
            }

            const currentConnection = activeConnections.get(socket.id)
            emitConnectionCount(currentConnection?.sessionCode)

            // Track the current bubbleId from frontend (important for stream restarts)
            if (bubbleId) {
                currentBubbleIds.set(socket.id, bubbleId);
            }

            // If we have audio data, process it with Google Cloud Speech-to-Text
            if (audioData && audioData.length > 0) {
                try {
                    const audioBuffer = Buffer.from(audioData, 'base64')

                    audioChunkCounter++

                    // Check if this is LINEAR16 format from frontend
                    const audioFormat = data.audioFormat || 'WEBM';
                    const sampleRate = data.sampleRate || 48000;

                    if (audioFormat === 'LINEAR16') {
                        // Start streaming recognition on first chunk for this socket (or after language change)
                        if (!streamingSessions.has(socket.id)) {

                            try {
                                const recognizeStream = await speechToTextService.startStreamingRecognition(
                                    sourceLanguage,
                                    speechEndTimeout,
                                    createStreamCallbacks(socket)
                                )

                                if (recognizeStream) {
                                    streamingSessions.set(socket.id, recognizeStream);
                                } else {
                                    logger.error({
                                        socketId: socket.id,
                                        sourceLanguage,
                                    }, 'Stream creation returned null/undefined')
                                }
                            } catch (streamError) {
                                logger.error({
                                    socketId: socket.id,
                                    sourceLanguage,
                                    error: streamError.message,
                                    stack: streamError.stack,
                                }, 'Failed to create streaming recognition')
                                socket.emit('error', {
                                    message: 'Failed to start speech recognition: ' + streamError.message
                                });
                                return;
                            }
                        }

                        // Check if we're in the middle of a stream restart - buffer the audio
                        if (restartingStreams.get(socket.id)) {
                            const buffer = audioBufferDuringRestart.get(socket.id) || [];
                            buffer.push(audioBuffer);
                            audioBufferDuringRestart.set(socket.id, buffer);
                            if (buffer.length > 100) {
                                buffer.shift();
                            }
                            if (buffer.length % 25 === 1) {
                                logger.debug({
                                    socketId: socket.id,
                                    bufferLength: buffer.length,
                                    rotating: !!rotatingStreams.get(socket.id),
                                }, 'Buffering audio during stream restart')
                            }
                            return;
                        }

                        // Send audio chunk to Google Cloud streaming (only to active stream)
                        const recognizeStream = streamingSessions.get(socket.id);
                        if (recognizeStream && !recognizeStream.destroyed) {
                            speechToTextService.sendAudioToStream(recognizeStream, audioBuffer);
                            if ((++__dbgAudioCount) % 150 === 0) {
                                logger.debug({
                                    socketId: socket.id,
                                    audioChunkCounter: __dbgAudioCount,
                                }, 'Audio sent to active stream')
                            }
                        } else {
                            if (!restartingStreams.get(socket.id)) {
                                logger.error({
                                    socketId: socket.id,
                                    hasStream: !!recognizeStream,
                                    isDestroyed: recognizeStream?.destroyed,
                                    sessionExists: streamingSessions.has(socket.id),
                                }, 'No valid stream found for socket')
                            }
                        }
                    } else {
                    }
                } catch (speechError) {
                    logger.error({
                        socketId: socket.id,
                        userId: socket.user?.id,
                        error: speechError.message,
                        stack: speechError.stack,
                        sourceLanguage,
                    }, 'Google Cloud Speech-to-Text error')
                    socket.emit('error', {
                        message: 'Speech recognition failed: ' + speechError.message
                    })
                }
            }

            // Handle manual finalization (when frontend sends final transcript)
            if (finalTranscript && isFinal && !audioData) {
                await processFinalTranscript({
                    socket,
                    transcript: finalTranscript,
                    sourceLanguage,
                    bubbleId,
                    origin: 'manualFinal'
                })

                lastInterimBySocket.delete(socket.id)
                if (speechToTextService.isRotationArmed(socket.id)) {
                    await rotateStream(socket)
                }
            }

        } catch (error) {
            logger.error({
                socketId: socket.id,
                userId: socket.user?.id,
                error: error.message,
                stack: error.stack,
            }, 'Error processing Google Cloud speech transcription')
            socket.emit('error', { message: 'Failed to process speech transcription: ' + error.message })
        }
    })


    socket.on('stopStreaming', async () => {
        const connection = activeConnections.get(socket.id)
        if (connection) {
            connection.isStreaming = false

            // Background processing of accumulated transcript
            handleBackgroundProcessing(socket.id, connection);

            await finishStreamingUsage(socket, connection)
        }

        // End Google Cloud streaming session
        const recognizeStream = streamingSessions.get(socket.id)
        if (recognizeStream) {
            speechToTextService.endStreamingRecognition(recognizeStream)
            streamingSessions.delete(socket.id)
        }

        cleanupSocketStreamState(socket.id)
    })

    socket.on('forceFinalizeAck', async () => {
        clearForceFinalizeSafetyTimer(socket.id)
        lastInterimBySocket.delete(socket.id)

        if (speechToTextService.isRotationArmed(socket.id)) {
            await rotateStream(socket)
        }
    })

    socket.on('requestStreamRestart', async (data) => {
        logger.info({
            socketId: socket.id,
            userId: socket.user?.id,
            reason: data?.reason || 'unknown',
        }, 'Client requested stream restart')

        const recognizeStream = streamingSessions.get(socket.id);
        if (recognizeStream) {
            speechToTextService.endStreamingRecognition(recognizeStream);
            streamingSessions.delete(socket.id);
        }

        speechToTextService.cleanupRotation(socket.id);
        clearForceFinalizeSafetyTimer(socket.id);
        rotatingStreams.delete(socket.id);
        restartingStreams.delete(socket.id);
        audioBufferDuringRestart.delete(socket.id);

        // Notify client to restart stream - a new stream will be created on next audio chunk
        socket.emit('streamRestart', {
            reason: data?.reason || 'client_request',
            timestamp: Date.now()
        });

        await rotateStream(socket, { emergency: true });
    })

    socket.on('setTargetLanguage', (data) => {
        const connection = activeConnections.get(socket.id)
        if (connection) {
            connection.targetLanguage = data.targetLanguage
            connection.isStreaming = false
            let queueBound = false
            if (messageQueue && connection.sessionCode && data.targetLanguage) {
                messageQueue.bindSocket(socket.id, connection.sessionCode, data.targetLanguage)
                queueBound = messageQueue.socketToListenerKey.has(socket.id)
            }
            const listenerCount = getTranslationConnectionIds(connection.sessionCode).length
            logger.info({
                socketId: socket.id,
                targetLanguage: data.targetLanguage,
                sessionCode: connection.sessionCode,
                listenerCount,
                queueBound,
            }, 'Listener registered for translation')
            emitConnectionCount(connection.sessionCode)
            socket.emit('targetLanguageConfirmed', {
                socketId: socket.id,
                sessionCode: connection.sessionCode,
                targetLanguage: data.targetLanguage,
                queueBound
            })
        }
    })

    socket.on('clearTargetLanguage', () => {
        const connection = activeConnections.get(socket.id)
        if (connection) {
            connection.targetLanguage = null
            if (messageQueue) {
                messageQueue.cleanupListener(socket.id)
            }
            logger.info({
                socketId: socket.id,
                sessionCode: connection.sessionCode,
            }, 'Listener unregistered from translation')
            emitConnectionCount(connection.sessionCode)
        }
    })

    // Acknowledge receipt of a translation message
    socket.on('translationAck', (data) => {
        if (data.messageId && messageQueue) {
            messageQueue.acknowledge(socket.id, data.messageId)
        }
    })

    // Request missed messages after reconnection
    socket.on('requestMissedMessages', () => {
        if (messageQueue) {
            const connection = activeConnections.get(socket.id)
            const pendingMessages = messageQueue.getPendingMessages(socket.id, connection)
            if (pendingMessages.length > 0) {
                pendingMessages.forEach(message => {
                    socket.emit('translationComplete', {
                        messageId: message.messageId,
                        sequence: message.sequence,
                        bubbleId: message.bubbleId,
                        originalText: message.originalText,
                        translatedText: message.translatedText,
                        sourceLanguage: message.sourceLanguage,
                        targetLanguage: message.targetLanguage,
                        timestamp: message.timestamp,
                        isRecovery: true // Flag to indicate this is a recovery message
                    })
                })
            }
        }
    })

    socket.on('getConnectionCount', () => {
        const currentConnection = activeConnections.get(socket.id)
        const sessionCode = currentConnection?.sessionCode

        if (!sessionCode) {
            return
        }

        socket.emit('connectionCount', buildConnectionDataForSession(sessionCode))
    })

    socket.on('disconnect', async () => {
        const connection = activeConnections.get(socket.id)
        const connectionAgeSeconds = connection?.connectedAt
            ? Math.round((Date.now() - connection.connectedAt) / 1000)
            : null

        logger.info({
            socketId: socket.id,
            userId: connection?.userId,
            userEmail: connection?.userEmail,
            sessionCode: connection?.sessionCode,
            connectionAge: connectionAgeSeconds,
            isStreaming: !!connection?.isStreaming,
            hasStream: streamingSessions.has(socket.id),
            connectionsBeforeRemove: activeConnections.size,
        }, 'Socket disconnected')

        // Clean up ping timeout
        if (connection && connection.pingTimeout) {
            clearTimeout(connection.pingTimeout)
        }

        // Background processing of accumulated transcript
        if (connection) {
            handleBackgroundProcessing(socket.id, connection);
        }

        if (connection) {
            await finishStreamingUsage(socket, connection)
        }

        // Clean up streaming session
        const recognizeStream = streamingSessions.get(socket.id)
        if (recognizeStream) {
            speechToTextService.endStreamingRecognition(recognizeStream)
            streamingSessions.delete(socket.id)
        }

        // Clean up restart state
        cleanupSocketStreamState(socket.id)

        // Clean up typing indicator timeout
        if (typingIndicatorTimeouts.has(socket.id)) {
            clearTimeout(typingIndicatorTimeouts.get(socket.id))
            typingIndicatorTimeouts.delete(socket.id)
        }

        interimTranslationThrottle.delete(socket.id)

        // Clean up content hashes
        cleanupContentHashes(socket.id)

        // Clean up message queue for this listener
        if (messageQueue) {
            messageQueue.cleanupListener(socket.id)
        }

        // Clean up processed transcripts for this socket
        const socketPrefix = `${socket.id}:`;
        for (const [key, _] of processedTranscripts.entries()) {
            if (key.startsWith(socketPrefix)) {
                processedTranscripts.delete(key);
            }
        }

        if (connection) {
            const sessionDuration = Date.now() - connection.lastActivity
            const errorRate = connection.errorCount / Math.max(connection.messageCount, 1)
            logger.info({
                socketId: socket.id,
                userId: connection.userId,
                userEmail: connection.userEmail,
                sessionDuration: Math.round(sessionDuration / 1000),
                messageCount: connection.messageCount,
                errorCount: connection.errorCount,
                errorRate: Math.round(errorRate * 100),
                connectionQuality: connection.connectionQuality,
            }, 'Connection quality metrics before cleanup')
        }

        activeConnections.delete(socket.id)

        logger.info({
            socketId: socket.id,
            totalConnections: activeConnections.size,
        }, 'Connection removed from active connections')

        emitConnectionCount(connection?.sessionCode)
    })
})

setInterval(() => {
    const orphanedConnections = [];

    activeConnections.forEach((conn, socketId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket || !socket.connected) {
            orphanedConnections.push(socketId);
        }
    });

    if (orphanedConnections.length > 0) {
        logger.info({
            orphanedCount: orphanedConnections.length,
            orphanedSocketIds: orphanedConnections,
        }, 'Found orphaned connections, cleaning up')
        orphanedConnections.forEach(socketId => {
            const conn = activeConnections.get(socketId);
            
            if (conn) {
                handleBackgroundProcessing(socketId, conn);
            }

            // Clean up associated resources
            const recognizeStream = streamingSessions.get(socketId);
            if (recognizeStream) {
                speechToTextService.endStreamingRecognition(recognizeStream);
                streamingSessions.delete(socketId);
            }
            speechToTextService.cleanupRotation(socketId);
            clearForceFinalizeSafetyTimer(socketId);
            rotatingStreams.delete(socketId);
            restartingStreams.delete(socketId);
            audioBufferDuringRestart.delete(socketId);
            lastInterimBySocket.delete(socketId);
            currentBubbleIds.delete(socketId);
            interimTranslationThrottle.delete(socketId);
            if (typingIndicatorTimeouts.has(socketId)) {
                clearTimeout(typingIndicatorTimeouts.get(socketId));
                typingIndicatorTimeouts.delete(socketId);
            }
            activeConnections.delete(socketId);
        });

        emitConnectionCount();
        logger.info({
            totalConnections: activeConnections.size,
            cleanedUpCount: orphanedConnections.length,
        }, 'Orphaned connections cleanup completed')
    }
}, 30000);

async function notifyInterimTranscription(socket, sourceLanguage, interimText) {
    const currentConnection = activeConnections.get(socket.id);
    if (!currentConnection?.sessionCode) return;

    const listenersByLanguage = getListenersByLanguage(currentConnection.sessionCode);
    if (listenersByLanguage.size === 0) return;

    const translationConnections = getTranslationConnectionIds(currentConnection.sessionCode);
    const interimTranslationEnabled = await AppSettings.isInterimTranslationEnabled(
        currentConnection.userId
    );

    if (!interimTranslationEnabled) {
        // Cost gate: signal typing without translating interim text
        translationConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId);
            if (targetSocket) {
                targetSocket.emit('speakerTyping', {
                    isTyping: true,
                    sourceLanguage: sourceLanguage
                });
            }
        });
    } else {
        if (!interimTranslationThrottle.has(socket.id)) {
            interimTranslationThrottle.set(socket.id, new Map());
        }
        const speakerThrottle = interimTranslationThrottle.get(socket.id);

        // Process each unique target language
        for (const [targetLanguage, listenerSocketIds] of listenersByLanguage) {
            let textToSend = interimText;
            let translatedText = null;

            if (isSameLanguage(sourceLanguage, targetLanguage)) {
                textToSend = interimText;
            } else {
                const throttleEntry = speakerThrottle.get(targetLanguage);
                const now = Date.now();

                if (throttleEntry && !shouldTranslateInterim(throttleEntry.timestamp, now)) {
                    translatedText = throttleEntry.translatedText;
                    textToSend = translatedText || interimText;
                } else {
                    // Throttle expired or first request -> translate
                    try {
                        translatedText = await googleTranslationService.translateText(
                            interimText,
                            sourceLanguage,
                            targetLanguage
                        );
                        textToSend = translatedText;

                        speakerThrottle.set(targetLanguage, {
                            timestamp: now,
                            translatedText: translatedText
                        });
                    } catch (error) {
                        logger.error({
                            error: error.message,
                            sourceLanguage,
                            targetLanguage,
                        }, 'Interim translation error')
                        textToSend = interimText;
                    }
                }
            }

            listenerSocketIds.forEach(socketId => {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    targetSocket.emit('speakerTyping', {
                        isTyping: true,
                        interimText: interimText,
                        translatedInterimText: translatedText || textToSend,
                        sourceLanguage: sourceLanguage
                    });
                }
            });
        }
    }

    // Clear existing timeout for this socket
    if (typingIndicatorTimeouts.has(socket.id)) {
        clearTimeout(typingIndicatorTimeouts.get(socket.id));
    }

    // Set timeout to stop typing indicator after 2 seconds of no interim results
    const timeout = setTimeout(() => {
        translationConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId);
            if (targetSocket) {
                targetSocket.emit('speakerTyping', { isTyping: false });
            }
        });
        typingIndicatorTimeouts.delete(socket.id);
        interimTranslationThrottle.delete(socket.id);
    }, 2000);

    typingIndicatorTimeouts.set(socket.id, timeout);
}

// Helper function to handle final transcription processing (translation and delivery)
async function handleFinalTranscription(socket, transcript, sourceLanguage, activeBubbleId, origin = 'sttFinal') {
    return processFinalTranscript({
        socket,
        transcript,
        sourceLanguage,
        bubbleId: activeBubbleId,
        origin
    });
}

async function processTranscription(transcription, sourceLanguage, targetLanguage) {
    // If source and target languages are the same, return the transcription directly
    if (sourceLanguage === targetLanguage) {
        return transcription;
    }

    // Use Google Cloud Translation API - let errors propagate so callers can handle them
    const translatedText = await googleTranslationService.translateText(
        transcription,
        sourceLanguage,
        targetLanguage
    );

    return translatedText;
}

app.get('/health', (req, res) => {
    try {
        res.status(200).json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            port: config.PORT,
            environment: config.NODE_ENV
        })
    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
        }, 'Health check endpoint error')
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        })
    }
})

app.post('/api/tts', async (req, res) => {
    try {
        const { text, languageCode } = req.body

        if (!text || !languageCode) {
            return res.status(400).json({
                error: 'Missing required fields: text and languageCode'
            })
        }

        // Check if language is supported
        if (!textToSpeechService.isLanguageSupported(languageCode)) {
            return res.status(400).json({
                error: `Language ${languageCode} is not supported for text-to-speech`
            })
        }

        // Generate audio
        const audioBuffer = await textToSpeechService.synthesizeSpeech(text, languageCode)

        // Send audio as MP3
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length,
            'Cache-Control': 'no-cache'
        })

        res.send(audioBuffer)
    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
            languageCode: req.body?.languageCode,
        }, 'TTS endpoint error')
        res.status(500).json({
            error: 'Text-to-speech synthesis failed: ' + error.message
        })
    }
})

// Check TTS language support
app.get('/api/tts/supported', (req, res) => {
    const { languageCode } = req.query

    if (!languageCode) {
        return res.status(400).json({ error: 'Missing languageCode query parameter' })
    }

    const supported = textToSpeechService.isLanguageSupported(languageCode)
    res.json({ languageCode, supported })
})

// Active streaming STT provider (drives speaker source-language catalog)
app.get('/api/stt/config', (req, res) => {
    res.json({
        provider: speechToTextService.getProviderName(),
        supportsStreamRotation: speechToTextService.supportsStreamRotation(),
    })
})

app.get('/api/sessions', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;
        const sessions = await Session.findByUserId(userId, limit);
        res.json({ sessions });
    } catch (error) {
        logger.error({
            userId: req.user?.id,
            error: error.message,
            stack: error.stack,
        }, 'Error fetching sessions')
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
})

app.delete('/api/sessions/:id', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const sessionData = await Session.findById(id);
        
        if (!sessionData) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Check if the current user is the owner
        if (sessionData.userId !== userId) {
            return res.status(403).json({ error: 'Unauthorized: You can only delete your own sessions' });
        }

        await Session.delete(id);
        res.json({ success: true, message: 'Session deleted successfully' });
    } catch (error) {
        logger.error({
            userId: req.user?.id,
            sessionId: req.params?.id,
            error: error.message,
            stack: error.stack,
        }, 'Error deleting session')
        res.status(500).json({ error: 'Failed to delete session' });
    }
})

app.use((err, req, res, next) => {
    logger.error({
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
        requestId: req.requestId,
    }, 'Unhandled error in request')
    res.status(500).json({ error: 'Something went wrong!' })
})

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' })
})

const startServer = async () => {
    try {
        logger.info({
            environment: config.NODE_ENV,
            port: config.PORT,
            host: config.HOST,
        }, 'Starting server initialization')

        await new Promise((resolve, reject) => {
            server.listen(config.PORT, config.HOST, () => {
                logger.info({
                    host: config.HOST,
                    port: config.PORT,
                }, 'Server listening')
                resolve()
            })
            server.on('error', reject)
        })

        try {
            await initFirestore()
            await AppSettings.ensureDefaults()
            logger.info('Firestore initialized successfully')
        } catch (dbError) {
            logger.error({
                error: dbError.message,
                stack: dbError.stack,
            }, 'Firestore initialization failed - server will continue but database features may not work')
        }

        try {
            await speechToTextService.warmClient()
            logger.info({
                provider: speechToTextService.getProviderName(),
            }, 'STT client initialized')
        } catch (error) {
            logger.warn({
                provider: speechToTextService.getProviderName(),
                error: error.message,
            }, 'STT client initialization failed - transcription will not work')
        }

        setInterval(() => {
            const now = Date.now()
            let cleanedCount = 0
            for (const [key, timestamp] of processedTranscripts.entries()) {
                if (now - timestamp > 10 * 60 * 1000) {
                    processedTranscripts.delete(key)
                    cleanedCount++
                }
            }

            logger.info({
                activeConnections: activeConnections.size,
                processedTranscripts: processedTranscripts.size,
                cleanedTranscripts: cleanedCount,
            }, 'Connection statistics')
        }, 5 * 60 * 1000)

        logger.info('Server is ready to accept connections')
    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
        }, 'Failed to start server')
        process.exit(1)
    }
}

const gracefulShutdown = (signal) => {
    logger.info({
        signal,
        activeConnections: activeConnections.size,
    }, 'Received shutdown signal, shutting down gracefully')
    server.close(() => {
        logger.info('Server closed successfully')
        process.exit(0)
    })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

startServer()
