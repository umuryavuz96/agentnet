// Step 7: boot sweep for retired agents' tmux sessions (docs/internal/one-folder/SPEC-step7-hardening.md §2).
// finish.ts kills the session through an in-memory timer 5.5 s after the despawn; a restart inside that window lost the kill (msg 7226).
// The pending kill is now written to the DB (agents.pending_kill_at) and this sweep runs once at server start.
import { db } from "../core/db";
import { logEvent } from "../core/logger";
import { agentSessions, isAgentSession, killSession, realTmux, sessionOf, type Tmux } from "./windows";

export const SWEEP_MIN_AGE_MS = 10_000;
const PREFIX = "agentnet-";

/** Record that the agent's session is due to be killed (cleared by clearPendingKill once it is). */
export const markPendingKill = (id: string, at: number) => { try { db().run("UPDATE agents SET pending_kill_at = ? WHERE id = ?", [at, id]); } catch { /* old db */ } };
export const clearPendingKill = (id: string) => { try { db().run("UPDATE agents SET pending_kill_at = NULL WHERE id = ?", [id]); } catch { /* old db */ } };

interface Row { id: string; archived_at: number | null; pending_kill_at: number | null }
export type Later = (fn: () => void, ms: number) => void;
const realLater: Later = (fn, ms) => { setTimeout(() => { try { fn(); } catch { /* gone */ } }, ms).unref?.(); };
const rowsOf = (name: string) => db().query("SELECT id, archived_at, pending_kill_at FROM agents WHERE name = ? ORDER BY gen DESC").all(name) as Row[];
/** What to do with `agentnet-<name>` now: kill it, wait `ms` (retired less than 10 s ago, or its pending kill is still ahead), or leave it. */
function verdict(name: string, now: number): { kill: true; row: Row } | { wait: number } | null {
  const rows = rowsOf(name);
  if (!rows.length || rows.some((r) => r.archived_at == null)) return null; // unknown name, or a live row owns the session
  const newest = rows[0]!, due = Math.max(newest.archived_at! + SWEEP_MIN_AGE_MS, newest.pending_kill_at ?? 0);
  return now > due ? { kill: true, row: newest } : { wait: due - now + 1 };
}
const kill = (s: string, row: Row, t: Tmux): boolean => {
  const ok = killSession(s, t);
  clearPendingKill(row.id);
  if (ok) logEvent("info", "boot sweep: killed the session of a retired agent", { session: s, agent: row.id });
  return ok;
};
/** Kill `agentnet-<name>` sessions left by retired agents. A session is killed only when the name has rows, none of them live, and the
 *  newest was retired more than 10 s ago. A retire inside that window (a restart killed finish.ts's timer) gets a timer for the rest:
 *  the guards are checked again when it fires. bot-* sessions, root's session and names with no row are never touched.
 *  Returns the sessions killed now. */
export function bootSweep(t: Tmux = realTmux, now = Date.now(), later: Later = realLater, clock: () => number = Date.now): string[] {
  if (process.env.AGENTNET_SWEEP === "0") return [];
  const killed: string[] = [];
  for (const s of agentSessions(t)) {
    if (!s.startsWith(PREFIX) || !isAgentSession(s)) continue;
    const name = s.slice(PREFIX.length);
    if (sessionOf(name) !== s) continue;
    const v = verdict(name, now);
    if (!v) continue;
    if ("kill" in v) { if (kill(s, v.row, t)) killed.push(s); continue; }
    later(() => { const again = verdict(name, clock()); if (again && "kill" in again && agentSessions(t).includes(s)) kill(s, again.row, t); }, v.wait);
  }
  // pending kills of older retires are done (killed above) or moot (a live row owns the name now, or the session is already gone)
  try { db().run("UPDATE agents SET pending_kill_at = NULL WHERE pending_kill_at IS NOT NULL AND pending_kill_at < ? AND archived_at IS NOT NULL AND archived_at < ?", [now, now - SWEEP_MIN_AGE_MS]); } catch { /* old db */ }
  return killed;
}
