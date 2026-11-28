import test from 'node:test';
import assert from 'node:assert/strict';
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
