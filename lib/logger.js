// Simple Logger Module: Centralize log behavior for easy unified replacement and level control
const { config } = require('./config');

function timestamp() { return new Date().toISOString(); }

const logger = {
  info(message, data) {
    console.log(`[${timestamp()}] Info: ${message}`, data || '');
  },
  error(message, error, data) {
    const payload = {
      error: error?.message || error,
      stack: error?.stack,
      ...(data || {})
    };
    console.error(`[${timestamp()}] Error: ${message}`, payload);
  },
  warn(message, data) {
    console.warn(`[${timestamp()}] Warning: ${message}`, data || '');
  },
  debug(message, data) {
    if (!config.DEBUG) return;
    console.log(`[${timestamp()}] Debug: ${message}`, data || '');
  }
};

module.exports = { logger };


