const PREVIEW_SCHEMA = 'bridge-preview-1';
const QUESTION_KINDS = new Set(['single', 'multiple', 'text']);
const DIRECT_QUESTION_FIELDS = new Set(['id', 'kind', 'text', 'description', 'required', 'allowOther', 'options']);
const DIRECT_OPTION_FIELDS = new Set(['label', 'value']);

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOption(option) {
  return isText(option?.label) && isText(option?.value);
}

function isQuestion(question) {
  return QUESTION_KINDS.has(question?.kind)
    && isText(question.id)
    && isText(question.text)
    && typeof question.required === 'boolean'
    && (question.kind === 'text'
      ? question.options === undefined
      : Array.isArray(question.options) && question.options.every(isOption));
}

function isRaftLink(value, origin) {
  const url = isText(value) ? URL.parse(value) : null;
  return url?.protocol === 'https:' && url.origin === origin && !url.username && !url.password;
}

function plainText(content) {
  return { tag: 'plain_text', content };
}

function paragraph(content) {
  return { tag: 'div', text: plainText(content) };
}

function button(label, behavior, type = 'default') {
  return { tag: 'button', text: plainText(label), type, behaviors: [behavior] };
}

function canAnswer(card, settings) {
  if (settings.mode !== 'answer' || !isText(settings.deliveryId) || card.questions.length !== 1) return false;
  const [question] = card.questions;
  if (question.kind !== 'single' || question.allowOther !== false
    || (question.description !== undefined && typeof question.description !== 'string')) return false;
  if (!Object.keys(question).every((key) => DIRECT_QUESTION_FIELDS.has(key))
    || !question.options.every((option) => Object.keys(option).every((key) => DIRECT_OPTION_FIELDS.has(key)))) return false;
  if (question.options.length < 1 || question.options.length > 4) return false;
  return new Set(question.options.map((option) => option.value)).size === question.options.length;
}

// Accepts a normalized preview card. A platform adapter must authenticate the
// event, authorize the recipient, and set the delivery mode before rendering it.
export function renderQuestionCard(card, settings) {
  if (settings.mode !== 'answer' && settings.mode !== 'link') return null;
  if (card?.type !== 'question:ask' || card.version !== PREVIEW_SCHEMA || card.status !== 'open') return null;
  if (!isText(card.recipientId) || !isText(card.title) || !isRaftLink(card.originalUrl, settings.raftOrigin)) return null;
  if (!Array.isArray(card.questions) || card.questions.length === 0 || !card.questions.every(isQuestion)) return null;
  if (new Set(card.questions.map((question) => question.id)).size !== card.questions.length) return null;

  const answerable = canAnswer(card, settings);
  const elements = [];
  const answers = [];
  const source = [card.senderName, card.sourceLabel].filter(isText).join(' · ');
  if (source) elements.push(paragraph(source));
  if (isText(card.description)) elements.push(paragraph(card.description));

  for (const question of card.questions) {
    elements.push(paragraph(question.text));
    if (isText(question.description)) elements.push(paragraph(question.description));
    if (question.required) elements.push(paragraph('必答'));
    for (const option of question.options ?? []) {
      if (!answerable) {
        elements.push(paragraph(option.label));
        continue;
      }
      const behavior = { type: 'callback', value: { deliveryId: settings.deliveryId, option: answers.length } };
      elements.push(button(option.label, behavior, question.options.length === 1 ? 'primary' : 'default'));
      answers.push({ questionId: question.id, optionValue: option.value });
    }
  }

  if (isText(card.expiresAt)) elements.push(paragraph(`截止时间 · ${card.expiresAt}`));
  if (!answerable) elements.push(paragraph('请在 Raft 原卡作答。'));
  elements.push(button('打开 Raft 原卡', { type: 'open_url', default_url: card.originalUrl }));

  return {
    mode: answerable ? 'answer' : 'link',
    card: {
      schema: '2.0',
      header: { template: 'blue', title: plainText(card.title) },
      body: { direction: 'vertical', elements },
    },
    answers,
  };
}

export function showAnsweredCard(card, optionIndex) {
  const isChoice = (element) => element.behaviors?.[0]?.type === 'callback';
  const selected = card.body.elements.filter(isChoice)[optionIndex]?.text.content;
  const elements = card.body.elements.filter((element) => !isChoice(element));
  const status = selected ? `已在 Raft 作答 · ${selected}` : '已在 Raft 作答';
  elements.splice(-1, 0, paragraph(status));
  return { ...card, body: { ...card.body, elements } };
}
