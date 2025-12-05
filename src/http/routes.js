const express = require('express');
const { createSession } = require('../game/session');
const { dispatchEvent } = require('../webhooks/dispatcher');
const sessionLogger = require('../logging/session_logger');

const router = express.Router();

router.post('/start', async (req, res) => {
  let { turn_duration_sec } = req.body;

  if (turn_duration_sec !== undefined) {
    turn_duration_sec = parseInt(turn_duration_sec, 10);
    if (isNaN(turn_duration_sec) || turn_duration_sec <= 0) {
      return res.status(400).json({ error: 'Invalid turn_duration_sec. Must be a positive integer.' });
    }
  }

  const session = createSession(turn_duration_sec);

  // Start the session log. This also logs the 'session.started' event internally.
  sessionLogger.startSessionLog(session);

  // Dispatch the session.started webhook (existing behavior)
  await dispatchEvent('session.started', session, session.sessionId);

  const join_url = `${req.protocol}://${req.get('host')}/session/${session.sessionId}/join`;

  res.status(201).json({
    session_id: session.sessionId,
    join_url: join_url,
  });
});

module.exports = router;
