import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeCycle, createTaskQueue } from '../src/bridge.js';
import { loadConfig, paths, saveBinding, validateConfig, writeJson } from '../src/config.js';
import { BridgeError, makeLark, runLark } from '../src/lark.js';
import { makeRaft } from '../src/raft.js';
import { launchAgentPlist } from '../src/service.js';
import { acquireLock, routeKey, Store } from '../src/store.js';

const start = Date.UTC(2026, 10, 25, 2, 0);
const firstRoot = '001aabcc-53d4-4023-88d1-8dc29c8651ae';
const secondRoot = '002aabcc-83d3-4b65-b006-695a538da163';

function binding(profile, mode = 'dm') {
  return { id: randomUUID(), name: profile, profile, appId: `cli_${profile}`, userId: `ou_${profile}`,
    brand: 'feishu', agentId: `id-${profile}`, agentHandle: profile, chatId: `oc_${profile}`, mode,
    enabled: true, enabledAt: start };
}

function configWith(bindings) {
  return { version: 1, larkBinary: 'lark-cli', pollSeconds: 20, raft: {
    url: 'https://api.raft.build', serverId: 'test-server', bridgeId: 'test-bridge',
  }, bindings };
}

test('an open setup preserves edits saved by another terminal before confirmation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-config-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = paths(directory);
  const old = binding('alice');
  const next = binding('bob');
  const preview = configWith([old, next]);
  await writeJson(files.config, configWith([{ ...old, enabled: false }]));
  await saveBinding(files, preview, next);
  assert.deepEqual((await loadConfig(files)).bindings, [{ ...old, enabled: false }, next]);
  await assert.rejects(saveBinding(files, preview, next, 'sk_agent_other'), /配置已变化/);
});

function source(rule, label = rule.profile, options = {}) {
  return { id: `om_${label}`, chatId: rule.chatId, senderId: 'ou_sender', sentAt: start + 15_000, content: `内容 ${label}`, ...options };
}

function response(rule, root, content = `/lark-reply\n答复 ${rule.profile}`, options = {}) {
  return { id: randomUUID(), target: `dm:@${rule.agentHandle}:${root.slice(0, 8)}`, content,
    sender: { type: 'agent' }, raw: { sender_id: rule.agentId }, ...options };
}

function localTest(store, config) {
  const forwards = [];
  const replies = [];
  const events = [];
  const state = { time: start + 25_000, inbox: [], cursor: 10, tokens: [], identity: {}, pages: {}, target: {}, failReply: null };
  const lark = {
    identity: async (profile) => state.identity[profile] ?? config.bindings.find((rule) => rule.profile === profile),
    page: async (rule, since, until, token) => {
      state.tokens.push([rule.profile, token]);
      return state.pages[rule.profile]?.(token, since, until) ?? { messages: [source(rule)], next: null };
    },
    reply: async (rule, originalId, text, key) => {
      if (state.failReply) return state.failReply(key);
      replies.push({ profile: rule.profile, originalId, text, key });
      return `om_sent_${rule.profile}`;
    },
  };
  const raft = {
    agent: async (handle) => ({ id: state.target[handle] ?? `id-${handle}` }),
    forward: async (rule, text, key) => {
      forwards.push({ profile: rule.profile, text, key });
      return rule.profile === 'alice' ? firstRoot : secondRoot;
    },
    inbox: async (cursor) => {
      if (cursor === state.cursor) return { messages: [], cursor, hasMore: false };
      return { messages: state.inbox, cursor: state.cursor, hasMore: false };
    },
  };
  function run(db = store, options) {
    return bridgeCycle({ config, store: db, lark, raft, loadCurrentConfig: async () => config, now: () => state.time,
      log: (event) => events.push(event), ...options });
  }
  return { state, run, forwards, replies, events, lark, raft };
}

test('forwards the original Lark text verbatim', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice', 'mention');
  const env = localTest(db, configWith([rule]));
  const text = `  @Alice #tag\n> 引用\r\n\n${'原'.repeat(6001)}  `;
  env.state.pages.alice = () => ({ messages: [source(rule, 'original', { content: text })], next: null });

  assert.equal((await env.run()).forwarded, 1);
  assert.equal(env.forwards[0].text === text, true);
});

test('reports the signal when lark-cli is interrupted', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(runLark(process.execPath, ['-e', 'process.kill(process.pid, "SIGINT")']), {
    code: 'LARK_SIGNAL_SIGINT', retryable: true,
  });
});

test('does not count a canceled search during bridge shutdown as a read failure', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  const searching = Promise.withResolvers();
  const cancel = Promise.withResolvers();
  env.lark.page = async () => {
    searching.resolve();
    await cancel.promise;
    throw new BridgeError('Interrupted', 'LARK_SIGNAL_SIGINT', true);
  };
  let stopping = false;
  const running = env.run(db, { phase: 'intake', stopped: () => stopping });
  await searching.promise;
  stopping = true;
  cancel.resolve();
  assert.equal((await running).errors, 0);
  assert.equal(db.get(`scan:${routeKey(rule)}`), null);
  assert.equal(db.get(`health:${rule.id}:scan`), null);

  const unexpected = await env.run(db, { phase: 'intake' });
  assert.equal(unexpected.errors, 1);
  assert.equal(db.get(`health:${rule.id}:scan`).code, 'LARK_SIGNAL_SIGINT');
});

test('upgrades queued forwards without resending wrapped text or duplicating a committed send', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rules = [binding('alice'), binding('bob')];
  const env = localTest(db, configWith(rules));
  const text = '  @Alice 原文\n第二行 ';
  const keys = rules.map((rule) => `in-${db.enqueue(rule, source(rule), '旧版附加指令')}`);
  db.migrateForwardText();
  db.migrateForwardText();
  const checked = [];
  env.raft.reconcileForward = async (_rule, key) => {
    checked.push(key);
    return key === keys[1] ? secondRoot : null;
  };
  env.lark.original = async (rule, originalId) => {
    assert.equal(rule.profile, 'alice');
    assert.equal(originalId, 'om_alice');
    return text;
  };

  assert.equal((await env.run()).forwarded, 2);
  assert.deepEqual(checked, keys);
  assert.deepEqual(env.forwards, [{ profile: 'alice', text, key: keys[0] }]);
});

test('a reply can reach Lark while a search is still running', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  const orderRaft = createTaskQueue();
  await env.run(db, { phase: 'intake', orderRaft });
  assert.equal(db.hasRecentForward(rule, start), true);
  assert.equal(db.hasRecentForward(rule, start + 30_000), false);
  const scanStarted = Promise.withResolvers();
  const allowSearch = Promise.withResolvers();
  env.lark.page = async () => {
    scanStarted.resolve();
    await allowSearch.promise;
    return { messages: [], next: null };
  };
  const intake = env.run(db, { phase: 'intake', orderRaft });
  try {
    await scanStarted.promise;
    env.state.inbox = [response(rule, firstRoot)];
    assert.equal((await env.run(db, { phase: 'reply', orderRaft })).replied, 1);
    assert.equal(db.hasRecentForward(rule, start), false);
  } finally {
    allowSearch.resolve();
    await intake;
  }
});

test('the inbox preserves an answer that arrives before the forward receipt returns', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const config = configWith([rule]);
  const env = localTest(db, config);
  const orderRaft = createTaskQueue();
  const started = Promise.withResolvers();
  const allowReceipt = Promise.withResolvers();
  const inboxRequested = Promise.withResolvers();
  env.raft.forward = async () => { started.resolve(); await allowReceipt.promise; return firstRoot; };
  env.raft.inbox = async () => {
    inboxRequested.resolve();
    return { messages: [response(rule, firstRoot)], cursor: 10, hasMore: false };
  };
  const intake = env.run(db, { phase: 'intake', orderRaft });
  let replies;
  try {
    await started.promise;
    replies = env.run(db, { phase: 'reply', orderRaft });
    await inboxRequested.promise;
    assert.equal(db.get(`raft-cursor:${config.raft.serverId}:${config.raft.bridgeId}`), null);
  } finally {
    allowReceipt.resolve();
    await intake;
  }
  assert.equal((await replies).replied, 1);
  assert.equal(db.get(`raft-cursor:${config.raft.serverId}:${config.raft.bridgeId}`), 10);
});

test('recovers a reply already read before an ambiguous forward receipt across a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-ambiguous-forward-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.sqlite');
  const rule = binding('alice');
  const config = configWith([rule]);
  let db = new Store(file);
  const env = localTest(db, config);
  t.after(() => db.close());
  env.raft.forward = async () => { throw new BridgeError('Response lost', 'TRANSPORT_ERROR', true); };
  env.state.inbox = [response(rule, firstRoot, 'Older unrelated author', { raw: { sender_id: 'id-other' } }),
    response(rule, firstRoot, 'The real reply')];
  const first = await env.run();
  assert.deepEqual(first, { queued: 1, forwarded: 0, replied: 0, errors: 1 });
  assert.equal(db.get(`raft-cursor:${config.raft.serverId}:${config.raft.bridgeId}`), 10);
  db.close();
  db = new Store(file);
  env.state.time += 15_001;
  env.raft.forward = async () => firstRoot;
  const second = await env.run(db);
  assert.deepEqual(second, { queued: 0, forwarded: 1, replied: 1, errors: 0 });
  assert.equal(env.replies[0].text, 'The real reply');
});

test('a bridge reply is skipped by another binding even when search sees it before its Lark receipt', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const a = binding('alice', 'group');
  const b = { ...binding('bob', 'group'), chatId: a.chatId, appId: a.appId };
  const env = localTest(db, configWith([a, b]));
  const read = (messages) => () => ({ messages, next: null });
  const human = source(a, 'human', { senderId: b.userId });
  env.state.pages.alice = env.state.pages.bob = read([human]);
  const queue = createTaskQueue();
  const orderLark = (_binding, action) => queue(action);
  const started = Promise.withResolvers();
  const allowReceipt = Promise.withResolvers();
  const markRead = Promise.withResolvers();
  env.lark.reply = async () => {
    started.resolve();
    await allowReceipt.promise;
    return 'om_sent_alice';
  };
  assert.equal((await env.run(db, { phase: 'intake', orderLark })).forwarded, 1);
  env.state.inbox = [response(a, firstRoot)];
  const reply = env.run(db, { phase: 'reply', orderLark });
  await started.promise;
  const generated = source(a, 'sent_alice', { senderId: a.userId });
  const followup = source(a, 'manual', { senderId: a.userId, sentAt: start + 30_000 });
  env.state.time += 20_000;
  env.state.pages.alice = read([]);
  env.state.pages.bob = () => {
    markRead.resolve();
    return { messages: [generated, followup], next: null };
  };
  const intake = env.run(db, { phase: 'intake', orderLark });
  try {
    await markRead.promise;
    assert.equal(env.forwards.length, 1);
  } finally {
    allowReceipt.resolve();
  }
  assert.equal((await reply).replied, 1);
  assert.equal((await intake).forwarded, 1);
  assert.equal(env.forwards[1].text, followup.content);
  assert.deepEqual(db.summary(b.id).map(({ state, total }) => [state, total]), [['forwarded', 1]]);
});

test('two identities route text and reply to the original source after a restart with out-of-order answers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'raft-bridge-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'state.sqlite');
  const a = binding('alice');
  const b = binding('bob', 'mention');
  let db = new Store(file);
  const env = localTest(db, configWith([a, b]));
  env.state.pages.alice = () => ({ messages: [source(a), source(a), source(a, 'mine', { senderId: a.userId }), source(b, 'unbound')], next: null });
  assert.deepEqual(await env.run(), { queued: 2, forwarded: 2, replied: 0, errors: 0 });
  assert.deepEqual(env.forwards.map(({ profile }) => profile), ['alice', 'bob']);
  db.close();
  db = new Store(file);
  t.after(() => db.close());
  env.state.cursor = 11;
  env.state.time += 20_000;
  const ordinaryReply = '  答复 bob\n第二行  ';
  env.state.inbox = [
    response(b, secondRoot, 'Raft 私聊正文', { target: 'dm:@bob' }),
    response(b, secondRoot, '卡片', { raw: { sender_id: b.agentId, message_card: { revision: 1 } } }),
    response(b, secondRoot, '只有回传标记', { content: '/lark-reply\n' }),
    response(b, secondRoot, ordinaryReply), response(b, secondRoot, '后续消息'),
    response(a, firstRoot, '/lark-reply\n身份不明', { raw: {} }),
    response(a, firstRoot, '受委托的回复', { raw: { sender_id: a.agentId, delegatedBy: { name: 'another-agent' } } }),
    response(a, firstRoot, '其他分身的消息', { raw: { sender_id: b.agentId } }),
    response(a, firstRoot, undefined, { timestamp: new Date(start + 40_000).toISOString() })];
  assert.deepEqual(await env.run(db), { queued: 0, forwarded: 0, replied: 2, errors: 0 });
  assert.deepEqual(env.replies.map(({ profile, originalId, text }) => [profile, originalId, text]), [
    ['alice', 'om_alice', '答复 alice'], ['bob', 'om_bob', ordinaryReply],
  ]);
  const forward = env.events.find((event) => event.event === 'raft.forwarded' && event.raftThread === firstRoot.slice(0, 8));
  const timing = env.events.find((event) => event.event === 'raft.reply_observed' && event.job === forward.job);
  assert.deepEqual([timing.waitMs, timing.agentPathMs, timing.inboxDelayMs], [20_000, 15_000, 5_000]);
  env.state.cursor = 12;
  env.state.time += 20_000;
  await env.run(db);
  assert.equal(env.replies.length, 2);
});

test('a replaced Lark user or Raft Agent cannot forward or reply as the old binding', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  await env.run();
  env.state.inbox = [response(rule, firstRoot)];
  env.state.cursor = 11;
  env.state.identity.alice = { ...rule, userId: 'ou_different' };
  env.state.time += 20_000;
  assert.equal((await env.run()).replied, 0);
  assert.equal(db.get(`health:${rule.id}:reply`).code, 'LARK_IDENTITY_CHANGED');
  env.state.identity = {};
  env.state.target.alice = 'new-agent';
  env.state.time += 20_000;
  assert.equal((await env.run()).replied, 0);
  assert.equal(db.get(`health:${rule.id}:reply`).code, 'RAFT_AGENT_CHANGED');
  env.state.target = {};
  env.state.time += 40_000;
  assert.equal((await env.run()).replied, 1);
});

test('retry after an ambiguous Lark response uses the same key and stops before Lark expires it', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  await env.run();
  env.state.inbox = [response(rule, firstRoot)];
  env.state.cursor = 11;
  const keys = [];
  env.state.failReply = (key) => {
    keys.push(key);
    throw new BridgeError('test failure', 'LARK_TIMEOUT', true);
  };
  await env.run();
  env.state.time += 20_000;
  await env.run();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  env.state.time += 54 * 60_000;
  env.lark.identity = async () => {
    env.state.time += 2 * 60_000;
    return rule;
  };
  await env.run(db, { phase: 'reply' });
  assert.equal(keys.length, 2);
  assert.equal(db.summary(rule.id)[0].state, 'review');
});

test('all Lark pages are fetched, and repeated page cursors never advance the scan checkpoint', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  env.state.pages.alice = (token) => ({ messages: token ? [] : [source(rule)], next: 'more' });
  assert.equal((await env.run()).errors, 1);
  assert.deepEqual(env.state.tokens, [['alice', undefined], ['alice', 'more']]);
  env.state.pages.alice = (token, since) => {
    assert.equal(since, start);
    return { messages: token ? [] : [source(rule)], next: token ? null : 'last' };
  };
  assert.equal((await env.run()).errors, 0);
  assert.equal(env.forwards.length, 1);
});

test('a large Lark search resumes its fixed window and token after reopening the database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-search-window-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rule = binding('alice');
  const database = join(directory, 'bridge.sqlite');
  let db = new Store(database);
  t.after(() => db.close());
  const env = localTest(db, configWith([rule]));
  const end = env.state.time;
  env.state.pages.alice = (token, from, until) => {
    assert.deepEqual([from, until], [start, end]);
    return { messages: token === 'page40' ? [source(rule)] : [], next: token === 'page40' ? null : `page${Number(token?.slice(4) ?? 0) + 1}` };
  };
  assert.equal((await env.run()).errors, 0);
  assert.equal(db.get(`scan:${routeKey(rule)}`), null);
  assert.equal(env.state.tokens.length, 40);
  db.close();
  db = new Store(database);
  env.state.time += 3_000;
  assert.equal((await env.run(db)).forwarded, 1);
  assert.deepEqual(env.state.tokens.at(-1), ['alice', 'page40']);
  assert.equal(db.get(`scan:${routeKey(rule)}`), end);
});

test('a legacy route cannot use chat history or forward queued jobs until its Lark chat type is confirmed', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice');
  const env = localTest(db, configWith([rule]));
  db.enqueue(rule, source(rule), 'queued for an unverified chat');
  env.lark.history = async () => { assert.fail('Unverified route read unrestricted history'); };
  env.state.pages.alice = () => ({ messages: [], next: null });
  env.lark.chatMode = async () => 'group';
  assert.deepEqual(await env.run(), { queued: 0, forwarded: 0, replied: 0, errors: 1 });
  assert.equal(db.get(`health:${rule.id}:scan`).code, 'LARK_CHAT_TYPE_MISMATCH');
  env.lark.chatMode = async () => null;
  assert.equal((await env.run()).forwarded, 0);
  assert.equal(db.get(`health:${rule.id}:scan`).code, 'LARK_CHAT_TYPE_UNVERIFIED');
  env.state.pages.alice = () => ({ messages: [source(rule)], next: null, chatVerified: true });
  assert.equal((await env.run()).forwarded, 1);
});

test('recent chat history forwards promptly and search catches up without forwarding a duplicate', async (t) => {
  const db = new Store(':memory:');
  t.after(() => db.close());
  const rule = binding('alice', 'mention');
  const env = localTest(db, configWith([rule]));
  db.set(`scan:${routeKey(rule)}`, start + 20_000);
  env.lark.history = async () => ({
    messages: [source(rule, 'before_binding', { sentAt: start - 500 }), source(rule)], hasMore: false,
  });
  assert.equal((await env.run()).forwarded, 1);
  assert.deepEqual(env.state.tokens, []);
  assert.ok(env.events.some((event) => event.event === 'lark.detected' && event.source === 'history'));
  env.state.time += 20_000;
  env.raft.forward = async () => secondRoot;
  env.state.pages.alice = () => ({ messages: [source(rule), source(rule, 'search_only')], next: null });
  assert.equal((await env.run()).forwarded, 1);
  assert.equal(env.state.tokens.length, 1);
  assert.ok(env.events.some((event) => event.event === 'lark.detected' && event.source === 'search'));
  env.state.time += 3000;
  env.lark.history = async () => ({ messages: [source(rule)], hasMore: true });
  assert.equal((await env.run()).errors, 0);
  assert.equal(env.state.tokens.length, 2);
  env.state.time += 3000;
  env.lark.history = async () => { throw new BridgeError('history unavailable', 'NO_HISTORY'); };
  assert.equal((await env.run()).errors, 0);
  assert.equal(env.state.tokens.length, 3);
  env.state.time += 3000;
  let retried = false;
  env.lark.history = async () => { retried = true; return { messages: [], hasMore: false }; };
  await env.run();
  assert.equal(retried, false);
  assert.equal(env.state.tokens.length, 4);
});

test('raw chat history uses the authorized user and accepts only genuine mentions of that user', async () => {
  const rule = { ...binding('alice', 'mention'), agentHandle: 'Alice-的分身' };
  const target = { key: '@_user_1', id: { open_id: rule.userId }, name: 'Alice' };
  const namesake = { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'Alice' };
  const base = { chat_id: rule.chatId, sender: { id: 'ou_colleague', sender_type: 'user' }, msg_type: 'text',
    create_time: String(start + 1200), body: { content: JSON.stringify({ text: '  @_user_1 你好\r\n@_user_2 和手写 @Alice  ' }) } };
  const lark = makeLark('/mock/lark-cli', async (binary, args, input, timeoutMs) => {
    assert.equal(binary, '/mock/lark-cli');
    assert.deepEqual(args.slice(0, 7), ['--profile', 'alice', 'api', 'GET', '/open-apis/im/v1/messages', '--as', 'user']);
    const params = JSON.parse(args[args.indexOf('--params') + 1]);
    assert.equal(params.container_id, rule.chatId);
    assert.equal(params.start_time, String(start / 1000));
    assert.equal(params.only_thread_root_messages, false);
    assert.equal(timeoutMs, 2500);
    return { has_more: false, items: [{ ...base, message_id: 'om_target', mentions: [target, namesake] },
      { ...base, message_id: 'om_other', mentions: [{ ...target, id: { open_id: 'ou_other' } }] },
      { ...base, message_id: 'om_invalid_body', mentions: [target], body: { content: 'bad JSON' } }] };
  });
  assert.deepEqual(await lark.history(rule, start, start + 5000), { hasMore: false, messages: [
    { id: 'om_target', chatId: 'oc_alice', sentAt: start + 1200, senderId: 'ou_colleague',
      content: '  @Alice 你好\r\n@Alice 和手写 @Alice  ', forwardContent: '  @Alice-的分身 你好\r\n@Alice 和手写 @Alice  ' },
  ] });
});

test('Lark CLI uses the selected profile, @me search filter, and stdin for literal reply text', async () => {
  const calls = [];
  const lark = makeLark('/mock/lark-cli', async (binary, args, input) => {
    calls.push({ binary, args, input });
    if (args.includes('+messages-reply')) return { chat_id: 'oc_alice', message_id: 'om_response' };
    const original = { message_id: 'om_original', chat_id: 'oc_alice', sender: { id: 'ou_colleague', sender_type: 'user' },
      content: '正文', create_time: `${start + 5000}`, msg_type: 'text' };
    return { messages: [original, { ...original, message_id: 'om_other', mentions: [{ id: 'ou_other' }] }],
      has_more: true, page_token: 'next' };
  });
  const rule = binding('alice', 'mention');
  const page = await lark.page(rule, start + 123, start + 30_456);
  assert.deepEqual(page, { messages: [{ id: 'om_original', chatId: 'oc_alice', senderId: 'ou_colleague',
    content: '正文', sentAt: start + 5000, needsOriginal: true }], next: 'next', chatVerified: true });
  assert.equal(await lark.reply(rule, 'om_original', '@./literal\n$(echo nope)', 'reply-key'), 'om_response');
  assert.deepEqual(calls[0].args.slice(0, 6), ['--profile', 'alice', 'im', '+messages-search', '--as', 'user']);
  assert.ok(calls[0].args.includes('--is-at-me'));
  const timeArg = calls[0].args.indexOf('--start');
  assert.deepEqual(calls[0].args.slice(timeArg, timeArg + 4), [
    '--start', '2026-11-25T10:00:00+08:00', '--end', '2026-11-25T10:00:30+08:00',
  ]);
  assert.deepEqual(calls[1].args.slice(0, 10), ['--profile', 'alice', 'im', '+messages-reply', '--as', 'user', '--message-id', 'om_original', '--text', '-']);
  assert.equal(calls[1].input, '@./literal\n$(echo nope)');
  await lark.recentDms(rule.profile, rule.userId);
  assert.match(calls[2].args[calls[2].args.indexOf('--start') + 1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
});

test('Lark rechecks activation time when search only supplied a minute display timestamp', async () => {
  const rule = { ...binding('alice'), enabledAt: start + 400 };
  const original = { message_id: 'om_original', chat_id: rule.chatId, sender: { id: 'ou_colleague', sender_type: 'user' },
    content: '原文', create_time: '2026-11-25 02:00', msg_type: 'text' };
  const lark = makeLark('/mock/lark-cli', async (_binary, args) => args.includes('+messages-search')
    ? { messages: [original], has_more: false } : { items: [{ ...original, create_time: String(start + 150),
      body: { content: JSON.stringify({ text: '原文' }) } }] });
  assert.equal((await lark.page(rule, rule.enabledAt, start + 4000)).messages[0].needsOriginal, true);
  await assert.rejects(lark.original(rule, 'om_original', { forForward: true }), { code: 'LARK_ORIGINAL_UNAVAILABLE' });
});

test('missing Lark message details report an error instead of acknowledging an empty scan', async () => {
  const lark = makeLark('/mock/lark-cli', async () => ({ message_ids: ['om_original'], has_more: false }));
  await assert.rejects(lark.page(binding('alice'), start, start + 30_000), { code: 'LARK_DETAILS_UNAVAILABLE' });
});

test('the published Raft SDK speaks the expected DM, freshness, and cursor contracts', async () => {
  const calls = [];
  const rule = binding('alice');
  const raft = makeRaft('https://api.raft.build', 'sk_agent_test', async (input, options) => {
    const url = new URL(input);
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    const json = (value) => Response.json(value);
    if (url.pathname.endsWith('/profile')) return json({ kind: 'agent', id: rule.agentId, isSelf: false, name: 'alice', displayName: 'Alice',
      description: null, avatarUrl: null, status: 'active', serverRole: 'member', runtime: 'codex', model: '',
      reasoningEffort: null, executionMode: 'byoc', computerId: null, computerName: null, computerHostname: null,
      daemonVersion: null, creator: null, createdAgents: [], createdAt: '', deletedAt: null });
    if (url.pathname.endsWith('/send')) {
      if (calls.at(-1).body.reconcileOnly) return json({ ok: true, state: 'committed', reconciliation: true, receiptComplete: false, messageId: firstRoot });
      if (!calls.at(-1).body.continueAnyway) return json({ ok: true, state: 'held', subtype: 'freshness' });
      return json({ ok: true, state: 'sent', messageId: firstRoot });
    }
    if (url.pathname.endsWith('/events')) return json({ ack_mode: 'cursor', last_seen_seq: 42, last_seen_msgId: null,
      reply_target: 'dm:@alice:001aabcc', has_more: false, events: [{
      message_id: '8ffcc150-6d82-47d1-9699-19d60f275d6a', seq: 42, sender_type: 'agent', sender_name: 'alice',
      sender_id: rule.agentId, channel_type: 'thread', channel_name: 'thread-001aabcc', parent_channel_type: 'dm',
      parent_channel_name: 'alice', content: '/lark-reply\n已处理',
    }] });
    assert.fail(url.pathname);
  });
  assert.deepEqual(await raft.agent('alice'), { id: rule.agentId, handle: 'alice', name: 'Alice' });
  assert.equal(await raft.forward(rule, 'test', 'uid'), firstRoot);
  const inbox = await raft.inbox(32);
  assert.equal(inbox.cursor, 42);
  assert.equal(inbox.messages[0].target, 'dm:@alice:001aabcc');
  assert.equal(inbox.messages[0].raw.sender_id, rule.agentId);
  assert.equal(calls[0].url.searchParams.get('target'), '@alice');
  assert.equal(calls[1].body.target, 'dm:@alice~agent');
  assert.equal(calls[2].body.idempotencyKey, calls[1].body.idempotencyKey);
  assert.equal(calls[3].url.searchParams.get('since'), '32');
  assert.equal(calls[3].url.searchParams.get('ack'), 'cursor');
  assert.equal(await raft.reconcileForward(rule, 'uid'), firstRoot);
  assert.deepEqual(calls[4].body, { target: 'dm:@alice~agent', idempotencyKey: 'uid', reconcileOnly: true });
});

test('route validation detects duplicates including Aliased Lark profiles', () => {
  const a = binding('alice');
  assert.throws(() => validateConfig(configWith([a, { ...a, id: randomUUID(), profile: 'alias', mode: 'mention' }])), /只能配置一条/);
});

test('a second process cannot acquire the SQLite runner lock', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'raft-bridge-lock-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'lock.sqlite');
  const release = acquireLock(file);
  try { assert.throws(() => acquireLock(file), /已有一个桥接进程/); } finally { release(); }
  acquireLock(file)();
});

test('the macOS service definition XML escapes paths and runs the same CLI', () => {
  const plist = launchAgentPlist({ label: 'test', node: '/example/node', entry: '/example/program & name.js',
    home: '/example/home', debug: true, environment: { PATH: '/bin', LARKSUITE_CLI_CONFIG_DIR: '/a<&b' } });
  assert.match(plist, /program &amp; name\.js/);
  assert.match(plist, /<string>--data-dir<\/string><string>\/example\/home<\/string><string>run<\/string><string>--managed<\/string><string>--debug<\/string>/);
  assert.match(plist, /\/a&lt;&amp;b/);
});
