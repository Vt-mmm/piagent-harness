import { unfinished, planText } from './plan.mjs';

// A main agent often ends its turn between the steps of its own checklist
// ("STEP06 done, STEP07 next"), though the member asked for all of them. Under
// plan "require" the harness sends it back to the next open step, as a new
// round (each round gets its own checks and review), until the checklist is
// done, the member stops it, a round fails, or IDLE_ROUNDS rounds in a row
// change nothing. A checklist holds at most 30 steps: one round per step at most.
export const IDLE_ROUNDS = 2;
export const MAX_ROUNDS = 30;
export const TURN_END_ENTRY = 'agent-watch-turn-end';
const completed = plan => plan?.plan?.filter(p => p.status === 'completed').length ?? 0;
const deferred = plan => plan?.plan?.filter(p => p.status === 'deferred').length ?? 0;

export class Continuation {
  constructor(policy) { Object.assign(this, { policy, rounds: 0, idle: 0, touched: false, reason: null, startDone: 0 }); }
  // A round is about to start: what its progress is measured from.
  begin(plan) { this.startDone = completed(plan); }
  // A round ended. The message that starts the next round, or null: then
  // `reason` says why the harness stopped sending it back.
  next({ plan, planUpdated, changed, stopped, failed }) {
    if (planUpdated) this.touched = true;
    if (stopped) { this.reason = 'stopped'; return null; }
    if (failed) { this.reason = 'failed'; return null; }
    if (!this.touched || !unfinished(plan)) { this.reason = null; return null; }
    if (this.policy.plan !== 'require') { this.reason = 'policy'; return null; }
    // The member's own round always gets one round back; a harness round that
    // neither completed a step nor changed code counts as idle.
    if (this.rounds > 0) this.idle = completed(plan) > this.startDone || changed ? 0 : this.idle + 1;
    if (this.idle >= IDLE_ROUNDS) { this.reason = 'idle'; return null; }
    if (this.rounds >= MAX_ROUNDS) { this.reason = 'limit'; return null; }
    this.rounds += 1;
    const steps = plan.plan.length, done = completed(plan), open = steps - done - deferred(plan);
    return { customType: 'agent-watch-process', display: true,
      content: `Harness: your checklist still has ${open} open step(s) (${done}/${steps} completed):\n${planText(plan)}\n`
        + 'The member asked for all of it, unless they told you to stop at this point. Continue with the next open step now and keep going until every step is completed; '
        + 'update the checklist with update_plan as you go. Do not stop to report progress between steps. If the member asked you to stop here '
        + '(to review a plan before any change, for example) or you cannot go on without them (a decision, access, a service that is not running), ask with ask_user instead of going on. '
        + 'If a step is no longer needed, take it out of the checklist and say why in your final answer.',
      details: { phase: 'continue', round: this.rounds, maxRounds: MAX_ROUNDS, planOpen: open, planDone: done, planSteps: steps, ...(this.idle ? { idle: this.idle } : {}) } };
  }
}
// "tiếp tục", "continue": the member asks for the open checklist, so it is this message's work.
const CONTINUE = /^(tiep tuc|lam tiep|lam not|continue|go on|keep going|resume)\b/;
export function asksToContinue(text) {
  const normal = String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase().trim();
  return normal.length <= 60 && CONTINUE.test(normal);
}
// How a member's message ended: done, stopped with steps open (and why the
// harness did not go on), failed (which role, which kind) or stopped by the member.
export function turnEnd(continuation, plan, { stopped, failure }) {
  const steps = continuation.touched ? plan?.plan?.length ?? 0 : 0, done = continuation.touched ? completed(plan) : 0, later = continuation.touched ? deferred(plan) : 0;
  const state = stopped ? 'cancelled' : failure ? 'failed' : continuation.touched && unfinished(plan) ? 'midway' : 'done';
  return { state, planSteps: steps, planDone: done, ...(later ? { planDeferred: later } : {}), rounds: continuation.rounds,
    ...(state === 'midway' && continuation.reason ? { reason: continuation.reason } : {}),
    ...(state === 'failed' ? { role: failure.role ?? 'main', code: String(failure.code || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64) } : {}),
    at: new Date().toISOString() };
}
export function turnEndText(end) {
  if (end.state === 'cancelled') return 'Turn stopped by the member.';
  if (end.state === 'failed') return `Turn failed: ${end.role} agent, ${end.code}. Send "continue" to go on.`;
  if (end.state === 'midway') {
    const why = end.reason === 'idle' ? `: the agent stopped ${IDLE_ROUNDS} times in a row without progress` : end.reason === 'limit' ? `: ${MAX_ROUNDS} rounds reached` : '';
    return `Turn ended with ${end.planSteps - end.planDone - (end.planDeferred ?? 0)} of ${end.planSteps} checklist step(s) open${why}. Send "continue" to go on.`;
  }
  if (end.planDeferred) return `Done: ${end.planDone} of ${end.planSteps} checklist steps completed, ${end.planDeferred} left for later.`;
  return end.planSteps ? `Done: all ${end.planSteps} checklist steps completed.` : 'Done.';
}
