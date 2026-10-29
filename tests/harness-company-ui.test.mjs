import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { headerLines, footerText, installCompanyUi, registerStyleCommand, styleChoices, readStyle } from '../src/ui.mjs';
import { StatusFile } from '../src/status-file.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ui-'));

test('header: team, main and review roles, mode, team memory, bundle version', () => {
  const [a, b] = headerLines({ team: 'Payments', mode: 'full', memory: true, bundle: '2.0.0', main: 'Main agent • Rất cao', review: 'Review • Cao' });
  assert.equal(a, 'Piagent công ty · team Payments · bộ 2.0.0');
  assert.equal(b, 'Main: Main agent • Rất cao · Review: Review • Cao · Full access · Team memory: bật');
  assert.match(headerLines({ mode: 'bypass', fast: true })[1], /Bypass · Fast · Team memory: tắt/);
});

test('footer never shows a cost in USD', () => {
  const text = footerText({ main: 'Main agent', effort: 'Rất cao', usage: { tokens: 45_000, contextWindow: 200_000 }, helpers: { running: 1, total: 3 }, branch: 'feat/x', cost: 12.5, usd: 3 });
  assert.equal(text, 'Main agent • Rất cao  45k/200k (23%)  Subagent 1/3  ⎇ feat/x');
  assert.doesNotMatch(text, /\$|USD|cost/i);
});

test('only the interactive TUI gets the header and footer', () => {
  const set = [];
  const ui = { setHeader: f => set.push('header'), setFooter: f => set.push('footer') };
  assert.equal(installCompanyUi({ hasUI: true, mode: 'print', ui }, () => ({})), null);
  assert.equal(installCompanyUi({ hasUI: false, mode: 'tui', ui }, () => ({})), null);
  assert.deepEqual(set, []);
  assert.ok(installCompanyUi({ hasUI: true, mode: 'tui', ui }, () => ({}))); assert.deepEqual(set, ['header', 'footer']);
});

test('the footer component renders the same text', () => {
  let footer; const ctx = { hasUI: true, mode: 'tui', ui: { setHeader() {}, setFooter: f => { footer = f({ requestRender() {} }); } } };
  installCompanyUi(ctx, () => ({ main: 'Main', usage: { tokens: 10, contextWindow: 100 } }));
  assert.deepEqual(footer.render(), ['Main  10/100 (10%)']);
});

test('/style lists, applies at once and keeps the choice for the next conversation', async () => {
  const handlers = {}, commands = {}, dir = tmp();
  const pi = { on: (e, f) => { handlers[e] = f; }, registerCommand: (n, o) => { commands[n] = o; } };
  registerStyleCommand(pi, { stateDir: dir });
  const themes = [{ name: 'piagent-ocean' }, { name: 'piagent-paper' }], applied = [], notes = [];
  const ui = { getAllThemes: () => themes, setTheme: n => { applied.push(n); return { success: true }; }, notify: (m, t) => notes.push([m, t]), select: async (_t,
    items) => items.find(i => i.startsWith('piagent-paper')), theme: { name: 'dark' } };
  assert.deepEqual(styleChoices(ui).map(c => c.name), ['system', 'dark', 'light', 'piagent-ocean', 'piagent-paper']);
  await commands.style.handler('piagent-ocean', { ui });
  await commands.style.handler('', { ui });
  await commands.style.handler('nope', { ui });
  assert.deepEqual(applied, ['piagent-ocean', 'piagent-paper']);
  assert.equal(readStyle(dir), 'piagent-paper'); assert.equal(notes.at(-1)[1], 'warning');
  applied.length = 0; await handlers.session_start({}, { hasUI: true, ui });
  assert.deepEqual(applied, ['piagent-paper'], 'put back when a conversation opens');
});

// --- the state file Agent Watch reads (PiagentStatus.swift) ---
test('status file: the old format, one file per conversation, only title and project name', () => {
  const dir = tmp(); let t = 0; const file = new StatusFile({ conversation: 'conv-1', title: 'Fix cart', project: 'shop', dir, now: () => new Date(Date.UTC(2026, 9, 29, 10, 0, t++)) });
  file.set('working', { helpers: 2 });
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'conv-1.json'), 'utf8'));
  assert.deepEqual(Object.keys(body), ['conversation', 'title', 'project', 'company', 'state', 'helpers', 'since', 'updated_at']);
  assert.deepEqual([body.company, body.state, body.helpers, body.project], [true, 'working', 2, 'shop']);
  const since = body.since; file.set('working', { helpers: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'conv-1.json'), 'utf8')).since, since, '"since" moves only when the state changes');
  file.set('blocked', { kind: 'question' }); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'conv-1.json'), 'utf8')).kind, 'question');
  file.set('done', { ended: 'stopped' }); const done = JSON.parse(fs.readFileSync(path.join(dir, 'conv-1.json'), 'utf8'));
  assert.deepEqual([done.state, done.ended, done.kind], ['done', 'stopped', undefined]);
  assert.ok(fs.statSync(path.join(dir, 'conv-1.json')).size < 16_384);
  assert.deepEqual(fs.readdirSync(dir), ['conv-1.json'], 'no temp file left');
  assert.throws(() => file.set('sleeping'), /status-state-invalid/);
  file.remove(); assert.deepEqual(fs.readdirSync(dir), []);
});

test('status file name cannot escape the folder', () => {
  const dir = tmp(); new StatusFile({ conversation: '../../etc/x', dir }).set('idle');
  assert.deepEqual(fs.readdirSync(dir), ['______etc_x.json']);
});
