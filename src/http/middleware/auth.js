
const DLQ_PASSWORD = process.env.DLQ_PASSWORD;

function adminAuth(req, res, next) {
  if (!DLQ_PASSWORD) {
    console.warn('[Admin] Admin endpoints are not protected. Set DLQ_PASSWORD in .env');
    return res.status(500).json({ error: 'Admin endpoint is not configured.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token format.' });
  }

  const providedPassword = authHeader.split(' ')[1];

  // NOTE: In a production environment, a constant-time comparison is crucial for security.
  // For this project, direct comparison is acceptable per requirements.
  if (providedPassword !== DLQ_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden: Invalid token.' });
  }

  next();
}

module.exports = { adminAuth };
