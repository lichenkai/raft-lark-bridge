import { routeKey } from './store.js';
import { BridgeError } from './lark.js';
import { explicitReply, raftEnvelope, threadKey } from './raft.js';

const LOOKBACK = 120_000;
const MAX_WINDOW = 15 * 60_000;
const MAX_RETRY_WINDOW = 55 * 60_000;

function failureCode(error) {
  const code = error.code ?? 'BRIDGE_ERROR';
  return typeof code === 'string' && /^[\w.-]{1,90}$/.test(code) ? code : 'BRIDGE_ERROR';
}

function exactIdentity(binding, user) {
  if (binding.userId !== user.userId || binding.appId !== user.appId || binding.brand !== user.brand) {
    throw new BridgeError('Profile 的登录身份有变化。请重新配置。', 'LARK_IDENTITY_CHANGED');
  }
}

export async function readWindow(lark, binding, start, end, consume) {
  let token;
  const seenTokens = new Set();
  for (let count = 0; count < 40; count += 1) {
    const page = await lark.page(binding, start, end, token);
    await consume(page.messages);
    if (!page.next) return;
    if (seenTokens.has(page.next)) throw new BridgeError('Lark 返回了重复分页游标。', 'LARK_REPEATED_CURSOR');
    seenTokens.add(page.next);
    token = page.next;
  }
  throw new BridgeError('Lark 搜索分页超过上限，未推进查询进度。', 'LARK_PAGE_LIMIT');
}

function validSource(binding, message, start, end) {
  // Lark CLI's display timestamps can drop seconds. The API query itself has the time filter.
  return message.chatId === binding.chatId && message.senderId !== binding.userId &&
    message.sentAt >= Math.floor(start / 60_000) * 60_000 && message.sentAt <= end;
}

export async function previewBinding(lark, binding, now = Date.now()) {
  exactIdentity(binding, await lark.identity(binding.profile));
  const start = now - 7 * 86400_000;
  const page = await lark.page(binding, start, now);
  return page.messages.filter((message) => validSource(binding, message, start, now)).slice(0, 5);
}

export async function bridgeCycle({ config, store, lark, raft, loadCurrentConfig, now = Date.now, log = () => {}, stopped = () => false }) {
  const bindings = config.bindings.filter((binding) => binding.enabled);
  const stats = { queued: 0, forwarded: 0, replied: 0, errors: 0 };
  const targetChecks = new Map();

  const report = (binding, stage, error) => {
    stats.errors += 1;
    const code = failureCode(error);
    const stamp = { at: now(), code };
    store.set(`health:${binding?.id ?? 'raft'}:${stage}`, stamp);
    log({ stage, binding: binding?.name, code });
    return code;
  };
  const healthy = (binding, stage) => store.set(`health:${binding?.id ?? 'raft'}:${stage}`, { at: now(), code: null });
  const current = async (binding) => {
    const latest = await loadCurrentConfig();
    if (latest.raft.serverId !== config.raft.serverId || latest.raft.bridgeId !== config.raft.bridgeId ||
        latest.raft.url !== config.raft.url || latest.larkBinary !== config.larkBinary) return false;
    return latest.bindings.some((row) => row.enabled && routeKey(row) === routeKey(binding));
  };
  const target = async (binding) => {
    if (!targetChecks.has(binding.agentHandle)) targetChecks.set(binding.agentHandle, raft.agent(binding.agentHandle));
    if ((await targetChecks.get(binding.agentHandle)).id !== binding.agentId) {
      throw new BridgeError('Raft handle 对应的 Agent 已变化。请重新配置。', 'RAFT_AGENT_CHANGED');
    }
  };

  for (const binding of bindings) {
    if (stopped()) return stats;
    try {
      exactIdentity(binding, await lark.identity(binding.profile));
      const cursorKey = `scan:${routeKey(binding)}`;
      const cursor = store.get(cursorKey, binding.enabledAt);
      const start = Math.max(binding.enabledAt, cursor - LOOKBACK);
      const end = Math.min(now(), cursor + MAX_WINDOW);
      if (end >= start + 1000) {
        await readWindow(lark, binding, start, end, (messages) => {
          store.transaction(() => {
            for (const message of messages.filter((row) => validSource(binding, row, start, end))) {
              stats.queued += store.enqueue(binding, message, raftEnvelope(binding, message.content));
            }
          });
        });
        store.set(cursorKey, end);
      }
      healthy(binding, 'scan');
    } catch (error) { report(binding, 'scan', error); }

    for (const job of store.pending(binding, 'queued', now())) {
      if (stopped()) return stats;
      try {
        if (!await current(binding)) break;
        await target(binding);
        exactIdentity(binding, await lark.identity(binding.profile));
        if (stopped() || !await current(binding)) break;
        const raftId = await raft.forward(binding, job.forwarded_content, `in-${job.id}`);
        store.forwarded(job.id, raftId, threadKey(`dm:@${binding.agentHandle}:${raftId.slice(0, 8)}`));
        stats.forwarded += 1;
        healthy(binding, 'forward');
      } catch (error) {
        store.failure(job, report(binding, 'forward', error), now());
        break;
      }
    }
  }

  if (!bindings.length || stopped()) return stats;
  try {
    const key = `raft-cursor:${config.raft.serverId}:${config.raft.bridgeId}`;
    let cursor = store.get(key);
    for (let page = 0; page < 10 && !stopped(); page += 1) {
      const batch = await raft.inbox(cursor);
      store.transaction(() => {
        for (const message of batch.messages) {
          const reply = explicitReply(message);
          if (!reply) continue;
          const job = store.byThread(reply.thread);
          if (!job || job.state !== 'forwarded') continue;
          const binding = config.bindings.find((row) => row.id === job.binding_id && routeKey(row) === job.binding_key);
          if (!binding || (reply.senderId && reply.senderId !== binding.agentId)) continue;
          store.prepareReply(job.id, reply.text);
        }
        if (Number.isSafeInteger(batch.cursor) && (cursor === null || batch.cursor > cursor)) store.set(key, batch.cursor);
      });
      if (!batch.hasMore || !Number.isSafeInteger(batch.cursor) || (cursor !== null && batch.cursor <= cursor)) break;
      cursor = batch.cursor;
    }
    healthy(null, 'inbox');
  } catch (error) { report(null, 'inbox', error); }

  for (const binding of bindings) {
    for (const job of store.pending(binding, 'ready', now())) {
      if (stopped()) return stats;
      let attempted = job.first_attempt != null;
      try {
        if (!await current(binding)) break;
        if (attempted && now() - job.first_attempt >= MAX_RETRY_WINDOW) {
          store.failure(job, report(binding, 'reply', { code: 'REPLY_NEEDS_REVIEW' }), now(), 'review');
          continue;
        }
        if (Array.from(job.reply_text).length > 12_000) {
          store.failure(job, report(binding, 'reply', { code: 'REPLY_TOO_LONG' }), now(), 'review');
          continue;
        }
        await target(binding);
        exactIdentity(binding, await lark.identity(binding.profile));
        if (stopped() || !await current(binding)) break;
        store.attemptedReply(job.id, now());
        attempted = true;
        const larkId = await lark.reply(binding, job.original_id, job.reply_text, `out-${job.id}`);
        store.replied(job.id, larkId);
        stats.replied += 1;
        healthy(binding, 'reply');
      } catch (error) {
        const state = attempted && !error.retryable ? 'review' : 'ready';
        store.failure(job, report(binding, 'reply', error), now(), state);
        break;
      }
    }
  }
  return stats;
}
