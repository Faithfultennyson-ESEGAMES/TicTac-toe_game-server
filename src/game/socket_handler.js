require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const {
  addOrReconnectPlayer,
  makeMove,
  relocateMove,
  handleDisconnect,
  passTurn,
  getSession,
  endSession,
} = require('./session');
const sessionLogger = require('../logging/session_logger');

const MAX_TURNS = parseInt(process.env.MAX_TURNS, 10) || 12;

function initializeSocket(io) {

  const startTurn = async (session) => {
    if (!session || session.status !== 'active') {
      return;
    }

    clearTimeout(session.turnTimerId);

    if (session.turnCount >= MAX_TURNS) {
        const payload = await endSession(session.sessionId, 'draw', 'draw', null);
        if (payload) {
            io.to(session.sessionId).emit('move-applied', { board: payload.board, currentTurnPlayerId: null });
            io.to(session.sessionId).emit('game-ended', payload);
        }
        return;
    }

    const expiresAt = new Date(Date.now() + session.turnDurationSec * 1000);
    const expiresAtISO = expiresAt.toISOString();

    sessionLogger.appendEvent(session.sessionId, 'turn.started', {
      playerId: session.currentTurnPlayerId,
      expiresAt: expiresAtISO,
    });

    io.to(session.sessionId).emit('turn-started', {
      currentTurnPlayerId: session.currentTurnPlayerId,
      expiresAt: expiresAtISO,
    });

    session.turnTimerId = setTimeout(async () => {
      const result = await passTurn(session.sessionId);
      if (result.success) {
          if (result.gameEnded) {
            io.to(session.sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
            io.to(session.sessionId).emit('game-ended', result.payload);
          } else {
            io.to(result.session.sessionId).emit('move-applied', { 
                board: result.session.board, 
                currentTurnPlayerId: result.nextTurnPlayerId 
            });
            startTurn(result.session);
          }
      }
    }, session.turnDurationSec * 1000);
  };

  io.on('connection', (socket) => {

    socket.on('join', async (data) => {
      try {
        if (!data || !data.sessionId || !data.playerId || !data.playerName) {
          return socket.emit('join-error', { message: 'Invalid payload. Must include sessionId, playerId, and playerName.' });
        }

        const { sessionId, playerId, playerName } = data;
        const result = await addOrReconnectPlayer(sessionId, playerId, playerName, socket.id);

        if (!result.success) {
          return socket.emit('join-error', { message: result.error });
        }

        socket.join(sessionId);

        const { session } = result;

        if (result.isReconnect) {
            io.to(sessionId).emit('player-reconnected', { playerId });
        }
        
        if (result.gameReady) {
          io.to(sessionId).emit('game-found', {
            sessionId: session.sessionId,
            players: session.players.map(p => ({ playerId: p.playerId, playerName: p.playerName, symbol: p.symbol })),
            board: session.board,
            turnDurationSec: session.turnDurationSec,
            currentTurnPlayerId: session.currentTurnPlayerId,
          });
          startTurn(session);
        } else if (session.status === 'pending') {
             io.to(sessionId).emit('waiting-for-player');
        }

      } catch (error) {
        console.error(`[Socket Handler] Error on join event:`, error);
        socket.emit('join-error', { message: 'An internal server error occurred.' });
      }
    });

    socket.on('make-move', async(data) => {
        try {
            if (!data || !data.sessionId || !data.playerId || data.position === undefined) {
                return socket.emit('move-error', { message: 'Invalid move payload.' });
            }
            const { sessionId, playerId, position } = data;
            
            const result = await makeMove(sessionId, playerId, position);

            if (!result.success) {
                return socket.emit('move-error', { message: result.error });
            }

            if (result.gameEnded) {
                io.to(sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
                io.to(sessionId).emit('game-ended', result.payload);
            } else {
                io.to(sessionId).emit('move-applied', { 
                    board: result.board, 
                    currentTurnPlayerId: result.nextTurnPlayerId 
                });
                const session = getSession(sessionId);
                startTurn(session);
            }
        } catch (error) {
            console.error(`[Socket Handler] Error on make-move event:`, error);
            socket.emit('move-error', { message: 'An internal server error occurred.' });
        }
    });
    
    socket.on('relocate-move', async(data) => {
        try {
            if (!data || !data.sessionId || !data.playerId || data.from === undefined || data.to === undefined) {
                return socket.emit('move-error', { message: 'Invalid relocate payload.' });
            }
            const { sessionId, playerId, from, to } = data;
            
            const result = await relocateMove(sessionId, playerId, from, to);

            if (!result.success) {
                return socket.emit('move-error', { message: result.error });
            }

            if (result.gameEnded) {
                io.to(sessionId).emit('move-applied', { board: result.payload.board, currentTurnPlayerId: null });
                io.to(sessionId).emit('game-ended', result.payload);
            } else {
                io.to(sessionId).emit('move-applied', { 
                    board: result.board, 
                    currentTurnPlayerId: result.nextTurnPlayerId 
                });
                const session = getSession(sessionId);
                startTurn(session);
            }
        } catch (error) {
            console.error(`[Socket Handler] Error on relocate-move event:`, error);
            socket.emit('move-error', { message: 'An internal server error occurred.' });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const result = await handleDisconnect(socket.id);
            if (result && result.session.status === 'active') {
                io.to(result.session.sessionId).emit('player-disconnected', { 
                    playerId: result.disconnectedPlayerId 
                });
            }
        } catch(error) {
            console.error(`[Socket Handler] Error on disconnect event:`, error);
        }
    });
  });
}

module.exports = { initializeSocket };
