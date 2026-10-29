import test from 'node:test';
import assert from 'node:assert/strict';
import { askTool, normalizeQuestions, normalizeAnswer, answerText, HEADLESS, CANCELLED } from '../src/member-questions.mjs';

const questions = [{ header: 'Phạm vi', question: 'Làm cả hai app?', options: [{ label: 'Chỉ web' }, { label: 'Cả hai', description: 'web và mobile' }] }];
const tool = askTool();
const terminal = script => ({ hasUI: true, ui: { select: async (title, items) => { const next = script.shift(); return typeof next === 'function' ? next(title, items) : next; },
  input: async () => script.shift() } });

test('Terminal: each question is a selector of numbered options, then Other and "let the agent decide"', async () => {
  let seen;
  const ctx = terminal([(title, items) => { seen = { title, items }; return items[1]; }]);
  const out = await tool.execute('c1', { questions }, undefined, undefined, ctx);
  assert.deepEqual(seen.items, ['1. Chỉ web', '2. Cả hai — web và mobile', '3. Khác (tự nhập)', 'Để agent tự quyết']);
  assert.match(out.content[0].text, /The member answered:/);
  assert.match(out.content[0].text, /→ 2\. Cả hai/);
  assert.deepEqual(out.details.answer.answers, [{ selected: [1], other: null }]);
});

test('Terminal: the member answers in their own words', async () => {
  const out = await tool.execute('c', { questions }, undefined, undefined, terminal([items => '3. Khác (tự nhập)'.length && '3. Khác (tự nhập)', 'chỉ trang đăng nhập']));
  assert.match(out.content[0].text, /→ Other: chỉ trang đăng nhập/);
});

test('Terminal: "let the agent decide" tells the agent to pick and say which', async () => {
  const out = await tool.execute('c', { questions }, undefined, undefined, terminal(['Để agent tự quyết']));
  assert.match(out.content[0].text, /leaves these decisions to you/);
});

test('headless (no UI): the agent is told to state its assumption and go on', async () => {
  for (const ctx of [undefined, { hasUI: false, ui: {} }]) {
    const out = await tool.execute('c', { questions }, undefined, undefined, ctx);
    assert.equal(out.content[0].text, HEADLESS);
    assert.match(out.content[0].text, /state the assumption plainly/);
    assert.equal(out.details.surface, 'none');
  }
});

test('stopped before answering: the decisions stay the member\'s', async () => {
  const stop = new AbortController();
  const ctx = { hasUI: true, ui: { select: async () => { stop.abort(); return undefined; } } };
  await assert.rejects(tool.execute('c', { questions }, stop.signal, undefined, ctx), e => e.message === CANCELLED);
});

test('questions must have 1-4 items with 2-4 distinct options', () => {
  assert.equal(normalizeQuestions([]), null);
  assert.equal(normalizeQuestions([{ question: 'q', options: [{ label: 'a' }] }]), null);
  assert.equal(normalizeQuestions([{ question: 'q', options: [{ label: 'a' }, { label: 'A' }] }]), null);
  assert.ok(normalizeQuestions(questions));
  assert.equal(normalizeAnswer(normalizeQuestions(questions), { answers: [{ selected: [5] }] }), null);
  assert.match(answerText(normalizeQuestions(questions), { skipped: true, answers: [] }), /judge best/);
  return assert.rejects(tool.execute('c', { questions: [] }, undefined, undefined, undefined), /managed-question-invalid/);
});
