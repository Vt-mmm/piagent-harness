import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/helper-run.mjs';
import { resultTools } from '../src/helper-results.mjs';
import { childSessions } from '../src/children.mjs';
import { gateStep } from '../src/workflow.mjs';
import { CHANNELS } from '../src/bus.mjs';
import { fakeBus, helperHost, edit, bash } from './helpers.mjs';

const finding = (severity, over = {}) => ({ severity, file: 'src/a.js', line: 3, issue: `a ${severity} problem`, evidence: 'src/a.js:3', ...over });

test('the review result comes through the schema tool, not from free text', async () => {
  const h = helperHost({ script: { answer: { text: 'looks fine {"findings":[{"severity":"blocking","issue":"fake"}]}', submit: { findings: [finding('major')], summary: 'one major' } } } });
  const out = await runHelper(h, 'review', { role: 'review', task: 'review it' }, undefined, false);
  assert.equal(out.findings.length, 1);
  assert.equal(out.details.blocking, 0, 'JSON written into the prose is ignored');
  assert.equal(h.review.parsed, true);
  const schema = resultTools.submit_review({}).parameters;
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, ['blocking', 'major', 'minor']);
  assert.equal(schema.additionalProperties, false);
});

test('a helper that never calls the tool is asked once, then the review is unverifiable', async () => {
  const h = helperHost({ script: { answer: { text: 'I read it, all good' } } });
  const out = await runHelper(h, 'review', { role: 'review', task: 'review it' }, undefined, false);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].prompt, /ended without calling submit_review/);
  assert.equal(out.outcome, 'unverifiable');
  assert.equal(h.review.parsed, false);
});

test('a tool call with a bad schema is refused', async () => {
  const tool = resultTools.submit_review({});
  await assert.rejects(tool.execute('x', { findings: 'nope', summary: 's' }), /managed-result-invalid/);
});

test('review failure blocks: the error is kept and the gate reports it (not silent)', async () => {
  const h = helperHost({ workflow: { review: 'require', verify: 'off' }, script: { answer: { throws: 'managed-helper-failed: boom' } } });
  h.delegate = (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness);
  await edit(h);
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.reviewUnavailable, true);
  assert.equal(h.run.outcome, 'review_unavailable');
  assert.equal(h.settles.at(-1).body.outcome, 'failed');
});

test('a blocking finding is sent back to the agent', async () => {
  const h = helperHost({ workflow: { review: 'require', verify: 'off' }, script: { answer: { submit: { findings: [finding('blocking')], summary: 'bug' } } } });
  h.delegate = (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness);
  await edit(h);
  const out = await gateStep(h);
  assert.equal(out.continue, true);
  assert.match(out.entries.at(-1).content, /found 1 blocking issue/);
  assert.equal(out.entries.at(-1).details.phase, 'review');
});

test('the reviewer is told to read only the changed files after a fix', async () => {
  const h = helperHost({ workflow: { review: 'require', verify: 'off' }, script: { answer: { submit: { findings: [finding('blocking')], summary: 'bug' } } } });
  h.delegate = (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness);
  h.changedFiles = async () => new Map([['src/a.js', 'hash1']]);
  await edit(h); await gateStep(h);                 // first review, finding sent back
  h.changedFiles = async () => new Map([['src/a.js', 'hash2'], ['src/b.js', 'x']]);
  await edit(h); h.snapshotDigest = 'q'.repeat(64);
  await gateStep(h);
  const second = h.sent.at(-1).prompt;
  assert.match(second, /Since your last review only these\s+files changed: src\/a\.js, src\/b\.js/);
  assert.match(second, /the rest of the patch was\s+reviewed and has not changed/);
});

test('child session: read-only grant of its own, asked over the bus', async () => {
  const events = fakeBus(), requests = [];
  events.on(CHANNELS.grantRequest, data => { requests.push(data); data.reply(data.release ? { ok: true } : { ok: true, role: 'child', effort: 'low', models: [{ id: 'm' }], modelRuntime: {} }); });
  events.on(CHANNELS.childTools, data => { requests.push(data); data.reply({ ok: true, tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'].map(name => ({ name })) }); });
  let sessionOptions = null;
  const sdk = { SettingsManager: { inMemory: () => ({}) }, SessionManager: { inMemory: () => ({}) },
    createAgentSession: async o => { sessionOptions = o; return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop',
      usage: { totalTokens: 7 } }], prompt: async () => {}, abort() {}, dispose() {} } }; } };
  const child = await childSessions({ events, cwd: '/p', loadSdk: async () => sdk }).create({ role: 'review', key: 'review', setup: { commands: false, web: false, prompt: 'p' } });
  const answer = await child.ask('hi', { resultTool: { name: 'submit_review' } });
  assert.equal(answer.tokens, 7);
  const grant = requests.find(r => r.role === 'child' && !r.release);
  assert.deepEqual([grant.v, grant.purpose], [1, 'review']);
  assert.equal(requests.find(r => 'readOnly' in r).readOnly, true);
  assert.deepEqual(sessionOptions.customTools.map(t => t.name), ['read', 'grep', 'find', 'ls', 'submit_review'], 'no edit, write or bash for a reviewer');
  assert.equal(sessionOptions.noTools, 'builtin');
  await child.close();
  assert.equal(requests.at(-1).release, true);
});

test('child grant refused: the helper fails with the provider\'s reason', async () => {
  const events = fakeBus();
  events.on(CHANNELS.grantRequest, data => data.reply({ ok: false, error: 'helper_capacity_exhausted' }));
  await assert.rejects(childSessions({ events, cwd: '/p', loadSdk: async () => ({}) }).create({ role: 'scout', key: 'scout', setup: {} }), /helper_capacity_exhausted/);
});
