import { request, CHANNELS, CONTRACT_VERSION } from './bus.mjs';
import { READ_TOOLS } from './helper-roles.mjs';
import { HELPER_UNTRUSTED_RULE } from './untrusted.mjs';
import { textOf } from './redact.mjs';

// Helper sessions: a child Pi session that can only read (verify also runs
// commands in the read-only project), under a grant of its own. The harness
// never holds a key. The provider answers piagent:grant.request with the
// helper's model limits and a `stream` function bound to the grant; the
// sandbox answers piagent:tools.child with read-only tool definitions; the
// session is created with Pi's SDK. The child model is registered on a private
// ModelRuntime whose stream is the provider's. Tested with fakes for both
// packages; not yet run against the real ones.
const GRANT_WAIT_MS = 30_000, PROVIDER = 'piagent-helper';
const roleOf = key => String(key).split('#')[0], slotOf = key => Number(String(key).split('#')[1]) || undefined;

// A private runtime with one model whose requests go through the grant's stream.
async function helperRuntime(sdk, ai, granted) {
  const entry = granted.models?.[0];
  if (!entry?.id) throw Error('managed-helper-grant-unavailable');
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(PROVIDER, { name: 'Company helper', api: 'piagent-helper', baseUrl: 'https://studio.invalid', apiKey: 'grant-bound',
    streamSimple: (_model, context, options) => granted.stream(context, options),
    models: [{ id: entry.id, name: 'Helper', reasoning: entry.reasoning === true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow ?? 200_000, maxTokens: entry.maxTokens ?? 16_384 }] });
  return { runtime, model: runtime.getModel(PROVIDER, entry.id) };
}

export function childSessions({ events, cwd, loadSdk, loadAi = () => import('@earendil-works/pi-ai'), extraTools = () => [] }) {
  return {
    // -> { ask(prompt, { signal, resultTool }) -> { text, tokens, stopReason }, close() }
    async create({ role, key, setup }) {
      const slot = slotOf(key ?? role);
      const granted = await request(events, CHANNELS.grantRequest, { role: roleOf(role), ...(slot ? { slot } : {}) }, { timeoutMs: GRANT_WAIT_MS });
      if (!granted?.ok) throw Error(granted?.error ? String(granted.error) : 'managed-helper-grant-unavailable');
      let open = true;
      const close = async () => { if (open) { open = false; events.emit(CHANNELS.grantClose, { v: CONTRACT_VERSION, role: roleOf(role), ...(slot ? { slot } : {}) }); } };
      try {
        const tools = await request(events, CHANNELS.childTools, { readOnly: true, commands: !!setup.commands, web: !!setup.web, key: key ?? role }, { timeoutMs: GRANT_WAIT_MS });
        if (!tools?.ok) throw Error(tools?.error ? String(tools.error) : 'managed-helper-tools-unavailable');
        const [sdk, ai] = await Promise.all([loadSdk(), loadAi()]);
        const { runtime, model } = await helperRuntime(sdk, ai, granted);
        const names = [...READ_TOOLS, ...(setup.commands ? ['bash'] : []), ...(setup.web ? ['web_search', 'web_fetch'] : [])];
        return {
          grant: granted,
          async ask(prompt, { signal, resultTool }) {
            const customTools = [...tools.tools.filter(t => names.includes(t.name)), ...extraTools(role), resultTool];
            const { session } = await sdk.createAgentSession({ cwd, model, modelRuntime: runtime, thinkingLevel: granted.effort || 'off',
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
          close,
        };
      } catch (error) { await close(); throw error; }
    },
  };
}
