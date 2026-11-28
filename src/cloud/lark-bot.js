const API_ORIGINS = {
  lark: 'https://open.larksuite.com',
  feishu: 'https://open.feishu.cn',
};
export const LARK_SEND_DEDUP_MS = 60 * 60 * 1000;

const CARD_LIMIT_BYTES = 30 * 1024;
const TEXT_LIMIT_BYTES = 150 * 1024;

class LarkSendError extends Error {
  constructor(reason, { httpStatus, apiCode } = {}) {
    super(`Lark message send: ${reason}`);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.apiCode = apiCode;
  }
}

function validString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function matchingId(value, prefix) {
  return validString(value) && value.startsWith(prefix) && /^[a-zA-Z0-9_-]+$/u.test(value);
}

function receipt(data, targetGroup) {
  const timestamp = typeof data?.create_time === 'string' && /^\d+$/u.test(data.create_time)
    ? new Date(Number(data.create_time))
    : null;
  if (!matchingId(data?.message_id, 'om_') || !matchingId(data?.chat_id, 'oc_')
    || (targetGroup && data.chat_id !== targetGroup) || !timestamp || !Number.isFinite(timestamp.getTime())) {
    throw new LarkSendError('invalid_receipt');
  }
  return { messageId: data.message_id, chatId: data.chat_id, confirmedAt: timestamp.toISOString() };
}

// The caller chooses the binding and configured group. Tokens are scoped by
// the installed application and are used only on the platform API origin.
export function makeLarkBot({ region, getTenantToken, fetcher = fetch }) {
  if (!Object.hasOwn(API_ORIGINS, region)) throw new TypeError('Choose Lark or Feishu');
  const endpoint = new URL('/open-apis/im/v1/messages', API_ORIGINS[region]);

  async function send(actor, target, targetType, messageType, content, idempotencyKey) {
    const { tenantId, appId } = actor ?? {};
    const group = targetType === 'chat_id';
    if (![tenantId, appId].every(validString) || !matchingId(target, group ? 'oc_' : 'ou_')
      || !validString(idempotencyKey) || idempotencyKey.length > 50) throw new LarkSendError('invalid_request');

    const body = JSON.stringify({ receive_id: target, msg_type: messageType, content: JSON.stringify(content), uuid: idempotencyKey });
    const limit = messageType === 'interactive' ? CARD_LIMIT_BYTES : TEXT_LIMIT_BYTES;
    if (Buffer.byteLength(body) > limit) throw new LarkSendError('message_too_large');

    let token;
    try {
      token = await getTenantToken({ tenantId, appId });
    } catch {
      throw new LarkSendError('token_unavailable');
    }
    if (!validString(token) || /\s/u.test(token)) throw new LarkSendError('token_unavailable');

    const url = new URL(endpoint);
    url.searchParams.set('receive_id_type', targetType);
    let response;
    let result;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      result = await response.json();
    } catch {
      throw new LarkSendError('send_unconfirmed', { httpStatus: response?.status });
    }
    if (!response.ok || result?.code !== 0) {
      throw new LarkSendError('send_rejected', {
        httpStatus: response.status,
        apiCode: Number.isInteger(result?.code) ? result.code : undefined,
      });
    }

    return receipt(result.data, group ? target : null);
  }

  return {
    async sendCard({ actor, card, idempotencyKey }) {
      if (card?.schema !== '2.0') throw new LarkSendError('invalid_request');
      return send(actor, actor?.openId, 'open_id', 'interactive', card, idempotencyKey);
    },

    async sendTrace({ actor, chatId, text, idempotencyKey }) {
      if (!validString(text)) throw new LarkSendError('invalid_request');
      return send(actor, chatId, 'chat_id', 'text', { text }, idempotencyKey);
    },
  };
}
