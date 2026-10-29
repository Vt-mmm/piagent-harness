import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionTrigger, shouldCompact, CompactionPolicy, planInstructions, withPlan, COMPACT_CEILING_TOKENS, BACKOFF_MS } from '../src/compaction.mjs';

test('compacts at 90% of the window', () => {
  assert.equal(compactionTrigger(200_000), 180_000);
  assert.equal(compactionTrigger(272_000), 244_800);
  assert.equal(shouldCompact({ tokens: 179_999, contextWindow: 200_000 }), false);
  assert.equal(shouldCompact({ tokens: 180_000, contextWindow: 200_000 }), true);
});

test('never later than 300k tokens, even in a 1M window', () => {
  assert.equal(COMPACT_CEILING_TOKENS, 300_000);
  assert.equal(compactionTrigger(1_000_000), 300_000);
  assert.equal(shouldCompact({ tokens: 300_000, contextWindow: 1_000_000 }), true);
  assert.equal(shouldCompact({ tokens: 299_999, contextWindow: 1_000_000 }), false);
});

test('unknown usage (just after a compaction) does not trigger', () => {
  assert.equal(shouldCompact(undefined), false);
  assert.equal(shouldCompact({ tokens: null, contextWindow: 200_000 }), false);
  assert.equal(shouldCompact({ tokens: 5, contextWindow: 0 }), false);
});

test('a failed summary backs off 1, 2, 4 minutes; one at a time', () => {
  let t = 0; const p = new CompactionPolicy(() => t), usage = { tokens: 190_000, contextWindow: 200_000 };
  assert.equal(p.due(usage), true); p.started(); assert.equal(p.due(usage), false, 'already running');
  p.failed(false); t += 30_000; assert.equal(p.due(usage), false);
  t += BACKOFF_MS; assert.equal(p.due(usage), true);
  p.started(); p.failed(false); assert.equal(p.wait(), 2 * BACKOFF_MS);
  p.started(); p.succeeded(); assert.equal(p.wait(), 0);
});

test('an unfinished plan is kept word for word; a finished one is not repeated', () => {
  const entries = [{ type: 'custom', customType: 'agent-watch-plan', data: { plan: [{ step: 'migrate db', status: 'in_progress' }, { step: 'ship', status: 'pending' }] } }];
  assert.match(planInstructions(entries), /1\. \[>\] migrate db\n2\. \[ \] ship/);
  const out = withPlan({ summary: 'S', tokensBefore: 1 }, entries);
  assert.match(out.summary, /^S\n\nCurrent plan \(kept verbatim/); assert.match(out.summary, /\[>\] migrate db/);
  const done = [{ type: 'custom', customType: 'agent-watch-plan', data: { plan: [{ step: 'a', status: 'completed' }] } }];
  assert.equal(planInstructions(done), undefined); assert.equal(withPlan({ summary: 'S' }, done).summary, 'S');
});
