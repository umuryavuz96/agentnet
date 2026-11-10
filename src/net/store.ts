// agentnet store: one append-only event log per agent, one pure reducer, one snapshot row per agent (the fold), and a
// single in-process writer that commits events and the fold in the same transaction.
// Flag: AGENTNET=1 (index.ts mounts nothing without it). Tasks live inside the fold (no separate table: smaller).
import { db, schema } from "../core/db";

// The DDL is registered only when the feature is mounted (AGENTNET=1) or a test asks for it: importing this module must
// never add tables to the live DB (2026-11-07 incident).
let registered = false;
export function ensureSchema() {
  if (registered) return; registered = true;
  schema(
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, gen INTEGER NOT NULL, job TEXT, boss TEXT, model TEXT, effort TEXT, soul TEXT,
     project TEXT, spawned_by TEXT, spawned_at INTEGER NOT NULL, token_hash TEXT UNIQUE, archived_at INTEGER, placement TEXT)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS agents_live_name ON agents (name) WHERE archived_at IS NULL",
  `CREATE TABLE IF NOT EXISTS agent_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, v INTEGER NOT NULL, type TEXT NOT NULL,
     schema INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL, source TEXT NOT NULL, corr TEXT, dedup TEXT UNIQUE, data TEXT NOT NULL, UNIQUE (agent_id, v))`,
  "CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events (agent_id, seq)",
  "CREATE TABLE IF NOT EXISTS agent_status (agent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, v INTEGER NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, body TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'info', subject TEXT, reply_to INTEGER, created_at INTEGER NOT NULL, delivered_at INTEGER, read_at INTEGER, held_until INTEGER,
     state TEXT NOT NULL DEFAULT 'queued', bounced_reason TEXT)`,
  "CREATE INDEX IF NOT EXISTS messages_to ON messages (to_agent, state, id)",
  // Teams (v1): a record, its members by agent NAME (stable across gens), and a board of team-level tasks. The channel lives in `messages`
  // (to_agent = 'team:<id>', state 'channel'); each member's delivery is a normal queued row whose channel_id points at it.
  `CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT, lead TEXT, project TEXT, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active')`,
  "CREATE TABLE IF NOT EXISTS team_members (team_id TEXT NOT NULL, agent TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (team_id, agent))",
  `CREATE TABLE IF NOT EXISTS team_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, text TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS team_tasks_team ON team_tasks (team_id, id)",
  "CREATE TABLE IF NOT EXISTS revoked_tokens (hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, at INTEGER NOT NULL)",
  // Owner checks: a real-world check only the owner can do. Keyed by agent NAME so the row outlives a despawned agent.
  `CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, team TEXT, agent TEXT NOT NULL, question TEXT NOT NULL, detail TEXT,
     created_by TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', note TEXT, resolved_at INTEGER, options TEXT, answer TEXT, answer_tone TEXT)`,
  "CREATE INDEX IF NOT EXISTS checks_state ON checks (state, id)",
  );
  try { db().run("ALTER TABLE messages ADD COLUMN channel_id INTEGER"); } catch { /* fresh table or already added */ }
  try { db().run("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'info'"); } catch { /* fresh table has it */ }
  try { db().run("ALTER TABLE agents ADD COLUMN token_file TEXT"); } catch { /* fresh or already added */ }
  try { db().run("ALTER TABLE agents ADD COLUMN compact_window INTEGER"); } catch { /* fresh or already added */ }
  try { db().run("ALTER TABLE agents ADD COLUMN goal TEXT"); } catch { /* fresh or already added */ }
  try { db().run("ALTER TABLE agents ADD COLUMN audit TEXT"); } catch { /* fresh or already added */ }
  try { db().run("ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'"); } catch { /* fresh or already added */ }
  for (const col of ["options", "answer", "answer_tone"]) try { db().run(`ALTER TABLE checks ADD COLUMN ${col} TEXT`); } catch { /* fresh or already added */ }
  try { db().run("ALTER TABLE messages ADD COLUMN subject TEXT"); } catch { /* fresh table has it; the live table from 2026-11-07 did not */ }
}

// ---------- events ----------
export type Life = "starting" | "live" | "stopping" | "gone" | "failed";
export type Activity = "working" | "idle" | "waiting" | "blocked";
export type Source = "spawn" | "mod" | "hook" | "mcp" | "service" | "reconcile";
export interface Task { id: number; text: string; status: "pending" | "in_progress" | "done" }
/** Background work an agent runs (in-process subagent, background shell, monitor), posted by the plugin hooks. */
export type BgKind = "subagent" | "shell" | "monitor";
export type BgState = "running" | "done" | "failed" | "killed";
/** `cmd` is set when the label began as a raw command (no description): the label may later become a plain-English sentence. */
export interface BgRow { id: string; kind: BgKind; label: string; cmd?: string; state: BgState; startedAt: number; endedAt: number | null }
export const BG_KINDS: BgKind[] = ["subagent", "shell", "monitor"], BG_STATES: BgState[] = ["running", "done", "failed", "killed"];
export const BG_KEEP_MS = 2 * 60_000, BG_MAX = 12;
/** A cron job the agent made with CronCreate (session-only: it dies with the session and expires after 7 days). */
export interface ScheduleRow { id: string; cron: string; prompt: string; recurring: boolean; createdAt: number }
export const SCHEDULE_MAX = 20;
/** The fold: what root and the page read. Every field has one owner (observed: hooks/connection; reported: the agent's tools). */
export interface Snapshot {
  id: string; name: string; gen: number; job: string | null; boss: string | null; model: string | null; effort: string | null; soul: string | null; goal: string | null; audit: string | null; compactWindow: number | null; project: string | null;
  spawnedAt: number; session: string | null; pid: number | null; version: string | null; connectedAt: number | null;
  life: Life; lifeSince: number; goneReason: string | null;
  state: Activity; stateSince: number;
  turn: { id: string; startedAt: number; snippet: string | null; tools: number } | null; turns: number;
  action: { tool: string; target: string | null; at: number } | null;
  lastTool: { tool: string; target: string | null; ok: boolean; ms: number | null; at: number } | null;
  reported: { doing: string | null; progress: number | null; phase: string | null; blockedOn: string | null; at: number; turn: number; expired?: boolean; msgAt?: number } | null;
  tasks: Task[];
  /** Background work under this agent; finished rows leave 2 min after they end. Absent on rows folded before this existed. */
  bg?: BgRow[];
  /** Session cron jobs (CronCreate), removed by CronDelete or when the agent goes. Absent on rows folded before this existed. */
  schedules?: ScheduleRow[];
  context: { tokens: number; window: number; pct: number } | null; cost: number | null; weekly: { pct: number; resetsAt: string | null } | null;
  lastMsg: { id: number | null; dir: "in" | "out"; peer: string; kind: string; snippet: string; at: number } | null; lastReport: { to: string; at: number } | null;
  /** A Terminal window is attached to the agent's tmux session (M8); null until the sweep has looked. */
  window: { open: boolean } | null;
  lastEventAt: number; seq: number; v: number;
}
export interface Event { type: string; ts: number; data: Record<string, unknown>; source: Source; seq?: number; v?: number }

const str = (x: unknown) => (typeof x === "string" ? x : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const FINISHED_KEEP = 64;
export const REPORT_FRESH_MS = 3 * 60_000, BLOCK_CLEAR_MS = 60_000;
const finished = new Map<string, string[]>(); // agent -> recent finished tool_use_ids (late ToolStarted is ignored)

/** Pure: snapshot + event → snapshot. `null` snapshot only accepts AgentSpawned. Never throws on unknown types (ignored). */
export function reduce(s: Snapshot | null, e: Event): Snapshot | null {
  const d = e.data, at = e.ts;
  if (!s) {
    if (e.type !== "AgentSpawned") return null;
    return { id: String(d.id), name: String(d.name), gen: num(d.gen) ?? 1, job: str(d.job), boss: str(d.boss), model: str(d.model), effort: str(d.effort), soul: str(d.soul), goal: str(d.goal), audit: str(d.audit), compactWindow: num(d.compactWindow), project: str(d.project),
      spawnedAt: at, session: null, pid: null, version: null, connectedAt: null, life: "starting", lifeSince: at, goneReason: null, state: "idle", stateSince: at,
      turn: null, turns: 0, action: null, lastTool: null, reported: null, tasks: [], context: null, cost: null, weekly: null, lastMsg: null, lastReport: null, window: null, lastEventAt: at, seq: 0, v: 0 };
  }
  const n: Snapshot = { ...s, lastEventAt: Math.max(s.lastEventAt, at) };
  const state = (x: Activity) => { if (n.state !== x) { n.state = x; n.stateSince = at; } };
  const life = (x: Life) => { if (n.life !== x) { n.life = x; n.lifeSince = at; } };
  // A report goes stale when later work supersedes it: a task start/done, a message the agent then acted on (a tool call after it), or more than
  // 3 min of tool activity after it. A blocked report also clears on the first successful tool call more than 60 s after it. A new report replaces all of it.
  const rep = n.reported && !n.reported.expired ? { ...n.reported } : null;
  if (rep) {
    const age = at - rep.at;
    if (e.type === "TaskStarted" || e.type === "TaskDone") rep.expired = true;
    else if (e.type === "MessageReceived") rep.msgAt ??= at;
    else if ((e.type === "ToolStarted" || e.type === "ToolFinished") && (age > REPORT_FRESH_MS || (rep.msgAt != null && at > rep.msgAt))) rep.expired = true;
    if (rep.blockedOn && (rep.expired || (e.type === "ToolFinished" && d.ok !== false && age > BLOCK_CLEAR_MS))) { rep.blockedOn = null; if (n.state === "blocked") { n.state = "working"; n.stateSince = at; } }
    n.reported = rep;
  }
  switch (e.type) {
    case "AgentConnected": n.session = str(d.session) ?? n.session; n.pid = num(d.pid) ?? n.pid; n.version = str(d.version) ?? n.version; n.connectedAt = at; n.model = str(d.model) ?? n.model; life("live"); break;
    case "AgentStopping": life("stopping"); break;
    case "AgentGone": n.bg = []; n.schedules = []; life("gone"); n.goneReason = str(d.reason); n.turn = null; n.action = null; state("idle"); break;
    case "AgentFailed": life("failed"); n.goneReason = str(d.reason) ?? "no hello"; break;
    case "TurnStarted": n.turn = { id: String(d.turn ?? at), startedAt: at, snippet: str(d.snippet), tools: 0 }; n.turns = s.turns + 1; state("working"); break;
    case "ToolStarted": n.action = { tool: String(d.tool), target: str(d.target), at }; if (n.turn) n.turn.tools++; if (!n.reported?.blockedOn) state("working"); break;
    case "ToolFinished": n.lastTool = { tool: String(d.tool), target: str(d.target), ok: d.ok !== false, ms: num(d.ms), at }; if (n.action?.tool === d.tool || !n.action?.tool) n.action = null; if (!n.reported?.blockedOn) state("working"); break;
    case "TurnEnded": n.turn = null; n.action = null; state("idle"); if (num(d.usd) != null) n.cost = num(d.usd); break;
    case "AwaitingInput": state("waiting"); break;
    case "StatusReported": n.reported = { doing: str(d.doing), progress: num(d.progress), phase: str(d.phase), blockedOn: str(d.blockedOn), at, turn: s.turns }; if (n.reported.blockedOn) state("blocked"); break;
    case "TaskAdded": { const id = num(d.id) ?? (Math.max(0, ...n.tasks.map((t) => t.id)) + 1); if (!n.tasks.some((t) => t.id === id)) n.tasks = [...n.tasks, { id, text: String(d.text).slice(0, 200), status: "pending" }]; break; }
    case "TaskStarted": case "TaskDone": n.tasks = n.tasks.map((t) => (t.id === num(d.id) ? { ...t, status: e.type === "TaskDone" ? "done" : "in_progress" } : t)); break;
    case "MessageSent": n.lastMsg = { id: num(d.msg_id), dir: "out", peer: String(d.peer), kind: str(d.kind) ?? "info", snippet: String(d.snippet ?? "").slice(0, 120), at }; break;
    case "MessageReceived": n.lastMsg = { id: num(d.msg_id), dir: "in", peer: String(d.peer), kind: str(d.kind) ?? "info", snippet: String(d.snippet ?? "").slice(0, 120), at }; break;
    case "Reported": n.lastReport = { to: String(d.to), at }; break;
    case "ContextMeasured": n.context = { tokens: num(d.tokens) ?? 0, window: num(d.window) ?? 0, pct: num(d.pct) ?? 0 }; break;
    case "CostMeasured": n.cost = num(d.usd); break;
    case "RateWindow": n.weekly = { pct: num(d.pct) ?? 0, resetsAt: str(d.resetsAt) }; break;
    case "BgUpdated": {
      const id = str(d.id), kind = str(d.kind) as BgKind | null, state = str(d.state) as BgState | null;
      if (id && str(d.sum)) { n.bg = (n.bg ?? []).map((b) => (b.id === id ? { ...b, label: str(d.sum)!.slice(0, 120) } : b)); break; } // the summary sentence for a raw command: label only, state untouched
      if (!id || !kind || !BG_KINDS.includes(kind) || !state || !BG_STATES.includes(state)) break;
      const prevRow = (n.bg ?? []).find((b) => b.id === id);
      // d.raw: the label is the command itself (no description given). The row keeps it as `cmd`; a later event that repeats the same command must not undo the summary sentence.
      const cmd = d.raw === true && str(d.label) ? str(d.label)!.slice(0, 120) : prevRow?.cmd;
      const label = cmd && str(d.label) === cmd && prevRow ? prevRow.label : str(d.label) ?? prevRow?.label ?? kind;
      const row: BgRow = { id, kind, label: label.slice(0, 120), ...(cmd ? { cmd } : {}), state, startedAt: prevRow?.startedAt ?? num(d.startedAt) ?? at, endedAt: state === "running" ? null : prevRow?.endedAt ?? num(d.endedAt) ?? at };
      if (prevRow && prevRow.state !== "running" && state === "running") break; // a late "running" never revives a finished row
      const rest = (n.bg ?? []).filter((b) => b.id !== id && (b.state === "running" || at - (b.endedAt ?? at) < BG_KEEP_MS));
      n.bg = [...rest, row].sort((a, b) => a.startedAt - b.startedAt).slice(-BG_MAX);
      break;
    }
    case "ScheduleUpdated": {
      const id = str(d.id); if (!id) break;
      const rest = (n.schedules ?? []).filter((x) => x.id !== id);
      if (d.state === "gone") { n.schedules = rest; break; }
      const cron = str(d.cron); if (!cron) break;
      const prev = (n.schedules ?? []).find((x) => x.id === id);
      n.schedules = [...rest, { id: id.slice(0, 80), cron: cron.slice(0, 80), prompt: (str(d.prompt) ?? prev?.prompt ?? "").slice(0, 200), recurring: d.recurring !== false, createdAt: prev?.createdAt ?? at }].slice(-SCHEDULE_MAX);
      break;
    }
    case "BossChanged": n.boss = str(d.boss); break;
    case "WindowChanged": n.window = { open: d.open === true }; break;
    case "ActivityReconciled": state((str(d.state) as Activity) ?? "idle"); if (n.state === "idle") { n.turn = null; n.action = null; } break;
    default: break;
  }
  return n;
}

/** Dedup key of a gone event: one per life of the agent (a hello after gone starts a new one), so a returning agent can go gone again. */
export const goneKey = (s: Snapshot | null, id: string) => `gone:${id}:${s?.connectedAt ?? s?.spawnedAt ?? 0}`;

// ---------- writer ----------
export interface Pending { agent: string; type: string; data: Record<string, unknown>; source: Source; ts?: number; dedup?: string; corr?: string; transient?: boolean }
export type Patch = { id: string; snapshot: Snapshot; removed: boolean };
const status = new Map<string, Snapshot>();
const subs = new Set<(p: Patch[]) => void>();
let queue: Pending[] = [], timer: ReturnType<typeof setTimeout> | null = null, loaded = false;
export const DRAIN_MS = 50;

function load() {
  if (loaded) return; loaded = true; ensureSchema();
  for (const r of db().query("SELECT agent_id, json FROM agent_status").all() as { agent_id: string; json: string }[]) status.set(r.agent_id, JSON.parse(r.json));
}
/** Queue one event; the writer commits it within DRAIN_MS. `transient` applies to the fold in memory only (ToolStarted). */
export function emit(p: Pending) { queue.push(p); timer ??= setTimeout(() => { timer = null; flush(); }, DRAIN_MS); }
/** Commit the queue now (tests call this directly). Returns the patches it produced. */
export function flush(): Patch[] {
  load();
  if (timer) { clearTimeout(timer); timer = null; }
  const batch = queue; queue = [];
  if (!batch.length) return [];
  const d = db(), patches = new Map<string, Patch>();
  const ins = d.query("INSERT OR IGNORE INTO agent_events (agent_id, v, type, schema, ts, source, corr, dedup, data) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)");
  const up = d.query("INSERT INTO agent_status (agent_id, seq, v, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET seq = excluded.seq, v = excluded.v, json = excluded.json, updated_at = excluded.updated_at");
  d.transaction(() => {
    for (const p of batch) {
      const prev = status.get(p.agent) ?? null, ts = p.ts ?? Date.now();
      if (p.type === "ToolStarted" && typeof p.data.tool_use_id === "string" && finished.get(p.agent)?.includes(p.data.tool_use_id)) continue; // late start for a finished tool
      if (p.type === "ToolFinished" && typeof p.data.tool_use_id === "string") { const l = finished.get(p.agent) ?? []; l.push(p.data.tool_use_id); if (l.length > FINISHED_KEEP) l.shift(); finished.set(p.agent, l); }
      const ev: Event = { type: p.type, ts, data: p.data, source: p.source };
      const next = reduce(prev, ev);
      if (!next) continue; // unknown agent (no AgentSpawned yet): dropped, never a row without a spawn
      if (p.transient) { next.seq = prev?.seq ?? 0; next.v = prev?.v ?? 0; status.set(p.agent, next); patches.set(p.agent, { id: p.agent, snapshot: next, removed: false }); continue; }
      const v = (prev?.v ?? 0) + 1;
      const r = ins.run(p.agent, v, p.type, ts, p.source, p.corr ?? null, p.dedup ?? null, JSON.stringify(p.data));
      if (r.changes === 0) continue; // duplicate (dedup key seen): the first one stands
      next.seq = Number(r.lastInsertRowid); next.v = v;
      up.run(p.agent, next.seq, v, JSON.stringify(next), ts);
      status.set(p.agent, next);
      patches.set(p.agent, { id: p.agent, snapshot: next, removed: next.life === "gone" || next.life === "failed" });
    }
  })();
  const out = [...patches.values()];
  if (out.length) for (const s of subs) s(out);
  return out;
}
/** Forget an agent name for good: its folds, its stored fold rows and its events. Returns the folds it removed (for a backup). Other agents are never touched. */
export function forgetByName(name: string): Snapshot[] {
  load();
  const gone = [...status.values()].filter((s) => s.name === name);
  db().transaction(() => { for (const s of gone) { db().run("DELETE FROM agent_status WHERE agent_id = ?", [s.id]); db().run("DELETE FROM agent_events WHERE agent_id = ?", [s.id]); status.delete(s.id); finished.delete(s.id); } })();
  return gone;
}
export function onPatch(fn: (p: Patch[]) => void) { subs.add(fn); return () => subs.delete(fn); }
export function get(agent: string): Snapshot | null { load(); return status.get(agent) ?? null; }
/** Agents on the live view: never gone or failed ("never hold an offline agent"). */
export function live(): Snapshot[] { load(); return [...status.values()].filter((s) => s.life !== "gone" && s.life !== "failed"); }
export function all(): Snapshot[] { load(); return [...status.values()]; }
export const lastSeq = (): number => (load(), Number((db().query("SELECT COALESCE(MAX(seq), 0) AS m FROM agent_events").get() as { m: number }).m));
export function events(agent: string, after = 0, limit = 200): Event[] {
  load();
  return (db().query("SELECT seq, v, type, ts, source, data FROM agent_events WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(agent, after, limit) as { seq: number; v: number; type: string; ts: number; source: Source; data: string }[])
    .map((r) => ({ seq: r.seq, v: r.v, type: r.type, ts: r.ts, source: r.source, data: JSON.parse(r.data) }));
}
/** Fold every stored event again (projection bug, or a check): returns the rebuilt folds and rewrites agent_status. */
export function rebuild(): Map<string, Snapshot> {
  load();
  const out = new Map<string, Snapshot>();
  const rows = db().query("SELECT seq, agent_id, v, type, ts, source, data FROM agent_events ORDER BY seq").all() as { seq: number; agent_id: string; v: number; type: string; ts: number; source: Source; data: string }[];
  for (const r of rows) { const n = reduce(out.get(r.agent_id) ?? null, { type: r.type, ts: r.ts, data: JSON.parse(r.data), source: r.source }); if (n) { n.seq = r.seq; n.v = r.v; out.set(r.agent_id, n); } }
  const up = db().query("INSERT INTO agent_status (agent_id, seq, v, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET seq = excluded.seq, v = excluded.v, json = excluded.json, updated_at = excluded.updated_at");
  db().transaction(() => { for (const [id, s] of out) up.run(id, s.seq, s.v, JSON.stringify(s), s.lastEventAt); })();
  status.clear(); for (const [id, s] of out) status.set(id, s);
  return out;
}
/** What the page shows as "doing": a fresh report (under 3 min, not superseded, this or the previous turn), else the task in progress, else the running tool or the turn snippet. */
export function doing(s: Snapshot, now = Date.now()): string | null {
  if (s.reported?.doing && !s.reported.expired && now - s.reported.at < REPORT_FRESH_MS && s.turns - s.reported.turn <= 1) return s.reported.doing;
  const t = s.tasks.find((x) => x.status === "in_progress"); if (t) return `${t.text} (task)`;
  return s.action ? `${s.action.tool}${s.action.target ? " · " + s.action.target : ""}` : s.turn?.snippet ?? null;
}
/** Task-derived progress, the one number the card, panel and map show: (done + f) / total, f = the agent's own % of its current task, counted only
 *  while exactly one task is in progress and the report is from this or the previous turn. No tasks = null: a self-reported % alone is never a bar. */
export function progressPct(s: Pick<Snapshot, "tasks" | "reported" | "turns">): number | null {
  const total = s.tasks.length; if (!total) return null;
  const done = s.tasks.filter((t) => t.status === "done").length;
  const live = s.tasks.filter((t) => t.status === "in_progress").length === 1 && s.reported?.progress != null && !s.reported.expired && s.turns - s.reported.turn <= 1;
  const f = live ? Math.max(0, Math.min(1, s.reported!.progress! / 100)) : 0;
  return Math.round(((done + f) / total) * 100);
}
export const _reset = () => { status.clear(); finished.clear(); queue = []; loaded = false; registered = false; if (timer) clearTimeout(timer); timer = null; };
