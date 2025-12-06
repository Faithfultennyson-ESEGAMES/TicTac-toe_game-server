const express = require('express');
const { getAllActiveSessions } = require('../game/session');
const { adminAuth } = require('./middleware/auth');

const router = express.Router();

// Protect all routes in this file with the admin password
router.use(adminAuth);

// GET /admin/sessions/active - Lists all active (non-ended) sessions
router.get('/sessions/active', (req, res) => {
  const activeSessions = getAllActiveSessions();
  res.status(200).json(activeSessions);
});

module.exports = router;
