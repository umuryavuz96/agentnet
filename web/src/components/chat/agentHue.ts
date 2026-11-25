// One hue per agent, shared by the map's AgentCard and the chat (tile, cards, names), so an agent reads the same colour
// everywhere. Seven hues spread from teal to pink, clear of the green, amber and red kept for state; root keeps blue 212.
// Live agents take them in name order, so no two of the first seven share one; an agent that is not live takes one from
// its name's hash.
import { net } from "../../net";

export const AGENT_HUES = [307, 172, 262, 334, 188, 285, 240];
export const ROOT_HUE = 212;

/** FNV-1a hash of a name: the same number for the same name on every page. */
export function nameHash(name: string): number {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** The agent's place among live agents: root 0, the rest from 1 in name order; the name's hash when it is not live. */
export function agentSlot(name: string): number {
  if (name === "root") return 0;
  const names = Object.values(net.agents)
    .filter((a) => a.name !== "root" && a.life !== "gone" && a.life !== "failed")
    .map((a) => a.name)
    .sort();
  const i = names.indexOf(name);
  return i >= 0 ? i + 1 : nameHash(name);
}

/** The hue for a slot from agentSlot. */
export function hueForSlot(slot: number): number {
  return slot === 0 ? ROOT_HUE : AGENT_HUES[(slot - 1) % AGENT_HUES.length]!;
}

/** The agent's hue, the one its map card shows. Reactive inside a computed (it reads net.agents). */
export function agentHue(name?: string): number {
  return hueForSlot(agentSlot(name ?? ""));
}
