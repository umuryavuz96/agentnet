// Owner chat through the plugin (default on): the owner's chat text goes to the agent's plugin through its long-poll
// (`owner` in the /poll answer) instead of a tmux paste + Enter. The plugin submits it with $.prompt.submit({ asUser: true }),
// so the model reads the owner's own words, not a "plugin sent a message" delivery. Only while the agent is idle: mid-turn it is typed (tmux).
// Only for an agent whose plugin said hello with caps "owner-chat" (Claude Code 2.1.286+); else tmux. Root/director, Send now
// and Stop stay on tmux. A server restart forgets the caps: the plugin says hello again when its poll reconnects.
// Flag AGENTNET_OWNER_VIA_PLUGIN: unset or "1" = every capable agent; "0" = off (tmux for all); "a,b" = only those agents.
// A request's `via` ("tmux" | "plugin") overrides the default (A/B measurements); "plugin" still needs a capable plugin and the flag not "0".
// At most once: an item leaves the queue when a poll answer carries it (an aborted poll takes nothing).

export interface OwnerItem { nonce: string | null; text: string; at: number }
const queue = new Map<string, OwnerItem[]>(); // agent name -> items
const capable = new Set<string>();             // agent names whose plugin said hello with caps "owner-chat"
let waker: (name: string) => void = () => {};

export const setOwnerWaker = (fn: (name: string) => void) => { waker = fn; };
export const setOwnerCapable = (name: string, on: boolean) => { if (on) capable.add(name); else capable.delete(name); };

/** Should this send go to the plugin? Never with the flag "0" or without a capable plugin.
 *  Mid-turn (`busy`) it goes to tmux: Claude Code takes a typed line into the running turn, while a plugin submit waits for the
 *  turn to end (measured 2026-11-24, busy 10: tmux 10/10 mid-turn, reply p50 6.1 s; plugin 0/10, 9.9 s). `via: "plugin"` still forces it. */
export function viaPlugin(name: string, via: unknown, flag = process.env.AGENTNET_OWNER_VIA_PLUGIN, busy = false): boolean {
  const f = (flag ?? "").trim();
  if (f === "0" || !capable.has(name) || via === "tmux") return false;
  if (busy && via !== "plugin") return false;
  return via === "plugin" || f === "" || f === "1" || f.split(",").map((s) => s.trim()).includes(name);
}
export function ownerPush(name: string, item: OwnerItem) { queue.set(name, [...(queue.get(name) ?? []), item]); waker(name); }
export const ownerHas = (name: string) => (queue.get(name)?.length ?? 0) > 0;
export function ownerTake(name: string): OwnerItem[] { const l = queue.get(name) ?? []; queue.delete(name); return l; }
/** Tests only. */
export function ownerReset() { queue.clear(); capable.clear(); }
