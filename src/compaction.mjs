import { currentPlan, planText, unfinished } from './plan.mjs';

// When a long conversation is summarised. Pi waits until the window is full but
// for its 16k reserve. A turn re-reads the whole context: a 1M-token window full
// to the brim bills about 1M input tokens per step and answers worse. So the
// harness asks for a summary at 90% of the window, and never later than 300k
// tokens, and keeps an unfinished plan word for word in the summary.
export const COMPACT_SHARE = 0.9, COMPACT_CEILING_TOKENS = 300_000;
export const SUMMARY_RESERVE_TOKENS = 16_384;
export function compactionTrigger(contextWindow) {
  return Math.min(Math.floor(contextWindow * COMPACT_SHARE), contextWindow - SUMMARY_RESERVE_TOKENS, COMPACT_CEILING_TOKENS);
}
// Whether the context is past the trigger now. `usage` is Pi's ctx.getContextUsage().
export function shouldCompact(usage) {
  if (!usage || !(usage.contextWindow > 0) || usage.tokens == null) return false;
  return usage.tokens >= compactionTrigger(usage.contextWindow);
}
// A summary that failed is not asked again at every step: threshold attempts
// wait 1, 2, 4 … minutes (at most 30) after a failure.
export const BACKOFF_MS = 60_000, BACKOFF_MAX_MS = 30 * 60_000;
export class CompactionPolicy {
  constructor(now = Date.now) { Object.assign(this, { now, failures: 0, failedAt: 0, pending: false }); }
  wait() { return this.failures ? Math.min(BACKOFF_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS) : 0; }
  // Called after a turn: true when the harness should start a compaction now.
  due(usage) { return !this.pending && shouldCompact(usage) && this.now() - this.failedAt >= this.wait(); }
  started() { this.pending = true; }
  succeeded() { this.pending = false; this.failures = 0; }
  failed(aborted) { this.pending = false; if (!aborted) { this.failures += 1; this.failedAt = this.now(); } }
}
// Instructions for the summary: the plan is kept verbatim.
export function planInstructions(entries) {
  const plan = currentPlan(entries);
  return unfinished(plan) ? `Keep this plan in the summary word for word, with each step's status:\n${planText(plan)}` : undefined;
}
// The summary with an unfinished plan appended verbatim, whatever the model wrote.
export function withPlan(result, entries) {
  const plan = currentPlan(entries);
  return unfinished(plan) ? { ...result, summary: `${result.summary}\n\nCurrent plan (kept verbatim; keep it up to date with update_plan):\n${planText(plan)}` } : result;
}
