import { HELPER_ROLES } from './helper-roles.mjs';
import { clip as cut } from './redact.mjs';

// How a helper's attempt ended (POST /v1/managed/settle): one report per
// attempt, sent with the helper's own run token before its role closes.
// succeeded: it did its job and handed in the result its role needs; failed:
// it could not (an error); cancelled: the member or the main agent stopped it;
// unverifiable: it answered without what its role needs, or its review went
// stale. Studio reads a role that closed without a report as unverifiable.
export const SPEC_FIELDS = Object.freeze({
  target: 'The files, component or environment in scope.',
  change: 'What the helper should find, check or judge.',
  constraints: 'What must hold, and what is out of bounds.',
  ownership: 'What the helper may read or run, and what is someone else\'s.',
  acceptance: 'The evidence that answers the task (for example file:line facts, a passing check, a cited source).',
});
const field = description => ({ type: 'string', maxLength: 1000, description });
export function delegateParameters() {
  return { type: 'object', properties: { role: { type: 'string', enum: HELPER_ROLES },
    title: { type: 'string', maxLength: 120, description: 'One line naming the job, for the company logs.' },
    task: { type: 'string', minLength: 1, maxLength: 12000 },
    ...Object.fromEntries(Object.entries(SPEC_FIELDS).map(([name, description]) => [name, field(description)])),
    since: { type: 'string', maxLength: 200, description: 'Review only: the commit, branch or HEAD~N the work to review started from.' },
    copies: { type: 'integer', minimum: 2, maximum: 3, description: 'Only when the member asked for several helpers of this role: how many run side by side on this brief.' },
    split: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Instead of copies: one line per helper naming its share of the work.' },
    member_words: { type: 'string', maxLength: 300, description: 'With copies or split: the member\'s own words, verbatim, that ask for that many helpers.' } },
  required: ['role', 'task'], additionalProperties: false };
}
export const SPEC_PROMPT = ' Give a helper target and acceptance at least (also change, constraints and ownership when they matter): it answers against them, and its ending is recorded with them.';
export function specOf(args) {
  return Object.fromEntries(Object.keys(SPEC_FIELDS).map(k => [k, typeof args?.[k] === 'string' ? args[k].trim().slice(0, 1000) : '']).filter(([, v]) => v));
}
// The task as the helper reads it: the structured fields head the brief.
export function briefWithSpec(args, spec) {
  if (!Object.keys(spec).length) return args.task;
  return `${Object.entries(spec).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`).join('\n')}\n\n${args.task}`.slice(0, 12000);
}

const FILE_LINE = /(?:^|[\s`("'])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]+):(\d+)/g;
const oneLine = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// The report of an attempt that answered. `result` is what the result tool
// stored (sink); no tool call means the role's form was not met: unverifiable.
export function answeredSettlement(role, { result, text = '', stale = false, parsed = true }, spec = {}) {
  const evidence = [], files = new Set();
  let outcome = result?.submitted ? 'succeeded' : 'unverifiable';
  if (!result?.submitted) outcome = 'unverifiable';
  if (role === 'verify') for (const v of result?.verdicts ?? []) evidence.push(oneLine(`${v.status}: ${v.claim} — ${v.evidence}`, 300));
  if (role === 'review') {
    if (stale || parsed === false) outcome = 'unverifiable';
    for (const f of result?.findings ?? []) { evidence.push(oneLine(`${f.severity} ${f.file}:${f.line ?? ''} ${f.issue}`, 300)); if (f.file) files.add(f.file); }
  }
  for (const m of String(text).matchAll(FILE_LINE)) {
    files.add(m[1].replace(/^\.\//, ''));
    if (role !== 'verify' && role !== 'review' && evidence.length < 8) evidence.push(oneLine(`${m[1]}:${m[2]}`, 300));
  }
  const prose = String(text).split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  const summary = oneLine(result?.summary || prose || `${role} answered.`, 600);
  return { outcome, summary: stale ? 'The patch changed during review; this review is stale.' : (outcome === 'unverifiable' && !result?.submitted ? `The ${role} helper ended without handing
in its result.` : summary),
    evidence: [...new Set(evidence.filter(Boolean))].slice(0, 8), files: [...files].filter(f => f.length <= 300).slice(0, 50), ...(Object.keys(spec).length ? { spec } : {}) };
}
// The report of an attempt that ended without an answer.
export function failedSettlement(role, error, signal, spec = {}) {
  const cancelled = signal?.aborted || /managed-helper-cancelled/.test(String(error?.message));
  return { outcome: cancelled ? 'cancelled' : 'failed', summary: oneLine(cancelled ? `The ${role} subagent was stopped.` : `The ${role} subagent failed: ${String(error?.message ?? 'unknown ' +
    'error').replace(/^managed-helper-failed:\s*/, '')}`, 600),
    evidence: [], files: [], ...(Object.keys(spec).length ? { spec } : {}) };
}

// Sends the report with the attempt's own token (the provider holds it);
// never fails the helper. No answer, 5xx or 429 is sent again after these
// pauses: Studio keeps one report per role, so a repeat is safe.
const SETTLE_PAUSES_MS = [500, 2_000];
export async function settleHelper(h, key, report, pauses = SETTLE_PAUSES_MS) {
  if (!report || !h.studio.has('managed.settle.v1')) return false;
  const body = { ...report, summary: cut(report.summary, 600), evidence: report.evidence.map(e => cut(e, 300)).slice(0, 8), files: report.files.slice(0, 50) };
  for (let attempt = 0; ; attempt += 1) {
    const answer = await h.studio.fetch('/v1/managed/settle', { role: key, body, timeoutMs: 3000 });
    if (answer.ok) return true;
    if ((answer.status && answer.status < 500 && answer.status !== 429) || attempt >= pauses.length) return false;
    await new Promise(resolve => setTimeout(resolve, pauses[attempt]));
  }
}
export const OUTCOME_WORDS = { succeeded: 'done', failed: 'failed', cancelled: 'stopped', unverifiable: 'unverifiable' };
