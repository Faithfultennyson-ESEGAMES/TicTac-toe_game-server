const express = require('express');
const { adminAuth } = require('./middleware/auth');
const sessionManager = require('../game/session');

const router = express.Router();

// Protect all session admin routes
router.use(adminAuth);

/**
 * @route POST /admin/sessions/:sessionId/end
 * @description Forcefully ends an active game session.
 * @access private
 */
router.post('/sessions/:sessionId/end', (req, res) => {
  const { sessionId } = req.params;
  const session = sessionManager.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.state === 'ended') {
    return res.status(200).json({ message: 'Session was already ended.', session_id: sessionId });
  }

  // Use the centralized session cleanup logic
  sessionManager.endSession(sessionId, {
    clientReason: 'admin_forced_end',
    winState: 'none',
    winnerPlayerId: null,
  });

  res.status(200).json({
    message: 'Session force-ended successfully.',
    session_id: sessionId,
    reason: 'admin_forced_end',
  });
});

module.exports = router;
