const express = require('express');
const crypto = require('crypto');
const { createSession } = require('../game/session');
const { dispatchEvent } = require('../webhooks/dispatcher');
const sessionLogger = require('../logging/session_logger');
const { startRequestAuth } = require('./middleware/auth');

const router = express.Router();
const HMAC_SECRET = process.env.HMAC_SECRET;

router.post('/start', startRequestAuth, async (req, res) => {
  if (!HMAC_SECRET) {
    console.error('[Auth] HMAC_SECRET is not configured. Cannot sign responses.');
    return res.status(500).json({ error: 'Server security is not configured.' });
  }

  let { turn_duration_sec } = req.body;

  if (turn_duration_sec !== undefined) {
    turn_duration_sec = parseInt(turn_duration_sec, 10);
    if (isNaN(turn_duration_sec) || turn_duration_sec <= 0) {
      return res.status(400).json({ error: 'Invalid turn_duration_sec. Must be a positive integer.' });
    }
  }

  const session = createSession(turn_duration_sec);

  sessionLogger.startSessionLog(session);

  await dispatchEvent('session.started', session, session.sessionId);

  const join_url = `${req.protocol}://${req.get('host')}/session/${session.sessionId}/join`;

  const payload = {
    session_id: session.sessionId,
    join_url: join_url,
  };

  // Sign the payload
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex');

  res.status(201).json({ ...payload, signature });
});

module.exports = router;
