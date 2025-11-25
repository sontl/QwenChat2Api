// Configuration loader: Unified handling of environment variables and configuration file reading
// Prioritize environment variables, then configuration files, finally default values
const fs = require('fs');
const path = require('path');

// Configuration file paths
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const COOKIE_PATH = path.join(__dirname, '..', 'cookie.txt');

// Safe file reading function
function safeReadFile(filePath, defaultValue = '') {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
    return defaultValue;
  } catch (error) {
    console.warn(`Failed to read file: ${filePath}`, error.message);
    return defaultValue;
  }
}

// Check if using environment variable mode
function isEnvMode() {
  return !!(process.env.QWEN_TOKEN || process.env.API_KEY || process.env.COOKIE);
}

// Load configuration: prioritize environment variables, otherwise read from file
function loadConfig() {
  // Prioritize environment variables
  if (isEnvMode()) {
    return {
      API_KEY: process.env.API_KEY || '',
      QWEN_TOKEN: process.env.QWEN_TOKEN || '',
      SERVER_MODE: process.env.SERVER_MODE !== 'false',
      DEBUG_MODE: process.env.DEBUG_MODE === 'true',
      SERVER_PORT: Number(process.env.SERVER_PORT || process.env.PORT || 8000),
      VISION_FALLBACK_MODEL: process.env.VISION_FALLBACK_MODEL || 'qwen3-vl-plus',
      AUTO_REFRESH_TOKEN: process.env.AUTO_REFRESH_TOKEN !== 'false',
      TOKEN_REFRESH_INTERVAL_HOURS: Number(process.env.TOKEN_REFRESH_INTERVAL_HOURS || 24)
    };
  }

  // Read from file
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (error) {
    console.warn('Failed to read config file, using default configuration', error.message);
  }

  // Default configuration
  return {
    API_KEY: '',
    QWEN_TOKEN: '',
    SERVER_MODE: true,
    DEBUG_MODE: false,
    SERVER_PORT: 8000,
    VISION_FALLBACK_MODEL: 'qwen3-vl-plus',
    AUTO_REFRESH_TOKEN: true,
    TOKEN_REFRESH_INTERVAL_HOURS: 24
  };
}

// Read Cookie: prioritize environment variables
function loadCookie() {
  if (process.env.COOKIE) {
    return process.env.COOKIE.trim();
  }
  return safeReadFile(COOKIE_PATH);
}

// Read multiple Cookies: support multi-line files or separator (|||)
function loadCookies() {
  let cookies = [];

  // Prioritize environment variables
  if (process.env.COOKIE) {
    const cookieStr = process.env.COOKIE.trim();
    // Support separator ||| or newline
    if (cookieStr.includes('|||')) {
      cookies = cookieStr.split('|||').map(c => c.trim()).filter(c => c.length > 0);
    } else {
      cookies = [cookieStr];
    }
  } else {
    // Read from file, support multi-lines
    const cookieContent = safeReadFile(COOKIE_PATH);
    if (cookieContent) {
      cookies = cookieContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#')); // Support comment lines
    }
  }

  return cookies;
}

// Read configuration file (for token refresh and other scenarios)
function readConfigFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    return null;
  } catch (error) {
    console.warn('Failed to read config file', error.message);
    return null;
  }
}

// Update token in configuration file
function updateConfigFile(newToken, newCookie) {
  try {
    let configUpdated = false;
    let cookieUpdated = false;

    // Update token in configuration file
    if (newToken) {
      const config = readConfigFile();
      if (config) {
        config.QWEN_TOKEN = newToken;

        // Backup original config file
        const backupPath = CONFIG_PATH + '.backup.' + Date.now();
        fs.writeFileSync(backupPath, fs.readFileSync(CONFIG_PATH));

        // Write new configuration
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        configUpdated = true;
      }
    }

    // Update cookie file
    if (newCookie) {
      // Backup original cookie file
      const cookieBackupPath = COOKIE_PATH + '.backup.' + Date.now();
      if (fs.existsSync(COOKIE_PATH)) {
        fs.writeFileSync(cookieBackupPath, fs.readFileSync(COOKIE_PATH));
      }

      // Write new cookie
      fs.writeFileSync(COOKIE_PATH, newCookie);
      cookieUpdated = true;
    }

    return { configUpdated, cookieUpdated };
  } catch (error) {
    console.error('Failed to update config file', error);
    return { configUpdated: false, cookieUpdated: false };
  }
}

// Reload configuration (for use after token refresh)
function reloadConfig(currentConfig) {
  try {
    // If using environment variables, skip file reloading
    if (isEnvMode()) {
      const newConfig = loadConfig();
      Object.assign(currentConfig, newConfig);
      return true;
    }

    // Reload from file
    const newConfig = readConfigFile();
    if (newConfig) {
      Object.assign(currentConfig, newConfig);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to reload configuration:', error);
    return false;
  }
}

// Get token (prioritize environment variables, then config file)
function getToken() {
  if (process.env.QWEN_TOKEN) {
    return process.env.QWEN_TOKEN;
  }
  const config = readConfigFile();
  return config?.QWEN_TOKEN || '';
}

// Get cookie (prioritize environment variables, then file)
function getCookie() {
  return loadCookie();
}

module.exports = {
  loadConfig,
  loadCookie,
  loadCookies,
  readConfigFile,
  updateConfigFile,
  reloadConfig,
  getToken,
  getCookie,
  isEnvMode,
  CONFIG_PATH,
  COOKIE_PATH
};

