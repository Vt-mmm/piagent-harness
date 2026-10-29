import { request, CHANNELS } from './bus.mjs';
import { READ_TOOLS } from './helper-roles.mjs';
import { HELPER_UNTRUSTED_RULE } from './untrusted.mjs';
import { textOf } from './redact.mjs';

// Helper sessions: a child Pi session that can only read (verify also runs
// commands in the read-only project), under a grant of its own. The harness
// never holds a key: the grant (broker `child`) is asked of the provider over
// the bus, the read-only tools of the sandbox, and the session is created
// with Pi's SDK. Not yet run against the real provider and sandbox: the bus
// messages follow package-contract.md and are tested with fakes.
const GRANT_WAIT_MS = 30_000;

export function childSessions({ events, cwd, loadSdk, toolFilter = () => true, extraTools = () => [] }) {
  return {
    // -> { ask(prompt, { signal, resultTool, title }) -> { text, tokens, stopReason }, close() }
    async create({ role, key, setup }) {
      const granted = await request(events, CHANNELS.grantRequest, { role: 'child', purpose: role, key, effort: 'inherit' }, { timeoutMs: GRANT_WAIT_MS });
      if (!granted?.ok) throw Error(granted?.error ? String(granted.error) : 'managed-helper-grant-unavailable');
      const tools = await request(events, CHANNELS.childTools, { readOnly: true, commands: !!setup.commands, web: !!setup.web, key }, { timeoutMs: GRANT_WAIT_MS });
      if (!tools?.ok) { await release(events, key); throw Error(tools?.error ? String(tools.error) : 'managed-helper-tools-unavailable'); }
      const sdk = await loadSdk();
      let open = true;
      const names = [...READ_TOOLS, ...(setup.commands ? ['bash'] : []), ...(setup.web ? ['web_search', 'web_fetch'] : [])];
      return {
        grant: granted,
        async ask(prompt, { signal, resultTool }) {
          const customTools = [...tools.tools.filter(t => names.includes(t.name) && toolFilter(t)), ...extraTools(role), resultTool];
          const { session } = await sdk.createAgentSession({ cwd, model: granted.models?.[0], modelRuntime: granted.modelRuntime, thinkingLevel: granted.effort || 'off',
            settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' }),
            sessionManager: sdk.SessionManager.inMemory(cwd), noTools: 'builtin', tools: customTools.map(t => t.name), customTools,
            resourceLoader: await sdk.minimalResourceLoader?.({ systemPrompt: setup.prompt + HELPER_UNTRUSTED_RULE }) });
          const abort = () => void session.abort();
          signal?.addEventListener('abort', abort, { once: true });
          try {
            if (signal?.aborted) throw Error('managed-helper-cancelled');
            await session.prompt(prompt, { expandPromptTemplates: false });
            const messages = session.messages.filter(m => m.role === 'assistant'), last = messages.at(-1);
            if (last?.stopReason === 'error') throw Error(`managed-helper-failed: ${last.errorMessage}`);
            if (!messages.length || last.stopReason === 'aborted') throw Error(signal?.aborted ? 'managed-helper-cancelled' : 'managed-helper-failed');
            return { text: messages.map(m => textOf(m.content)).join('\n'), tokens: messages.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0), stopReason: last.stopReason };
          } finally { signal?.removeEventListener('abort', abort); session.dispose?.(); }
        },
        async close() { if (open) { open = false; await release(events, key); } },
      };
    },
  };
}
// Tells the provider the helper is done: it closes that role's grant.
async function release(events, key) {
  await request(events, CHANNELS.grantRequest, { role: 'child', purpose: 'release', key, release: true }, { timeoutMs: 10_000, fallback: { ok: false } });
}
