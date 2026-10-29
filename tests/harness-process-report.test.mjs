import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RunProcess } from '../src/workflow.mjs';
import { processVersion, sendProcessReport, REPORT_FIELDS } from '../src/report.mjs';
import { CHANNELS } from '../src/bus.mjs';
import { fakeBus } from './helpers.mjs';

// tests/fixtures/process-report-golden.json is the report the previous harness
// (Piagent 1.47.0) wrote for this very scripted task (synthetic values only).
const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/process-report-golden.json', import.meta.url), 'utf8'));
const plan = { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }, { step: 'c', status: 'deferred' }] };

async function sameTask() {
  const run = new RunProcess({ plan: 'require', verify: 'require', review: 'require', lanes: true, maxFixLoops: 2 }, { request: 'task', complex: true, checks: { commands: ['npm test'] } });
  run.startDigest = 'd0';
  await run.afterTool({ name: 'edit', input: { path: 'src/a.js' }, isError: false }, async () => 'd1');
  await run.afterTool({ name: 'bash', input: { command: 'npm test' }, isError: true }, async () => 'd1');
  await run.afterTool({ name: 'bash', input: { command: 'npm test' }, isError: false }, async () => 'd1');
  Object.assign(run, { changed: true, verified: true, reviews: 2, reviewed: true, blocking: 1, blockingOpen: 0, verifyLoops: 2, reviewLoops: 1, planUpdated: true, planSkipped: false,
    unknownTools: 2, legacyOutcome: 'clean', outcome: 'disputed' });
  run.disputes.push({ source: 'review' }); run.ledger.push({ source: 'brief', status: 'accepted' }, { source: 'brief', status: 'open' });
  return run;
}

test('process report v1, v2 and v3 match the old harness field for field, in order, on the same task', async () => {
  const run = await sameTask();
  for (const version of [1, 2, 3]) assert.equal(JSON.stringify(run.report(plan, version)), JSON.stringify(golden[`v${version}`]), `v${version}`);
});

test('v3 has every field of the old report', async () => {
  const report = (await sameTask()).report(plan, 3);
  assert.deepEqual(Object.keys(report), [...REPORT_FIELDS[1], ...REPORT_FIELDS[2], ...REPORT_FIELDS[3]]);
  assert.equal(report.fix_loops, 3, 'verify and review loops are two counters but the report keeps the old total');
});

test('the dispute shows only in v3; older versions get the outcome without it', async () => {
  const run = await sameTask();
  assert.equal(run.report(plan, 3).outcome, 'disputed'); assert.equal(run.report(plan, 2).outcome, 'clean');
});

test('steps left for later are not this run\'s work', async () => {
  const report = (await sameTask()).report(plan, 1);
  assert.deepEqual([report.plan_steps, report.plan_done], [2, 1]);
});

test('the version follows what Agent Watch advertises, or the provider\'s protocol number', () => {
  assert.equal(processVersion({ protocol: 2 }), 2); assert.equal(processVersion({ protocol: 0, features: ['process-v3'] }), 0);
  assert.equal(processVersion([]), 0);
  assert.equal(processVersion(['process']), 1);
  assert.equal(processVersion(['process', 'process-v2']), 2);
  assert.equal(processVersion(['process', 'process-v2', 'process-v3', 'close-retry']), 3);
});

test('the report goes to the provider on the bus, once the Harness has a workflow', async () => {
  const events = fakeBus(), run = await sameTask();
  assert.equal(sendProcessReport(events, { features: ['process'] }, run, plan), null, 'no workflow: nothing to report');
  assert.equal(sendProcessReport(events, { features: [], workflow: {} }, run, plan), null, 'no process feature');
  const report = sendProcessReport(events, { features: ['process', 'process-v2', 'process-v3'], workflow: { verify: 'require' } }, run, plan);
  const [channel, payload] = events.log.at(-1);
  assert.equal(channel, CHANNELS.runProcess);
  assert.deepEqual([payload.v, payload.process], [1, report]);
  assert.equal(payload.process.version, 3);
});

test('an empty run reports no_change', () => {
  const run = new RunProcess({ plan: 'off', verify: 'off', review: 'off' });
  assert.equal(run.report(null, 1).outcome, 'no_change'); assert.equal(run.report(null, 1).plan_steps, 0);
});
