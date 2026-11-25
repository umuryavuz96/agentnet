// What the owner set on the chat's composer, kept per browser: which key sends, what a send does while the agent is busy,
// the reading size, and the saved quick prompts. parsePrefs is pure (tests); `prefs` is the page's live copy.
import { reactive, watch } from "vue";

export interface ChatPrefs {
  /** enter = Enter sends and Shift+Enter adds a line; mod = Cmd/Ctrl+Enter sends and Enter adds a line */
  sendKey: "enter" | "mod";
  /** queue = type the prompt (the terminal queues it); interrupt = stop the turn first, then type */
  busy: "queue" | "interrupt";
  size: "s" | "m" | "l";
  /** every folded trail (tool calls) starts open, old turns, new ones and a running one (owner 8404) */
  toolsOpen: boolean;
  quick: string[];
}
export const QUICK_MAX = 8, QUICK_LEN = 400;
export const DEFAULT_PREFS: ChatPrefs = { sendKey: "enter", busy: "queue", size: "m", toolsOpen: false, quick: ["Status?", "Continue", "Show me what changed"] };
const KEY = "agentnet.chat.prefs";

const cleanQuick = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) { const s = typeof x === "string" ? x.trim().slice(0, QUICK_LEN) : ""; if (s && !out.includes(s) && out.length < QUICK_MAX) out.push(s); }
  return out;
};
/** Stored text to prefs; anything missing or wrong falls back to the default for that one field. */
export function parsePrefs(json: string | null): ChatPrefs {
  let v: Record<string, unknown> = {};
  try { const p: unknown = json ? JSON.parse(json) : null; if (p && typeof p === "object" && !Array.isArray(p)) v = p as Record<string, unknown>; } catch { /* defaults */ }
  return {
    sendKey: v.sendKey === "mod" ? "mod" : "enter",
    busy: v.busy === "interrupt" ? "interrupt" : "queue",
    size: v.size === "s" || v.size === "l" ? v.size : "m",
    toolsOpen: v.toolsOpen === true,
    quick: cleanQuick(v.quick) ?? [...DEFAULT_PREFS.quick],
  };
}
/** The list with `text` added (trimmed, no repeats, at most QUICK_MAX); the same list when it cannot be added. */
export function addQuick(list: string[], text: string): string[] {
  const s = text.trim().slice(0, QUICK_LEN);
  return !s || list.includes(s) || list.length >= QUICK_MAX ? list : [...list, s];
}

const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const prefs = reactive<ChatPrefs>(parsePrefs(typeof localStorage === "undefined" ? null : read()));
if (typeof localStorage !== "undefined") watch(prefs, (p) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window: lasts until reload */ } }, { deep: true });
