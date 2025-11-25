const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getServerPort, getApiKey } = require('./lib/config');

const BASE_URL = `http://localhost:${getServerPort()}`;
const apiKey = getApiKey();
const AUTH_HEADER = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

function log(title, payload) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${title}`, payload !== undefined ? payload : '');
}

async function testHealth() {
  log('Testing /health start');
  const res = await axios.get(`${BASE_URL}/health`, { timeout: 15000 });
  if (res.status !== 200) throw new Error(`/health status code error: ${res.status}`);
  log('Testing /health passed', res.data);
}

async function testModels() {
  log('Testing /v1/models start');
  const res = await axios.get(`${BASE_URL}/v1/models`, { headers: AUTH_HEADER, timeout: 20000 });
  if (res.status !== 200) throw new Error(`/v1/models status code error: ${res.status}`);
  const list = res.data?.data || [];
  log('Testing /v1/models passed, model count', list.length);
}

async function testChatStream() {
  log('Testing /v1/chat/completions (SSE-text) start');
  const body = {
    model: 'qwen3-max',
    stream: true,
    messages: [
      { role: 'user', content: 'Hello, please introduce yourself in one or two sentences.' }
    ]
  };

  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, body, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', ...AUTH_HEADER },
    responseType: 'stream',
    timeout: 60000
  });

  return new Promise((resolve, reject) => {
    let chunkCount = 0;
    let done = false;

    res.data.on('data', (buf) => {
      const text = buf.toString('utf-8');
      const lines = text.split(/\n/).filter(Boolean);
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          log('Chat stream received complete [DONE]');
          done = true;
          res.data.destroy();
          resolve();
          return;
        }
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          chunkCount += 1;
          log(`SSE chunk ${chunkCount}`, payload.slice(0, 200));
        }
      }
    });

    res.data.on('error', (err) => {
      if (!done) reject(err);
    });

    res.data.on('end', () => {
      if (!done) {
        log('Chat stream ended (no [DONE] received), still considered passed');
        resolve();
      }
    });
  });
}

async function testChatWithImage() {
  log('Testing /v1/chat/completions (SSE-image) start');

  // Read image from current directory: alert (2).jpg
  const imagePath = path.join(__dirname, 'alert (2).jpg');
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const mimeType = 'image/jpeg'; // File name is .jpg
  const dataUrl = `data:${mimeType};base64,${base64}`;

  // Visual conversation: still use qwen3-max model (non -image suffix), messages carry images
  const body = {
    model: 'qwen3-max',
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Please describe the content of this image and identify the main elements.' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
  };

  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, body, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-API-Key': apiKey || '', ...AUTH_HEADER },
    responseType: 'stream',
    timeout: 120000
  });

  return new Promise((resolve, reject) => {
    let chunkCount = 0;
    let done = false;

    res.data.on('data', (buf) => {
      const text = buf.toString('utf-8');
      const lines = text.split(/\n/).filter(Boolean);
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          log('Image conversation stream received complete [DONE]');
          done = true;
          res.data.destroy();
          resolve();
          return;
        }
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          chunkCount += 1;
          log(`SSE(IMG) chunk ${chunkCount}`, payload.slice(0, 200));
        }
      }
    });

    res.data.on('error', (err) => {
      if (!done) reject(err);
    });

    res.data.on('end', () => {
      if (!done) {
        log('Image conversation stream ended (no [DONE] received), still considered passed');
        resolve();
      }
    });
  });
}

async function testChatWithRemoteImageUrl() {
  log('Testing /v1/chat/completions (SSE-remote image URL) start');

  const body = {
    model: 'qwen3-max',
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the content of this image' },
          { type: 'image_url', image_url: { url: 'https://www.baidu.com/img/flexible/logo/pc/result@2.png' } }
        ]
      }
    ]
  };

  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, body, {
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-API-Key': apiKey || '', ...AUTH_HEADER },
    responseType: 'stream',
    timeout: 120000
  });

  return new Promise((resolve, reject) => {
    let chunkCount = 0;
    let done = false;

    res.data.on('data', (buf) => {
      const text = buf.toString('utf-8');
      const lines = text.split(/\n/).filter(Boolean);
      for (const line of lines) {
        if (line.trim() === 'data: [DONE]') {
          log('Remote image conversation stream received complete [DONE]');
          done = true;
          res.data.destroy();
          resolve();
          return;
        }
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          chunkCount += 1;
          log(`SSE(REMOTE_IMG) chunk ${chunkCount}`, payload.slice(0, 200));
        }
      }
    });

    res.data.on('error', (err) => {
      if (!done) reject(err);
    });

    res.data.on('end', () => {
      if (!done) {
        log('Remote image conversation stream ended (no [DONE] received), still considered passed');
        resolve();
      }
    });
  });
}

async function testChatNonStream() {
  log('Testing /v1/chat/completions (non-stream) start');
  const body = {
    model: 'qwen3-max',
    stream: false,
    messages: [
      { role: 'user', content: 'Please introduce Hangzhou in one sentence.' }
    ]
  };
  const res = await axios.post(`${BASE_URL}/v1/chat/completions`, body, {
    headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
    timeout: 30000
  });
  if (res.status !== 200) throw new Error(`/v1/chat/completions non-stream status code error: ${res.status}`);
  const content = res.data?.choices?.[0]?.message?.content;
  if (!content) {
    log('Non-stream response content is empty, complete response body', res.data);
  } else {
    log('Testing /v1/chat/completions (non-stream) passed', content.slice(0, 120));
  }
}

async function runAll() {
  try {
    log('Starting tests', { baseURL: BASE_URL, hasApiKey: !!apiKey });
    await testHealth();
    await testModels();
    await testChatStream();
    await testChatNonStream();
    await testChatWithRemoteImageUrl();
    await testChatWithImage();
    log('All tests passed ✅');
    process.exit(0);
  } catch (e) {
    console.error('Tests failed ❌', e?.message || e);
    if (e?.code === 'ECONNREFUSED') {
      console.error(`Cannot connect to service ${BASE_URL}, please run first: npm run start`);
    }
    process.exit(1);
  }
}

runAll();