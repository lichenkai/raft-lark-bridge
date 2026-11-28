import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { makeLarkBot } from '../src/cloud/lark-bot.js';
import { TraceJournal } from '../src/cloud/trace-journal.js';

const start = Date.parse('2026-12-01T12:00:00Z');
const serverId = 'server';
const chatId = 'oc_group';

function journalFixture(t) {
  let now = start;
  const journal = new TraceJournal(':memory:', { clock: () => now });
  t.after(() => journal.close());
  const revision = journal.configure(serverId, chatId);
  journal.verify(serverId, revision, { chatId, messageId: 'om_group_test' });
  journal.enable(serverId, revision);

  const add = (kind) => journal.record({
    serverId, deliveryId: 'delivery', kind, providerReceiptId: 'provider_receipt',
    confirmedAt: '2026-12-01T12:00:00Z', senderName: '发起人', recipientName: '用户',
  });
  add('delivery');
  add('reply');
  return { journal, advance(milliseconds) { now += milliseconds; } };
}

test('retries group sends with the same UUID and marks only confirmed group receipts', async (t) => {
  const { journal } = journalFixture(t);
  const attempts = [];
  const send = async (notice) => {
    attempts.push(notice);
    if (attempts.length === 1) throw Error('ambiguous network error');
    return { chatId, messageId: 'om_sent' };
  };
  assert.deepEqual(await journal.flush(serverId, send), { sent: 1, pending: 1, needsReview: 0 });
  assert.deepEqual(await journal.flush(serverId, send), { sent: 1, pending: 0, needsReview: 0 });
  assert.deepEqual(attempts[0], attempts[2]);
  assert.notEqual(attempts[0].id, attempts[1].id);
  assert.deepEqual(journal.pending(serverId), []);
});

test('closing trace while a group send is in flight stops the rest', async (t) => {
  const { journal } = journalFixture(t);
  let attempts = 0;
  await journal.flush(serverId, async () => {
    attempts += 1;
    journal.disable(serverId);
    return { chatId, messageId: 'om_accepted' };
  });
  assert.equal(attempts, 1);
  assert.deepEqual(journal.pending(serverId), []);
});

test('ambiguous sends beyond the Lark dedup time require review before sending again', async (t) => {
  const { journal, advance } = journalFixture(t);
  const failSend = async () => { throw Error('unknown receipt'); };
  assert.deepEqual(await journal.flush(serverId, failSend), { sent: 0, pending: 2, needsReview: 0 });
  advance(60 * 60 * 1000);
  assert.deepEqual(await journal.flush(serverId, async () => assert.fail('must not resend')), {
    sent: 0, pending: 0, needsReview: 2,
  });
});

test('a batch of expired traces does not block dispatch of new ones', async (t) => {
  const { journal, advance } = journalFixture(t);
  for (let index = 0; index < 98; index += 1) {
    journal.record({
      serverId, deliveryId: `old-${index}`, kind: 'delivery', providerReceiptId: 'older',
      confirmedAt: '2026-12-01T12:00:00Z', senderName: '发起人', recipientName: '用户',
    });
  }
  const failed = await journal.flush(serverId, async () => { throw Error('unknown receipt'); });
  assert.equal(failed.pending, 100);
  advance(60 * 60 * 1000);
  journal.record({
    serverId, deliveryId: 'new', kind: 'delivery', providerReceiptId: 'newer',
    confirmedAt: '2026-12-01T13:00:00Z', senderName: '发起人', recipientName: '用户',
  });
  const result = await journal.flush(serverId, async () => ({ chatId, messageId: 'om_later' }));
  assert.deepEqual(result, { sent: 1, pending: 0, needsReview: 100 });
});

function slowBot() {
  const waiting = Promise.withResolvers();
  const credentials = Promise.withResolvers();
  const requests = [];
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async () => {
      waiting.resolve();
      return credentials.promise;
    },
    fetcher: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({ code: 0, data: { chat_id: chatId, message_id: 'om_sent', create_time: String(start) } });
    },
  });
  const actor = { tenantId: 'tenant', appId: 'cli_example' };
  return { waiting, credentials, requests, send: (notice, beforeSend) => bot.sendTrace({
    actor, chatId: notice.chatId, idempotencyKey: notice.id, text: notice.text, beforeSend,
  }) };
}

test('while app credentials are loading, disabling or changing the group cancels all old sends', async (t) => {
  for (const replace of [false, true]) {
    const { journal } = journalFixture(t);
    const transport = slowBot();
    const run = journal.flush(serverId, transport.send);
    await transport.waiting.promise;
    if (replace) {
      const version = journal.configure(serverId, 'oc_replacement');
      journal.verify(serverId, version, { chatId: 'oc_replacement', messageId: 'om_probe' });
      journal.enable(serverId, version);
    } else {
      journal.disable(serverId);
    }
    transport.credentials.resolve('example-token');
    await run;
    assert.equal(transport.requests.length, 0);
  }
});

test('a retry crossing the dedup deadline while waiting for credentials never sends', async (t) => {
  const { journal, advance } = journalFixture(t);
  await journal.flush(serverId, async () => { throw Error('ambiguous HTTP result'); });
  advance(59 * 60 * 1000);
  const transport = slowBot();
  const run = journal.flush(serverId, transport.send);
  await transport.waiting.promise;
  advance(2 * 60 * 1000);
  transport.credentials.resolve('example-token');
  assert.deepEqual(await run, { sent: 0, pending: 0, needsReview: 2 });
  assert.equal(transport.requests.length, 0);
});

test('upgrades a prior main trace database and preserves its verified group and pending notice', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'bridge-trace-upgrade-'));
  const path = join(temporary, 'legacy.db');
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const older = new DatabaseSync(path);
  older.exec(`
    CREATE TABLE cloud_trace_settings (
      server_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, revision TEXT NOT NULL,
      test_message_id TEXT, enabled_since INTEGER
    ) STRICT;
    CREATE TABLE cloud_trace_notices (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, delivery_id TEXT NOT NULL, kind TEXT NOT NULL,
      trace_id TEXT NOT NULL, revision TEXT NOT NULL, sender_name TEXT NOT NULL,
      recipient_name TEXT NOT NULL, confirmed_at TEXT NOT NULL, sent_message_id TEXT,
      UNIQUE (server_id, delivery_id, kind)
    ) STRICT;
    INSERT INTO cloud_trace_settings VALUES ('server', 'oc_group', 'rev', 'om_group_test', ${start});
    INSERT INTO cloud_trace_notices VALUES (
      'legacy-notice', 'server', 'legacy-delivery', 'delivery', 'legacy-trace', 'rev',
      'Old sender', 'Old recipient', '2026-12-01T12:00:00Z', NULL
    );
  `);
  older.close();

  const journal = new TraceJournal(path, { clock: () => start });
  t.after(() => journal.close());
  assert.equal(journal.pending(serverId)[0].traceId, 'legacy-trace');
  const run = await journal.flush(serverId, async ({ id, chatId: destination }) => {
    assert.equal(id, 'legacy-notice');
    assert.equal(destination, chatId);
    return { chatId, messageId: 'om_sent' };
  });
  assert.equal(run.sent, 1);
  assert.deepEqual(journal.pending(serverId), []);
});
