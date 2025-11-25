// Token Refresh Module: Automatically acquire new Qwen tokens
const { http } = require('./http');
const { logger } = require('./logger');
const { 
  readConfigFile, 
  updateConfigFile, 
  getCookie, 
  getToken, 
  isEnvMode 
} = require('./config-loader');

// API endpoint for refreshing tokens
const AUTH_REFRESH_URL = 'https://chat.qwen.ai/api/v1/auths/';

// Update token in config file and cookie file
function updateConfig(newToken, newCookie) {
  const { configUpdated, cookieUpdated } = updateConfigFile(newToken, newCookie);
  logger.info('Configuration file updated', {
    tokenUpdated: configUpdated,
    cookieUpdated: cookieUpdated
  });
  return configUpdated || cookieUpdated;
}

// Main function to get token from cookie
// Optional parameter: specify cookie to use (for multi-cookie load balancing)
async function getTokenFromCookie(cookieToUse = null) {
  try {
    logger.info('Starting to get token from cookie...');

    // Use unified config loader to get cookie, use specified cookie if provided
    const cookie = cookieToUse || getCookie();

    if (!cookie) {
      logger.error('Cookie is empty or not set');
      return { success: false, error: 'Cookie is empty or not set' };
    }

    // Build request headers, simulate browser request
    const headers = {
      "accept": "*/*",
      "accept-language": "zh,zh-CN;q=0.9,zh-TW;q=0.8,en-US;q=0.7,en;q=0.6",
      "bx-v": "2.5.31",
      "cache-control": "no-cache",
      "content-type": "application/json; charset=UTF-8",
      "pragma": "no-cache",
      "sec-ch-ua": '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "source": "web",
      "timezone": new Date().toISOString(),
      "x-request-id": require('crypto').randomUUID(),
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "cookie": cookie
    };

    // Send request
    const response = await http.get(AUTH_REFRESH_URL, { headers });

    if (response.status === 200 && response.data) {
      const data = response.data;

      // Extract token
      let newToken = null;

      // Extract token from response (usually in data.token or data.access_token fields)
      if (data.token) {
        newToken = data.token;
      } else if (data.access_token) {
        newToken = data.access_token;
      } else if (data.data && data.data.token) {
        newToken = data.data.token;
      }

      if (newToken) {
        // If using environment variable mode, only update config in memory, don't write to file
        if (isEnvMode()) {
          logger.info('Token acquired successfully (env var mode, only updating memory)', {
            newTokenLength: newToken.length
          });
          // Notify caller that environment variables need to be updated
          return { success: true, newToken, envMode: true };
        }

        // Update token in config file
        const success = updateConfig(newToken, null);
        if (success) {
          logger.info('Token acquisition successful', {
            newTokenLength: newToken.length
          });
          return { success: true, newToken };
        } else {
          logger.error('Token acquisition failed: unable to update config file');
          return { success: false, error: 'Config file update failed' };
        }
      } else {
        logger.error('Token acquisition failed: token not found in response', { responseData: data });
        return { success: false, error: 'Token not found in response' };
      }
    } else {
      logger.error('Token acquisition failed: HTTP request failed', {
        status: response.status,
        data: response.data
      });
      return { success: false, error: `HTTP request failed: ${response.status}` };
    }
  } catch (error) {
    logger.error('Error occurred during token acquisition', error);
    return { success: false, error: error.message };
  }
}

// Main function to refresh token (maintain backward compatibility)
async function refreshToken() {
  return await getTokenFromCookie();
}

// Check if token needs to be refreshed (based on expiration time)
function shouldRefreshToken(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || !decoded.payload || !decoded.payload.exp) {
      return true; // Unable to parse, need to refresh
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const expiryTime = decoded.payload.exp;
    const timeUntilExpiry = expiryTime - currentTime;

    // If token expires within 24 hours, need to refresh
    const oneDayInSeconds = 24 * 60 * 60;
    return timeUntilExpiry < oneDayInSeconds;
  } catch (error) {
    logger.error('Failed to check token expiration time', error);
    return true; // Also refresh on error
  }
}

// Schedule token refresh (check once per day)
// Optional parameter: config object (for updating in-memory config in env var mode)
function startTokenRefreshScheduler(configObject = null) {
  // Check immediately once
  checkAndRefreshToken(configObject);

  // Read refresh interval from config (env var first, then config file)
  const intervalHours = Number(
    process.env.TOKEN_REFRESH_INTERVAL_HOURS ||
    readConfigFile()?.TOKEN_REFRESH_INTERVAL_HOURS ||
    24
  );
  const interval = intervalHours * 60 * 60 * 1000; // Convert to milliseconds

  setInterval(() => {
    checkAndRefreshToken(configObject);
  }, interval);

  logger.info('Token auto-refresh scheduler started', {
    checkInterval: `${intervalHours} hours`,
    nextCheck: new Date(Date.now() + interval).toISOString()
  });
}

// Check and refresh token
// Optional parameter: config object (for updating in-memory config in env var mode)
async function checkAndRefreshToken(configObject = null) {
  try {
    // Use unified config loader to get token
    const token = getToken();

    if (!token) {
      logger.warn('No QWEN_TOKEN found, skipping refresh check');
      return false;
    }

    const shouldRefresh = shouldRefreshToken(token);
    if (shouldRefresh) {
      logger.info('Detected that token needs refresh, starting refresh...');
      const result = await refreshToken();
      if (result.success) {
        // If env var mode and config object passed, directly update in-memory config
        if (result.envMode && result.newToken) {
          if (configObject) {
            configObject.QWEN_TOKEN = result.newToken;
            logger.info('Token auto-refresh completed (env var mode, updated in-memory config)', {
              newTokenLength: result.newToken.length
            });
          } else {
            logger.warn('Token has been refreshed, but in env var mode need to manually update QWEN_TOKEN env var or pass config object');
          }
        } else {
          logger.info('Token auto-refresh completed');
        }
        return true;
      } else {
        logger.error('Token auto-refresh failed', { error: result.error });
        return false;
      }
    } else {
      logger.info('Token still valid, skipping refresh');
      return false;
    }
  } catch (error) {
    logger.error('Error occurred while checking token refresh', error);
    return false;
  }
}

module.exports = {
  getTokenFromCookie,
  refreshToken,
  shouldRefreshToken,
  startTokenRefreshScheduler,
  checkAndRefreshToken,
  updateConfig
};
