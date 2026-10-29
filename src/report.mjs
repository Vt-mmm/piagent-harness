import { CHANNELS, CONTRACT_VERSION } from './bus.mjs';

// The process report Studio keeps for a run (close body `process`), version 1
// to 3. The provider owns the broker and the close; the harness hands it the
// report on the bus when the run ends, in the highest version both speak.
export function processVersion(features = []) {
  if (!features.includes('process')) return 0;
  return features.includes('process-v3') ? 3 : features.includes('process-v2') ? 2 : 1;
}
// The old fields, in the old order, for the same task as the old harness.
export const REPORT_FIELDS = {
  1: ['version', 'policy', 'changed', 'plan_steps', 'plan_done', 'checks', 'checks_failed', 'verified', 'reviews', 'reviewed', 'blocking', 'blocking_open', 'fix_loops', 'outcome'],
  2: ['plan_skipped', 'unknown_tools'],
  3: ['objections', 'objections_answered', 'disputes'],
};
// Sends the report of the finished run; nothing when the Harness has no workflow or Studio takes no report.
export function sendProcessReport(events, state, run, plan) {
  const version = processVersion(state?.features);
  if (!version || !state?.workflow || !run) return null;
  const report = run.report(plan, version);
  events.emit(CHANNELS.processReport, { v: CONTRACT_VERSION, version, report });
  return report;
}
