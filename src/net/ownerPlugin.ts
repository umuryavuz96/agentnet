// Owner chat goes through the agentnet plugin, and only through it: the owner's chat text rides to the agent's plugin on its
// long-poll (`owner` in the /poll answer). The plugin submits it with $.prompt.submit({ asUser: true }), so the model reads the
// owner's own words, not a "plugin sent a message" delivery. Mid-turn, Claude Code holds it until the turn ends.
// Only a plugin that said hello with caps "owner-chat" (Claude Code 2.1.286+) takes items; for any other they stay queued.
// A server restart forgets the caps and the queue: the plugin says hello again when its poll reconnects.
// At most once: an item leaves the queue when a poll answer carries it (an aborted poll takes nothing).
// Stop and Send now go the same way: a plugin that said "owner-abort" gets `abort` in the /poll answer and ends the turn with
// $.turn.abort. Claude Code then runs the prompts it holds. An Escape would drop them, and every later one until someone types.
import { polledLately } from "./liveness";

export interface OwnerItem { nonce: string | null; text: string; at: number }
const queue = new Map<string, OwnerItem[]>(); // agent name -> items
const capable = new Set<string>();             // agent names whose plugin said hello with caps "owner-chat"
const abortable = new Set<string>();           // agent names whose plugin said hello with caps "owner-abort"
const cuts = new Map<string, { turn: string; at: number }>(); // agent name -> a turn to end, not yet fetched
const lastCut = new Map<string, number>();
/** A cut not fetched this long is dropped: it must not end a later turn. */
export const CUT_TTL = 10_000;
/** Send now twice within this is one click: the second would end the turn that answers the message. */
export const CUT_GAP = 3_000;
let waker: (name: string) => void = () => {};

export const setOwnerWaker = (fn: (name: string) => void) => { waker = fn; };
/** A hello that can take owner chat wakes the poll for what waited. */
export const setOwnerCapable = (name: string, on: boolean) => { if (!on) { capable.delete(name); return; } capable.add(name); if (ownerHas(name)) waker(name); };
export const ownerCapable = (name: string) => capable.has(name);
/** A retry (same nonce) replaces the item that still waits, so it arrives once. */
export function ownerPush(name: string, item: OwnerItem) { queue.set(name, [...(queue.get(name) ?? []).filter((i) => !item.nonce || i.nonce !== item.nonce), item]); waker(name); }
export const ownerHas = (name: string) => (queue.get(name)?.length ?? 0) > 0;
/** Is there something the agent's plugin can take now? */
export const ownerReady = (name: string) => capable.has(name) && (ownerHas(name) || cuts.has(name));
export const setOwnerAbortable = (name: string, on: boolean) => { if (on) abortable.add(name); else abortable.delete(name); };
export const ownerAbortable = (name: string) => abortable.has(name);
/** Ask the agent's plugin to end the running turn. `turn` = the turn the owner saw ("" = whatever runs).
 *  False = this plugin cannot do it (an older one, or it is not polling). */
export function cutTurn(name: string, id: string, turn: string, now = Date.now()): boolean {
  if (!capable.has(name) || !abortable.has(name) || !polledLately(id, now)) return false;
  cuts.set(name, { turn, at: now }); lastCut.set(name, now); waker(name);
  return true;
}
export const cutLately = (name: string, now = Date.now()) => now - (lastCut.get(name) ?? -Infinity) < CUT_GAP;
export function ownerTakeCut(name: string, now = Date.now()): string | null { const c = cuts.get(name); cuts.delete(name); return c && now - c.at < CUT_TTL ? c.turn : null; }
export function ownerTake(name: string): OwnerItem[] { if (!capable.has(name)) return []; const l = queue.get(name) ?? []; queue.delete(name); return l; }
/** Tests only. */
export function ownerReset() { queue.clear(); capable.clear(); abortable.clear(); cuts.clear(); lastCut.clear(); }
