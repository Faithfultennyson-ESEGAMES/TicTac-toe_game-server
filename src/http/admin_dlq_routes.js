const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { resendDlqItem, DLQ_DIR } = require('../webhooks/dispatcher');
const { adminAuth } = require('./middleware/auth'); // Import shared middleware

const router = express.Router();

// Protect all DLQ routes with the admin password
router.use(adminAuth);

// GET /admin/dlq - List all items in the DLQ
router.get('/dlq', async (req, res) => {
  try {
    const files = await fs.readdir(DLQ_DIR);
    const dlqItems = files
      .filter(file => file.endsWith('.json'))
      .map(file => file.replace('.json', ''));
    res.status(200).json(dlqItems);
  } catch (error) {
    if (error.code === 'ENOENT') { // Directory doesn't exist
      return res.status(200).json([]);
    }
    console.error('[Admin DLQ] Error listing DLQ items:', error);
    res.status(500).json({ error: 'Failed to list DLQ items.' });
  }
});

// Middleware to validate :id parameter
const validateId = (req, res, next) => {
    const { id } = req.params;
    // A simple regex to ensure the ID is a UUID v4. Prevents path traversal.
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
        return res.status(400).json({ error: 'Invalid ID format.' });
    }
    next();
};

// GET /admin/dlq/:id - Get a specific DLQ item
router.get('/dlq/:id', validateId, async (req, res) => {
  const { id } = req.params;
  const filePath = path.join(DLQ_DIR, `${id}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    res.status(200).json(JSON.parse(data));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'DLQ item not found.' });
    }
    console.error(`[Admin DLQ] Error reading DLQ item ${id}:`, error);
    res.status(500).json({ error: 'Failed to read DLQ item.' });
  }
});

// POST /admin/dlq/:id/resend - Resend a specific DLQ item
router.post('/dlq/:id/resend', validateId, async (req, res) => {
  const { id } = req.params;
  const filePath = path.join(DLQ_DIR, `${id}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf8');
    const dlqItem = JSON.parse(data);

    const success = await resendDlqItem(dlqItem);

    if (success) {
      res.status(200).json({ message: 'DLQ item successfully resent and removed.' });
    } else {
      res.status(400).json({ error: 'Failed to resend DLQ item. It remains in the DLQ.' });
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'DLQ item not found.' });
    }
    console.error(`[Admin DLQ] Error resending DLQ item ${id}:`, error);
    res.status(500).json({ error: 'An error occurred while trying to resend the item.' });
  }
});

// DELETE /admin/dlq - Delete all items from the DLQ
router.delete('/dlq', async (req, res) => {
  const { password } = req.body;

  // This endpoint requires re-authentication of the password in the body for safety.
  if (password !== process.env.DLQ_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden: Incorrect password for bulk delete.' });
  }

  try {
    const files = await fs.readdir(DLQ_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    if (jsonFiles.length === 0) {
        return res.status(200).json({ message: 'DLQ is already empty.' });
    }

    await Promise.all(jsonFiles.map(file => fs.unlink(path.join(DLQ_DIR, file))));

    res.status(200).json({ message: `Successfully deleted ${jsonFiles.length} items from the DLQ.` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(200).json({ message: 'DLQ is already empty.' });
    }
    console.error('[Admin DLQ] Error clearing DLQ:', error);
    res.status(500).json({ error: 'Failed to clear the DLQ.' });
  }
});

module.exports = router;
