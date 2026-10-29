import test from 'node:test';
import assert from 'node:assert/strict';
import { gateStep, RunProcess } from '../src/workflow.mjs';
import { isReadOnlyCommand } from '../src/checks.mjs';
import { fakeHost, bash } from './helpers.mjs';

// A project that is not a git repository: no digest, so "changed" follows the tools of the turn.
const plainHost = () => { const h = fakeHost({ workflow: { review: 'off' } }); h.digest = async () => null; h.patchDigest = async () => null; h.run.startDigest = null; return h; };
const turn = h => { h.run = new RunProcess(h.policy, { checks: { source: 'agents', commands: ['npm test'] } }); };

test('turn 2 with a read-only environment listing is not a change and is not sent back', async () => {
  const h = plainHost();
  await h.run.afterTool({ name: 'edit', input: { path: 'add.js' }, isError: false }, async () => null);
  await bash(h, 'npm test', { output: '# pass 1\n# fail 0' });
  assert.equal((await gateStep(h)).continue, false);
  turn(h);
  await bash(h, 'env | cut -d= -f1 | sort');
  const out = await gateStep(h);
  assert.equal(out.continue, false);
  assert.equal(h.run.changed, false);
  assert.equal(h.run.report(null, 3).changed, false);
});

test('environment and system readers are read-only, a command run through env is not', () => {
  for (const c of ['env', 'printenv HOME', 'uname -a', 'whoami', 'ps aux | grep node']) assert.equal(isReadOnlyCommand(c), true, c);
  for (const c of ['env FOO=1 node build.js', 'env rm -rf x']) assert.equal(isReadOnlyCommand(c), false, c);
});

test('a command that may write still counts as a change without a digest', async () => {
  const h = plainHost();
  await bash(h, 'node build.js');
  assert.equal((await gateStep(h)).continue, true);
  assert.equal(h.run.changed, true);
});
