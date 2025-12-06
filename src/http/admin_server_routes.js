const express = require('express');
const sessionManager = require('../game/session');
const { adminAuth } = require('./middleware/auth');

const router = express.Router();

// Protect all routes in this file with the admin password
router.use(adminAuth);

// GET /admin/sessions/active - Lists all active (non-ended) sessions
router.get('/sessions/active', (req, res) => {
  const activeSessions = sessionManager.getAllActiveSessions();
  res.status(200).json(activeSessions);
});

// POST /admin/sessions/:sessionId/end - Forcefully ends a specific session
router.post('/sessions/:sessionId/end', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  if (session.status === 'ended') {
    return res.status(400).json({ error: 'Session has already ended.' });
  }

  try {
    // Forcefully end the session
    await sessionManager.endSession(sessionId, 'admin_forced_end', 'none', null);
    res.status(200).json({ message: `Session ${sessionId} has been forcefully ended.` });
  } catch (error) {
    console.error(`[Admin] Error ending session ${sessionId}:`, error);
    res.status(500).json({ error: 'An internal error occurred while ending the session.' });
  }
});

module.exports = router;
