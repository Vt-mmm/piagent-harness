// The one JSON reader of the harness. Review and verify results arrive through
// schema tools, so free text is parsed only where a model sends arguments as a
// string (prepareArguments) or a stored entry is read back.
export function parseObject(text) {
  try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch { return null; }
}
// The last ```json block of a text that parses to an object (copies, notes).
export function lastJsonBlock(text) {
  const blocks = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const raw of blocks.reverse()) { const value = parseObject(raw); if (value) return value; }
  return null;
}
// Some models send an array argument as a JSON string: read it as the array.
export function arrayArgument(name) {
  return args => {
    if (typeof args?.[name] !== 'string') return args;
    try { const list = JSON.parse(args[name]); return Array.isArray(list) ? { ...args, [name]: list } : args; } catch { return args; }
  };
}
