/** In-memory registry for live WebSocket connections (registered from server.js). */

let activeConnectionsRef = null;

function registerActiveConnections(map) {
  activeConnectionsRef = map;
}

function getLiveConnectionsSnapshot() {
  if (!activeConnectionsRef) {
    return { connections: [], groups: [], totalConnections: 0, streamingCount: 0 };
  }

  const now = Date.now();
  const connections = [];
  const groupsMap = new Map();

  for (const [socketId, conn] of activeConnectionsRef.entries()) {
    const entry = {
      socketId,
      userId: conn.userId || null,
      userEmail: conn.userEmail || null,
      sessionCode: conn.sessionCode || null,
      isStreaming: conn.isStreaming === true,
      sourceLanguage: conn.sourceLanguage || null,
      targetLanguage: conn.targetLanguage || null,
      connectedAt: conn.connectedAt || null,
      streamStartTime: conn.streamStartTime || null,
      connectionQuality: conn.connectionQuality || null,
      durationMs: conn.connectedAt ? now - conn.connectedAt : 0,
      streamDurationMs:
        conn.isStreaming && conn.streamStartTime ? now - conn.streamStartTime : 0,
    };
    connections.push(entry);

    const code = conn.sessionCode || 'unknown';
    if (!groupsMap.has(code)) {
      groupsMap.set(code, {
        sessionCode: code,
        speakerEmail: null,
        isStreaming: false,
        listenerCount: 0,
        languages: new Set(),
        connectionCount: 0,
      });
    }
    const group = groupsMap.get(code);
    group.connectionCount += 1;
    if (conn.isStreaming) {
      group.isStreaming = true;
      if (conn.userEmail) group.speakerEmail = conn.userEmail;
    }
    if (conn.userId && conn.userEmail && !conn.targetLanguage) {
      group.speakerEmail = conn.userEmail;
    }
    if (conn.targetLanguage) {
      group.listenerCount += 1;
      group.languages.add(conn.targetLanguage);
    }
    if (conn.sourceLanguage) {
      group.languages.add(conn.sourceLanguage);
    }
  }

  const groups = Array.from(groupsMap.values()).map((g) => ({
    sessionCode: g.sessionCode,
    speakerEmail: g.speakerEmail,
    isStreaming: g.isStreaming,
    listenerCount: g.listenerCount,
    connectionCount: g.connectionCount,
    languages: Array.from(g.languages),
  }));

  return {
    connections,
    groups,
    totalConnections: connections.length,
    streamingCount: connections.filter((c) => c.isStreaming).length,
  };
}

module.exports = {
  registerActiveConnections,
  getLiveConnectionsSnapshot,
};
