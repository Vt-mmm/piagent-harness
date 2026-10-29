import test from 'node:test';
import assert from 'node:assert/strict';
import { runHelper } from '../src/helper-run.mjs';
import { helperHost } from './helpers.mjs';

test('a helper that runs for a long time is never stopped by the harness (no timer of its own)', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [], summary: 's' } } } });
  const children = h.children; let released;
  h.children = { create: async spec => { const child = await children.create(spec); return { ...child, ask: async (...args) => { await new Promise(r => { released = r; });
    return child.ask(...args); } }; } };
  const run = runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.closed.length, 0, 'still running, grant open');
  released(); assert.equal((await run).outcome, 'succeeded');
});

test('Studio\'s reason for refusing a helper is named', async () => {
  const h = helperHost();
  h.children = { create: async () => { throw Error('managed-broker:permissionDenied helper_run_limit_reached'); } };
  await assert.rejects(runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false), /managed-helper-failed: .*helper_run_limit_reached/);
  assert.equal(h.settles.at(-1).body.outcome, 'failed');
});

test('a helper whose model account is resting starts once more on the next model of its role', async () => {
  let calls = 0; const h = helperHost({ script: { answer: () => { calls += 1; return calls === 1 ? { throws: 'managed-helper-failed: {"code":"upstream_rate_limited"}' }
    : { submit: { brief_issues: [], summary: 's' } }; } } });
  const out = await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  assert.equal(out.outcome, 'succeeded'); assert.equal(h.created.length, 2);
  assert.deepEqual(h.settles.map(s => s.body.outcome), ['failed', 'succeeded']);
});
