import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuestionRelay } from '../src/cloud/question-relay.js';
import { TraceJournal } from '../src/cloud/trace-journal.js';

const source = { serverId: 'server-one', cardId: 'card-one', recipientId: 'recipient-one' };
const actor = { tenantId: 'tenant', appId: 'app', openId: 'ou_test' };
const binding = {
  id: 'binding', revision: '1', actor, raftOrigin: 'https://raft.example.com', mode: 'answer', larkChatId: 'oc_personal', recipientName: '试点员工',
};
const card = {
  type: 'question:ask', version: 'bridge-preview-1', status: 'open', recipientId: source.recipientId,
  title: '安排发布', originalUrl: 'https://raft.example.com/messages/example',
  senderName: '发起人', expiresAt: '2026-12-01T13:00:00Z',
  questions: [{ id: 'confirm', kind: 'single', text: '是否继续？', required: true, allowOther: false,
    options: [{ label: '继续', value: 'yes' }, { label: '稍后', value: 'wait' }] }],
};
const confirmedAt = '2026-12-01T12:00:00Z';

function fixture({ path = ':memory:', traceFails = false, traceFailsOnce = false, offsetReceipt = false } = {}) {
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
  let loseNextDelivery = false;
  let recoverableReceipt = false;
  let readOverride;
  let traceFailureCount = 0;
  const deliveryReceipt = { messageId: 'om_card', chatId: 'oc_personal', confirmedAt: offsetReceipt ? '2026-12-01T20:00:00+08:00' : confirmedAt };
  const options = {
    path,
    clock: () => Date.parse(confirmedAt),
    trace: { record(event) {
      if (traceFails || (traceFailsOnce && traceFailureCount++ === 0)) throw Error('group reporting unavailable');
      return trace.record(event);
    } },
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
      readCardReceipt: async (...args) => readOverride ? readOverride(...args) : (recoverableReceipt ? deliveryReceipt : null),
      sendCard: async (input) => {
        if (!input.beforeSend()) return null;
        sent.push(input);
        if (loseNextDelivery) {
          loseNextDelivery = false;
          throw Error('lost Lark reply');
        }
        return deliveryReceipt;
      },
    },
  };
  let relay = new QuestionRelay(options);

  return {
    get relay() { return relay; },
    restart() { relay.close(); relay = new QuestionRelay(options); },
    trace, sent, submissions,
    loseResponse() { loseNextResponse = true; },
    loseDelivery() { loseNextDelivery = true; },
    allowReceiptRead() { recoverableReceipt = true; },
    overrideReceiptReader(read) { readOverride = read; },
    rebind() { currentBinding = { ...binding, revision: '2' }; },
    changeCard() { currentCard = { ...card, title: '改了问题' }; },
    answerElsewhere() {
      currentCard = { ...card, status: 'answered' };
      result = { state: 'answered', receiptId: 'raft_web_receipt', confirmedAt, answer: { questionId: 'confirm', optionValue: 'wait' } };
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
  assert.equal(result.state, 'answered_elsewhere');
  assert.deepEqual(result.answer, { questionId: 'confirm', optionValue: 'wait' });
  assert.ok(result.card.body.elements.some((element) => element.text?.content === '已在 Raft 作答 · 稍后'));
  assert.ok(result.card.body.elements.every((element) => element.behaviors?.[0]?.type !== 'callback'));
  assert.equal(system.submissions.length, 0);
  assert.equal(system.trace.pending(source.serverId).length, 1);
});

test('the first verified click survives restart and resumes after a lost Lark receipt recovers', async (t) => {
  const temporary = mkdtempSync(join(tmpdir(), 'bridge-click-restart-'));
  const system = fixture({ path: join(temporary, 'relay.db') });
  t.after(() => {
    system.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  assert.equal(delivery.state, 'pending');

  const click = { deliveryId: delivery.deliveryId, messageId: 'om_card', option: 0, actor };
  assert.equal((await system.relay.answer(click)).state, 'pending');
  assert.equal(system.submissions.length, 0);
  system.restart();
  assert.equal((await system.relay.deliver(source)).state, 'delivered');
  assert.equal(system.submissions.length, 1);
  assert.equal(system.sent[0].idempotencyKey, system.sent[1].idempotencyKey);
  assert.equal((await system.relay.answer({ ...click, option: 1 })).state, 'answered');
  assert.equal(system.submissions.length, 1);
  assert.deepEqual(system.submissions[0].answer, { questionId: 'confirm', optionValue: 'yes' });
});

test('a verified original message read reconciles the delivery before writing the answer', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  system.allowReceiptRead();
  const click = { deliveryId: delivery.deliveryId, messageId: 'om_card', option: 0, actor };
  assert.equal((await system.relay.answer(click)).state, 'answered');
  assert.equal(system.sent.length, 1);
  assert.equal(system.submissions.length, 1);
});

test('a trace write failure retains the receipt for replay and normalizes offset timestamps', async (t) => {
  const system = fixture({ traceFailsOnce: true, offsetReceipt: true });
  t.after(() => system.close());
  const delivery = await system.relay.deliver(source);
  assert.equal(delivery.state, 'delivered');
  assert.equal(system.trace.pending(source.serverId).length, 0);

  const state = await system.relay.answer({ deliveryId: delivery.deliveryId, messageId: 'om_card', option: 0, actor });
  assert.equal(state.state, 'answered');
  const [first, second] = system.trace.pending(source.serverId);
  assert.match(first.text, /2026-12-01T12:00:00\.000Z/);
  assert.equal(first.traceId, second.traceId);
  assert.equal(system.sent.length, 1);
});

test('a staged click never submits against a different confirmed Lark message', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  const click = { deliveryId: delivery.deliveryId, messageId: 'om_unrelated', option: 0, actor };
  assert.equal((await system.relay.answer(click)).state, 'pending');
  assert.equal((await system.relay.deliver(source)).state, 'delivered');
  assert.equal(system.submissions.length, 0);
  assert.equal((await system.relay.answer({ ...click, messageId: 'om_card', option: 1 })).state, 'answered');
  assert.deepEqual(system.submissions[0].answer, { questionId: 'confirm', optionValue: 'wait' });
});

test('a correct pending click is recovered even when a wrong message ID was staged first', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  const click = { deliveryId: delivery.deliveryId, messageId: 'om_card', option: 1, actor };
  assert.equal((await system.relay.answer({ ...click, messageId: 'om_unrelated', option: 0 })).state, 'pending');
  assert.equal((await system.relay.answer(click)).state, 'pending');

  assert.equal((await system.relay.deliver(source)).state, 'delivered');
  assert.equal(system.submissions.length, 1);
  assert.deepEqual(system.submissions[0].answer, { questionId: 'confirm', optionValue: 'wait' });
});

test('a concurrent delivery confirmation resumes a staged click before a read can report it missing', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  const reading = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  system.overrideReceiptReader(() => {
    reading.resolve();
    return receipt.promise;
  });
  const submitted = system.relay.answer({ deliveryId: delivery.deliveryId, messageId: 'om_card', option: 0, actor });
  await reading.promise;
  const retried = system.relay.deliver(source);
  await new Promise((resolve) => setImmediate(resolve));
  receipt.resolve(null);
  const [answer, deliveryAfterRetry] = await Promise.all([submitted, retried]);
  assert.equal(deliveryAfterRetry.state, 'delivered');
  assert.equal(answer.state, 'answered');
  assert.equal(system.submissions.length, 1);
});

test('a receipt returned in an unrelated private chat cannot unlock the staged click', async (t) => {
  const system = fixture();
  t.after(() => system.close());
  system.loseDelivery();
  const delivery = await system.relay.deliver(source);
  system.overrideReceiptReader(async () => ({ messageId: 'om_card', chatId: 'oc_unrelated', confirmedAt }));
  const click = { deliveryId: delivery.deliveryId, messageId: 'om_card', option: 0, actor };
  assert.equal((await system.relay.answer(click)).state, 'pending');
  assert.equal(system.submissions.length, 0);
});
