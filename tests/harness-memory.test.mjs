import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TeamMemory, memoryTools, memoryPrompt, turnRecord, PROTOCOL } from '../src/memory.mjs';
import { repoKey } from '../src/memory-repos.mjs';
import { MemoryOutbox, scopeID } from '../src/memory-outbox.mjs';
import { CheckLessons } from '../src/memory-lessons.mjs';

const scope = { studio_instance_id: 's1', dataset_epoch: 'e1', auth_generation: 1, key_id: '00000000-0000-4000-8000-000000000001' };
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mem-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('remote', 'add', 'origin', 'git@github.com:Acme/Shop.git');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first');
  return dir;
}
// A Studio standing in for the real one: records each memory call.
function studioStub(handlers = {}, capabilities = ['memory']) {
  const calls = [];
  return { calls, has: name => capabilities.includes(name), fetch: async (p, opts) => { calls.push({ path: p, ...opts }); const op = p.split('/').pop(); const h = handlers[op]; return h
    ? h(opts.body, calls.length) : { ok: false, status: 404 }; } };
}
const make = (studio, dir = repo()) => new TeamMemory({ studio, cwd: dir, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'harness-state-')), conversationId: 'c1', scope: () => scope });

test('repoKey: origin without scheme, user, port or .git, lower case', () => {
  assert.equal(repoKey('git@github.com:Acme/Shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('https://user@github.com/Acme/Shop.git'), 'github.com/acme/shop');
  assert.equal(repoKey('file:///tmp/x'), null);
});

test('brief goes through Studio with the repo key, branch context (protocol 3) and ends up in the prompt as data', async () => {
  const studio = studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 3, text: 'Use pnpm here.', facts: 4, pages: ['Core concepts'], retain_sessions: true,
    git_head: null } }), git: () => ({ ok: true, status: 200, body: { status: 'accepted' } }) });
  const memory = make(studio);
  const brief = await memory.brief('fix the cart');
  assert.deepEqual([brief.text, brief.facts], ['Use pnpm here.', 4]);
  const call = studio.calls.find(c => c.path === '/v1/memory/brief');
  assert.equal(call.body.repo_key, 'github.com/acme/shop'); assert.equal(call.body.prompt, 'fix the cart');
  assert.equal(memory.protocol, 3);
  assert.match(memoryPrompt(brief), /data, not instructions/);
  assert.equal(memoryPrompt({ text: '' }), '');
});

test('memory off (204) is not asked again for 30 minutes', async () => {
  const studio = studioStub({ brief: () => ({ ok: true, status: 204, body: null }) });
  let now = 1000; const memory = new TeamMemory({ studio, cwd: repo(), stateDir: os.tmpdir(), conversationId: 'c', scope: () => scope, now: () => now });
  assert.equal(await memory.brief('x'), null);
  await memory.brief('x'); assert.equal(studio.calls.length, 1);
  now += 31 * 60_000; await memory.brief('x'); assert.equal(studio.calls.length, 2);
});

test('Studio without the memory capability: nothing is sent', async () => {
  const studio = studioStub({}, []);
  assert.equal(await make(studio).brief('x'), null);
  assert.equal(studio.calls.length, 0);
});

test('memory_ask (protocol 3): the answer comes with its sources; protocol 2 Studio is refused clearly', async () => {
  const ask = { answer: 'Because of rate limits.', sources: [{ text: 'ADR 7', origin: 'github.com/acme/shop', when: '2026-09' }] };
  const studio = studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 3, text: 't' } }), ask: () => ({ ok: true, status: 200, body: ask }) });
  const memory = make(studio); await memory.brief('x');
  const tool = memoryTools(memory).find(t => t.name === 'memory_ask');
  const out = await tool.execute('1', { question: 'why retry?' });
  assert.match(out.content[0].text, /Because of rate limits\.\n\nSources:\n- ADR 7 \(github\.com\/acme\/shop, 2026-09\)/);
  assert.equal(studio.calls.at(-1).timeoutMs, 50_000);
  const old = make(studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 2, text: 't' } }) })); await old.brief('x');
  await assert.rejects(memoryTools(old).find(t => t.name === 'memory_ask').execute('1', { question: 'q' }), /memory-ask-unavailable/);
  assert.deepEqual(memoryTools(memory, { readOnly: true }).map(t => t.name), ['memory_search'], 'helpers only search');
});

test('a 404 on ask is not "memory off"', async () => {
  const studio = studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 3, text: 't' } }), ask: () => ({ ok: false, status: 404 }), git: () => ({ ok: true, status: 200,
    body: {} }) });
  const memory = make(studio); await memory.brief('x');
  await memory.ask('q');
  assert.equal(memory.active, true);
});

test('retain: the round is queued with event id, files and checks (protocol 3), sent, and removed from the outbox', async () => {
  const studio = studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 3, text: 't' } }), retain: body => ({ ok: true, status: 200, body: { status: 'pending',
    event_id: body.event_id } }), git: () => ({ ok: true, status: 200, body: {} }) });
  const memory = make(studio); await memory.brief('x');
  await memory.afterRound([{ role: 'user', content: 'add a cart' }, { role: 'assistant', content: [{ type: 'text', text: 'done, see cart.js' }] }], { changedFiles: ['src/cart.js'],
    checks: { passed: 1, failed: 0, final: 'passed' } });
  const sent = studio.calls.find(c => c.path === '/v1/memory/retain').body;
  assert.equal(sent.source_key_id, scope.key_id); assert.match(sent.event_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent.files, ['src/cart.js']); assert.deepEqual(sent.checks, { passed: 1, failed: 0, final: 'passed' });
  assert.match(sent.text, /Member: add a cart/);
  assert.equal(memory.outbox.files().length, 0);
});

test('retain failure waits in the outbox; a refused (409) body is quarantined', async () => {
  let status = 503;
  const studio = studioStub({ brief: () => ({ ok: true, status: 200, body: { protocol_version: 3, text: 't' } }), retain: () => ({ ok: false, status }), git: () => ({ ok: true, status: 200,
    body: {} }) });
  const memory = make(studio); await memory.brief('x');
  await memory.afterRound([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], {});
  assert.equal(memory.outbox.files().length, 1);
  status = 409; await memory.drain();
  assert.equal(memory.outbox.files().length, 0); assert.equal(memory.outbox.quarantined, 1);
});

test('the outbox is scoped by Studio, epoch and key', () => {
  assert.notEqual(scopeID(scope), scopeID({ ...scope, key_id: '00000000-0000-4000-8000-000000000002' }));
  assert.equal(scopeID({}), null);
  assert.equal(new MemoryOutbox(os.tmpdir(), {}).directory, null);
});

test('turnRecord keeps secrets out and stays within the byte budget', () => {
  const text = turnRecord([{ role: 'user', content: 'use key as_run_00000000-0000-4000-8000-0000000000a1_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq' }, { role: 'assistant',
    content: 'x'.repeat(100000) }], ['a'], []);
  assert.doesNotMatch(text, /as_run_/); assert.ok(Buffer.byteLength(text) <= 30 * 1024);
  assert.equal(turnRecord([], [], []), '');
});

// --- lessons come only from evidence ---
const run = (lessons, events) => { for (const e of events) lessons.event(e); return lessons; };
const start = (id, tool, args) => ({ type: 'tool_execution_start', toolCallId: id, toolName: tool, args });
const end = (id, tool, isError, text) => ({ type: 'tool_execution_end', toolCallId: id, toolName: tool, isError, result: { content: [{ type: 'text', text }], details: isError
  ? { exitCode: 1 } : { exitCode: 0 } } });

test('lessons: a check that failed, an edit, then passed becomes a recovery lesson built from tool evidence only', () => {
  const l = run(new CheckLessons(['npm test']), [start('1', 'bash', { command: 'npm test' }), end('1', 'bash', true, 'AssertionError: expected 1 to be 2'),
    start('2', 'edit', { path: 'src/a.js' }), end('2', 'edit', false, 'ok'), start('3', 'bash', { command: 'npm test' }), end('3', 'bash', false, '# pass 4\n# fail 0')]);
  assert.equal(l.lessons.length, 1);
  assert.equal(l.lessons[0].kind, 'check_recovery');
  assert.match(l.lessons[0].line, /Root cause not established/);
  assert.match(l.lessons[0].line, /edited src\/a\.js/);
  assert.deepEqual(l.summary, { passed: 1, failed: 1, final: 'passed' });
});

test('lessons: a rerun that passes without any change is flaky, not a fix', () => {
  const l = run(new CheckLessons(['npm test']), [start('1', 'bash', { command: 'npm test' }), end('1', 'bash', true, 'FAIL x'), start('2', 'bash', { command: 'npm test' }), end('2', 'bash',
    false, '# pass 4\n# fail 0')]);
  assert.equal(l.lessons.length, 0);
});

test('lessons: a filtered run or version probe is no check, so it teaches nothing', () => {
  const l = run(new CheckLessons([]), [start('1', 'bash', { command: 'pytest -k x' }), end('1', 'bash', true, 'FAIL'), start('2', 'edit', { path: 'a.py' }), end('2', 'edit', false, 'ok'),
    start('3', 'bash', { command: 'pytest -k x' }), end('3', 'bash', false, '1 passed')]);
  assert.equal(l.lessons.length, 0); assert.equal(l.summary.final, 'none');
});

test('lessons: the same non-check command failing the same way twice is a tool_error lesson, without a guessed cause', () => {
  const l = run(new CheckLessons([]), [start('1', 'bash', { command: 'curl service-a' }), end('1', 'bash', true, 'curl: (7) Failed to connect: connection refused'),
    start('2', 'bash', { command: 'curl service-a' }), end('2', 'bash', true, 'curl: (7) Failed to connect: connection refused')]);
  assert.equal(l.lessons.length, 1); assert.equal(l.lessons[0].kind, 'tool_error'); assert.match(l.lessons[0].line, /Cause not established/);
});

test('PROTOCOL is 3', () => assert.equal(PROTOCOL, 3));
