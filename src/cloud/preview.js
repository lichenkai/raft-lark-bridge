import { QuestionRelay } from './question-relay.js';
import { TraceJournal } from './trace-journal.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--link-only')) {
  console.error('Usage: node src/cloud/preview.js [--link-only]');
  process.exit(2);
}

const source = { serverId: 'preview-server', cardId: 'preview-question', recipientId: 'preview-recipient' };
const actor = { tenantId: 'preview-tenant', appId: 'preview-app', openId: 'ou_preview' };
const binding = {
  id: 'preview-binding',
  revision: '1',
  actor,
  raftOrigin: 'https://raft.example.com',
  recipientName: '示例员工',
  mode: args.length ? 'link' : 'answer',
};
const original = {
  type: 'question:ask',
  version: 'bridge-preview-1',
  status: 'open',
  recipientId: source.recipientId,
  senderName: '示例发起人',
  sourceLabel: '示例服务器 · 技术讨论',
  originalUrl: 'https://raft.example.com/messages/example',
  title: '确认开发环境验证时段',
  description: '选择一个适合验收的时间。两组时间均为示例。',
  expiresAt: '2026-12-01T14:00:00Z',
  questions: [{
    id: 'window',
    kind: 'single',
    text: '哪段时间可以一起检查？',
    required: true,
    allowOther: false,
    options: [
      { label: '今天下午，先检查配置和只读数据', value: 'afternoon' },
      { label: '明天上午，先检查机器人和回执', value: 'tomorrow' },
    ],
  }],
};
const deliveredAt = '2026-12-01T12:00:03Z';
const answeredAt = '2026-12-01T12:01:12Z';
const clock = () => Date.parse(deliveredAt);
const trace = new TraceJournal(':memory:', { clock });
const chatId = 'oc_preview';
const revision = trace.configure(source.serverId, chatId);
trace.verify(source.serverId, revision, { chatId, messageId: 'om_preview_group_probe' });
trace.enable(source.serverId, revision);

let card;
const relay = new QuestionRelay({
  path: ':memory:',
  trace,
  clock,
  bindings: () => binding,
  raft: {
    readCard: () => original,
    readAnswer: () => ({ state: 'open' }),
    submitAnswer: ({ submissionId }) => ({
      state: 'answered', submissionId, receiptId: 'raft_preview_receipt', confirmedAt: answeredAt,
    }),
  },
  lark: {
    sendCard: (input) => {
      if (!input.beforeSend()) return null;
      card = input.card;
      return { messageId: 'om_preview_card', confirmedAt: deliveredAt };
    },
  },
});

try {
  const delivery = await relay.deliver(source);
  const answer = binding.mode === 'answer'
    ? await relay.answer({ deliveryId: delivery.deliveryId, messageId: delivery.messageId, option: 0, actor })
    : null;
  console.log(JSON.stringify({ simulated: true, card, delivery, answer, traces: trace.pending(source.serverId) }, null, 2));
} finally {
  relay.close();
  trace.close();
}
