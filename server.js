const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')
require('dotenv').config()
const config = require('./src/config')
const { authenticateSocket, authenticateToken } = require('./src/middleware/auth')
const authRoutes = require('./src/routes/auth')
const User = require('./src/models/User')
const Session = require('./src/models/Session')
const { initFirestore } = require('./src/database/firestore')
const speechToTextService = require('./src/services/speechToTextService')
const googleTranslationService = require('./src/services/googleTranslationService')
const textToSpeechService = require('./src/services/textToSpeechService')
const aiService = require('./src/services/aiService')
const { isSameLanguage } = require('./src/utils/languageCodeMapper')
const app = express()
const server = http.createServer(app)

app.use(cors({
    origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
}))

const io = socketIo(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 200
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
})

io.use(authenticateSocket)

app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.use('/auth', authRoutes)

const activeConnections = new Map()
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
// #region agent log
let __dbgAudioCount = 0
const __dbg = (location, message, data) => { try { fetch('http://127.0.0.1:7809/ingest/3c5ff2ee-7cbf-4a34-a4e1-f6d7b649a94d',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a86d7b'},body:JSON.stringify({sessionId:'a86d7b',location,message,data,timestamp:Date.now()})}).catch(()=>{}) } catch(e){} }
// #endregion

const interimTranslationThrottle = new Map()
const INTERIM_THROTTLE_MS = 1000

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

    static listenerKey(sessionCode, targetLanguage) {
        return `${sessionCode}:${targetLanguage}`
    }

    bindSocket(socketId, sessionCode, targetLanguage) {
        if (!sessionCode || !targetLanguage) return

        const key = MessageQueue.listenerKey(sessionCode, targetLanguage)
        this.cancelScheduledCleanup(key)

        const previousSocket = this.listenerKeyToSocket.get(key)
        if (previousSocket && previousSocket !== socketId) {
            this.socketToListenerKey.delete(previousSocket)
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
    queueMessage(socketId, message) {
        const listenerKey = this.socketToListenerKey.get(socketId)
        if (!listenerKey) {
            console.warn(`⚠️ No listener key bound for socket ${socketId}, skipping queue`)
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
        this.listenerKeyToSocket.delete(listenerKey)

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
    let accumulatedText = sessionTranscripts.get(socketId);
    sessionTranscripts.delete(socketId);

    // Default to opt-in if not specified (for backward compatibility)
    const prefs = connectionData.recordingPrefs || {
        storeText: true,
        generateSummary: true,
        generateFacebookPost: true
    };

    if (!accumulatedText || accumulatedText.trim().length === 0 || !connectionData || !connectionData.userId || !prefs.storeText) {
        if (!prefs.storeText) {
            console.log(`ℹ️ Skipping transcription storage for user ${connectionData.userId} (user opted out)`);
        }
        return;
    }

    // Fire-and-forget background processing
    (async () => {
        try {
            console.log(`📝 Processing transcription background task for user ${connectionData.userId}...`);

            // Save to database
            const sessionData = await Session.create({
                userId: connectionData.userId,
                fullText: accumulatedText,
                sourceLanguage: connectionData.sourceLanguage || 'en-US'
            });

            // Generate AI Content based on preferences
            const aiTasks = [];
            if (prefs.generateSummary) {
                aiTasks.push(aiService.generateSummary(accumulatedText));
            } else {
                aiTasks.push(Promise.resolve(null));
            }

            if (prefs.generateFacebookPost) {
                aiTasks.push(aiService.generateFacebookPost(accumulatedText));
            } else {
                aiTasks.push(Promise.resolve(null));
            }

            const [summary, facebookPost] = await Promise.all(aiTasks.map(p => p.catch(e => {
                console.error('⚠️ AI generation error ignored in background task:', e);
                return null;
            })));

            // Update session with AI content if generated
            if (summary || facebookPost) {
                await Session.update(sessionData.id, {
                    summary: summary || null,
                    facebookPost: facebookPost || null
                });
                console.log(`✅ Transcription processed and updated with AI for ${connectionData.userId}`);
            } else {
                console.log(`✅ Transcription saved without AI content for ${connectionData.userId}`);
            }
        } catch (error) {
            console.error(`❌ Background processing failed for ${connectionData.userId}:`, error.message);
        }
    })();
}

const emitConnectionCount = (sessionCode = null) => {
    const connectionsByLanguage = {}
    let totalConnections = 0

    activeConnections.forEach((connection) => {
        if (sessionCode && connection.sessionCode !== sessionCode) {
            return
        }

        if (!connection.sessionCode) {
            return
        }

        totalConnections++
        if (connection.targetLanguage) {
            connectionsByLanguage[connection.targetLanguage] = (connectionsByLanguage[connection.targetLanguage] || 0) + 1
        }
    })

    const connectionData = {
        total: totalConnections,
        byLanguage: connectionsByLanguage
    }

    if (sessionCode) {
        const sessionCodeConnections = Array.from(activeConnections.entries())
            .filter(([_, conn]) => conn.sessionCode === sessionCode)
            .map(([socketId, _]) => socketId)


        sessionCodeConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId)
            if (targetSocket) {
                targetSocket.emit('connectionCount', connectionData)
            }
        })
    } else {
        const validConnections = Array.from(activeConnections.entries())
            .filter(([_, conn]) => conn.sessionCode)
            .map(([socketId, _]) => socketId)

        validConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId)
            if (targetSocket) {
                targetSocket.emit('connectionCount', connectionData)
            }
        })
    }
}

async function processTranslations(translationConnections, transcript, sourceLanguage, bubbleId) {
    try {
    } catch (translationError) {
        console.error('Translation error:', translationError)
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

    // #region agent log
    __dbg('server.js:rotateStream', 'ROTATE entry', { socketId, emergency, armed: speechToTextService.isRotationArmed(socketId), hasOldStream: !!oldStream })
    // #endregion

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
                console.error(`❌ rotateStream: failed to create new stream (attempt ${retries}):`, err)
                if (retries < maxRetries) {
                    await new Promise((resolve) => setTimeout(resolve, 500))
                }
            }
        }

        if (!newStream) {
            console.error(`❌ rotateStream: all retries failed for ${socketId}, keeping old stream`)
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

        console.log(`✅ [ROTATE] Stream rotated for ${socketId}, flushed ${bufferedAudio.length} buffered chunks`)
        // #region agent log
        __dbg('server.js:rotateStream', 'ROTATE success', { socketId, flushed: bufferedAudio.length, newDestroyed: !!newStream.destroyed })
        // #endregion
    } catch (err) {
        console.error(`❌ rotateStream failed for ${socketId}:`, err)
    } finally {
        restartingStreams.delete(socketId)
        audioBufferDuringRestart.delete(socketId)
        rotatingStreams.delete(socketId)
        // #region agent log
        __dbg('server.js:rotateStream', 'ROTATE finally cleanup', { socketId, restartingStillSet: restartingStreams.has(socketId), rotatingStillSet: rotatingStreams.has(socketId) })
        // #endregion
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
                    console.log(`🔄 [ROTATE] Final received, rotating stream for ${socket.id}`)
                    await rotateStream(socket)
                }
            }
        },
        onError: (error) => {
            console.error('❌ Google Cloud streaming error:', error)
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
        onEnd: () => {
            streamingSessions.delete(socket.id)
        },
        onRotationArm: () => {
            if (speechToTextService.isRotationArmed(socket.id)) return
            speechToTextService.armRotation(socket.id)
            console.log(`⏰ [ROTATE] Rotation armed for ${socket.id} at 3:00`)
        },
        onForceFinalize: () => {
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
                        activeBubbleId
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

    // Log new connection
    console.log(`🔗 New connection: ${socket.id} (user: ${socket.user?.email || 'listener'}, sessionCode: ${socket.sessionCode})`);
    console.log(`📊 Total connections before add: ${activeConnections.size}`);

    // Check for stale connections from same user and clean them up
    // This handles both authenticated users (speakers) and listeners (sessionCode only)
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

    // Clean up stale connections immediately
    if (staleConnections.length > 0) {
        const identifier = socket.user?.email || `listener-${socket.sessionCode}`;
        console.log(`🧹 Cleaning up ${staleConnections.length} stale connections for ${identifier}`);
        staleConnections.forEach(socketId => {
            console.log(`  - Removing stale socket: ${socketId}`);
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

    console.log(`📊 Total connections after add: ${activeConnections.size}`);

    // Update lastActive for authenticated users
    if (socket.user?.id) {
        try {
            await User.updateLastActive(socket.user.id);
        } catch (err) {
            console.warn('⚠️ Failed to update lastActive:', err.message);
        }
    }

    // Set up heartbeat mechanism
    // Server timeout is a safety net - clients should detect and reconnect faster
    const connection = activeConnections.get(socket.id)
    if (connection) {
        // Set initial ping timeout (45 seconds - acts as safety net, client should reconnect faster)
        connection.pingTimeout = setTimeout(() => {
            console.log(`💔 Heartbeat timeout for socket ${socket.id}, disconnecting...`)
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

            // Adaptive timeout based on connection quality (increased - acts as safety net)
            // Client should detect and reconnect faster (15s) before these timeouts trigger
            const timeoutDuration = connection.connectionQuality === 'critical' ? 25000 :
                connection.connectionQuality === 'poor' ? 35000 : 45000

            connection.pingTimeout = setTimeout(() => {
                console.log(`💔 Heartbeat timeout for socket ${socket.id} (quality: ${connection.connectionQuality}), disconnecting...`)
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
                    console.error('Error refreshing token:', error)
                    socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
                }
            })
        } catch (error) {
            console.error('Token refresh error:', error)
            socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
        }
    })

    socket.on('updateRecordingPrefs', (prefs) => {
        const connection = activeConnections.get(socket.id);
        if (connection) {
            connection.recordingPrefs = {
                storeText: !!prefs.storeText,
                generateSummary: !!prefs.generateSummary,
                generateFacebookPost: !!prefs.generateFacebookPost
            };
            console.log(`⚙️ Updated recording prefs for ${socket.id}:`, connection.recordingPrefs);
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
                connection.isStreaming = true
                connection.sourceLanguage = sourceLanguage
                connection.messageCount++
                connection.lastActivity = Date.now()

                // Track streaming session start
                if (!connection.streamStartTime) {
                    connection.streamStartTime = Date.now();
                    if (socket.user?.id && !connection.sessionCounted) {
                        connection.sessionCounted = true;
                        User.incrementSessionCount(socket.user.id).catch(() => { });
                    }
                }
            }

            const currentConnection = activeConnections.get(socket.id)
            emitConnectionCount(currentConnection?.sessionCode)

            if (currentConnection?.sessionCode) {
                const sessionCodeConnections = Array.from(activeConnections.entries())
                    .filter(([_, conn]) => conn.sessionCode === currentConnection.sessionCode)
                    .map(([socketId, _]) => socketId)

                const translationConnections = sessionCodeConnections.filter(socketId => {
                    const conn = activeConnections.get(socketId)
                    return conn && !conn.isStreaming && conn.targetLanguage
                })

                sessionCodeConnections.forEach(socketId => {
                    const targetSocket = io.sockets.sockets.get(socketId)
                    const conn = activeConnections.get(socketId)
                    if (targetSocket && conn?.userId) {
                        targetSocket.emit('transcriptionComplete', {
                            transcription,
                            sourceLanguage,
                            bubbleId,
                            userId: currentConnection.userId,
                            userEmail: currentConnection.userEmail
                        })
                    }
                })

                if (translationConnections.length > 0) {
                    try {
                        for (const socketId of translationConnections) {
                            const conn = activeConnections.get(socketId)
                            if (conn?.targetLanguage) {
                                const translatedText = await processTranscription(transcription, sourceLanguage, conn.targetLanguage)

                                // Use message queue for guaranteed delivery
                                if (messageQueue) {
                                    messageQueue.queueMessage(socketId, {
                                        originalText: transcription,
                                        translatedText,
                                        sourceLanguage,
                                        targetLanguage: conn.targetLanguage,
                                        bubbleId,
                                        userId: currentConnection.userId,
                                        userEmail: currentConnection.userEmail
                                    })
                                }
                            }
                        }
                    } catch (error) {
                        console.error('Translation error:', error)
                        translationConnections.forEach(socketId => {
                            const targetSocket = io.sockets.sockets.get(socketId)
                            if (targetSocket) {
                                targetSocket.emit('translationError', {
                                    error: 'Translation failed',
                                    bubbleId
                                })
                            }
                        })
                    }
                }
            } else {
                io.emit('transcriptionComplete', {
                    transcription,
                    sourceLanguage,
                    bubbleId,
                    userId: currentConnection?.userId,
                    userEmail: currentConnection?.userEmail
                })
            }

        } catch (error) {
            console.error('Error processing speech transcription:', error)

            // Track error for connection quality monitoring
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
                connection.isStreaming = true
                connection.sourceLanguage = sourceLanguage
                connection.speechEndTimeout = speechEndTimeout

                // Track streaming session start
                if (!connection.streamStartTime) {
                    connection.streamStartTime = Date.now();
                    if (socket.user?.id && !connection.sessionCounted) {
                        connection.sessionCounted = true;
                        User.incrementSessionCount(socket.user.id).catch(() => { });
                    }
                }
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

                                // Store the stream for this socket
                                if (recognizeStream) {
                                    streamingSessions.set(socket.id, recognizeStream);
                                } else {
                                    console.error('❌ Stream creation returned null/undefined for socket:', socket.id);
                                }
                            } catch (streamError) {
                                console.error('❌ Failed to create streaming recognition:', streamError);
                                console.error('Error details:', {
                                    message: streamError.message,
                                    stack: streamError.stack,
                                    sourceLanguage: sourceLanguage
                                });
                                socket.emit('error', {
                                    message: 'Failed to start speech recognition: ' + streamError.message
                                });
                                return; // Don't try to send audio if stream creation failed
                            }
                        }

                        // Check if we're in the middle of a stream restart - buffer the audio
                        if (restartingStreams.get(socket.id)) {
                            const buffer = audioBufferDuringRestart.get(socket.id) || [];
                            buffer.push(audioBuffer);
                            audioBufferDuringRestart.set(socket.id, buffer);
                            // Limit buffer size to prevent memory issues (keep last 100 chunks ~2 seconds of audio)
                            if (buffer.length > 100) {
                                buffer.shift();
                            }
                            // #region agent log
                            if (buffer.length % 25 === 1) __dbg('server.js:audio', 'AUDIO buffering during restart', { socketId: socket.id, bufferLen: buffer.length, rotating: !!rotatingStreams.get(socket.id) })
                            // #endregion
                            return; // Don't try to send to stream while restarting
                        }

                        // Send audio chunk to Google Cloud streaming (only to active stream)
                        const recognizeStream = streamingSessions.get(socket.id);
                        if (recognizeStream && !recognizeStream.destroyed) {
                            // Send audio only to active stream (standby streams don't receive audio until activated)
                            speechToTextService.sendAudioToStream(recognizeStream, audioBuffer);
                            // #region agent log
                            if ((++__dbgAudioCount) % 150 === 0) __dbg('server.js:audio', 'AUDIO sent to active stream', { socketId: socket.id, counter: __dbgAudioCount })
                            // #endregion
                        } else {
                            // #region agent log
                            __dbg('server.js:audio', 'AUDIO no valid stream', { socketId: socket.id, hasStream: !!recognizeStream, destroyed: recognizeStream?.destroyed, restarting: !!restartingStreams.get(socket.id), sessionExists: streamingSessions.has(socket.id) })
                            // #endregion
                            // Only log error if we're not in a transient state
                            if (!restartingStreams.get(socket.id)) {
                                console.error('❌ No valid stream found for socket:', socket.id, {
                                    hasStream: !!recognizeStream,
                                    isDestroyed: recognizeStream?.destroyed,
                                    sessionExists: streamingSessions.has(socket.id)
                                });
                            }
                        }
                    } else {
                    }
                } catch (speechError) {
                    console.error('❌ Google Cloud Speech-to-Text error:', speechError)
                    socket.emit('error', {
                        message: 'Speech recognition failed: ' + speechError.message
                    })
                }
            }

            // Handle manual finalization (when frontend sends final transcript)
            if (finalTranscript && isFinal && !audioData) {
                if (currentConnection?.sessionCode) {
                    const sessionCodeConnections = Array.from(activeConnections.entries())
                        .filter(([_, conn]) => conn.sessionCode === currentConnection.sessionCode)
                        .map(([socketId, _]) => socketId)

                    const translationConnections = sessionCodeConnections.filter(socketId => {
                        const conn = activeConnections.get(socketId)
                        return conn && !conn.isStreaming && conn.targetLanguage
                    })

                    sessionCodeConnections.forEach(socketId => {
                        const targetSocket = io.sockets.sockets.get(socketId)
                        const conn = activeConnections.get(socketId)
                        if (targetSocket && conn?.userId) {
                            targetSocket.emit('transcriptionComplete', {
                                transcription: finalTranscript,
                                sourceLanguage,
                                bubbleId,
                                userId: currentConnection.userId,
                                userEmail: currentConnection.userEmail
                            })
                        }
                    })

                    if (translationConnections.length > 0) {
                        try {
                            const translations = await Promise.all(
                                translationConnections.map(async (socketId) => {
                                    const conn = activeConnections.get(socketId)
                                    if (conn?.targetLanguage) {
                                        const translation = await processTranscription(
                                            finalTranscript,
                                            sourceLanguage,
                                            conn.targetLanguage
                                        )
                                        return { socketId, translation, targetLanguage: conn.targetLanguage }
                                    }
                                    return null
                                })
                            )

                            translations.filter(Boolean).forEach(({ socketId, translation, targetLanguage }) => {
                                if (socketId && translation && messageQueue) {
                                    messageQueue.queueMessage(socketId, {
                                        originalText: finalTranscript,
                                        translatedText: translation,
                                        sourceLanguage,
                                        targetLanguage,
                                        bubbleId
                                    })
                                }
                            })
                        } catch (translationError) {
                            console.error('Translation error:', translationError)
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
                } else {
                    io.emit('transcriptionComplete', {
                        transcription: finalTranscript,
                        sourceLanguage,
                        bubbleId,
                        userId: currentConnection?.userId,
                        userEmail: currentConnection?.userEmail
                    })
                }

                lastInterimBySocket.delete(socket.id)
                if (speechToTextService.isRotationArmed(socket.id)) {
                    await rotateStream(socket)
                }
            }

        } catch (error) {
            console.error('Error processing Google Cloud speech transcription:', error)
            socket.emit('error', { message: 'Failed to process speech transcription: ' + error.message })
        }
    })


    socket.on('stopStreaming', async () => {
        const connection = activeConnections.get(socket.id)
        if (connection) {
            connection.isStreaming = false

            // Background processing of accumulated transcript
            handleBackgroundProcessing(socket.id, connection);

            // Record usage minutes
            if (connection.streamStartTime && socket.user?.id) {
                const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
                if (usageMinutes >= 0.1) {
                    User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => { });
                }
                connection.streamStartTime = null;
            }
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

    // Handle client request for stream restart (e.g., when client detects hung stream)
    socket.on('requestStreamRestart', async (data) => {
        console.log(`🔄 Client ${socket.id} requested stream restart: ${data?.reason || 'unknown'}`);

        // End existing stream
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
            if (messageQueue && connection.sessionCode && data.targetLanguage) {
                messageQueue.bindSocket(socket.id, connection.sessionCode, data.targetLanguage)
            }
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

        const connectionsByLanguage = {}
        let totalConnections = 0

        activeConnections.forEach((connection) => {
            if (sessionCode && connection.sessionCode !== sessionCode) {
                return
            }

            if (!connection.sessionCode) {
                return
            }

            totalConnections++
            if (connection.targetLanguage) {
                connectionsByLanguage[connection.targetLanguage] = (connectionsByLanguage[connection.targetLanguage] || 0) + 1
            }
        })

        const connectionData = {
            total: totalConnections,
            byLanguage: connectionsByLanguage
        }

        socket.emit('connectionCount', connectionData)
    })

    socket.on('disconnect', async () => {
        const connection = activeConnections.get(socket.id)

        // #region agent log
        __dbg('server.js:disconnect', 'DISCONNECT', { socketId: socket.id, user: connection?.userEmail || 'listener', isStreaming: !!connection?.isStreaming, hasStream: streamingSessions.has(socket.id), armed: speechToTextService.isRotationArmed(socket.id), restarting: !!restartingStreams.get(socket.id) })
        // #endregion
        const connectionAgeSeconds = connection?.connectedAt
            ? Math.round((Date.now() - connection.connectedAt) / 1000)
            : null
        console.log(`🔌 Disconnect: ${socket.id} (user: ${connection?.userEmail || 'listener'}, age: ${connectionAgeSeconds ?? 'unknown'}s)`)
        console.log(`📊 Total connections before remove: ${activeConnections.size}`)

        // Clean up ping timeout
        if (connection && connection.pingTimeout) {
            clearTimeout(connection.pingTimeout)
        }

        // Background processing of accumulated transcript
        if (connection) {
            handleBackgroundProcessing(socket.id, connection);
        }

        // Record usage minutes if user was streaming when disconnected
        if (connection?.streamStartTime && socket.user?.id) {
            const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
            if (usageMinutes >= 0.1) {
                User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => { });
            }
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
        const socketPrefix = `${socket.id}-`;
        for (const [key, _] of processedTranscripts.entries()) {
            if (key.startsWith(socketPrefix)) {
                processedTranscripts.delete(key);
            }
        }

        // Log connection quality metrics before cleanup
        if (connection) {
            const sessionDuration = Date.now() - connection.lastActivity
            const errorRate = connection.errorCount / Math.max(connection.messageCount, 1)
            console.log(`📊 Connection metrics for ${socket.user?.email || 'Listener'}:`, {
                duration: `${Math.round(sessionDuration / 1000)}s`,
                messages: connection.messageCount,
                errors: connection.errorCount,
                errorRate: `${Math.round(errorRate * 100)}%`,
                quality: connection.connectionQuality
            })
        }

        activeConnections.delete(socket.id)

        console.log(`📊 Total connections after remove: ${activeConnections.size}`)

        emitConnectionCount(connection?.sessionCode)
    })
})

// Periodic cleanup of orphaned connections (every 30 seconds)
setInterval(() => {
    const orphanedConnections = [];

    activeConnections.forEach((conn, socketId) => {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket || !socket.connected) {
            orphanedConnections.push(socketId);
        }
    });

    if (orphanedConnections.length > 0) {
        console.log(`🧹 [Cleanup] Found ${orphanedConnections.length} orphaned connections, cleaning up...`);
        orphanedConnections.forEach(socketId => {
            const conn = activeConnections.get(socketId);
            console.log(`  - Removing orphan: ${socketId} (user: ${conn?.userEmail || 'listener'})`);

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

        // Emit updated connection count
        emitConnectionCount();
        console.log(`📊 Total connections after cleanup: ${activeConnections.size}`);
    }
}, 30000);

async function notifyInterimTranscription(socket, sourceLanguage, interimText) {
    const currentConnection = activeConnections.get(socket.id);
    if (!currentConnection?.sessionCode) return;

    const sessionCodeConnections = Array.from(activeConnections.entries())
        .filter(([_, conn]) => conn.sessionCode === currentConnection.sessionCode)
        .map(([socketId, _]) => socketId);

    const translationConnections = sessionCodeConnections.filter(socketId => {
        const conn = activeConnections.get(socketId);
        return conn && !conn.isStreaming && conn.targetLanguage;
    });

    if (translationConnections.length === 0) return;

    const listenersByLanguage = new Map();
    translationConnections.forEach(socketId => {
        const conn = activeConnections.get(socketId);
        if (conn?.targetLanguage) {
            if (!listenersByLanguage.has(conn.targetLanguage)) {
                listenersByLanguage.set(conn.targetLanguage, []);
            }
            listenersByLanguage.get(conn.targetLanguage).push(socketId);
        }
    });

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

            if (throttleEntry && (now - throttleEntry.timestamp) < INTERIM_THROTTLE_MS) {
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
                    console.error(`❌ Interim translation error (${sourceLanguage} → ${targetLanguage}):`, error.message);
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
async function handleFinalTranscription(socket, transcript, sourceLanguage, activeBubbleId) {
    // Accumulate the transcript
    const currentText = sessionTranscripts.get(socket.id) || '';
    sessionTranscripts.set(socket.id, currentText + (currentText ? ' ' : '') + transcript);

    const currentConnection = activeConnections.get(socket.id);
    if (!currentConnection?.sessionCode) return;

    const sessionCodeConnections = Array.from(activeConnections.entries())
        .filter(([_, conn]) => conn.sessionCode === currentConnection.sessionCode)
        .map(([socketId, _]) => socketId);

    const translationConnections = sessionCodeConnections.filter(socketId => {
        const conn = activeConnections.get(socketId);
        return conn && !conn.isStreaming && conn.targetLanguage;
    });


    // Send transcription to input clients
    sessionCodeConnections.forEach(socketId => {
        const targetSocket = io.sockets.sockets.get(socketId);
        const conn = activeConnections.get(socketId);
        if (targetSocket && conn?.userId) {
            targetSocket.emit('transcriptionComplete', {
                transcription: transcript,
                sourceLanguage,
                bubbleId: activeBubbleId,
                userId: currentConnection.userId,
                userEmail: currentConnection.userEmail
            });
        }
    });

    // Process translations
    if (translationConnections.length > 0) {
        try {
            const translations = await Promise.all(
                translationConnections.map(async (socketId) => {
                    const conn = activeConnections.get(socketId);
                    if (conn?.targetLanguage) {
                        const translation = await processTranscription(
                            transcript,
                            sourceLanguage,
                            conn.targetLanguage
                        );
                        return { socketId, translation, targetLanguage: conn.targetLanguage };
                    }
                    return null;
                })
            );

            translations.filter(Boolean).forEach(({ socketId, translation, targetLanguage }) => {
                if (socketId && translation && messageQueue) {
                    messageQueue.queueMessage(socketId, {
                        originalText: transcript,
                        translatedText: translation,
                        sourceLanguage,
                        targetLanguage,
                        bubbleId: activeBubbleId
                    });
                }
            });
        } catch (translationError) {
            console.error('Translation error:', translationError);
            translationConnections.forEach(socketId => {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) {
                    targetSocket.emit('translationError', {
                        message: 'Translation failed: ' + translationError.message,
                        bubbleId: activeBubbleId
                    });
                }
            });
        }
    }
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
        // Simple health check that doesn't depend on external services
        res.status(200).json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            port: config.PORT,
            environment: config.NODE_ENV
        })
    } catch (error) {
        console.error('Health check error:', error);
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
        console.error('TTS endpoint error:', error)
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

app.get('/api/sessions', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;
        const sessions = await Session.findByUserId(userId, limit);
        res.json({ sessions });
    } catch (error) {
        console.error('Error fetching sessions:', error);
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
        console.error('Error deleting session:', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
})

app.use((err, req, res, next) => {
    console.error(err.stack)
    res.status(500).json({ error: 'Something went wrong!' })
})

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' })
})

const startServer = async () => {
    try {
        console.log('🔧 Starting server initialization...')
        console.log(`📊 Environment: ${config.NODE_ENV}`)
        console.log(`🌐 Port: ${config.PORT}`)
        console.log(`🏠 Host: ${config.HOST}`)

        await new Promise((resolve, reject) => {
            server.listen(config.PORT, config.HOST, () => {
                console.log(`🚀 Server listening on ${config.HOST}:${config.PORT}`)
                resolve()
            })
            server.on('error', reject)
        })

        console.log('🔧 Starting Firestore initialization...')
        try {
            await initFirestore()
            console.log('✅ Firestore initialized')
        } catch (dbError) {
            console.error('❌ Firestore initialization failed:', dbError.message)
            console.log('⚠️ Server will continue but database features may not work')
        }

        try {
            await speechToTextService.getSpeechClient()
            console.log('✅ Google Cloud Speech client initialized')
        } catch (error) {
            console.warn('⚠️ Google Cloud Speech client initialization failed:', error.message)
            console.log('⚠️ Continuing without Google Cloud Speech (transcription will not work)')
        }

        setInterval(() => {
            const now = Date.now()
            for (const [key, timestamp] of processedTranscripts.entries()) {
                if (now - timestamp > 10 * 60 * 1000) {
                    processedTranscripts.delete(key)
                }
            }

            // Log connection statistics
            console.log(`📊 Active connections: ${activeConnections.size}, Processed transcripts: ${processedTranscripts.size}`)
        }, 5 * 60 * 1000)

        console.log('✅ Server is ready to accept connections')
    } catch (error) {
        console.error('❌ Failed to start server:', error)
        process.exit(1)
    }
}

const gracefulShutdown = (signal) => {
    console.log(`🛑 Received ${signal}, shutting down gracefully...`)
    server.close(() => {
        console.log('✅ Server closed')
        process.exit(0)
    })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

startServer()
