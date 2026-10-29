import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewParts, focusParts, mergeReviews, REVIEW_PART_BYTES, reviewText } from '../src/patch.mjs';
import { runHelper } from '../src/helper-run.mjs';
import { helperHost } from './helpers.mjs';

const file = (name, bytes) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${'+' + 'x'.repeat(78) + '\n'}`.repeat(1) + ('+' + 'y'.repeat(78) + '\n').repeat(Math.floor(bytes / 80));
const big = names => ({ patch: names.map(n => file(n, 50_000)).join(''), untracked: [], digest: 'd'.repeat(64) });

test('a patch of 120 KB or less is one part', () => {
  const snapshot = big(['a.js']);
  assert.ok(Buffer.byteLength(reviewText(snapshot)) < REVIEW_PART_BYTES);
  assert.equal(reviewParts(snapshot).parts.length, 1);
});

test('a patch over 120 KB is split into parts of whole files, none over the limit', () => {
  const snapshot = big(['a.js', 'b.js', 'c.js', 'd.js']);
  assert.ok(Buffer.byteLength(reviewText(snapshot)) > REVIEW_PART_BYTES);
  const { parts } = reviewParts(snapshot);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.files), [['a.js', 'b.js'], ['c.js', 'd.js']]);
  for (const p of parts) assert.ok(Buffer.byteLength(p.text) <= REVIEW_PART_BYTES + 2000);
  assert.match(parts[1].text, /part 2 of 2/);
});

test('one huge file is named as not read instead of blowing the part', () => {
  const snapshot = big(['a.js']); snapshot.patch += file('lock.json', 450_000);
  const review = reviewParts(snapshot);
  assert.deepEqual(review.omitted.map(o => o.path), ['lock.json']);
  assert.match(review.parts[0].text, /Not read: lock\.json/);
});

test('too many parts: the review cannot run', () => {
  const names = Array.from({ length: 200 }, (_, i) => `f${i}.js`), snapshot = { patch: names.map(n => file(n, 110_000)).join(''), untracked: [], digest: 'e'.repeat(64) };
  assert.throws(() => reviewParts(snapshot), /managed-review-patch-too-large/);
});

test('a re-review after a fix reads only the parts holding a changed file', () => {
  const review = reviewParts(big(['a.js', 'b.js', 'c.js', 'd.js']));
  assert.deepEqual(focusParts(review, { files: ['d.js'] }).parts.map(p => p.files), [['c.js', 'd.js']]);
  assert.equal(focusParts(review, { files: ['nothere.js'] }).parts.length, 2);
});

test('findings of the parts are merged, most severe first, blocking counted', () => {
  const review = reviewParts(big(['a.js', 'b.js', 'c.js', 'd.js']));
  const merged = mergeReviews(review, [{ findings: [{ severity: 'minor', issue: 'm' }], tokens: 5 }, { findings: [{ severity: 'blocking', issue: 'b' }], tokens: 6 }]);
  assert.deepEqual(merged.findings.map(f => f.severity), ['blocking', 'minor']);
  assert.equal(merged.blocking, 1);
  assert.equal(merged.tokens, 11);
});

test('runHelper reviews each part in its own child session, one after another, and merges', async () => {
  const snapshot = big(['a.js', 'b.js', 'c.js', 'd.js']);
  const h = helperHost({ patch: snapshot.patch, script: { answer: (spec, n) => ({ submit: { findings: n === 1 ? [] : [{ severity: 'blocking', file: 'c.js', line: 1, issue: 'bug' }],
    summary: `part ${n}` } }) } });
  const out = await runHelper(h, 'review', { role: 'review', task: 't' }, undefined, false);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0].prompt, /part 1 of 2/); assert.match(h.sent[1].prompt, /part 2 of 2/);
  assert.equal(out.details.parts, 2);
  assert.equal(out.details.blocking, 1);
  assert.equal(h.created.length, 1, 'one grant for the role, parts share it');
});
