import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/helper-run.mjs';
import { answeredSettlement, failedSettlement, settleHelper, SPEC_FIELDS } from '../src/helper-settlement.mjs';
import { helperHost } from './helpers.mjs';

const verdict = { claim: 'tests pass', status: 'pass', evidence: 'npm test: 3 pass' };

test('succeeded: verify handed in its verdicts; settled once with the helper\'s own role', async () => {
  const h = helperHost({ script: { answer: { submit: { verdicts: [verdict], summary: 'all good' } } } });
  await runHelper(h, 'verify', { role: 'verify', task: 't', target: 'src/', acceptance: 'check passes' }, undefined, false);
  assert.equal(h.settles.length, 1);
  const call = h.settles[0];
  assert.equal(call.path, '/v1/managed/settle'); assert.equal(call.role, 'verify');
  assert.equal(call.body.outcome, 'succeeded');
  assert.deepEqual(call.body.spec, { target: 'src/', acceptance: 'check passes' });
  assert.match(call.body.evidence[0], /^pass: tests pass/);
  assert.deepEqual(h.closed, ['verify'], 'the grant closes after the settlement');
});

test('failed: the helper threw', async () => {
  const h = helperHost({ script: { answer: { throws: 'managed-helper-failed: the model refused' } } });
  await assert.rejects(runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false), /refused/);
  assert.equal(h.settles[0].body.outcome, 'failed');
  assert.match(h.settles[0].body.summary, /scout subagent failed: the model refused/);
  assert.deepEqual(h.closed, ['scout']);
});

test('cancelled: the member stopped it', async () => {
  const stop = new AbortController(), h = helperHost({ script: { answer: () => { stop.abort(); return { throws: 'managed-helper-cancelled' }; } } });
  await assert.rejects(runHelper(h, 'research', { role: 'research', task: 't' }, stop.signal, false), /cancelled/);
  assert.equal(h.settles[0].body.outcome, 'cancelled');
});

test('unverifiable: no result tool call, a stale review, or an unparsed review', async () => {
  const none = helperHost({ script: { answer: { text: 'free text only' } } });
  await runHelper(none, 'verify', { role: 'verify', task: 't' }, undefined, false);
  assert.equal(none.settles[0].body.outcome, 'unverifiable');
  assert.equal(answeredSettlement('review', { result: { submitted: true, findings: [] }, stale: true }).outcome, 'unverifiable');
  assert.equal(answeredSettlement('review', { result: { submitted: true, findings: [] }, parsed: false }).outcome, 'unverifiable');
  assert.equal(answeredSettlement('scout', { result: { submitted: true, summary: 'x' }, text: 'src/a.js:3 calls it' }).outcome, 'succeeded');
});

test('Studio without managed.settle.v1 gets nothing; 5xx and 429 are retried, 4xx is not', async () => {
  const off = helperHost({ capabilities: [], script: { answer: { submit: { verdicts: [verdict], summary: 's' } } } });
  await runHelper(off, 'verify', { role: 'verify', task: 't' }, undefined, false);
  assert.equal(off.settles.length, 0);
  const calls = [], busy = { has: () => true, fetch: async () => { calls.push(1); return { ok: false, status: 503 }; } };
  assert.equal(await settleHelper({ studio: busy }, 'review', { outcome: 'failed', summary: 's', evidence: [], files: [] }, [1, 1]), false);
  assert.equal(calls.length, 3);
  const bad = []; assert.equal(await settleHelper({ studio: { has: () => true, fetch: async () => { bad.push(1); return { ok: false, status: 409 }; } } }, 'review', { outcome: 'failed',
    summary: 's', evidence: [], files: [] }, [1, 1]), false);
  assert.equal(bad.length, 1);
});

test('failed settlement never says "success" and keeps the spec', () => {
  const report = failedSettlement('verify', Error('boom'), undefined, { target: 'x' });
  assert.deepEqual([report.outcome, report.spec.target, report.files], ['failed', 'x', []]);
  assert.equal(Object.keys(SPEC_FIELDS).length, 5);
});
