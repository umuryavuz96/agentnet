// agentnet HTTP API (/api/v1/agentnet/*): identity by per-agent token, the message outbox with a server-owned cursor,
// the one hierarchy check, status posts, and root-only spawn/despawn. Mounted only with AGENTNET=1.
import type { Hono, Context } from "hono";
import { adoptApplyRoute, adoptFacts, adoptReportRoute } from "./adopt";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { db } from "../core/db";
import { ROOT } from "../core/config";
import { isLoopback } from "../core/access";
import { isRootToken, loopbackRoot } from "../core/auth";
import { audit, logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { summarize as summarizeBg, enabled as bgSumEnabled } from "./bgsum";
import { emit, flush, get, live, all, events, doing, progressPct, lastSeq, ensureSchema, goneKey, BG_KINDS, BG_STATES, type Snapshot, type Source } from "./store";
import { pollOpened, pollClosed } from "./liveness";
import { realTmux, createdOf, hasSession, sessionOf, SCAN_AGENT, type Tmux } from "./windows";
import { sameTeam, getTeam, addMember, archiveAbandoned, createTeam, gatePasses, leadGate, teamsOf, goalError } from "./teams";
import { teamRoutes, sendTeam } from "./teamRoutes";
import { trailSearch, trailInject, cassReady } from "./trailSearch";
import { RouteBlocked } from "./autoroute";
import { planSpawn, type PlanInput } from "./placement";
import { grade, recordJob } from "./scores";
import { activeStep, addError, briefSteps, cleanSteps, isCeremony, jobCounts, jobsOf, openAsks, openJob, openSteps, planError, planSummary, PLAN_MAX, STEPS_MAX, type Job, type Origin } from "./jobs";
import { EVIDENCE_HELP, parseEvidence, verifyEvidence } from "./evidence";
import { disciplineConfig, gateReason } from "./discipline";
import { createCheck, listChecks } from "./checks";
import { hasNoteFields, logTrail, trailConfig, writeNote, type NoteFields } from "./trails";

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const TOKEN_DIR = () => join(ROOT, "run", "agentnet");
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME = NAME_RE;
export const BODY_MAX = 16_000, POLL_MAX_S = 25, HOLD_MS = 24 * 3600_000, HOLD_CAP = 100;
/** After a wake, wait this long before answering the poll so a burst of sends lands as one delivery (one turn, one list). */
export const BURST_MS = 200;
export const KINDS = ["task", "question", "answer", "report", "info"] as const;
export type Kind = (typeof KINDS)[number];
export const kindOf = (k: unknown): Kind => (KINDS as readonly string[]).includes(String(k)) ? (k as Kind) : "info";
/** `subject` as given (cut to 60), else the first line of the body cut to 60. */
export const subjectOf = (subject: unknown, body: string) => (typeof subject === "string" && subject.trim() ? subject.trim() : body.split("\n").find((l) => l.trim()) ?? body).replace(/\s+/g, " ").trim().slice(0, 60);
/** The turn text the mod submits or appends: one line per message, a header when more than one.
 *  M6: the sender's subject is free text, so it is shown as a quoted JSON string AFTER the id (`#7 [kind] from: "subject"`):
 *  a fake `(#99)` or an instruction inside it stays inside the quotes, and the mod's note says the line is data. */
export const deliveryText = (msgs: { id: number; from: string; kind: string; subject: string }[]) => {
  const lines = msgs.map((m) => `#${m.id} [${m.kind}] ${m.from}: ${JSON.stringify(m.subject.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 60))}`);
  return msgs.length > 1 ? `agentnet: ${msgs.length} messages\n${lines.join("\n")}` : lines[0] ?? "";
};

export interface AgentRow { id: string; name: string; gen: number; job: string | null; boss: string | null; model: string | null; effort: string | null; soul: string | null; goal?: string | null; audit?: string | null; project: string | null; spawned_by: string | null; spawned_at: number; token_hash: string | null; archived_at: number | null; placement?: string | null; token_file: string | null; kind: "agent" | "member" }
/** A request from this machine acts as root (the ADMIN pseudo-row): spawn, despawn, placement, reads. */
export const ADMIN: AgentRow = { id: "@admin", name: "root", gen: 0, job: null, boss: null, model: null, effort: null, soul: null, project: null, spawned_by: null, spawned_at: 0, token_hash: null, archived_at: null, token_file: null, kind: "agent" };
/** The sender of panel admin actions (Stop, Close, Run now): shown as "admin", never a real agent, no token. */
export const PANEL: AgentRow = { ...ADMIN, id: "@panel", name: "admin" };
/** The sender of a resolved owner check: the person who tapped Works / Not yet. */
export const OWNER: AgentRow = { ...ADMIN, id: "@owner", name: "owner" };
/** The live agent that owns this token, or null. */
export const agentByToken = (t: string): AgentRow | null => byToken(t);
const byToken = (t: string) => (ensureSchema(), db().query("SELECT * FROM agents WHERE token_hash = ? AND archived_at IS NULL").get(sha(t)) as AgentRow | null);
/** `root` resolves to the admin pseudo-row while no live root agent exists, so reports and sends to root always land. */
export const resolveTo = (n: string): AgentRow | null => byName(n) ?? (n === "root" ? ADMIN : null);
export const byName = (n: string) => (ensureSchema(), db().query("SELECT * FROM agents WHERE name = ? AND archived_at IS NULL").get(n) as AgentRow | null);

/** The agent endpoints, listed explicitly: the panel's requireAuth lets only these through to this module's own bearer
 *  check (unknown token = 401 here). snapshot and stream are not listed: they stay behind panel auth. */
export const agentPath = (p: string) => /^(?:\/api\/v1)?\/agentnet\/(hello|bye|poll|ack|send|inbox|report|status|events|bg|checks|gate|plan|steps(\/done|\/\d+\/drop)?|jobs|spawn|plan-spawn|despawn|teams(\/[a-z0-9-]+(\/(archive|members|messages|tasks(\/\d+\/(start|done|claim))?))?)?|tasks(\/\d+\/(start|done))?|trail\/(search|inject)|adopt\/(facts|report|apply)|agents(\/[a-z0-9-]+(\/(placement|grade|asks\/\d+\/close))?)?)$/.test(p);

// ---------- the one hierarchy check: boss, own reports, teammates under the same boss; root outbound exempt ----------
export const isRoot = (a: { name: string }) => a.name === "root";
/** The read-only setup scan session of adopt (windows.ts SCAN_AGENT). It gets the adopt tools, nothing of root. */
export const isScan = (a: { name: string }) => a.name === SCAN_AGENT;
/** Why `from` may not reach `to`, or null. The lead gate binds everyone except root: root (the director) may always send, and a team whose lead is gone is not gated.
 *  Never a gate for an agent's own boss or a teammate: `to` may sit in other, older teams whose lead is someone else. */
export function gateDenied(from: { name: string; boss?: string | null }, to: { name: string }): string | null {
  if (isRoot(from) || from.boss === to.name || sameTeam(from.name, to.name) || gatePasses(from.name, to.name)) return null;
  const lead = leadGate(to.name), team = teamsOf(to.name).find((t) => t.lead === lead);
  return `${to.name} is in team ${team?.id ?? "?"}: send it to its lead ${lead}`;
}
export function canSend(from: AgentRow, to: AgentRow): boolean {
  if (gateDenied(from, to)) return false;
  if (isRoot(from)) return true;
  return to.name === from.boss || to.boss === from.name || (!!from.boss && to.boss === from.boss) || sameTeam(from.name, to.name);
}
export const canTask = (by: AgentRow, target: AgentRow) => !gateDenied(by, target) && (isRoot(by) || by.id === target.id || target.boss === by.name);
export const VIA_BOSS = "send it via your boss";

// ---------- outbox ----------
interface Msg { id: number; from_agent: string; to_agent: string; body: string; kind: string; subject: string | null; reply_to: number | null; created_at: number; delivered_at: number | null; read_at: number | null; state: string }
const waiters = new Map<string, Set<() => void>>();
/** Every stored message, by id, the moment it is queued or held (the stream's `msg` frames come from here, whoever sent it). */
const msgSubs = new Set<(id: number) => void>();
export function onMessage(fn: (id: number) => void) { msgSubs.add(fn); return () => msgSubs.delete(fn); }
const wake = (agent: string) => { for (const w of waiters.get(agent) ?? []) w(); };
const snippet = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);
/** Queue one message; `state` tells the sender what happened. Gone by despawn/failed = refused; other gone = held 24 h (cap 100). */
export function enqueueMessage(from: AgentRow, to: AgentRow, body: string, kind: Kind, replyTo: number | null, subject = subjectOf(undefined, body), now = Date.now()): { id: number | null; state: "queued" | "held" | "gone"; lost?: true } {
  const s = to.id === ADMIN.id ? null : get(to.id);
  if (to.id !== ADMIN.id && (!s || s.life === "failed" || (s.life === "gone" && s.goneReason === "despawn"))) return { id: null, state: "gone" };
  if (s?.life === "gone" && s.goneReason === "lost") return { id: null, state: "gone", lost: true }; // its tmux session ended: not stored, the caller falls back; unread messages from before are held for the respawn
  const held = s?.life === "gone";
  if (held && (db().query("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND state = 'held'").get(to.id) as { n: number }).n >= HOLD_CAP) return { id: null, state: "gone" };
  const r = db().run("INSERT INTO messages (from_agent, to_agent, body, kind, subject, reply_to, created_at, held_until, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [from.id, to.id, body, kind, subject, replyTo, now, held ? now + HOLD_MS : null, held ? "held" : "queued"]);
  const id = Number(r.lastInsertRowid);
  emit({ agent: from.id, type: "MessageSent", data: { msg_id: id, peer: to.name, kind, snippet: snippet(body), ...(replyTo ? { reply_to: replyTo } : {}) }, source: "service", ts: now }); // reply_to closes the ask it answers (jobs.ts)
  if (!held) { if (to.id !== ADMIN.id) emit({ agent: to.id, type: "MessageReceived", data: { msg_id: id, peer: from.name, kind, subject, snippet: snippet(body) }, source: "service", ts: now }); wake(to.id); const live = byName("root"); if (to.id === ADMIN.id && live) wake(live.id); }
  for (const f of msgSubs) f(id);
  return { id, state: held ? "held" : "queued" };
}
const inboxIds = (a: AgentRow) => (isRoot(a) ? [a.id, ADMIN.id] : [a.id]);
const pending = (a: AgentRow): Msg[] => db().query(`SELECT * FROM messages WHERE to_agent IN (${inboxIds(a).map(() => "?").join(",")}) AND state = 'queued' ORDER BY id`).all(...inboxIds(a)) as Msg[];
const pub = (m: Msg, names: Map<string, string>) => ({ id: m.id, from: names.get(m.from_agent) ?? m.from_agent, kind: kindOf(m.kind), subject: m.subject ?? subjectOf(undefined, m.body), body: m.body, reply_to: m.reply_to, at: m.created_at });
/** agent id → name; the loopback root sends show as root. */
export const nameMap = () => new Map([["@admin", "root"], ["@panel", "admin"], ["@owner", "owner"], ...(db().query("SELECT id, name FROM agents").all() as { id: string; name: string }[]).map((r) => [r.id, r.name] as [string, string])]);
/** Re-boss a live agent: the row and the fold (the Cards page reads the fold). No-op when the boss is already that. */
export function setBoss(name: string, boss: string | null, now = Date.now()): boolean {
  const a = byName(name); if (!a || a.boss === boss) return false;
  db().run("UPDATE agents SET boss = ? WHERE id = ?", [boss, a.id]);
  emit({ agent: a.id, type: "BossChanged", data: { boss, was: a.boss }, source: "service", ts: now });
  return true;
}
/** A team with a lead: every member but the lead reports to the lead. Returns the names that changed. */
export function syncBosses(teamId: string): string[] {
  const t = getTeam(teamId); if (!t || t.state !== "active" || !t.lead) return [];
  const changed = t.members.filter((m) => m !== t.lead && setBoss(m, t.lead));
  if (changed.length) flush();
  return changed;
}
/** A member left a team: when it reported to that team's lead, it now reports to the lead's boss (root when there is none). */
export function releaseBoss(name: string, team: { lead: string | null }): boolean {
  if (!team.lead || byName(name)?.boss !== team.lead) return false;
  const ok = setBoss(name, byName(team.lead)?.boss ?? "root"); if (ok) flush(); return ok;
}

/** A gone agent that comes back within 24 h gets its held messages in id order. */
export function releaseHeld(agent: string, now = Date.now()) {
  db().run("UPDATE messages SET state = 'queued', held_until = NULL WHERE to_agent = ? AND state = 'held' AND held_until > ?", [agent, now]);
  db().run("UPDATE messages SET state = 'expired' WHERE to_agent = ? AND state = 'held' AND held_until <= ?", [agent, now]);
}

// ---------- identity ----------
const revoke = (id: string, now: number) => db().run("INSERT OR IGNORE INTO revoked_tokens (hash, agent_id, at) SELECT token_hash, id, ? FROM agents WHERE id = ? AND token_hash IS NOT NULL", [now, id]);
/** True when this token belonged to a retired agent. */
export const isRevoked = (t: string): boolean => (ensureSchema(), !!db().query("SELECT 1 FROM revoked_tokens WHERE hash = ?").get(sha(t)));
export interface SpawnInput { name: string; job?: string; boss?: string; model?: string; effort?: string; soul?: string; goal?: string; audit?: string; compactWindow?: number; project?: string; by: string; kind?: "agent" | "member" }
export const GHOST_MS = 60_000;
export const ghostDeps = { pidAlive: (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } }, hasSession: (s: string) => hasSession(s) };
/** A root (or setup-scan) row that will never be a director: it joined (got a token) but the plugin never said hello within GHOST_MS, or it did
 *  and both its process and its tmux session are gone. A connected root with a live process or session is never a ghost. */
export function isGhostRoot(a: AgentRow, now = Date.now()): boolean {
  const s = get(a.id); if (!s) return false;
  if (s.life === "starting") return s.connectedAt == null && now - s.spawnedAt > GHOST_MS;
  if (s.life !== "live" || s.pid == null) return false;
  return !ghostDeps.pidAlive(s.pid) && !ghostDeps.hasSession(sessionOf(a.name));
}
/** Create the spawn record and the 0600 token file. Returns the token file path (the token itself is never logged). */
export function createAgent(i: SpawnInput, now = Date.now()): { id: string; tokenFile: string; token: string } {
  ensureSchema();
  if (!NAME.test(i.name)) throw new Error("name must match ^[a-z0-9][a-z0-9-]{1,39}$");
  const old = byName(i.name);
  if (old) {
    // A row that went gone/failed (bot restarted, mod said bye) is not archived until despawn: it must not block the name. Archive it
    // here; its held messages move to the new row below. A starting/live/stopping row still blocks.
    const life = get(old.id)?.life;
    if (life !== "gone" && life !== "failed") {
      if (!((i.name === "root" || i.name === SCAN_AGENT) && isGhostRoot(old, now))) throw new Error(`${i.name} is live already: give a role without a number and the service picks the next free one`);
      retireAgent(old, "replaced", now); // a failed earlier setup left it: it must not block the director's join
    } else {
      revoke(old.id, now);
      db().run("UPDATE agents SET token_hash = NULL, archived_at = ? WHERE id = ?", [now, old.id]);
    }
  }
  const gen = ((db().query("SELECT COALESCE(MAX(gen), 0) AS g FROM agents WHERE name = ?").get(i.name) as { g: number }).g) + 1;
  const id = `${i.name}#${gen}`, t = token();
  if (!existsSync(TOKEN_DIR())) mkdirSync(TOKEN_DIR(), { recursive: true, mode: 0o700 });
  const tokenFile = join(TOKEN_DIR(), `${i.name}.token`);
  writeFileSync(tokenFile, t, { mode: 0o600 }); chmodSync(tokenFile, 0o600); // file first: a failed write leaves no row that holds the name without a token
  try { db().run("INSERT INTO agents (id, name, gen, job, boss, model, effort, soul, goal, audit, compact_window, project, spawned_by, spawned_at, token_hash, token_file, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, i.name, gen, i.job ?? null, i.boss ?? null, i.model ?? null, i.effort ?? null, i.soul ?? null, i.goal ?? null, i.audit ?? null, i.compactWindow ?? null, i.project ?? null, i.by, now, sha(t), tokenFile, i.kind ?? "agent"]);
  } catch (e) { try { unlinkSync(tokenFile); } catch { /* none */ } throw e; }
  if (old) db().run("UPDATE messages SET to_agent = ? WHERE to_agent = ? AND state = 'held'", [id, old.id]); // held for the gone one: the new one gets them on hello
  emit({ agent: id, type: "AgentSpawned", data: { id, name: i.name, gen, job: i.job ?? null, boss: i.boss ?? null, model: i.model ?? null, effort: i.effort ?? null, soul: i.soul ?? null, goal: i.goal ?? null, audit: i.audit ?? null, compactWindow: i.compactWindow ?? null, project: i.project ?? null, by: i.by }, source: "spawn", ts: now });
  flush();
  return { id, tokenFile, token: t };
}
/** Revoke the token, archive the row, delete the token file; the fold gets AgentGone{reason}. A despawn also closes every team that has no live member left; returns their ids. */
export function retireAgent(a: AgentRow, reason: string, now = Date.now(), kill: (pid: number | null, placement: string | null, name?: string) => void = killAgent): string[] {
  revoke(a.id, now);
  db().run("UPDATE agents SET token_hash = NULL, archived_at = ? WHERE id = ?", [now, a.id]);
  try { unlinkSync(a.token_file ?? join(TOKEN_DIR(), `${a.name}.token`)); } catch { /* already gone */ }
  const s = get(a.id);
  if (reason === "despawn" && a.kind !== "member") kill(s?.pid ?? null, a.placement ?? null, a.name);
  emit({ agent: a.id, type: "AgentGone", data: { reason }, source: "service", ts: now, dedup: reason === "despawn" ? `despawn:${a.id}` : goneKey(s ?? null, a.id) });
  const closed = reason === "despawn" ? archiveAbandoned(a.name, (n) => isRoot({ name: n })) : [];
  flush();
  if (reason === "despawn") scoreJob(a); // the despawn closed the open job (jobs.ts): nothing stays open on a gone agent
  return closed;
}
/** Write the score row of the agent's last job once it is closed (a second call for the same job changes nothing). */
function scoreJob(a: AgentRow): Job | null {
  const s = get(a.id), j = s ? jobsOf(s).at(-1) ?? null : null;
  if (s && j && j.closedAt != null) recordJob({ id: a.id, name: a.name, model: s.model ?? a.model, soul: s.soul ?? a.soul, project: s.project ?? a.project }, j);
  return j;
}
/** The brief file of a spawn or a job_open: an absolute .md path of at most 200 KB. Anything else reads as empty. */
export function readBrief(path: string | undefined): string {
  try { return path && isAbsolute(path) && /\.(md|markdown|txt)$/i.test(path) && statSync(path).size <= 200_000 ? readFileSync(path, "utf8") : ""; } catch { return ""; }
}
/** Open a job on an agent: JobOpened, and the plan when there is one (the given steps, else the brief's `## Steps`). Returns what the caller should know. */
export function startJob(agentId: string, i: { by: string; goal?: string | null; brief?: string | null; steps?: unknown; maxSteps?: unknown }, now = Date.now()): { steps: number; warnings: string[] } {
  const given = cleanSteps(i.steps), fromBrief = given.length ? [] : briefSteps(readBrief(i.brief ?? undefined)), steps = given.length ? given : fromBrief, warnings: string[] = [];
  const ms = Number(i.maxSteps), planMax = Number.isInteger(ms) && ms > PLAN_MAX ? Math.min(ms, STEPS_MAX) : null;
  emit({ agent: agentId, type: "JobOpened", data: { by: i.by, goal: i.goal ?? null, brief: i.brief ?? null, ...(planMax ? { planMax } : {}) }, source: "service", ts: now });
  if (steps.length > (planMax ?? PLAN_MAX)) warnings.push(`the ${given.length ? "given plan" : "brief"} has ${steps.length} steps and a plan has at most ${planMax ?? PLAN_MAX}: no plan was set, the agent sets it with plan_set (or pass max_steps, up to ${STEPS_MAX})`);
  else if (steps.length) emit({ agent: agentId, type: "PlanSet", data: { steps, origin: given.length ? "boss" : "brief", by: i.by }, source: "service", ts: now });
  else if (i.brief) warnings.push("the brief has no `## Steps` section with numbered lines: the agent sets the plan with plan_set");
  flush();
  return { steps: warnings.length ? 0 : steps.length, warnings };
}
/** A pid worth signalling: an integer above 1 (0, 1 and negatives would reach every process of the user). */
export const goodPid = (x: unknown): number | null => { const n = Number(x); return typeof x !== "boolean" && x !== null && Number.isInteger(n) && n > 1 ? n : null; };
/** Is `pid` one of `roots` or a descendant of one? `ppid` looks a parent up. */
export function inTree(pid: number, roots: number[], ppid: (p: number) => number | null): boolean {
  for (let p: number | null = pid, i = 0; p && p > 1 && i < 32; p = ppid(p), i++) if (roots.includes(p)) return true;
  return false;
}
export interface KillDeps { tmux: Tmux; ppid: (p: number) => number | null; signal: (pid: number, sig: string) => void; later: (fn: () => void, ms: number) => void }
const realKillDeps = (): KillDeps => ({
  tmux: realTmux,
  ppid: (p) => { const r = Bun.spawnSync(["/bin/ps", "-o", "ppid=", "-p", String(p)]); return Number(new TextDecoder().decode(r.stdout).trim()) || null; },
  signal: (pid, sig) => { try { process.kill(pid, sig as NodeJS.Signals); } catch { /* gone */ } },
  later: (fn, ms) => { setTimeout(() => { try { fn(); } catch { /* gone */ } }, ms); },
});
/** Despawn: end the claude process, then kill its detached tmux session (exact name; a window placement from before M8 is
 *  killed by id). The reported pid is not trusted: it is signalled (SIGTERM, SIGKILL after 3 s) only while it is inside the
 *  agent's own tmux pane. The session is killed only if it is still the one that existed at despawn (same session_created). */
export function killAgent(pid: number | null, placement: string | null, name?: string, d: KillDeps = realKillDeps()) {
  const session = placement && /^agentnet-/.test(placement) ? placement : name ? `agentnet-${name}` : null;
  const panes = () => session ? d.tmux.run(["list-panes", "-t", `=${session}:`, "-F", "#{pane_pid}"]).out.split("\n").map((x) => Number(x.trim())).filter((n) => n > 1) : [];
  const p = goodPid(pid);
  if (p && inTree(p, panes(), d.ppid)) { d.signal(p, "SIGTERM"); d.later(() => { if (inTree(p, panes(), d.ppid)) d.signal(p, "SIGKILL"); }, 3000); }
  const id = placement?.match(/[%@]\d+$/)?.[0], created = session ? createdOf(session, d.tmux) : "";
  d.later(() => {
    if (session) { if (createdOf(session, d.tmux) === created) d.tmux.run(["kill-session", "-t", `=${session}`]); }
    else if (id) d.tmux.run([id.startsWith("@") ? "kill-window" : "kill-pane", "-t", id]);
  }, 3500);
}

// ---------- routes ----------
export type Ctx = Context<Env & { Variables: { agent: AgentRow } }>;
export const bad = (c: Context, msg: string) => problem(c, 422, "Can't do that", msg);
const REQ_MAX = 64_000, EVENTS_PER_CALL = 50, RATE_N = 300, RATE_MS = 60_000;
const rate = new Map<string, number[]>();
/** LOW: a token holder can post at most RATE_N writes per minute to /events, /send, /tasks, /report (root is exempt). */
export const rateOk = (agent: string, now = Date.now()) => { const l = (rate.get(agent) ?? []).filter((t) => now - t < RATE_MS); l.push(now); rate.set(agent, l); return l.length <= RATE_N; };
export const body = async (c: Context): Promise<Record<string, unknown>> => { try { const t = await c.req.text(); if (t.length > REQ_MAX) return {}; const b = JSON.parse(t); return b && typeof b === "object" ? b as Record<string, unknown> : {}; } catch { return {}; } };
/** Refuse a plan or report call: the agent reads `detail`, and the refusal is logged on its event log (`Refused`, with the rule) so it can be counted. */
function refuse(c: Context, a: AgentRow, rule: string, detail: string, status: 404 | 409 | 422 = 409) {
  if (a.id !== ADMIN.id && get(a.id)) { emit({ agent: a.id, type: "Refused", data: { rule, detail: detail.slice(0, 300) }, source: "service" }); flush(); }
  return problem(c, status, "Can't do that", detail);
}
const viewOf = (s: Snapshot) => ({ ...s, doing: doing(s), progressPct: progressPct(s) });

/** Panel auth (the Chat tab): POST /agentnet/agents/:name/message {body, kind?, subject?} sends as root. 404 unknown, 410 despawned/failed, 422 bad body. */
export function agentnetPanelSendRoute(api: Hono<Env>) {
  api.post("/agentnet/agents/:name/message", async (c) => {
    const to = resolveTo(String(c.req.param("name")));
    if (!to || to.id === ADMIN.id) return problem(c, 404, "Not Found", "no live agent by that name");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>, text = typeof b.body === "string" ? b.body : "";
    if (!text.trim()) return bad(c, "body is empty");
    if (text.length > BODY_MAX) return bad(c, `body over ${BODY_MAX} characters`);
    const out = enqueueMessage(ADMIN, to, text, kindOf(b.kind), null, subjectOf(b.subject, text));
    flush();
    audit(c.get("actor"), "agentnet.panel-send", to.name, out.state === "gone" ? "failed" : "ok", c.get("trace"), { msg_id: out.id });
    if (out.lost) return problem(c, 409, "Conflict", `${to.name} is lost: its tmux session ended. Nothing stored. Respawn it.`, { state: "lost" });
    if (out.state === "gone") return problem(c, 410, "Gone", `${to.name} is gone; nothing stored`);
    return c.json({ id: out.id, to: to.name, state: out.state });
  });
}

/** A decision note from task_done / report done: var/trails/<date>-<agent>-<slug>.md. Returns the file name, null when it fails. */
function noteFor(a: AgentRow, task: string, b: Record<string, unknown>): string | null {
  try { return writeNote({ agent: a.name, task, repo: a.project }, b as NoteFields).split("/").pop() ?? null; } catch (e) { logEvent("warn", "trail note failed", { agent: a.name, error: (e as Error).message }); return null; }
}

/** Panel auth (the Search tab): GET /trails/search?q=&limit=1..20&repo=&sources=all|fts|cass; `cass` says whether cass is installed and indexed. Same search as trail_search, full hits. */
export function trailsPanelRoute(api: Hono<Env>) {
  api.get("/trails/search", async (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 500), t0 = performance.now();
    const src = c.req.query("sources") ?? "all"; // all | fts | cass
    const hits = q.trim() ? (await trailSearch(q, { repo: c.req.query("repo") || undefined, limit: Number(c.req.query("limit")) || 10, max: 20, cass: src !== "fts", fts: src !== "cass" })).hits : [];
    return c.json({ q, ms: Math.round(performance.now() - t0), cass: cassReady(), hits });
  });
}

export function agentnetRoutes(api: Hono<Env>) {
  ensureSchema();
  const r = api.basePath("/agentnet") as unknown as Hono<Env & { Variables: { agent: AgentRow } }>;
  // Every call carries a token (Bearer): an agent's own, or run/root.token for root. Unknown or revoked = 401.
  r.use("*", async (c, next) => {
    if (!agentPath(c.req.path)) return next(); // the page routes (snapshot, stream, open, close, close-all) keep the panel auth whatever the mount order
    const h = c.req.header("authorization") ?? "", t = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    let a = t ? byToken(t) : null;
    if (!a && t && isRevoked(t)) return problem(c, 401, "Unauthorized", "agentnet: revoked agent token"); // a retired agent never comes back as root
    if (!a && t && isRootToken(t)) a = ADMIN; // run/root.token
    if (!a && loopbackRoot() && isLoopback(c)) a = ADMIN; // house flag AGENTNET_LOOPBACK_ROOT=on: this machine, no token or an unknown one, is root
    if (!a) return problem(c, 401, "Unauthorized", "agentnet: unknown or revoked agent token");
    c.set("agent", a); c.set("actor", `agent:${a.name}`);
    if (Number(c.req.header("content-length") ?? 0) > REQ_MAX) return problem(c, 413, "Payload Too Large", "agentnet: body over 64 kB");
    if (c.req.method === "POST" && /\/(events|send|tasks|report|plan|steps|done|drop)$/.test(c.req.path) && !isRoot(a) && !rateOk(a.id)) return problem(c, 429, "Too Many Requests", "agentnet: over 300 writes a minute");
    await next();
  });
  r.post("/hello", async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c), now = Date.now(), prev = get(a.id);
    const session = typeof b.session === "string" ? b.session : null;
    emit({ agent: a.id, type: "AgentConnected", data: { session, pid: goodPid(b.pid), version: b.version ?? null, model: b.model ?? null, client: b.client ?? "claude-code" }, source: "mod", ts: now, dedup: session ? `hello:${a.id}:${session}:${b.pid ?? ""}:${prev?.life === "gone" ? prev.lifeSince : 0}` : undefined });
    releaseHeld(a.id, now); flush();
    audit(`agent:${a.name}`, "agentnet.hello", a.id, "ok", c.get("trace"));
    const snap = get(a.id); // null for the root pseudo-row (root.token): it has no card
    return c.json({ agent: snap ? viewOf(snap) : null, root: isRoot(a), scan: isScan(a), poll_max_s: POLL_MAX_S });
  });
  r.post("/bye", async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c);
    emit({ agent: a.id, type: "AgentGone", data: { reason: typeof b.reason === "string" ? b.reason.slice(0, 40) : "exit" }, source: "mod", dedup: goneKey(get(a.id), a.id) }); flush();
    return c.body(null, 204);
  });
  // Long-poll: everything still queued for me (server-owned cursor: redelivered until acked), or wait up to `wait` s for the first one.
  r.get("/poll", async (c: Ctx) => {
    const a = c.get("agent"), wait = Math.min(POLL_MAX_S, Math.max(0, Number(c.req.query("wait") ?? POLL_MAX_S)));
    let msgs = pending(a);
    pollOpened(a.id);
    try {
      if (!msgs.length && wait > 0) {
        await new Promise<void>((res) => { const set = waiters.get(a.id) ?? waiters.set(a.id, new Set()).get(a.id)!; const w = () => { set.delete(w); clearTimeout(t); res(); }; set.add(w); const t = setTimeout(w, wait * 1000); c.req.raw.signal.addEventListener("abort", w); });
        if (!c.req.raw.signal.aborted) await new Promise((res) => setTimeout(res, BURST_MS)); // gather the rest of a burst
        msgs = pending(a);
      }
    } finally { pollClosed(a.id); }
    if (c.req.raw.signal.aborted) return c.body(null, 499 as 400); // the client went away mid-poll (killed, or reconnecting): the sweep decides
    const names = nameMap(), out = msgs.map((m) => pub(m, names));
    return c.json({ messages: out, text: out.length ? deliveryText(out) : null });
  });
  r.post("/ack", async (c: Ctx) => { // the mod has handed the message to the model (submit resolved, or the pointer is stored)
    const a = c.get("agent"), b = await body(c), ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
    const now = Date.now();
    for (const id of ids) for (const who of inboxIds(a)) db().run("UPDATE messages SET state = 'delivered', delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND to_agent = ? AND state = 'queued'", [now, id, who]);
    return c.json({ acked: ids });
  });
  r.post("/inbox", async (c: Ctx) => { // the model reads: marks read; `peek` leaves the state alone
    const a = c.get("agent"), b = await body(c), names = nameMap(), limit = Math.min(50, Math.max(1, Number(b.limit) || 20));
    const ids = inboxIds(a), q = ids.map(() => "?").join(",");
    const rows = db().query(`SELECT * FROM messages WHERE to_agent IN (${q}) AND state IN ('queued', 'delivered') ORDER BY id LIMIT ?`).all(...ids, limit) as Msg[];
    if (!b.peek) for (const m of rows) db().run("UPDATE messages SET state = 'read', read_at = ? WHERE id = ?", [Date.now(), m.id]);
    const left = (db().query(`SELECT COUNT(*) AS n FROM messages WHERE to_agent IN (${q}) AND state IN ('queued', 'delivered')`).get(...ids) as { n: number }).n;
    const work = b.peek ? [] : rows.filter((m) => m.kind === "task" && m.from_agent !== a.id);
    const trails = work.length && !isRoot(a) ? (await trailInject(a.name, "task_msg", work.map((m) => `${m.subject ?? ""}\n${m.body}`).join("\n"), a.project ?? undefined, a.spawned_at)).text : "";
    return c.json({ messages: rows.map((m) => pub(m, names)), unread_left: left, ...(trails ? { trails } : {}) });
  });
  const sendRoute = (kind: "message" | "report") => async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c);
    const text = typeof b.body === "string" ? b.body : typeof b.summary === "string" ? b.summary : "";
    if (!text.trim()) return bad(c, "body is empty");
    if (text.length > BODY_MAX) return bad(c, `body over ${BODY_MAX} characters`);
    const toName = kind === "report" ? a.boss : typeof b.to === "string" ? b.to : "";
    if (!toName) return bad(c, kind === "report" ? "you have no boss on record" : "to is required");
    if (kind === "message" && toName.startsWith("team:")) { const t = sendTeam(a, toName.slice(5), text, kindOf(b.kind), subjectOf(b.subject, text)); return t.error ? problem(c, t.status, "Can't do that", t.error) : c.json(t); }
    const to = resolveTo(toName);
    if (!to) return problem(c, 404, "Not Found", `no live agent named ${toName}`);
    if (!canSend(a, to)) return problem(c, 403, "Forbidden", gateDenied(a, to) ?? VIA_BOSS);
    // The done report (or a failed one) closes the job; the report itself is never a step. The plan summary rides along.
    const snap = get(a.id), job = kind === "report" && snap && !isRoot(a) && a.id !== ADMIN.id ? openJob(snap) : null, closes = !!job && (b.state === "done" || b.state === "failed");
    if (job && b.state === "done" && disciplineConfig().blockDoneReport) {
      const open = openSteps(job);
      if (open.length) return refuse(c, a, "report-open-steps", `agentnet: you cannot report done while ${open.length} step${open.length > 1 ? "s are" : " is"} open (${open.slice(0, 5).map((t) => `${job.id}.${t.n}`).join(", ")}). ${job.legacy ? "Finish them with mcp__agentnet__task_done first." : "Close each with mcp__agentnet__step_done and its proof, or drop it with mcp__agentnet__step_drop and a reason. The report is not a step."}`);
    }
    const k: Kind = kind === "report" ? "report" : kindOf(b.kind);
    const sent = closes && job && !job.legacy ? `${text}\n\n${planSummary(job, snap?.asks ?? [])}` : text;
    const out = enqueueMessage(a, to, sent, k, Number(b.reply_to) || null, subjectOf(b.subject, text));
    if (closes && out.id != null) { emit({ agent: a.id, type: "JobClosed", data: { outcome: b.state === "failed" ? "failed" : "done", reason: String(b.state), msg_id: out.id }, source: "mcp" }); flush(); scoreJob(a); }
    if (kind === "report" && b.state === "done" && hasNoteFields(b)) noteFor(a, text.split("\n")[0]!.slice(0, 160), b);
    if (kind === "report") { emit({ agent: a.id, type: "Reported", data: { to: to.name, msg_id: out.id }, source: "mcp" }); if (b.state) emit({ agent: a.id, type: "StatusReported", data: { doing: text.slice(0, 120), phase: String(b.state), progress: null, blockedOn: b.state === "blocked" ? text.slice(0, 120) : null }, source: "mcp" }); }
    flush();
    if (out.lost) return problem(c, 409, "Conflict", `${to.name} is lost: its tmux session ended. Nothing stored. Respawn it.`, { state: "lost" });
    if (out.state === "gone") return problem(c, 410, "Gone", `${to.name} is gone; nothing stored`);
    return c.json({ msg_id: out.id, to: to.name, state: out.state, ...(closes && job ? { job_closed: job.id } : {}) });
  };
  r.post("/send", sendRoute("message"));
  r.post("/report", sendRoute("report"));
  // ---------- the plan (docs/task-discipline.md): plan_set, step_done, step_add, step_drop, job_open ----------
  const planOut = (id: string, extra: Record<string, unknown> = {}) => { const s = get(id), j = s ? jobsOf(s).at(-1) : undefined, act = activeStep(j ?? null); return { ...(j ? { plan: planSummary(j, s?.asks ?? []), next: act ? `${j.id}.${act.n}: ${act.text}` : j.closedAt == null && j.steps.length ? "every step is closed: send your report (state done) to close the job" : null } : {}), ...extra }; };
  /** Add one step to an open job that has a plan, by the cap rules. Returns the refusal, or null when it was added. */
  const addStep = (c: Ctx, by: AgentRow, target: AgentRow, job: Job, text: string, origin: Origin, originMsg: number | null, dedup?: string) => {
    const err = addError(job, origin, text);
    if (err) return refuse(c, by, origin === "self" && err.includes("of your own") ? "self-cap" : "step-cap", err);
    const before = jobCounts(job);
    emit({ agent: target.id, type: "StepAdded", data: { text, origin, originMsg }, source: "mcp", dedup });
    // growth warning, once: the moment the added steps pass half of the plan, root hears about it
    if (!job.legacy && before.added * 2 <= job.plan && (before.added + 1) * 2 > job.plan) { const root = resolveTo("root"); if (root) enqueueMessage(target, root, `The plan of ${target.name} (job ${job.id}) grew by more than half: ${job.plan} steps in the plan, ${before.added + 1} added since. Open a new job (job_open) or re-brief.`, "info", null, `plan of ${target.name} grew by half`); }
    return null;
  };
  r.post("/plan", async (c: Ctx) => { // plan_set: the whole plan of the open job, until the first step is closed
    const a = c.get("agent"), b = await body(c), steps = cleanSteps(b.steps), snap = get(a.id);
    if (!snap) return problem(c, 404, "Not Found", "no status yet");
    const job = openJob(snap), had = jobsOf(snap).length > 0;
    if (!job && had) return refuse(c, a, "job-closed", "agentnet: your job is closed. A new job is opened by your boss (mcp__agentnet__job_open); a follow-up ask is answered with reply_to and needs no plan.");
    const err = planError(job, steps);
    if (err) return refuse(c, a, "plan", err);
    emit({ agent: a.id, type: "PlanSet", data: { steps, origin: job?.brief ? "brief" : "self", by: a.name }, source: "mcp" }); flush();
    const chores = steps.filter(isCeremony);
    const trails = !isRoot(a) ? (await trailInject(a.name, "task_add", steps.join("\n"), a.project ?? undefined, a.spawned_at)).text : "";
    return c.json(planOut(a.id, { ...(chores.length ? { warnings: [`${chores.map((t) => `"${t}"`).join(", ")} ${chores.length > 1 ? "look" : "looks"} like a chore, not an outcome. The report closes the job by itself and reading or committing is part of a step: adjust the plan (one adjust is allowed) or leave it.`] } : {}), ...(trails ? { trails } : {}) }));
  });
  r.post("/steps/done", async (c: Ctx) => { // step_done: close the active step with its proof; the next step becomes active
    const a = c.get("agent"), b = await body(c), snap = get(a.id), job = snap ? openJob(snap) : null, step = activeStep(job);
    if (!job || !step) return refuse(c, a, "no-step", job ? "agentnet: no step is open. Every step is closed: send your report (state done) to close the job." : "agentnet: you have no open job with a plan. Set your plan first with mcp__agentnet__plan_set.");
    const ev = parseEvidence(b.evidence);
    if ("error" in ev) return refuse(c, a, "evidence", ev.error, 422);
    if (!ev.length) return refuse(c, a, "evidence", `agentnet: step_done needs proof that step ${job.id}.${step.n} is done. ${EVIDENCE_HELP}.`, 422);
    const checked = verifyEvidence(ev, { id: a.id, project: snap!.project ?? a.project });
    emit({ agent: a.id, type: "StepClosed", data: { n: step.n, evidence: checked, note: typeof b.note === "string" ? b.note.slice(0, 300) : null }, source: "mcp" }); flush();
    const note = hasNoteFields(b) ? noteFor(a, step.text, b) : null, missing = checked.filter((e) => e.ok === false);
    return c.json(planOut(a.id, { closed: `${job.id}.${step.n}`, evidence: checked, ...(missing.length ? { warnings: [`not found: ${missing.map((e) => `${e.kind} ${e.value}`).join("; ")}. It is stored as given and shown as not verified.`] } : {}), ...(note ? { note } : {}) }));
  });
  r.post("/steps", async (c: Ctx) => { // step_add: new scope, after the active step; because = the boss message that asked for it, or "self"
    const a = c.get("agent"), b = await body(c), snap = get(a.id), job = snap ? openJob(snap) : null, text = cleanSteps([b.text])[0] ?? "";
    if (!job || !job.steps.length) return refuse(c, a, "no-step", "agentnet: you have no open job with a plan. Set your plan first with mcp__agentnet__plan_set.");
    const self = b.because == null || /^self$/i.test(String(b.because).trim()), msgId = self ? null : Number(String(b.because).replace(/^#/, ""));
    if (!self) {
      const m = Number.isInteger(msgId) ? db().query("SELECT from_agent, to_agent FROM messages WHERE id = ?").get(msgId) as { from_agent: string; to_agent: string } | null : null, from = m ? nameMap().get(m.from_agent) : null;
      if (!m || m.to_agent !== a.id || (from !== a.boss && from !== "root")) return refuse(c, a, "because", `agentnet: because must be the id of a message to you from your boss or root (or "self"). ${Number.isInteger(msgId) ? `#${msgId} is not one.` : ""}`, 422);
    }
    const no = addStep(c, a, a, job, text, self ? "self" : "boss", msgId);
    if (no) return no;
    flush();
    return c.json(planOut(a.id));
  });
  r.post("/steps/:n/drop", async (c: Ctx) => { // step_drop: an open step that no longer applies
    const a = c.get("agent"), b = await body(c), n = Number(c.req.param("n")), snap = get(a.id), job = snap ? openJob(snap) : null, step = job?.steps.find((x) => x.n === n);
    if (!job || !step || (step.status !== "pending" && step.status !== "active")) return refuse(c, a, "no-step", `agentnet: no open step ${n}.`, 404);
    const reason = typeof b.reason === "string" ? b.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!reason) return refuse(c, a, "drop-reason", "agentnet: step_drop needs a reason.", 422);
    emit({ agent: a.id, type: "StepDropped", data: { n, reason }, source: "mcp" }); flush();
    return c.json(planOut(a.id));
  });
  r.post("/jobs", async (c: Ctx) => { // job_open: the boss or root gives a live agent a new job; the old one must be closed
    const a = c.get("agent"), b = await body(c), target = typeof b.agent === "string" ? byName(b.agent) : null;
    if (!target) return problem(c, 404, "Not Found", "no such live agent");
    if (target.id === a.id || !canTask(a, target)) return problem(c, 403, "Forbidden", gateDenied(a, target) ?? "only the agent's boss or root may open a job on it");
    const goal = typeof b.goal === "string" ? b.goal.replace(/\s+/g, " ").trim().slice(0, 500) : "", snap = get(target.id);
    if (!goal) return bad(c, "goal is required: one line that says what done looks like");
    if (!snap) return problem(c, 404, "Not Found", "no status yet");
    const open = openJob(snap);
    if (open) return refuse(c, a, "job-open", `agentnet: job ${open.id} of ${target.name} is still open (${openSteps(open).length} open steps). It closes with the agent's done report; ask for it first.`);
    const brief = str(b.brief), made = startJob(target.id, { by: a.name, goal, brief, steps: b.steps, maxSteps: b.max_steps });
    const j = jobsOf(get(target.id)!).at(-1)!;
    const msg = enqueueMessage(a, target, `New job ${j.id}: ${goal}${brief ? `\nBrief: ${brief}` : ""}\n${j.steps.length ? planSummary(j) : "No plan yet: read the brief and set it with mcp__agentnet__plan_set (at most 7 steps)."}`, "info", null, `new job ${j.id}: ${goal}`.slice(0, 60)); flush();
    audit(`agent:${a.name}`, "agentnet.job-open", target.id, "ok", c.get("trace"), { job: j.id, steps: made.steps });
    return c.json({ agent: target.name, job: j.id, steps: made.steps, msg_id: msg.id, ...(made.warnings.length ? { warnings: made.warnings } : {}) }, 201);
  });
  r.post("/agents/:name/asks/:id/close", async (c: Ctx) => { // root: an ask that was answered without reply_to, or that no longer matters
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const t = byName(String(c.req.param("name"))), id = Number(c.req.param("id")), s = t ? get(t.id) : null;
    if (!t || !s || !openAsks(s).some((x) => x.id === id)) return problem(c, 404, "Not Found", "no such open ask");
    emit({ agent: t.id, type: "AskClosed", data: { id, by: a.name }, source: "mcp" }); flush();
    return c.json({ asks: get(t.id)!.asks ?? [] });
  });
  // ---------- the old task tools: aliases for one release, so agents that run today do not break ----------
  r.post("/tasks", async (c: Ctx) => { // task_add: to myself, or (boss / root) to a report
    const a = c.get("agent"), b = await body(c);
    const target = typeof b.agent === "string" && b.agent ? byName(b.agent) : a;
    if (!target) return problem(c, 404, "Not Found", "no such agent");
    if (!canTask(a, target)) return problem(c, 403, "Forbidden", gateDenied(a, target) ?? "only the agent, its boss or root may add tasks to it");
    const titles = cleanSteps(Array.isArray(b.titles) ? b.titles : [b.title]).slice(0, 20);
    if (!titles.length) return bad(c, "title or titles required");
    // A list that was made with the old tools keeps working as it did (no caps), and so does the list of root and of a team member: they have no job that closes.
    // Everything else goes by the plan rules, so the old names are not a way around them.
    const snap = get(target.id), job = snap ? openJob(snap) : null, last = snap ? jobsOf(snap).at(-1) : undefined, old = isRoot(target) || target.kind === "member" || !!(job ?? last)?.legacy, op = typeof b.op === "string" ? b.op : null;
    if (!old && !job && last) return refuse(c, a, "job-closed", `agentnet: the job of ${target.name} is closed. A new job is opened by its boss with mcp__agentnet__job_open; a follow-up ask is answered with reply_to and needs no task.`);
    if (!old && !job?.steps.length) { // no plan yet: the list is the plan
      const err = planError(job, titles);
      if (err) return refuse(c, a, "plan", err);
      emit({ agent: target.id, type: "PlanSet", data: { steps: titles, origin: a.id === target.id ? "self" : "boss", by: a.name }, source: "mcp", dedup: op ? `task:${target.id}:${op}:plan` : undefined });
    } else if (!old && job) { // a job with a plan: each title is a step_add (self, or boss when a boss adds it)
      let j = job;
      for (const [i, text] of titles.entries()) { const no = addStep(c, a, target, j, text, a.id === target.id ? "self" : "boss", null, op ? `task:${target.id}:${op}:${i}` : undefined); if (no) { flush(); return no; } flush(); j = openJob(get(target.id)!) ?? j; }
    } else { // a list made with the old tools (or no job yet): as before, no caps
      const base = Math.max(0, ...(job?.steps.map((t) => t.n) ?? [0]));
      titles.forEach((text, i) => emit({ agent: target.id, type: "TaskAdded", data: { id: base + i + 1, text }, source: "mcp", dedup: op ? `task:${target.id}:${op}:${i}` : undefined }));
    }
    flush();
    const trails = target.id === a.id && !isRoot(a) ? (await trailInject(a.name, "task_add", titles.join("\n"), a.project ?? undefined, a.spawned_at)).text : "";
    return c.json({ tasks: get(target.id)?.tasks ?? [], ...(trails ? { trails } : {}) });
  });
  r.post("/tasks/:id/:op", async (c: Ctx) => { // task_start: a no-op on a planned job; task_done: step_done with "none: old tool"
    const a = c.get("agent"), id = Number(c.req.param("id")), op = String(c.req.param("op"));
    if (!["start", "done"].includes(op)) return bad(c, "op must be start or done");
    const snap = get(a.id), job = snap ? openJob(snap) : null, task = (snap?.tasks ?? []).find((t) => t.id === id);
    if (!task) return problem(c, 404, "Not Found", `no task ${id}`);
    const b = op === "done" ? await body(c) : {};
    if (job && !job.legacy) { if (op === "done" && task.status !== "done") emit({ agent: a.id, type: "StepClosed", data: { n: id, evidence: [{ kind: "none", value: "old tool", ok: null }], note: null }, source: "mcp" }); }
    else emit({ agent: a.id, type: op === "start" ? "TaskStarted" : "TaskDone", data: { id }, source: "mcp" });
    flush();
    const note = op === "done" && hasNoteFields(b) ? noteFor(a, task.text, b) : null;
    return c.json({ tasks: get(a.id)!.tasks, ...(note ? { note } : {}) });
  });
  r.post("/trail/search", async (c: Ctx) => { // trail_search: FTS5 (notes + Entire) first, cass fills up to 3; compact text for the model
    const a = c.get("agent"), b = await body(c), q = typeof b.query === "string" ? b.query.slice(0, 500) : "";
    if (!q.trim()) return bad(c, "query is required");
    if (trailConfig().off_agents.includes(a.name)) return c.json({ text: "Trail search is off for this run.", hits: [] }); // A/B control agents
    const repo = typeof b.repo === "string" && b.repo ? b.repo : undefined;
    const t0 = performance.now(), out = await trailSearch(q, { repo, limit: Number(b.limit) || 3 });
    logTrail({ agent: a.name, source: "trail_search", query: q, hits: out.hits, chars: out.text.length, ms: Math.round(performance.now() - t0) });
    audit(`agent:${a.name}`, "agentnet.trail-search", a.id, "ok", c.get("trace"), { hits: out.hits.length });
    return c.json({ text: out.text || "No past trails for that query.", hits: out.hits.map((h) => h.id) });
  });
  r.post("/trail/inject", async (c: Ctx) => { // spawn-agent.sh (root): the trails block for a boot prompt; logged like the other injections
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const b = await body(c), name = typeof b.agent === "string" ? b.agent : "", text = typeof b.text === "string" ? b.text.slice(0, 4000) : "";
    if (!NAME.test(name) || !text.trim()) return bad(c, "agent and text are required");
    const out = await trailInject(name, "spawn", text, typeof b.repo === "string" && b.repo ? b.repo : undefined);
    return c.json({ text: out.text, skipped: out.skipped ?? null });
  });
  r.get("/adopt/facts", (c: Ctx) => { if (!isScan(c.get("agent")) && c.get("agent").id !== ADMIN.id) return problem(c, 403, "Forbidden", "setup scan only"); return adoptFacts(c as never); });
  r.post("/adopt/report", async (c: Ctx) => { if (!isScan(c.get("agent")) && c.get("agent").id !== ADMIN.id) return problem(c, 403, "Forbidden", "setup scan only"); return adoptReportRoute(c as never, await body(c)); });
  r.post("/adopt/apply", async (c: Ctx) => { if (!isScan(c.get("agent"))) return problem(c, 403, "Forbidden", "setup scan only"); return adoptApplyRoute(c as never, await body(c)); });
  /** The mod asks before every work tool. The gate asks one thing: is there a plan (after the grace time). Allowed (200 {allow:true}) or a reason
   *  the agent reads. Root, the loopback admin and team members are exempt. A refusal is logged once a minute. */
  r.get("/gate", (c: Ctx) => {
    const a = c.get("agent"), exempt = isRoot(a) || a.id === ADMIN.id || a.kind === "member", s = get(a.id), now = Date.now();
    const why = gateReason({ exempt, spawnedAt: a.spawned_at, hasPlan: !!s && jobsOf(s).some((j) => j.steps.length > 0), now });
    if (why) { emit({ agent: a.id, type: "Refused", data: { rule: "gate", detail: why.slice(0, 200) }, source: "service", dedup: `refused:gate:${a.id}:${Math.floor(now / 60_000)}` }); flush(); }
    return c.json(why ? { allow: false, reason: why } : { allow: true });
  });
  r.post("/status", async (c: Ctx) => { // set_status
    const a = c.get("agent"), b = await body(c);
    emit({ agent: a.id, type: "StatusReported", data: { doing: typeof b.doing === "string" ? b.doing.slice(0, 120) : null, progress: b.progress == null ? null : Math.max(0, Math.min(100, Number(b.progress))), phase: typeof b.phase === "string" ? b.phase.slice(0, 40) : null, blockedOn: typeof b.blocked_on === "string" ? b.blocked_on.slice(0, 120) : null }, source: "mcp" }); flush();
    return c.json({ agent: viewOf(get(a.id)!) });
  });
  // Status posts from the mod: {events: [{type, data, dedup?, ts?, transient?}]}; unknown types fold to nothing and are dropped by the reducer.
  const EVENT_TYPES = new Set(["TurnStarted", "ToolStarted", "ToolFinished", "TurnEnded", "AwaitingInput", "ContextMeasured", "CostMeasured", "RateWindow", "TaskAdded", "TaskStarted", "TaskDone", "SubagentStarted", "SubagentFinished"]);
  r.post("/events", async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c), list = (Array.isArray(b.events) ? b.events : [b]).slice(0, EVENTS_PER_CALL);
    let n = 0;
    // The built-in todo list of the session is mirrored only where it was the list already: an open list made with the old tools, root, a team member.
    // For every other agent it stays private, so it cannot open or grow a plan around the caps.
    const s0 = get(a.id), mirror = isRoot(a) || a.kind === "member" || !!(s0 && openJob(s0)?.legacy);
    for (const e of list as Record<string, unknown>[]) {
      if (!EVENT_TYPES.has(String(e.type)) || (!mirror && /^Task(Added|Started|Done)$/.test(String(e.type)))) continue;
      emit({ agent: a.id, type: String(e.type), data: (e.data ?? {}) as Record<string, unknown>, source: (typeof e.source === "string" ? e.source : "mod") as Source, ts: Number(e.ts) || undefined, dedup: typeof e.dedup === "string" ? `${a.id}:${e.dedup}`.slice(0, 200) : undefined, transient: e.type === "ToolStarted" }); n++;
    }
    flush();
    return c.json({ accepted: n });
  });
  /** A summary sentence for a background job that has no description, made once per job after its row exists. The row shows the raw command until it arrives. */
  const asked = new Set<string>();
  const describeBg = (agent: string, id: string, label: string, cmd: string) => {
    void summarizeBg(cmd).then((sum) => {
      const row = sum ? get(agent)?.bg?.find((b) => b.id === id) : undefined;
      if (!sum || !row || row.cmd !== label.slice(0, 120)) return;
      emit({ agent, type: "BgUpdated", data: { id, sum }, source: "hook" }); flush();
    });
  };
  // Background work rows from the plugin hooks: {items: [{id, kind, label?, state, startedAt?, endedAt?}]} (or one item). Fire and forget; loopback root with no row is dropped.
  r.post("/bg", async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c), list = (Array.isArray(b.items) ? b.items : [b]).slice(0, 20);
    const target = a.id === ADMIN.id ? byName("root") : a;
    let n = 0;
    if (target) for (const e of list as Record<string, unknown>[]) {
      if (e.kind === "schedule") { // a CronCreate / CronDelete from the hooks: state "active" | "gone"
        if (typeof e.id !== "string" || !e.id || (e.state !== "active" && e.state !== "gone")) continue;
        emit({ agent: target.id, type: "ScheduleUpdated", data: { id: e.id.slice(0, 80), state: e.state, cron: typeof e.cron === "string" ? e.cron.slice(0, 80) : undefined, prompt: typeof e.prompt === "string" ? e.prompt.slice(0, 200) : undefined, recurring: e.recurring !== false }, source: "hook" }); n++;
        continue;
      }
      if (typeof e.id !== "string" || !e.id || !BG_KINDS.includes(e.kind as never) || !BG_STATES.includes(e.state as never)) continue;
      const raw = e.raw === true && typeof e.label === "string" && e.label !== "" && (e.kind === "shell" || e.kind === "monitor");
      emit({ agent: target.id, type: "BgUpdated", data: { id: e.id.slice(0, 80), kind: e.kind, state: e.state, label: typeof e.label === "string" ? e.label.slice(0, 120) : undefined, raw: raw || undefined, startedAt: Number(e.startedAt) || undefined, endedAt: Number(e.endedAt) || undefined }, source: "hook" }); n++;
      if (raw && bgSumEnabled() && !asked.has(`${target.id}:${e.id}`)) { asked.add(`${target.id}:${e.id}`); if (asked.size > 500) asked.delete(asked.values().next().value as string); describeBg(target.id, e.id.slice(0, 80), e.label as string, typeof e.cmd === "string" ? e.cmd : e.label as string); }
    }
    flush();
    return c.json({ accepted: n });
  });
  // Owner checks: an agent asks for itself, root for any agent (also a despawned one). GET: root sees all, an agent its own. Resolve is a panel write (checksPanel.ts).
  r.post("/checks", async (c: Ctx) => {
    const a = c.get("agent"), b = await body(c);
    const who = isRoot(a) && typeof b.agent === "string" && b.agent ? b.agent : a.name;
    if (!NAME.test(who)) return bad(c, "agent must match ^[a-z0-9][a-z0-9-]{1,39}$");
    if (!isRoot(a) && who !== a.name) return problem(c, 403, "Forbidden", "an agent may only ask for itself");
    const out = createCheck({ agent: who, question: b.question, detail: b.detail, options: b.options, by: a.name, project: (byName(who) ?? a).project });
    if ("error" in out) return bad(c, out.error);
    audit(`agent:${a.name}`, "agentnet.check-ask", who, "ok", c.get("trace"), { check: out.check.id });
    return c.json({ check: out.check, created: out.created }, out.created ? 201 : 200);
  });
  r.get("/checks", (c: Ctx) => {
    const a = c.get("agent"), st = c.req.query("state"), state = st === "pending" || st === "answered" ? st : undefined;
    return c.json({ checks: listChecks(state).filter((k) => isRoot(a) || k.agent === a.name) });
  });
  // Reads: any agent sees itself; root sees everyone.
  r.get("/agents", (c: Ctx) => { const a = c.get("agent"); return c.json({ seq: lastSeq(), agents: (isRoot(a) ? (c.req.query("all") ? all() : live()) : [get(a.id)!].filter(Boolean)).map(viewOf) }); });
  r.get("/agents/:name", (c: Ctx) => {
    const a = c.get("agent"), t = byName(String(c.req.param("name")));
    if (!isRoot(a) && t?.id !== a.id) return problem(c, 403, "Forbidden", "root only"); // non-root: 403 either way, no name probing
    if (!t) return problem(c, 404, "Not Found", "no such live agent");
    const s = get(t.id); if (!s) return problem(c, 404, "Not Found", "no status yet");
    return c.json({ agent: viewOf(s), events: c.req.query("events") ? events(t.id, 0, Math.min(50, Number(c.req.query("events")) || 20)) : undefined });
  });
  /** Where a new agent would land (name, boss, team, model, effort, soul, compact window, reasons). No side effects. GET reads query params, POST a JSON body. */
  const plan = async (c: Ctx, b: Record<string, unknown>) => {
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    if (!str(b.job)) return bad(c, "job needed");
    try { return c.json({ plan: await planSpawn(planInput(b)) }); } catch (e) { return e instanceof RouteBlocked ? problem(c, 409, "Reserve mode", e.message) : bad(c, (e as Error).message); }
  };
  r.get("/plan-spawn", (c: Ctx) => plan(c, Object.fromEntries(new URL(c.req.url).searchParams)));
  r.post("/plan-spawn", async (c: Ctx) => plan(c, await body(c)));
  r.post("/spawn", async (c: Ctx) => {
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const b = await body(c);
    try {
      const kind = b.kind === "member" ? "member" : "agent";
      if (kind === "agent") { const ge = goalError(b.goal); if (ge) return bad(c, ge); } // members (channel bots via agentnet-join) are exempt
      // Agents (not members): name, boss, team, model, effort, persona and compact window come from the one placement plan for every field the caller left out.
      const plan = kind === "agent" ? await planSpawn(planInput(b), { log: true }) : null;
      const name = plan?.name ?? String(b.name ?? "");
      const made = createAgent({ name, job: str(b.job), goal: str(b.goal)?.trim().slice(0, 500), boss: plan?.boss ?? str(b.boss) ?? a.name, model: plan?.model ?? str(b.model), effort: plan?.effort ?? str(b.effort), soul: plan?.soul ?? str(b.soul), audit: plan?.audit ?? undefined, compactWindow: plan?.compactWindow, project: plan?.workspaceProject ? plan.project ?? undefined : str(b.project), by: a.name, kind });
      const tm = plan?.team;
      if (tm?.action === "create") createTeam({ id: tm.id, name: tm.id, goal: str(b.goal)?.trim().slice(0, 500) ?? str(b.job), lead: tm.lead ?? undefined, project: plan!.project ?? undefined, members: tm.members });
      else if (tm && getTeam(tm.id)) addMember(tm.id, name); // an unknown team id is ignored: old callers pass agmsg team names
      // the first job: its plan comes from the brief's `## Steps` (or the given steps); no brief = the agent sets the plan
      const job1 = kind === "agent" && (str(b.brief) || cleanSteps(b.steps).length) ? startJob(made.id, { by: a.name, goal: str(b.goal)?.trim().slice(0, 500), brief: str(b.brief), steps: b.steps, maxSteps: b.max_steps }) : null;
      audit(`agent:${a.name}`, "agentnet.spawn", made.id, "ok", c.get("trace"));
      return c.json({ plan_steps: job1?.steps ?? 0, plan_warnings: job1?.warnings ?? [], agent: made.id, token_file: made.tokenFile, state: "starting", name, boss: plan?.boss ?? null, team: tm?.id ?? null, model: plan?.model ?? null, effort: plan?.effort ?? null, soul: plan?.soul ?? null, project: plan?.project ?? null, goal: str(b.goal) ?? null, audit: plan?.audit ?? null, compact_window: plan?.compactWindow ?? null, reasons: plan?.reasons ?? [], warnings: plan?.warnings ?? [] }, 201); // M6: spawn.sh launches it with this file
    } catch (e) { return e instanceof RouteBlocked ? problem(c, 409, "Reserve mode", e.message) : bad(c, (e as Error).message); }
  });
  r.post("/agents/:name/placement", async (c: Ctx) => { // spawn.sh after launch: where the pane is ("session:@win.%pane")
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const t = byName(String(c.req.param("name"))), b = await body(c);
    if (!t) return problem(c, 404, "Not Found", "no such live agent");
    db().run("UPDATE agents SET placement = ? WHERE id = ?", [typeof b.tmux === "string" ? b.tmux.slice(0, 80) : null, t.id]);
    return c.body(null, 204);
  });
  r.post("/agents/:name/grade", async (c: Ctx) => { // root only: grade a closed job of an agent, named by generation and job number (docs/agent-score.md)
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const name = String(c.req.param("name")), out = grade(name, await body(c));
    if ("error" in out) return out.status === 404 ? problem(c, 404, "Not Found", out.error) : bad(c, out.error);
    audit(`agent:${a.name}`, "agentnet.grade", out.job?.agent_id ?? name, "ok", c.get("trace"), { ...(out.job ? { job: out.job.job } : { task_id: out.record.taskId }), grade: out.record.grade });
    return c.json(out);
  });
  teamRoutes(r as never, (c) => (c as Ctx).get("agent"));
  r.post("/despawn", async (c: Ctx) => {
    const a = c.get("agent"); if (!isRoot(a)) return problem(c, 403, "Forbidden", "root only");
    const b = await body(c), t = typeof b.agent === "string" ? byName(b.agent) : null;
    if (!t) return problem(c, 404, "Not Found", "no such live agent");
    if (t.name === "root") return problem(c, 403, "Forbidden", "root cannot be despawned"); // its pid is the main bot's claude
    const open = (get(t.id)?.tasks ?? []).filter((x) => x.status !== "done"); // warn root, do not block: the despawn closes the job and drops them
    const closed = retireAgent(t, "despawn");
    audit(`agent:${a.name}`, "agentnet.despawn", t.id, "ok", c.get("trace"), { reason: String(b.reason ?? ""), open_tasks: open.length, ...(closed.length ? { teams_archived: closed.join(",") } : {}) });
    return c.json({ agent: t.id, state: "gone", ...(closed.length ? { teams_archived: closed } : {}), ...(open.length ? { warning: `${t.name} was despawned with ${open.length} open task${open.length > 1 ? "s" : ""}: ${open.map((x) => `${x.id} ${x.text.slice(0, 40)}`).join("; ")}`, open_tasks: open.map((x) => x.id) } : {}) });
  });
  logEvent("info", "agentnet routes mounted", { flag: "AGENTNET=1" });
}
const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
/** Spawn/plan body to planner input. Numbers may arrive as strings (query params). */
const planInput = (b: Record<string, unknown>): PlanInput => {
  const n = (x: unknown) => { const v = typeof x === "string" && x.trim() ? Number(x) : x; return typeof v === "number" && Number.isFinite(v) ? v : undefined; };
  return { name: str(b.name), role: str(b.role), job: str(b.job), project: str(b.project), projectDefault: b.project_default === true, boss: str(b.boss), team: str(b.team), model: str(b.model), effort: str(b.effort), soul: str(b.soul), scope: n(b.scope), novelty: n(b.novelty), risk: n(b.risk), need: str(b.need), ask: str(b.ask) };
};
