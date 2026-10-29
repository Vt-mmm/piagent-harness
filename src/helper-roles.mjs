import { isCheckCommand } from './checks.mjs';

// The helpers a main agent may delegate to, in the Harness's order. Each is
// optional: only those the company Harness enables are offered. Scout reads the
// code, research also reads the web, verify re-checks a result with the
// repository's checks and primary sources, review judges the patch. None of
// them changes files, and each hands its result back through a schema tool.
export const HELPER_ROLES = Object.freeze(['scout', 'research', 'verify', 'review']);
export const helperRoles = state => HELPER_ROLES.filter(role => (state?.roles ?? []).includes(role));

// Each helper role runs at most this often per user message. Studio may set
// it (the optional helper_slots field, passed on as helperCalls); a Studio
// without the field gets the old fixed 8.
export const DEFAULT_HELPER_CALLS = 8;
export function helperCallLimit(state) {
  const n = state?.helperCalls;
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : DEFAULT_HELPER_CALLS;
}
// The Harness's workflow.main_web_lookups (0 to 5, default 0): quick web calls the main agent may make itself.
export const MAIN_WEB_LOOKUPS_MAX = 5;
export function mainWebLookups(state) {
  const n = state?.workflow?.main_web_lookups;
  return Number.isInteger(n) && n >= 0 && n <= MAIN_WEB_LOOKUPS_MAX ? n : 0;
}
export function limitedWebTools(tools, currentRun, limit) {
  return tools.map(tool => ({ ...tool, execute: async (...args) => {
    const run = currentRun();
    if (run && ++run.webLookups > limit) throw Error(`managed-web-lookups-spent: you used your ${limit} quick web lookup(s) for this message. Hand the rest of the web work to the research
helper (delegate role "research").`);
    return tool.execute(...args);
  } }));
}

const WIDE_READING = 'when understanding the task needs more reading than a few batches of files, such as a flow across many modules of an unfamiliar codebase';
export function helperPrompt(roles) {
  const lines = [];
  if (roles.includes('scout')) lines.push(`Use the scout helper (delegate role "scout") ${WIDE_READING}, and work from its file:line findings; do small lookups yourself.`);
  if (roles.includes('research')) lines.push('Use the research helper (delegate role "research") for anything on the web (current information, news, library and API docs, releases, error ' +
    'messages), together with the code when needed; give it the question and the answer you need, and work from its summary.');
  if (roles.includes('verify')) lines.push('Before you report a non-trivial result as done, you may have the verify helper (delegate role "verify") confirm it independently: it runs the ' +
    'repository checks on the current code and checks claims against the code and primary sources, answering pass, fail or unverifiable with evidence.');
  if (lines.length) lines.push('A helper sees the member\'s request next to your brief and may object to the brief with evidence (brief_issues); each objection gets an id. You decide, but ' +
    'check each one at the place its evidence names and record your decision with resolve_objection: accepted with what you changed, or rejected with what you checked and why. An objection ' +
    'that the brief rests on a wrong premise or conflicts with the request refuses file changes until you decide it; a rejected one goes back to the helper, and a disagreement that remains ' +
    'goes to the member, as does a second objection from the same helper for one message.');
  if (lines.length) lines.push('One helper per role works on a brief. Only when the member asks for several of one role ("use 3 subagents", "dùng 2 helper"), run up to 3 in one delegate ' +
    'call: copies for independent answers on the same brief, or split for shares of the work, with member_words quoting the member\'s request. Never add helpers on your own.');
  return lines.length ? ' ' + lines.join(' ') : '';
}
const USES = {
  scout: () => 'scout: before changing an area you do not know that spans more files than you can read in a few batches. It reads only the project, no web, and answers with file:line facts.',
  research: () => 'research: anything on the web (current information, news, library or API documentation, releases, error messages), with the code when needed. You get its summary with sources.',
  verify: () => 'verify: an independent check of a result: it runs the repository checks on the current code (offline, the project is read-only for its commands) and confirms claims against ' +
    'the code and primary sources. It answers pass, fail or unverifiable per claim, with evidence.',
  review: () => 'review: an independent review of the current patch. To review work committed in earlier turns, pass since: the commit, branch or HEAD~N it started from. Ask once, when your ' +
    'change is finished, and again only after fixing blocking findings; under a required review the harness reviews the final patch and refuses your own call.',
};
export const delegateDescription = (roles, limit) => `Hand work to a helper with its own context. Helpers read the project but cannot change files or call helpers.
${roles.map(r => USES[r]()).join(' ')} A lookup that one grep or read answers stays with you. Write the task as a brief the helper can act on alone: the goal, what to find or check, where to
start and what you already know or ruled out, and the answer you need. One call per helper runs at a time; each can be called again, up to ${limit} times per user message.`;

export const BRIEF_CHECK = 'The member\'s request is quoted above the brief, and the brief is a reading of it. Check the brief against the request and against what you find. Object only when ' +
  'acting on the brief as written would give a wrong or wasted answer: it states as fact something the code or sources contradict, it conflicts with the request, it is too ambiguous to ' +
  'answer, or it asks for work the request does not need. A guess the brief marks as a guess that turns out empty is not an objection: say what you found. Report objections in brief_issues ' +
  'of your result tool, with evidence (file:line, the member\'s words or a source URL); never answer a different question in silence.';
const END = 'Hand your result in with the tool named below, once, as your last step; text outside the tool is only your explanation. You cannot change files or delegate.';
export const SCOUT_PROMPT = `Scout the codebase for the assigned question. Search first (grep, find), then read only the parts that matter. Answer with facts the main agent can act on:
file:line, short quotes, what calls what, and where you looked and found nothing. You have no web access. ${BRIEF_CHECK} ${END} Tool: submit_brief_check.`;
export const RESEARCH_PROMPT = `Research the assigned question. Read only the needed source; use web_search or web_fetch for external documentation. Answer with facts the main agent can act
on: file:line, short quotes, sources, and what you checked and found nothing in. ${BRIEF_CHECK} ${END} Tool: submit_brief_check.`;
export const REVIEW_PROMPT = `You review a patch for the company coding assistant. The patch snapshot below is immutable; read only the files it changed to check the code around it. Report
only problems that matter: incorrect behaviour, regressions, security issues, parts of the request that are missing, changed behaviour without tests. Do not report style or preferences.
Classify each finding: blocking (must be fixed before the work is done), major, or minor. ${BRIEF_CHECK} ${END} Tool: submit_review (an empty findings list when the patch is fine).`;
export const VERIFY_PROMPT = `You verify a result for the company coding assistant, independently of whoever produced it. For each claim or requirement in the brief: read the code it is
about, run the repository checks that cover it with bash, and confirm external facts against primary sources. Commands run offline and the project is read-only for them: a check that must
write into the project or reach the network fails for that reason. Report such a claim as unverifiable and say why; do not work around the sandbox. Never mark a claim pass without evidence
you saw. ${BRIEF_CHECK} ${END} Tool: submit_verdicts.`;

// What each helper may use. Every helper's project is read-only; verify also runs commands there.
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
export const HELPER_SETUP = {
  scout: { web: false, commands: false, prompt: SCOUT_PROMPT, label: 'Scout', result: 'submit_brief_check' },
  research: { web: true, commands: false, prompt: RESEARCH_PROMPT, label: 'Research', result: 'submit_brief_check' },
  verify: { web: true, commands: true, prompt: VERIFY_PROMPT, label: 'Verify', result: 'submit_verdicts' },
  review: { web: false, commands: false, prompt: REVIEW_PROMPT, label: 'Review', result: 'submit_review' },
};

// A repository check a helper ran counts for the run like one the main agent
// ran, when the code was the same before and after it.
export function countedCheck(h, tool) {
  if (tool.name !== 'bash') return tool;
  return { ...tool, execute: async (...args) => {
    const folder = async () => { try { return await (h.folderDigest ?? h.digest).call(h); } catch { return null; } };
    const counted = h.run && isCheckCommand(args[1]?.command, h.run.checks.commands), before = counted ? await folder() : null;
    let result, isError = true;
    try { result = await tool.execute(...args); isError = !!result?.isError; return result; }
    finally {
      const after = counted && before !== null ? await folder() : null;
      if (after !== null && after === before) await h.run.afterTool({ name: 'bash', input: args[1], isError, output: (result?.content ?? []).map(p => p.text ?? '').join('\n') }, () => h.digest());
    }
  } };
}
