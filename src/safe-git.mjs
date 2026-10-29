// git run on the host in the member's project, which the sandboxed agent can write. The repository's own configuration, attributes and
// hooks are data from the agent: they must not start a program. THE SAME FILE as piagent-sandbox/src/safe-git.mjs (args and env only).
export const SAFE_GIT_ARGS = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false',
  '-c', 'core.sshCommand=false', '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'diff.external=', '-c', 'gc.auto=0']);
export const NO_EXEC_DIFF = Object.freeze(['--no-ext-diff', '--no-textconv']);

export function safeGitEnv(base = process.env) {
  const env = { ...base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat' };
  for (const name of ['GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[name];
  return env;
}
