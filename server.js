const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config()
const config = require('./src/config')
const { authenticateSocket } = require('./src/middleware/auth')
const authRoutes = require('./src/routes/auth')
const { initFirestore } = require('./src/database/firestore')
const User = require('./src/models/User')
const speechToTextService = require('./src/services/speechToTextService')
const googleTranslationService = require('./src/services/googleTranslationService')
const textToSpeechService = require('./src/services/textToSpeechService')
const app = express()
const server = http.createServer(app)

app.use(cors({
  origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}))

const io = socketIo(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
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
const processedTranscripts = new Map() // Track processed transcripts to prevent duplicates
const restartingStreams = new Map() // Track sockets that are currently restarting their stream
const audioBufferDuringRestart = new Map() // Buffer audio during stream restart
const currentBubbleIds = new Map() // Track current bubbleId per socket (updated by incoming audio)
const contentHashes = new Map() // Track content hashes for deduplication
const typingIndicatorTimeouts = new Map() // Track typing indicator timeouts per socket

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
    this.queues = new Map() // Per-listener message queues: socketId -> Map<messageId, message>
    this.retryInterval = 2000 // Retry every 2 seconds
    this.maxRetries = 5
    this.messageExpiry = 30000 // Messages expire after 30 seconds
    this.sequenceNumbers = new Map() // Per-listener sequence numbers
    
    // Start the retry loop
    this.startRetryLoop()
  }
  
  generateMessageId() {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
  
  getNextSequence(socketId) {
    const current = this.sequenceNumbers.get(socketId) || 0
    const next = current + 1
    this.sequenceNumbers.set(socketId, next)
    return next
  }
  
  // Queue a message for delivery to a specific listener
  queueMessage(socketId, message) {
    if (!this.queues.has(socketId)) {
      this.queues.set(socketId, new Map())
    }
    
    const messageId = this.generateMessageId()
    const sequence = this.getNextSequence(socketId)
    
    const queuedMessage = {
      ...message,
      messageId,
      sequence,
      timestamp: Date.now(),
      attempts: 0,
      acknowledged: false
    }
    
    this.queues.get(socketId).set(messageId, queuedMessage)
    
    // Attempt immediate delivery
    this.deliverMessage(socketId, queuedMessage)
    
    return messageId
  }
  
  // Attempt to deliver a message
  deliverMessage(socketId, message) {
    const socket = this.io.sockets.sockets.get(socketId)
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
    const queue = this.queues.get(socketId)
    if (!queue) return false
    
    const message = queue.get(messageId)
    if (!message) return false
    
    message.acknowledged = true
    queue.delete(messageId)
    return true
  }
  
  // Get pending messages for a listener (for recovery after reconnect)
  getPendingMessages(socketId) {
    const queue = this.queues.get(socketId)
    if (!queue) return []
    
    return Array.from(queue.values())
      .filter(m => !m.acknowledged)
      .sort((a, b) => a.sequence - b.sequence)
  }
  
  // Clean up listener's queue on disconnect
  cleanupListener(socketId) {
    this.queues.delete(socketId)
    this.sequenceNumbers.delete(socketId)
  }
  
  // Retry loop for unacknowledged messages
  startRetryLoop() {
    setInterval(() => {
      const now = Date.now()
      
      for (const [socketId, queue] of this.queues.entries()) {
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
              this.deliverMessage(socketId, message)
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

const emitConnectionCount = (userCode = null) => {
  const connectionsByLanguage = {}
  let totalConnections = 0
  
  activeConnections.forEach((connection) => {
    if (userCode && connection.userCode !== userCode) {
      return
    }
    
    if (!connection.userCode) {
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
  
  if (userCode) {
    const userCodeConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.userCode === userCode)
      .map(([socketId, _]) => socketId)
    
    
    userCodeConnections.forEach(socketId => {
      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.emit('connectionCount', connectionData)
      }
    })
  } else {
    const validConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.userCode)
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

io.on('connection', async (socket) => {
  
  activeConnections.set(socket.id, {
    userId: socket.user?.id,
    userEmail: socket.user?.email,
    userCode: socket.userCode,
    isStreaming: false,
    sourceLanguage: null,
    targetLanguage: null,
    needsTokenRefresh: socket.needsTokenRefresh || false,
    lastPing: Date.now(),
    pingTimeout: null,
    connectionQuality: 'good', // good, poor, critical
    messageCount: 0,
    errorCount: 0,
    lastActivity: Date.now(),
    streamStartTime: null,  // Track when streaming session started
    sessionCounted: false   // Prevent double-counting sessions
  })
  
  // Update lastActive for authenticated users
  if (socket.user?.id) {
    try {
      await User.updateLastActive(socket.user.id);
    } catch (err) {
      console.warn('⚠️ Failed to update lastActive:', err.message);
    }
  }

  // Set up heartbeat mechanism
  const connection = activeConnections.get(socket.id)
  if (connection) {
    // Set initial ping timeout (30 seconds)
    connection.pingTimeout = setTimeout(() => {
      console.log(`💔 Heartbeat timeout for socket ${socket.id}, disconnecting...`)
      socket.disconnect(true)
    }, 30000)
  }

  if (socket.needsTokenRefresh) {
    socket.emit('tokenExpired', {
      message: 'Your session has expired. Please refresh your token.',
      code: 'TOKEN_EXPIRED'
    })
  }
  
  emitConnectionCount(socket.userCode)

  // Handle ping/pong for heartbeat
  socket.on('ping', () => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.lastPing = Date.now()
      connection.lastActivity = Date.now()
      
      // Update connection quality based on ping frequency
      const timeSinceLastPing = Date.now() - connection.lastPing
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
      
      // Adaptive timeout based on connection quality
      const timeoutDuration = connection.connectionQuality === 'critical' ? 15000 : 
                            connection.connectionQuality === 'poor' ? 25000 : 30000
      
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
            User.incrementSessionCount(socket.user.id).catch(() => {});
          }
        }
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.userCode)
      
      if (currentConnection?.userCode) {
        const userCodeConnections = Array.from(activeConnections.entries())
          .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
          .map(([socketId, _]) => socketId)
        
        const translationConnections = userCodeConnections.filter(socketId => {
          const conn = activeConnections.get(socketId)
          return conn && !conn.isStreaming && conn.targetLanguage
        })
        
        userCodeConnections.forEach(socketId => {
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
          // Clear any standby streams for this socket
          speechToTextService.cleanupStandbyStream(socket.id);
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
        
        // Track streaming session start
        if (!connection.streamStartTime) {
          connection.streamStartTime = Date.now();
          if (socket.user?.id && !connection.sessionCounted) {
            connection.sessionCounted = true;
            User.incrementSessionCount(socket.user.id).catch(() => {});
          }
        }
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.userCode)
      
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
                const recognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, speechEndTimeout, {
                onResult: async (result) => {
                  // Use tracked bubbleId (updated by incoming audio) to handle stream restarts
                  const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                  
                  // Send transcription result to frontend (no filtering/duplicate removal)
                  socket.emit('transcriptionUpdate', {
                    transcript: result.transcript,
                    isFinal: result.isFinal,
                    confidence: result.confidence,
                    bubbleId: activeBubbleId
                  });

                  // Notify listeners when interim results come in
                  if (!result.isFinal && result.transcript && result.transcript.trim()) {
                    notifyInterimTranscription(socket, sourceLanguage);
                  }

                  // Handle translation for final results
                  if (result.isFinal && result.transcript.trim()) {
                    // Stop typing indicator when final result comes in
                    const currentConnection = activeConnections.get(socket.id);
                    if (currentConnection?.userCode) {
                      const userCodeConnections = Array.from(activeConnections.entries())
                        .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                        .map(([socketId, _]) => socketId);
                      
                      const translationConnections = userCodeConnections.filter(socketId => {
                        const conn = activeConnections.get(socketId);
                        return conn && !conn.isStreaming && conn.targetLanguage;
                      });
                      
                      translationConnections.forEach(socketId => {
                        const targetSocket = io.sockets.sockets.get(socketId);
                        if (targetSocket) {
                          targetSocket.emit('speakerTyping', { isTyping: false });
                        }
                      });
                      
                      // Clear timeout
                      if (typingIndicatorTimeouts.has(socket.id)) {
                        clearTimeout(typingIndicatorTimeouts.get(socket.id));
                        typingIndicatorTimeouts.delete(socket.id);
                      }
                    }
                    // Notify frontend that we've received a final result
                    socket.emit('finalResultReceived', { bubbleId: activeBubbleId });
                    
                    // Process final transcription (translation and delivery) - no duplicate filtering
                    await handleFinalTranscription(socket, result.transcript, sourceLanguage, activeBubbleId);
                  }
                },
                onError: (error) => {
                  console.error('❌ Google Cloud streaming error:', error);
                  
                  // Attempt to recover from common errors
                  if (error.code === 14 || error.message.includes('UNAVAILABLE')) {
                    setTimeout(() => {
                      if (socket.connected) {
                        socket.emit('streamRestart', { 
                          reason: 'recovery', 
                          error: error.message 
                        });
                      }
                    }, 1000);
                  }
                },
                onEnd: () => {
                  // Stream ended - this is normal with singleUtterance: true
                  // Clear the session so a new stream will be created when new audio arrives
                  streamingSessions.delete(socket.id);
                },
                // Create standby stream 1 minute before limit (called at 4 minutes)
                onPreRestart: async () => {
                  
                  const currentStream = streamingSessions.get(socket.id);
                  if (!currentStream) {
                    return;
                  }
                  
                  try {
                    // Create standby stream (not receiving audio yet)
                    await speechToTextService.createStandbyStream(
                      socket.id,
                      sourceLanguage,
                      speechEndTimeout,
                      {
                        onResult: async (result) => {
                          // This will be used when standby is activated
                          const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                          socket.emit('transcriptionUpdate', {
                            transcript: result.transcript,
                            isFinal: result.isFinal,
                            confidence: result.confidence,
                            bubbleId: activeBubbleId
                          });

                          // Notify listeners when interim results come in
                          if (!result.isFinal && result.transcript && result.transcript.trim()) {
                            notifyInterimTranscription(socket, sourceLanguage);
                          }

                          if (result.isFinal && result.transcript.trim()) {
                            // Stop typing indicator when final result comes in
                            const currentConnection = activeConnections.get(socket.id);
                            if (currentConnection?.userCode) {
                              const userCodeConnections = Array.from(activeConnections.entries())
                                .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                                .map(([socketId, _]) => socketId);
                              
                              const translationConnections = userCodeConnections.filter(socketId => {
                                const conn = activeConnections.get(socketId);
                                return conn && !conn.isStreaming && conn.targetLanguage;
                              });
                              
                              translationConnections.forEach(socketId => {
                                const targetSocket = io.sockets.sockets.get(socketId);
                                if (targetSocket) {
                                  targetSocket.emit('speakerTyping', { isTyping: false });
                                }
                              });
                              
                              // Clear timeout
                              if (typingIndicatorTimeouts.has(socket.id)) {
                                clearTimeout(typingIndicatorTimeouts.get(socket.id));
                                typingIndicatorTimeouts.delete(socket.id);
                              }
                            }
                            // Notify frontend that we've received a final result
                            socket.emit('finalResultReceived', { bubbleId: activeBubbleId });
                            
                            // Process final transcription (translation and delivery) - no duplicate filtering
                            await handleFinalTranscription(socket, result.transcript, sourceLanguage, activeBubbleId);
                          }
                        },
                        onError: (error) => {
                          console.error('❌ Standby stream error:', error);
                        },
                        onEnd: () => {
                        },
                        // Standby streams don't need onPreRestart/onRestart - they become the active stream
                        // and will get their own callbacks when activated
                        onPreRestart: null,
                        onRestart: null
                      }
                    );
                    
                  } catch (error) {
                    console.error('❌ Failed to create standby stream:', error);
                  }
                },
                onError: (error) => {
                  console.error('❌ Google Cloud streaming error:', error);
                  
                  // Attempt to recover from common errors
                  if (error.code === 14 || error.message.includes('UNAVAILABLE')) {
                    setTimeout(() => {
                      if (socket.connected) {
                        socket.emit('streamRestart', { 
                          reason: 'recovery', 
                          error: error.message 
                        });
                      }
                    }, 1000);
                  }
                },
                onEnd: () => {
                  // Stream ended - this is normal with singleUtterance: true
                  // Clear the session so a new stream will be created when new audio arrives
                  streamingSessions.delete(socket.id);
                },
                // Create standby stream 1 minute before limit (called at 4 minutes)
                onPreRestart: async () => {
                  
                  const currentStream = streamingSessions.get(socket.id);
                  if (!currentStream) {
                    return;
                  }
                  
                  // Check if standby already exists
                  if (speechToTextService.hasStandbyStream(socket.id)) {
                    return;
                  }
                  
                  try {
                    // Create standby stream (not receiving audio yet)
                    await speechToTextService.createStandbyStream(
                      socket.id,
                      sourceLanguage,
                      speechEndTimeout,
                      {
                        onResult: async (result) => {
                          // This will be used when standby is activated
                          const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                          socket.emit('transcriptionUpdate', {
                            transcript: result.transcript,
                            isFinal: result.isFinal,
                            confidence: result.confidence,
                            bubbleId: activeBubbleId
                          });

                          // Notify listeners when interim results come in
                          if (!result.isFinal && result.transcript && result.transcript.trim()) {
                            notifyInterimTranscription(socket, sourceLanguage);
                          }

                          if (result.isFinal && result.transcript.trim()) {
                            // Stop typing indicator when final result comes in
                            const currentConnection = activeConnections.get(socket.id);
                            if (currentConnection?.userCode) {
                              const userCodeConnections = Array.from(activeConnections.entries())
                                .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                                .map(([socketId, _]) => socketId);
                              
                              const translationConnections = userCodeConnections.filter(socketId => {
                                const conn = activeConnections.get(socketId);
                                return conn && !conn.isStreaming && conn.targetLanguage;
                              });
                              
                              translationConnections.forEach(socketId => {
                                const targetSocket = io.sockets.sockets.get(socketId);
                                if (targetSocket) {
                                  targetSocket.emit('speakerTyping', { isTyping: false });
                                }
                              });
                              
                              // Clear timeout
                              if (typingIndicatorTimeouts.has(socket.id)) {
                                clearTimeout(typingIndicatorTimeouts.get(socket.id));
                                typingIndicatorTimeouts.delete(socket.id);
                              }
                            }
                            
                            await handleFinalTranscription(socket, result.transcript, sourceLanguage, activeBubbleId);
                          }
                        },
                        onError: (error) => {
                          console.error('❌ Standby stream error:', error);
                        },
                        onEnd: () => {
                        },
                        // Standby streams don't need onPreRestart/onRestart - they become the active stream
                        // and will get their own callbacks when activated
                        onPreRestart: null,
                        onRestart: null
                      }
                    );
                    
                  } catch (error) {
                    console.error('❌ Failed to create standby stream:', error);
                  }
                },
                // Fallback restart (for error recovery)
                onRestart: (async function restartStream() {
                  
                  // Mark this socket as restarting to buffer incoming audio
                  restartingStreams.set(socket.id, true);
                  audioBufferDuringRestart.set(socket.id, []);
                  
                  // Notify the speaker to save any displayed interim text
                  socket.emit('streamRestart', { 
                    reason: '5-minute-limit-or-recovery',
                    timestamp: Date.now()
                  });
                  
                  // Properly end current stream
                  if (recognizeStream) {
                    speechToTextService.endStreamingRecognition(recognizeStream);
                    recognizeStream.removeAllListeners();
                  }
                  
                  // Clear the session mapping
                  streamingSessions.delete(socket.id);
                  
                  // Clear any processed transcripts for this socket to prevent conflicts
                  const socketPrefix = `${socket.id}-`;
                  for (const [key, _] of processedTranscripts.entries()) {
                    if (key.startsWith(socketPrefix)) {
                      processedTranscripts.delete(key);
                    }
                  }
                  
                  // Create new stream
                  const newRecognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, speechEndTimeout, {
                    onResult: async (result) => {
                      // Use tracked bubbleId (updated by incoming audio) to handle stream restarts
                      const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                      
                      socket.emit('transcriptionUpdate', {
                        transcript: result.transcript,
                        isFinal: result.isFinal,
                        confidence: result.confidence,
                        bubbleId: activeBubbleId
                      });

                      // Notify listeners when interim results come in
                      if (!result.isFinal && result.transcript && result.transcript.trim()) {
                        notifyInterimTranscription(socket, sourceLanguage);
                      }

                      // Handle translation for final results
                      if (result.isFinal && result.transcript.trim()) {
                        // Stop typing indicator when final result comes in
                        const currentConnection = activeConnections.get(socket.id);
                        if (currentConnection?.userCode) {
                          const userCodeConnections = Array.from(activeConnections.entries())
                            .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                            .map(([socketId, _]) => socketId);
                          
                          const translationConnections = userCodeConnections.filter(socketId => {
                            const conn = activeConnections.get(socketId);
                            return conn && !conn.isStreaming && conn.targetLanguage;
                          });
                          
                          translationConnections.forEach(socketId => {
                            const targetSocket = io.sockets.sockets.get(socketId);
                            if (targetSocket) {
                              targetSocket.emit('speakerTyping', { isTyping: false });
                            }
                          });
                          
                          // Clear timeout
                          if (typingIndicatorTimeouts.has(socket.id)) {
                            clearTimeout(typingIndicatorTimeouts.get(socket.id));
                            typingIndicatorTimeouts.delete(socket.id);
                          }
                        }
                        // Notify frontend that we've received a final result
                        socket.emit('finalResultReceived', { bubbleId: activeBubbleId });
                        
                        if (currentConnection?.userCode) {
                          const userCodeConnections = Array.from(activeConnections.entries())
                            .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                            .map(([socketId, _]) => socketId);
                          
                          const translationConnections = userCodeConnections.filter(socketId => {
                            const conn = activeConnections.get(socketId);
                            return conn && !conn.isStreaming && conn.targetLanguage;
                          });
                          
                          
                          // Send transcription to input clients
                          userCodeConnections.forEach(socketId => {
                            const targetSocket = io.sockets.sockets.get(socketId);
                            const conn = activeConnections.get(socketId);
                            if (targetSocket && conn?.userId) {
                              targetSocket.emit('transcriptionComplete', {
                                transcription: result.transcript,
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
                                      result.transcript,
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
                                    originalText: result.transcript,
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
                      }
                    },
                    onError: (error) => {
                      console.error('❌ Google Cloud streaming error:', error);
                      
                      // Attempt to recover from common errors
                      if (error.code === 14 || error.message.includes('UNAVAILABLE')) {
                        setTimeout(() => {
                          if (socket.connected) {
                            socket.emit('streamRestart', { 
                              reason: 'recovery', 
                              error: error.message 
                            });
                          }
                        }, 1000);
                      }
                    },
                    onEnd: () => {
                    },
                    onRestart: restartStream // Recursive restart
                  });
                  
                  // Store new stream
                  if (newRecognizeStream) {
                    streamingSessions.set(socket.id, newRecognizeStream);
                    
                    // Flush buffered audio to the new stream
                    const bufferedAudio = audioBufferDuringRestart.get(socket.id) || [];
                    if (bufferedAudio.length > 0) {
                      for (const audioBuffer of bufferedAudio) {
                        speechToTextService.sendAudioToStream(newRecognizeStream, audioBuffer);
                      }
                    }
                    
                    // Clear restart state
                    restartingStreams.delete(socket.id);
                    audioBufferDuringRestart.delete(socket.id);
                    
                  }
                }
                )});
                
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
              // Log buffering every 50 chunks
              if (buffer.length % 50 === 0) {
              }
              return; // Don't try to send to stream while restarting
            }
            
            // Send audio chunk to Google Cloud streaming (only to active stream)
            const recognizeStream = streamingSessions.get(socket.id);
            if (recognizeStream && !recognizeStream.destroyed) {
              // Send audio only to active stream (standby streams don't receive audio until activated)
              speechToTextService.sendAudioToStream(recognizeStream, audioBuffer);
            } else {
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
        if (currentConnection?.userCode) {
          const userCodeConnections = Array.from(activeConnections.entries())
            .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
            .map(([socketId, _]) => socketId)
          
          const translationConnections = userCodeConnections.filter(socketId => {
            const conn = activeConnections.get(socketId)
            return conn && !conn.isStreaming && conn.targetLanguage
          })
          
          userCodeConnections.forEach(socketId => {
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
      
      // Record usage minutes
      if (connection.streamStartTime && socket.user?.id) {
        const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
        if (usageMinutes >= 0.1) {
          User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => {});
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
  })

  socket.on('setTargetLanguage', (data) => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.targetLanguage = data.targetLanguage
      emitConnectionCount(connection.userCode)
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
      const pendingMessages = messageQueue.getPendingMessages(socket.id)
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
    const userCode = currentConnection?.userCode
    
    const connectionsByLanguage = {}
    let totalConnections = 0
    
    activeConnections.forEach((connection) => {
      if (userCode && connection.userCode !== userCode) {
        return
      }
      
      if (!connection.userCode) {
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
    
    // Clean up ping timeout
    if (connection && connection.pingTimeout) {
      clearTimeout(connection.pingTimeout)
    }
    
    // Record usage minutes if user was streaming when disconnected
    if (connection?.streamStartTime && socket.user?.id) {
      const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
      if (usageMinutes >= 0.1) {
        User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => {});
      }
    }
    
    // Clean up streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
    
    // Clean up restart state
    restartingStreams.delete(socket.id)
    audioBufferDuringRestart.delete(socket.id)
    currentBubbleIds.delete(socket.id)
    
    // Clean up typing indicator timeout
    if (typingIndicatorTimeouts.has(socket.id)) {
      clearTimeout(typingIndicatorTimeouts.get(socket.id))
      typingIndicatorTimeouts.delete(socket.id)
    }
    
    // Clean up any standby streams
    speechToTextService.cleanupStandbyStream(socket.id)
    
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
    
    emitConnectionCount(connection?.userCode)
  })
})

// Helper function to notify listeners when interim transcription is active
function notifyInterimTranscription(socket, sourceLanguage) {
  const currentConnection = activeConnections.get(socket.id);
  if (!currentConnection?.userCode) return;
  
  const userCodeConnections = Array.from(activeConnections.entries())
    .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
    .map(([socketId, _]) => socketId);
  
  const translationConnections = userCodeConnections.filter(socketId => {
    const conn = activeConnections.get(socketId);
    return conn && !conn.isStreaming && conn.targetLanguage;
  });
  
  // Notify all listener connections that speaker is typing
  translationConnections.forEach(socketId => {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.emit('speakerTyping', { isTyping: true });
    }
  });
  
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
  }, 2000);
  
  typingIndicatorTimeouts.set(socket.id, timeout);
}

// Helper function to handle final transcription processing (translation and delivery)
async function handleFinalTranscription(socket, transcript, sourceLanguage, activeBubbleId) {
  // No duplicate filtering - process all final transcripts
  
  // Check if we have a standby stream and switch to it now that transcription is finalized
  if (speechToTextService.hasStandbyStream(socket.id)) {
    const currentStream = streamingSessions.get(socket.id);
    const newStream = speechToTextService.activateStandbyStream(socket.id, currentStream);
    
    if (newStream) {
      streamingSessions.set(socket.id, newStream);
    } else {
      console.error('❌ [STANDBY] Failed to activate standby stream');
    }
  }
  
  const currentConnection = activeConnections.get(socket.id);
  if (!currentConnection?.userCode) return;
  
  const userCodeConnections = Array.from(activeConnections.entries())
    .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
    .map(([socketId, _]) => socketId);
  
  const translationConnections = userCodeConnections.filter(socketId => {
    const conn = activeConnections.get(socketId);
    return conn && !conn.isStreaming && conn.targetLanguage;
  });
  
  
  // Send transcription to input clients
  userCodeConnections.forEach(socketId => {
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
    
    // Start listening on the port FIRST to satisfy Cloud Run health checks
    // This ensures the container responds to health checks quickly
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
    
    // Initialize Google Cloud client in the background to avoid startup delays
    try {
      await speechToTextService.getSpeechClient()
      console.log('✅ Google Cloud Speech client initialized')
    } catch (error) {
      console.warn('⚠️ Google Cloud Speech client initialization failed:', error.message)
      console.log('⚠️ Continuing without Google Cloud Speech (transcription will not work)')
    }
    
    // Set up periodic cleanup to prevent memory leaks
    setInterval(() => {
      const now = Date.now()
      
      // Clean up old processed transcripts (older than 10 minutes)
      for (const [key, timestamp] of processedTranscripts.entries()) {
        if (now - timestamp > 10 * 60 * 1000) {
          processedTranscripts.delete(key)
        }
      }
      
      // Log connection statistics
      console.log(`📊 Active connections: ${activeConnections.size}, Processed transcripts: ${processedTranscripts.size}`)
    }, 5 * 60 * 1000) // Run every 5 minutes
    
    console.log('✅ Server is ready to accept connections')
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

startServer()
