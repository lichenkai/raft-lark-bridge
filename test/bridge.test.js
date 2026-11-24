import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeCycle } from '../src/bridge.js';
import { validateConfig } from '../src/config.js';
import { BridgeError, makeLark } from '../src/lark.js';
import { makeRaft } from '../src/raft.js';
import { launchAgentPlist } from '../src/service.js';
import { acquireLock, Store } from '../src/store.js';

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
  function run(db = store) {
    return bridgeCycle({ config, store: db, lark, raft, loadCurrentConfig: async () => config, now: () => state.time });
  }
  return { state, run, forwards, replies };
}

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
  env.state.inbox = [response(b, secondRoot, '只是进度'), response(b, secondRoot),
    response(a, firstRoot, '/lark-reply\n伪造', { raw: { sender_id: b.agentId } }), response(a, firstRoot)];
  assert.deepEqual(await env.run(db), { queued: 0, forwarded: 0, replied: 2, errors: 0 });
  assert.deepEqual(env.replies.map(({ profile, originalId, text }) => [profile, originalId, text]), [
    ['alice', 'om_alice', '答复 alice'], ['bob', 'om_bob', '答复 bob'],
  ]);
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
  env.state.time += 56 * 60_000;
  await env.run();
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

test('Lark CLI uses the selected profile, @me search filter, and stdin for literal reply text', async () => {
  const calls = [];
  const lark = makeLark('/mock/lark-cli', async (binary, args, input) => {
    calls.push({ binary, args, input });
    if (args.includes('+messages-reply')) return { chat_id: 'oc_alice', message_id: 'om_response' };
    return { messages: [{ message_id: 'om_original', chat_id: 'oc_alice', sender: { id: 'ou_colleague', sender_type: 'user' },
      content: '正文', create_time: `${start + 5000}`, msg_type: 'text' }], has_more: true, page_token: 'next' };
  });
  const rule = binding('alice', 'mention');
  const page = await lark.page(rule, start, start + 30_000);
  assert.deepEqual(page, { messages: [{ id: 'om_original', chatId: 'oc_alice', senderId: 'ou_colleague', content: '正文', sentAt: start + 5000 }], next: 'next' });
  assert.equal(await lark.reply(rule, 'om_original', '@./literal\n$(echo nope)', 'reply-key'), 'om_response');
  assert.deepEqual(calls[0].args.slice(0, 6), ['--profile', 'alice', 'im', '+messages-search', '--as', 'user']);
  assert.ok(calls[0].args.includes('--is-at-me'));
  assert.deepEqual(calls[1].args.slice(0, 10), ['--profile', 'alice', 'im', '+messages-reply', '--as', 'user', '--message-id', 'om_original', '--text', '-']);
  assert.equal(calls[1].input, '@./literal\n$(echo nope)');
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
    home: '/example/home', log: '/example/run.log', environment: { PATH: '/bin', LARKSUITE_CLI_CONFIG_DIR: '/a<&b' } });
  assert.match(plist, /program &amp; name\.js/);
  assert.match(plist, /<string>--data-dir<\/string><string>\/example\/home<\/string><string>run<\/string>/);
  assert.match(plist, /\/a&lt;&amp;b/);
});
