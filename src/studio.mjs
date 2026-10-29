import { request, CHANNELS } from './bus.mjs';

// Calls to Agent Studio go through the provider, which holds the run tokens
// (the harness never sees one). `role` names the grant to use: main, or a
// helper's key (role or role#slot). A Studio that lacks an operation answers
// 404/405, which callers treat as "not offered".
export class StudioClient {
  constructor(events, { timeoutMs = 10_000 } = {}) { this.events = events; this.timeoutMs = timeoutMs; this.state = null; }
  setState(state) { this.state = state; }
  get capabilities() { return new Set(this.state?.capabilities ?? []); }
  has(name) { return this.capabilities.has(name); }
  // -> { ok, status, body } ; never throws.
  async fetch(path, { method = 'POST', body, role = 'main', timeoutMs = this.timeoutMs } = {}) {
    const answer = await request(this.events, CHANNELS.studioFetch, { role, method, path, body, timeoutMs }, { timeoutMs: timeoutMs + 1000, fallback: { ok: false, status: 0, error: 'no-answer' } });
    return { ok: !!answer.ok, status: Number(answer.status) || 0, body: answer.body ?? null, error: answer.error };
  }
}
