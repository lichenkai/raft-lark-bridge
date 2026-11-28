import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceJournal } from '../src/cloud/trace-journal.js';

const delivered = {
  serverId: 'r1',
  deliveryId: 'bridge-message',
  kind: 'delivery',
  providerReceiptId: 'om_receipt',
  confirmedAt: '2026-12-01T12:00:03Z',
  senderName: '发起人',
  recipientName: '同事',
  content: 'private text',
  answer: 'private answer',
};
const beforeConfirmation = { clock: () => Date.parse('2026-12-01T11:59:00Z') };
const replied = {
  ...delivered,
  kind: 'reply',
  providerReceiptId: 'raft_receipt',
  confirmedAt: '2026-12-01T12:01:12Z',
};

function configured(journal, serverId, chatId) {
  const revision = journal.configure(serverId, chatId);
  assert.equal(journal.enable(serverId, revision), false);
  assert.equal(journal.verify(serverId, revision, { chatId, messageId: 'om_test' }), true);
  assert.equal(journal.enable(serverId, revision), true);
  return revision;
}

test('queues one private-metadata notice per confirmed phase with one correlation ID', () => {
  const journal = new TraceJournal(':memory:', beforeConfirmation);
  try {
    configured(journal, 'r1', 'oc_first');
    assert.equal(journal.record({ ...delivered, providerReceiptId: '' }), false);
    assert.equal(journal.record(delivered), true);
    assert.equal(journal.record({ ...delivered, confirmedAt: replied.confirmedAt }), false);
    assert.equal(journal.record(replied), true);

    const [first, second] = journal.pending('r1');
    assert.equal(journal.pending('r1').length, 2);
    assert.equal(first.traceId, second.traceId);
    assert.notEqual(first.id, second.id);
    assert.equal(first.chatId, 'oc_first');
    assert.equal(first.text, `投递　发起人 → 同事　2026-12-01T12:00:03Z　编号 ${first.traceId}`);
    assert.equal(second.text, `回复　同事 → 发起人　2026-12-01T12:01:12Z　编号 ${first.traceId}`);
    assert.doesNotMatch(JSON.stringify(journal.pending('r1')), /private text|private answer|raft_receipt|om_receipt/);
  } finally {
    journal.close();
  }
});

test('server scopes, disabling, and changed groups never redirect existing notices', () => {
  const journal = new TraceJournal(':memory:', beforeConfirmation);
  try {
    const firstRevision = configured(journal, 'r1', 'oc_first');
    configured(journal, 'r2', 'oc_second');
    journal.record(delivered);
    journal.record({ ...delivered, serverId: 'r2' });
    assert.deepEqual(journal.pending('r1').map((row) => row.chatId), ['oc_first']);
    assert.deepEqual(journal.pending('r2').map((row) => row.chatId), ['oc_second']);

    journal.disable('r1');
    assert.deepEqual(journal.pending('r1'), []);
    assert.equal(journal.record(replied), false);
    assert.equal(journal.enable('r1', firstRevision), false);
    assert.equal(journal.verify('r1', firstRevision, { chatId: 'oc_first', messageId: 'om_stale' }), false);
    const nextRevision = configured(journal, 'r1', 'oc_replacement');
    assert.notEqual(nextRevision, firstRevision);
    assert.equal(journal.verify('r1', nextRevision, { chatId: 'oc_first', messageId: 'om_wrong_group' }), false);
    assert.equal(journal.enable('r1', nextRevision), true);
    assert.deepEqual(journal.pending('r1'), []);
    assert.equal(journal.record(delivered), false);
    assert.equal(journal.record({ ...delivered, deliveryId: 'later-message' }), true);
    assert.deepEqual(journal.pending('r1').map((row) => row.chatId), ['oc_replacement']);
    assert.deepEqual(journal.pending('r2').map((row) => row.chatId), ['oc_second']);
  } finally {
    journal.close();
  }
});

test('a restart preserves notification identity until send is confirmed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-trace-'));
  const path = join(directory, 'trace.db');
  try {
    let journal = new TraceJournal(path, beforeConfirmation);
    configured(journal, 'r1', 'oc_first');
    journal.record({ ...delivered, senderName: '<at user_id="all">所有人</at>\nname' });
    const [before] = journal.pending('r1');
    assert.doesNotMatch(before.text, /[<>\n]/);
    journal.close();

    journal = new TraceJournal(path, beforeConfirmation);
    try {
      assert.deepEqual(journal.pending('r1'), [before]);
      assert.equal(journal.markSent('r1', before.id, ''), false);
      assert.equal(journal.markSent('r2', before.id, 'om_sent'), false);
      assert.equal(journal.markSent('r1', before.id, 'om_sent'), true);
      assert.deepEqual(journal.pending('r1'), []);
    } finally {
      journal.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replays of events confirmed before tracing was enabled do not reach the group', () => {
  const clock = () => Date.parse('2026-12-01T12:00:10Z');
  const journal = new TraceJournal(':memory:', { clock });
  try {
    configured(journal, 'r1', 'oc_first');
    assert.equal(journal.record(delivered), false);
    assert.equal(journal.record(replied), true);
    assert.equal(journal.pending('r1').length, 1);
  } finally {
    journal.close();
  }
});
