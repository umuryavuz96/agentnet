// Oldest Claude Code the plugin works with. 2.1.293 added $.tool.register with isDeferred and $.session.append;
// 2.1.318 keeps prompt.submit attachments in the user turn. plugin/hooks/register.ts repeats these two numbers (a test keeps them equal).
export const MIN_CLAUDE = "2.1.293", RECOMMENDED_CLAUDE = "2.1.318";
const parts = (v: string) => (/\d+(?:\.\d+){0,2}/.exec(v)?.[0] ?? "").split(".").map(Number);
/** True when `v` (text such as "2.1.318 (Claude Code)") is older than `min`. Unreadable = false. */
export function olderThan(v: string, min: string): boolean {
  const a = parts(v), b = parts(min); if (!a[0] && a[0] !== 0) return false;
  for (let i = 0; i < 3; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x < y; }
  return false;
}
