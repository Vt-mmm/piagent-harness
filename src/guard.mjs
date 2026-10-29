import { CHANNELS, CONTRACT_VERSION } from './bus.mjs';

// The core tools must come from piagent-sandbox: it is the boundary that keeps
// reads, writes and commands inside the project. When a session opens, each of
// the seven must carry the sandbox's sourceInfo (the sandbox names its source
// on piagent:tools.attest). If any is Pi's own built-in or another extension's
// (the first package loaded wins a duplicate name), every tool call is blocked
// and Studio is told.
export const CORE_TOOLS = Object.freeze(['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls']);
// The sandbox names itself by package ("piagent-sandbox"); Pi's sourceInfo of a tool loaded with -e (or
// installed) is the entry file's path with source "cli". It matches when a folder of that path is
// the package, so a look-alike name ("piagent-sandbox-fake") or Pi's own "builtin:bash" does not.
const sameSource = (info, source) => !!info && !!source && (info.source === source || String(info.path ?? '').split(/[\\/]/).includes(source));

// -> { ok, bad: [{ name, found }] }. `attested`: Map name -> source from the sandbox.
export function checkToolset(tools, attested) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const bad = [];
  for (const name of CORE_TOOLS) {
    const tool = byName.get(name), want = attested.get(name);
    if (!tool) bad.push({ name, found: 'missing' });
    else if (!want) bad.push({ name, found: 'no-attestation' });
    else if (!sameSource(tool.sourceInfo, want)) bad.push({ name, found: String(tool.sourceInfo?.path ?? tool.sourceInfo?.source ?? 'unknown').replace(/^.*\//, '') });
  }
  // One package registers all seven: tools that come from different files are not one boundary.
  const paths = new Set(CORE_TOOLS.map(n => byName.get(n)?.sourceInfo?.path).filter(Boolean));
  if (!bad.length && paths.size > 1) bad.push({ name: 'toolset', found: 'mixed-sources' });
  return { ok: bad.length === 0, bad };
}
export const BLOCK_REASON = 'managed-toolset-untrusted: the core tools (bash, read, edit, write, grep, find, ls) do not come from piagent-sandbox, '
  + 'so no tool call is allowed. Start Pi with piagent-sandbox loaded before any other package that registers these tools.';

export class ToolsetGuard {
  constructor({ events, getTools, report = async () => {} }) { Object.assign(this, { events, getTools, report, attested: new Map(), blocked: false, bad: [], reported: false, checked: false }); }
  start() {
    return this.events.on(CHANNELS.toolsAttest, data => { for (const t of Array.isArray(data?.tools) ? data.tools : []) if (typeof t?.name === 'string'
      && typeof t.source === 'string') this.attested.set(t.name, t.source); });
  }
  // Called before each run (and before the first tool call if no run came first): decides, tells Studio once.
  // Not at session_start: the sandbox is loaded after the harness and attests in its own session_start.
  async verify() {
    this.checked = true;
    const result = checkToolset(this.getTools(), this.attested);
    this.blocked = !result.ok; this.bad = result.bad;
    if (this.blocked) {
      this.events.emit(CHANNELS.toolsBlocked, { v: CONTRACT_VERSION, bad: result.bad });
      await this.tell();
    }
    return result;
  }
  // Tells Studio once it has been heard: the report needs the run's grant, which the provider opens after the
  // first before_agent_start, so a report that finds no run is tried again at the first blocked tool call.
  async tell() {
    if (this.reported || !this.blocked) return;
    try { this.reported = (await this.report(this.bad)) !== false; } catch { /* Studio may be unreachable: tried again */ }
  }
  // The tool_call handler's answer.
  onToolCall() { return this.blocked ? { block: true, reason: BLOCK_REASON } : undefined; }
}
