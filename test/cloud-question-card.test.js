import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQuestionCard } from '../src/cloud/question-card.js';

const settings = { raftOrigin: 'https://raft.example.com', mode: 'answer', deliveryId: 'delivery-1' };

function previewCard() {
  return {
    type: 'question:ask',
    version: 'bridge-preview-1',
    title: '选择部署窗口',
    description: '请看 `release.sh` 和 https://example.com/release\n<at id=all></at> @name',
    senderName: '示例发起人',
    sourceLabel: '示例服务器 · 技术讨论',
    originalUrl: 'https://raft.example.com/messages/example',
    expiresAt: '2026-12-01T12:00:00Z',
    status: 'open',
    recipientId: 'employee-1',
    questions: [{
      id: 'deploy',
      kind: 'single',
      text: '哪一天适合部署？',
      required: true,
      allowOther: false,
      options: [{ label: '周五 Run A', value: 'a' }, { label: '周六运行备用方案', value: 'b:2' }],
    }],
  };
}

function callbacks(result) {
  return result.card.body.elements.filter((element) => element.behaviors?.[0]?.type === 'callback');
}

test('renders exact source text and vertical options with opaque callback references', () => {
  const source = previewCard();
  const result = renderQuestionCard(source, settings);

  assert.equal(result.mode, 'answer');
  assert.equal(result.card.schema, '2.0');
  assert.equal(result.card.header.title.content, source.title);
  assert.equal(result.card.body.direction, 'vertical');
  const paragraphs = result.card.body.elements.filter((element) => element.tag === 'div');
  assert.ok(paragraphs.some(({ text }) => text.tag === 'plain_text' && text.content === source.description));
  assert.ok(paragraphs.some(({ text }) => text.content === source.questions[0].text));
  assert.ok(paragraphs.some(({ text }) => text.content.includes(source.expiresAt)));
  assert.deepEqual(callbacks(result).map(({ text }) => text.content), ['周五 Run A', '周六运行备用方案']);
  assert.deepEqual(callbacks(result).map(({ behaviors }) => behaviors[0].value), [
    { deliveryId: 'delivery-1', option: 0 },
    { deliveryId: 'delivery-1', option: 1 },
  ]);
  assert.deepEqual(result.answers, [
    { questionId: 'deploy', optionValue: 'a' },
    { questionId: 'deploy', optionValue: 'b:2' },
  ]);
});

test('Other, multiple questions and link-only authorization all preserve the original card entry', () => {
  const other = previewCard();
  other.questions[0].allowOther = true;
  const multiple = previewCard();
  multiple.questions.push({ id: 'notes', kind: 'text', text: '备注', required: false });

  for (const [source, mode] of [[other, 'answer'], [multiple, 'answer'], [previewCard(), 'link']]) {
    const result = renderQuestionCard(source, { ...settings, mode });
    assert.equal(result.mode, 'link');
    assert.equal(callbacks(result).length, 0);
    assert.deepEqual(result.answers, []);
    assert.equal(result.card.body.elements.at(-1).behaviors[0].default_url, source.originalUrl);
  }
});

test('rejects unknown revisions, unassigned or closed cards and off-origin links', () => {
  for (const changes of [
    { version: 'bridge-preview-2' },
    { type: 'request:prepare' },
    { recipientId: '' },
    { originalUrl: 'https://other.example/messages/example' },
    { originalUrl: 'https://user@raft.example.com/messages/example' },
    { status: 'withdrawn' },
    { questions: [{ kind: 'unsupported' }] },
  ]) {
    assert.equal(renderQuestionCard({ ...previewCard(), ...changes }, settings), null);
  }
  assert.equal(renderQuestionCard(previewCard(), { ...settings, mode: 'disabled' }), null);
});

test('one-option confirmation uses the same round-trip answer mapping', () => {
  const source = previewCard();
  source.questions[0].options = [{ label: '收到', value: 'seen' }];
  const result = renderQuestionCard(source, settings);
  assert.equal(callbacks(result).length, 1);
  assert.deepEqual(result.answers, [{ questionId: 'deploy', optionValue: 'seen' }]);
});

test('malformed text question options and non-string source links are rejected', () => {
  const source = previewCard();
  source.questions = [{ id: 'notes', text: '备注', kind: 'text', required: false, options: {} }];
  assert.equal(renderQuestionCard(source, settings), null);
  assert.equal(renderQuestionCard({ ...previewCard(), originalUrl: ['https://raft.example.com/messages/example'] }, settings), null);
});
