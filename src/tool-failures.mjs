import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.mjs';

// Tool calls that failed in a company run, for Studio's logs. A failure
// happens on the member's machine and its output stays there: an administrator
// told "Docker does not work" had nothing to read. Each failed call is kept as
// the tool, a stable code, what it was asked to run (a command, path or
// address; never a search query or a brief), the end of its error output and
// what the machine is; secrets are redacted and the home folder is written "~".
const TOOL = /^[a-z0-9_]{1,40}$/;
const INPUT_CHARS = 500, ERROR_HEAD = 1000, ERROR_TAIL = 2000, BATCH = 20, KEEP = 100, ATTEMPTS = 3;
// The member stopped the tool or declined to approve it: not a failure.
const NOT_FAILURES = new Set(['managed_tool_cancelled', 'managed_helper_cancelled', 'managed_operation_denied']);
const text = result => typeof result === 'string' ? result
  : Array.isArray(result) ? result.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';

// The runtime's own code when the error starts with one, else how the command ended.
export function toolFailureCode(error) {
  const named = /^((?:managed|web-search)-[a-z-]{1,56})\b/.exec(error)?.[1];
  if (named) return named.replaceAll('-', '_');
  const exit = /Command exited with code (\d{1,3})\s*$/.exec(error)?.[1];
  if (exit) return `exit_${exit}`;
  if (/Command timed out after \d+ seconds\s*$/.test(error)) return 'timeout';
  if (/Command aborted\s*$/.test(error)) return 'managed_tool_cancelled';
  return 'error';
}
// One failed call as Studio stores it; null when it is not a failure to keep.
export function toolFailure({ tool, role, input, content, startedAt, endedAt, engine, home }) {
  const error = redact(text(content), home).trim(), code = toolFailureCode(error);
  if (NOT_FAILURES.has(code)) return null;
  const shown = redact(input?.command ?? input?.path ?? input?.url ?? '', home).trim();
  return { id: randomUUID(), tool: TOOL.test(String(tool)) ? tool : 'other', role, code, at: endedAt, ...(shown ? { input: shown.slice(0, INPUT_CHARS) } : {}),
    // A long output keeps its start and its end: the end is where it failed.
    error: error.length <= ERROR_HEAD + ERROR_TAIL ? error : `${error.slice(0, ERROR_HEAD)}\n[… ${error.length - ERROR_HEAD - ERROR_TAIL} characters left out …]\n${error.slice(-ERROR_TAIL)}`,
    duration_ms: Math.max(0, Math.round(endedAt - (startedAt ?? endedAt))), engine: tool === 'run_with_docker' ? 'used' : engine ? 'available' : 'none' };
}

export class ToolFailureLog {
  constructor(studio, { now = Date.now, engine = () => false } = {}) { Object.assign(this, { studio, now, engine, queue: [], sending: null, off: false, started: new Map() }); }
  start(event) { this.started.set(event.toolCallId, { at: this.now() }); }
  // A finished tool call: a failed one is kept and sent. `role`: main or the helper's role.
  end(event, role = 'main') {
    const call = this.started.get(event.toolCallId); this.started.delete(event.toolCallId);
    if (!event.isError || this.off) return null;
    let failure = null;
    try { failure = toolFailure({ tool: event.toolName, role, input: event.input, content: event.content, startedAt: call?.at, endedAt: this.now(), engine: this.engine() });
      } catch { /* the log never fails a tool */ }
    if (!failure) return null;
    this.queue.push(failure); if (this.queue.length > KEEP) this.queue.shift();
    void this.send();
    return failure;
  }
  // Sends what is waiting. A Studio without this log (404/405) is not asked again; nothing here can fail a turn.
  send() {
    if (this.off || this.sending || !this.queue.length) return this.sending;
    const batch = this.queue.splice(0, BATCH);
    const again = () => { this.queue.unshift(...batch.filter(item => (item.attempts = (item.attempts ?? 0) + 1) < ATTEMPTS)); };
    this.sending = (async () => {
      try {
        const body = { os: `${process.platform} ${os.release()} ${process.arch}`.slice(0, 80), failures: batch.map(({ at, attempts, ...item }) => ({ ...item, age_ms: Math.max(0,
          this.now() - at) })) };
        const answer = await this.studio.fetch('/studio/v1/managed/tool-failures', { body, timeoutMs: 10_000 });
        if (answer.status === 404 || answer.status === 405) { this.off = true; this.queue.length = 0; }
        else if (!answer.ok && answer.status !== 400) again(); // a refused body (400) would be refused again
      } catch { again(); } finally { this.sending = null; }
    })();
    return this.sending;
  }
}
