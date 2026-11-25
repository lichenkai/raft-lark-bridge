import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileLog } from '../src/log.js';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const preflight = fileURLToPath(new URL('../src/preflight.js', import.meta.url));

test('CLI help and setup do not load SQLite', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const help = await exec(process.execPath, [entry, 'help']);
  assert.match(help.stdout, /setup/);
  assert.doesNotMatch(help.stderr, /SQLite is an experimental feature/);
  await assert.rejects(exec(process.execPath, [entry, 'setup', '--data-dir', directory]), (error) => {
    assert.match(error.stderr, /请在终端中运行 setup/);
    assert.doesNotMatch(error.stderr, /SQLite is an experimental feature/);
    return true;
  });
});

test('the CLI runs a simulated Lark executable and a Raft HTTP service end to end', { skip: process.platform === 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'raft-lark-cli-'));
  const binary = join(home, 'lark-cli');
  const eventTime = new Date(Date.now() - 6000).toISOString().slice(0, 16).replace('T', ' ');
  const originalText = '  @测试账号 需要帮助\r\n#项目  ';
  const rawText = '  @_user_1 需要帮助\r\n#项目  ';
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.TZ !== 'UTC') process.exit(12);
const out = (data) => console.log(JSON.stringify({ ok: true, data }));
if (args[0] === '--version') console.log('lark-cli version ' + process.env.MOCK_LARK_VERSION);
else if (args.includes('update') && args.includes('--check')) out({ action: 'update_available', latest_version: '1.0.100' });
else if (args.includes('profile') && args.includes('list')) console.log(JSON.stringify([{ tokenStatus: 'valid' }]));
else if (args.includes('status')) out({ appId: 'cli_app', brand: 'feishu', identities: { user: {
  available: true, openId: 'ou_me', userName: '本人', verified: true,
} } });
else if (args.includes('/open-apis/im/v1/messages/om_first')) out({ items: [{
  message_id: 'om_first', chat_id: 'oc_group', sender: { id: 'ou_colleague', sender_type: 'user' },
  body: { content: JSON.stringify({ text: ${JSON.stringify(rawText)} }) },
  create_time: ${JSON.stringify(eventTime)}, msg_type: 'text', mentions: [{ key: '@_user_1', id: { open_id: 'ou_me' }, name: '测试账号' }],
}] });
else if (args.includes('+messages-search')) out({ has_more: false, messages: [{
  message_id: 'om_first', chat_id: 'oc_group', sender: { id: 'ou_colleague', sender_type: 'user' },
  content: ${JSON.stringify(originalText)}, create_time: ${JSON.stringify(eventTime)}, msg_type: 'text',
  mentions: [{ key: '@_user_1', id: 'ou_me', name: '测试账号' }],
}] });
else if (args.includes('+messages-reply')) {
  if (!args.includes('om_first') || !args.includes('person') || !args.includes('user') || fs.readFileSync(0, 'utf8') !== '收到。') process.exit(9);
  out({ message_id: 'om_replied', chat_id: 'oc_group' });
} else process.exit(11);
`, { mode: 0o700 });

  const paths = [];
  const root = '1234abcd-53d4-4023-88d1-8dc29c8651ae';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      paths.push(url.pathname);
      const json = (data) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(data)); };
      assert.equal(request.headers.authorization, 'Bearer sk_agent_mock');
      if (url.pathname.endsWith('/context')) return json({ agent: { id: 'bridge-id', name: 'bridge', displayName: null,
        description: null, runtime: 'external', external: true }, server: { id: 'server-id', slug: 'team', name: '团队' },
      credential: { capabilities: ['read', 'send'] }, prompt: null });
      if (url.pathname.endsWith('/profile')) return json({ kind: 'agent', id: 'target-id', isSelf: false, name: 'target', displayName: 'Target',
        description: null, avatarUrl: null, status: 'active', serverRole: 'member', runtime: 'codex', model: '',
        reasoningEffort: null, executionMode: 'byoc', computerId: null, computerName: null, computerHostname: null,
        daemonVersion: null, creator: null, createdAgents: [], createdAt: '', deletedAt: null });
      if (url.pathname.endsWith('/send')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.target, 'dm:@target~agent');
        assert.ok(body.idempotencyKey);
        if (body.reconcileOnly) return json({ ok: true, state: 'not_found', reconciliation: true });
        assert.equal(body.content, '  @target 需要帮助\r\n#项目  ');
        return json({ ok: true, state: 'sent', messageId: root });
      }
      if (url.pathname.endsWith('/events')) return json({ ack_mode: 'cursor', last_seen_seq: 1, last_seen_msgId: null,
        reply_target: 'dm:@target:1234abcd', has_more: false, events: [{ message_id: randomUUID(), seq: 1, sender_type: 'agent', sender_name: 'target',
          timestamp: new Date().toISOString(),
          sender_id: 'target-id', channel_type: 'thread', channel_name: 'thread-1234abcd', parent_channel_type: 'dm',
          parent_channel_name: 'target', content: '收到。' }] });
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { version: 1, larkBinary: binary, pollSeconds: 3, raft: {
    url: `http://127.0.0.1:${server.address().port}`, serverId: 'server-id', bridgeId: 'bridge-id',
  }, bindings: [{ id: randomUUID(), name: 'test-rule', profile: 'person', appId: 'cli_app', brand: 'feishu', userId: 'ou_me',
    agentId: 'target-id', agentHandle: 'target', chatId: 'oc_group', mode: 'group', enabled: true, enabledAt: Date.now() - 60_000 }] };
  await writeFile(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(home, 'raft-credential.json'), JSON.stringify({ token: 'sk_agent_mock' }), { mode: 0o600 });
  const check = (...args) => exec(process.execPath, [preflight, '--data-dir', home, ...args], {
    timeout: 6000, env: { ...process.env, MOCK_LARK_VERSION: '1.0.97' },
  });
  const readiness = await check();
  assert.match(readiness.stdout, /Node\.js[\s\S]*Raft SDK 0\.40\.0[\s\S]*lark-cli version 1\.0\.97[\s\S]*1 个已登录/);
  assert.doesNotMatch(readiness.stdout, /1\.0\.100/);
  assert.match((await check('--check-updates')).stdout, /1\.0\.100[\s\S]*lark-cli update/);
  const runWithVersion = (version, ...args) => exec(process.execPath, [entry, '--data-dir', home, ...args], {
    timeout: 6000, env: { ...process.env, TZ: 'America/New_York', MOCK_LARK_VERSION: version },
  });
  await assert.rejects(runWithVersion('1.0.95', 'run', '--once'), /LARK_REPLY_STDIN_UNSUPPORTED/);
  assert.equal(paths.length, 0);
  const run = (...args) => runWithVersion('1.0.97', ...args);
  const preview = await run('preview', 'test-rule');
  assert.match(preview.stdout, /需要帮助/);
  assert.equal(paths.length, 0);
  const doctor = await run('doctor');
  assert.match(doctor.stdout, /读取检查通过/);
  const cycle = await run('run', '--once', '--debug', '--managed');
  assert.match(cycle.stdout, /入队 1 · 转发 1 · 回复 1 · 错误 0/);
  const log = await readFile(join(home, 'bridge.log'), 'utf8');
  const events = log.trim().split('\n').map(JSON.parse);
  const timeline = events.filter((event) => event.job);
  assert.deepEqual(timeline.map((event) => event.event), ['lark.detected', 'raft.forwarded', 'raft.reply_observed', 'lark.replied']);
  assert.equal(new Set(timeline.map((event) => event.job)).size, 1);
  assert.equal(typeof timeline[1].durationMs, 'number');
  assert.equal(typeof timeline[2].agentPathMs, 'number');
  assert.equal(typeof timeline[2].inboxDelayMs, 'number');
  assert.equal(typeof timeline[3].durationMs, 'number');
  assert.ok(events.some((event) => event.event === 'lark.search' && event.level === 'debug' && event.durationMs >= 0));
  assert.ok(events.some((event) => event.event === 'raft.inbox' && event.level === 'debug' && event.durationMs >= 0));
  assert.doesNotMatch(log, /需要帮助|收到。|sk_agent_mock|ou_me|oc_group/);
  assert.match((await run('status')).stdout, /轮询间隔 3 秒[\s\S]*已回信 1/);
  assert.match((await run('pause', 'test-rule')).stdout, /已暂停/);
  const paused = await run('run', '--once');
  assert.match(paused.stdout, /入队 0 · 转发 0 · 回复 0 · 错误 0/);
  assert.doesNotMatch(paused.stdout, /"level":"debug"/);
  assert.match((await run('resume', 'test-rule')).stdout, /已恢复/);
  assert.match((await run('run', '--once')).stdout, /入队 0 · 转发 0 · 回复 0 · 错误 0/);
  assert.match((await run('unbind', 'test-rule')).stdout, /已解除绑定/);
});

test('the local log rotates without losing the previous file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'raft-lark-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'bridge.log');
  const record = fileLog(path, 12);
  record('first');
  record('next');
  record('last');
  assert.equal(await readFile(path, 'utf8'), 'last\n');
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'first\nnext\n');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});
