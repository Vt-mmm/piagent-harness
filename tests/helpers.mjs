import { RunProcess, workflowPolicy } from '../src/workflow.mjs';

// A pi.events stand-in: emit calls the handlers of the channel synchronously.
export function fakeBus() {
  const handlers = new Map(), log = [];
  return { log, on(ch, fn) { const set = handlers.get(ch) ?? new Set(); set.add(fn); handlers.set(ch, set); return () => set.delete(fn); },
    emit(ch, data) { log.push([ch, data]); for (const fn of [...(handlers.get(ch) ?? [])]) fn(data); } };
}

// The gate's host: code state is a digest string the test moves by hand.
export function fakeHost({ workflow = {}, roles = ['review', 'verify'], checks = ['npm test'], delegate } = {}) {
  const policy = workflowPolicy({ workflow: { plan: 'off', verify: 'require', review: 'require', ...workflow }, roles });
  const state = { digest: 'd0', patch: ['a', 'b', 'c'].map(f => `diff --git a/src/${f}.js b/src/${f}.js\n+x\n`).join(''), untracked: [], entries: [], delegated: [], messages: 0 };
  const h = {
    cwd: process.cwd(), state, policy, review: null, reviewFiles: null, nextPurpose: null,
    run: new RunProcess(policy, { checks: { source: 'agents', commands: checks } }),
    digest: async () => state.digest, patchDigest: async () => state.digest,
    patchSnapshot: async () => ({ patch: state.patch, untracked: state.untracked }), changedFiles: async () => new Map(),
    entries: () => state.entries, append: (customType, data) => state.entries.push({ type: 'custom', customType, data }),
    messageCount: () => state.messages, assistantTextSince: () => '', note: async () => {},
    delegate: async (args, signal, opts) => { state.delegated.push(args); return delegate ? delegate(args, h, opts) : { brief_issues: [] }; },
  };
  h.run.startDigest = 'd0';
  return h;
}
export const edit = async (h, path = 'src/app.js') => { h.state.digest = `d${h.state.digest.slice(1) * 1 + 1}`; await h.run.afterTool({ name: 'edit', input: { path }, isError: false },
  async () => h.state.digest); };
export const bash = async (h, command, { isError = false, output = '' } = {}) => h.run.afterTool({ name: 'bash', input: { command }, isError, output }, async () => h.state.digest);
// A review helper result recorded the way delegate does: h.review + ledger.
export const reviewed = (h, findings) => { h.review = { patchDigest: h.state.digest, stale: false, findings, blocking: findings.filter(f => f.severity === 'blocking').length }; };

// A host for runHelper: scripted child sessions that hand in their result
// through the very tool the harness gives them (schema included).
export function helperHost({ roles = ['scout', 'research', 'verify', 'review'], features = [], capabilities = ['managed.settle.v1'], helperCalls, patch, workflow = {}, script = {} } = {}) {
  const h = fakeHost({ roles, workflow });
  const sent = [], created = [], closed = [], settles = [], notes = [];
  Object.assign(h.state, { roles, features, capabilities, helperCalls });
  h.helperCalls = new Map(); h.git = async () => ''; h.reviewFocus = null; h.sent = sent; h.created = created; h.closed = closed; h.settles = settles; h.notes = notes;
  const snapshot = { patch: patch ?? 'diff --git a/src/a.js b/src/a.js\n+x\n', untracked: [], digest: 'p'.repeat(64) };
  h.patchSnapshotFull = async () => ({ ...snapshot, digest: h.snapshotDigest ?? snapshot.digest });
  h.patchDigestSince = async () => h.snapshotDigest ?? snapshot.digest;
  h.patchDigest = async () => h.snapshotDigest ?? snapshot.digest;
  h.note = async (content, details, customType) => { notes.push({ content, details, customType }); };
  h.studio = { has: name => capabilities.includes(name), fetch: async (path, opts) => { settles.push({ path, ...opts }); return script.settleStatus ? { ok: false,
    status: script.settleStatus } : { ok: true, status: 200 }; } };
  h.children = { async create(spec) {
    created.push(spec);
    const plan = typeof script.answer === 'function' ? script.answer : () => script.answer ?? {};
    return {
      async ask(prompt, { resultTool, signal }) {
        sent.push({ role: spec.role, key: spec.key, prompt });
        const answer = plan(spec, sent.length);
        if (answer.throws) throw Error(answer.throws);
        if (answer.submit) await resultTool.execute('t1', answer.submit);
        return { text: answer.text ?? 'done', tokens: answer.tokens ?? 100 };
      },
      async close() { closed.push(spec.key); },
    };
  } };
  return h;
}

// Pi as the harness sees it: handlers by event, tools, messages and entries recorded.
export function fakePi() {
  const handlers = {}, tools = {}, commands = {}, messages = [], entries = [], events = fakeBus(), sandbox = '/pkgs/piagent-sandbox/src/index.mjs';
  const pi = { events, handlers, tools, commands, messages, entries,
    on(name, fn) { (handlers[name] ??= []).push(fn); }, registerTool(t) { tools[t.name] = t; }, registerCommand(n, o) { commands[n] = o; },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); }, sendMessage(m, o) { messages.push([m, o]); },
    getAllTools: () => ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'].map(name => ({ name, sourceInfo: { path: sandbox } })) };
  const ctx = { hasUI: false, mode: 'print', cwd: process.cwd(), signal: undefined, entries, sessionManager: { getEntries: () => entries, getSessionId: () => 'conv-1',
    getSessionName: () => 'Fix cart' },
    getContextUsage: () => ctx.usage, compact: o => ctx.compactCalls.push(o), compactCalls: [], usage: undefined, ui: {} };
  pi.ctx = ctx; pi.studioCalls = [];
  events.on('piagent:studio.call', data => { pi.studioCalls.push(data); data.reply({ ok: true, status: 200, body: {} }); });
  pi.fire = async (name, event = {}) => { let last; for (const fn of handlers[name] ?? []) last = (await fn(event, ctx)) ?? last; return last; };
  pi.attest = () => events.emit('piagent:tools.attest', { v: 1, tools: ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'].map(name => ({ name, source: 'piagent-sandbox' })) });
  return pi;
}
