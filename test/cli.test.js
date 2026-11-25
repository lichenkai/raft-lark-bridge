import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const entry = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('the CLI runs a simulated Lark executable and a Raft HTTP service end to end', { skip: process.platform === 'win32' }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'raft-lark-cli-'));
  const binary = join(home, 'lark-cli');
  const eventTime = new Date(Date.now() - 6000).toISOString().slice(0, 16).replace('T', ' ');
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.TZ !== 'UTC') process.exit(12);
const out = (data) => console.log(JSON.stringify({ ok: true, data }));
if (args.includes('status')) out({ appId: 'cli_app', brand: 'feishu', identities: { user: {
  available: true, openId: 'ou_me', userName: '本人', verified: true,
} } });
else if (args.includes('+messages-search')) out({ has_more: false, messages: [{
  message_id: 'om_first', chat_id: 'oc_group', sender: { id: 'ou_colleague', sender_type: 'user' },
  content: '需要帮助', create_time: ${JSON.stringify(eventTime)}, msg_type: 'text',
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
        assert.match(body.content, /需要帮助/);
        assert.equal(body.target, 'dm:@target~agent');
        assert.ok(body.idempotencyKey);
        return json({ ok: true, state: 'sent', messageId: root });
      }
      if (url.pathname.endsWith('/events')) return json({ ack_mode: 'cursor', last_seen_seq: 1, last_seen_msgId: null,
        reply_target: 'dm:@target:1234abcd', has_more: false, events: [{ message_id: randomUUID(), seq: 1, sender_type: 'agent', sender_name: 'target',
          sender_id: 'target-id', channel_type: 'thread', channel_name: 'thread-1234abcd', parent_channel_type: 'dm',
          parent_channel_name: 'target', content: '/lark-reply\n收到。' }] });
      response.writeHead(404).end();
    } catch (error) { response.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { version: 1, larkBinary: binary, pollSeconds: 20, raft: {
    url: `http://127.0.0.1:${server.address().port}`, serverId: 'server-id', bridgeId: 'bridge-id',
  }, bindings: [{ id: randomUUID(), name: 'test-rule', profile: 'person', appId: 'cli_app', brand: 'feishu', userId: 'ou_me',
    agentId: 'target-id', agentHandle: 'target', chatId: 'oc_group', mode: 'group', enabled: true, enabledAt: Date.now() - 60_000 }] };
  await writeFile(join(home, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(home, 'raft-credential.json'), JSON.stringify({ token: 'sk_agent_mock' }), { mode: 0o600 });
  const run = (...args) => exec(process.execPath, [entry, '--data-dir', home, ...args], {
    timeout: 6000, env: { ...process.env, TZ: 'America/New_York' },
  });
  const preview = await run('preview', 'test-rule');
  assert.match(preview.stdout, /需要帮助/);
  assert.equal(paths.length, 0);
  const doctor = await run('doctor');
  assert.match(doctor.stdout, /读取检查通过/);
  const cycle = await run('run', '--once');
  assert.match(cycle.stdout, /入队 1 · 转发 1 · 回复 1 · 错误 0/);
  assert.match((await run('status')).stdout, /已回信 1/);
  assert.match((await run('pause', 'test-rule')).stdout, /已暂停/);
  assert.match((await run('run', '--once')).stdout, /入队 0 · 转发 0 · 回复 0 · 错误 0/);
  assert.match((await run('resume', 'test-rule')).stdout, /已恢复/);
  assert.match((await run('run', '--once')).stdout, /入队 0 · 转发 0 · 回复 0 · 错误 0/);
  assert.match((await run('unbind', 'test-rule')).stdout, /已解除绑定/);
});
