// Risk lanes (the Harness's workflow.lanes, on unless Studio sets it false):
// the configured policy is the standard lane, sized on the patch the run made.
// A tiny change (few files and lines, nothing sensitive) ends after its checks,
// without a review; a risky one (a complex request, a sensitive file, a test or
// CI file, a wide patch) has check and review required. "off" stays off.
export const LANE_LIMITS = Object.freeze({ tinyFiles: 2, tinyLines: 40, riskyFiles: 12, riskyLines: 400 });
const SENSITIVE = new RegExp([
  String.raw`(^|\/)(migrations?|auth|security|secrets?|permissions?|\.github|\.circleci|infra|terraform|helm|k8s)(\/|$)`,
  String.raw`(^|\/)(Dockerfile|docker-compose[^/]*|\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum)$`,
  String.raw`(^|\/)(Cargo\.toml|Cargo\.lock|pyproject\.toml|uv\.lock|AGENTS\.md|\.env[^/]*)$`,
  String.raw`\.(sql|tf|pem|key)$`,
].join('|'), 'i');
// A change to a test or to CI can make a failing check pass: it needs a review.
const TEST_OR_CI = new RegExp([
  String.raw`(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]*\.py$`,
  String.raw`(^|\/)(vitest|jest|playwright|pytest|karma)\.config\.[^/]*$|(^|\/)(pytest\.ini|tox\.ini|conftest\.py)$|Tests?\.swift$`,
].join('|'), 'i');
export const sensitivePath = file => SENSITIVE.test(String(file ?? ''));
export const testOrCiPath = file => TEST_OR_CI.test(String(file ?? '')) || /(^|\/)\.github\/workflows\//.test(String(file ?? ''));

// Files and changed lines of a unified diff (plus new files); paths named by
// the run itself are added by the caller.
export function patchStats({ patch = '', untracked = [] } = {}) {
  const paths = new Set(); let lines = 0;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('diff --git ')) paths.add(line.match(/^diff --git a\/(.+) b\/\1$/)?.[1] ?? line.slice(11));
    else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) lines += 1;
  }
  for (const file of untracked) {
    if (typeof file?.path !== 'string') continue;
    paths.add(file.path); lines += file.encoding === 'utf8' ? String(file.contents ?? '').split('\n').filter((l, i, all) => l || i < all.length - 1).length : 1;
  }
  return { files: paths.size, lines, paths: [...paths] };
}
// An unreadable patch is standard unless the run's own edits already say risky.
export function changeLane(stats, { complex = false, editedPaths = [] } = {}) {
  const paths = [...new Set([...(stats?.paths ?? []), ...editedPaths])];
  if (complex || paths.some(p => sensitivePath(p) || testOrCiPath(p))) return 'risky';
  if (!stats) return 'standard';
  const L = LANE_LIMITS;
  if (stats.files > L.riskyFiles || stats.lines > L.riskyLines) return 'risky';
  return stats.files <= L.tinyFiles && stats.lines <= L.tinyLines ? 'tiny' : 'standard';
}
export function lanePolicy(policy, lane) {
  if (!policy.lanes || lane === 'standard') return policy;
  if (lane === 'tiny') return { ...policy, review: 'off' };
  const up = mode => mode === 'suggest' ? 'require' : mode;
  return { ...policy, verify: up(policy.verify), review: up(policy.review) };
}
