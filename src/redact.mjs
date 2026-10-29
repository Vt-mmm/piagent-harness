import os from 'node:os';

// Keys and tokens never reach a log, a report or a memory line.
const SECRETS = [
  /\bas_(?:live|run|device)_[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
export const redact = (text, home = os.homedir()) => {
  const out = SECRETS.reduce((t, pattern) => t.replace(pattern, '[REDACTED_SECRET]'), String(text ?? ''));
  return (home.length > 1 ? out.split(home).join('~') : out).replace(/\0/g, '');
};
export const clip = (value, n) => typeof value === 'string' ? value.trim().slice(0, n) : '';
// Cut to a byte budget without splitting a character.
export function clipBytes(text, bytes) {
  return Buffer.byteLength(text) <= bytes ? text : Buffer.from(text).subarray(0, bytes - 3).toString('utf8').replace(/�*$/, '') + '…';
}
export const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';
