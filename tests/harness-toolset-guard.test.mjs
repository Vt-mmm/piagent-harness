import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolsetGuard, checkToolset, CORE_TOOLS, BLOCK_REASON } from '../src/guard.mjs';
import { CHANNELS } from '../src/bus.mjs';
import { fakeBus } from './helpers.mjs';

const SANDBOX = 'piagent-sandbox', ENTRY = '/pkgs/piagent-sandbox/src/index.mjs';
const tools = (overrides = {}) => CORE_TOOLS.map(name => ({ name, sourceInfo: overrides[name] ?? { path: ENTRY, source: 'cli', scope: 'temporary', origin: 'top-level' } }));
const attest = events => events.emit(CHANNELS.toolsAttest, { v: 1, tools: CORE_TOOLS.map(name => ({ name, source: SANDBOX })) });

test('seven core tools, all from the sandbox: allowed', async () => {
  const events = fakeBus(); const guard = new ToolsetGuard({ events, getTools: () => tools() }); guard.start(); attest(events);
  assert.equal((await guard.verify()).ok, true); assert.equal(guard.onToolCall(), undefined);
  assert.deepEqual(CORE_TOOLS, ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls']);
});

test('a fake extension registering bash: every tool call is blocked and Studio is told', async () => {
  const events = fakeBus(), reports = [];
  const fake = tools({ bash: { path: '/evil/fake-extension.mjs', source: 'fake', scope: 'project', origin: 'top-level' } });
  const guard = new ToolsetGuard({ events, getTools: () => fake, report: async bad => reports.push(bad) }); guard.start(); attest(events);
  const result = await guard.verify();
  assert.equal(result.ok, false); assert.deepEqual(result.bad, [{ name: 'bash', found: 'fake-extension.mjs' }]);
  assert.deepEqual(guard.onToolCall(), { block: true, reason: BLOCK_REASON });
  assert.equal(reports.length, 1); assert.equal(reports[0][0].name, 'bash');
  await guard.verify(); assert.equal(reports.length, 1, 'Studio is told once');
  assert.equal(events.log.some(([c]) => c === CHANNELS.toolsBlocked), true);
});

test('Pi\'s own built-in tool (no sandbox loaded) is blocked too', async () => {
  const events = fakeBus(); const builtin = tools(Object.fromEntries(CORE_TOOLS.map(n => [n, { path: `builtin:${n}`, source: 'builtin', scope: 'user', origin: 'top-level' }])));
  const guard = new ToolsetGuard({ events, getTools: () => builtin }); guard.start(); attest(events);
  assert.equal((await guard.verify()).bad.length, 7);
});

test('a missing tool, or a sandbox that never attested, blocks', () => {
  const attested = new Map(CORE_TOOLS.map(n => [n, SANDBOX]));
  assert.deepEqual(checkToolset(tools().filter(t => t.name !== 'ls'), attested).bad, [{ name: 'ls', found: 'missing' }]);
  assert.equal(checkToolset(tools(), new Map()).bad.length, 7);
});

test('the check runs again when a tool is registered late', async () => {
  const events = fakeBus(); let current = tools(); const guard = new ToolsetGuard({ events, getTools: () => current }); guard.start(); attest(events);
  assert.equal((await guard.verify()).ok, true);
  current = tools({ write: { path: '/late/ext.mjs', source: 'late' } });
  assert.equal((await guard.verify()).ok, false); assert.ok(guard.onToolCall().block);
});

test('a look-alike folder or a mix of sources is not the sandbox', async () => {
  const events = fakeBus(); attest(events);
  assert.equal(checkToolset(tools({ bash: { path: '/evil/piagent-sandbox-fake/index.mjs', source: 'cli' } }), new Map(CORE_TOOLS.map(n => [n, SANDBOX]))).ok, false);
  const mixed = tools({ bash: { path: '/other/piagent-sandbox/src/index.mjs', source: 'cli' } });
  assert.deepEqual(checkToolset(mixed, new Map(CORE_TOOLS.map(n => [n, SANDBOX]))).bad, [{ name: 'toolset', found: 'mixed-sources' }]);
  assert.equal(checkToolset(tools({ read: { path: 'builtin:read', source: 'builtin' } }), new Map(CORE_TOOLS.map(n => [n, SANDBOX]))).bad[0].name, 'read');
});
