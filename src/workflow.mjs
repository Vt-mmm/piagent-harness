import { LANE_LIMITS, patchStats, changeLane, lanePolicy } from './risk-lanes.mjs';
import { isCheckCommand, isReadOnlyCommand, checkPassed, onlyNonCode } from './checks.mjs';
import { currentPlan, planText, unfinished } from './plan.mjs';
import { briefCounts, decisionsText, ledgerGuard, ledgerOf, ledgerWords, saveLedger, setStatus, settleLedger, changedSince } from './ledger.mjs';
import { reviewUnavailableReason } from './patch.mjs';
import { failureCode } from './failure.mjs';

// The process layer of the company harness: a plan for multi-step work, the
// repository's checks after a code change, an independent review of the patch.
// Studio's Harness sets the policy. "suggest" tells the agent and records what
// happened; "require" is enforced here, before a code-changing turn ends: the
// agent is sent back at most max_fix_loops times for the checks, and at most
// that many times again for the review (the two counters are separate).
const MODES = ['off', 'suggest', 'require'];
export function workflowPolicy(state) {
  const config = state?.workflow ?? {}, mode = value => MODES.includes(value) ? value : 'suggest';
  const loops = Number.isInteger(config.max_fix_loops) && config.max_fix_loops >= 0 && config.max_fix_loops <= 3 ? config.max_fix_loops : 2;
  // A review needs a review helper; without one in the Harness it is off.
  const review = (state?.roles ?? []).includes('review') ? mode(config.review) : 'off';
  return { plan: mode(config.plan), verify: mode(config.verify), review, maxFixLoops: loops, lanes: config.lanes !== false };
}

export const PLAN_REFUSALS = 3;
export const BASELINE_ENTRY = 'agent-watch-baseline';
export function pendingBaseline(entries) {
  const last = entries.filter(e => e.type === 'custom' && e.customType === BASELINE_ENTRY).at(-1)?.data;
  return last?.settled === false && typeof last.digest === 'string' ? last : null;
}

// What happened in one run (one member message, or one round of a checklist).
export class RunProcess {
  constructor(policy, { request = '', complex = false, checks = { commands: [] } } = {}) {
    Object.assign(this, { policy, request: String(request), complex, checks, startDigest: null, startHead: null, mutations: 0, lastCheck: null, checksRun: 0, checksFailed: 0,
      reviews: 0, blocking: 0, blockingOpen: 0, verifyLoops: 0, reviewLoops: 0, planUpdated: false, planRefusals: new Set(), planSkipped: false, unplannedChange: false,
      unknownTools: 0, changed: false, verified: false, docsOnly: false, approvalDeclined: false, reviewed: false, reviewUnavailable: false, outcome: null, legacyOutcome: null,
      ledger: [], disputes: [], verifyFails: [], claimsAsked: false, claimsAt: null, claimsRechecked: false, claimsDone: false, mainReviews: 0, minorFindings: 0,
      sentAt: null, sentDigest: null, rejudged: false, reviewSettled: false, decideAsked: false,
      lane: null, laneStats: null, laneDigest: null, webLookups: 0, editedPaths: new Set(), ownPaths: new Set(), tools: [] });
  }
  // The report's old single counter: both kinds of send-back.
  get fixLoops() { return this.verifyLoops + this.reviewLoops; }
  planMissing(plan) { return this.policy.plan === 'require' && this.complex && !this.planUpdated && !unfinished(plan); }
  // Plan "require": the edits of a complex task are refused until a plan exists
  // (write and edit, and any command once a command changed files without one).
  beforeEdit(name, plan, answer) {
    if (!this.planMissing(plan) || !(['write', 'edit'].includes(name) || (name === 'bash' && this.unplannedChange))) return;
    if (!this.planRefusals.has(answer) && this.planRefusals.size >= PLAN_REFUSALS) { this.planSkipped = true; return; }
    this.planRefusals.add(answer);
    throw Error('managed-plan-required: this is a multi-step task. Write a checklist with update_plan first, then repeat this call.');
  }
  changedWithoutPlan() { this.unplannedChange = true; this.planSkipped = true; }
  // One finished tool call. `output` is the tool's text; `digestOf` reads the code's digest now.
  async afterTool({ name, input, isError, output = '' }, digestOf) {
    const ok = !isError;
    if (['write', 'edit'].includes(name) && ok && typeof input?.path === 'string') { this.editedPaths.add(input.path); this.ownPaths.add(input.path); }
    if (name === 'bash' && isCheckCommand(input?.command, this.checks.commands)) {
      const passed = checkPassed({ command: input.command, isError, output });
      this.checksRun += 1; if (!passed) this.checksFailed += 1;
      this.lastCheck = { ok: passed, digest: await digestOf(), mutations: this.mutations };
    // A command may change files, so it counts. Without a git repository to
    // compare against, one that only reads does not.
    } else if (['write', 'edit'].includes(name) && ok || name === 'bash' && (this.startDigest !== null || !isReadOnlyCommand(input?.command))) this.mutations += 1;
  }
  verifiedOn(digest) {
    const c = this.lastCheck;
    return !!c?.ok && (digest !== null && c.digest !== null ? c.digest === digest : c.mutations === this.mutations);
  }
  // Version 2 adds whether code was changed without the required plan and how
  // many calls named no tool. Version 3 adds helper objections, those the
  // agent answered and the disagreements handed to the member ("disputed");
  // older versions get the outcome the run would have had without that.
  report(plan, version = 1) {
    const steps = (this.planUpdated || unfinished(plan) ? plan?.plan ?? [] : []).filter(p => p.status !== 'deferred');
    const fallback = this.changed ? 'interrupted' : 'no_change', count = n => Math.min(n, 1000);
    return { version, policy: { plan: this.policy.plan, verify: this.policy.verify, review: this.policy.review }, changed: this.changed,
      plan_steps: steps.length, plan_done: steps.filter(p => p.status === 'completed').length, checks: count(this.checksRun), checks_failed: count(this.checksFailed),
      verified: this.verified, reviews: count(this.reviews), reviewed: this.reviewed, blocking: count(this.blocking), blocking_open: Math.min(this.blockingOpen, this.blocking, 1000),
      fix_loops: this.fixLoops, outcome: (version === 3 ? this.outcome : this.legacyOutcome) ?? fallback,
      ...(version >= 2 ? { plan_skipped: this.planSkipped, unknown_tools: count(this.unknownTools) } : {}),
      ...(version === 3 ? { objections: count(briefCounts(this).objections), objections_answered: count(briefCounts(this).answered), disputes: count(this.disputes.length) } : {}) };
  }
}

// The guidance a policy adds to the main agent's system prompt.
export function workflowPrompt(policy, checks) {
  const lines = [];
  if (policy.plan !== 'off') lines.push(`- Plan: for work with several steps keep a checklist with update_plan and update it as you go. When the member asks for several items (plans, files,
tickets), put every item in the checklist and work through all of them; do not end your turn to report between items.${policy.plan === 'require' ? ' For a complex task, file edits are ' +
    'refused until a plan exists. A checklist left with pending steps sends you back to the next one until every step is completed or deferred: if you cannot go on without the member, ask ' +
    'with ask_user. Mark a step deferred only when the member asked to leave it for later or it is no longer needed; never mark completed a step you did not do.' : ''}`);
  if (policy.verify !== 'off') {
    const list = checks.commands.length ? `${checks.commands.map(c => '`' + c + '`').join(', ')}${checks.source === 'detected' ? ' (detected; the repository declares none in AGENTS.md "## ' +
      'Checks")' : ''}` : 'none declared: choose the tests, type check or build that cover the change';
    lines.push(`- Verify: after changing code, run the repository checks that cover the change and fix failures before you finish. A filtered run (-k, --grep, --testNamePattern) or --version
is not a check. Repository checks: ${list}.${policy.verify === 'require' ? ' The turn does not end until a check has passed on the final code.' : ''}`);
  }
  const severities = ' Blocking findings: fix them, or reject one with resolve_objection and the reviewer judges your reason; a disagreement that remains goes to the member. Major findings: ' +
    'fix them or reject them with resolve_objection; no new review follows. Minor findings are listed for the member and need nothing.';
  if (policy.review !== 'off') lines.push(policy.review === 'require' ? `- Review: when you finish, the harness reviews the final patch with an independent reviewer, and after a fix only
what you changed; do not ask for a review yourself.${severities}`
    : `- Review: when your code change is finished, ask the review helper (delegate role "review") once; ask again only after fixing blocking findings.${severities}`);
  if (policy.lanes && (policy.verify !== 'off' || policy.review !== 'off')) {
    const L = LANE_LIMITS;
    lines.push(`- Size: the process follows the size of your change. A small change (at most ${L.tinyFiles} files and ${L.tinyLines} changed lines, no migration, auth, security, CI, test,
dependency or AGENTS.md file) ends after its checks, without a review: do not ask for one. A risky change (a complex request, one of those files, more than ${L.riskyFiles} files or
${L.riskyLines} lines) must pass the checks${policy.review !== 'off' ? ' and the harness review' : ''} even where they are only suggested. Editing a test or CI file makes the change risky.`);
  }
  if (!lines.length) return '';
  return `\n\nProcess for code changes (company Harness):\n${lines.join('\n')}\nIf a check cannot run because the machine lacks something (a runtime, Docker, a database or another service,
the network), do not stop there: request the approval that makes it run or ask the member with ask_user; never install or start anything without that approval.\nA command stops after 10
minutes and anything left running in the background stops when the turn ends: run the checks that cover your change first and a long suite in parts.`;
}

const findingText = f => `[${f.severity}]${f.file ? ` ${f.file}${f.line ? ':' + f.line : ''}` : ''} — ${f.issue}${f.evidence ? `\n   Evidence: ${f.evidence}` : ''}`;
export { findingText };

// One settle of the main agent. Decides whether code changed, whether a check
// passed on the final code and whether the final patch was reviewed. With
// "require" the harness acts (asks for checks, runs the review, sends blocking
// findings back) within max_fix_loops per kind. Returns { continue, entries }
// for Pi's agent_before_settle: a send-back is an entry that keeps the agent
// going; notes and the final status are entries too.
export async function gateStep(h, { aborted = false, outcome = 'completed' } = {}) {
  const run = h.run, configured = run.policy, entries = [];
  let policy = configured;
  const stopped = () => aborted || outcome === 'aborted' || outcome === 'error';
  const entry = (content, details, customType = 'agent-watch-process') => entries.push({ type: 'custom_message', customType, content, display: true, details });
  const note = async (content, details) => { entry(content, details); };
  const send = async (content, details) => { entry(content, details); h.nextPurpose = 'harness'; };
  const laneOf = async digest => {
    if (!configured.lanes) return configured;
    if (run.laneDigest === null || run.laneDigest !== digest) {
      let stats = null;
      try { stats = patchStats(await h.patchSnapshot?.()); } catch { /* unreadable: standard */ }
      run.lane = changeLane(stats, { complex: run.complex, editedPaths: [...run.editedPaths] }); run.laneStats = stats ? { files: stats.files, lines: stats.lines } : null; run.laneDigest = digest;
    }
    return lanePolicy(configured, run.lane);
  };
  const answerSince = at => h.assistantTextSince(at);
  let digest = null, interrupted = false, verifyGaveUp = run.verifyGaveUp ?? false, sent = false;
  for (let step = 0; step < 16 && !sent; step += 1) {
    digest = await h.digest();
    run.changed = run.startDigest !== null && digest !== null ? digest !== run.startDigest : run.mutations > 0;
    if (run.changed) run.verified = run.verifiedOn(digest);
    run.docsOnly = run.changed && onlyNonCode(run.ownPaths);
    policy = run.changed ? await laneOf(digest) : configured;
    if (stopped()) { interrupted = run.changed; break; }
    if (run.changed) {
      const reviewDigest = h.review ? await h.patchDigest() : null;
      const review = h.review, fresh = !!review && !review.stale && reviewDigest !== null && review.patchDigest === reviewDigest;
      run.reviewed = fresh;
      run.blockingOpen = fresh ? review.blocking ?? 0 : run.blockingOpen;
      // Out of fix rounds the check stays unmet, but a required review still runs.
      if (policy.verify === 'require' && !run.verified && !verifyGaveUp && run.verifyLoops >= policy.maxFixLoops) verifyGaveUp = true;
      // The member declined the approval a check needed: asking again repeats the answer.
      if (policy.verify === 'require' && !run.verified && run.approvalDeclined && run.verifyLoops > 0) verifyGaveUp = true;
      if (policy.verify === 'require' && !run.verified && !run.docsOnly && !verifyGaveUp) {
        run.verifyLoops += 1;
        const list = run.checks.commands.length ? run.checks.commands.map(c => '`' + c + '`').join(', ') : 'the tests, type check or build that cover the change';
        await send(`Harness process check: code changed in this turn, but no check has passed on the current code. Run the checks that cover your change (${list}) and fix what fails. A
filtered run or --version does not count. If a check cannot run because the machine lacks something (a runtime, Docker, a database or another service, the network), request the approval that
makes it run or ask the member with ask_user, then run it; install or start nothing without that approval. If it fails for a reason unrelated to your change, say so plainly.`,
          { phase: 'verify', loop: run.verifyLoops, maxLoops: policy.maxFixLoops, lastCheckFailed: run.lastCheck?.ok === false });
        sent = true; break;
      }
      if (policy.review === 'require' && !fresh && !run.reviewSettled) {
        const answer = run.sentAt !== null ? answerSince(run.sentAt) + decisionsText(run, 'review') : '';
        const focus = run.sentAt !== null ? changedSince(h.reviewFiles, await h.changedFiles?.()) : null;
        const previous = (review?.findings ?? []).filter(f => f.severity === 'blocking').map((f, i) => `${i + 1}. ${findingText(f)}`).join('\n');
        const brief = `Review the current patch against the member's request.\n\nChecks: ${run.verified ? 'a repository check passed on this code' : 'no check has passed on this ' +
          'code'}.${answer ? `\n\nThe main agent's answer to your previous blocking findings (the code changed after it):\n${answer}` : ''}${focus ? `\n\nSince your last review only these
files changed: ${focus.files.join(', ')}. Judge whether each previous blocking finding is fixed (repeat it when it is not) and review the changes in these files; the rest of the patch was
reviewed and has not changed.${previous ? `\nYour previous blocking findings:\n${previous}` : ''}` : ''}`;
        h.reviewFocus = focus;
        try { await h.delegate({ role: 'review', task: brief }, h.signal, { harness: true }); }
        catch (error) {
          run.reviewUnavailable = !stopped(); run.reviewUnavailableReason = reviewUnavailableReason(error?.message); interrupted = stopped();
          if (run.reviewUnavailable) try { h.append('agent-watch-failure-detail', { role: 'review', code: failureCode(error?.message) }); } catch { /* the report still says it */ }
          break;
        } finally { h.reviewFocus = null; }
        continue;
      }
      if (policy.review === 'require' && fresh && (review.blocking ?? 0) > 0 && !run.reviewSettled) {
        const blocking = (review.findings ?? []).filter(f => f.severity === 'blocking'), list = blocking.map((f, i) => `${i + 1}. ${findingText(f)}`).join('\n');
        if (run.sentDigest === digest && !run.rejudged) {
          // The agent answered the findings without changing the code: the reviewer reads that answer once.
          run.rejudged = true;
          await note('Harness: the main agent answered the review instead of changing the code; the reviewer judges its answer.', { phase: 'rejudge', role: 'review' });
          const brief = `Judge your previous blocking findings on this patch again. The main agent answered them without changing the code:\n${answerSince(run.sentAt) || '(no ' +
            'answer)'}${decisionsText(run, 'review')}\n\nYour previous blocking findings:\n${list}\n\nKeep a finding as blocking when the answer does not hold against the code; leave it out
when the answer is right.`;
          try { await h.delegate({ role: 'review', task: brief }, h.signal, { harness: true }); }
          catch { if (stopped()) { interrupted = true; break; } run.reviewSettled = true; }
          continue;
        }
        if (run.sentDigest === digest) {
          // It heard the answer and kept its findings: the member decides.
          run.reviewSettled = true; run.disputes.push({ source: 'review' });
          for (const item of ledgerOf(run)) if (item.source === 'review' && item.kind === 'blocking' && ['open', 'rejected'].includes(item.status)) setStatus(item, 'disputed');
          await note(`Harness: the main agent and the review subagent still disagree after two rounds; the member decides.\n${list}`, { phase: 'dispute', role: 'review',
            findings: blocking.slice(0, 10) });
        } else if (run.reviewLoops >= policy.maxFixLoops) run.reviewSettled = true;
        else {
          run.reviewLoops += 1; run.sentDigest = digest; run.sentAt = h.messageCount();
          await send(`Harness review of the current patch found ${blocking.length} blocking issue(s):\n${list}\nFix them, or reject one with resolve_objection (what you checked and why): a
rejection without a code change goes back to the reviewer, who judges it. After your fix the reviewer checks these findings and the files you changed, not the whole patch again.`,
            { phase: 'review', loop: run.reviewLoops, maxLoops: policy.maxFixLoops, findings: blocking.slice(0, 10) });
          sent = true; break;
        }
      }
    }
    // Claims the verify subagent marked failed, under a required verify: back
    // to the agent once, then checked again with its answer; still failing, the member decides.
    if (policy.verify === 'require' && run.verifyFails.length && !run.claimsDone) {
      const fails = run.verifyFails, list = fails.map((v, i) => `${i + 1}. ${v.claim}${v.evidence ? `\n   Evidence: ${v.evidence}` : ''}`).join('\n'), claims = fails.slice(0,
        10).map(v => ({ claim: v.claim }));
      if (!run.claimsAsked) {
        run.claimsAsked = true; run.claimsAt = h.messageCount();
        await send(`Harness: the verify subagent marked ${fails.length} claim(s) as failed:\n${list}\nFix the cause, or reject a verdict with resolve_objection (what you checked and why).
The verify subagent then checks these claims again with your answer.`, { phase: 'claims', claims });
        sent = true; break;
      }
      if (!run.claimsRechecked) {
        run.claimsRechecked = true;
        await note("Harness: the verify subagent checks the failed claims again with the main agent's answer.", { phase: 'rejudge', role: 'verify' });
        try { await h.delegate({ role: 'verify', task: `Check these claims again on the current code; they were marked failed before:\n${list}\n\nThe main agent's
answer:\n${answerSince(run.claimsAt) || '(no answer)'}${decisionsText(run, 'verify')}\n\nA claim passes only on evidence you see yourself. It stays failed when it does not hold and the
result the member asked for depends on it. When the answer shows the claim is not part of what the member asked and the result does not depend on it, mark it unverifiable and say why.` },
          h.signal, { harness: true }); }
        catch { if (stopped()) { interrupted = run.changed; break; } }
        continue;
      }
      run.claimsDone = true; run.disputes.push({ source: 'verify' });
      for (const item of ledgerOf(run)) if (item.source === 'verify' && ['open', 'accepted', 'rejected'].includes(item.status)) setStatus(item, 'disputed');
      await note(`Harness: the main agent and the verify subagent still disagree after two rounds; the member decides.\n${list}`, { phase: 'dispute', role: 'verify', claims });
    }
    // A rejected premise objection goes back to its helper; then what the main
    // agent never decided is asked once (ledger.mjs).
    const again = await settleLedger(h, run, { note, send, signal: h.signal });
    if (again === 'sent') { sent = true; break; }
    if (again) continue;
    break;
  }
  run.verifyGaveUp = verifyGaveUp;
  if (sent) return { continue: true, entries };
  // However the code was changed, a complex task under plan "require" that never had a plan is reported as changed without it.
  if (run.changed && run.planMissing(currentPlan(h.entries()))) run.planSkipped = true;
  run.legacyOutcome = !run.changed ? 'no_change' : interrupted ? 'interrupted' : run.blockingOpen > 0 ? 'blocking_open'
    : policy.verify !== 'off' && !run.verified && !run.docsOnly ? 'unverified' : run.reviewUnavailable ? 'review_unavailable' : policy.review !== 'off' && !run.reviewed ? 'unreviewed' : 'clean';
  run.outcome = run.legacyOutcome !== 'interrupted' && run.disputes.length ? 'disputed' : run.legacyOutcome;
  const settled = run.outcome !== 'interrupted';
  h.append(BASELINE_ENTRY, { digest: settled ? digest : run.startDigest, settled, outcome: run.outcome, ...(run.startHead ? { head: run.startHead } : {}), ...(settled ? {}
    : { paths: [...run.ownPaths].slice(0, 2000) }) });
  saveLedger(h);
  run.final = true;
  if (!run.changed && !run.disputes.length && !ledgerOf(run).length) return { continue: false, entries };
  const finalPlan = currentPlan(h.entries()), planOpen = run.planUpdated ? finalPlan?.plan?.filter(p => p.status === 'pending' || p.status === 'in_progress').length ?? 0 : 0;
  const status = { verified: run.verified, reviewed: run.reviewed, blockingOpen: run.blockingOpen, checks: run.checksRun, fixLoops: run.fixLoops, verifyLoops: run.verifyLoops,
    reviewLoops: run.reviewLoops,
    ...(planOpen ? { planOpen } : {}), ...(run.planSkipped ? { planSkipped: true } : {}), ...(run.disputes.length ? { disputes: run.disputes.length } : {}), ...(run.changed ? {}
      : { unchanged: true }) };
  const words = [...(run.changed ? [run.verified ? 'a check passed on the final code' : policy.verify === 'off' ? null : run.docsOnly ? 'only documentation changed: no check needed' : 'no ' +
    'check passed on the final code',
    run.reviewed ? (run.blockingOpen ? `review: ${run.blockingOpen} blocking issue(s) still open` : 'review: no blocking issue') : policy.review === 'off' ? null : run.reviewUnavailable
      ? `review could not run (${run.reviewUnavailableReason})` : 'not reviewed',
    run.planSkipped ? 'code was changed before the required plan existed' : null, planOpen ? `plan: ${planOpen} step(s) not completed` : null] : []),
    run.disputes.length ? `${run.disputes.length} disagreement(s) between the main agent and a subagent go to the member` : null, ledgerWords(run)].filter(Boolean);
  entry(`Process status for this turn: ${run.changed ? 'code changed' : 'no code changed'}; ${words.join('; ') || 'no process step configured'}.`,
    { phase: 'final', outcome: run.outcome, ...status, ...(run.reviewUnavailable ? { reviewUnavailable: run.reviewUnavailableReason } : {}), policy: { verify: policy.verify, review: policy.review },
      ...(configured.lanes && run.lane ? { lane: run.lane, ...(run.laneStats ? { size: run.laneStats } : {}) } : {}) });
  return { continue: false, entries };
}
