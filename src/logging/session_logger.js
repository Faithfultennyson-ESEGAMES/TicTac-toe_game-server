require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, '../../logs');
const SESSION_LOG_TTL_MS = parseInt(process.env.SESSION_LOG_TTL_MS, 10) || 3600000;

const inMemoryLogs = new Map(); // sessionId -> log object
const ttlTimers = new Map(); // sessionId -> timerId

// Helper to write the log to a file safely
async function _writeLogToFile(log) {
  if (!log || !log.session_id) return;

  const filePath = path.join(LOG_DIR, `${log.session_id}.json`);
  try {
    // The 'w' flag ensures the file is created if it doesn't exist or truncated if it does.
    await fs.writeFile(filePath, JSON.stringify(log, null, 2), { flag: 'w' });
  } catch (error) {
    console.warn(`[SessionLogger] Failed to write log file for session ${log.session_id}:`, error);
  }
}

// Initializes the logger, creating the log directory if it doesn't exist.
async function init() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (error) {
    console.error('[SessionLogger] Failed to create log directory:', error);
    // If we can't create the log directory, logging will fail, but the server can continue.
  }
}

// Creates the initial log object for a new session and logs the 'session.started' event.
function startSessionLog(session) {
  const log = {
    session_id: session.sessionId,
    created_at: session.createdAt,
    turn_duration_sec: session.turnDurationSec,
    status: 'pending',
    events: [],
    final_summary: null,
  };

  inMemoryLogs.set(session.sessionId, log);

  // Append the initial event and write to disk
  appendEvent(session.sessionId, 'session.started', { turn_duration_sec: session.turnDurationSec });
}

// Appends a new event to a session's log.
function appendEvent(sessionId, eventType, payload) {
  const log = inMemoryLogs.get(sessionId);
  if (!log) return;

  const event = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: payload || {},
  };

  log.events.push(event);

  // Asynchronously write the updated log to the file system.
  _writeLogToFile(log);
}

// Finalizes a session's log, adds the summary, and schedules cleanup.
function finalizeLog(session, { win_state, winner_player_id }) {
  const log = inMemoryLogs.get(session.sessionId);
  if (!log || log.status === 'ended') return;

  // Update final status and summary
  log.status = 'ended';
  log.final_summary = {
    win_state,
    winner_player_id,
  };

  // Append the final event
  appendEvent(session.sessionId, 'session.ended', log.final_summary);

  // Schedule cleanup after TTL. The timer starts from the moment the session ends.
  const timerId = setTimeout(() => {
    const filePath = path.join(LOG_DIR, `${session.sessionId}.json`);
    fs.unlink(filePath).catch(err => {
      // This error is expected if the file was manually deleted, so we just warn.
      console.warn(`[SessionLogger] Could not delete log file ${filePath}:`, err.message);
    });
    inMemoryLogs.delete(session.sessionId);
    ttlTimers.delete(session.sessionId);
  }, SESSION_LOG_TTL_MS);

  // Store the timer so we can clear it if the server shuts down gracefully (future enhancement)
  ttlTimers.set(session.sessionId, timerId);
}

module.exports = {
  init,
  startSessionLog,
  appendEvent,
  finalizeLog,
};