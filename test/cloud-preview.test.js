import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const preview = fileURLToPath(new URL('../src/cloud/preview.js', import.meta.url));

function run(...args) {
  return JSON.parse(execFileSync(process.execPath, [preview, ...args], { encoding: 'utf8' }));
}

test('the offline setup rehearsal shows the card, simulated native receipt and two linked traces', () => {
  const example = run();
  assert.equal(example.simulated, true);
  assert.equal(example.card.schema, '2.0');
  assert.equal(example.delivery.state, 'delivered');
  assert.equal(example.answer.state, 'answered');
  assert.equal(example.traces.length, 2);
  assert.equal(example.traces[0].traceId, example.traces[1].traceId);
});

test('the link-only rehearsal displays one delivery and no reply receipt', () => {
  const example = run('--link-only');
  assert.equal(example.answer, null);
  assert.equal(example.traces.length, 1);
  assert.ok(example.card.body.elements.every((element) => element.behaviors?.[0]?.type !== 'callback'));
});
