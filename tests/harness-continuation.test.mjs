import test from 'node:test';
import assert from 'node:assert/strict';
import { Continuation, IDLE_ROUNDS, MAX_ROUNDS, asksToContinue, turnEnd, turnEndText } from '../src/continuation.mjs';
import { normalizePlan, planTool, currentPlan, unfinished } from '../src/plan.mjs';

const plan = (done, total, extra = {}) => ({ plan: Array.from({ length: total }, (_, i) => ({ step: `s${i + 1}`, status: i < done ? 'completed' : 'pending', ...extra })) });
const require = { plan: 'require' };

test('a checklist with open steps sends the agent back to the next one', () => {
  const c = new Continuation(require); c.begin(plan(0, 3));
  const next = c.next({ plan: plan(1, 3), planUpdated: true, changed: true });
  assert.equal(next.details.phase, 'continue'); assert.equal(next.details.planOpen, 2); assert.match(next.content, /1\/3 completed/);
});

test('it stops when the checklist is done, deferred, untouched, or the policy is not "require"', () => {
  const c = () => new Continuation(require);
  assert.equal(c().next({ plan: plan(3, 3), planUpdated: true }), null);
  assert.equal(c().next({ plan: { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'deferred' }] }, planUpdated: true }), null);
  assert.equal(c().next({ plan: plan(1, 3), planUpdated: false }), null);
  const suggest = new Continuation({ plan: 'suggest' }); assert.equal(suggest.next({ plan: plan(1, 3), planUpdated: true }), null); assert.equal(suggest.reason, 'policy');
});

test('it stops after 2 rounds in a row that change nothing', () => {
  const c = new Continuation(require), p = plan(1, 5);
  assert.ok(c.next({ plan: p, planUpdated: true, changed: true }));             // the member's round: always one back
  c.begin(p);
  assert.ok(c.next({ plan: p, changed: false }));                                 // idle 1
  assert.equal(c.next({ plan: p, changed: false }), null);                        // idle 2 -> stop
  assert.deepEqual([c.reason, c.idle, IDLE_ROUNDS], ['idle', 2, 2]);
});

test('progress (a step completed, or code changed) resets the idle count', () => {
  const c = new Continuation(require);
  c.next({ plan: plan(1, 6), planUpdated: true, changed: true });
  c.begin(plan(1, 6)); c.next({ plan: plan(1, 6), changed: false });                // idle 1
  c.begin(plan(1, 6)); assert.ok(c.next({ plan: plan(2, 6), changed: false }));      // step completed: idle 0
  assert.equal(c.idle, 0);
});

test('at most 30 steps and 30 rounds', () => {
  assert.equal(MAX_ROUNDS, 30);
  assert.doesNotThrow(() => normalizePlan(plan(0, 30)));
  assert.throws(() => normalizePlan(plan(0, 31)), /managed-plan-invalid/);
  const c = new Continuation(require); let n = 0;
  for (let i = 0; i < 40; i += 1) { c.begin(plan(i % 25, 30)); if (!c.next({ plan: plan((i % 25) + 1, 30), planUpdated: true, changed: true })) break; n += 1; }
  assert.equal(n, 30); assert.equal(c.reason, 'limit');
});

test('a stopped or failed round is not sent back', () => {
  const c = new Continuation(require);
  assert.equal(c.next({ plan: plan(1, 3), planUpdated: true, stopped: true }), null); assert.equal(c.reason, 'stopped');
  assert.equal(new Continuation(require).next({ plan: plan(1, 3), planUpdated: true, failed: true }), null);
});

test('how the message ended is said in words', () => {
  const c = new Continuation(require); c.touched = true; c.rounds = 4; c.reason = 'idle';
  const end = turnEnd(c, plan(2, 5), { stopped: false, failure: null });
  assert.equal(end.state, 'midway'); assert.match(turnEndText(end), /3 of 5 checklist step\(s\) open: the agent stopped 2 times in a row/);
  assert.equal(turnEnd(c, plan(5, 5), {}).state, 'done');
  assert.equal(turnEnd(c, plan(2, 5), { stopped: true }).state, 'cancelled');
  assert.equal(turnEnd(c, plan(2, 5), { failure: { code: 'Upstream Timeout!' } }).code, 'upstream_timeout_');
});

test('"tiếp tục" / continue asks for the open checklist', () => {
  for (const t of ['tiếp tục', 'Làm tiếp', 'continue', 'keep going please']) assert.equal(asksToContinue(t), true, t);
  assert.equal(asksToContinue('please continue refactoring the parser module and add docs for the public API now'), false);
});

test('the plan tool stores the whole list and reads a list sent as a string', async () => {
  let stored; const tool = planTool(async p => { stored = p; });
  const args = tool.prepareArguments({ plan: JSON.stringify([{ step: 'a', status: 'in_progress' }]) });
  await tool.execute('1', args);
  assert.deepEqual(stored.plan, [{ step: 'a', status: 'in_progress' }]);
  assert.throws(() => normalizePlan({ plan: [{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }] }), /at most one/);
  assert.equal(unfinished(currentPlan([{ type: 'custom', customType: 'agent-watch-plan', data: stored }])), true);
});
