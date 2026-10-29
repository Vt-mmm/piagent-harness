import { failureCode } from './failure.mjs';
import { HELPER_SETUP, helperCallLimit } from './helper-roles.mjs';
import { resultToolFor } from './helper-results.mjs';
import { answeredSettlement, failedSettlement, settleHelper, specOf, briefWithSpec, OUTCOME_WORDS } from './helper-settlement.mjs';
import { anchorText, beforeDelegate, relayObjection, recordVerdicts } from './objections.mjs';
import { recordFindings } from './ledger.mjs';
import { copyNote, fanOut, mergeCopies, withDroppedNote } from './copies.mjs';
import { emptySnapshot, focusParts, mergeReviews, readBranchBase, readPatchSnapshot, resolveReviewBase, reviewParts } from './patch.mjs';
import { currentWorkflow, helperWorkflowPrompt } from './workflow-context.mjs';
import { fenced } from './untrusted.mjs';

// A helper role's run: its own grant (broker `child`, asked through the
// provider), its read-only Pi session (one per part of a large patch for a
// review), the result it hands in through a schema tool, the settlement and the
// review it records. A helper whose company model account is out of usage, or
// resting after a refusal, starts once more: Studio then gives the new helper
// the next model of its role that serves.
const HELPER_SWITCH = new Set(['upstream_rate_limited', 'session_account_not_ready_retry_later', 'session_account_unavailable_start_new_session', 'account_capacity_unavailable',
  'execution_capability_unavailable']);
const HELPER_ATTEMPTS = 2;
export const baseRole = key => String(key).split('#')[0];
const slotsReady = h => (h.state?.features ?? []).includes('helper-slots');

// The patch a review reads: this turn's change; the commits since `since`; or,
// when the turn changed nothing and the main agent asked, the branch's commits.
async function reviewSnapshot(h, harness, since) {
  if (since) {
    const base = await resolveReviewBase(h.git, since);
    if (!base) throw Error(`managed-review-base-unknown: "${String(since).slice(0, 80)}" is not a commit HEAD descends from in this repository; name a commit, a branch or HEAD~N`);
    return readPatchSnapshot(h.git, h.cwd, { base, from: { kind: 'since', ref: since, base } });
  }
  const snapshot = await h.patchSnapshotFull();
  if (harness || !emptySnapshot(snapshot)) return snapshot;
  const branch = await readBranchBase(h.git);
  return branch ? readPatchSnapshot(h.git, h.cwd, { base: branch.base, from: { kind: 'branch', ref: branch.ref, base: branch.base } }) : snapshot;
}

export async function runHelper(h, role, args, signal, harness) {
  const limit = helperCallLimit(h.state);
  if ((h.helperCalls.get(role) ?? 0) >= limit) throw Error(`managed-helper-limit: the ${role} helper already ran ${limit} times for this message.`);
  const fan = fanOut(h.entries(), role, args, harness);
  beforeDelegate(h.run, role, harness, { since: args.since ?? null, review: h.review, changed: h.run?.changed || h.run?.mutations > 0, asked: !!fan });
  const spec = specOf(args), ctx = { task: briefWithSpec(args, spec), title: args.title, spec, fan, harness, signal };
  if (role === 'review') {
    ctx.snapshot = await reviewSnapshot(h, harness, args.since);
    ctx.parts = focusParts(reviewParts(ctx.snapshot), harness && !args.since ? h.reviewFocus : null);
  }
  for (let attempt = 1; ; attempt += 1) {
    try { return { ...(await helperAttempt(h, role, ctx)), droppedFan: fan?.dropped ? { role, dropped: fan.dropped } : null }; }
    catch (error) {
      if (attempt >= HELPER_ATTEMPTS || signal?.aborted || !HELPER_SWITCH.has(failureCode(error?.message)) || (h.helperCalls.get(role) ?? 0) >= limit) throw error;
    }
  }
}

async function helperAttempt(h, role, ctx) {
  const setup = HELPER_SETUP[role], { fan, snapshot, parts } = ctx;
  let result;
  if (!fan) result = await answerUnder(h, role, ctx, ['']);
  else if (!slotsReady(h)) result = await answerUnder(h, role, ctx, Array.from({ length: fan.n }, (_, i) => copyNote(role, i, fan)));
  else {
    // One grant per helper, all at once; the first that fails stops the others.
    const stop = new AbortController(), both = AbortSignal.any([stop.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    let results;
    try { results = await Promise.all(Array.from({ length: fan.n }, (_, i) => answerUnder(h, i ? `${role}#${i + 1}` : role, { ...ctx, signal: both }, [copyNote(role, i,
      fan)]).catch(error => { stop.abort(); throw error; }))); }
    catch (error) { throw ctx.signal?.aborted ? Error('managed-helper-cancelled') : error; }
    const merged = mergeCopies(role, setup.label, results.map(r => ({ text: r.text, tokens: r.tokens, result: r.result })));
    result = { ...results[0], text: merged.text, tokens: merged.tokens, result: merged.result, stale: results.some(r => r.stale), report: null };
  }
  const { text, tokens, result: sink, stale, from } = result;
  const details = { role, tokens, patchDigest: snapshot?.digest, stale, ...(fan ? { helpers: fan.n, ...(slotsReady(h) ? { slots: true } : {}) } : {}), ...(from ? { since: { kind: from.kind,
    ref: from.ref, base: from.base } } : {}) };
  if (snapshot) {
    const findings = sink?.findings ?? null;
    Object.assign(details, { parsed: !!sink?.submitted, findings: (findings ?? []).slice(0, 40), blocking: findings?.filter(f => f.severity === 'blocking').length ?? 0 });
    if (result.review) Object.assign(details, { parts: result.review.parts, unread: result.review.unread });
    if (h.run) { h.run.reviews += 1; h.run.blocking += details.blocking; }
    // A review of earlier commits is not the review of this turn's change.
    if (!from) {
      h.review = details;
      if (!stale && sink?.submitted) { recordFindings(h.run, h.cwd, findings, h.reviewFocus); h.reviewFiles = await h.changedFiles?.(); }
    }
    h.append('agent-watch-review', details);
  }
  const verdicts = role === 'verify' && sink?.verdicts ? recordVerdicts(h.run, h.cwd, sink.verdicts, ctx.harness) : null;
  if (verdicts) details.verdicts = verdicts;
  const report = result.report ?? answeredSettlement(role, { result: sink, text, stale, parsed: details.parsed }, ctx.spec);
  details.outcome = report.outcome;
  const counts = verdicts ? ' · ' + Object.entries(verdicts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') : '';
  await h.note(`${setup.label}: ${tokens.toLocaleString('en-US')} tokens${counts}${fan ? ` · ${fan.n} helpers` : result.review ? ` · ${result.review.parts} parts` : ''}${snapshot ? (stale
    ? ' · review is stale' : ' · patch ' + snapshot.digest.slice(0, 12)) : ''} · ${OUTCOME_WORDS[report.outcome]}.`,
    details, 'agent-watch-helper-receipt');
  const objection = stale ? '' : await relayObjection(h, role, sink?.brief_issues, ctx.harness);
  const ending = `Outcome: ${report.outcome}${report.outcome === 'unverifiable' ? ` (${report.summary})` : ''}.\n\n`;
  const body = stale ? 'Review is stale: the patch changed during review. Ask for another review only after fixing blocking findings; under a required review the harness reviews the final patch.'
    : fenced(`${setup.label} helper's answer`, summaryText(role, sink, text)) + objection;
  return { text: ending + body, details, brief_issues: sink?.brief_issues ?? [], findings: sink?.findings, verdicts: sink?.verdicts, outcome: report.outcome, summary: sink?.summary ?? '' };
}
// What the main agent reads: the helper's explanation and its structured result.
function summaryText(role, sink, text) {
  const parts = [String(text ?? '').trim()];
  if (sink?.findings) parts.push(`Findings (${sink.findings.length}):\n${sink.findings.map(f => `- [${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} ${f.issue}${f.evidence ? `
(${f.evidence})` : ''}`).join('\n') || '(none)'}`);
  if (sink?.verdicts) parts.push(`Verdicts:\n${sink.verdicts.map(v => `- ${v.status}: ${v.claim}${v.evidence ? ` (${v.evidence})` : ''}`).join('\n')}`);
  if (sink?.summary) parts.push(`Summary: ${sink.summary}`);
  return parts.filter(Boolean).join('\n\n').slice(0, 16000);
}

// One grant of the role (`key`: the role, or role#slot) and the helper sessions
// that answer under it, one per note. Its settlement goes to Studio and the
// grant closes before the answer is used.
async function answerUnder(h, key, ctx, notes) {
  const role = baseRole(key), setup = HELPER_SETUP[role], { parts, signal, harness } = ctx;
  let child = null, report = null;
  try {
    try { child = await h.children.create({ role, key, setup, signal }); }
    catch (error) { throw Error(`managed-helper-failed: ${String(error?.message ?? error)}`); }
    h.helperCalls.set(role, (h.helperCalls.get(role) ?? 0) + notes.length); // each helper the member asked for counts
    const anchor = anchorText(h.entries(), harness), extra = `${helperWorkflowPrompt(currentWorkflow(h.entries()))}${role === 'verify' ? checksText(h) : ''}`;
    // One helper session answers the brief (one part of the patch for a review in parts).
    const ask = async (partText, note) => {
      const sink = {}, tool = resultToolFor(role, setup, sink), prompt = `${anchor}${ctx.task}${note}${extra}${partText}`;
      let answer = await child.ask(prompt, { signal, resultTool: tool, title: ctx.title });
      // A helper that never handed in its result is asked once to do so.
      if (!sink.submitted && !signal?.aborted) answer = { ...(await child.ask(`You ended without calling ${setup.result}. Call it now with your result for the brief above; your earlier
answer was:\n${answer.text.slice(0, 4000)}`, { signal, resultTool: tool, title: ctx.title })), tokens: answer.tokens + 0 };
      return { text: answer.text, tokens: answer.tokens, result: sink };
    };
    const once = async note => {
      if (!parts || parts.parts.length === 1) return { ...(await ask(parts ? `\n${parts.parts[0].text}` : '', note)), review: null };
      const answers = [];
      for (const part of parts.parts) answers.push(await ask(`\n${part.text}`, note)); // one request of a role at a time
      const review = mergeReviews(parts, answers.map(a => ({ ...a.result, tokens: a.tokens })));
      const submitted = answers.every(a => a.result.submitted);
      return { text: answers.map((a, i) => `Part ${i + 1}/${answers.length}: ${a.result.summary ?? ''}`).join('\n'), tokens: review.tokens, review,
        result: { submitted, findings: review.findings, brief_issues: review.brief_issues, summary: review.summary } };
    };
    let out;
    if (notes.length === 1) out = await once(notes[0]);
    else {
      const answers = await Promise.all(notes.map(note => once(note)));
      const merged = mergeCopies(role, setup.label, answers);
      out = { text: merged.text, tokens: merged.tokens, result: merged.result, review: null };
    }
    const from = ctx.snapshot?.from ?? null;
    const stale = ctx.snapshot ? (await (from ? h.patchDigestSince(from.base) : h.patchDigest())) !== ctx.snapshot.digest : false;
    report = answeredSettlement(role, { result: out.result, text: out.text, stale, parsed: out.result.submitted }, ctx.spec);
    return { ...out, stale, from, report };
  } catch (error) { report = failedSettlement(role, error, signal, ctx.spec); throw error; }
  finally {
    await settleHelper(h, key, report); // with the role's current token, before it closes
    await child?.close();
  }
}
const checksText = h => `\n\nRepository checks: ${h.run?.checks.commands.length ? h.run.checks.commands.map(c => '`' + c + '`').join(', ') : 'none declared or detected; choose the tests, ' +
  'type check or build that cover the claims'}.`;

// The delegate tool the main agent calls.
export function delegateTool(h, roles, parameters, description) {
  return { name: 'delegate', label: 'Subagent', description, parameters,
    execute: async (_id, args, signal) => {
      if (!roles.includes(args?.role)) throw Error(`managed-helper-unavailable: the Harness has no ${String(args?.role).slice(0, 20)} helper.`);
      const out = await runHelper(h, args.role, args, signal, false);
      return { content: [{ type: 'text', text: withDroppedNote(out.text, args.role, out.droppedFan) }], details: out.details };
    } };
}
