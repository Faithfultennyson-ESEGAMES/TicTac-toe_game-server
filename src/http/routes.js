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

  let { turnDurationSec } = req.body;

  if (turnDurationSec !== undefined) {
    turnDurationSec = parseInt(turnDurationSec, 10);
    if (isNaN(turnDurationSec) || turnDurationSec <= 0) {
      return res.status(400).json({ error: 'Invalid turnDurationSec. Must be a positive integer.' });
    }
  }

  const session = createSession(turnDurationSec);

  sessionLogger.startSessionLog(session);

  await dispatchEvent('session.started', session, session.sessionId);

  const joinUrl = `${req.protocol}://${req.get('host')}/session/${session.sessionId}/join`;

  const payload = {
    sessionId: session.sessionId,
    joinUrl: joinUrl,
  };

  // Sign the payload
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(JSON.stringify(payload)).digest('hex');

  res.set('X-Hub-Signature-256', signature);
  res.status(201).json(payload);
});

module.exports = router;
