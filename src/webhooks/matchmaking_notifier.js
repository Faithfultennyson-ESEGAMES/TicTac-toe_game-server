const crypto = require('crypto');

const MATCHMAKING_SERVICE_URL = process.env.MATCHMAKING_SERVICE_URL;
const HMAC_SECRET = process.env.HMAC_SECRET;

/**
 * Notifies the matchmaking service that a session has ended.
 * This uses the standard webhook format.
 * 
 * @param {object} session - The final, complete session object.
 */
async function notifySessionClosed(session) {
  if (!MATCHMAKING_SERVICE_URL || !HMAC_SECRET) {
    // If the matchmaking service isn't configured, do nothing.
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
        'X-Hub-Signature-256': signature, // Aligned with the standard webhook dispatcher
      },
      body: body,
      signal: AbortSignal.timeout(5000), // 5-second timeout
    });

    if (!response.ok) {
        // This is a fire-and-forget notification. We log the error but do not retry.
        console.error(`[Notifier] Failed to send session-closed notification for ${session.sessionId}. Status: ${response.status}`);
    }

  } catch (error) {
    console.error(`[Notifier] Error sending session-closed notification for ${session.sessionId}:`, error.message);
  }
}

module.exports = { notifySessionClosed };
