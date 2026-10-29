import { execFile } from 'node:child_process';
import { SAFE_GIT_ARGS, safeGitEnv } from './safe-git.mjs';

// Which repository team memory uses in the folder and what git says about it.
// Memory only reads git (remote, branch, log, status).
export function repoKey(remote) {
  let s = String(remote ?? '').trim();
  if (!s) return null;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s); // git@github.com:acme/shop.git
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try { const u = new URL(s); if (!['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) return null; s = `${u.hostname}${u.pathname}`; } catch { return null; }
  }
  s = s.toLowerCase().replace(/\.git\/?$/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._/-]+$/.test(s) && s.length <= 200 && !s.includes('..') ? s : null;
}
const gitOnce = (cwd, args, timeout, signal) => new Promise(resolve => execFile('git', ['-C', cwd, ...SAFE_GIT_ARGS, ...args], { timeout, signal, maxBuffer: 4 << 20, encoding: 'utf8', env: safeGitEnv() },
  (error, stdout, stderr) => resolve(error ? { out: null, err: String(stderr ?? '') } : { out: stdout })));
// A repository another user owns makes git refuse ("dubious ownership"): the read is retried trusting that folder.
export async function git(cwd, args, timeout = 3_000, signal) {
  const first = await gitOnce(cwd, args, timeout, signal);
  if (first.out !== null || !/dubious ownership/i.test(first.err)) return first.out;
  return (await gitOnce(cwd, ['-c', `safe.directory=${cwd}`, ...args], timeout, signal)).out;
}
// { key, dir } or { reason }: not_a_repository, no_origin or unsupported_remote.
export async function repositoryAt(dir, signal) {
  const top = (await git(dir, ['rev-parse', '--show-toplevel'], 3_000, signal))?.trim();
  if (!top) return { reason: 'not_a_repository' };
  let remote = (await git(dir, ['remote', 'get-url', 'origin'], 3_000, signal))?.trim();
  if (!remote) {
    const remotes = (await git(dir, ['remote'], 3_000, signal))?.split('\n').map(r => r.trim()).filter(Boolean) ?? [];
    if (remotes.length !== 1) return { reason: 'no_origin' };
    remote = (await git(dir, ['remote', 'get-url', remotes[0]], 3_000, signal))?.trim();
  }
  const key = repoKey(remote);
  return key ? { key, dir: top } : { reason: 'unsupported_remote' };
}
// The top folders of the changed paths (memory context, protocol 3).
export function topDirs(paths, max = 6) {
  const counts = new Map();
  for (const p of paths) { const top = String(p).split('/').length > 1 ? String(p).split('/')[0] : '.'; counts.set(top, (counts.get(top) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, max).map(([d]) => d);
}
