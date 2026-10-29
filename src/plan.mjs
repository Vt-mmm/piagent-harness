import { arrayArgument } from './json.mjs';

// update_plan: the agent's checklist, kept as a session entry so it survives
// compaction and "continue", and shown to the member beside the conversation.
export const PLAN_ENTRY = 'agent-watch-plan';
// "deferred": left for later at the member's word, or no longer needed.
const STATUS = ['pending', 'in_progress', 'completed', 'deferred'];
export function normalizePlan(args) {
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  if (plan.length < 1 || plan.length > 30 || plan.some(p => typeof p?.step !== 'string' || !p.step.trim() || p.step.length > 200 || !STATUS.includes(p.status)))
    throw Error('managed-plan-invalid: send 1 to 30 steps, each {step, status} with status pending, in_progress, completed or deferred.');
  if (plan.filter(p => p.status === 'in_progress').length > 1) throw Error('managed-plan-invalid: mark at most one step in_progress.');
  return { plan: plan.map(p => ({ step: p.step.trim(), status: p.status })), explanation: typeof args.explanation === 'string' ? args.explanation.slice(0, 300) : '' };
}
export const currentPlan = entries => entries.filter(e => e.type === 'custom' && e.customType === PLAN_ENTRY).at(-1)?.data ?? null;
export const unfinished = plan => !!plan?.plan?.some(p => p.status === 'pending' || p.status === 'in_progress');
const MARK = { completed: 'x', in_progress: '>', deferred: '-', pending: ' ' };
export const planText = plan => plan?.plan?.map((p, i) => `${i + 1}. [${MARK[p.status]}] ${p.step}`).join('\n') ?? '';

export function planTool(onPlan) {
  return { name: 'update_plan', label: 'Plan',
    description: 'Keep a short checklist for work with several steps. Send the whole list each time; mark the step you work on in_progress and finished steps completed. Mark a step deferred ' +
      'when the member asked to leave it for later or it is no longer needed, and say why in your answer; never mark completed a step you did not do. The member sees the checklist next to ' +
      'the conversation.',
    parameters: { type: 'object', properties: { explanation: { type: 'string', maxLength: 300 }, plan: { type: 'array', minItems: 1, maxItems: 30,
      items: { type: 'object', properties: { step: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: STATUS } }, required: ['step', 'status'],
        additionalProperties: false } } },
      required: ['plan'], additionalProperties: false },
    prepareArguments: arrayArgument('plan'),
    execute: async (_id, args) => {
      const plan = normalizePlan(args);
      await onPlan(plan);
      return { content: [{ type: 'text', text: `Plan updated: ${plan.plan.filter(p => p.status === 'completed').length}/${plan.plan.length} steps completed.` }], details: { plan: plan.plan } };
    } };
}
