require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const crypto = require('crypto');
const { dispatchEvent } = require('../webhooks/dispatcher');
const { checkForWinner, isBoardFull } = require('./game_logic');
const sessionLogger = require('../logging/session_logger');

const sessions = new Map(); // sessionId -> session object
const activePlayerIds = new Map(); // playerId -> sessionId
const sessionsBySocket = new Map(); // socketId -> sessionId

// Private function for the final cleanup
async function _concludeAndCleanupSession(session) {
    if (!session) return;

    // Dispatch the webhook while the session data is still intact.
    await dispatchEvent('session.ended', session, session.sessionId);

    // Clean up all global maps to prevent memory leaks and allow players to join new games.
    for (const player of session.players) {
        if (player) {
            activePlayerIds.delete(player.playerId);
            if (player.socketId) {
                sessionsBySocket.delete(player.socketId);
            }
        }
    }

    // Finally, remove the session from the main map.
    sessions.delete(session.sessionId);
}


async function endSession(sessionId, clientReason, webhookWinState, winnerPlayerId) {
    const session = getSession(sessionId);
    if (!session || session.status === 'ended') {
        return null; // Indicate that the session is already ended or not found
    }

    // 1. Stop any pending turn timers immediately.
    clearTimeout(session.turnTimerId);
    session.turnTimerId = null;

    // 2. Set the final state on the session object.
    session.status = 'ended';
    session.winState = webhookWinState;
    session.winnerPlayerId = winnerPlayerId;

    // 3. Finalize the session log.
    sessionLogger.finalizeLog(session, { win_state: webhookWinState, winner_player_id: winnerPlayerId });

    // 4. Asynchronously trigger the final webhook dispatch and cleanup.
    // We don't wait for this to complete before notifying the client.
    _concludeAndCleanupSession(session);

    // 5. Return the neutral payload for the client-facing 'game-ended' event.
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
    winState: null, // 'win' | 'draw' | 'none'
    winnerPlayerId: null,
    turnCount: 0, // New field for MAX_TURNS rule
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

async function addOrReconnectPlayer(sessionId, playerId, playerName, socketId) {
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

    sessionLogger.appendEvent(sessionId, 'player.reconnected', { player_id: playerId });
    await dispatchEvent('player.reconnected', { player_id: playerId, status: 'reconnected' }, sessionId);
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

    sessionLogger.appendEvent(sessionId, 'player.joined', { player_id: playerId, player_name: playerName });
    await dispatchEvent('player.joined', { player_id: playerId, player_name: playerName, status: 'joined' }, sessionId);

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

  clearTimeout(session.turnTimerId);
  session.turnTimerId = null;

  const player = session.players.find(p => p.playerId === playerId);
  session.board[position] = player.symbol;

  sessionLogger.appendEvent(sessionId, 'move.made', { player_id: playerId, position });

  const winnerSymbol = checkForWinner(session.board);
  if (winnerSymbol) {
    const winner = session.players.find(p => p.symbol === winnerSymbol);
    const payload = await endSession(sessionId, 'win', 'win', winner.playerId);
    return { success: true, gameEnded: true, payload };
  }

  if (isBoardFull(session.board)) {
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

  // Only remove the socketId mapping, do not remove the player from the session
  sessionsBySocket.delete(socketId);
  player.socketId = null;

  if (session.status === 'active') {
      sessionLogger.appendEvent(sessionId, 'player.disconnected', { player_id: player.playerId });
      await dispatchEvent('player.disconnected', { player_id: player.playerId, status: 'disconnected' }, sessionId);
  }

  return { session, disconnectedPlayerId: player.playerId };
}

async function passTurn(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active') {
    return { success: false };
  }

  const timedOutPlayerId = session.currentTurnPlayerId;
  sessionLogger.appendEvent(sessionId, 'player.turn_passed', { player_id: timedOutPlayerId });
  await dispatchEvent('player.turn_passed', { player_id: timedOutPlayerId, reason: 'timeout' }, sessionId);

  const otherPlayer = session.players.find(p => p.playerId !== timedOutPlayerId);
  session.currentTurnPlayerId = otherPlayer.playerId;

  return { success: true, session, nextTurnPlayerId: session.currentTurnPlayerId };
}

module.exports = {
  createSession,
  getSession,
  addOrReconnectPlayer,
  makeMove,
  handleDisconnect,
  passTurn,
  endSession,
};