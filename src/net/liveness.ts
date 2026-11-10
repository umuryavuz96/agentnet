// agentnet liveness: for mod agents the connection is the claude pid. Reachable = a poll is open;
// exists = kill(pid, 0). Gone = bye, or no open poll and the pid dead. Service restart = `recovering` for 10 s from listen,
// then one pid check per silent agent. No hello within 30 s of spawn = failed. No heartbeat, no `unreachable` state.
import { logEvent } from "../core/logger";
import { db } from "../core/db";
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

/** An agent that ran in its tmux session (seen there once) and whose session is gone for LOST_SWEEPS sweeps in a row is lost, unless a poll is open
 *  (it is still talking to us) or its claude pid is the same live process. A pid started after the hello is a reused pid: not the agent. */
export const LOST_SWEEPS = 3, HOLD_MS = 24 * 3600_000; // same hold time as routes.ts HOLD_MS
const seenInTmux = new Set<string>();  // agent id -> its session existed at some sweep
const missing = new Map<string, number>(); // agent id -> consecutive sweeps without its session
const startedAt = (pid: number): number | null => { const r = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)]); const t = Date.parse(new TextDecoder().decode(r.stdout).trim()); return Number.isFinite(t) ? t : null; };
/** Same process as at hello? true when the pid exists and started before (or at) the agent connected. */
export const sameProcess = (pid: number, connectedAt: number | null, check: (pid: number) => boolean = alive, start: (pid: number) => number | null = startedAt): boolean => {
  if (!check(pid)) return false;
  const st = start(pid); return st === null || connectedAt === null || st <= connectedAt + 2000;
};
export function lostCheck(s: Snapshot, sessions: Set<string> | null, o: { polling: boolean; same: () => boolean }): boolean {
  if (!sessions || s.name === "root" || s.life !== "live") { missing.delete(s.id); return false; }
  if (sessions.has(sessionOf(s.name))) { seenInTmux.add(s.id); missing.delete(s.id); return false; }
  if (!seenInTmux.has(s.id)) return false;
  const n = (missing.get(s.id) ?? 0) + 1; missing.set(s.id, n);
  return n >= LOST_SWEEPS && !o.polling && !o.same();
}
/** Unread messages of a lost agent wait for its respawn (same name, within 24 h). */
export function holdUnread(agent: string, now = Date.now()): number {
  return db().run("UPDATE messages SET state = 'held', held_until = ? WHERE to_agent = ? AND state = 'queued'", [now + HOLD_MS, agent]).changes;
}

export function sweep(now = Date.now(), check: (pid: number) => boolean = alive, tmux: Tmux | null = realTmux, start: (pid: number) => number | null = startedAt) {
  let n = 0;
  const attached = tmux ? attachedSessions(tmux) : null;
  const ls = tmux ? tmux.run(["list-sessions", "-F", "#{session_name}"]) : null;
  const sessions = ls && ls.code === 0 ? new Set(ls.out.split("\n").map((l) => l.trim()).filter(Boolean)) : ls && ls.code !== 127 ? new Set<string>() : null; // no tmux server = no sessions; no tmux binary = unknown
  for (const s of live()) {
    if (attached && s.life === "live") { const open = attached.has(sessionOf(s.name)); if (open !== (s.window?.open ?? false) || s.window === null) { emit({ agent: s.id, type: "WindowChanged", data: { open }, source: "service", ts: now }); n++; } }
    if (lostCheck(s, sessions, { polling: isPolling(s.id), same: () => (s.pid ? sameProcess(s.pid, s.connectedAt, check, start) : false) })) {
      holdUnread(s.id, now);
      emit({ agent: s.id, type: "AgentGone", data: { reason: "lost" }, source: "service", ts: now, dedup: goneKey(s, s.id) }); n++; continue;
    }
    const d = decide(s, { polling: isPolling(s.id), lastPoll: lastPoll.get(s.id) ?? null, pidAlive: s.pid ? check(s.pid) : null, recovering: recovering(now) }, now);
    if (!d) continue;
    // its pid died and its tmux session is gone too: that is "lost" (senders get 409), not a plain exit. Unread messages wait for the respawn either way.
    if (d.type === "AgentGone") { if (sessions && s.name !== "root" && !sessions.has(sessionOf(s.name)) && seenInTmux.has(s.id)) d.reason = "lost"; holdUnread(s.id, now); }
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
export const _reset = () => { seenInTmux.clear(); missing.clear(); polls.clear(); lastPoll.clear(); listenedAt = 0; if (timer) clearInterval(timer); timer = null; };
