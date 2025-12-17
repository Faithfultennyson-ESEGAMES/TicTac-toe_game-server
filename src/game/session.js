require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const { dispatchEvent } = require('../webhooks/dispatcher');
const { checkForWinner } = require('./game_logic');
const sessionLogger = require('../logging/session_logger');
const { notifySessionClosed } = require('../webhooks/matchmaking_notifier');

// --- Constants ---
const sessions = new Map(); // sessionId -> session object
const activePlayerIds = new Map(); // playerId -> sessionId
const sessionsBySocket = new Map(); // socketId -> sessionId

// Use environment variables for configuration with sane defaults
const SESSION_MAX_LIFETIME_MS = parseInt(process.env.SESSION_MAX_LIFETIME_MS, 10) || 3600000; // Default 1 hour
const SESSION_CLEANUP_INTERVAL_MS = 300000; // 5 minutes
const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 12;

// --- Private Functions ---

async function _concludeAndCleanupSession(session) {
    if (!session) return;

    await dispatchEvent('session.ended', session, session.sessionId);

    // Notify the matchmaking service that the session is officially over.
    await notifySessionClosed(session);

    for (const player of session.players) {
        if (player) {
            activePlayerIds.delete(player.playerId);
            if (player.socketId) {
                sessionsBySocket.delete(player.socketId);
            }
        }
    }

    sessions.delete(session.sessionId);
}

async function _cleanupStaleSessions() {
  const now = Date.now();
  console.log('[Session] Running stale session cleanup...');

  for (const session of sessions.values()) {
    if (session.status === 'ended') {
      continue;
    }

    const sessionAge = now - new Date(session.createdAt).getTime();

    if (sessionAge > SESSION_MAX_LIFETIME_MS) {
      console.log(`[Session] Stale session ${session.sessionId} (created at ${session.createdAt}, status: ${session.status}) found. Auto-ending.`);
      await endSession(session.sessionId, 'stale', 'draw', null);
    }
  }
}

// --- Public API ---

function init() {
  setInterval(_cleanupStaleSessions, SESSION_CLEANUP_INTERVAL_MS);
  console.log(`[Session] Stale session cleanup initiated. Will run every ${SESSION_CLEANUP_INTERVAL_MS / 60000} minutes.`);
  console.log(`[Session] Sessions older than ${SESSION_MAX_LIFETIME_MS / 3600000} hour(s) will be terminated.`);
}

async function endSession(sessionId, clientReason, webhookWinState, winnerPlayerId) {
    const session = getSession(sessionId);
    if (!session || session.status === 'ended') {
        return null;
    }

    clearTimeout(session.turnTimerId);
    session.turnTimerId = null;

    session.status = 'ended';
    session.winState = webhookWinState;
    session.winnerPlayerId = winnerPlayerId;

    sessionLogger.finalizeLog(session, { winState: webhookWinState, winnerPlayerId: winnerPlayerId });
    _concludeAndCleanupSession(session);

    return { reason: clientReason, board: session.board };
}

function createSession(turnDurationSec = 10) {
  const sessionId = crypto.randomUUID();
  const session = {
    sessionId,
    status: 'pending',
    players: [],
    board: Array(9).fill(null),
    turnDurationSec,
    createdAt: new Date().toISOString(),
    currentTurnPlayerId: null,
    turnTimerId: null,
    winState: null,
    winnerPlayerId: null,
    turnCount: 0,
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function getAllActiveSessions() {
  const activeSessions = [];
  for (const session of sessions.values()) {
    if (session.status !== 'ended') {
      const sanitizedPlayers = session.players.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        symbol: p.symbol,
      }));

      activeSessions.push({
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt,
        turnDurationSec: session.turnDurationSec,
        turnCount: session.turnCount,
        currentTurnPlayerId: session.currentTurnPlayerId,
        players: sanitizedPlayers,
      });
    }
  }
  return activeSessions;
}

async function addOrReconnectPlayer( sessionId, playerId, playerName, socketId) {
  const session = getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found.' };
  }

  if (activePlayerIds.has(playerId) && activePlayerIds.get(playerId) !== sessionId) {
    return { success: false, error: 'Player already in another session.' };
  }

  const existingPlayer = session.players.find(p => p.playerId === playerId);
  let isReconnect = false;

  if (existingPlayer) {
    isReconnect = true;
    existingPlayer.socketId = socketId;
    sessionsBySocket.set(socketId, sessionId);

    sessionLogger.appendEvent(sessionId, 'player.reconnected', { playerId: playerId });
    await dispatchEvent('player.reconnected', { sessionId, playerId: playerId, status: 'reconnected' }, sessionId);
  } else {
    if (session.players.length >= 2 || session.status !== 'pending') {
      return { success: false, error: 'Session is full or has already started.' };
    }

    const player = {
      playerId,
      playerName,
      socketId,
      symbol: session.players.length === 0 ? 'X' : 'O',
    };
    session.players.push(player);
    activePlayerIds.set(playerId, sessionId);
    sessionsBySocket.set(socketId, sessionId);

    sessionLogger.appendEvent(sessionId, 'player.joined', { playerId: playerId, playerName: playerName });
    await dispatchEvent('player.joined', { sessionId, playerId: playerId, playerName: playerName, status: 'joined' }, sessionId);

    if (session.players.length === 2) {
      session.status = 'active';
      session.currentTurnPlayerId = session.players[0].playerId;
    }
  }

  return { success: true, isReconnect, gameReady: session.status === 'active', session };
}

async function makeMove(sessionId, playerId, position) {
  const session = getSession(sessionId);

  if (!session || session.status !== 'active') {
    return { success: false, error: 'Session not active.' };
  }
  if (playerId !== session.currentTurnPlayerId) {
    return { success: false, error: 'Not your turn.' };
  }
  if (position < 0 || position > 8 || session.board[position] !== null) {
    return { success: false, error: 'Invalid move.' };
  }

  const player = session.players.find(p => p.playerId === playerId);
  const symbolCount = session.board.filter(s => s === player.symbol).length;

  if (symbolCount >= 3) {
    return { success: false, error: 'You have placed all your symbols. You must relocate one.' };
  }

  clearTimeout(session.turnTimerId);
  session.turnTimerId = null;

  session.board[position] = player.symbol;
  session.turnCount++;

  sessionLogger.appendEvent(sessionId, 'move.made', { playerId: playerId, position });

  const winnerSymbol = checkForWinner(session.board);
  if (winnerSymbol) {
    const winner = session.players.find(p => p.symbol === winnerSymbol);
    const payload = await endSession(sessionId, 'win', 'win', winner.playerId);
    return { success: true, gameEnded: true, payload };
  }

  if (session.turnCount >= MAX_TURNS) {
    const payload = await endSession(sessionId, 'draw', 'draw', null);
    return { success: true, gameEnded: true, payload };
  }

  const otherPlayer = session.players.find(p => p.playerId !== playerId);
  session.currentTurnPlayerId = otherPlayer.playerId;
  return { success: true, gameEnded: false, board: session.board, nextTurnPlayerId: session.currentTurnPlayerId };
}

async function relocateMove(sessionId, playerId, from, to) {
    const session = getSession(sessionId);

    if (!session || session.status !== 'active') {
        return { success: false, error: 'Session not active.' };
    }
    if (playerId !== session.currentTurnPlayerId) {
        return { success: false, error: 'Not your turn.' };
    }
    const player = session.players.find(p => p.playerId === playerId);
    if (!player) {
        return { success: false, error: 'Player not in session.' };
    }

    if (from < 0 || from > 8 || to < 0 || to > 8) {
        return { success: false, error: 'Invalid move coordinates.' };
    }
    if (session.board[from] !== player.symbol) {
        return { success: false, error: 'The "from" position does not contain your symbol.' };
    }
    if (session.board[to] !== null) {
        return { success: false, error: 'The "to" position is already occupied.' };
    }
    
    const symbolCount = session.board.filter(s => s === player.symbol).length;
    if (symbolCount < 3) {
      return { success: false, error: 'You must place all your symbols before you can relocate.' };
    }

    clearTimeout(session.turnTimerId);
    session.turnTimerId = null;

    session.board[from] = null;
    session.board[to] = player.symbol;
    session.turnCount++;

    sessionLogger.appendEvent(sessionId, 'move.relocated', { playerId, from, to });

    const winnerSymbol = checkForWinner(session.board);
    if (winnerSymbol) {
        const winner = session.players.find(p => p.symbol === winnerSymbol);
        const payload = await endSession(sessionId, 'win', 'win', winner.playerId);
        return { success: true, gameEnded: true, payload };
    }

    if (session.turnCount >= MAX_TURNS) {
        const payload = await endSession(sessionId, 'draw', 'draw', null);
        return { success: true, gameEnded: true, payload };
    }

    const otherPlayer = session.players.find(p => p.playerId !== playerId);
    session.currentTurnPlayerId = otherPlayer.playerId;
    return { success: true, gameEnded: false, board: session.board, nextTurnPlayerId: session.currentTurnPlayerId };
}


async function handleDisconnect(socketId) {
  const sessionId = sessionsBySocket.get(socketId);
  if (!sessionId) return null;

  const session = getSession(sessionId);
  if (!session) return null;

  const player = session.players.find(p => p.socketId === socketId);
  if (!player) return null;

  sessionsBySocket.delete(socketId);
  player.socketId = null;

  if (session.status === 'active') {
      sessionLogger.appendEvent(sessionId, 'player.disconnected', { playerId: player.playerId });
      await dispatchEvent('player.disconnected', { sessionId, playerId: player.playerId, status: 'disconnected' }, sessionId);
  }

  return { session, disconnectedPlayerId: player.playerId };
}

async function passTurn(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return { success: false };
  }

  session.turnCount++;

  const timedOutPlayerId = session.currentTurnPlayerId;
  sessionLogger.appendEvent(sessionId, 'player.turn_passed', { playerId: timedOutPlayerId });
  await dispatchEvent('player.turn_passed', { sessionId, playerId: timedOutPlayerId, reason: 'timeout' }, sessionId);

  if (session.turnCount >= MAX_TURNS) {
    const payload = await endSession(sessionId, 'draw', 'draw', null);
    return { success: true, gameEnded: true, payload };
  }

  const otherPlayer = session.players.find(p => p.playerId !== timedOutPlayerId);
  session.currentTurnPlayerId = otherPlayer.playerId;

  return { success: true, gameEnded: false, session, nextTurnPlayerId: session.currentTurnPlayerId };
}

module.exports = {
  init,
  createSession,
  getSession,
  getAllActiveSessions,
  addOrReconnectPlayer,
  makeMove,
  relocateMove,
  handleDisconnect,
  passTurn,
  endSession,
};
