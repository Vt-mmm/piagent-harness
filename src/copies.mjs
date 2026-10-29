import { memberMessages, memberRequest } from './objections.mjs';

// Several helpers of one role, at the member's request only ("use 3
// reviewers", "cho 3 scout"): one delegate call runs 2 to MAX_COPIES helper
// sessions of the role side by side and their answers merge into one. The main
// agent never adds helpers on its own, and the harness never does: the call
// quotes the member's words that ask for them, and those words must be the
// member's own and name the number.
export const MAX_COPIES = 3;
const COUNTS = { two: 2, three: 3, hai: 2, ba: 3 };
const HELPER_WORDS = /agent|helper|review|scout|research|verif|nghiên cứu|kiểm|xác minh|trinh sát/;
const normal = text => String(text ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
export function namedCount(words) {
  const found = [...normal(words).matchAll(/(?<![\p{L}\d])(\d+|two|three|hai|ba)(?![\p{L}\d])/gu)].map(m => COUNTS[m[1]] ?? Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}
// The copies a delegate call asks for, checked against the member's words; null
// for a plain call. Copies the member did not ask for come back as `{ dropped }`:
// one helper runs and the main agent is told why.
export function fanOut(entries, role, args, harness) {
  const split = Array.isArray(args?.split) ? args.split.map(s => typeof s === 'string' ? s.trim().slice(0, 500) : '').filter(Boolean) : [];
  const n = split.length || (Number.isInteger(args?.copies) ? args.copies : 1);
  if (n <= 1) return null;
  if (harness) throw Error('managed-copies-invalid: the harness runs one helper per call.');
  const words = normal(args?.member_words);
  if (words.length < 3 || !memberRequest(memberMessages(entries)).some(text => normal(text).includes(words)) || namedCount(words) < n || !HELPER_WORDS.test(words)) return { dropped: n };
  if (n > MAX_COPIES) throw Error(`managed-copies-invalid: ask for 2 to ${MAX_COPIES} ${role} helpers (copies, or one split line per helper).`);
  return { n, split: split.length ? split : null };
}
export function withDroppedNote(text, role, asked) {
  const n = asked?.dropped;
  return n ? `One ${role} helper ran, not ${n}: the member's own words did not ask for ${n} ${role} helpers. Go on with this answer; run several only when the member asks for that
many.\n\n${text}` : text;
}
export const copyNote = (role, i, fan) => `\n\nThe member asked for ${fan.n} ${role} helpers; you are ${role} helper ${i + 1} of ${fan.n}. ${fan.split ? `Your share of the work:
${fan.split[i]}. The others cover the rest.` : 'The others have the same brief: answer on your own judgement.'}`;

const unique = (list, key) => { const seen = new Set(); return list.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const SEVERITY = { blocking: 0, major: 1, minor: 2 };
// One result from the copies: a finding or a failed claim any copy reports stands.
// `answers[i]` = { text, tokens, result: { findings?, verdicts?, brief_issues, summary, submitted } }.
export function mergeCopies(role, label, answers) {
  const n = answers.length, room = Math.floor(12000 / n), results = answers.map(a => a.result ?? {});
  const findings = role === 'review' ? unique(results.flatMap(r => r.findings ?? []), f => `${f.severity}|${f.file}|${f.line}|${f.issue}`).sort((a,
    b) => SEVERITY[a.severity] - SEVERITY[b.severity]).slice(0, 40) : null;
  const verdicts = role === 'verify' ? unique(results.flatMap(r => r.verdicts ?? []), v => `${v.status}|${v.claim}`).slice(0, 40) : null;
  const summaries = results.map(r => r.summary).filter(s => typeof s === 'string').map(s => s.slice(0, 200));
  const result = { submitted: results.every(r => r.submitted), brief_issues: unique(results.flatMap(r => r.brief_issues ?? []), i => `${i.kind}|${i.detail}`).slice(0, 5),
    summary: `${n} ${role} helpers${summaries.length ? ': ' + summaries.join(' | ') : ''}`.slice(0, 600), ...(findings ? { findings } : {}), ...(verdicts ? { verdicts } : {}) };
  const text = answers.map((a, i) => `### ${label} helper ${i + 1} of ${n}\n${String(a.text ?? '').trim().slice(0, room)}`).join('\n\n');
  return { text, tokens: answers.reduce((total, a) => total + (a.tokens ?? 0), 0), result, parsed: result.submitted, blocking: findings?.filter(f => f.severity === 'blocking').length ?? 0 };
}
