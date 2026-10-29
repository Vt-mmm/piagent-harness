import fs from 'node:fs';
import path from 'node:path';

// Where the repository's checks come from: a "## Checks" section of AGENTS.md
// (code-block lines or `command` bullets) first, else what its manifests imply.
const HEADING = /^#{1,6}\s+(checks?|verification|kiểm tra)\s*$/i;
export function declaredChecks(agentsFiles = []) {
  const out = [];
  for (const file of agentsFiles) {
    let inside = false, fence = false;
    for (const line of String(file.content ?? '').split('\n')) {
      if (!fence && /^#{1,6}\s/.test(line)) { inside = HEADING.test(line.trim()); continue; }
      if (!inside) continue;
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const command = (fence ? line : line.match(/^\s*[-*]\s+`([^`]+)`/)?.[1] ?? '').trim();
      if (command && !command.startsWith('#') && command.length <= 200 && !out.includes(command) && out.length < 10) out.push(command);
    }
  }
  return out;
}
const SCRIPTS = ['typecheck', 'type-check', 'lint', 'test', 'test:unit', 'test:integration', 'test:api', 'test:contract', 'test:e2e'];
export function detectedChecks(dir) {
  const has = name => { try { const s = fs.lstatSync(path.join(dir, name)); return s.isFile() && s.size <= 1024 * 1024; } catch { return false; } };
  const out = [];
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
      const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
      for (const name of SCRIPTS) if (typeof scripts[name] === 'string') out.push(name === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${name}`);
    } catch { /* not JSON: nothing implied */ }
  }
  if (has('go.mod')) out.push('go vet ./...', 'go test ./...');
  if (has('Package.swift')) out.push('swift build', 'swift test');
  if (has('Cargo.toml')) out.push('cargo check', 'cargo test');
  if (has('pyproject.toml') || has('pytest.ini')) out.push(has('uv.lock') ? 'uv run pytest' : 'pytest');
  if (has('pom.xml')) out.push(has('mvnw') ? './mvnw verify' : 'mvn verify');
  if (has('build.gradle') || has('build.gradle.kts')) out.push(has('gradlew') ? './gradlew test' : 'gradle test');
  return out.slice(0, 16);
}
export function repositoryChecks(agentsFiles, cwd) {
  const declared = declaredChecks(agentsFiles);
  return declared.length ? { source: 'agents', commands: declared } : { source: 'detected', commands: detectedChecks(cwd) };
}
// The AGENTS.md files that apply here: the folder's own and its parents'.
export function readAgentsFiles(cwd) {
  const files = [];
  for (let dir = path.resolve(cwd); files.length < 4; dir = path.dirname(dir)) {
    try { const file = path.join(dir, 'AGENTS.md'); if (fs.statSync(file).size <= 256 * 1024) files.push({ path: file, content: fs.readFileSync(file, 'utf8') }); } catch { /* none here */ }
    if (path.dirname(dir) === dir) break;
  }
  return files;
}

// A command that verifies code: a declared check, or a known test, type, lint
// or build runner. Text tools that merely mention one do not count.
const RUNNER = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build|verify)\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\b(tsc|vitest|jest|eslint|biome|ruff|mypy|pyright|pytest|rspec|phpunit)\b`,
  String.raw`\bplaywright\s+test\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy)\b`,
  String.raw`\bgo\s+(test|vet|build)\b`,
  String.raw`\bcargo\s+(test|check|clippy|build)\b`,
  String.raw`\bswift\s+(test|build)\b`,
  String.raw`\bxcodebuild\b.*\b(test|build)\b`,
  String.raw`\bmake\s+(test|check|lint)\b`,
  String.raw`\b(gradle|gradlew|mvn|mvnw)\b.*\b(test|check|verify|compile|package|build)\b`,
  String.raw`\bdotnet\s+(test|build)\b`,
  String.raw`\bdeno\s+(test|check|lint)\b`,
].join('|'));
// A filtered run covers part of the suite and a version probe runs nothing:
// neither shows that the code works.
const FILTERED = /(?:^|\s)(?:-k|-t|--grep|--testNamePattern|--test-name-pattern|--filter|--only|--testPathPattern|--collect-only)(?:[\s=]|$)|\bgo\s+test\b.*\s-run[\s=]|\bpytest\b.*\s::|\.only\b/;
const VERSION_ONLY = /(?:^|\s)(?:--version|-V|--help)(?:\s|$)/;
export function isCheckCommand(command, declared = []) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /^(echo|printf|grep|rg|cat|sed|awk|head|tail|less|git|ls|find)\b/.test(text)) return false;
  if (FILTERED.test(text) || VERSION_ONLY.test(text)) return false;
  return declared.some(d => text.includes(d)) || RUNNER.test(text);
}

// A check piped into another command (`npm test | tail`) returns the last
// command's status: it is judged by its output too.
export const hasPipe = command => /(^|[^|])\|(?!\|)/.test(String(command ?? '')) || /\|\|\s*(true|:|exit\s+0)/.test(String(command ?? ''));
const FAILED_OUTPUT = new RegExp([
  String.raw`^# fail [1-9]|\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|^\s*(?:FAIL|FAILED)\b|\bTests?:\s+[1-9]\d* failed|✖ [1-9]`,
  String.raw`\bBUILD FAILURE\b|npm ERR!|\bAssertionError\b|Traceback \(most recent call last\)|error TS\d+`,
].join('|'), 'm');
const ZEROS = /\b(?:fail(?:ed|ures?)?|errors?|skipped)\s*[:=]?\s*0\b|\b0\s+(?:failed|failing|failures?|errors?|skipped)\b/gi;
export function failedOutput(output) {
  const text = String(output ?? '').replace(ZEROS, '');
  return FAILED_OUTPUT.test(text);
}
// Whether a finished check passed: by exit status, and by output when the
// command is piped (the exit status is then another command's).
export function checkPassed({ command, isError, output }) {
  if (isError) return false;
  return hasPipe(command) ? !failedOutput(output) : true;
}

// Files no check covers: documentation, pictures and documents, Spec Kit state.
const NON_CODE = /\.(md|mdx|markdown|rst|adoc|asciidoc|org|png|jpe?g|gif|webp|bmp|ico|pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
export function nonCodePath(file) {
  const name = String(file ?? '').replaceAll('\\', '/');
  return !!name && (NON_CODE.test(name) || /(^|\/)\.specify\//.test(name) || /(^|\/)(LICENSE|NOTICE|AUTHORS|CODEOWNERS)$/.test(name));
}
export const onlyNonCode = paths => { const list = [...(paths ?? [])]; return list.length > 0 && list.every(nonCodePath); };

// A command that only reads: each part starts with a reading tool and nothing
// is written. Git may name the repository first (git -C <folder>).
const GIT_VERBS = 'status|diff|log|show|branch|ls-files|rev-parse|rev-list|blame|describe|shortlog|cat-file|for-each-ref|reflog(?!\\s+(expire|delete))';
const GIT_READ = String.raw`git(\s+(-C\s+('[^']*'|"[^"]*"|\S+)|-c\s+\S+|--no-pager))*\s+(${GIT_VERBS}|remote(\s+(-v|--verbose|show|get-url)\b|$))`;
const READERS = 'ls|cat|head|tail|wc|grep|egrep|rg|find|fd|sed|awk|cut|sort|uniq|tr|echo|printf|pwd|which|stat|file|du|df|tree|jq|diff|cmp|basename|dirname|realpath|date|true|cd|printenv|uname|whoami|id|hostname|ps|uptime|env(?=\s*$)|less|more|nl|rev|shasum|md5|md5sum|readlink|lsof';
const READER = new RegExp(String.raw`^(${READERS}|${GIT_READ})(\b|$)`);
export function isReadOnlyCommand(command) {
  const text = String(command ?? '').trim();
  if (!text || />(?!>|\s*&\d|\s*\/dev\/null)|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\s-(delete|exec|execdir|fprint|ok)\b|\bxargs\b|\$\(|`/.test(text)) return false;
  return text.split(/&&|\|\||;|\||\n/).every(part => !part.trim() || READER.test(part.trim()));
}
