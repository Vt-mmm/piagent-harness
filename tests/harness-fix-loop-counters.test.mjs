import test from 'node:test';
import assert from 'node:assert/strict';
import { gateStep } from '../src/workflow.mjs';
import { fakeHost, edit, bash } from './helpers.mjs';

const blockingReview = (calls = []) => async (args, h) => {
  calls.push(args.role);
  h.review = { patchDigest: h.state.digest, stale: false, blocking: 1, findings: [{ severity: 'blocking', file: 'src/app.js', line: 1, issue: 'bug', evidence: 'x' }] };
  h.run.reviews += 1; h.run.blocking += 1;
  return {};
};

test('verify and review loops are counted separately', async () => {
  const h = fakeHost({ workflow: { max_fix_loops: 1 }, delegate: blockingReview() });
  await edit(h);
  assert.match((await gateStep(h)).entries[0].content, /no check has passed/);           // verify loop 1 of 1
  await bash(h, 'npm test');
  const review = await gateStep(h);                                                       // review loop 1 of 1: not blocked by the spent verify loop
  assert.equal(review.continue, true);
  assert.equal(review.entries.at(-1).details.phase, 'review');
  assert.deepEqual([h.run.verifyLoops, h.run.reviewLoops, h.run.fixLoops], [1, 1, 2]);
  await edit(h); await bash(h, 'npm test');
  const done = await gateStep(h);                                                         // review loops spent: gate stops
  assert.equal(done.continue, false);
  assert.equal(h.run.reviewSettled, true);
});

test('out of verify loops the check stays unmet but the required review still runs', async () => {
  const calls = [];
  const h = fakeHost({ workflow: { max_fix_loops: 1 }, delegate: async (a, hh) => { calls.push(a.role); hh.review = { patchDigest: hh.state.digest, stale: false, blocking: 0, findings: [] };
    return {}; } });
  await edit(h);
  await gateStep(h);                  // verify loop 1
  const out = await gateStep(h);      // verify spent; review runs
  assert.deepEqual(calls, ['review']);
  assert.equal(out.continue, false);
  assert.equal(h.run.outcome, 'unverified');
  assert.equal(h.run.reviewed, true);
});

test('the report keeps the old fix_loops total', async () => {
  const h = fakeHost({ workflow: { review: 'off' } });
  await edit(h); await gateStep(h);
  assert.equal(h.run.report(null, 3).fix_loops, 1);
});
