// Chat History Deletion Module
const { http } = require('./http');
const { logger } = require('./logger');
const { buildBrowserLikeHeaders } = require('./headers');
const { getQwenToken, getCookie } = require('./config');
const { identityPool } = require('./identity-pool');

const QWEN_CHAT_LIST_URL = 'https://chat.qwen.ai/api/v2/chats';

/**
 * Delete specified chat history
 * @param {string} chatId - Chat ID
 * @param {string} token - Authentication token
 * @param {string} cookie - Cookie string
 * @returns {Promise<boolean>} - Whether deletion was successful
 */
async function deleteChat(chatId, token, cookie) {
  try {
    const url = `${QWEN_CHAT_LIST_URL}/${chatId}`;
    const headers = buildBrowserLikeHeaders(token, { includeCookie: false });
    // Clean illegal characters in Cookie (newlines, carriage returns, etc.)
    if (cookie) {
      const cleanCookie = cookie.replace(/[\r\n]/g, '').trim();
      if (cleanCookie) headers['Cookie'] = cleanCookie;
    }

    logger.info('Deleting chat history', { chatId });
    const response = await http.delete(url, { headers });

    if (response.status === 200 || response.status === 204) {
      logger.info('✓ Successfully deleted chat history', { chatId });
      return true;
    } else {
      logger.error('✗ Delete failed', { chatId, status: response.status, data: response.data });
      return false;
    }
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    logger.error('✗ Exception occurred while deleting chat history', {
      chatId,
      error: error.message,
      status,
      dataPreview: typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data || {}).slice(0, 300)
    });
    return false;
  }
}

/**
 * Query and delete chat history from page 2
 * @param {number} intervalMinutes - Execution interval (minutes), default 10 minutes
 */
async function deleteChatsFromPage2() {
  try {
    // Prioritize identities from identity pool
    let token = null;
    let cookie = null;

    if (identityPool.initialized) {
      const identity = identityPool.getAvailableIdentity();
      if (identity && identity.token) {
        token = identity.token;
        cookie = identity.cookie;
        logger.info('Using identity from pool to execute deletion task', { identityId: identity.id });
      }
    }

    // If identity pool unavailable, fall back to traditional method
    if (!token) {
      token = getQwenToken();
      if (!token) {
        logger.warn('Cannot execute deletion task: QWEN_TOKEN not set');
        return;
      }
    }

    if (!cookie) {
      cookie = getCookie();
      if (!cookie) {
        logger.warn('Cannot execute deletion task: Cookie not set');
        return;
      }
    }

    logger.info('Starting scheduled deletion task: Querying page 2 chat history...');
    const url = `${QWEN_CHAT_LIST_URL}/?page=2`;
    const headers = buildBrowserLikeHeaders(token, { includeCookie: false });

    // Clean illegal characters in Cookie (newlines, carriage returns, etc.)
    const cleanCookie = cookie.replace(/[\r\n]/g, '').trim();
    if (cleanCookie) {
      headers['Cookie'] = cleanCookie;
    }

    try {
      const response = await http.get(url, { headers, timeout: 10000 });

      if (response.status !== 200) {
        logger.error('Failed to query chat history', { status: response.status, data: response.data });
        return;
      }

      const contentType = (response.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('application/json')) {
        logger.error('Returned Content-Type is abnormal', {
          contentType,
          preview: response.data?.toString?.()?.slice(0, 500)
        });
        return;
      }

      const data = response.data;
      if (!data || !data.success || !Array.isArray(data.data)) {
        logger.info('No more chat history to delete', {
          success: data?.success,
          hasData: !!data?.data
        });
        return;
      }

      const chatIds = data.data.map(item => item?.id).filter(Boolean);
      if (chatIds.length === 0) {
        logger.info('No chat history to delete on page 2');
        return;
      }

      logger.info(`Obtained ${chatIds.length} chat IDs, starting deletion...`);
      let successCount = 0;
      let failCount = 0;

      for (const chatId of chatIds) {
        if (await deleteChat(chatId, token, cookie)) {
          successCount++;
        } else {
          failCount++;
        }
      }

      logger.info(`Deletion task completed: ${successCount} succeeded, ${failCount} failed`);
    } catch (error) {
      const status = error?.response?.status;
      const data = error?.response?.data;
      logger.error('Exception occurred while querying chat history', {
        error: error.message,
        status,
        dataPreview: typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500)
      });
    }
  } catch (error) {
    logger.error('Error occurred while executing deletion task', error);
  }
}

/**
 * Start scheduled deletion task
 * @param {number} intervalMinutes - Execution interval (minutes), default 10 minutes
 * @returns {NodeJS.Timeout} - Timer ID
 */
function startChatDeletionScheduler(intervalMinutes = 10) {
  const TIME_INTERVAL = intervalMinutes * 60 * 1000;

  // Delay first execution, waiting for token to possibly be acquired (getting from Cookie takes time)
  setTimeout(() => {
    deleteChatsFromPage2();
  }, 5000); // Delay 5 seconds to execute, giving time for token acquisition

  // Then execute on schedule
  const intervalId = setInterval(() => {
    deleteChatsFromPage2();
  }, TIME_INTERVAL);

  logger.info(`Scheduled deletion task started: Executing once every ${intervalMinutes} minutes`);

  return intervalId;
}

module.exports = {
  deleteChat,
  deleteChatsFromPage2,
  startChatDeletionScheduler
};

