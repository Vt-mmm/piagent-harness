import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The state file Agent Watch reads (PiagentStatus): one small file per
// conversation under <agent dir>/status/company/. Only the conversation's
// title and project name, never a prompt or an answer. A file over 16 KB is
// skipped by the reader, so titles are cut.
export const STATES = ['idle', 'working', 'blocked', 'done', 'error'];
export const BLOCKED_KINDS = ['permission', 'question', 'auth'];
export const ENDED = ['done', 'stopped', 'failed'];
export const agentDir = (env = process.env) => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

export class StatusFile {
  constructor({ conversation, title = '', project = '', dir = path.join(agentDir(), 'status', 'company'), now = () => new Date() }) {
    Object.assign(this, { conversation: String(conversation), title: String(title).slice(0, 200), project: String(project).slice(0, 120), dir, now, since: null, state: null });
    this.file = path.join(dir, `${this.conversation.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}.json`);
  }
  setTitle(title) { this.title = String(title ?? '').slice(0, 200); }
  // state: idle, working, blocked (with kind), done or error (with ended).
  set(state, { kind, ended, helpers = 0 } = {}) {
    if (!STATES.includes(state)) throw Error(`status-state-invalid: ${state}`);
    const at = this.now().toISOString();
    if (state !== this.state) { this.state = state; this.since = at; }
    const body = { conversation: this.conversation, title: this.title, project: this.project, company: true, state,
      ...(state === 'blocked' && BLOCKED_KINDS.includes(kind) ? { kind } : {}), ...(ENDED.includes(ended) ? { ended } : {}),
      helpers: Math.max(0, Math.min(helpers, 99)), since: this.since, updated_at: at };
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch { /* Agent Watch's view is optional */ }
    return body;
  }
  remove() { try { fs.rmSync(this.file, { force: true }); } catch { /* gone */ } }
}
