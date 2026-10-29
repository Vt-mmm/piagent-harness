import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitReader, readChangedFiles, readPatchSnapshot } from '../src/patch.mjs';
import { repositoryAt } from '../src/memory-repos.mjs';
import { git as memoryGit } from '../src/memory-repos.mjs';
import { ToolsetGuard, CORE_TOOLS, checkToolset, pinnedSandboxRoot } from '../src/guard.mjs';
import { CHANNELS } from '../src/bus.mjs';
import { redact } from '../src/redact.mjs';
import { toolFailure } from '../src/tool-failures.mjs';
import { NEEDLES, SECRETS } from './fixtures/secret-corpus.mjs';
import { fakeBus } from './helpers.mjs';

// Regression tests for docs/security-review.md (C1 host side, T1 guard pin, T5). Temporary folders, fake HOME, synthetic strings.
const env = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-')), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { env, stdio: 'pipe', encoding: 'utf8' });

function hostileRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-c1-')), dir = path.join(root, 'project'), marker = path.join(root, 'MARKER');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'one');
  const script = name => { const file = path.join(dir, '.git', name); fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker}-${name}'\n`, { mode: 0o755 }); return file; };
  fs.appendFileSync(path.join(dir, '.git/config'), `[core]\n\tfsmonitor = ${script('fsm.sh')}\n\tsshCommand = ${script('ssh.sh')}\n[diff "x"]\n\ttextconv = ${script('tc.sh')}\n[remote "origin"]\n\turl = https://example.invalid/acme/shop.git\n`);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=x\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  return { dir, marker };
}
const ran = marker => ['fsm.sh', 'ssh.sh', 'tc.sh'].filter(name => fs.existsSync(`${marker}-${name}`));

test('C1: the patch snapshot, changed files and memory probes run no program from a hostile .git/config', async () => {
  const { dir, marker } = hostileRepo();
  const reader = gitReader(dir);
  await readPatchSnapshot(reader, dir); await readChangedFiles(reader, dir);
  await repositoryAt(dir); await memoryGit(dir, ['status', '--porcelain', '--untracked-files=no']);
  assert.deepEqual(ran(marker), [], 'a planted script ran on the host');
});

test('T1: the toolset guard trusts the sandbox folder it was given, not what the tools say about themselves', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-')), pinned = path.join(root, 'packages/piagent-sandbox');
  fs.mkdirSync(path.join(pinned, 'src'), { recursive: true }); fs.mkdirSync('/tmp/evil-x', { recursive: true });
  const toolsFrom = file => CORE_TOOLS.map(name => ({ name, sourceInfo: { path: file, source: 'cli', scope: 'temporary', origin: 'top-level' } }));
  const attested = new Map(CORE_TOOLS.map(n => [n, 'x.mjs']));
  // The review's scenario: seven tools from another folder, attested under that folder's own name.
  assert.equal(checkToolset(toolsFrom('/tmp/evil-x/x.mjs'), attested, pinned).ok, false);
  // A look-alike folder named piagent-sandbox elsewhere.
  const alike = path.join(root, 'elsewhere/piagent-sandbox/evil.mjs');
  fs.mkdirSync(path.dirname(alike), { recursive: true });
  assert.equal(checkToolset(toolsFrom(alike), new Map(CORE_TOOLS.map(n => [n, 'piagent-sandbox'])), pinned).ok, false);
  assert.equal(checkToolset(toolsFrom(path.join(pinned, 'src/index.mjs')), new Map(), pinned).ok, true);
  const events = fakeBus(), guard = new ToolsetGuard({ events, getTools: () => toolsFrom('/tmp/evil-x/x.mjs'), pinned }); guard.start();
  events.emit(CHANNELS.toolsAttest, { v: 1, tools: CORE_TOOLS.map(name => ({ name, source: 'x.mjs' })) });
  assert.equal((await guard.verify()).ok, false);
});

test('T1: the pinned folder is read from the bundle manifest next to the harness', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-')));
  fs.mkdirSync(path.join(root, 'packages/h/src'), { recursive: true }); fs.mkdirSync(path.join(root, 'packages/s'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 1, parts: { harness: { path: 'packages/h' }, sandbox: { path: 'packages/s' } } }));
  fs.writeFileSync(path.join(root, 'packages/h/src/guard.mjs'), '');
  assert.equal(pinnedSandboxRoot(path.join(root, 'packages/h/src/guard.mjs')), path.join(root, 'packages/s'));
  assert.equal(pinnedSandboxRoot(path.join(os.tmpdir(), 'not-in-a-bundle/x.mjs')), null);
});

test('T5: every secret shape of the corpus is redacted, and a failed call sends the program and the last 300 characters only', () => {
  for (const [i, secret] of SECRETS.entries()) assert.ok(!redact(`before ${secret} after`).includes(NEEDLES[i]), `leaked: ${NEEDLES[i]}`);
  const failure = toolFailure({ tool: 'bash', role: 'main', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop12345678" https://api.example.invalid/x?k=v' },
    content: [{ type: 'text', text: `${'source line\n'.repeat(200)}${SECRETS[10]}\nCommand exited with code 1` }], startedAt: 1, endedAt: 2, home: '/Users/me' });
  assert.equal(failure.input, 'curl');
  assert.ok(failure.error.length < 400 && !failure.error.includes('ghp_'), failure.error);
  assert.equal(failure.code, 'exit_1');
});
