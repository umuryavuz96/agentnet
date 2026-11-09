// Context use against the window an agent really runs with. Pure, so tests import it without the page state.
/** Context use against the window the agent really runs with: its compact window when it has one, else the model window. */
export function ctxView(r: { context: { tokens: number; window: number; pct: number } | null; compactWindow?: number | null } | null | undefined): { pct: number; tokens: number; window: number; model: number; compact: boolean } | null {
  const c = r?.context; if (!c) return null;
  const w = r!.compactWindow && r!.compactWindow > 0 ? r!.compactWindow : c.window;
  return { pct: w > 0 ? (c.tokens / w) * 100 : c.pct, tokens: c.tokens, window: w, model: c.window, compact: w !== c.window };
}
