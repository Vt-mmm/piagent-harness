import os from 'node:os';
import { redactSecrets } from './secret-patterns.mjs';

// Keys and tokens never reach a log, a report or a memory line. The shapes live in secret-patterns.mjs (the same file in every package).
export const redact = (text, home = os.homedir()) => {
  const out = redactSecrets(text);
  return (home.length > 1 ? out.split(home).join('~') : out).replace(/\0/g, '');
};
export const clip = (value, n) => typeof value === 'string' ? value.trim().slice(0, n) : '';
// Cut to a byte budget without splitting a character.
export function clipBytes(text, bytes) {
  return Buffer.byteLength(text) <= bytes ? text : Buffer.from(text).subarray(0, bytes - 3).toString('utf8').replace(/�*$/, '') + '…';
}
export const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';
