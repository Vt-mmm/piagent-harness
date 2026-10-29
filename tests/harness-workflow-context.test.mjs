import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentWorkflow, updateWorkflow, workflowContextTool, workflowContextPrompt, helperWorkflowPrompt, WORKFLOW_ENTRY } from '../src/workflow-context.mjs';
import { discoverDeliveryContext, deliveryPrompt } from '../src/delivery-context.mjs';
import { request, serve, CHANNELS } from '../src/bus.mjs';
import { StudioClient } from '../src/studio.mjs';
import { fakeBus } from './helpers.mjs';

const selection = { task: 'cart', method: 'spec-kit', basis: 'member', evidence: 'the member said so', sources: [{ purpose: 'plan', scope: 'cart', ref: 'specs/cart/plan.md' }] };
const manager = () => { const entries = []; return { entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }; };

test('workflow context: adopt with the expected revision, refuse a stale one, clear', () => {
  const m = manager();
  assert.deepEqual(currentWorkflow(m), { revision: 0, selection: null });
  updateWorkflow(m, { action: 'adopt', expectedRevision: 0, reason: 'member chose', selection });
  assert.equal(currentWorkflow(m).revision, 1); assert.equal(currentWorkflow(m).selection.method, 'spec-kit');
  assert.throws(() => updateWorkflow(m, { action: 'adopt', expectedRevision: 0, reason: 'r', selection }), /managed-workflow-context-stale/);
  updateWorkflow(m, { action: 'clear', expectedRevision: 1, reason: 'switched' });
  assert.equal(currentWorkflow(m).selection, null); assert.equal(currentWorkflow(m.getEntries()).revision, 2, 'readable from a plain entry list too');
  assert.throws(() => updateWorkflow(m, { action: 'adopt', expectedRevision: 2, reason: 'r', selection: { ...selection, basis: 'guess' } }), /basis/);
  assert.match(m.entries[0].customType, new RegExp(WORKFLOW_ENTRY));
});
test('workflow context tool and prompts', async () => {
  const m = manager(), tool = workflowContextTool(() => m);
  const out = await tool.execute('1', { action: 'adopt', expectedRevision: 0, reason: 'r', selection });
  assert.match(out.content[0].text, /not approval/);
  assert.match(workflowContextPrompt(currentWorkflow(m)), /Developer-owned working method/);
  assert.equal(helperWorkflowPrompt({ selection: null }), ''); assert.match(helperWorkflowPrompt(currentWorkflow(m)), /Working-method context/);
});
test('delivery discovery reads the folder only, never follows links, and is bounded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-del-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '1', express: '1' } }));
  fs.mkdirSync(path.join(dir, 'migrations')); fs.symlinkSync('/etc', path.join(dir, 'backend'));
  const ctx = discoverDeliveryContext(dir);
  assert.deepEqual(ctx.units[0].surfaces, ['backend', 'frontend']); assert.ok(ctx.units[0].capabilities.includes('database'));
  assert.equal(ctx.units.some(u => u.path === 'backend'), false, 'a symlink is not entered');
  assert.match(deliveryPrompt(ctx), /Adaptive delivery lifecycle/);
});

test('bus: a request gets its reply; no answer falls back after the timeout; the first reply wins', async () => {
  const events = fakeBus();
  serve(events, 'x', async d => ({ ok: true, got: d.n }));
  assert.deepEqual(await request(events, 'x', { n: 2 }), { ok: true, got: 2 });
  assert.deepEqual(await request(events, 'nobody', {}, { timeoutMs: 10 }), { ok: false, error: 'no-answer' });
  serve(events, 'boom', () => { throw Error('bad'); });
  assert.deepEqual(await request(events, 'boom', {}), { ok: false, error: 'bad' });
  assert.equal(events.log[0][1].v, 1, 'every payload carries v');
});
test('Studio client goes through the provider and never sees a token', async () => {
  const events = fakeBus(); let seen;
  events.on(CHANNELS.studioCall, d => { seen = d; d.reply({ ok: true, status: 200, body: '{"a":1}' }); });
  const studio = new StudioClient(events); studio.setState({ capabilities: ['memory'] });
  assert.deepEqual(await studio.fetch('/v1/memory/brief', { body: { q: 1 }, role: 'review' }), { ok: true, status: 200, body: { a: 1 }, error: undefined });
  assert.deepEqual([seen.role, seen.path, seen.method], ['review', '/v1/memory/brief', 'POST']); assert.equal(JSON.stringify(seen).includes('token'), false);
  assert.equal(studio.has('memory'), true); assert.equal(studio.has('x'), false);
});
