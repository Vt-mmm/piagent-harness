import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The company's look in Pi's Terminal: a header (team, mode, memory, bundle
// version), a footer without cost in USD, and /style. Only the interactive TUI
// draws them (setHeader and setFooter do nothing in print, JSON and RPC modes).
const MODE_WORDS = { ask: 'Ask first', full: 'Full access', bypass: 'Bypass' };
export const modeWord = mode => MODE_WORDS[mode] ?? MODE_WORDS.ask;

export function headerLines({ team = '', mode = 'ask', memory = false, fast = false, bundle = '', main = '', review = '' } = {}) {
  const line1 = ['Piagent công ty', team && `team ${team}`, bundle && `bộ ${bundle}`].filter(Boolean).join(' · ');
  const line2 = [main && `Main: ${main}`, review && `Review: ${review}`, modeWord(mode), fast ? 'Fast' : null, `Team memory: ${memory ? 'bật' : 'tắt'}`].filter(Boolean).join(' · ');
  return [line1, line2];
}
const compact = n => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
// The footer's text: the role and effort of the main agent, context use, helpers running, the Git branch. Never cost.
export function footerText({ main = '', effort = '', usage = null, helpers = { running: 0, total: 0 }, branch = '', mode = 'ask', fast = false } = {}) {
  const context = usage?.tokens != null && usage.contextWindow ? `${compact(usage.tokens)}/${compact(usage.contextWindow)} (${Math.round(usage.tokens / usage.contextWindow * 100)}%)` : null;
  return [main && `${main}${effort ? ` • ${effort}` : ''}`, context, helpers.total ? `Subagent ${helpers.running}/${helpers.total}` : null, mode === 'bypass' ? 'Bypass' : null, fast ? 'Fast'
    : null, branch && `⎇ ${branch}`].filter(Boolean).join('  ');
}
// Installs the header and footer. `view()` returns the current numbers; `redraw()` refreshes.
export function installCompanyUi(ctx, view) {
  if (!ctx.hasUI || ctx.mode !== 'tui') return null;
  let invalidate = () => {};
  ctx.ui.setHeader(() => ({ render: () => headerLines(view()).map(l => l), invalidate: () => {}, dispose: () => {} }));
  ctx.ui.setFooter((tui) => { invalidate = () => tui.requestRender?.(); return { render: () => [footerText(view())], invalidate: () => {}, dispose: () => {} }; });
  return { redraw: () => invalidate() };
}

const STYLE_DESCRIPTIONS = {
  system: 'theo màu của terminal (mặc định của Pi)', dark: 'nền tối của Pi', light: 'nền sáng của Pi',
  'piagent-ocean': 'nền tối, xanh biển dịu mắt cho phiên dài', 'piagent-paper': 'nền sáng, tông giấy ấm',
  'piagent-contrast': 'tương phản cao, cho phòng sáng hoặc máy chiếu', 'piagent-focus': 'gần như đơn sắc, một màu nhấn hổ phách',
};
const styleFile = stateDir => path.join(stateDir ?? path.join(os.homedir(), '.pi'), 'piagent-terminal-style.json');
export function readStyle(stateDir) { try { const name = JSON.parse(fs.readFileSync(styleFile(stateDir), 'utf8'))?.theme; return typeof name === 'string' && name ? name : null;
  } catch { return null; } }
export function writeStyle(name, stateDir) {
  const file = styleFile(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ theme: name })}\n`, { mode: 0o600 });
}
export function styleChoices(ui) {
  const names = [...new Set(['system', 'dark', 'light', ...(ui?.getAllThemes?.() ?? []).map(t => t?.name).filter(Boolean)])];
  return names.map(name => ({ name, label: STYLE_DESCRIPTIONS[name] ? `${name} — ${STYLE_DESCRIPTIONS[name]}` : name }));
}
// /style lists the themes, /style <name> applies one at once and keeps it for the next conversation.
export function registerStyleCommand(pi, { stateDir } = {}) {
  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const saved = readStyle(stateDir);
    if (saved && ctx.ui.theme?.name !== saved) ctx.ui.setTheme?.(saved);
  });
  pi.registerCommand('style', {
    description: 'Chọn giao diện (theme) của Terminal: /style để chọn trong danh sách, /style <tên> để đổi ngay',
    handler: async (args, ctx) => {
      const choices = styleChoices(ctx.ui), wanted = String(args ?? '').trim();
      let name = wanted;
      if (!name) {
        if (!ctx.ui.select) return;
        const picked = await ctx.ui.select('Chọn giao diện', choices.map(c => c.label));
        name = choices.find(c => c.label === picked)?.name ?? '';
        if (!name) return;
      }
      if (!choices.some(c => c.name === name)) { ctx.ui.notify(`Không có giao diện "${name}". Có: ${choices.map(c => c.name).join(', ')}.`, 'warning'); return; }
      const result = ctx.ui.setTheme(name);
      if (!result?.success) { ctx.ui.notify(`Không đổi được giao diện: ${result?.error ?? 'không rõ'}.`, 'error'); return; }
      writeStyle(name, stateDir);
      ctx.ui.notify(`Đã đổi giao diện sang ${name}.`, 'info');
    },
  });
}
