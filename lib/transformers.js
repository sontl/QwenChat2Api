// Transformer Collection: Convert upstream Qwen responses to OpenAI compatible format (stream/non-stream)
const { Transform } = require('stream');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

// Streaming: qwen -> openai sse
function createQwenToOpenAIStreamTransformer() {
  const messageId = randomUUID();
  const sentImageUrls = new Set();
  let buffer = '';
  const MAX_BUFFER_SIZE = 100000; // 100KB

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,
    transform(chunk, _enc, callback) {
      try {
        const raw = chunk.toString('utf-8');
        buffer += raw;
        if (buffer.length > MAX_BUFFER_SIZE) {
          logger.error(`Buffer overflow detected (size: ${buffer.length}), clearing buffer`);
          buffer = '';
          return callback();
        }
        if (buffer.includes('[DONE]')) {
          this.push(`data: [DONE]\n\n`);
          buffer = '';
          return callback();
        }
        let lines = [];
        if (buffer.includes('\n\n')) {
          lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
        } else if (buffer.includes('\n')) {
          lines = buffer.split('\n');
          const lastLine = lines[lines.length - 1];
          if (lastLine && !lastLine.startsWith('data:')) {
            buffer = lines.pop() || '';
          } else {
            buffer = '';
          }
        }
        for (const line of lines) {
          if (!line || line.trim() === '') continue;
          let dataStr = line.startsWith('data:') ? line.replace(/^data:\s?/, '').trim() : line.trim();
          if (!dataStr) continue;
          if (dataStr === '[DONE]') { this.push(`data: [DONE]\n\n`); continue; }

          let content = '';
          let isFinished = false;
          try {
            const q = JSON.parse(dataStr);
            if (q.success === false) {
              const errorMessage = q.data?.details || q.data?.code || 'Unknown Qwen API error';
              const openAIError = { id: `chatcmpl-${messageId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'qwen-proxy', choices: [{ index: 0, delta: { content: `Error: ${errorMessage}` }, finish_reason: 'stop' }] };
              this.push(`data: ${JSON.stringify(openAIError)}\n\n`);
              this.push(`data: [DONE]\n\n`);
              continue;
            }
            if (q.choices && q.choices.length > 0) {
              const choice = q.choices[0];
              const delta = choice.delta || choice.message;
              if (delta) {
                content = delta.content || '';
                if (delta.phase === 'image_gen') {
                  if (content && content.startsWith('https://')) {
                    if (!sentImageUrls.has(content)) { sentImageUrls.add(content); content = `![Image](${content})`; } else { content = ''; }
                  }
                } else if ((delta.chat_type === 't2i' || delta.chat_type === 'image_edit') && typeof content === 'string' && content.startsWith('https://')) {
                  if (!sentImageUrls.has(content)) { sentImageUrls.add(content); content = `![Image](${content})`; } else { content = ''; }
                }
                if (delta.status === 'finished') {
                  isFinished = true;
                }
                isFinished = isFinished || choice.finish_reason === 'stop';
              }
            } else if (q.content) {
              content = q.content;
              if (typeof content === 'string' && content.startsWith('https://') && content.includes('cdn.qwenlm.ai')) {
                if (!sentImageUrls.has(content)) { sentImageUrls.add(content); content = `![Image](${content})`; } else { content = ''; }
              }
              isFinished = q.status === 'finished' || q.finish_reason === 'stop';
            } else if (q.result || q.data) {
              const data = q.result || q.data;
              if (typeof data === 'string') content = data; else if (data.content) content = data.content;
            }
          } catch (_) {
            if (dataStr && !dataStr.startsWith('{')) { content = dataStr; }
          }

          if (content || isFinished) {
            const openAIChunk = { id: `chatcmpl-${messageId}`, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'qwen-proxy', choices: [{ index: 0, delta: { content }, finish_reason: isFinished ? 'stop' : null }] };
            this.push(`data: ${JSON.stringify(openAIChunk)}\n\n`);
          }
        }
        callback();
      } catch (e) {
        logger.error('Transform stream processing failed', e);
        callback();
      }
    }
  });
}

// Non-streaming: Integrate complete upstream response as OpenAI completion
function convertQwenResponseToOpenAI(json) {
  const id = `chatcmpl-${randomUUID()}`;

  const coerceToString = (val) => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      // Support OpenAI-style content parts: [{type:'text',text:'...'}]
      const texts = val
        .map((p) => (typeof p === 'string' ? p : (p?.text || p?.content || '')))
        .filter(Boolean);
      return texts.join('');
    }
    if (typeof val === 'object') {
      // Common fields
      return val.text || val.content || '';
    }
    return '';
  };

  const pick = (...cands) => {
    for (const c of cands) {
      const s = coerceToString(c);
      if (s) return s;
    }
    return '';
  };

  // Attempt to extract upstream content layer by layer
  let content = pick(
    json?.choices?.[0]?.message?.content,
    json?.choices?.[0]?.delta?.content,
    json?.choices?.[0]?.content,
    json?.message?.content,
    json?.content,
    json?.result?.content,
    json?.data?.content,
    json?.output?.text,
    json?.output_text,
    json?.result?.data?.content
  );

  // URL image fallback (some responses directly return image direct links)
  if (!content) {
    const url = [
      json?.url,
      json?.image_url,
      json?.data?.url,
      json?.result?.url,
      json?.choices?.[0]?.url
    ].find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (url) content = url.includes('cdn.qwenlm.ai') ? `![Image](${url})` : url;
  }

  // Fallback when data/result is string
  if (!content) {
    if (typeof json?.data === 'string') content = json.data;
    else if (typeof json?.result === 'string') content = json.result;
  }

  // Final fallback: avoid returning empty string
  if (!content) content = '';

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now()/1000),
    model: 'qwen-proxy',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }
    ]
  };
}

// Aggregate upstream SSE stream as one-time text (for non-stream fallback implementation)
function collectOpenAICompletionFromSSE(readable) {
  return new Promise((resolve) => {
    let remainder = '';
    let content = '';
    const sentImageUrls = new Set();

    function pickContentFromQwen(q) {
      try {
        if (q.success === false) return `Error: ${q.data?.details || q.data?.code || 'Unknown Qwen API error'}`;
        if (q.choices && q.choices.length > 0) {
          const choice = q.choices[0];
          const delta = choice.delta || choice.message || {};
          let c = delta.content || '';
          if (delta.phase === 'image_gen' && typeof c === 'string' && c.startsWith('https://')) {
            if (!sentImageUrls.has(c)) { sentImageUrls.add(c); c = `![Image](${c})`; } else { c = ''; }
          } else if ((delta.chat_type === 't2i' || delta.chat_type === 'image_edit') && typeof c === 'string' && c.startsWith('https://')) {
            if (!sentImageUrls.has(c)) { sentImageUrls.add(c); c = `![Image](${c})`; } else { c = ''; }
          }
          return c || '';
        }
        if (typeof q.content === 'string') {
          const c = q.content;
          if (c.startsWith('https://') && c.includes('cdn.qwenlm.ai')) {
            if (!sentImageUrls.has(c)) { sentImageUrls.add(c); return `![Image](${c})`; }
            return '';
          }
          return c;
        }
        if (q.result || q.data) {
          const data = q.result || q.data;
          if (typeof data === 'string') return data;
          if (data?.content) return data.content;
        }
      } catch (_) { /* ignore */ }
      return '';
    }

    const onData = (buf) => {
      remainder += buf.toString('utf-8');
      let idx;
      while ((idx = remainder.indexOf('\n')) >= 0) {
        const line = remainder.slice(0, idx);
        remainder = remainder.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          try { readable.destroy?.(); } catch (_) {}
          resolve(content);
          return;
        }
        if (trimmed.startsWith('data: ')) {
          const payload = trimmed.slice(6);
          try {
            const q = JSON.parse(payload);
            const piece = pickContentFromQwen(q);
            if (piece) content += piece;
          } catch (_) {
            // Non-JSON, directly concatenate
            if (payload && !payload.startsWith('{')) content += payload;
          }
        }
      }
    };

    const finalize = () => resolve(content);
    readable.on('data', onData);
    readable.on('end', finalize);
    readable.on('close', finalize);
    readable.on('error', finalize);
  });
}

module.exports = { createQwenToOpenAIStreamTransformer, convertQwenResponseToOpenAI, collectOpenAICompletionFromSSE };


