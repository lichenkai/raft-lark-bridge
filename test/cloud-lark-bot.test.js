import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLarkBot } from '../src/cloud/lark-bot.js';

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
  const lookup = { actor, card, messageId: 'om_example', idempotencyKey };
  assert.deepEqual(await bot.readCardReceipt(lookup), {
    messageId: 'om_example', chatId: 'oc_trace', confirmedAt: createdAt,
  });

  for (const changes of [
    { deleted: true },
    { sender: { ...message.sender, tenant_key: 'foreign_tenant' } },
    { sender: { ...message.sender, id: 'cli_other' } },
    { body: { content: '{"other":true}' } },
    { message_id: 'om_other' },
  ]) {
    returned = { ...message, ...changes };
    assert.equal(await bot.readCardReceipt(lookup), null);
  }
});
