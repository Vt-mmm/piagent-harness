import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Failed memory writes wait in a local outbox, one JSON file per event,
// scoped by the Studio instance, dataset epoch and key: another member or
// another Studio never reads them. Quarantine keeps a file Studio refused.
const MAX_FILE = 2 * 1024 * 1024, MAX_FILES = 200;
export function scopeID(scope) {
  if (!scope?.studio_instance_id || !scope.key_id) return null;
  return createHash('sha256').update(`${scope.studio_instance_id}\0${scope.dataset_epoch}\0${scope.auth_generation}\0${scope.key_id}`).digest('hex');
}
export class MemoryOutbox {
  constructor(stateDir, scope) {
    this.scope = scopeID(scope); this.quarantined = 0;
    this.directory = stateDir && this.scope ? path.join(stateDir, 'memory-outbox-v2', this.scope) : null;
  }
  put(item) {
    if (!this.directory || !/^[0-9a-f-]{36}$/.test(item.event_id)) return false;
    const text = JSON.stringify(item);
    if (Buffer.byteLength(text) > MAX_FILE || this.files().length >= MAX_FILES) return false;
    try { fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.directory, `${item.event_id}.json`), text, { mode: 0o600 }); return true;
      } catch { return false; }
  }
  files() { try { return fs.readdirSync(this.directory).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).sort(); } catch { return []; } }
  read(name) {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')); }
    catch { this.quarantine(name); return null; }
  }
  remove(name) { fs.rmSync(path.join(this.directory, name), { force: true }); }
  quarantine(name) {
    this.quarantined += 1;
    try { fs.mkdirSync(path.join(this.directory, 'quarantine'), { recursive: true, mode: 0o700 }); fs.renameSync(path.join(this.directory, name), path.join(this.directory, 'quarantine',
      name)); } catch { /* gone */ }
  }
}
