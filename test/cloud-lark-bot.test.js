import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLarkBot } from '../src/cloud/lark-bot.js';
import { QuestionRelay } from '../src/cloud/question-relay.js';

const actor = { tenantId: 'tenant-example', appId: 'cli_example', openId: 'ou_example' };
const idempotencyKey = '99990000-0000-4000-8000-000000000001';
const createdAt = '2026-12-01T12:00:03.000Z';
const data = { message_id: 'om_example', chat_id: 'oc_trace', create_time: String(Date.parse(createdAt)) };

test('app sends an interactive card to the bound app-specific open ID', async () => {
  const requests = [];
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async (application) => {
      assert.deepEqual(application, { tenantId: actor.tenantId, appId: actor.appId });
      return 'example-token';
    },
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ code: 0, data });
    },
  });

  const card = { schema: '2.0', body: { elements: [] } };
  const receipt = await bot.sendCard({ actor, card, idempotencyKey });
  assert.deepEqual(receipt, { messageId: 'om_example', chatId: 'oc_trace', confirmedAt: createdAt });
  const [{ url, init }] = requests;
  assert.equal(String(url), 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer example-token');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(init.body), {
    receive_id: actor.openId, msg_type: 'interactive', content: JSON.stringify(card), uuid: idempotencyKey,
  });
});

test('trace send submits a plain text message to the configured group and verifies its group receipt', async () => {
  const bot = makeLarkBot({
    region: 'feishu',
    getTenantToken: async () => 'example-token',
    fetcher: async (url, init) => {
      assert.equal(String(url), 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
      assert.deepEqual(JSON.parse(init.body), {
        receive_id: 'oc_trace', msg_type: 'text', content: '{"text":"测试通知"}', uuid: idempotencyKey,
      });
      return Response.json({ code: 0, data });
    },
  });

  assert.deepEqual(await bot.sendTrace({ actor, chatId: 'oc_trace', text: '测试通知', idempotencyKey }),
    { messageId: 'om_example', chatId: 'oc_trace', confirmedAt: createdAt });
});

test('rejected or incomplete platform replies never become confirmed receipts', async () => {
  for (const [response, expected] of [
    [{ code: 230020, msg: 'provider detail' }, 'send_rejected'],
    [{ code: 0, data: { ...data, create_time: null } }, 'invalid_receipt'],
    [{ code: 0, data: { ...data, chat_id: 'oc_other' } }, 'invalid_receipt'],
  ]) {
    const bot = makeLarkBot({
      region: 'lark',
      getTenantToken: async () => 'example-token',
      fetcher: async () => Response.json(response),
    });
    await assert.rejects(bot.sendTrace({ actor, chatId: 'oc_trace', text: '测试通知', idempotencyKey }),
      (error) => error.reason === expected && !error.message.includes('provider detail'));
  }
});

test('malformed target and oversized cards are rejected before looking up a token', async () => {
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async () => assert.fail('unexpected token request'),
    fetcher: async () => assert.fail('unexpected network request'),
  });
  await assert.rejects(bot.sendTrace({ actor, chatId: 'ou_not_a_group', text: 'test', idempotencyKey }),
    (error) => error.reason === 'invalid_request');
  await assert.rejects(bot.sendCard({ actor, card: { schema: '2.0', description: '字'.repeat(15000) }, idempotencyKey }),
    (error) => error.reason === 'message_too_large');
});

test('receipt recovery accepts only a matching card sent by the same Lark app and tenant', async () => {
  const card = { schema: '2.0', body: { elements: [] } };
  const message = { ...data, msg_type: 'interactive', deleted: false,
    sender: { sender_type: 'app', id_type: 'app_id', id: actor.appId, tenant_key: actor.tenantId },
    body: { content: JSON.stringify(card) } };
  let returned = message;
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async () => 'example-token',
    fetcher: async (url, init) => {
      assert.equal(String(url), 'https://open.larksuite.com/open-apis/im/v1/messages/om_example');
      assert.equal(init.method, 'GET');
      return Response.json({ code: 0, data: { items: [returned] } });
    },
  });
  const lookup = { actor, card, messageId: 'om_example', chatId: 'oc_trace', idempotencyKey };
  assert.deepEqual(await bot.readCardReceipt(lookup), {
    messageId: 'om_example', chatId: 'oc_trace', confirmedAt: createdAt,
  });

  returned = { ...message, msg_type: 'card' };
  assert.equal((await bot.readCardReceipt(lookup)).messageId, 'om_example');

  assert.equal(await bot.readCardReceipt({ ...lookup, chatId: undefined }), null);

  for (const changes of [
    { deleted: true },
    { sender: { ...message.sender, tenant_key: 'foreign_tenant' } },
    { sender: { ...message.sender, id: 'cli_other' } },
    { body: { content: '{"other":true}' } },
    { message_id: 'om_other' },
    { chat_id: 'oc_other' },
  ]) {
    returned = { ...message, ...changes };
    assert.equal(await bot.readCardReceipt(lookup), null);
  }
});

test('the bot can replace the card on the confirmed message without sending a new one', async () => {
  const card = { schema: '2.0', body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '已在 Raft 作答' } }] } };
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async () => 'example-token',
    fetcher: async (url, init) => {
      assert.equal(String(url), 'https://open.larksuite.com/open-apis/im/v1/messages/om_example');
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(init.body), { content: JSON.stringify(card) });
      return Response.json({ code: 0, data: {} });
    },
  });
  assert.deepEqual(await bot.updateCard({ actor, card, messageId: 'om_example' }), { messageId: 'om_example' });
});

test('a private card retry crossing the dedup deadline during credential fetch never resends', async (t) => {
  const start = Date.parse(createdAt);
  let now = start;
  let tokenRequests = 0;
  let messageRequests = 0;
  const waiting = Promise.withResolvers();
  const released = Promise.withResolvers();
  const bot = makeLarkBot({
    region: 'lark',
    getTenantToken: async () => {
      tokenRequests += 1;
      if (tokenRequests === 1) return 'example-token';
      waiting.resolve();
      return released.promise;
    },
    fetcher: async () => {
      messageRequests += 1;
      throw Error('ambiguous message response');
    },
  });
  const source = { serverId: 'r1', cardId: 'card', recipientId: 'person' };
  const relay = new QuestionRelay({
    path: ':memory:', clock: () => now,
    bindings: () => ({ id: 'binding', revision: '1', actor, raftOrigin: 'https://raft.example.com', mode: 'answer' }),
    raft: { readCard: () => ({
      type: 'question:ask', version: 'bridge-preview-1', status: 'open', recipientId: source.recipientId,
      title: '试点确认', originalUrl: 'https://raft.example.com/messages/example',
      questions: [{ id: 'q1', kind: 'single', text: '确认收到？', required: true, allowOther: false,
        options: [{ label: '收到', value: 'yes' }] }],
    }) },
    lark: bot,
  });
  t.after(() => relay.close());
  const first = await relay.deliver(source);
  assert.equal(first.state, 'pending');
  now += 3_599_000;
  const retry = relay.deliver(source);
  await waiting.promise;
  now += 10_000;
  released.resolve('example-token');
  assert.deepEqual(await retry, { state: 'needs_review', deliveryId: first.deliveryId });
  assert.equal(messageRequests, 1);
});
