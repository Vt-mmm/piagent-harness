import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { SAFE_GIT_ARGS, safeGitEnv } from './safe-git.mjs';

// The patch a reviewer reads: this turn's change (diff against HEAD or the
// commit the turn started from, plus new files), the commits since a ref, or
// the branch's commits. It is read with read-only git commands; the snapshot
// is immutable and its digest says whether a review is still current.
const MAX_UNTRACKED_FILE = 400_000, MAX_UNTRACKED = 200, MAX_PATCH = 16 * 1024 * 1024;
const BASE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export function gitReader(cwd) {
  return args => new Promise((resolve, reject) => {
    execFile('git', ['--no-pager', ...SAFE_GIT_ARGS, '-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: MAX_PATCH, encoding: 'utf8', timeout: 30_000, env: safeGitEnv() },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const sha = text => createHash('sha256').update(text).digest('hex');

export async function readHead(git) {
  try { const head = (await git(['rev-parse', 'HEAD'])).trim(); return BASE.test(head) ? head : null; } catch { return null; }
}
// The commit a ref names when HEAD descends from it, or null.
export async function resolveReviewBase(git, ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9._\/~^@{}-]{1,200}$/.test(ref) || ref.startsWith('-')) return null;
  try {
    const base = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    await git(['merge-base', '--is-ancestor', base, 'HEAD']);
    return BASE.test(base) ? base : null;
  } catch { return null; }
}
export async function readBranchBase(git) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try {
      const base = (await git(['merge-base', ref, 'HEAD'])).trim(), head = (await git(['rev-parse', 'HEAD'])).trim();
      if (BASE.test(base) && base !== head) return { base, ref: ref.replace(/^origin\//, '') };
    } catch { /* next candidate */ }
  }
  return null;
}
async function untrackedFiles(git, cwd, scope) {
  const names = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).filter(n => !scope || scope.has(n)).slice(0, MAX_UNTRACKED);
  const out = [];
  for (const name of names) {
    const file = path.join(cwd, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) out.push({ path: name, mode: 'symlink', target: fs.readlinkSync(file) });
      else if (stat.isDirectory()) out.push({ path: name, mode: 'directory', encoding: 'omitted', bytes: 0 });
      else if (stat.size > MAX_UNTRACKED_FILE) out.push({ path: name, encoding: 'omitted', bytes: stat.size });
      else {
        const data = fs.readFileSync(file);
        out.push(data.includes(0) ? { path: name, encoding: 'base64', contents: data.toString('base64') } : { path: name, encoding: 'utf8', contents: data.toString('utf8') });
      }
    } catch { /* gone meanwhile */ }
  }
  return out;
}
// -> { patch, untracked, base, digest, from? }
export async function readPatchSnapshot(git, cwd, { base = null, scope = null, untracked = true, from } = {}) {
  const against = base && BASE.test(base) ? base : 'HEAD';
  const paths = scope ? ['--', ...scope] : [];
  const patch = await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', against, ...paths]);
  const files = untracked ? await untrackedFiles(git, cwd, scope ? new Set(scope) : null) : [];
  const value = { patch, untracked: files, ...(base ? { base } : {}) };
  return { ...value, digest: sha(JSON.stringify(value)), ...(from ? { from } : {}) };
}
export const emptySnapshot = s => !s?.patch && !(s?.untracked ?? []).length;
// What each changed or new file holds now: { path: hash }. Compared before and
// after, it names the files a command or a fix changed.
export async function readChangedFiles(git, cwd, base = null) {
  const names = new Set((await git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', base && BASE.test(base) ? base : 'HEAD'])).split('\0').filter(Boolean));
  for (const name of (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) names.add(name);
  const out = new Map();
  for (const name of [...names].slice(0, 2000)) {
    try { out.set(name, sha(fs.readFileSync(path.join(cwd, name)).toString('latin1'))); } catch { out.set(name, 'gone'); }
  }
  return out;
}

// Why a required review could not run, in one word for the member.
export function reviewUnavailableReason(message) {
  const text = String(message ?? '');
  if (/review-(patch|file|untracked)-limit|managed-review-patch-too-large/.test(text)) return 'too_large';
  if (/not a git repository|Could not access 'HEAD'|unknown revision|managed-review-patch-unreadable/i.test(text)) return 'not_git';
  if (/managed-helper-limit|helper_run_limit_reached/.test(text)) return 'limit';
  return 'failed';
}

const unread = f => f.mode === 'outside' ? `${f.path} (outside any Git repository, not reviewed)` : f.mode === 'directory' ? `${f.path} (a repository of its own)` : `${f.path} (${f.bytes}
bytes, too large to review)`;
const against = (value, from) => from?.kind === 'since' ? `diff against ${from.ref} (${String(value.base ?? '').slice(0, 12)}): the commits made since, and changes not committed yet`
  : from?.kind === 'branch' ? `diff against where this branch left ${from.ref} (${String(value.base ?? '').slice(0, 12)}): the branch's commits, and changes not committed yet`
  : value?.base ? `diff against the commit the turn started from (${String(value.base).slice(0, 12)}), commits made since included` : 'diff against HEAD';
const newFile = f => f.mode === 'symlink' ? `=== new symlink ${f.path} -> ${f.target}` : f.encoding === 'utf8' ? `=== new file ${f.path}\n${f.contents}`
  : `=== new binary file ${f.path} (${Math.round(String(f.contents ?? '').length * 0.75)} bytes)`;
export function reviewText(snapshot) {
  const files = (snapshot.untracked ?? []).map(f => f.mode === 'directory' ? `=== new folder ${f.path} (a repository of its own, not reviewed)` : f.encoding === 'omitted' ? `=== new file
${unread(f)}` : newFile(f));
  return `Patch snapshot ${snapshot.digest}:\n--- ${against(snapshot, snapshot.from)} ---\n${snapshot.patch || '(no changes to tracked files)'}\n${files.length ? `--- new files
---\n${files.join('\n\n')}` : ''}`;
}

// A patch larger than one reviewer reads at once (REVIEW_PART_BYTES, about 30k
// tokens with room to read the code around it) is reviewed in parts of whole
// files, one part after another, and the findings are merged. One file's diff
// larger than READ_SECTION is not read (a lockfile, generated output): the
// parts name it. More than REVIEW_PARTS_MAX parts: the review cannot run.
export const REVIEW_PART_BYTES = 120_000, REVIEW_PARTS_MAX = 96;
const READ_SECTION = 400_000;
const SEVERITY = { blocking: 0, major: 1, minor: 2 };
export function reviewParts(snapshot, size = REVIEW_PART_BYTES) {
  const whole = reviewText(snapshot);
  const omitted = (snapshot.untracked ?? []).filter(f => f.encoding === 'omitted').map(f => ({ path: f.path, bytes: f.bytes, ...(f.mode === 'directory' ? { repository: true } : {}) }));
  if (Buffer.byteLength(whole) <= size && !omitted.length) return { parts: [{ files: null, text: whole }], omitted: [] };
  const sections = [];
  for (const text of String(snapshot.patch ?? '').split(/(?=^diff --git )/m).filter(Boolean)) {
    const file = /^diff --git (?:"?a\/(.+?)"? )"?b\/(.+?)"?$/m.exec(text)?.[2] ?? text.slice(0, 200).split('\n')[0];
    sections.push({ file, kind: 'diff', text, bytes: Buffer.byteLength(text) });
  }
  for (const f of snapshot.untracked ?? []) if (f.encoding !== 'omitted') { const text = newFile(f); sections.push({ file: f.path, kind: 'new', text, bytes: Buffer.byteLength(text) }); }
  const groups = [];
  for (const section of sections) {
    if (section.bytes > READ_SECTION) { omitted.push({ path: section.file, bytes: section.bytes }); continue; }
    const last = groups.at(-1);
    if (last && last.bytes + section.bytes <= size) { last.sections.push(section); last.bytes += section.bytes; } else groups.push({ sections: [section], bytes: section.bytes });
  }
  if (groups.length > REVIEW_PARTS_MAX) throw Error('managed-review-patch-too-large');
  const skipped = omitted.length ? `\nNot read: ${omitted.map(o => unread({ ...o, mode: o.repository ? 'directory' : null })).join(', ')}.` : '';
  const parts = groups.map((group, i) => {
    const files = group.sections.map(s => s.file), diff = group.sections.filter(s => s.kind === 'diff').map(s => s.text).join(''), news = group.sections.filter(s => s.kind === 'new').map(s => s.text);
    const head = groups.length === 1 ? `Patch snapshot ${snapshot.digest}.` : `Patch snapshot ${snapshot.digest}, part ${i + 1} of ${groups.length}. This part's files: ${files.join(', ')}.
The other parts are reviewed separately: judge this part, and read other files only for context.`;
    return { files, text: `${head}${skipped}\n--- ${against(snapshot, snapshot.from)} ---\n${diff || '(no changes to tracked files in this part)'}\n${news.length ? `--- new files
---\n${news.join('\n\n')}` : ''}` };
  });
  return { parts: parts.length ? parts : [{ files: [], text: `Patch snapshot ${snapshot.digest}: every changed file is too large to review.${skipped}` }], omitted };
}
// A re-review after a fix (focus: the files changed since the last review)
// reads only the parts that hold one of them.
export function focusParts(review, focus) {
  if (!focus?.files?.length || review.parts.length < 2) return review;
  const files = new Set(focus.files), kept = review.parts.filter(part => part.files?.some(file => files.has(file)));
  return kept.length ? { ...review, parts: kept } : review;
}
// One review from the answers of every part: findings of all parts, most
// severe first. `answers[i]` = { findings, brief_issues, summary, tokens }.
export function mergeReviews(review, answers) {
  const all = answers.flatMap(a => a.findings ?? []).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  const issues = answers.flatMap(a => a.brief_issues ?? []).slice(0, 5), count = s => all.filter(f => f.severity === s).length;
  const summary = `${answers.length} parts reviewed: ${count('blocking')} blocking, ${count('major')} major, ${count('minor')} minor${review.omitted.length ? `; ${review.omitted.length}
file(s) too large to review` : ''}.`;
  return { findings: all.slice(0, 40), brief_issues: issues, summary, parts: answers.length, blocking: count('blocking'), unread: review.omitted.map(o => o.path).slice(0, 50),
    tokens: answers.reduce((n, a) => n + (a.tokens ?? 0), 0) };
}
