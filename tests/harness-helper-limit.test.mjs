import test from 'node:test';
import assert from 'node:assert/strict';
import { helperCallLimit, DEFAULT_HELPER_CALLS, helperRoles, HELPER_SETUP, delegateDescription, READ_TOOLS, mainWebLookups, limitedWebTools } from '../src/helper-roles.mjs';
import { runHelper } from '../src/helper-run.mjs';
import { delegateParameters, specOf, briefWithSpec } from '../src/helper-settlement.mjs';
import { fanOut, namedCount, mergeCopies, MAX_COPIES } from '../src/copies.mjs';
import { helperHost } from './helpers.mjs';

test('the helper call limit comes from Studio; without the field it is the old 8', () => {
  assert.equal(DEFAULT_HELPER_CALLS, 8);
  assert.equal(helperCallLimit({}), 8);
  assert.equal(helperCallLimit(null), 8);
  assert.equal(helperCallLimit({ helperCalls: 3 }), 3);
  assert.equal(helperCallLimit({ helperCalls: 0 }), 8);
  assert.equal(helperCallLimit({ helperCalls: 'x' }), 8);
  assert.match(delegateDescription(['scout'], 5), /up to 5 times per user message/);
});

test('a role runs at most the limit per message, then refuses', async () => {
  const h = helperHost({ helperCalls: 2, script: { answer: { submit: { brief_issues: [], summary: 's' } } } });
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  await assert.rejects(runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false), /managed-helper-limit: the scout helper already ran 2 times/);
  await runHelper(h, 'research', { role: 'research', task: 't' }, undefined, false); // another role has its own count
});

test('with no helperCalls from Studio the 9th call is refused', async () => {
  const h = helperHost({ script: { answer: { submit: { brief_issues: [], summary: 's' } } } });
  for (let i = 0; i < 8; i += 1) await runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false);
  await assert.rejects(runHelper(h, 'scout', { role: 'scout', task: 't' }, undefined, false), /ran 8 times/);
});

test('four roles, each with its own tools: scout reads, research reads the web, verify runs checks, review reads', () => {
  assert.deepEqual(helperRoles({ roles: ['review', 'scout', 'bogus'] }), ['scout', 'review']);
  assert.deepEqual(READ_TOOLS, ['read', 'grep', 'find', 'ls']);
  const { scout, research, verify, review } = HELPER_SETUP;
  assert.deepEqual([scout.web, scout.commands], [false, false]);
  assert.deepEqual([research.web, research.commands], [true, false]);
  assert.deepEqual([verify.web, verify.commands], [true, true]);
  assert.deepEqual([review.web, review.commands], [false, false]);
  assert.deepEqual([scout.result, research.result, verify.result, review.result], ['submit_brief_check', 'submit_brief_check', 'submit_verdicts', 'submit_review']);
  assert.match(scout.prompt, /file:line/);
});

test('delegate carries optional target, change, constraints, ownership, acceptance at the head of the brief', () => {
  const props = delegateParameters().properties;
  for (const k of ['target', 'change', 'constraints', 'ownership', 'acceptance']) assert.equal(props[k].type, 'string');
  assert.deepEqual(delegateParameters().required, ['role', 'task']);
  const args = { role: 'scout', task: 'find it', target: ' src/ ', acceptance: 'file:line' }, spec = specOf(args);
  assert.equal(briefWithSpec(args, spec), 'Target: src/\nAcceptance: file:line\n\nfind it');
  assert.equal(briefWithSpec({ task: 'x' }, {}), 'x');
});

test('web lookups of the main agent are capped by the Harness', async () => {
  assert.equal(mainWebLookups({ workflow: { main_web_lookups: 2 } }), 2);
  assert.equal(mainWebLookups({ workflow: { main_web_lookups: 9 } }), 0);
  const run = { webLookups: 0 }, [tool] = limitedWebTools([{ name: 'web_search', execute: async () => 'ok' }], () => run, 1);
  assert.equal(await tool.execute(), 'ok');
  await assert.rejects(tool.execute(), /managed-web-lookups-spent/);
});

test('copies only at the member\'s word: otherwise one helper runs and the agent is told why', () => {
  const entries = [{ type: 'message', message: { role: 'user', content: 'dùng 3 reviewer cho patch này' } }];
  assert.equal(namedCount('dùng 3 reviewer'), 3); assert.equal(namedCount('use two helpers'), 2);
  assert.equal(fanOut(entries, 'review', { role: 'review', task: 't' }, false), null);
  assert.deepEqual(fanOut(entries, 'review', { role: 'review', task: 't', copies: 3, member_words: 'dùng 3 reviewer' }, false), { n: 3, split: null });
  assert.deepEqual(fanOut(entries, 'review', { role: 'review', task: 't', copies: 3, member_words: 'tôi muốn 3 thứ' }, false), { dropped: 3 });
  assert.deepEqual(fanOut(entries, 'review', { role: 'review', task: 't', copies: 2 }, false), { dropped: 2 });
  assert.throws(() => fanOut(entries, 'review', { copies: 2 }, true), /one helper per call/);
  assert.equal(MAX_COPIES, 3);
});

test('parallel helpers: one grant per helper when Studio has slots, a finding any copy reports stands', async () => {
  const entries = [{ type: 'message', message: { role: 'user', content: 'dùng 2 reviewer' } }];
  const h = helperHost({ features: ['helper-slots'], script: { answer: (spec, n) => ({ submit: { findings: n === 1 ? [] : [{ severity: 'blocking', file: 'a.js', line: 1, issue: 'bad' }],
    summary: `r${n}` } }) } });
  h.entries = () => entries;
  const out = await runHelper(h, 'review', { role: 'review', task: 't', copies: 2, member_words: 'dùng 2 reviewer' }, undefined, false);
  assert.deepEqual(h.created.map(c => c.key).sort(), ['review', 'review#2']);
  assert.equal(h.helperCalls.get('review'), 2);
  assert.equal(out.details.blocking, 1);
  assert.deepEqual(h.closed.sort(), ['review', 'review#2']);
  const merged = mergeCopies('review', 'Review', [{ text: 'a', tokens: 1, result: { submitted: true, findings: [] } }, { text: 'b', tokens: 2, result: { submitted: false } }]);
  assert.equal(merged.parsed, false);
});

test('without slots the copies share one grant', async () => {
  const entries = [{ type: 'message', message: { role: 'user', content: 'use 2 scout helpers' } }];
  const h = helperHost({ script: { answer: { submit: { brief_issues: [], summary: 's' } } } });
  h.entries = () => entries;
  await runHelper(h, 'scout', { role: 'scout', task: 't', copies: 2, member_words: 'use 2 scout helpers' }, undefined, false);
  assert.equal(h.created.length, 1);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0].prompt, /you are scout helper 1 of 2/);
});
