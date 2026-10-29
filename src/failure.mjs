// The stable code inside any error text the packages can produce or receive.
// The provider owns the full table; the harness needs the code for reports,
// tool failures and "continue" decisions.
export function failureCode(raw) {
  const text = String(raw ?? '');
  const studio = /"code"\s*:\s*"([a-z0-9_]{1,80})"/.exec(text)?.[1] ?? /web-search-failed: ([a-z0-9_-]{1,80})/.exec(text)?.[1];
  if (studio) return studio === 'initial_request_limit_reached' ? 'live_trial_limit_reached' : studio;
  const local = /(managed-broker:[A-Za-z_]{1,80}|managed-[a-z-]{1,80}|web-search-empty)/.exec(text)?.[1];
  if (local) return local;
  if (/\bAPI error \((?:50[234]|52\d|530)\)|^(?:50[234]|52\d|530)\b/.test(text)) return 'studio-gateway-unavailable';
  if (/\bAPI error \(\d{3}\)|^\d{3} \{/.test(text)) return 'studio-request-failed';
  if (/stream ended without a (terminal event|stop reason)|response has no body/i.test(text)) return 'upstream_incomplete';
  if (/^Request interrupted\b/i.test(text)) return 'upstream_interrupted';
  if (/^The answer ran past its output limit\b/i.test(text)) return 'output_limit_exceeded';
  if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network|socket hang up/i.test(text)) return 'studio-unreachable';
  return 'managed-request-failed';
}
