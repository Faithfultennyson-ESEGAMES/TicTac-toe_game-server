require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const {
  addOrReconnectPlayer,
  makeMove,
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

    session.turnCount += 1;

    if (session.turnCount > MAX_TURNS) {
        const payload = await endSession(session.sessionId, 'draw', 'draw', null);
        if (payload) {
            io.to(session.sessionId).emit('game-ended', payload);
        }
        return;
    }

    const expiresAt = new Date(Date.now() + session.turnDurationSec * 1000);
    const expiresAtISO = expiresAt.toISOString();

    sessionLogger.appendEvent(session.sessionId, 'turn.started', {
      player_id: session.currentTurnPlayerId,
      expires_at: expiresAtISO,
    });

    io.to(session.sessionId).emit('turn-started', {
      current_turn_player_id: session.currentTurnPlayerId,
      expires_at: expiresAtISO,
    });

    session.turnTimerId = setTimeout(async () => {
      const result = await passTurn(session.sessionId);
      if (result.success) {
        io.to(result.session.sessionId).emit('move-applied', { 
            board: result.session.board, 
            current_turn_player_id: result.nextTurnPlayerId 
        });
        startTurn(result.session);
      }
    }, session.turnDurationSec * 1000);
  };

  io.on('connection', (socket) => {

    socket.on('join', async (data) => {
      try {
        if (!data || !data.session_id || !data.playerId || !data.playerName) {
          return socket.emit('join-error', { message: 'Invalid payload. Must include session_id, playerId, and playerName.' });
        }

        const { session_id, playerId, playerName } = data;
        const result = await addOrReconnectPlayer(session_id, playerId, playerName, socket.id);

        if (!result.success) {
          return socket.emit('join-error', { message: result.error });
        }

        const session = result.session;
        socket.join(session.sessionId);

        if (result.isReconnect) {
            io.to(session.sessionId).emit('player-reconnected', { playerId });
        }
        
        if (result.gameReady) {
          io.to(session.sessionId).emit('game-found', {
            session_id: session.sessionId,
            players: session.players.map(p => ({ playerId: p.playerId, playerName: p.playerName, symbol: p.symbol })),
            board: session.board,
            turn_duration_sec: session.turnDurationSec,
          });
          startTurn(session);
        }

      } catch (error) {
        console.error(`[Socket Handler] Error on join event:`, error);
        socket.emit('join-error', { message: 'An internal server error occurred.' });
      }
    });

    socket.on('make-move', async(data) => {
        try {
            if (!data || !data.session_id || !data.playerId || data.position === undefined) {
                return socket.emit('move-error', { message: 'Invalid move payload.' });
            }
            const { session_id, playerId, position } = data;
            
            const result = await makeMove(session_id, playerId, position);

            if (!result.success) {
                return socket.emit('move-error', { message: result.error });
            }

            if (result.gameEnded) {
                if (result.payload) {
                    io.to(session_id).emit('game-ended', result.payload);
                }
            } else {
                const session = getSession(session_id);
                io.to(session_id).emit('move-applied', { 
                    board: result.board, 
                    current_turn_player_id: result.nextTurnPlayerId 
                });
                startTurn(session);
            }
        } catch (error) {
            console.error(`[Socket Handler] Error on make-move event:`, error);
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