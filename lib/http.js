// HTTP Wrapper: Unified axios instance, request/response interception and error handling
const axios = require('axios');
const { logger } = require('./logger');
const https = require('https');
const httpModule = require('http');

// Create basic instance (optimize concurrent performance)
const http = axios.create({
  timeout: 60000,
  maxRedirects: 5,
  // Optimize concurrent connections
  httpsAgent: new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10
  }),
  httpAgent: new httpModule.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 50,
    maxFreeSockets: 10
  })
});

// Request interception: Record key information (avoid printing sensitive Token)
http.interceptors.request.use((config) => {
  const headers = { ...config.headers };
  if (headers.Authorization) headers.Authorization = headers.Authorization.slice(0, 10) + '...';
  logger.debug('HTTP Request', { method: config.method, url: config.url, headers });
  return config;
});

// Response interception: Unified error handling and logging
http.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    logger.error('HTTP Response Error', error, { status, dataPreview: typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500) });
    return Promise.reject(error);
  }
);

module.exports = { http };


