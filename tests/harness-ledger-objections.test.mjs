import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/helper-run.mjs';
import { gateStep } from '../src/workflow.mjs';
import { ledgerOf, resolveTool, ledgerGuard, briefCounts, ledgerWords } from '../src/ledger.mjs';
import { beforeDelegate } from '../src/objections.mjs';
import { helperHost, edit, bash } from './helpers.mjs';

const premise = { kind: 'wrong_premise', detail: 'the function does not exist', evidence: 'src/missing.js:1' };
const solid = { kind: 'wrong_premise', detail: 'it is in a.js', evidence: 'package.json:1' };

test('a helper objection to the brief enters the ledger and is handed to the main agent', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [solid], summary: 's' } } } });
  const out = await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  const [item] = ledgerOf(h.run);
  assert.deepEqual([item.id, item.source, item.required, item.status], ['o1', 'brief', true, 'open']);
  assert.match(out.text, /objected to your brief/);
  assert.match(out.text, /file changes are refused: o1/);
  assert.throws(() => ledgerGuard(h.run, 'a1'), /resolve o1 with resolve_objection/);
});

test('an objection that points at a place that does not exist does not block edits', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [premise], summary: 's' } } } });
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  assert.equal(ledgerOf(h.run)[0].required, false);
  ledgerGuard(h.run, 'a1');
});

test('second objection from the same helper: the exchange stops and the member decides ("disputed")', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [solid], summary: 's' } } } });
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  const tool = resolveTool(() => h.run);
  await tool.execute('x', { id: 'o1', decision: 'accepted', checked: 'read it', change: 'new brief' });
  const second = await runHelper(h, 'scout', { role: 'scout', task: 'new brief' }, undefined, false);
  assert.match(second.text, /second objection/);
  assert.equal(h.run.disputes.length, 1);
  assert.equal(ledgerOf(h.run).at(-1).status, 'disputed');
  assert.throws(() => beforeDelegate(h.run, 'scout', false), /managed-helper-disputed/);
  await edit(h);
  h.policy.verify = 'off'; h.run.policy = { ...h.run.policy, verify: 'off', review: 'off' };
  await gateStep(h);
  assert.equal(h.run.outcome, 'disputed', 'the closing turn reports disputed');
  assert.equal(h.run.report(null, 3).outcome, 'disputed');
  assert.equal(h.run.report(null, 2).outcome, 'clean', 'older versions get the outcome without the dispute');
});

test('review disagreement: the agent rejects the finding, the reviewer keeps it, the member decides', async () => {
  const finding = { severity: 'blocking', file: 'src/a.js', line: 3, issue: 'null deref', evidence: 'src/a.js:3' };
  const h = helperHost({ workflow: { review: 'require', verify: 'off' }, script: { answer: { submit: { findings: [finding], summary: 'bug' } } } });
  h.delegate = (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness);
  await edit(h);
  assert.equal((await gateStep(h)).entries.at(-1).details.phase, 'review');     // sent back with the finding
  await resolveTool(() => h.run).execute('x', { id: 'o1', decision: 'rejected', checked: 'src/a.js:3', reason: 'cannot be null there' });
  // the agent changed nothing: the reviewer judges the answer once, keeps the finding
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.disputes.length, 1);
  assert.equal(ledgerOf(h.run).find(i => i.id === 'o1').status, 'disputed');
  assert.match(out.entries.map(e => e.content).join('\n'), /still disagree after two rounds; the member decides/);
  assert.equal(h.run.outcome, 'disputed');
});

test('a rejected brief objection goes back to the helper, which withdraws it', async () => {
  let turn = 0;
  const h = helperHost({ script: { answer: () => ({ submit: { brief_issues: turn++ === 0 ? [solid] : [], summary: 's' } }) } });
  h.delegate = (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness);
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  await resolveTool(() => h.run).execute('x', { id: 'o1', decision: 'rejected', checked: 'package.json:1', reason: 'it is right there' });
  await gateStep(h);
  assert.equal(ledgerOf(h.run)[0].status, 'withdrawn');
  assert.deepEqual(briefCounts(h.run), { objections: 1, answered: 1 });
  assert.match(ledgerWords(h.run), /1 withdrawn by the helper/);
});

test('resolve_objection checks its arguments', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [solid], summary: 's' } } } });
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  const tool = resolveTool(() => h.run);
  await assert.rejects(tool.execute('x', { id: 'o9', decision: 'accepted', checked: 'x', change: 'y' }), /unknown/);
  await assert.rejects(tool.execute('x', { id: 'o1', decision: 'accepted', checked: 'x' }), /names what you changed/);
  await assert.rejects(tool.execute('x', { id: 'o1', decision: 'rejected', checked: 'x' }), /says why/);
  await tool.execute('x', { id: 'o1', decision: 'accepted', checked: 'x', change: 'brief' });
  await assert.rejects(tool.execute('x', { id: 'o1', decision: 'accepted', checked: 'x', change: 'brief' }), /already accepted/);
});
