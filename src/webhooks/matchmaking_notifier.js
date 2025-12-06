const crypto = require('crypto');

const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL;
const HMAC_SECRET = process.env.HMAC_SECRET;

/**
 * Notifies the matchmaking service that a session has ended.
 * 
 * @param {object} session - The final, complete session object.
 */
async function notifySessionClosed(session) {
  if (!MATCHMAKING_SERVICE_URL || !HMAC_SECRET) {
    // If the matchmaking service isn't configured, do nothing.
    // This prevents errors in environments where it's not needed.
    return;
  }

  console.log(`[Notifier] Sending session-closed notification for ${session.sessionId} to ${MATCHMAKING_SERVICE_URL}`)

  try {
    const body = JSON.stringify(session);
    const signature = crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex');

    const response = await fetch(MATCHMAKING_SERVICE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      body: body,
      signal: AbortSignal.timeout(5000), // 5-second timeout
    });

    if (!response.ok) {
        // We don't retry this or send it to a DLQ. It's a fire-and-forget notification.
        // The matchmaking service is responsible for its own availability.
        console.error(`[Notifier] Failed to send session-closed notification for ${session.sessionId}. Status: ${response.status}`);
    }

  } catch (error) {
    console.error(`[Notifier] Error sending session-closed notification for ${session.sessionId}:`, error.message);
  }
}

module.exports = { notifySessionClosed };
