import { spawn } from 'node:child_process';
import { CHAT_ID, MESSAGE_ID, USER_ID } from './config.js';

export class BridgeError extends Error {
  constructor(message, code, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function parseOutput(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function errorCode(value) {
  return /^[\w.-]{1,90}$/.test(String(value ?? '')) ? String(value) : null;
}

export function runLark(binary, args, input) {
  return new Promise((resolve, reject) => {
    // Lark CLI formats message timestamps in local time without an offset.
    const child = spawn(binary, args, {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, TZ: 'UTC' },
    });
    let stdout = '';
    let stderr = '';
    let fault;
    const timer = setTimeout(() => {
      fault = new BridgeError('Lark CLI 调用超时。', 'LARK_TIMEOUT', true);
      child.kill('SIGKILL');
    }, 45_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) {
        fault = new BridgeError('Lark CLI 返回数据过大。', 'LARK_OUTPUT_LIMIT');
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-80_000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('error', (error) => {
      clearTimeout(timer);
      const code = errorCode(error.code) || 'LARK_START';
      reject(new BridgeError(code === 'ENOENT' ? '找不到 lark-cli。请安装它，或在 setup 输入可执行文件绝对路径。' : '无法启动 lark-cli。', code));
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (fault) return reject(fault);
      const output = parseOutput(stdout);
      if (status === 0 && output && output.ok !== false) return resolve(output.data ?? output);
      const err = output?.error ?? parseOutput(stderr)?.error;
      const code = errorCode(err?.code ?? err?.subtype ?? err?.type) || (status === 0 ? 'LARK_INVALID_OUTPUT' : `LARK_EXIT_${status}`);
      const transient = [4, 5].includes(status) || ['230020', '99991400', 'rate_limit', 'network', 'timeout', 'LARK_INVALID_OUTPUT'].includes(code) || err?.type === 'network';
      return reject(new BridgeError('Lark CLI 调用失败。请检查身份、权限或网络。', code, transient));
    });
  });
}

function timeValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN;
  if (/^\d{10,13}$/.test(String(value))) return Number(value) * (String(value).length === 10 ? 1000 : 1);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return Date.parse(value.replace(' ', 'T') + ':00Z');
  return Date.parse(value);
}

export function normalizeMessage(row) {
  if (!row || !MESSAGE_ID.test(row.message_id) || !CHAT_ID.test(row.chat_id)) return null;
  const sentAt = timeValue(row.create_time);
  const senderId = row.sender?.id;
  if (!Number.isFinite(sentAt) || !USER_ID.test(senderId) || row.sender?.sender_type !== 'user' ||
      row.deleted || row.msg_type !== 'text') return null;
  const content = row.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return { id: row.message_id, chatId: row.chat_id, sentAt, senderId, content: content.trim() };
}

export function makeLark(binary, call = runLark) {
  const invoke = (profile, args, input) => call(binary, [...(profile ? ['--profile', profile] : []), ...args], input);
  const search = (profile, args) => invoke(profile, ['im', '+messages-search', '--as', 'user', '--no-reactions', '--format', 'json', ...args]);
  return {
    profiles: () => invoke(null, ['profile', 'list']),
    async identity(profile, verify = false) {
      const data = await invoke(profile, ['auth', 'status', '--json', ...(verify ? ['--verify'] : [])]);
      const user = data.identities?.user;
      if (!user?.available || !USER_ID.test(user.openId) || !data.appId || !['feishu', 'lark'].includes(data.brand) || (verify && user.verified === false)) {
        throw new BridgeError(`Profile ${profile} 没有可用的用户授权。`, 'LARK_USER_AUTH');
      }
      return { appId: data.appId, userId: user.openId, userName: user.userName || profile, brand: data.brand };
    },
    async groups(profile, query) {
      const data = await invoke(profile, ['im', '+chat-search', '--as', 'user', '--query', query, '--search-types', 'private,external,public_joined', '--format', 'json']);
      return (data.chats ?? []).filter((chat) => CHAT_ID.test(chat.chat_id)).map((chat) => ({ id: chat.chat_id, name: chat.name || chat.chat_id }));
    },
    async recentDms(profile, userId) {
      const data = await search(profile, ['--chat-type', 'p2p', '--start', new Date(Date.now() - 7 * 86400_000).toISOString(), '--page-size', '50']);
      const conversations = new Map();
      for (const row of requireMessages(data)) {
        if (!CHAT_ID.test(row.chat_id) || conversations.has(row.chat_id)) continue;
        const name = row.sender?.id !== userId ? row.sender?.name : null;
        conversations.set(row.chat_id, name || row.chat_partner?.open_id || row.chat_id);
      }
      return Array.from(conversations, ([id, name]) => ({ id, name }));
    },
    async page(binding, start, end, token) {
      const data = await search(binding.profile, [
        '--chat-id', binding.chatId, '--chat-type', binding.mode === 'dm' ? 'p2p' : 'group',
        '--start', new Date(start).toISOString(), '--end', new Date(end).toISOString(),
        '--page-size', '50', ...(binding.mode === 'mention' ? ['--is-at-me'] : []),
        ...(token ? ['--page-token', token] : []),
      ]);
      const rows = requireMessages(data);
      if (data.notice) throw new BridgeError('Lark 搜索返回了限制提示，当前查询窗口未确认完整。', 'LARK_SEARCH_NOTICE');
      if (typeof data.has_more !== 'boolean' || (data.has_more && (typeof data.page_token !== 'string' || !data.page_token))) {
        throw new BridgeError('Lark 搜索分页结果不完整。', 'LARK_BAD_PAGE');
      }
      return { messages: rows.map(normalizeMessage).filter(Boolean), next: data.has_more ? data.page_token : null };
    },
    async reply(binding, originalId, content, key) {
      if (!MESSAGE_ID.test(originalId)) throw new BridgeError('原始飞书消息 ID 无效。', 'LARK_INVALID_MESSAGE_ID');
      const result = await invoke(binding.profile, [
        'im', '+messages-reply', '--as', 'user', '--message-id', originalId,
        '--text', '-', '--idempotency-key', key, '--format', 'json',
      ], content);
      if (!MESSAGE_ID.test(result.message_id) || result.chat_id !== binding.chatId) {
        throw new BridgeError('Lark 未返回可验证的发送回执。', 'LARK_REPLY_RECEIPT', true);
      }
      return result.message_id;
    },
  };
}

function requireMessages(data) {
  if (!Array.isArray(data.messages)) {
    throw new BridgeError('Lark 搜索没有返回消息正文。请检查消息详情读取权限。', 'LARK_DETAILS_UNAVAILABLE');
  }
  return data.messages;
}
