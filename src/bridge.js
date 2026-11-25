import { performance } from 'node:perf_hooks';
import { routeKey } from './store.js';
import { BridgeError } from './lark.js';
import { threadReply, threadKey } from './raft.js';

const LOOKBACK = 120_000;
const MAX_WINDOW = 15 * 60_000;
const MAX_RETRY_WINDOW = 55 * 60_000;
const HISTORY_WINDOW = 15_000;
const SEARCH_INTERVAL = 15_000;
const HISTORY_RETRY_DELAY = 60_000;

function elapsed(start) {
  return Math.round(performance.now() - start);
}

function replyTiming(forwardedAt, observedAt, timestamp) {
  const publishedAt = typeof timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? Date.parse(timestamp) : NaN;
  const waitMs = Number.isFinite(forwardedAt) && forwardedAt <= observedAt ? observedAt - forwardedAt : null;
  const inboxDelayMs = Number.isFinite(publishedAt) && publishedAt <= observedAt ? observedAt - publishedAt : null;
  return {
    raftReplyPublishedAt: Number.isFinite(publishedAt) ? new Date(publishedAt).toISOString() : null,
    waitMs,
    agentPathMs: inboxDelayMs !== null && waitMs !== null && inboxDelayMs <= waitMs ? waitMs - inboxDelayMs : null,
    inboxDelayMs,
  };
}

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

function validSource(binding, message, start, end, source = 'search') {
  // Lark CLI's display timestamps can drop seconds. The API query itself has the time filter.
  const lowerBound = source === 'history' ? start : Math.floor(start / 60_000) * 60_000;
  return message.chatId === binding.chatId && message.senderId !== binding.userId &&
    message.sentAt >= lowerBound && message.sentAt <= end;
}

export async function previewBinding(lark, binding, now = Date.now()) {
  exactIdentity(binding, await lark.identity(binding.profile));
  const start = now - 7 * 86400_000;
  const page = await lark.page(binding, start, now);
  return page.messages.filter((message) => validSource(binding, message, start, now)).slice(0, 5);
}

export function createRaftQueue() {
  let tail = Promise.resolve();
  return (action) => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };
}

export async function bridgeCycle({ config, store, lark, raft, loadCurrentConfig, now = Date.now, log = () => {},
  stopped = () => false, phase = 'both', orderRaft = (action) => action() }) {
  const bindings = config.bindings.filter((binding) => binding.enabled);
  const stats = { queued: 0, forwarded: 0, replied: 0, errors: 0 };
  const targetChecks = new Map();

  const record = (level, event, fields, at = now()) => log({ time: new Date(at).toISOString(), level, event, ...fields });
  const report = (binding, stage, error, fields = {}) => {
    stats.errors += 1;
    const code = failureCode(error);
    const stamp = { at: now(), code };
    store.set(`health:${binding?.id ?? 'raft'}:${stage}`, stamp);
    record('error', 'bridge.error', { stage, binding: binding?.id.slice(0, 8), code, ...fields }, stamp.at);
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
  const enqueue = (binding, messages, start, end, source) => {
    const detected = store.transaction(() => {
      const added = [];
      for (const message of messages) {
        if (!validSource(binding, message, start, end, source)) continue;
        const id = store.enqueue(binding, message, message.needsOriginal ? null : message.forwardContent ?? message.content);
        if (id) added.push({ id, sentAt: message.sentAt });
      }
      return added;
    });
    stats.queued += detected.length;
    for (const { id, sentAt } of detected) record('info', 'lark.detected', {
      binding: binding.id.slice(0, 8), job: id.slice(0, 12), source, larkSourceAt: new Date(sentAt).toISOString(),
    });
    return detected.length;
  };

  const collectAndForward = async () => {
    for (const binding of bindings) {
      if (stopped()) return;
      const bindingId = binding.id.slice(0, 8);
      const scanStarted = performance.now();
      try {
        const identityStarted = performance.now();
        exactIdentity(binding, await lark.identity(binding.profile));
        record('debug', 'lark.identity', { binding: bindingId, durationMs: elapsed(identityStarted) });
        const route = routeKey(binding);
        const historyRetryKey = `history-retry:${route}`;
        const historyEnd = now();
        const historyStart = Math.max(binding.enabledAt, historyEnd - HISTORY_WINDOW);
        let historyComplete = false;
        let historyQueued = 0;
        if (lark.history && historyEnd > historyStart && historyEnd >= store.get(historyRetryKey, 0)) {
          const started = performance.now();
          let history;
          try {
            history = await lark.history(binding, historyStart, historyEnd);
          } catch (error) {
            store.set(historyRetryKey, now() + HISTORY_RETRY_DELAY);
            record('debug', 'lark.history_fallback', { binding: bindingId, durationMs: elapsed(started), code: failureCode(error) });
          }
          if (history) {
            record('debug', 'lark.history', { binding: bindingId, durationMs: elapsed(started),
              returnedMessages: history.messages.length, hasMore: history.hasMore });
            historyQueued = enqueue(binding, history.messages, historyStart, historyEnd, 'history');
            historyComplete = !history.hasMore;
          }
        }
        const cursorKey = `scan:${route}`;
        const cursor = store.get(cursorKey, binding.enabledAt);
        const start = Math.max(binding.enabledAt, cursor - LOOKBACK);
        const end = Math.min(now(), cursor + MAX_WINDOW);
        const searchAge = end - cursor;
        // Let fresh history hits go first, but bound the delay of a scheduled catch-up.
        const searchDue = searchAge >= SEARCH_INTERVAL &&
          (historyQueued === 0 || searchAge >= SEARCH_INTERVAL + config.pollSeconds * 1000);
        if (end >= start + 1000 && (!historyComplete || searchDue)) {
          const searchStarted = performance.now();
          let pages = 0;
          let returnedMessages = 0;
          await readWindow(lark, binding, start, end, (messages) => {
            pages += 1;
            returnedMessages += messages.length;
            enqueue(binding, messages, start, end, 'search');
          });
          record('debug', 'lark.search', { binding: bindingId, durationMs: elapsed(searchStarted), pages, returnedMessages });
          store.set(cursorKey, end);
        }
        healthy(binding, 'scan');
      } catch (error) { report(binding, 'scan', error, { durationMs: elapsed(scanStarted) }); }

      for (const job of store.pending(binding, 'queued', now())) {
        if (stopped()) return;
        const forwardStarted = performance.now();
        try {
          if (!await current(binding)) break;
          await target(binding);
          exactIdentity(binding, await lark.identity(binding.profile));
          const sendForward = (send) => orderRaft(async () => {
            if (stopped() || !await current(binding)) return undefined;
            const sendStarted = performance.now();
            const raftId = await send();
            if (raftId === null) return null;
            const forwardedAt = now();
            const durationMs = elapsed(sendStarted);
            const raftThread = raftId.slice(0, 8);
            store.forwarded(job.id, raftId, threadKey(`dm:@${binding.agentHandle}:${raftThread}`), forwardedAt);
            return { forwardedAt, durationMs, raftThread };
          });
          const key = `in-${job.id}`;
          let content = job.forwarded_content;
          let receipt;
          if (content === null) {
            receipt = await sendForward(() => raft.reconcileForward(binding, key));
            if (receipt === undefined) break;
            if (receipt === null) {
              content = await lark.original(binding, job.original_id, { forForward: true });
              store.saveForwardText(job.id, content);
            }
          }
          receipt ??= await sendForward(() => raft.forward(binding, content, key));
          if (!receipt) break;
          const { forwardedAt, durationMs, raftThread } = receipt;
          record('info', 'raft.forwarded', { binding: bindingId, job: job.id.slice(0, 12), raftThread, durationMs }, forwardedAt);
          stats.forwarded += 1;
          healthy(binding, 'forward');
        } catch (error) {
          const code = report(binding, 'forward', error, { job: job.id.slice(0, 12), durationMs: elapsed(forwardStarted) });
          if (code === 'LARK_ORIGINAL_UNAVAILABLE') {
            store.failure(job, code, now(), 'review');
            continue;
          }
          store.failure(job, code, now());
          break;
        }
      }
    }
  };

  if (phase !== 'reply') await collectAndForward();
  if (phase === 'intake' || !bindings.length || stopped()) return stats;
  const inboxCycleStarted = performance.now();
  try {
    const key = `raft-cursor:${config.raft.serverId}:${config.raft.bridgeId}`;
    let cursor = store.get(key);
    for (let page = 0; page < 10 && !stopped(); page += 1) {
      const inboxStarted = performance.now();
      const batch = await raft.inbox(cursor);
      const observedAt = now();
      record('debug', 'raft.inbox', { durationMs: elapsed(inboxStarted), messages: batch.messages.length }, observedAt);
      // Wait for a matching outgoing message to commit its thread before acknowledging this page.
      const replies = await orderRaft(() => store.transaction(() => {
        const accepted = [];
        for (const message of batch.messages) {
          const reply = threadReply(message);
          if (!reply) continue;
          const job = store.byThread(reply.thread);
          if (!job || job.state !== 'forwarded') continue;
          const binding = config.bindings.find((row) => row.id === job.binding_id && routeKey(row) === job.binding_key);
          if (!binding || reply.senderId !== binding.agentId) continue;
          const forwardedAt = store.prepareReply(job.id, reply.text);
          accepted.push({ binding: binding.id.slice(0, 8), job: job.id.slice(0, 12),
            ...replyTiming(forwardedAt, observedAt, message.timestamp) });
        }
        if (Number.isSafeInteger(batch.cursor) && (cursor === null || batch.cursor > cursor)) store.set(key, batch.cursor);
        return accepted;
      }));
      for (const reply of replies) record('info', 'raft.reply_observed', reply, observedAt);
      if (!batch.hasMore || !Number.isSafeInteger(batch.cursor) || (cursor !== null && batch.cursor <= cursor)) break;
      cursor = batch.cursor;
    }
    healthy(null, 'inbox');
  } catch (error) { report(null, 'inbox', error, { durationMs: elapsed(inboxCycleStarted) }); }

  for (const binding of bindings) {
    for (const job of store.pending(binding, 'ready', now())) {
      if (stopped()) return stats;
      const replyStarted = performance.now();
      const jobId = job.id.slice(0, 12);
      let attempted = job.first_attempt != null;
      try {
        if (!await current(binding)) break;
        if (attempted && now() - job.first_attempt >= MAX_RETRY_WINDOW) {
          store.failure(job, report(binding, 'reply', { code: 'REPLY_NEEDS_REVIEW' }, { job: jobId }), now(), 'review');
          continue;
        }
        if (Array.from(job.reply_text).length > 12_000) {
          store.failure(job, report(binding, 'reply', { code: 'REPLY_TOO_LONG' }, { job: jobId }), now(), 'review');
          continue;
        }
        await target(binding);
        exactIdentity(binding, await lark.identity(binding.profile));
        if (stopped() || !await current(binding)) break;
        store.attemptedReply(job.id, now());
        attempted = true;
        const sendStarted = performance.now();
        const larkId = await lark.reply(binding, job.original_id, job.reply_text, `out-${job.id}`);
        const durationMs = elapsed(sendStarted);
        store.replied(job.id, larkId);
        record('info', 'lark.replied', { binding: binding.id.slice(0, 8), job: jobId, durationMs });
        stats.replied += 1;
        healthy(binding, 'reply');
      } catch (error) {
        const state = attempted && !error.retryable ? 'review' : 'ready';
        const code = report(binding, 'reply', error, { job: jobId, durationMs: elapsed(replyStarted) });
        store.failure(job, code, now(), state);
        break;
      }
    }
  }
  return stats;
}
