import test from 'node:test';
import assert from 'node:assert/strict';
import { gateStep } from '../src/workflow.mjs';
import { isCheckCommand, checkPassed } from '../src/checks.mjs';
import { fakeHost, edit, bash } from './helpers.mjs';

const verifyOnly = { review: 'off' };

test('no check sends back: code changed, nothing ran', async () => {
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h);
  const out = await gateStep(h);
  assert.equal(out.continue, true);
  assert.match(out.entries[0].content, /Harness process check/);
  assert.equal(out.entries[0].details.phase, 'verify');
});

test('a passing check on the final code lets the turn end', async () => {
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h); await bash(h, 'npm test', { output: '# pass 3\n# fail 0' });
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.verified, true);
  assert.equal(h.run.outcome, 'clean');
});

test('a check that passed on older code is stale after another edit', async () => {
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h); await bash(h, 'npm test'); await edit(h);
  const out = await gateStep(h);
  assert.equal(out.continue, true);
});

test('docs-only change needs no check', async () => {
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h, 'README.md');
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.docsOnly, true);
  assert.equal(h.run.outcome, 'clean');
});

test('out of fix loops the gate gives up and the outcome is unverified', async () => {
  const h = fakeHost({ workflow: { ...verifyOnly, max_fix_loops: 1 } });
  await edit(h);
  assert.equal((await gateStep(h)).continue, true);
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.outcome, 'unverified');
});

test('interrupted turn that changed code is reported interrupted, not sent back', async () => {
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h);
  const out = await gateStep(h, { aborted: true });
  assert.equal(out.continue, false);
  assert.equal(h.run.outcome, 'interrupted');
});

test('piped check: failing output is not a pass even when tail exits 0', async () => {
  const failing = '# tests 5\n# pass 4\n# fail 1\n';
  assert.equal(checkPassed({ command: 'npm test | tail -20', isError: false, output: failing }), false);
  assert.equal(checkPassed({ command: 'npm test 2>&1 | tail -20', isError: false, output: '# pass 5\n# fail 0' }), true);
  assert.equal(checkPassed({ command: 'npm test', isError: true, output: '' }), false);
  const h = fakeHost({ workflow: verifyOnly });
  await edit(h); await bash(h, 'npm test | tail -20', { output: failing });
  assert.equal(h.run.checksFailed, 1);
  assert.equal((await gateStep(h)).continue, true);
});

test('"0 failed" in a piped passing run is not a failure', () => {
  assert.equal(checkPassed({ command: 'npm test | tail', isError: false, output: 'Tests: 12 passed, 0 failed' }), true);
});

test('filtered runs and version probes are not checks', async () => {
  for (const c of ['pytest -k login', 'tsc --version', 'npx vitest run -t "x"', 'node --test --test-name-pattern=a', 'jest --grep a', 'mocha --grep x', 'go test -run TestA ./...', 'eslint --version'])
    assert.equal(isCheckCommand(c), false, c);
  for (const c of ['pytest', 'tsc --noEmit', 'npm test', 'npm run lint', 'go test ./...']) assert.equal(isCheckCommand(c), true, c);
  const h = fakeHost({ workflow: verifyOnly, checks: [] });
  await edit(h); await bash(h, 'pytest -k x'); await bash(h, 'tsc --version');
  assert.equal(h.run.checksRun, 0);
  assert.equal((await gateStep(h)).continue, true);
});
