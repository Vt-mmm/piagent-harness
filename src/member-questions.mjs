// Questions the main agent asks the member when the request leaves a decision
// open: 1-4 questions, each with 2-4 numbered options, and always "Other" in the
// member's own words. In Pi's Terminal each question is a selector; with no
// member at a screen (print mode, RPC without UI) the agent is told to go on
// with a stated assumption.
// What the agent reads when the member stopped the turn before answering: the decisions stay theirs.
export const CANCELLED = 'managed-question-cancelled: the member stopped before answering. '
  + 'These decisions are still open: when the member continues, ask again (unless their new message settles them); do not choose for them.';
export const HEADLESS = 'No member can answer right now (this conversation has no screen to ask on). '
  + 'Go on with the most reasonable choice for each question, state the assumption plainly in your answer, and keep it easy to change.';
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

// The questions as asked, or null when they do not have the expected shape.
export function normalizeQuestions(raw) {
  const list = Array.isArray(raw) ? raw : null;
  if (!list || list.length < 1 || list.length > 4) return null;
  const out = [];
  for (const item of list) {
    const question = text(item?.question, 400), header = text(item?.header, 24);
    const options = Array.isArray(item?.options) ? item.options.map(o => ({ label: text(o?.label, 80), description: text(o?.description, 200) })) : [];
    if (!question || options.length < 2 || options.length > 4 || options.some(o => !o.label) || new Set(options.map(o => o.label.toLowerCase())).size !== options.length) return null;
    out.push({ header, question, options, multiSelect: item?.multiSelect === true });
  }
  return out;
}

// The member's answer, checked against the questions: one entry per question
// with the chosen option numbers (0-based) and/or their own words; or skipped
// (the member leaves the decision to the agent). Null when it does not fit.
export function normalizeAnswer(questions, raw) {
  if (raw?.skipped === true) return { skipped: true, answers: [] };
  const list = Array.isArray(raw?.answers) ? raw.answers : null;
  if (!list || list.length !== questions.length) return null;
  const answers = [];
  for (const [i, item] of list.entries()) {
    const q = questions[i], other = text(item?.other, 1000) || null;
    const selected = Array.isArray(item?.selected) ? [...new Set(item.selected)] : [];
    if (selected.some(n => !Number.isSafeInteger(n) || n < 0 || n >= q.options.length)) return null;
    if (!q.multiSelect && selected.length + (other ? 1 : 0) > 1) return null;
    if (!selected.length && !other) return null;
    answers.push({ selected: selected.sort((a, b) => a - b), other });
  }
  return { skipped: false, answers };
}

// What the agent reads back.
export function answerText(questions, answer) {
  if (answer.skipped) return 'The member did not choose and leaves these decisions to you. Make the choice you judge best, say in one line which one and why, and go on.';
  return ['The member answered:', ...questions.flatMap((q, i) => {
    const a = answer.answers[i];
    return [`${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question}`,
      ...a.selected.map(n => `   → ${n + 1}. ${q.options[n].label}`), ...(a.other ? [`   → Other: ${a.other}`] : [])];
  })].join('\n');
}

// In the Terminal: each question as a selector of its numbered options, then
// "Other" (typed) and "Let the agent decide". Esc leaves it to the agent.
export async function askInTerminal(ui, questions, signal) {
  const answers = [];
  for (const [i, q] of questions.entries()) {
    const title = `${questions.length > 1 ? `(${i + 1}/${questions.length}) ` : ''}${q.header ? `${q.header}: ` : ''}${q.question}`;
    const items = q.options.map((o, n) => `${n + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`);
    const other = `${q.options.length + 1}. Khác (tự nhập)`, skip = 'Để agent tự quyết', done = 'Xong';
    const selected = [];
    for (;;) {
      const choices = q.multiSelect ? [...items.filter((_, n) => !selected.includes(n)), other, ...(selected.length ? [done] : [skip])] : [...items, other, skip];
      const picked = await ui.select(q.multiSelect && selected.length ? `${title}\nĐã chọn: ${selected.map(n => n + 1).join(', ')}` : title, choices, { signal });
      if (signal?.aborted) throw Error('managed-question-cancelled');
      if (picked === undefined || picked === skip) return { skipped: true, answers: [] };
      if (picked === done) { answers.push({ selected, other: null }); break; }
      if (picked === other) {
        const typed = await ui.input(title, 'Câu trả lời của bạn', { signal });
        if (signal?.aborted) throw Error('managed-question-cancelled');
        if (typed?.trim()) { answers.push({ selected, other: typed.trim() }); break; }
        continue;
      }
      const n = items.indexOf(picked);
      if (!q.multiSelect) { answers.push({ selected: [n], other: null }); break; }
      selected.push(n);
    }
  }
  return normalizeAnswer(questions, { answers }) ?? { skipped: true, answers: [] };
}

const QUESTION_SCHEMA = { type: 'object', properties: {
  header: { type: 'string', maxLength: 24, description: 'A short label for the question, 1-3 words.' },
  question: { type: 'string', minLength: 1, maxLength: 400, description: 'One clear question in the member\'s language, ending with a question mark.' },
  options: { type: 'array', minItems: 2, maxItems: 4, description: 'The real choices, most likely first. "Other" is always added for the member: never add it yourself.',
    items: { type: 'object', properties: { label: { type: 'string', minLength: 1, maxLength: 80 }, description: { type: 'string', maxLength: 200 } }, required: ['label'],
      additionalProperties: false } },
  multiSelect: { type: 'boolean', description: 'True when several options may be chosen together.' } },
  required: ['question', 'options'], additionalProperties: false };

// The tool of the main agent. It asks through the Terminal UI of Pi when there is one.
export function askTool() {
  return { name: 'ask_user', label: 'Hỏi thành viên',
    description: 'Ask the member 1-4 questions and wait for the answers, when the request leaves a decision open that changes the result and the code, the docs or a subagent cannot settle ' +
      'it: scope, expected behaviour, data shape, a trade-off, a name the member will see. Ask before acting on a guess, all questions in one call, each with 2-4 concrete numbered options ' +
      '(most likely first). The member can always answer in their own words or leave the choice to you. Without a screen to ask on, go on with a stated assumption.',
    parameters: { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: QUESTION_SCHEMA } }, required: ['questions'], additionalProperties: false },
    execute: async (_toolCallId, args, signal, _onUpdate, ctx) => {
      const questions = normalizeQuestions(args?.questions);
      if (!questions) throw Error('managed-question-invalid: give 1-4 questions, each with a question and 2-4 options with distinct labels.');
      if (!ctx?.hasUI || !ctx.ui?.select) return { content: [{ type: 'text', text: HEADLESS }], details: { questions, answer: null, surface: 'none' } };
      let answer;
      try { answer = await askInTerminal(ctx.ui, questions, signal); }
      catch (error) { throw error?.message === 'managed-question-cancelled' ? Error(CANCELLED) : error; }
      return { content: [{ type: 'text', text: answerText(questions, answer) }], details: { questions, answer } };
    } };
}
