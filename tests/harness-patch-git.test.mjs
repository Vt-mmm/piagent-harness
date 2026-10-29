import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitReader, readPatchSnapshot, readHead, resolveReviewBase, readBranchBase, readChangedFiles, emptySnapshot, reviewText, reviewUnavailableReason } from '../src/patch.mjs';
import { gateStep, RunProcess, workflowPolicy } from '../src/workflow.mjs';
import { runHelper } from '../src/helper-run.mjs';
import { helperHost } from './helpers.mjs';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-git-')), run = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a],
    { stdio: 'pipe', encoding: 'utf8' });
  run('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.js'), 'one\n'); run('add', '.'); run('commit', '-qm', 'one');
  return { dir, run, git: gitReader(dir) };
}

test('digest changes with the code, not with time; untracked files count', async () => {
  const { dir, git } = repo();
  const a = await readPatchSnapshot(git, dir), b = await readPatchSnapshot(git, dir);
  assert.equal(a.digest, b.digest); assert.equal(emptySnapshot(a), true);
  fs.writeFileSync(path.join(dir, 'a.js'), 'two\n'); const c = await readPatchSnapshot(git, dir);
  assert.notEqual(c.digest, a.digest); assert.match(c.patch, /\+two/);
  fs.writeFileSync(path.join(dir, 'new.js'), 'n\n'); const d = await readPatchSnapshot(git, dir);
  assert.deepEqual(d.untracked.map(f => f.path), ['new.js']); assert.match(reviewText(d), /=== new file new\.js\nn/);
});

test('a commit made during the turn is still part of the turn\'s change', async () => {
  const { dir, run, git } = repo();
  const start = await readHead(git), before = (await readPatchSnapshot(git, dir, { base: start })).digest;
  fs.writeFileSync(path.join(dir, 'a.js'), 'two\n'); run('commit', '-qam', 'in the turn');
  const after = await readPatchSnapshot(git, dir, { base: start });
  assert.notEqual(after.digest, before); assert.match(after.patch, /\+two/);
  assert.equal(emptySnapshot(await readPatchSnapshot(git, dir)), true, 'against HEAD alone the commit would have hidden the change');
});

test('check evidence is on the final code: an edit after the check makes it stale', async () => {
  const { dir, git } = repo(), start = await readHead(git);
  const policy = workflowPolicy({ workflow: { plan: 'off', verify: 'require', review: 'off' }, roles: [] });
  const h = { cwd: dir, policy, run: new RunProcess(policy, { checks: { commands: ['npm test'] } }), review: null, entries: () => [], append() {}, messageCount: () => 0,
    assistantTextSince: () => '', note: async () => {}, delegate: async () => ({}),
    digest: async () => (await readPatchSnapshot(git, dir, { base: start })).digest, patchDigest: async () => h.digest(), patchSnapshot: () => readPatchSnapshot(git, dir, { base: start }),
      changedFiles: async () => readChangedFiles(git, dir, start) };
  h.run.startDigest = await h.digest();
  fs.writeFileSync(path.join(dir, 'a.js'), 'two\n'); await h.run.afterTool({ name: 'edit', input: { path: 'a.js' }, isError: false }, h.digest);
  await h.run.afterTool({ name: 'bash', input: { command: 'npm test' }, isError: false, output: '' }, h.digest);
  fs.writeFileSync(path.join(dir, 'a.js'), 'three\n');                                    // edited by a command, after the check
  const out = await gateStep(h);
  assert.equal(out.continue, true); assert.match(out.entries[0].content, /no check has passed on the current code/);
});

test('review since: a commit, a branch or HEAD~N the work started from', async () => {
  const { dir, run, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'two\n'); run('commit', '-qam', 'two'); fs.writeFileSync(path.join(dir, 'a.js'), 'three\n'); run('commit', '-qam', 'three');
  const base = await resolveReviewBase(git, 'HEAD~2');
  assert.match(base, /^[0-9a-f]{40}$/);
  const snap = await readPatchSnapshot(git, dir, { base, from: { kind: 'since', ref: 'HEAD~2', base } });
  assert.match(snap.patch, /\+three/); assert.match(reviewText(snap), /diff against HEAD~2/);
  assert.equal(await resolveReviewBase(git, 'nonexistent'), null);
  assert.equal(await resolveReviewBase(git, '--output=x'), null, 'a ref cannot be an option');
  run('checkout', '-qb', 'feat'); fs.writeFileSync(path.join(dir, 'b.js'), 'b\n'); run('add', '.'); run('commit', '-qm', 'b');
  const branch = await readBranchBase(git); assert.deepEqual(branch.ref, 'main'); assert.match(branch.base, /^[0-9a-f]{40}$/);
});

test('delegate review with since reads those commits, and is not the review of this turn', async () => {
  const { dir, run, git } = repo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'two\n'); run('commit', '-qam', 'two');
  const h = helperHost({ script: { answer: { submit: { findings: [], summary: 's' } } } });
  h.git = git; h.cwd = dir; delete h.patchSnapshotFull;
  h.patchSnapshotFull = () => readPatchSnapshot(git, dir); h.patchDigestSince = async base => (await readPatchSnapshot(git, dir, { base })).digest;
  await runHelper(h, 'review', { role: 'review', task: 't', since: 'HEAD~1' }, undefined, false);
  assert.match(h.sent[0].prompt, /diff against HEAD~1/); assert.match(h.sent[0].prompt, /\+two/);
  assert.equal(h.review, null, 'a review of earlier commits is not the turn\'s review');
  await assert.rejects(runHelper(h, 'review', { role: 'review', task: 't', since: 'nope' }, undefined, false), /managed-review-base-unknown/);
});

test('why a required review could not run', () => {
  assert.equal(reviewUnavailableReason('fatal: not a git repository'), 'not_git');
  assert.equal(reviewUnavailableReason('managed-review-patch-too-large'), 'too_large');
  assert.equal(reviewUnavailableReason('managed-helper-limit'), 'limit');
  assert.equal(reviewUnavailableReason('boom'), 'failed');
});
