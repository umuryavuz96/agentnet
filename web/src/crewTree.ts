// The team crew tree: members arranged by boss link, lead on top. Pure (rows in, tree out) so a test pins it down.
// Order inside a level is by name, never by state, so a status change never moves a card.
import type { AgentRow } from "./net";

export type CrewState = "working" | "idle" | "waiting" | "blocked" | "done" | "starting" | "off";
export interface CrewNode { name: string; row: AgentRow | null; lead: boolean; state: CrewState; kids: CrewNode[] }

export function crewState(r: AgentRow | null): CrewState {
  if (!r) return "off";
  if (r.life === "gone" || r.life === "failed" || r.life === "stopping") return "done";
  if (r.life === "starting") return "starting";
  if (r.reported?.blockedOn || r.state === "blocked") return "blocked";
  return r.state === "working" ? "working" : r.state === "waiting" ? "waiting" : "idle";
}

/** Short model name: claude-sonnet-5-5 -> sonnet, claude-fable-5-2 -> fable. */
/** A name never breaks before its trailing number: "agentnet-designer-1" may wrap at a hyphen, not as "designer-" + "1". */
export const brk = (n: string) => n.replace(/-(\d+)$/, "-\u2060$1");
export const modelShort = (m: string | null | undefined) => (m ? m.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "").replace(/\[.*\]$/, "") : null);

export function buildCrew(members: string[], lead: string | null, rowOf: (n: string) => AgentRow | null, bosses: Record<string, string | null> = {}): CrewNode[] {
  const set = new Set(members);
  const mk = (n: string): CrewNode => { const row = rowOf(n); return { name: n, row, lead: n === lead, state: crewState(row), kids: [] }; };
  const nodes = new Map(members.map((n) => [n, mk(n)]));
  // a retired member has no live row: its last known boss comes from the server
  const bossOf = (n: string): string | null => (nodes.get(n)?.row?.boss ?? bosses[n]) ?? null;
  // parent = boss when the boss is a member and following bosses never loops back
  const parentOf = (n: string): string | null => {
    const b = bossOf(n);
    if (!b || b === n || !set.has(b)) return null;
    for (let c: string | null = b, i = 0; c; c = bossOf(c), i++) { if (c === n) return null; if (i > members.length) return null; if (!set.has(c)) break; }
    return b;
  };
  const roots: CrewNode[] = [];
  for (const n of [...members].sort((a, b) => a.localeCompare(b))) {
    const p = parentOf(n);
    (p ? nodes.get(p)!.kids : roots).push(nodes.get(n)!);
  }
  // the lead is the single top: other parentless members hang under it
  const top = lead && nodes.has(lead) ? lead : null;
  if (top && roots.some((r) => r.name === top)) {
    const t = nodes.get(top)!;
    const rest = roots.filter((r) => r.name !== top);
    t.kids = [...t.kids, ...rest].sort((a, b) => a.name.localeCompare(b.name));
    return [t];
  }
  return roots;
}

export const flatCount = (t: CrewNode[]): number => t.reduce((s, n) => s + 1 + flatCount(n.kids), 0);
