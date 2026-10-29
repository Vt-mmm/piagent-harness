// The harness talks to the provider and the sandbox only through Pi's event
// bus (package-contract.md). Every payload carries `v`; a request carries a
// `reply` function, which the answering package calls once.
export const CHANNELS = Object.freeze({
  grantRequest: 'piagent:grant.request', grantClose: 'piagent:grant.close', runState: 'piagent:run.state', runProcess: 'piagent:run.process',
  studioCall: 'piagent:studio.call', toolsAttest: 'piagent:tools.attest', permissionMode: 'piagent:permission.mode',
  childTools: 'piagent:tools.child', toolsBlocked: 'piagent:tools.blocked',
});
export const CONTRACT_VERSION = 1;

// Asks another package and waits for its reply; `fallback` says what an
// unanswered request means (nobody listens, or it took too long).
export function request(events, channel, payload, { timeoutMs = 10_000, fallback = { ok: false, error: 'no-answer' } } = {}) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    let answered = false;
    const reply = value => { if (answered) return; answered = true; clearTimeout(timer); resolve(value ?? fallback); };
    try { events.emit(channel, { v: CONTRACT_VERSION, ...payload, reply }); } catch { reply(fallback); }
  });
}
// Answers requests of a channel; the handler returns the reply value.
export function serve(events, channel, handler) {
  return events.on(channel, async data => {
    try { data?.reply?.(await handler(data)); } catch (error) { data?.reply?.({ ok: false, error: String(error?.message ?? error) }); }
  });
}
