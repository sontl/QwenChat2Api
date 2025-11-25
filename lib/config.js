// Configuration module: Read and export config.json and commonly used getter functions
// Purpose: Centralize configuration management to avoid reading files everywhere in business code
const jwt = require('jsonwebtoken');
const { loadConfig, loadCookie, loadCookies, reloadConfig: reloadConfigLoader } = require('./config-loader');

// Load configuration and Cookie
const config = loadConfig();
const cookie = loadCookie();

// Get API key (for simple authentication)
function getApiKey() { return config.API_KEY || ''; }
// Get Qwen Token
function getQwenToken() { return config.QWEN_TOKEN || ''; }
// Get browser Cookie (required for some interfaces)
function getCookie() { return cookie || ''; }
// Get multiple Cookies (for load balancing)
function getCookies() { return loadCookies(); }
// Whether to use server-side authentication mode
function isServerMode() { return !!config.SERVER_MODE; }
// Whether to enable debug logging
function isDebugMode() { return !!config.DEBUG_MODE; }
// Server port
function getServerPort() { return Number(config.SERVER_PORT || 8000); }
// Visual model fallback name (automatically switch when pure text model carries images)
function getVisionFallbackModel() { return config.VISION_FALLBACK_MODEL || ''; }

// JWT token parsing and expiration time detection
function parseJwtToken(token) {
  try {
    // Don't verify signature, only parse payload
    const decoded = jwt.decode(token, { complete: true });
    return decoded;
  } catch (error) {
    return null;
  }
}

// Check if token is expired
function isTokenExpired(token) {
  const decoded = parseJwtToken(token);
  if (!decoded || !decoded.payload || !decoded.payload.exp) {
    return true; // Unable to parse or no expiration time, consider expired
  }

  const currentTime = Math.floor(Date.now() / 1000);
  return decoded.payload.exp < currentTime;
}

// Get token expiration time (milliseconds timestamp)
function getTokenExpiryTime(token) {
  const decoded = parseJwtToken(token);
  if (!decoded || !decoded.payload || !decoded.payload.exp) {
    return null;
  }
  return decoded.payload.exp * 1000; // Convert to milliseconds
}

// Get remaining valid time of token (milliseconds)
function getTokenRemainingTime(token) {
  const expiryTime = getTokenExpiryTime(token);
  if (!expiryTime) {
    return 0;
  }
  const remaining = expiryTime - Date.now();
  return Math.max(0, remaining);
}

// Format remaining time display
function formatRemainingTime(remainingMs) {
  if (remainingMs <= 0) return 'Expired';

  const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

// Dynamically reload configuration (for use after token refresh)
function reloadConfig() {
  return reloadConfigLoader(config);
}

// Check if token needs to be refreshed
function shouldRefreshToken() {
  const token = getQwenToken();
  if (!token) return true;

  // If token is expired, refresh is needed
  if (isTokenExpired(token)) return true;

  const remainingTime = getTokenRemainingTime(token);
  const oneDayInMs = 24 * 60 * 60 * 1000;

  // If remaining time is less than 24 hours, refresh is needed
  return remainingTime < oneDayInMs;
}

// Get token refresh status information
function getTokenRefreshInfo() {
  const token = getQwenToken();
  if (!token) {
    return {
      needsRefresh: true,
      reason: 'No token found',
      remainingTime: 0,
      formattedTime: 'N/A',
      valid: false,
      isExpired: true
    };
  }

  const isExpired = isTokenExpired(token);
  const remainingTime = getTokenRemainingTime(token);
  const formattedTime = formatRemainingTime(remainingTime);
  const needsRefresh = shouldRefreshToken();

  return {
    needsRefresh,
    isExpired,
    remainingTime,
    formattedTime,
    valid: !isExpired,
    reason: needsRefresh ? (isExpired ? 'Token is expired' : 'Token will expire within 24 hours') : 'Token is still valid'
  };
}

module.exports = {
  config,
  getApiKey,
  getQwenToken,
  getCookie,
  getCookies,
  isServerMode,
  isDebugMode,
  getServerPort,
  getVisionFallbackModel,
  parseJwtToken,
  isTokenExpired,
  getTokenExpiryTime,
  getTokenRemainingTime,
  formatRemainingTime,
  reloadConfig,
  shouldRefreshToken,
  getTokenRefreshInfo,
  // Backward compatibility aliases
  getSalt: getApiKey,
  isServerEnv: isServerMode,
  isDebug: isDebugMode,
  getPort: getServerPort,
};


