import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolFailureLog, toolFailure, toolFailureCode } from '../src/tool-failures.mjs';
import { SkillFeedback } from '../src/skill-feedback.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const text = t => [{ type: 'text', text: t }];
test('failure codes', () => {
  assert.equal(toolFailureCode('managed-domain-blocked: x'), 'managed_domain_blocked');
  assert.equal(toolFailureCode('boom\n\nCommand exited with code 2'), 'exit_2');
  assert.equal(toolFailureCode('Command timed out after 600 seconds'), 'timeout');
  assert.equal(toolFailureCode('whatever'), 'error');
});
test('the home folder and secrets never leave; a long error keeps head and tail', () => {
  const f = toolFailure({ tool: 'bash', role: 'main', input: { command: 'cat /Users/me/x' }, content: text(`/Users/me/a
as_run_00000000-0000-4000-8000-0000000000a1_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq ${'e'.repeat(5000)}END`), startedAt: 1, endedAt: 5, home: '/Users/me' });
  assert.equal(f.input, 'cat'); assert.doesNotMatch(f.error, /as_run_|\/Users\/me/); assert.match(f.error, /characters left out/); assert.match(f.error, /END$/);
  assert.equal(f.duration_ms, 4);
  assert.equal(toolFailure({ tool: 'bash', role: 'main', content: text('x\nCommand aborted'), endedAt: 1 }), null, 'the member stopping it is no failure');
});
test('failed calls are sent to Studio with their age; 404 turns the log off; others are retried at most 3 times', async () => {
  const calls = []; let status = 200;
  const studio = { fetch: async (p, o) => { calls.push({ p, o }); return { ok: status === 200, status }; } };
  let t = 1000; const log = new ToolFailureLog(studio, { now: () => t });
  log.start({ toolCallId: '1' }); t = 1200;
  log.end({ toolCallId: '1', toolName: 'bash', isError: true, input: { command: 'npm test' }, content: text('FAIL\nCommand exited with code 1') });
  await log.sending;
  assert.equal(calls[0].p, '/studio/v1/managed/tool-failures');
  assert.deepEqual([calls[0].o.body.failures[0].code, calls[0].o.body.failures[0].tool, calls[0].o.body.failures[0].age_ms], ['exit_1', 'bash', 0]);
  log.end({ toolCallId: '2', toolName: 'bash', isError: false, content: text('ok') }); assert.equal(calls.length, 1, 'a success is not logged');
  status = 503; for (let i = 0; i < 5; i += 1) { log.end({ toolCallId: `r${i}`, toolName: 'read', isError: true, content: text('nope') }); await log.sending; await log.send(); await log.sending; }
  assert.ok(log.queue.length <= 100);
  status = 404; log.queue.push({ id: 'x', tool: 'bash', role: 'main', code: 'error', at: 0, error: 'e', duration_ms: 0, engine: 'none' }); await log.send();
  assert.equal(log.off, true);
});

test('skill feedback proposes a review file after repeated bad rounds, never edits the skill', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skill-')), file = path.join(cwd, 'SKILL.md'); fs.writeFileSync(file, 'x');
  const mk = () => { const f = new SkillFeedback({ cwd, skills: [{ name: 'deploy', filePath: file }] }); f.event({ type: 'tool_execution_start', toolName: 'read',
    args: { path: 'SKILL.md' } }); return f; };
  assert.deepEqual(mk().close({ checks: 'passed' }), []);
  mk().close({ checks: 'failed' }); mk().close({ checks: 'failed' });
  const written = mk().close({ checks: 'failed' });
  assert.equal(written.length, 1); assert.match(fs.readFileSync(written[0], 'utf8'), /Nothing was changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  assert.match(written[0], /\.pi\/piagent-state\/skill-proposals\/deploy\.md$/);
});
