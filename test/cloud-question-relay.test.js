import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionRelay } from '../src/cloud/question-relay.js';
import { TraceJournal } from '../src/cloud/trace-journal.js';

const source = { serverId: 'server-one', cardId: 'card-one', recipientId: 'recipient-one' };
const actor = { tenantId: 'tenant', appId: 'app', openId: 'ou_test' };
const binding = {
  id: 'binding', revision: '1', actor, raftOrigin: 'https://raft.example.com', mode: 'answer', recipientName: '试点员工',
};
const card = {
  type: 'question:ask', version: 'bridge-preview-1', status: 'open', recipientId: source.recipientId,
  title: '安排发布', originalUrl: 'https://raft.example.com/messages/example',
  senderName: '发起人', expiresAt: '2026-12-01T13:00:00Z',
  questions: [{ id: 'confirm', kind: 'single', text: '是否继续？', required: true, allowOther: false,
    options: [{ label: '继续', value: 'yes' }, { label: '稍后', value: 'wait' }] }],
};
const confirmedAt = '2026-12-01T12:00:00Z';

function fixture({ traceFails = false } = {}) {
  const trace = new TraceJournal(':memory:', { clock: () => Date.parse(confirmedAt) });
  const revision = trace.configure(source.serverId, 'oc_group');
  trace.verify(source.serverId, revision, { chatId: 'oc_group', messageId: 'om_test' });
  trace.enable(source.serverId, revision);
  const sent = [];
  const submissions = [];
  let result = { state: 'open' };
  let currentBinding = binding;
  let currentCard = card;
  let loseNextResponse = false;
  const relay = new QuestionRelay({
    path: ':memory:',
    clock: () => Date.parse(confirmedAt),
    trace: traceFails ? { record() { throw Error('group reporting unavailable'); } } : trace,
    bindings: async () => currentBinding,
    raft: {
      readCard: async () => currentCard,
      readAnswer: async () => result,
      submitAnswer: async (input) => {
        submissions.push(input);
        result = { state: 'answered', submissionId: input.submissionId, receiptId: 'raft_answer', confirmedAt };
        if (loseNextResponse) throw Error('response dropped');
        return result;
      },
    },
    lark: {
      sendCard: async (input) => {
        sent.push(input);
        return { messageId: 'om_card', confirmedAt };
      },
    },
  });

  return {
    relay, trace, sent, submissions,
    loseResponse() { loseNextResponse = true; },
    rebind() { currentBinding = { ...binding, revision: '2' }; },
    changeCard() { currentCard = { ...card, title: '改了问题' }; },
    answerElsewhere() {
      currentCard = { ...card, status: 'answered' };
      result = { state: 'answered', submissionId: 'raft-web-answer', receiptId: 'raft_web_receipt', confirmedAt };
    },
    close() { relay.close(); trace.close(); },
  };
}

test('authorized card delivers once, and the correct user answers with the original value', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  const first = await system.relay.deliver(source);
  assert.equal(first.state, 'delivered');
  assert.deepEqual(await system.relay.deliver(source), first);
  assert.equal(system.sent.length, 1);

  const click = { deliveryId: first.deliveryId, messageId: 'om_card', option: 0, actor };
  for (const wrong of [
    { messageId: 'om_other' },
    { actor: { ...actor, appId: 'other-app' } },
    { actor: { ...actor, openId: 'ou_other' } },
    { option: -1 },
  ]) {
    assert.equal((await system.relay.answer({ ...click, ...wrong })).state, 'rejected');
  }

  const results = await Promise.all([system.relay.answer(click), system.relay.answer({ ...click, option: 1 })]);
  assert.deepEqual(results.map(({ state }) => state), ['answered', 'answered']);
  assert.equal(system.submissions.length, 1);
  assert.deepEqual(system.submissions[0].answer, { questionId: 'confirm', optionValue: 'yes' });
  assert.deepEqual(system.submissions[0].source, source);
  const pending = system.trace.pending(source.serverId);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].traceId, pending[1].traceId);
});

test('a lost Raft response reconciles the same logical write before any retry', async (t) => {
  const system = fixture();
  t.after(() => system.close());

  const first = await system.relay.deliver(source);
  const click = { deliveryId: first.deliveryId, messageId: 'om_card', option: 0, actor };
  system.loseResponse();
  assert.equal((await system.relay.answer(click)).state, 'pending');
  assert.equal(system.trace.pending(source.serverId).length, 1);

  assert.equal((await system.relay.answer({ ...click, option: 1 })).state, 'answered');
  assert.equal(system.submissions.length, 1);
  assert.equal(system.trace.pending(source.serverId).length, 2);
});

test('a replaced binding or changed original card stops an old click', async (t) => {
  for (const modify of ['rebind', 'changeCard']) {
    const system = fixture();
    t.after(() => system.close());
    const first = await system.relay.deliver(source);
    system[modify]();
    const result = await system.relay.answer({ deliveryId: first.deliveryId, messageId: 'om_card', option: 0, actor });
    assert.equal(result.state, 'rejected');
    assert.equal(system.submissions.length, 0);
  }
});

test('failure to record a trace cannot turn an already confirmed delivery or reply into a failure', async (t) => {
  const system = fixture({ traceFails: true });
  t.after(() => system.close());
  const delivered = await system.relay.deliver(source);
  assert.equal(delivered.state, 'delivered');
  const result = await system.relay.answer({ deliveryId: delivered.deliveryId, messageId: delivered.messageId, option: 0, actor });
  assert.equal(result.state, 'answered');
});

test('an answer saved in Raft before the click is never overwritten or traced as a Lark reply', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  const delivered = await system.relay.deliver(source);
  system.answerElsewhere();

  const result = await system.relay.answer({ deliveryId: delivered.deliveryId, messageId: delivered.messageId, option: 0, actor });
  assert.equal(result.state, 'rejected');
  assert.equal(system.submissions.length, 0);
  assert.equal(system.trace.pending(source.serverId).length, 1);
});
