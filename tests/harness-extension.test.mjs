import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import piagentHarness from '../src/index.mjs';
import { CHANNELS } from '../src/bus.mjs';
import { fakePi } from './helpers.mjs';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ext-')), git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Checks\n- `npm test`\n'); fs.writeFileSync(path.join(dir, 'app.js'), 'let a = 1;\n');
  git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}
async function boot(workflow = { plan: 'off', verify: 'require', review: 'off' }, extra = {}) {
  const dir = project(), pi = fakePi(); pi.ctx.cwd = dir;
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-aside-'));  // outside the project, as in real use
  piagentHarness(pi, { cwd: dir, stateDir: path.join(aside, 'state'), statusDir: path.join(aside, 'status'), styleDir: path.join(aside, 'style') });
  pi.aside = aside; pi.attest();
  pi.events.emit(CHANNELS.runState, { v: 1, runId: 'r1', harness: { thinking: {}, bypassMode: false, helperCalls: [], protocol: 3, workflow, ...extra }, capabilities: [] });
  await pi.fire('session_start', { reason: 'startup' });
  return { pi, dir, aside: pi.aside };
}
const user = (pi, prompt = 'change app.js') => pi.fire('before_agent_start', { messageType: 'user', prompt, systemPrompt: 'BASE' });
const editApp = async (pi, dir, body) => { fs.writeFileSync(path.join(dir, 'app.js'), body); await pi.fire('tool_result', { toolName: 'edit', toolCallId: `e${Math.random()}`,
  input: { path: 'app.js' }, isError: false, content: [{ type: 'text', text: 'ok' }] }); };
const bashResult = (pi, command, text, isError = false) => pi.fire('tool_result', { toolName: 'bash', toolCallId: `b${Math.random()}`, input: { command }, isError, content: [{ type: 'text',
  text }] });

test('registers the tools of the company and /style', async () => {
  const { pi } = await boot();
  for (const name of ['update_plan', 'ask_user', 'resolve_objection', 'workflow_context']) assert.ok(pi.tools[name], name);
  assert.ok(pi.commands.style);
});

test('the system prompt gets the process, with the checks from AGENTS.md', async () => {
  const { pi } = await boot();
  const out = await user(pi);
  assert.match(out.systemPrompt, /^BASE/); assert.match(out.systemPrompt, /Repository checks: `npm test`\./); assert.match(out.systemPrompt, /does not end until a check has passed/);
});

test('whole round: edit without a check is sent back; a passing check ends it; the report goes out', async () => {
  const { pi, dir } = await boot();
  await user(pi); await editApp(pi, dir, 'let a = 2;\n');
  const first = await pi.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(first.continue, true); assert.match(first.entries[0].content, /no check has passed/);
  await bashResult(pi, 'npm test | tail -5', '# pass 3\n# fail 0');
  const second = await pi.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(second.continue, false);
  assert.match(second.entries.at(-1).content, /Done\.|Process status/);
  const report = pi.events.log.find(([c]) => c === CHANNELS.runProcess)[1].process;
  assert.equal(report.version, 3); assert.equal(report.verified, true); assert.equal(report.checks, 1); assert.equal(report.outcome, 'clean');
});

test('piped check with failing output is not verified', async () => {
  const { pi, dir } = await boot();
  await user(pi); await editApp(pi, dir, 'let a = 3;\n'); await bashResult(pi, 'npm test | tail -5', '# pass 2\n# fail 1');
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).continue, true);
});

test('the gate resets only when before_agent_start is a member\'s message', async () => {
  const { pi, dir } = await boot();
  await user(pi); await editApp(pi, dir, 'let a = 4;\n');
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).continue, true);      // verify loop 1
  await pi.fire('before_agent_start', { messageType: 'custom', systemPrompt: 'BASE' });              // the gate's own send-back / auto-retry
  await pi.fire('before_agent_start', { messageType: 'custom', systemPrompt: 'BASE' });
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).continue, true);      // verify loop 2 (not reset to 1)
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).continue, false);     // spent: loops=2 by default
  await user(pi, 'next');                                                                              // a member's message: reset
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).entries.length, 0);
});

test('a turn the member stopped is not sent back', async () => {
  const { pi, dir } = await boot();
  await user(pi); await editApp(pi, dir, 'let a = 5;\n');
  const out = await pi.fire('agent_before_settle', { outcome: 'aborted' });
  assert.equal(out.continue, false);
  assert.equal(pi.entries.find(e => e.customType === 'agent-watch-turn-end').data.state, 'cancelled');
  const notes = []; pi.ctx.ui.notify = (m, t) => notes.push(m); await pi.fire('agent_settled', { aborted: true });
  assert.deepEqual(notes, ['Turn stopped by the member.']);
});

test('plan "require": a complex run with an open checklist gets the next round and the checklist rounds stop after 2 idle', async () => {
  const { pi, dir } = await boot({ plan: 'require', verify: 'off', review: 'off' });
  await user(pi);
  await pi.tools.update_plan.execute('p', { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }, { step: 'c', status: 'pending' }] });
  const r1 = await pi.fire('agent_before_settle', { outcome: 'completed' });
  assert.equal(r1.continue, true); assert.equal(r1.entries.at(-1).details.phase, 'continue');
  const r2 = await pi.fire('agent_before_settle', { outcome: 'completed' }); assert.equal(r2.continue, true);   // idle 1
  const r3 = await pi.fire('agent_before_settle', { outcome: 'completed' }); assert.equal(r3.continue, false);  // idle 2: stop
  const end = pi.entries.find(e => e.customType === 'agent-watch-turn-end').data;
  assert.deepEqual([end.state, end.reason, end.planSteps, end.planDone], ['midway', 'idle', 3, 1]);
  const notes = []; pi.ctx.ui.notify = m => notes.push(m); await pi.fire('agent_settled', { aborted: false });
  assert.match(notes[0], /2 times in a row without progress/);
});

test('tool calls are blocked when the toolset is not the sandbox\'s', async () => {
  const { pi } = await boot();
  assert.equal(await pi.fire('tool_call', { toolName: 'read', toolCallId: 'x', input: {} }), undefined);
  pi.getAllTools = () => [{ name: 'bash', sourceInfo: { path: '/evil/ext.mjs' } }];
  await pi.fire('before_agent_start', { messageType: 'custom', systemPrompt: '' });
  const blocked = await pi.fire('tool_call', { toolName: 'read', toolCallId: 'y', input: {} });
  assert.equal(blocked.block, true); assert.match(blocked.reason, /managed-toolset-untrusted/);
});

test('compaction: asked at 90% of the window, with the plan in the instructions; a failed one backs off', async () => {
  const { pi } = await boot();
  await pi.tools.update_plan.execute('p', { plan: [{ step: 'migrate', status: 'in_progress' }] });
  pi.ctx.usage = { tokens: 100_000, contextWindow: 200_000 }; await pi.fire('turn_end', {}); assert.equal(pi.ctx.compactCalls.length, 0);
  pi.ctx.usage = { tokens: 181_000, contextWindow: 200_000 }; await pi.fire('turn_end', {}); assert.equal(pi.ctx.compactCalls.length, 1);
  assert.match(pi.ctx.compactCalls[0].customInstructions, /\[>\] migrate/);
  await pi.fire('turn_end', {}); assert.equal(pi.ctx.compactCalls.length, 1, 'one at a time');
  pi.ctx.usage = { tokens: 350_000, contextWindow: 1_000_000 };
  await pi.fire('session_compact_failed', { aborted: false }); await pi.fire('turn_end', {}); assert.equal(pi.ctx.compactCalls.length, 1, 'backed off');
  await pi.fire('session_compact', {});
  const kept = pi.messages.find(([m]) => m.customType === 'agent-watch-plan-kept');
  assert.match(kept[0].content, /\[in_progress\] migrate/);
  await pi.fire('turn_end', {}); assert.equal(pi.ctx.compactCalls.length, 2, 'past 300k in a 1M window');
});

test('the status file follows the run: working, then done; removed at shutdown', async () => {
  const { pi, aside } = await boot();
  const read = () => JSON.parse(fs.readFileSync(path.join(aside, 'status', 'conv-1.json'), 'utf8'));
  assert.equal(read().state, 'idle');
  await user(pi); assert.equal(read().state, 'working');
  await pi.fire('agent_before_settle', { outcome: 'completed' }); await pi.fire('agent_settled', { aborted: false });
  assert.deepEqual([read().state, read().ended], ['done', 'done']); assert.equal(read().title, 'Fix cart');
  await pi.fire('ui_prompt_start', { kind: 'select' }); assert.deepEqual([read().state, read().kind], ['blocked', 'permission']);
  await pi.fire('ui_prompt_end', {});
  const asking = pi.tools.ask_user.execute('q', { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] }, undefined, undefined,
    { hasUI: true, ui: { select: async (_t, items) => { await pi.fire('ui_prompt_start', { kind: 'select' }); return items[0]; } } });
  await asking; assert.deepEqual([read().state, read().kind], ['blocked', 'question']);
  await pi.fire('session_shutdown', {}); assert.equal(fs.existsSync(path.join(aside, 'status', 'conv-1.json')), false);
});

test('the delegate tool appears once Studio says which helpers the Harness has', async () => {
  const { pi } = await boot();
  assert.equal(pi.tools.delegate, undefined);
  pi.events.emit(CHANNELS.runState, { v: 1, runId: 'r1', harness: { thinking: {}, bypassMode: false, helperCalls: ['scout', 'review'], helperLimit: 5, protocol: 3,
    workflow: { verify: 'require' } } });
  assert.ok(pi.tools.delegate); assert.match(pi.tools.delegate.description, /up to 5 times per user message/);
  assert.deepEqual(pi.tools.delegate.parameters.properties.role.enum, ['scout', 'research', 'verify', 'review']);
});

test('without run state from the provider the harness adds no process', async () => {
  const dir = project(), pi = fakePi(); pi.ctx.cwd = dir;
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-aside-'));
  piagentHarness(pi, { cwd: dir, stateDir: aside, statusDir: aside, styleDir: aside });
  pi.attest(); await pi.fire('session_start', {});
  const out = await user(pi);
  assert.doesNotMatch(out.systemPrompt, /Process for code changes/);
  fs.writeFileSync(path.join(dir, 'app.js'), 'x'); await pi.fire('tool_result', { toolName: 'edit', toolCallId: 'e', input: { path: 'app.js' }, isError: false, content: [] });
  assert.equal((await pi.fire('agent_before_settle', { outcome: 'completed' })).continue, false);
});

test('run.state as the provider sends it today (roles in helperCalls, protocol as a number) and with the fields the harness asks to add', async () => {
  const { normalizeRunState } = await import('../src/index.mjs');
  const today = { v: 1, runId: 'r1', harness: { thinking: { allowed: ['low'], effort: 'low' }, bypassMode: false, helperCalls: ['scout', 'review'], protocol: 3 } };
  const state = normalizeRunState(today);
  assert.deepEqual([state.roles, state.protocol, state.helperLimit], [['scout', 'review'], 3, undefined]);
  assert.equal(normalizeRunState({ v: 1, harness: { helperCalls: 5 } }).helperLimit, 5);
  const richer = normalizeRunState({ v: 1, capabilities: ['memory'], scope: { key_id: 'k' }, harness: { helperCalls: ['review'], helperLimit: 4, workflow: { review: 'require' } } }, state);
  assert.deepEqual([richer.helperLimit, richer.workflow.review, richer.capabilities], [4, 'require', ['memory']]);
  assert.deepEqual(normalizeRunState({ v: 1, harness: {} }, state).roles, ['scout', 'review'], 'a state without roles keeps those it knew');
});

test('the sandbox loads after the harness: its attestation at session_start is not missed, nothing is blocked or reported', async () => {
  const dir = project(), pi = fakePi(); pi.ctx.cwd = dir;
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-aside-'));
  const blocked = [], calls = [];
  piagentHarness(pi, { cwd: dir, stateDir: aside, statusDir: aside, styleDir: aside });
  pi.events.on(CHANNELS.toolsBlocked, d => blocked.push(d));
  pi.events.on(CHANNELS.studioCall, d => { calls.push(d); d.reply({ ok: true, status: 200 }); });
  await pi.fire('session_start', { reason: 'startup' });   // harness handler first: no attestation yet
  pi.attest();                                             // then the sandbox's session_start handler
  await user(pi);
  assert.equal(await pi.fire('tool_call', { toolName: 'read', toolCallId: 't1', input: { path: 'app.js' } }), undefined);
  assert.deepEqual(blocked, []); assert.deepEqual(calls, []);
});

test('no attestation at all (sandbox not loaded): the first run is blocked and Studio is told once', async () => {
  const dir = project(), pi = fakePi(); pi.ctx.cwd = dir;
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-aside-'));
  const calls = [];
  piagentHarness(pi, { cwd: dir, stateDir: aside, statusDir: aside, styleDir: aside });
  pi.events.on(CHANNELS.studioCall, d => { calls.push(d); d.reply({ ok: true, status: 200 }); });
  await pi.fire('session_start', {}); await user(pi);
  const out = await pi.fire('tool_call', { toolName: 'read', toolCallId: 't1', input: {} });
  assert.equal(out?.block, true);
  assert.equal(calls.filter(c => c.path === '/studio/v1/managed/tool-failures').length, 1);
});
