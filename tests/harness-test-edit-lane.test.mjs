import test from 'node:test';
import assert from 'node:assert/strict';
import { gateStep } from '../src/workflow.mjs';
import { changeLane, lanePolicy, testOrCiPath, patchStats } from '../src/risk-lanes.mjs';
import { fakeHost, edit, bash } from './helpers.mjs';

test('test and CI files are detected', () => {
  for (const p of ['tests/a.mjs', 'src/a.test.ts', 'pkg/x_test.go', 'tests/test_a.py', '.github/workflows/ci.yml', 'jest.config.js', 'e2e/login.spec.ts']) assert.equal(testOrCiPath(p), true, p);
  for (const p of ['src/app.js', 'README.md', 'src/latest.js', 'src/contest.js']) assert.equal(testOrCiPath(p), false, p);
});

test('editing a test file moves a tiny change to the risky lane', () => {
  const stats = patchStats({ patch: 'diff --git a/tests/a.test.js b/tests/a.test.js\n+x\n' });
  assert.equal(changeLane(stats), 'risky');
  assert.equal(changeLane({ files: 1, lines: 2, paths: ['src/a.js'] }), 'tiny');
  assert.equal(changeLane(null, { editedPaths: ['tests/a.test.js'] }), 'risky');
});

test('a tiny change skips the review; the same change touching a test is reviewed', async () => {
  const tiny = fakeHost({ workflow: { verify: 'suggest', review: 'suggest' } });
  tiny.state.patch = 'diff --git a/src/a.js b/src/a.js\n+x\n';
  await edit(tiny, 'src/a.js'); await bash(tiny, 'npm test');
  await gateStep(tiny);
  assert.equal(tiny.run.lane, 'tiny');
  assert.equal(tiny.state.delegated.length, 0);

  const risky = fakeHost({ workflow: { verify: 'suggest', review: 'suggest' }, delegate: async (a, h) => { h.review = { patchDigest: h.state.digest, stale: false, findings: [], blocking: 0 };
    return {}; } });
  risky.state.patch = 'diff --git a/tests/a.test.js b/tests/a.test.js\n+x\n';
  await edit(risky, 'tests/a.test.js');
  const first = await gateStep(risky);
  assert.equal(risky.run.lane, 'risky');
  assert.equal(first.continue, true); // risky lane lifts "suggest" to "require": no check yet, sent back
  assert.match(first.entries[0].content, /Harness process check/);
  await bash(risky, 'npm test');
  await gateStep(risky);
  assert.equal(risky.state.delegated[0].role, 'review');
});

test('lanes can be switched off', () => {
  assert.deepEqual(lanePolicy({ lanes: false, verify: 'suggest', review: 'suggest' }, 'risky'), { lanes: false, verify: 'suggest', review: 'suggest' });
});
