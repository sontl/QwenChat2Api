const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { randomUUID } = require('crypto');
const { config, getApiKey, getQwenToken, getCookie, getCookies, isServerMode, isDebugMode, getServerPort, getVisionFallbackModel, isTokenExpired, getTokenRemainingTime, formatRemainingTime, reloadConfig, getTokenRefreshInfo } = require('./lib/config');
const { startTokenRefreshScheduler, checkAndRefreshToken, getTokenFromCookie } = require('./lib/token-refresh');
const { buildBrowserLikeHeaders } = require('./lib/headers');
const { setSseHeaders, createKeepAlive } = require('./lib/sse');
const { http } = require('./lib/http');
const { logger } = require('./lib/logger');
const { createQwenToOpenAIStreamTransformer, convertQwenResponseToOpenAI, collectOpenAICompletionFromSSE } = require('./lib/transformers');
const { startChatDeletionScheduler } = require('./lib/chat-deletion');
const { identityPool } = require('./lib/identity-pool');

// Logging is managed by lib/logger.js

const QWEN_API_BASE_URL = 'https://chat.qwen.ai/api/v2/chat/completions';
const QWEN_CHAT_NEW_URL = 'https://chat.qwen.ai/api/v2/chats/new';

// Startup validation: Check basic configuration
function validateConfig() {
  const warnings = [];
  if (!getQwenToken()) warnings.push('QWEN_TOKEN is not set, will attempt to get from Cookie');
  if (!getCookie()) warnings.push('Cookie file does not exist or COOKIE environment variable is not set, please set Cookie to automatically acquire Token');

  if (warnings.length) {
    warnings.forEach(w => console.log('⚠️ ', w));
  }
}

// Token expiration time detection and warning
function checkTokenExpiry() {
  const token = getQwenToken();
  if (!token) return;

  const isExpired = isTokenExpired(token);
  const remainingTime = getTokenRemainingTime(token);
  const formattedTime = formatRemainingTime(remainingTime);

  if (isExpired) {
    console.log('⚠️  WARNING: QWEN_TOKEN has expired!');
    console.log('   Please update the QWEN_TOKEN in the configuration file');
  } else {
    const remainingDays = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
    if (remainingDays <= 7) {
      console.log(`⚠️  WARNING: QWEN_TOKEN will expire in ${formattedTime}`);
      console.log('   It is recommended to update the QWEN_TOKEN in the configuration file in advance');
    } else {
      console.log(`✅ QWEN_TOKEN is valid, remaining time: ${formattedTime}`);
    }
  }
}
// Automatically get token from cookie on startup
async function initializeToken() {
  try {
    // Check if there is already a valid token
    const currentToken = getQwenToken();
    if (currentToken && !isTokenExpired(currentToken)) {
      logger.info('Using existing valid token');
      return;
    }

    // Check if cookie file exists
    const cookie = getCookie();
    if (!cookie) {
      logger.info('Cookie file does not exist or COOKIE environment variable is not set, please set Cookie to automatically acquire Token');
      if (!currentToken) {
        logger.error('No available token and cookie, service cannot start');
        process.exit(1);
      }
      return;
    }

    // Try to get new token from cookie
    logger.info('Cookie detected, attempting to acquire token...');
    const result = await getTokenFromCookie();

    if (result.success) {
      // If in environment variable mode, directly update the configuration in memory
      if (result.envMode && result.newToken) {
        config.QWEN_TOKEN = result.newToken;
        logger.info('Token acquired successfully (environment variable mode, memory configuration updated)', {
          newTokenLength: result.newToken.length
        });
      } else {
        logger.info('Token acquired successfully, reloading configuration');
        reloadConfig();
      }
    } else {
      logger.info('Failed to acquire token from cookie:', result.error);
      if (!currentToken) {
        logger.error('No available token, service may not work properly');
        process.exit(1);
      }
    }
  } catch (error) {
    logger.error('Error occurred during token initialization:', error);
    process.exit(1);
  }
}

// Utility functions: message ID, image detection
function generateMessageId() { return randomUUID(); }
function hasImagesInMessage(message) {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some(item => (item.type === 'image_url' && item.image_url?.url) || (item.type === 'image' && item.image));
}

async function createNewChat(token, cookie, model, chatType) {
  try {
    logger.info('Creating new chat', { model, chatType });
    const requestId = randomUUID();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      'source': 'web',
      'x-request-id': requestId
    };
    if (cookie) headers['Cookie'] = cookie;
    const res = await http.post(QWEN_CHAT_NEW_URL, {
      title: 'New Chat', models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now()
    }, { headers });
    const chatId = res.data?.data?.id || null;
    if (!chatId) logger.error('No chat ID in response', res.data);
    return chatId;
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    logger.error('Error creating new chat', e, { status, dataPreview: typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data || {}).slice(0, 300) });
    return null;
  }
}

function calculateAspectRatio(size) {
  const [w, h] = String(size).split('x').map(Number);
  if (!w || !h) return '1:1';
  const gcd = (a,b)=> b===0?a:gcd(b,a%b);
  const d = gcd(w,h);
  return `${w/d}:${h/d}`;
}

function validateQwenRequest(request) {
  try {
    if (!request.chat_id || !request.messages || !Array.isArray(request.messages)) return false;
    for (const m of request.messages) {
      if (!m.fid || !m.role || m.content === undefined) return false;
      if (m.role === 'user') {
        if (!m.user_action || !m.timestamp || !m.models) return false;
      }
    }
    return true;
  } catch (_) { return false; }
}

async function processImageUpload(imageUrl, authToken, cookie) {
  // Compatible with main.ts: Temporarily skip OSS upload, directly pass through original URL
  let filename = `image_${Date.now()}.png`;
  let mimeType = 'image/png';
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:image/')) {
    const mimeMatch = imageUrl.match(/data:image\/([^;]+)/);
    if (mimeMatch) { mimeType = `image/${mimeMatch[1]}`; filename = `image_${Date.now()}.${mimeMatch[1]}`; }
  } else if (typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
    const urlMatch = imageUrl.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i);
    if (urlMatch) { const ext = urlMatch[1].toLowerCase(); mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`; filename = `image_${Date.now()}.${ext}`; }
  }
  return {
    type: 'image',
    file: { created_at: Date.now(), data: {}, filename, hash: null, id: randomUUID(), user_id: 'system', meta: { name: filename, size: 0, content_type: mimeType }, update_at: Date.now() },
    id: randomUUID(),
    url: imageUrl,
    name: filename,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    greenNet: 'success',
    size: 0,
    error: '',
    itemId: randomUUID(),
    file_type: mimeType,
    showType: 'image',
    file_class: 'vision',
    uploadTaskId: randomUUID()
  };
}

function extractImagesFromHistory(messages) {
  const images = [];
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'assistant' && typeof message.content === 'string') {
      const md = /!\[.*?\]\((.*?)\)/g; for (const m of message.content.matchAll(md)) { if (m[1]) images.push(m[1]); }
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        const md = /!\[.*?\]\((.*?)\)/g; for (const m of message.content.matchAll(md)) { if (m[1]) images.push(m[1]); }
      } else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'image_url' && item.image_url?.url) images.push(item.image_url.url);
          else if (item.type === 'image' && item.image) images.push(item.image);
        }
      }
    }
  }
  return images.slice(-3);
}

async function transformOpenAIRequestToQwen(openAIRequest, token, cookie, opts = {}) {
  if (!openAIRequest.messages || !Array.isArray(openAIRequest.messages)) throw new Error('Invalid request: messages array is required');
  if (openAIRequest.messages.length === 0) throw new Error('Invalid request: messages array cannot be empty');
  const model = openAIRequest.model || 'qwen-max';
  const wantStream = openAIRequest.stream !== false; // Default stream, explicit false means non-stream
  let chat_type = 't2t';
  const hasImages = openAIRequest.messages.some(msg => hasImagesInMessage(msg));
  if (model.endsWith('-image')) chat_type = 't2i';
  else if (model.endsWith('-image_edit')) chat_type = 'image_edit';
  else if (model.endsWith('-video')) chat_type = 't2v';
  else if (hasImages) { chat_type = 't2t'; }
  let qwenModel = model.replace(/-(search|thinking|image|image_edit|video)$/,'');
  let usedFallback = false;
  const disableVisionFallback = !!opts.disableVisionFallback;
  if (!disableVisionFallback && hasImages && !/(image|image_edit|video)$/.test(model) && config.VISION_FALLBACK_MODEL) {
    qwenModel = config.VISION_FALLBACK_MODEL;
    usedFallback = true;
    logger.info('Image detected, switched to visual fallback model', { fallback: qwenModel });
  }
  const chatId = await createNewChat(token, cookie, qwenModel, chat_type);
  if (!chatId) throw new Error('Failed to create chat session');

  if (chat_type === 'image_edit') {
    const lastUserMessage = openAIRequest.messages.filter(m=>m.role==='user').pop();
    if (!lastUserMessage) throw new Error('User message for image editing not found.');
    let textContent = '';
    const currentMessageImages = [];
    if (typeof lastUserMessage.content === 'string') textContent = lastUserMessage.content;
    else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) {
        if (item.type === 'text') textContent += (item.text || item.content || '');
        else if (item.type === 'image_url' && item.image_url?.url) currentMessageImages.push(item.image_url.url);
        else if (item.type === 'image' && item.image) currentMessageImages.push(item.image);
      }
    }
    const historyImages = extractImagesFromHistory(openAIRequest.messages.slice(0,-1));
    const allImages = [...currentMessageImages, ...historyImages];
    const imagesToUse = allImages.slice(-3);
    const files = [];
    if (imagesToUse.length > 0) {
      for (const imageUrl of imagesToUse) {
        try {
          const uploadedFile = await processImageUpload(imageUrl, token, cookie);
          files.push(uploadedFile);
        } catch (e) {
          logger.error('Image upload failed, skipping this image', e);
        }
      }
      if (files.length === 0) {
        logger.error('All image uploads failed, switching to text-to-image mode');
      }
    }
    const messageId = generateMessageId();
    const timestamp = Math.floor(Date.now()/1000);
    const actualChatType = files.length > 0 ? 'image_edit' : 't2i';
    const transformedRequest = {
      stream: wantStream,
      incremental_output: wantStream,
      chat_id: chatId,
      chat_mode: 'normal',
      model: qwenModel,
      parent_id: null,
      messages: [{
        fid: messageId,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: textContent || 'Generate an image',
        user_action: 'chat',
        files,
        timestamp,
        models: [qwenModel],
        chat_type: actualChatType,
        feature_config: { thinking_enabled: false, output_schema: 'phase' },
        extra: { meta: { subChatType: actualChatType } },
        sub_chat_type: actualChatType,
        parent_id: null
      }],
      timestamp
    };
    return { request: transformedRequest, chatId, usedFallback };
  }

  if (chat_type === 't2i') {
    const lastUserMessage = openAIRequest.messages.filter(m=>m.role==='user').pop();
    if (!lastUserMessage) throw new Error('User message for image generation not found.');
    const openAISize = openAIRequest.size || '1024x1024';
    const sizeMap = { '256x256':'1:1','512x512':'1:1','1024x1024':'1:1','1792x1024':'16:9','1024x1792':'9:16','2048x2048':'1:1','1152x768':'3:2','768x1152':'2:3' };
    const qwenSize = sizeMap[openAISize] || calculateAspectRatio(openAISize);
    let textContent='';
    if (typeof lastUserMessage.content === 'string') textContent = lastUserMessage.content;
    else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) if (item.type==='text') textContent += (item.text || item.content || '');
    }
    const messageId = generateMessageId();
    const timestamp = Math.floor(Date.now()/1000);
    const transformedRequest = {
      stream: wantStream,
      incremental_output: wantStream,
      chat_id: chatId,
      chat_mode: 'normal',
      model: qwenModel,
      parent_id: null,
      size: qwenSize,
      messages: [{
        fid: messageId,
        parentId: null,
        childrenIds: [],
        role: 'user',
        content: textContent || 'Generate an image',
        user_action: 'chat',
        files: [],
        timestamp,
        models: [qwenModel],
        chat_type: 't2i',
        feature_config: { thinking_enabled: false, output_schema: 'phase' },
        extra: { meta: { subChatType: 't2i' } },
        sub_chat_type: 't2i',
        parent_id: null
      }],
      timestamp
    };
    return { request: transformedRequest, chatId, usedFallback };
  }

  const timestamp = Math.floor(Date.now()/1000);
  const transformedMessages = await Promise.all((openAIRequest.messages||[]).map(async (msg, index) => {
    const messageId = generateMessageId();
    let files = [];
    let content = msg.content;
    let messageChatType = chat_type;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const textParts = []; const imageUrls = [];
      for (const item of msg.content) {
        if (item.type==='text') textParts.push(item.text || item.content || '');
        else if (item.type==='image_url' && item.image_url?.url) imageUrls.push(item.image_url.url);
        else if (item.type==='image' && item.image) imageUrls.push(item.image);
      }
      if (imageUrls.length > 0) {
        try {
          for (const imageUrl of imageUrls) { const uploadedFile = await processImageUpload(imageUrl, token, cookie); files.push(uploadedFile); }
          if (files.length > 0) messageChatType = 't2t';
        } catch (e) { logger.error('Image upload failed, will skip image processing', e); }
      }
      content = textParts.join(' ');
    }
    return {
      fid: messageId,
      parentId: index > 0 ? null : null,
      childrenIds: [],
      role: msg.role,
      content,
      user_action: msg.role === 'user' ? 'chat' : undefined,
      files,
      timestamp,
      models: [model.replace(/-(search|thinking|image|image_edit|video)$/,'')],
      chat_type: messageChatType,
      feature_config: { thinking_enabled: model.includes('-thinking'), output_schema: 'phase' },
      extra: { meta: { subChatType: messageChatType } },
      sub_chat_type: messageChatType,
      parent_id: null
    };
  }));
  const transformedRequest = { stream: wantStream, incremental_output: wantStream, chat_id: chatId, chat_mode: 'normal', model: model.replace(/-(search|thinking|image|image_edit|video)$/,''), parent_id: null, messages: transformedMessages, timestamp };
  return { request: transformedRequest, chatId, usedFallback };
}

// Streaming transformer is provided by lib/transformers.js
// Chat deletion functionality is managed by lib/chat-deletion.js

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Authentication middleware (supports both server-side and client-side modes)
// - Server-side mode: Only verify API_KEY, QWEN_TOKEN is injected from config
// - Client-side mode: Parse api_key;qwen_token;cookie from Authorization header
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health') return next();
  try {
    if (isServerMode()) {
      // Server-side authentication: Only verify API_KEY (if configured), and inject token from config
      const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
      const apiKeyHeader = req.headers['x-api-key'] || '';
      const queryApiKey = (req.query && (req.query.api_key || req.query.key)) || '';
      const bodyApiKey = (req.body && typeof req.body === 'object' && (req.body.api_key || req.body.key)) || '';
      if (getApiKey()) {
        const bearer = String(authHeader).startsWith('Bearer ')
          ? String(authHeader).replace(/^Bearer\s+/i, '')
          : '';
        const candidate = String(bearer || apiKeyHeader || queryApiKey || bodyApiKey || '').trim();
        if (!candidate || candidate !== getApiKey()) {
          return res.status(401).json({ error: 'Authentication failed', message: 'Invalid API key' });
        }
      }
      req.state = { qwenToken: config.QWEN_TOKEN, ssxmodItna: getCookie() };
      return next();
    } else {
      const authHeader = req.headers['authorization'];
      const clientToken = (authHeader || '').replace(/^Bearer\s+/i, '');
      if (!clientToken) {
        const expected = getApiKey() ? 'Bearer api_key;qwen_token;ssxmod_itna' : 'Bearer qwen_token;ssxmod_itna';
        return res.status(401).json({ error: 'Authentication failed', message: 'No authentication token provided', format: expected, api_key_required: !!getApiKey() });
      }
      const parts = clientToken.split(';');
      let qwenToken, ssxmodItna;
      if (getApiKey()) {
        if (parts[0]?.trim() !== getApiKey()) return res.status(401).json({ error: 'Authentication failed', message: 'Invalid API key' });
        qwenToken = parts[1]?.trim(); ssxmodItna = parts[2]?.trim() || '';
      } else { qwenToken = parts[0]?.trim(); ssxmodItna = parts[1]?.trim() || ''; }
      if (!qwenToken) return res.status(401).json({ error: 'Authentication failed', message: 'Qwen token required' });
      req.state = { qwenToken, ssxmodItna };
      return next();
    }
  } catch (e) { logger.error('Error during authentication', e); return res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/', (req, res) => {
  const apiKeyStatus = getApiKey() ? '🔒 Restricted Access Mode' : '🎯 Open Access Mode';
  const authMode = isServerMode() ? 'Server-side Authentication (Configuration File)' : 'Client-side Authentication (Request Header)';
  const authFormat = isServerMode()
    ? (getApiKey() ? 'Authorization: Bearer your_api_key' : 'Authorization Optional')
    : (getApiKey() ? 'Authorization: Bearer api_key;qwen_token;ssxmod_itna_value' : 'Authorization: Bearer qwen_token;ssxmod_itna_value');
  res.set('Content-Type','text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Qwen API Proxy</title><script src="https://cdn.tailwindcss.com"></script></head><body class="font-sans min-h-screen flex items-center justify-center p-5 bg-gradient-to-br from-indigo-500 to-purple-600"><div class="w-full max-w-lg rounded-2xl bg-white/95 p-10 text-center shadow-2xl backdrop-blur-md"><div class="mb-3 flex items-center justify-center gap-2"><div class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></div><div class="text-lg font-semibold text-gray-800">Service Running</div></div><div class="mb-8 text-sm leading-relaxed text-gray-500">The service is running normally</div><div class="mb-8 text-left"><div class="mb-4 text-base font-semibold text-gray-700">API Endpoints</div><div class="flex items-center justify-between border-b border-gray-100 py-3"><span class="text-sm text-gray-500">Models List</span><code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/models</code></div><div class="flex items-center justify-between py-3"><span class="text-sm text-gray-500">Chat Completion</span><code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/chat/completions</code></div></div><div class="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-left"><div class="mb-2 text-sm font-semibold text-gray-700">Authentication Method</div><div class="mb-1 text-xs font-medium text-emerald-600">${apiKeyStatus}</div><div class="mb-3 text-xs font-medium text-indigo-600">${authMode}</div><div class="font-mono break-all rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-[12px] leading-snug text-gray-600">${authFormat}</div></div><div class="text-xs font-medium text-gray-400"><span class="text-indigo-500">Qwen API Proxy v3.11</span><br/><span class="text-gray-400 mt-1">🚀 Supports Latest API Format</span></div></div></body></html>`);
});

app.get('/v1/models', async (req, res) => {
  // Get identity (prioritize identity pool, otherwise use traditional method)
  let identity = null;
  let token = req.state?.qwenToken;
  let ssx = req.state?.ssxmodItna || getCookie();

  if (identityPool.initialized) {
    identity = identityPool.getAvailableIdentity();
    if (identity) {
      token = identity.token;
      ssx = identity.cookie;
    }
  }

  if (!token) return res.status(401).json({ error: 'Authentication failed. No available Qwen token.' });
  try {
    const headers = buildBrowserLikeHeaders(token, { includeCookie: false });
    if (ssx) headers['Cookie'] = ssx;
    const rsp = await http.get('https://chat.qwen.ai/api/models', { headers });

    // Mark identity as successful
    if (identity && identity.id !== 'legacy') {
      identityPool.markIdentitySuccess(identity);
    }
    const originalModels = rsp.data?.data || [];
    const processedModels = [];
    for (const model of originalModels) {
      processedModels.push(model);
      if (model?.info?.meta?.abilities?.thinking) processedModels.push({ ...model, id: `${model.id}-thinking` });
      if (model?.info?.meta?.chat_type?.includes('search')) processedModels.push({ ...model, id: `${model.id}-search` });
      if (model?.info?.meta?.chat_type?.includes('t2i')) { processedModels.push({ ...model, id: `${model.id}-image` }); processedModels.push({ ...model, id: `${model.id}-image_edit` }); }
      if (model?.info?.meta?.chat_type?.includes('image_edit')) { if (!processedModels.some(m => m.id === `${model.id}-image_edit`)) processedModels.push({ ...model, id: `${model.id}-image_edit` }); }
    }
    // Fallback: if upstream is empty, return a set of common models to avoid frontend unavailability
    if (processedModels.length === 0) {
      const fallback = [
        { id: 'qwen3-max', object: 'model' },
        { id: 'qwen3-max-thinking', object: 'model' },
        { id: 'qwen3-max-image', object: 'model' },
        { id: 'qwen3-max-image_edit', object: 'model' },
        { id: 'qwen3-vl-plus', object: 'model' }
      ];
      return res.json({ object: 'list', data: fallback });
    }
    res.json({ object: 'list', data: processedModels });
  } catch (e) {
    // Mark identity as failed
    if (identity && identity.id !== 'legacy') {
      identityPool.markIdentityFailure(identity, e);
    }
    logger.error('Error getting models', e);
    res.status(502).json({ error: 'Failed to get models from upstream API.', details: e.message });
  }
});

// Helper function to execute request (supports retry)
async function executeQwenRequest(qwenRequest, identity, usedFallback, wantStream, requestId, req, res) {
  let apiUrl = QWEN_API_BASE_URL;
  const requestChatId = qwenRequest.chat_id;
  if (requestChatId) apiUrl = `${QWEN_API_BASE_URL}?chat_id=${requestChatId}`;

  const headers = {
    'Authorization': `Bearer ${identity.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'source': 'web',
    'x-request-id': requestId,
    'accept': '*/*',
    'x-accel-buffering': 'no'
  };
  if (identity.cookie) headers['Cookie'] = identity.cookie;

  // If using visual fallback, supplement more complete browser headers to improve stability
  if (usedFallback) {
    headers['sec-ch-ua'] = '"Google Chrome";v="120", "Chromium";v="120", "Not=A?Brand";v="24"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"macOS"';
    headers['sec-fetch-dest'] = 'empty';
    headers['sec-fetch-mode'] = 'cors';
    headers['sec-fetch-site'] = 'same-origin';
    headers['referer'] = 'https://chat.qwen.ai/';
  }

  logger.info('Will call upstream API', {
    requestId,
    url: apiUrl,
    identityId: identity.id
  });

  if (wantStream) {
    // Stream: SSE forwarding
    setSseHeaders(res, requestId);
    let cleanup = null;
    const { safeWriteDone, cleanup: cleanupFn } = createKeepAlive(res);
    cleanup = cleanupFn;

    try {
      const upstream = await http.post(apiUrl, qwenRequest, { headers, responseType: 'stream' });
      logger.info('Upstream response ready', { requestId, status: upstream.status, identityId: identity.id });

      // Check status code
      if (upstream.status >= 400) {
        identityPool.markIdentityFailure(identity, new Error(`HTTP ${upstream.status}`));
        throw new Error(`Upstream API returned error: ${upstream.status}`);
      }

      // Mark success
      identityPool.markIdentitySuccess(identity);

      const transformer = createQwenToOpenAIStreamTransformer();
      upstream.data.on('error', (e)=>{
        logger.error('Upstream stream error', e);
        identityPool.markIdentityFailure(identity, e);
      });
      transformer.on('error', (e)=>{ logger.error('Transformer error', e); });
      upstream.data.on('end', () => { logger.info('Upstream data stream end', { requestId }); safeWriteDone(); });
      upstream.data.on('close', () => { logger.info('Upstream data stream close', { requestId }); safeWriteDone(); });
      transformer.on('end', () => { logger.info('Transformer end', { requestId }); safeWriteDone(); });
      req.on('close', () => { try { upstream.data.destroy(); } catch (_) {} safeWriteDone(); });
      upstream.data.pipe(transformer).pipe(res, { end: false });
      res.on('close', () => { if (cleanup) cleanup(); logger.info('Response close', { requestId }); });
      res.on('finish', () => { if (cleanup) cleanup(); logger.info('Response finish', { requestId }); });
      return { success: true };
    } catch (upstreamError) {
      identityPool.markIdentityFailure(identity, upstreamError);

      // If upstream request fails but response headers have been sent, need to send error message to client
      if (res.headersSent) {
        logger.error('Upstream request failed but response headers already sent, sending error to client', { requestId, error: upstreamError.message });
        try {
          const errorMessage = `Upstream API request failed: ${upstreamError.message}`;
          const errorChunk = {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now()/1000),
            model: 'qwen-proxy',
            choices: [{ index: 0, delta: { content: errorMessage }, finish_reason: 'stop' }]
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          if (cleanup) cleanup();
          res.end();
        } catch (e) {
          logger.error('Failed to send error message', e);
          if (cleanup) cleanup();
          res.end();
        }
        return { success: false, error: upstreamError, retryable: false };
      }

      return { success: false, error: upstreamError, retryable: true };
    }
  } else {
    // Non-streaming: Some upstream still return incremental results in SSE format, so we prioritize stream collection here
    try {
      const upstream = await http.post(apiUrl, { ...qwenRequest, stream: true, incremental_output: true }, { headers, responseType: 'stream' });
      logger.info('Upstream non-streaming (converted to stream aggregation) response ready', { requestId, status: upstream.status, identityId: identity.id });

      // Check status code
      if (upstream.status >= 400) {
        identityPool.markIdentityFailure(identity, new Error(`HTTP ${upstream.status}`));
        throw new Error(`Upstream API returned error: ${upstream.status}`);
      }

      // Mark success
      identityPool.markIdentitySuccess(identity);

      const content = await collectOpenAICompletionFromSSE(upstream.data);
      const openaiJson = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now()/1000),
        model: 'qwen-proxy',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
      };
      return { success: true, data: openaiJson };
    } catch (error) {
      identityPool.markIdentityFailure(identity, error);
      return { success: false, error, retryable: true };
    }
  }
}

app.post('/v1/chat/completions', async (req, res) => {
  const requestId = randomUUID();

  // Get identity (prioritize identity pool, otherwise use traditional method)
  let identity = null;
  let token = req.state?.qwenToken;
  let ssxmodItna = req.state?.ssxmodItna;

  // If identity pool is initialized and there's an available identity, use the pool
  if (identityPool.initialized) {
    identity = identityPool.getAvailableIdentity();
    if (identity) {
      token = identity.token;
      ssxmodItna = identity.cookie;
      logger.info('Using identity from pool', { identityId: identity.id, requestId });
    }
  }

  // If no identity or token, return error
  if (!token) {
    return res.status(401).json({ error: 'Authentication failed. No available Qwen token.' });
  }

  // If no identity was retrieved from pool, create temporary identity object (for compatibility)
  if (!identity) {
    identity = { token, cookie: ssxmodItna || getCookie(), id: 'legacy' };
  }

  try {
    const openAIRequest = req.body || {};
    const wantStream = openAIRequest.stream !== false; // Default streaming

    // Extract prompt information (first user message)
    let userPrompt = '';
    if (Array.isArray(openAIRequest.messages)) {
      const firstUserMessage = openAIRequest.messages.find(m => m.role === 'user');
      if (firstUserMessage) {
        if (typeof firstUserMessage.content === 'string') {
          userPrompt = firstUserMessage.content;
        } else if (Array.isArray(firstUserMessage.content)) {
          const textParts = firstUserMessage.content
            .filter(item => item.type === 'text')
            .map(item => item.text || item.content || '');
          userPrompt = textParts.join(' ');
        }
        // Truncate long prompts
        if (userPrompt.length > 200) {
          userPrompt = userPrompt.substring(0, 200) + '...';
        }
      }
    }

    const { request: qwenRequest, chatId, usedFallback } = await transformOpenAIRequestToQwen(openAIRequest, token, identity.cookie);
    logger.info('Transformation complete, preparing to request upstream', {
      chatId,
      usedFallback,
      model: qwenRequest?.model,
      messageCount: Array.isArray(qwenRequest?.messages) ? qwenRequest.messages.length : 0,
      chatType: qwenRequest?.messages?.[0]?.chat_type,
      identityId: identity.id,
      userPrompt: userPrompt || '(No text prompt)'
    });
    if (!validateQwenRequest(qwenRequest)) return res.status(400).json({ error: 'Request format transformation failed' });

    // Execute request (supports retry)
    let result = await executeQwenRequest(qwenRequest, identity, usedFallback, wantStream, requestId, req, res);

    // If failed and retryable, try using other identities
    if (!result.success && result.retryable && identityPool.initialized && identity.id !== 'legacy') {
      const maxRetries = 2; // Maximum 2 retries
      for (let retry = 0; retry < maxRetries; retry++) {
        const nextIdentity = identityPool.getAvailableIdentity();
        if (!nextIdentity || nextIdentity.id === identity.id) {
          break; // No other available identities
        }

        logger.info('Attempting to retry with backup identity', {
          requestId,
          oldIdentityId: identity.id,
          newIdentityId: nextIdentity.id,
          retry: retry + 1
        });

        // Recreate chat (using new identity)
        const newChatId = await createNewChat(nextIdentity.token, nextIdentity.cookie, qwenRequest.model, qwenRequest.messages?.[0]?.chat_type || 't2t');
        if (newChatId) {
          qwenRequest.chat_id = newChatId;
        }

        identity = nextIdentity;
        result = await executeQwenRequest(qwenRequest, identity, usedFallback, wantStream, requestId, req, res);

        if (result.success) {
          break; // Retry successful
        }
      }
    }

    // Process result
    if (!result.success) {
      throw result.error;
    }

    // Non-streaming returns data
    if (!wantStream && result.data) {
      res.json(result.data);
    }
  } catch (e) {
    const status = e?.response?.status || 500;
    const data = e?.response?.data;
    logger.error('Error in chat completion proxy', e, { requestId, status, dataPreview: typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500) });
    if (!res.headersSent) res.status(status).json({ error: 'Upstream API request failed', details: data || e.message, requestId });
  }
});

app.get('/health', (req, res) => {
  const tokenRefreshInfo = getTokenRefreshInfo();
  const poolStatus = identityPool.getPoolStatus();
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(), 
    version: '3.11', 
    config: { 
      apiKeyEnabled: !!getApiKey(), 
      serverMode: !!isServerMode(), 
      debugMode: !!isDebugMode(),
      autoRefreshToken: config.AUTO_REFRESH_TOKEN !== false
    },
    token: {
      valid: !tokenRefreshInfo.isExpired,
      expired: tokenRefreshInfo.isExpired,
      remainingTime: tokenRefreshInfo.remainingTime,
      formattedTime: tokenRefreshInfo.formattedTime,
      needsRefresh: tokenRefreshInfo.needsRefresh,
      reason: tokenRefreshInfo.reason
    },
    identityPool: poolStatus
  });
});

// Manual token refresh API endpoint
app.post('/refresh-token', async (req, res) => {
  try {
    logger.info('Received manual token refresh request');
    const result = await getTokenFromCookie();

    if (result.success) {
      // If in environment variable mode, directly update the configuration in memory
      if (result.envMode && result.newToken) {
        config.QWEN_TOKEN = result.newToken;
        logger.info('Token refresh successful (environment variable mode, memory configuration updated)', {
          newTokenLength: result.newToken.length
        });
      } else {
        // Update configuration file
        reloadConfig();
        logger.info('Token refresh successful, configuration file updated');
      }

      const newTokenInfo = getTokenRefreshInfo();

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        timestamp: new Date().toISOString(),
        token: {
          valid: !newTokenInfo.isExpired,
          remainingTime: newTokenInfo.remainingTime,
          formattedTime: newTokenInfo.formattedTime
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Token refresh failed',
        error: result.error,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Error occurred during manual token refresh', error);
    res.status(500).json({
      success: false,
      message: 'Error occurred during token refresh process',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Start server
function startServer() {
  const port = getServerPort();
app.listen(port, () => {
  console.log('='.repeat(80));
  console.log('🚀 Starting Qwen API Proxy Server v3.11 (Node.js)');
  console.log('📋 Configuration status:');
    console.log(`  🔑 QWEN_TOKEN: ${getQwenToken() ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`  🔐 API_KEY: ${getApiKey() ? '✅ Configured' : '⚠️ Not configured (Open mode)'}`);
    const cookies = getCookies();
    const cookieCount = cookies.length;
    console.log(`  🍪 Cookie files: ${cookieCount > 0 ? `✅ Configured (${cookieCount})` : '⚠️ Not configured'}`);
    if (cookieCount > 1) {
      const poolStatus = identityPool.getPoolStatus();
      console.log(`  🔄 Load balancing: ✅ Enabled (${poolStatus.healthy}/${poolStatus.total} available)`);
    }
    console.log(`  🐛 Debug mode: ${isDebugMode() ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`  🔒 Authentication mode: ${isServerMode() ? 'Server-side' : 'Client-side'}`);
    console.log(`  🔄 Auto refresh: ${config.AUTO_REFRESH_TOKEN !== false ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`  🗑️  Scheduled deletion: ${getQwenToken() ? '✅ Enabled (Delete page 2 chat history every hour)' : '⚠️ Not enabled (requires QWEN_TOKEN)'}`);
  console.log('\n🔌 API Endpoints:');
  console.log('  📋 GET  /v1/models - Get model list');
  console.log('  💬 POST /v1/chat/completions - Chat completion');
  console.log('  ❤️  GET  /health - Health check');
    console.log('  🔄 POST /refresh-token - Manual token refresh');
  console.log('  🏠 GET  / - Homepage');
  console.log('🌐 Access address: http://localhost:' + port);
  console.log('='.repeat(80));
});
}

// Modify initialization flow, start server after completion
async function initialize() {
  validateConfig();
  checkTokenExpiry();

  // Initialize identity pool (priority)
  const cookies = getCookies();
  if (cookies.length > 1) {
    logger.info(`Detected ${cookies.length} cookies, enabling load balancing mode`);
    await identityPool.initialize();

    // Start the token auto-refresh scheduler for identity pool
    if (config.AUTO_REFRESH_TOKEN !== false) {
      const intervalHours = Number(
        process.env.TOKEN_REFRESH_INTERVAL_HOURS ||
        config.TOKEN_REFRESH_INTERVAL_HOURS ||
        24
      );
      const interval = intervalHours * 60 * 60 * 1000;

      setInterval(async () => {
        await identityPool.refreshExpiredTokens();
      }, interval);

      logger.info('Identity pool token auto-refresh scheduler started', {
        checkInterval: `${intervalHours} hours`
      });
    }
  } else {
    logger.info('Using traditional single cookie mode');
    // Automatically acquire token (traditional mode)
    await initializeToken();

    // Start token auto-refresh scheduler (pass config object to update memory in environment variable mode)
    if (config.AUTO_REFRESH_TOKEN !== false) {
      startTokenRefreshScheduler(config);
    }
  }

  // Start scheduled deletion task: delete page 2 chat history every 1 hour
  // Only start deletion task when token is available
  if (getQwenToken() || (identityPool.initialized && identityPool.getPoolStatus().healthy > 0)) {
    startChatDeletionScheduler(60); // Execute every 60 minutes
  } else {
    logger.warn('QWEN_TOKEN not configured, skipping scheduled deletion task startup');
  }

  // Start server
  startServer();
}

// Execute initialization
initialize();


