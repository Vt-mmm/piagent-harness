import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaredChecks, repositoryChecks, detectedChecks, readAgentsFiles } from '../src/checks.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'harness-checks-'));

test('## Checks in AGENTS.md comes first: fenced lines and bullets', () => {
  const content = '# Agent\n## Checks\n- `npm test`\n```bash\nnpm run lint\n# a comment\n```\n## Other\n- `rm -rf /`\n';
  assert.deepEqual(declaredChecks([{ content }]), ['npm test', 'npm run lint']);
});

test('AGENTS.md wins over the manifest', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', lint: 'y' } }));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Checks\n- `make verify`\n');
  assert.deepEqual(repositoryChecks(readAgentsFiles(dir), dir), { source: 'agents', commands: ['make verify'] });
});

test('without a Checks section the manifest implies them', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x', lint: 'y', build: 'z' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(repositoryChecks([], dir), { source: 'detected', commands: ['pnpm run lint', 'pnpm run test'] });
  const go = tmp(); fs.writeFileSync(path.join(go, 'go.mod'), 'module x');
  assert.deepEqual(detectedChecks(go), ['go vet ./...', 'go test ./...']);
});

test('this repository declares npm test', () => {
  assert.deepEqual(repositoryChecks(readAgentsFiles(process.cwd()), process.cwd()).commands, ['npm test']);
});
