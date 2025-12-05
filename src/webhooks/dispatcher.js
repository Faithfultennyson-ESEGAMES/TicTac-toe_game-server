const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DLQ_DIR = path.join(__dirname, '../../dlq');
const HMAC_SECRET = process.env.HMAC_SECRET;
const WEBHOOK_ENDPOINTS = process.env.WEBHOOK_ENDPOINTS ? process.env.WEBHOOK_ENDPOINTS.split(',') : [];
const MAX_WEBHOOK_ATTEMPTS = parseInt(process.env.MAX_WEBHOOK_ATTEMPTS, 10) || 3;

let RETRY_SCHEDULE_MS = [];

// --- Private Functions ---

/**
 * Moves a failed webhook event to the Dead Letter Queue.
 */
async function _moveToDlq(endpoint, event, reason, lastStatus, deliveryAttempts) {
  const dlqItemId = crypto.randomUUID();
  const dlqItem = {
    dlq_item_id: dlqItemId,
    failed_at: new Date().toISOString(),
    reason: reason,
    endpoint: endpoint,
    last_response_status: lastStatus,
    delivery_attempts: deliveryAttempts,
    webhook_payload: event,
  };

  try {
    const filePath = path.join(DLQ_DIR, `${dlqItemId}.json`);
    await fs.writeFile(filePath, JSON.stringify(dlqItem, null, 2));
    console.log(`[Dispatcher] Event ${event.event_id} moved to DLQ: ${dlqItemId}.json`);
  } catch (error) {
    console.error(`[Dispatcher] CRITICAL: Failed to write to DLQ directory for event ${event.event_id}:`, error);
  }
}

/**
 * Sends a webhook with a retry mechanism. Does not block.
 * @param {string} endpoint - The URL to send the webhook to.
 * @param {object} event - The event object to send.
 * @param {number} attempt - The current attempt number (0-indexed).
 * @param {array} deliveryAttempts - A log of previous delivery attempts.
 */
async function _sendWithRetries(endpoint, event, attempt = 0, deliveryAttempts = []) {
  const body = JSON.stringify(event.body);
  const signature = `sha256=${crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex')}`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Event-Id': event.event_id,
    'X-Event-Type': event.event_type,
    'X-Signature': signature,
  };

  let response = null;
  let error = null;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: body,
      signal: AbortSignal.timeout(5000), // 5-second timeout
    });
  } catch (e) {
    error = e;
  }

  const attemptRecord = {
    attempt_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status_code: response ? response.status : null,
    error: error ? error.message : null,
  };
  deliveryAttempts.push(attemptRecord);

  // Success Case
  if (response && response.ok) { // 2xx status
    console.log(`[Dispatcher] Event ${event.event_id} delivered successfully to ${endpoint}.`);
    return;
  }

  // Permanent Failure Case
  if (response && response.status >= 400 && response.status < 500) {
    console.warn(`[Dispatcher] Event ${event.event_id} failed permanently (4xx) for ${endpoint}. Moving to DLQ.`);
    await _moveToDlq(endpoint, event, `Permanent failure with status ${response.status}`, response.status, deliveryAttempts);
    return;
  }

  // Retryable Failure Case (5xx or network error)
  if (attempt + 1 < MAX_WEBHOOK_ATTEMPTS) {
    const delay = RETRY_SCHEDULE_MS[attempt] || 1000; // Fallback delay
    console.log(`[Dispatcher] Event ${event.event_id} failed for ${endpoint} (Attempt ${attempt + 1}/${MAX_WEBHOOK_ATTEMPTS}). Retrying in ${delay}ms...`);
    setTimeout(() => _sendWithRetries(endpoint, event, attempt + 1, deliveryAttempts), delay);
  } else {
    console.error(`[Dispatcher] Event ${event.event_id} failed for ${endpoint} after ${MAX_WEBHOOK_ATTEMPTS} attempts. Moving to DLQ.`);
    await _moveToDlq(endpoint, event, `Exhausted ${MAX_WEBHOOK_ATTEMPTS} retry attempts.`, response ? response.status : null, deliveryAttempts);
  }
}

// --- Public API ---

/**
 * Initializes the dispatcher, creating the DLQ directory.
 */
async function init() {
  try {
    await fs.mkdir(DLQ_DIR, { recursive: true });
    // Parse retry schedule, ensuring values are numbers
    if (process.env.RETRY_SCHEDULE_MS) {
        RETRY_SCHEDULE_MS = process.env.RETRY_SCHEDULE_MS.split(',').map(t => parseInt(t.trim(), 10)).filter(Number.isFinite);
    }
  } catch (error) {
    console.error('[Dispatcher] Failed to create DLQ directory:', error);
    // If this fails, the server can still run, but DLQ writes will fail.
  }
}

/**
 * Dispatches an event to all configured webhook endpoints.
 * This is the public interface and does not change.
 */
function dispatchEvent(eventType, payload, sessionId) {
  if (!HMAC_SECRET || WEBHOOK_ENDPOINTS.length === 0) {
    // Silently ignore if not configured, to avoid breaking game logic.
    return;
  }

  // Create a clean, serializable copy of the payload
  let cleanPayload;
  try {
    cleanPayload = JSON.parse(JSON.stringify(payload));
  } catch (e) {
    // If payload has circular references, try to extract only serializable properties
    cleanPayload = payload;
    console.warn(`[Dispatcher] Warning: Could not serialize payload, using as-is. Error: ${e.message}`);
  }

  const event = {
    event_id: crypto.randomUUID(),
    event_type: eventType,
    session_id: sessionId,
    body: cleanPayload,
  };

  // Fire-and-forget for each endpoint
  for (const endpoint of WEBHOOK_ENDPOINTS) {
    _sendWithRetries(endpoint, event);
  }
}

/**
 * Resends an item from the DLQ.
 * @param {object} dlqItem - The parsed DLQ item from the JSON file.
 * @returns {boolean} - True if the resend was successful.
 */
async function resendDlqItem(dlqItem) {
    if (!dlqItem || !dlqItem.endpoint || !dlqItem.webhook_payload) {
        return false;
    }

    // A simple, single attempt to resend. No complex retries here.
    // If it fails again, it stays in the DLQ.
    const event = dlqItem.webhook_payload;
    const body = JSON.stringify(event.body);
    const signature = `sha256=${crypto.createHmac('sha256', HMAC_SECRET).update(body).digest('hex')}`;
    const headers = {
        'Content-Type': 'application/json',
        'X-Event-Id': event.event_id,
        'X-Event-Type': event.event_type,
        'X-Signature': signature,
    };

    try {
        const response = await fetch(dlqItem.endpoint, {
            method: 'POST',
            headers: headers,
            body: body,
            signal: AbortSignal.timeout(10000), // 10-second timeout for manual resend
        });

        if (response.ok) {
            console.log(`[Dispatcher] DLQ item ${dlqItem.dlq_item_id} successfully resent to ${dlqItem.endpoint}.`);
            // On success, delete the DLQ file
            const filePath = path.join(DLQ_DIR, `${dlqItem.dlq_item_id}.json`);
            await fs.unlink(filePath);
            return true;
        } else {
            console.warn(`[Dispatcher] DLQ item ${dlqItem.dlq_item_id} failed to resend with status ${response.status}.`);
            return false;
        }
    } catch (error) {
        console.error(`[Dispatcher] DLQ item ${dlqItem.dlq_item_id} failed to resend with network error:`, error.message);
        return false;
    }
}


module.exports = {
  init,
  dispatchEvent,
  resendDlqItem,
  DLQ_DIR, // Export for use in admin routes
};