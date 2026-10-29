import path from 'node:path';
import { CHANNELS, CONTRACT_VERSION } from './bus.mjs';
import { StudioClient } from './studio.mjs';
import { repositoryChecks, readAgentsFiles } from './checks.mjs';
import { PLAN_ENTRY, currentPlan, planTool } from './plan.mjs';
import { RunProcess, gateStep, workflowPolicy, workflowPrompt } from './workflow.mjs';
import { Continuation, TURN_END_ENTRY, asksToContinue, turnEnd, turnEndText } from './continuation.mjs';
import { resolveTool, ledgerGuard } from './ledger.mjs';
import { delegateDescription, helperCallLimit, helperPrompt, helperRoles, limitedWebTools, mainWebLookups } from './helper-roles.mjs';
import { delegateParameters, SPEC_PROMPT } from './helper-settlement.mjs';
import { delegateTool, runHelper } from './helper-run.mjs';
import { childSessions } from './children.mjs';
import { gitReader, readChangedFiles, readHead, readPatchSnapshot } from './patch.mjs';
import { workflowContextPrompt, workflowContextTool, currentWorkflow } from './workflow-context.mjs';
import { deliveryPrompt, discoverDeliveryContext } from './delivery-context.mjs';
import { TeamMemory, memoryPrompt, memoryTools } from './memory.mjs';
import { CheckLessons } from './memory-lessons.mjs';
import { SkillFeedback } from './skill-feedback.mjs';
import { ToolFailureLog } from './tool-failures.mjs';
import { CompactionPolicy, planInstructions } from './compaction.mjs';
import { askTool } from './member-questions.mjs';
import { ToolsetGuard, pinnedSandboxRoot } from './guard.mjs';
import { nonceOk, serveNonce } from './bus-nonce.mjs';
import { sendProcessReport } from './report.mjs';
import { StatusFile, agentDir } from './status-file.mjs';
import { installCompanyUi, registerStyleCommand } from './ui.mjs';
import { textOf } from './redact.mjs';

// piagent-harness: company mode on stock Pi 1.4.0. The completion gate, the
// helpers, the ledger, team memory, the member's questions, the checklist, the
// company Terminal and the process report. It talks to piagent-provider and
// piagent-sandbox only through Pi's event bus (package-contract.md).
const CONTEXT_PROMPT_BUDGET = 60_000;

// run.state as the provider sends it: { runId, harness: { thinking, bypassMode, helperCalls (the helper roles
// the Harness has, or a number: the call limit), protocol (process version) } }, with the fields the harness
// also needs (workflow, capabilities, scope, team, skills, helperLimit) added by the provider as it learns them.
export function normalizeRunState(data, previous = null) {
  const harness = data.harness ?? {}, roles = Array.isArray(harness.roles) ? harness.roles : Array.isArray(harness.helperCalls) ? harness.helperCalls : previous?.roles ?? [];
  return { ...previous, ...data, ...harness, roles, helperLimit: Number.isInteger(harness.helperLimit) ? harness.helperLimit : typeof harness.helperCalls === 'number' ? harness.helperCalls
    : previous?.helperLimit };
}

export default function piagentHarness(pi, options = {}) {
  const events = pi.events, studio = new StudioClient(events);
  const stateDir = options.stateDir ?? path.join(agentDir(), 'piagent-harness');
  const cwd = options.cwd ?? process.cwd(), git = options.git ?? gitReader(cwd);
  const loadSdk = options.loadSdk ?? (() => import('@earendil-works/pi-coding-agent'));
  const now = options.now ?? Date.now;
  const toolFailures = new ToolFailureLog(studio, { now });
  const compaction = new CompactionPolicy(now);
  // Inside a bundle (the sandbox folder is pinned by its manifest) or when asked, the bus carries a startup secret.
  const pinned = options.sandboxRoot ?? pinnedSandboxRoot(import.meta.filename);
  const handshake = options.nonce ?? !!pinned ? serveNonce(events) : null;
  const guard = new ToolsetGuard({ events, getTools: () => pi.getAllTools?.() ?? [], pinned, busReady: handshake ? handshake.complete : null, report: bad => reportBlocked(bad) });
  let state = null, policy = workflowpolicyOff(), checks = { source: 'detected', commands: [] };
  let current = { ctx: null }, continuation = null, memory = null, lessons = null, feedback = null, status = null, ui = null, brief = null, helpersRunning = 0, helpersTotal = 0;
  let askActive = false, roundStarted = 0, delegateRegistered = false, memoryRegistered = false, mode = 'ask';

  function workflowpolicyOff() { return { plan: 'off', verify: 'off', review: 'off', maxFixLoops: 2, lanes: false }; }
  const entries = () => current.ctx?.sessionManager?.getEntries?.() ?? [];
  const lastUserText = () => textOf(entries().findLast(e => e.type === 'message' && e.message?.role === 'user')?.message?.content);

  // The gate's host: everything the run needs from Pi, the repository and the helpers.
  const h = {
    cwd, git, studio, helperCalls: new Map(), review: null, reviewFiles: null, reviewFocus: null, nextPurpose: null, run: null, signal: undefined,
    get state() { return state; }, get policy() { return policy; },
    entries, append: (type, data) => pi.appendEntry(type, data),
    note: async (content, details, customType = 'agent-watch-process') => pi.sendMessage({ customType, content, display: true, details }, { triggerTurn: false }),
    messageCount: () => entries().length,
    assistantTextSince: at => entries().slice(at ?? entries().length).filter(e => e.type === 'message'
      && e.message?.role === 'assistant').map(e => textOf(e.message.content)).join('\n').trim().slice(-3000),
    patchSnapshotFull: () => readPatchSnapshot(git, cwd, { base: h.run?.startHead ?? null }),
    patchSnapshot: () => h.patchSnapshotFull(),
    digest: async () => { try { return (await h.patchSnapshotFull()).digest; } catch { return null; } },
    patchDigest: async () => h.digest(),
    patchDigestSince: async base => { try { return (await readPatchSnapshot(git, cwd, { base })).digest; } catch { return null; } },
    changedFiles: async () => { try { return await readChangedFiles(git, cwd, h.run?.startHead ?? null); } catch { return null; } },
    delegate: (args, signal, opts) => runHelper(h, args.role, args, signal, !!opts?.harness),
    children: null,
  };
  h.children = (() => {
    const real = childSessions({ events, cwd, loadSdk, loadAi: options.loadAi, extraTools: role => memory && state?.capabilities?.includes('memory') && role !== 'verify' ? memoryTools(memory, { readOnly: true }) : [] });
    return { async create(spec) {
      const child = await real.create(spec);
      helpersRunning += 1; helpersTotal += 1; ui?.redraw(); status?.set('working', { helpers: helpersRunning });
      return { ...child, async close() { await child.close(); helpersRunning -= 1; ui?.redraw(); status?.set('working', { helpers: helpersRunning }); } };
    } };
  })();
  const newRun = async (request, complex) => {
    const run = new RunProcess(policy, { request, complex, checks });
    // The digest is taken against the commit the run starts from, so a commit made during it still counts as its change.
    run.startHead = await readHead(git); h.run = run; run.startDigest = await h.digest();
    h.review = null; h.reviewFiles = null;
    return run;
  };
  const reportBlocked = async bad => {
    const answer = await studio.fetch('/studio/v1/managed/tool-failures', { body: { os: process.platform, failures: [{ id: crypto.randomUUID(), tool: 'other', role: 'main', code: 'managed_toolset_untrusted',
      input: bad.map(b => b.name).join(','), error: JSON.stringify(bad).slice(0, 1000), duration_ms: 0, age_ms: 0, engine: 'none' }] } });
    return answer.ok;
  };

  // What the provider tells the harness about the run (policy, roles, features, scope).
  events.on(CHANNELS.runState, data => {
    if (!data || data.v > CONTRACT_VERSION || !nonceOk(events, data)) return;
    state = normalizeRunState(data, state); studio.setState(state);
    policy = state.workflow ? workflowPolicy(state) : workflowpolicyOff();
    if (typeof state.permissionMode === 'string') mode = state.permissionMode;
    registerLateTools(); ui?.redraw();
  });
  events.on(CHANNELS.permissionMode, data => { if (nonceOk(events, data) && ['ask', 'full', 'bypass'].includes(data?.mode)) { mode = data.mode; ui?.redraw(); } });
  guard.start();

  // Tools that depend on what Studio enables are registered when the state arrives.
  function registerLateTools() {
    const roles = helperRoles(state);
    if (roles.length && !delegateRegistered) {
      delegateRegistered = true;
      pi.registerTool(delegateTool(h, roles, delegateParameters(), delegateDescription(roles, helperCallLimit(state)) + SPEC_PROMPT));
    }
    if (state?.capabilities?.includes('memory') && !memoryRegistered && memory) { memoryRegistered = true; for (const tool of memoryTools(memory)) pi.registerTool(tool); }
  }
  pi.registerTool(planTool(async plan => { pi.appendEntry(PLAN_ENTRY, { ...plan, at: new Date().toISOString() }); if (h.run) h.run.planUpdated = true; }));
  // While the member is asked a question, the state file says "question" instead of "permission".
  const ask = askTool(), askRun = ask.execute;
  ask.execute = async (...args) => { askActive = true; try { return await askRun(...args); } finally { askActive = false; } };
  pi.registerTool(ask);
  pi.registerTool(resolveTool(() => h.run));
  pi.registerTool(workflowContextTool(() => ({ getEntries: entries, appendCustomEntry: (t, d) => pi.appendEntry(t, d) })));
  registerStyleCommand(pi, { stateDir: options.styleDir });

  pi.on('session_start', async (_event, ctx) => {
    current.ctx = ctx;
    const id = ctx.sessionManager?.getSessionId?.() ?? `local-${process.pid}`;
    status = new StatusFile({ conversation: id, title: ctx.sessionManager?.getSessionName?.() ?? '', project: path.basename(cwd), dir: options.statusDir });
    status.set('idle');
    memory = new TeamMemory({ studio, cwd, stateDir, conversationId: id, scope: () => state?.scope ?? null, now, changed: () => [...(h.run?.ownPaths ?? [])] });
    registerLateTools();
    checks = repositoryChecks(readAgentsFiles(cwd), cwd);
    ui = installCompanyUi(ctx, () => ({ team: state?.team?.name ?? state?.team ?? '', mode, memory: !!brief?.text, fast: !!state?.fast, bundle: state?.bundle ?? '',
      main: state?.mainLabel ?? '', effort: state?.effort ?? '', review: state?.reviewLabel ?? '', usage: ctx.getContextUsage?.(), helpers: { running: helpersRunning, total: helpersTotal } }));
  });

  // A member's message starts the gate over; Pi's auto-retry and the gate's own
  // send-backs start new agent runs of the same message and keep it.
  pi.on('before_agent_start', async (event, ctx) => {
    current.ctx = ctx;
    await guard.verify();
    if (event.messageType === 'user') {
      const text = event.prompt ?? lastUserText();
      continuation = new Continuation(policy);
      if (asksToContinue(text) && currentPlan(entries())?.plan) continuation.touched = true;
      h.helperCalls = new Map(); lessons = new CheckLessons(checks.commands, now); feedback = new SkillFeedback({ cwd, skills: state?.skills ?? [] }); feedback.request(text);
      await newRun(text, false);
      roundStarted = now();
      brief = await memory?.brief(text).catch(() => null);
      status?.set('working', { helpers: 0 });
    }
    const prompt = [workflowPrompt(policy, checks), helperPrompt(helperRoles(state)), memoryPrompt(brief), workflowContextPrompt(currentWorkflow({ getEntries: entries })),
      deliveryPrompt(discoverDeliveryContext(cwd))].join('').slice(0, CONTEXT_PROMPT_BUDGET);
    return { systemPrompt: event.systemPrompt + prompt };
  });

  pi.on('tool_call', async (event, ctx) => {
    current.ctx = ctx;
    if (!guard.checked) await guard.verify();
    const blocked = guard.onToolCall();
    if (blocked) { await guard.tell(); return blocked; }
    const run = h.run;
    if (!run) return undefined;
    try {
      run.beforeEdit(event.toolName, currentPlan(entries()), event.toolCallId.split('/')[0]);
      if (event.toolName !== 'bash') { if (['write', 'edit'].includes(event.toolName)) ledgerGuard(run, event.toolCallId); }
      else if (!/^\s*(ls|cat|grep|rg|git\s+(status|diff|log))\b/.test(String(event.input?.command ?? ''))) ledgerGuard(run, event.toolCallId);
    } catch (error) { return { block: true, reason: error.message }; }
    toolFailures.start(event); lessons?.event({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.input });
    return undefined;
  });
  pi.on('tool_result', async event => {
    const run = h.run, output = (event.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    toolFailures.end(event);
    lessons?.event({ type: 'tool_execution_end', toolCallId: event.toolCallId, isError: event.isError, result: { content: event.content, details: event.details } });
    feedback?.event({ type: 'tool_execution_start', toolName: event.toolName, args: event.input });
    if (!run) return;
    if (event.toolName === 'delegate' || event.toolName === 'update_plan') return;
    if (/managed-operation-denied/.test(output)) run.approvalDeclined = true;
    await run.afterTool({ name: event.toolName, input: event.input, isError: event.isError, output }, () => h.digest());
  });
  pi.on('ui_prompt_start', () => { status?.set('blocked', { kind: askActive ? 'question' : 'permission', helpers: helpersRunning }); });
  pi.on('ui_prompt_end', () => { status?.set('working', { helpers: helpersRunning }); });

  // Before a turn settles: the completion gate, then the checklist's next round.
  pi.on('agent_before_settle', async (event, ctx) => {
    current.ctx = ctx; h.signal = ctx.signal;
    if (!h.run) return undefined;
    const out = await gateStep(h, { aborted: ctx.signal?.aborted, outcome: event.outcome });
    if (out.continue) return out;
    const plan = currentPlan(entries()), run = h.run, failed = event.outcome === 'error', stopped = event.outcome === 'aborted';
    continuation ??= new Continuation(policy);
    const message = continuation.next({ plan, planUpdated: run.planUpdated, changed: run.changed, stopped, failed });
    sendProcessReport(events, state, run, plan);
    if (message) {
      await newRun(message.content, false); continuation.begin(plan);
      return { continue: true, entries: [...out.entries, { type: 'custom_message', ...message }] };
    }
    const ended = turnEnd(continuation, plan, { stopped, failure: failed ? { role: 'main', code: 'error' } : null });
    pi.appendEntry(TURN_END_ENTRY, ended); run.turnEnd = ended;
    return { continue: false, entries: out.entries };
  });

  pi.on('agent_settled', async (event, ctx) => {
    current.ctx = ctx;
    const run = h.run, ended = run?.turnEnd;
    // How the member's message ended is shown, not sent to the model (the entry above is not in its context).
    if (ended && (ended.state !== 'done' || ended.planSteps)) ctx.ui?.notify?.(turnEndText(ended), ended.state === 'failed' ? 'error' : 'info');
    status?.set(event.aborted ? 'done' : ended?.state === 'failed' ? 'error' : 'done', { ended: event.aborted || ended?.state === 'cancelled' ? 'stopped' : ended?.state === 'failed'
      ? 'failed' : 'done', helpers: 0 });
    const messages = entries().filter(e => e.type === 'message').map(e => e.message);
    try {
      const closed = feedback?.close({ checks: lessons?.summary.final ?? 'none', lessons: lessons?.lessons ?? [] }) ?? [];
      if (closed.length) await h.note(`Skill proposal written (nothing was changed): ${closed.map(f => path.basename(f)).join(', ')}`, { phase: 'skill-feedback' });
    } catch { /* feedback is optional */ }
    await memory?.afterRound(messages, { changedFiles: [...(run?.ownPaths ?? [])], checks: lessons?.summary, lessons: lessons?.lessons ?? [] }).catch(() => {});
    void memory?.telemetry({ ...(memory.stats ?? {}) }, event.aborted ? 'aborted' : 'answered', Math.max(0, now() - roundStarted));
  });

  // Compaction at 90% of the window, never later than 300k tokens; the plan stays word for word.
  pi.on('turn_end', async (_event, ctx) => {
    current.ctx = ctx;
    if (!compaction.due(ctx.getContextUsage?.())) return;
    compaction.started();
    ctx.compact({ customInstructions: planInstructions(entries()) });
  });
  pi.on('session_compact', async () => {
    compaction.succeeded();
    const plan = currentPlan(entries());
    if (plan?.plan?.some(p => p.status === 'pending' || p.status === 'in_progress')) {
      pi.sendMessage({ customType: 'agent-watch-plan-kept', display: false, content: `Current plan (kept verbatim across compaction; keep it up to date with update_plan):\n${plan.plan.map((p,
        i) => `${i + 1}. [${p.status}] ${p.step}`).join('\n')}` }, { triggerTurn: false });
    }
    try { brief = await memory?.brief(lastUserText()).catch(() => brief); } catch { /* keep the old brief */ }
  });
  pi.on('session_compact_failed', async event => { compaction.failed(!!event.aborted); });
  pi.on('session_shutdown', async () => { status?.remove(); await toolFailures.send(); });
}
