import { arrayArgument } from './json.mjs';
import { clip } from './redact.mjs';

// A helper hands its result back through a tool with a schema, never as JSON
// written into its answer. The tool validates and stores it in `sink`; a
// helper that never calls it has not answered in the form its role needs.
export const BRIEF_ISSUE_KINDS = ['wrong_premise', 'conflicts_with_request', 'ambiguous', 'out_of_scope'];
const issueSchema = { type: 'object', properties: { kind: { type: 'string', enum: BRIEF_ISSUE_KINDS }, detail: { type: 'string', minLength: 1, maxLength: 400 }, evidence: { type: 'string',
  maxLength: 300 } },
  required: ['kind', 'detail'], additionalProperties: false };
const issuesProp = { type: 'array', maxItems: 5, items: issueSchema, description: 'Objections to the brief, with evidence; an empty list when the brief is sound.' };
const summary = { type: 'string', minLength: 1, maxLength: 600 };
const SEVERITIES = ['blocking', 'major', 'minor'], STATUSES = ['pass', 'fail', 'unverifiable'];

export function normalizeIssues(list) {
  return (Array.isArray(list) ? list : []).filter(i => BRIEF_ISSUE_KINDS.includes(i?.kind) && typeof i.detail === 'string' && i.detail.trim()).slice(0, 5)
    .map(i => ({ kind: i.kind, detail: clip(i.detail, 400), evidence: clip(i.evidence, 300) }));
}
export function normalizeFindings(list) {
  return (Array.isArray(list) ? list : []).filter(f => SEVERITIES.includes(f?.severity) && typeof f.issue === 'string' && f.issue.trim()).slice(0, 20)
    .map(f => ({ severity: f.severity, file: clip(f.file, 300), line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : null, issue: clip(f.issue, 500), evidence: clip(f.evidence, 500) }));
}
export function normalizeVerdicts(list) {
  return (Array.isArray(list) ? list : []).filter(v => STATUSES.includes(v?.status) && typeof v.claim === 'string' && v.claim.trim()).slice(0, 40)
    .map(v => ({ status: v.status, claim: clip(v.claim, 500), evidence: clip(v.evidence, 500) }));
}

const tool = (name, description, properties, required, field, build) => sink => ({
  name, label: 'Result', description,
  parameters: { type: 'object', properties: { ...properties, brief_issues: issuesProp, summary }, required: [...required, 'summary'], additionalProperties: false },
  prepareArguments: args => arrayArgument('brief_issues')(arrayArgument(field)(args)),
  execute: async (_id, args) => {
    if (field && !Array.isArray(args?.[field])) throw Error(`managed-result-invalid: send ${field} as a list.`);
    Object.assign(sink, build(args), { brief_issues: normalizeIssues(args?.brief_issues), summary: clip(args?.summary, 600), submitted: true });
    return { content: [{ type: 'text', text: 'Result recorded. Stop here.' }], details: { role: sink.role } };
  },
});
export const resultTools = {
  submit_review: tool('submit_review', 'Hand in the review: every finding with its severity, file and line, and your objections to the brief. Call it once, as your last step.',
    { findings: { type: 'array', maxItems: 20, items: { type: 'object', properties: { severity: { type: 'string', enum: SEVERITIES }, file: { type: 'string', maxLength: 300 },
      line: { type: 'integer', minimum: 1 },
      issue: { type: 'string', minLength: 1, maxLength: 500 }, evidence: { type: 'string', maxLength: 500 } }, required: ['severity', 'issue'], additionalProperties: false } } },
    ['findings'], 'findings', args => ({ findings: normalizeFindings(args.findings) })),
  submit_verdicts: tool('submit_verdicts', 'Hand in the verdict on each claim, with the evidence you saw, and your objections to the brief. Call it once, as your last step.',
    { verdicts: { type: 'array', maxItems: 40, items: { type: 'object', properties: { claim: { type: 'string', minLength: 1, maxLength: 500 }, status: { type: 'string', enum: STATUSES },
      evidence: { type: 'string', maxLength: 500 } }, required: ['claim', 'status'], additionalProperties: false } } },
    ['verdicts'], 'verdicts', args => ({ verdicts: normalizeVerdicts(args.verdicts) })),
  submit_brief_check: tool('submit_brief_check', 'Hand in your objections to the brief (an empty list when it is sound) and a one-sentence summary of what you found. Call it once, as your last step.',
    {}, [], null, () => ({})),
};
export const resultToolFor = (role, setup, sink) => resultTools[setup.result](Object.assign(sink, { role }));
