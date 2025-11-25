// Identity Pool Module: Manage multiple Cookie/Token combinations to implement load balancing and failover
const { randomUUID } = require('crypto');
const { getCookies, isTokenExpired, getTokenExpiryTime, getTokenRemainingTime } = require('./config');
const { getTokenFromCookie } = require('./token-refresh');
const { logger } = require('./logger');

// Identity status
const IDENTITY_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  DOWN: 'down'
};

// Identity object
class Identity {
  constructor(id, cookie) {
    this.id = id;
    this.cookie = cookie;
    this.token = null;
    this.tokenExp = null; // Expiration time (timestamp in milliseconds)
    this.status = IDENTITY_STATUS.HEALTHY;
    this.failCount = 0;
    this.lastUsedAt = null;
    this.nextRetryAt = null; // Circuit breaker recovery time
    this.lastError = null;
  }

  // Check if available
  isAvailable() {
    if (this.status === IDENTITY_STATUS.DOWN) {
      return false;
    }
    if (this.nextRetryAt && Date.now() < this.nextRetryAt) {
      return false; // Still in circuit breaker period
    }
    if (!this.token || isTokenExpired(this.token)) {
      return false;
    }
    return true;
  }

  // Mark failure
  markFailure(error = null) {
    this.failCount++;
    this.lastError = error;

    // Adjust status based on failure count
    if (this.failCount >= 5) {
      this.status = IDENTITY_STATUS.DOWN;
      this.nextRetryAt = Date.now() + 5 * 60 * 1000; // Retry after 5 minutes
    } else if (this.failCount >= 3) {
      this.status = IDENTITY_STATUS.DEGRADED;
      this.nextRetryAt = Date.now() + 2 * 60 * 1000; // Retry after 2 minutes
    }

    logger.warn(`Identity ${this.id} marked as failed`, {
      failCount: this.failCount,
      status: this.status,
      error: error?.message || error
    });
  }

  // Mark success
  markSuccess() {
    if (this.failCount > 0) {
      this.failCount = Math.max(0, this.failCount - 1); // Decrease failure count on success
    }
    if (this.status !== IDENTITY_STATUS.HEALTHY && this.isAvailable()) {
      this.status = IDENTITY_STATUS.HEALTHY;
      this.nextRetryAt = null;
      logger.info(`Identity ${this.id} recovered to health`, { status: this.status });
    }
    this.lastUsedAt = Date.now();
  }

  // Update token
  updateToken(token) {
    this.token = token;
    this.tokenExp = getTokenExpiryTime(token);
    if (!this.tokenExp) {
      logger.warn(`Identity ${this.id} token cannot parse expiration time`);
    }
  }
}

// Identity Pool Management Class
class IdentityPool {
  constructor() {
    this.identities = [];
    this.currentIndex = 0; // Round-robin index
    this.initialized = false;
  }

  // Initialize identity pool
  async initialize() {
    if (this.initialized) {
      return;
    }

    logger.info('Starting identity pool initialization...');
    const cookies = getCookies();

    if (cookies.length === 0) {
      logger.warn('No Cookie found, identity pool will be empty');
      this.initialized = true;
      return;
    }

    logger.info(`Found ${cookies.length} Cookies, starting to get corresponding Tokens...`);

    // Create identity for each Cookie and get Token
    const initPromises = cookies.map(async (cookie, index) => {
      const id = `identity-${index + 1}`;
      const identity = new Identity(id, cookie);

      try {
        logger.info(`Getting Token for ${id}...`);
        const result = await getTokenFromCookie(cookie);

        if (result.success && result.newToken) {
          identity.updateToken(result.newToken);
          logger.info(`${id} Token acquisition successful`, {
            tokenLength: result.newToken.length,
            expiresAt: identity.tokenExp ? new Date(identity.tokenExp).toISOString() : 'unknown'
          });
        } else {
          identity.status = IDENTITY_STATUS.DEGRADED;
          identity.markFailure(result.error || 'Token acquisition failed');
          logger.error(`${id} Token acquisition failed`, { error: result.error });
        }
      } catch (error) {
        identity.status = IDENTITY_STATUS.DEGRADED;
        identity.markFailure(error);
        logger.error(`${id} initialization failed`, error);
      }

      return identity;
    });

    this.identities = await Promise.all(initPromises);

    const healthyCount = this.identities.filter(id => id.isAvailable()).length;
    logger.info(`Identity pool initialization completed`, {
      total: this.identities.length,
      healthy: healthyCount,
      degraded: this.identities.filter(id => id.status === IDENTITY_STATUS.DEGRADED).length,
      down: this.identities.filter(id => id.status === IDENTITY_STATUS.DOWN).length
    });

    this.initialized = true;
  }

  // Get available identity (round-robin strategy)
  getAvailableIdentity() {
    if (this.identities.length === 0) {
      return null;
    }

    // Filter out available identities
    const availableIdentities = this.identities.filter(id => id.isAvailable());

    if (availableIdentities.length === 0) {
      // If no available identity, try to use all identities (including circuit-breaked)
      const allIdentities = this.identities.filter(id => id.token);
      if (allIdentities.length === 0) {
        return null;
      }
      logger.warn('All identities are unavailable, using degraded identities');
      return allIdentities[this.currentIndex % allIdentities.length];
    }

    // Round-robin selection
    const selected = availableIdentities[this.currentIndex % availableIdentities.length];
    this.currentIndex = (this.currentIndex + 1) % availableIdentities.length;

    return selected;
  }

  // Mark identity failure
  markIdentityFailure(identity, error = null) {
    if (identity) {
      identity.markFailure(error);
    }
  }

  // Mark identity success
  markIdentitySuccess(identity) {
    if (identity) {
      identity.markSuccess();
    }
  }

  // Refresh Token for specified identity
  async refreshIdentityToken(identity) {
    if (!identity) {
      return false;
    }

    try {
      logger.info(`Refreshing Token for identity ${identity.id}...`);
      const result = await getTokenFromCookie(identity.cookie);

      if (result.success && result.newToken) {
        identity.updateToken(result.newToken);
        identity.markSuccess();
        logger.info(`Identity ${identity.id} Token refresh successful`);
        return true;
      } else {
        identity.markFailure(result.error || 'Token refresh failed');
        logger.error(`Identity ${identity.id} Token refresh failed`, { error: result.error });
        return false;
      }
    } catch (error) {
      identity.markFailure(error);
      logger.error(`Error occurred while refreshing Token for identity ${identity.id}`, error);
      return false;
    }
  }

  // Check and refresh all tokens that need to be refreshed
  async refreshExpiredTokens() {
    const refreshPromises = this.identities.map(async (identity) => {
      // Check if refresh is needed (expires within 24 hours or already expired)
      if (!identity.token || isTokenExpired(identity.token)) {
        return await this.refreshIdentityToken(identity);
      }

      const remainingTime = getTokenRemainingTime(identity.token);
      const oneDayInMs = 24 * 60 * 60 * 1000;

      if (remainingTime < oneDayInMs) {
        return await this.refreshIdentityToken(identity);
      }

      return false;
    });

    const results = await Promise.all(refreshPromises);
    const refreshedCount = results.filter(r => r === true).length;

    if (refreshedCount > 0) {
      logger.info(`Refreshed Tokens for ${refreshedCount} identities`);
    }

    return refreshedCount;
  }

  // Get pool status information
  getPoolStatus() {
    const healthy = this.identities.filter(id => id.status === IDENTITY_STATUS.HEALTHY && id.isAvailable()).length;
    const degraded = this.identities.filter(id => id.status === IDENTITY_STATUS.DEGRADED).length;
    const down = this.identities.filter(id => id.status === IDENTITY_STATUS.DOWN).length;

    return {
      total: this.identities.length,
      healthy,
      degraded,
      down,
      initialized: this.initialized
    };
  }

  // Get all identity details (for debugging)
  getAllIdentities() {
    return this.identities.map(id => ({
      id: id.id,
      status: id.status,
      failCount: id.failCount,
      hasToken: !!id.token,
      tokenExpired: id.token ? isTokenExpired(id.token) : true,
      lastUsedAt: id.lastUsedAt ? new Date(id.lastUsedAt).toISOString() : null,
      nextRetryAt: id.nextRetryAt ? new Date(id.nextRetryAt).toISOString() : null
    }));
  }
}

// Create global singleton
const identityPool = new IdentityPool();

module.exports = {
  identityPool,
  IDENTITY_STATUS,
  Identity
};

