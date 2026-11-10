// agentnet liveness: for mod agents the connection is the claude pid. Reachable = a poll is open;
// exists = kill(pid, 0). Gone = bye, or no open poll and the pid dead. Service restart = `recovering` for 10 s from listen,
// then one pid check per silent agent. No hello within 30 s of spawn = failed. No heartbeat, no `unreachable` state.
import { logEvent } from "../core/logger";
import { emit, flush, live, goneKey, type Snapshot } from "./store";
import { attachedSessions, sessionOf, realTmux, type Tmux } from "./windows";

/** A director with no pid on record (hello gave none) that has not polled for this long is not running: without it the card would say Idle for hours. */
export const NO_PID_GONE_MS = 90_000;
export const RECOVER_MS = 10_000, SWEEP_MS = 1_000, SILENT_MS = 1_000, HELLO_MS = 30_000; // measured: client killed → poll abort at once → gone on the next sweep (~2 s)
const polls = new Map<string, number>();   // agent id -> open polls
const lastPoll = new Map<string, number>(); // agent id -> when its last poll ended
let listenedAt = 0, timer: ReturnType<typeof setInterval> | null = null;

/** Is the process there? EPERM means it exists but belongs to someone else: still alive. */
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
export const recovering = (now = Date.now()) => now - listenedAt < RECOVER_MS;

export function pollOpened(agent: string) { polls.set(agent, (polls.get(agent) ?? 0) + 1); }
export function pollClosed(agent: string, now = Date.now()) { const n = (polls.get(agent) ?? 1) - 1; if (n <= 0) polls.delete(agent); else polls.set(agent, n); lastPoll.set(agent, now); }
export const isPolling = (agent: string) => (polls.get(agent) ?? 0) > 0;

/** Pure decision for one agent: what the sweep should emit now, or null. */
export function decide(s: Snapshot, o: { polling: boolean; lastPoll: number | null; pidAlive: boolean | null; recovering: boolean }, now = Date.now()): { type: "AgentFailed" | "AgentGone"; reason: string } | null {
  if (s.life === "gone" || s.life === "failed") return null;
  if (s.life === "starting") return !o.recovering && now - s.spawnedAt > HELLO_MS ? { type: "AgentFailed", reason: "no hello within 30 s" } : null;
  if (o.polling) return null;
  if (o.recovering) return null;
  const silentFor = now - Math.max(o.lastPoll ?? 0, s.connectedAt ?? 0);
  if (silentFor < SILENT_MS) return null;
  if (o.pidAlive === false) return { type: "AgentGone", reason: s.connectedAt && listenedAt > s.connectedAt ? "during_restart" : "killed" };
  if (o.pidAlive === null && s.name === "root" && silentFor > NO_PID_GONE_MS) return { type: "AgentGone", reason: "no_poll" }; // pid unknown, nothing polling for 90 s
  return null; // pid alive, mod silent: still live (it reconnects by itself); never `unreachable` for a mod agent
}

export function sweep(now = Date.now(), check: (pid: number) => boolean = alive, tmux: Tmux | null = realTmux) {
  let n = 0;
  const attached = tmux ? attachedSessions(tmux) : null;
  for (const s of live()) {
    if (attached && s.life === "live") { const open = attached.has(sessionOf(s.name)); if (open !== (s.window?.open ?? false) || s.window === null) { emit({ agent: s.id, type: "WindowChanged", data: { open }, source: "service", ts: now }); n++; } }
    const d = decide(s, { polling: isPolling(s.id), lastPoll: lastPoll.get(s.id) ?? null, pidAlive: s.pid ? check(s.pid) : null, recovering: recovering(now) }, now);
    if (!d) continue;
    emit({ agent: s.id, type: d.type, data: { reason: d.reason }, source: "service", ts: now, dedup: d.type === "AgentFailed" ? `failed:${s.id}:${s.spawnedAt}` : goneKey(s, s.id) }); n++;
  }
  if (n) flush();
  return n;
}
/** Called once when the server listens: starts the 10 s grace and the 2 s sweep. */
export function startLiveness(now = Date.now()) {
  if (process.env.AGENTNET_SWEEP === "0") { logEvent("info", "agentnet: liveness off (AGENTNET_SWEEP=0)"); return; }
  listenedAt = now;
  if (!timer) timer = setInterval(() => { try { sweep(); } catch { /* next sweep */ } }, SWEEP_MS);
}
export const _reset = () => { polls.clear(); lastPoll.clear(); listenedAt = 0; if (timer) clearInterval(timer); timer = null; };
