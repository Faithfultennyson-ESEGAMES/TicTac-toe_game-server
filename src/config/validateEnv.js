const chalk = require('chalk');

/**
 * Validates that all critical environment variables are set.
 * If any are missing or invalid, it logs a clear error and exits the process.
 */
function validateEnv() {
  const requiredVars = [
    'HMAC_SECRET',
    'WEBHOOK_ENDPOINTS',
    'DLQ_PASSWORD',
    'MAX_WEBHOOK_ATTEMPTS',
    'RETRY_SCHEDULE_MS',
    'SESSION_LOG_TTL_MS',
    'MAX_TURNS',
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error(
      chalk.red('Error: Missing required environment variables:\n') +
      chalk.yellow(missingVars.join('\n')) +
      '\n\nPlease check your .env file and ensure all variables are set.'
    );
    process.exit(1);
  }

  // --- Additional, specific validations ---

  const maxAttempts = parseInt(process.env.MAX_WEBHOOK_ATTEMPTS, 10);
  if (isNaN(maxAttempts) || maxAttempts <= 0) {
    console.error(
      chalk.red('Error: Invalid environment variable `MAX_WEBHOOK_ATTEMPTS`.\n') +
      'It must be a positive integer.'
    );
    process.exit(1);
  }

  const retrySchedule = process.env.RETRY_SCHEDULE_MS.split(',').map(t => parseInt(t.trim(), 10));
  if (retrySchedule.some(isNaN) || retrySchedule.length !== maxAttempts - 1) {
    console.error(
      chalk.red('Error: Invalid environment variable `RETRY_SCHEDULE_MS`.\n') +
      `It must be a comma-separated list of numbers, with a length of (MAX_WEBHOOK_ATTEMPTS - 1).`
    );
    process.exit(1);
  }
}

module.exports = { validateEnv };
