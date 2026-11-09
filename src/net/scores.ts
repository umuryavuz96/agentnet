// Agent scorecard storage + API. One record per finished agent task, in its own SQLite file (var/data/agent-scores.db, the trails.db
// pattern: never the live Server OS DB). Cost comes from the agent event log (TurnEnded.usage in the task window) at API list prices.
// Math lives in score.ts; the doc is docs/agent-score.md.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ROOT } from "../core/config";
import { db } from "../core/db";
import { logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { costUsd, loadPrices, priceFor, type Tok } from "../core/prices";
import { all, ensureSchema, get } from "./store";
import { computeScore, roleMedians, roleOf, scoreConfig, type Score, type TaskRecord } from "./score";

let handle: Database | null = null;
/** Tests point this at :memory:. */
export function useScoreDb(d: Database | null) { handle = d; if (d) init(d); }
function init(d: Database) {
  d.run(`CREATE TABLE IF NOT EXISTS agent_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT, soul TEXT, project TEXT,
    task_id INTEGER NOT NULL, text TEXT NOT NULL, started_at INTEGER, done_at INTEGER NOT NULL, tokens INTEGER, cost_usd REAL, cost_settled INTEGER NOT NULL DEFAULT 0,
    listed_first INTEGER NOT NULL DEFAULT 0, prompt_start INTEGER NOT NULL DEFAULT 0, prompt_done INTEGER NOT NULL DEFAULT 0, note_filled INTEGER NOT NULL DEFAULT 0,
    grade INTEGER, note TEXT, rework INTEGER NOT NULL DEFAULT 0, rework_at INTEGER, owner_rounds INTEGER, graded_at INTEGER, UNIQUE (agent_id, task_id))`);
  d.run("CREATE INDEX IF NOT EXISTS agent_scores_agent ON agent_scores (agent, done_at)");
}
function sdb(): Database {
  if (handle) return handle;
  mkdirSync(join(ROOT, "data"), { recursive: true });
  handle = new Database(join(ROOT, "data", "agent-scores.db")); handle.run("PRAGMA journal_mode = WAL"); init(handle);
  return handle;
}

// ---------- reading the event log ----------
const evTs = (agentId: string, type: string, taskId: number, order: "ASC" | "DESC"): number | null =>
  (db().query(`SELECT ts FROM agent_events WHERE agent_id = ? AND type = ? AND json_extract(data, '$.id') = ? ORDER BY seq ${order} LIMIT 1`).get(agentId, type, taskId) as { ts: number } | null)?.ts ?? null;

/** Tokens (input+output+cache write) and list-price dollars of the agent's finished turns in [from, to]. Null cost when no turn had a priced model. */
export function windowCost(agentId: string, from: number, to: number): { tokens: number; costUsd: number | null } {
  const rows = db().query("SELECT data FROM agent_events WHERE agent_id = ? AND type = 'TurnEnded' AND ts >= ? AND ts <= ?").all(agentId, from, to) as { data: string }[];
  const prices = loadPrices(); let tokens = 0, usd = 0, priced = 0;
  for (const r of rows) {
    let u: Record<string, unknown> | null = null; try { u = (JSON.parse(r.data) as { usage?: Record<string, unknown> | null }).usage ?? null; } catch { /* skip */ }
    if (!u) continue;
    const n = (k: string) => (typeof u![k] === "number" && Number.isFinite(u![k]) ? (u![k] as number) : 0);
    const t: Tok = [n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), 0, 1];
    tokens += t[0] + t[1] + t[3];
    const p = typeof u.model === "string" ? priceFor(u.model, prices) : null;
    if (p) { usd += costUsd(t, p); priced++; }
  }
  return { tokens, costUsd: priced ? usd : null };
}

interface Row { id: number; agent: string; agent_id: string; role: string; model: string | null; soul: string | null; project: string | null; task_id: number; text: string; started_at: number | null; done_at: number; tokens: number | null; cost_usd: number | null; cost_settled: number; listed_first: number; prompt_start: number; prompt_done: number; note_filled: number; grade: number | null; note: string | null; rework: number; rework_at: number | null; owner_rounds: number | null; graded_at: number | null }
const rec = (r: Row): TaskRecord => ({ id: r.id, agent: r.agent, role: r.role, model: r.model, soul: r.soul, project: r.project, taskId: r.task_id, text: r.text, startedAt: r.started_at, doneAt: r.done_at, tokens: r.tokens, costUsd: r.cost_usd,
  listedFirst: !!r.listed_first, promptStart: !!r.prompt_start, promptDone: !!r.prompt_done, noteFilled: !!r.note_filled, grade: r.grade, note: r.note, rework: !!r.rework, reworkAt: r.rework_at, ownerRounds: r.owner_rounds, gradedAt: r.graded_at });

// ---------- writing ----------
export interface Who { id: string; name: string; model?: string | null; soul?: string | null; project?: string | null }
const filled = (x: unknown) => x != null && x !== "" && !(Array.isArray(x) && !x.length);
/** Called when an agent's task is done. First done stands (re-sent done events change nothing). Never throws: a score problem must not break task_done. */
export function recordDone(who: Who, taskId: number, noteBody: Record<string, unknown> | null, now = Date.now()): number | null {
  try {
    ensureSchema();
    const cfg = scoreConfig(), snap = get(who.id), text = snap?.tasks.find((t) => t.id === taskId)?.text ?? `task ${taskId}`;
    const started = evTs(who.id, "TaskStarted", taskId, "DESC"), added = (db().query("SELECT MIN(ts) AS t FROM agent_events WHERE agent_id = ? AND type = 'TaskAdded'").get(who.id) as { t: number | null }).t;
    const firstWork = (db().query("SELECT MIN(ts) AS t FROM agent_events WHERE agent_id = ? AND type = 'ToolFinished' AND json_extract(data, '$.tool') NOT LIKE 'mcp__agentnet__%' AND json_extract(data, '$.tool') <> 'ToolSearch'").get(who.id) as { t: number | null }).t;
    const prevDone = (sdb().query("SELECT MAX(done_at) AS t FROM agent_scores WHERE agent_id = ? AND done_at <= ?").get(who.id, now) as { t: number | null }).t;
    const listedFirst = added != null && (firstWork == null || added <= firstWork);
    const promptStart = started != null && started - (prevDone ?? added ?? started) <= cfg.promptStartMs;
    const promptDone = started != null && now - started <= cfg.staleMs;
    const noteFilled = !!noteBody && filled(noteBody.goal) && filled(noteBody.result);
    const r = sdb().run(`INSERT OR IGNORE INTO agent_scores (agent, agent_id, role, model, soul, project, task_id, text, started_at, done_at, listed_first, prompt_start, prompt_done, note_filled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [who.name, who.id, roleOf(who.name), snap?.model ?? who.model ?? null, snap?.soul ?? who.soul ?? null, snap?.project ?? who.project ?? null, taskId, text.slice(0, 200), started, now, +listedFirst, +promptStart, +promptDone, +noteFilled]);
    return r.changes ? Number(r.lastInsertRowid) : null;
  } catch (e) { logEvent("warn", "agent score record failed", { agent: who.name, error: (e as Error).message }); return null; }
}

/** Fill in tokens and cost for records whose window has closed (done + grace, cut at the agent's next task start). Cheap: only unsettled rows. */
export function settle(now = Date.now()) {
  const cfg = scoreConfig();
  for (const r of sdb().query("SELECT * FROM agent_scores WHERE cost_settled = 0 AND done_at + ? <= ?").all(cfg.costGraceMs, now) as Row[]) {
    const from = r.started_at ?? r.done_at;
    const next = (db().query("SELECT MIN(ts) AS t FROM agent_events WHERE agent_id = ? AND type = 'TaskStarted' AND ts > ?").get(r.agent_id, from) as { t: number | null }).t;
    const to = Math.min(r.done_at + cfg.costGraceMs, next ?? Infinity), c = windowCost(r.agent_id, from, Math.max(to, from));
    sdb().run("UPDATE agent_scores SET tokens = ?, cost_usd = ?, cost_settled = 1 WHERE id = ?", [c.tokens, c.costUsd, r.id]);
  }
}

/** Body of the grade POST: task_id, grade (1-5), note, rework, owner_rounds. */
export type GradeInput = Record<string, unknown>;
/** Root's grade of a finished task (newest record of that agent name with that task id). Error string on bad input, null when no such finished task. */
export function gradeTask(agent: string, i: GradeInput, now = Date.now()): TaskRecord | null | { error: string } {
  const taskId = Number(i.task_id), grade = Number(i.grade);
  if (!Number.isInteger(taskId)) return { error: "task_id must be an integer" };
  if (!Number.isInteger(grade) || grade < 1 || grade > 5) return { error: "grade must be an integer 1-5" };
  const rounds = i.owner_rounds;
  if (rounds != null && !(Number.isInteger(Number(rounds)) && Number(rounds) >= 0)) return { error: "owner_rounds must be an integer >= 0" };
  const row = sdb().query("SELECT * FROM agent_scores WHERE agent = ? AND task_id = ? ORDER BY done_at DESC LIMIT 1").get(agent, taskId) as Row | null;
  if (!row) return null;
  const note = typeof i.note === "string" && i.note.trim() ? i.note.trim().slice(0, 500) : null;
  const rework = i.rework === true || (note != null && /^rework:/i.test(note));
  sdb().run("UPDATE agent_scores SET grade = ?, note = ?, rework = ?, rework_at = ?, owner_rounds = COALESCE(?, owner_rounds), graded_at = ? WHERE id = ?",
    [grade, note, +rework, rework ? now : null, rounds == null ? null : Number(rounds), now, row.id]);
  return rec(sdb().query("SELECT * FROM agent_scores WHERE id = ?").get(row.id) as Row);
}

// ---------- reading ----------
const records = (where = "", ...args: string[]) => (sdb().query(`SELECT * FROM agent_scores ${where} ORDER BY done_at`).all(...args) as Row[]).map(rec);
/** Tasks an agent has had in progress for more than staleMs right now. */
function staleOpen(name: string, now: number): number {
  const cfg = scoreConfig(); let n = 0;
  for (const s of all()) if (s.name === name && s.life !== "gone" && s.life !== "failed") for (const t of s.tasks) if (t.status === "in_progress") { const at = evTs(s.id, "TaskStarted", t.id, "DESC"); if (at != null && now - at > cfg.staleMs) n++; }
  return n;
}
const slim = (r: TaskRecord) => ({ id: r.id, task_id: r.taskId, text: r.text, grade: r.grade, note: r.note, rework: r.rework, owner_rounds: r.ownerRounds, done_at: r.doneAt, graded_at: r.gradedAt, cost_usd: r.costUsd });

export function agentScore(name: string, now = Date.now()) {
  settle(now);
  const cfg = scoreConfig(), mine = records("WHERE agent = ?", name), meds = roleMedians(records());
  const last = mine.filter((r) => r.grade != null).sort((a, b) => (b.gradedAt ?? 0) - (a.gradedAt ?? 0) || (b.id ?? 0) - (a.id ?? 0)).slice(0, 5);
  const lastRounds = last.filter((r) => r.ownerRounds != null).map((r) => r.ownerRounds!);
  return { agent: name, role: roleOf(name), ...computeScore(mine, meds, cfg, staleOpen(name, now)), minGraded: cfg.minGraded, weights: cfg.weights, last: last.map(slim), lastAvgRounds: lastRounds.length ? lastRounds.reduce((a, b) => a + b, 0) / lastRounds.length : null };
}

export function allScores(now = Date.now()) {
  settle(now);
  const cfg = scoreConfig(), recs = records(), meds = roleMedians(recs);
  const group = (key: (r: TaskRecord) => string | null) => {
    const by = new Map<string, TaskRecord[]>();
    for (const r of recs) { const k = key(r); if (k != null) (by.get(k) ?? by.set(k, []).get(k)!).push(r); }
    return [...by].map(([k, v]) => ({ key: k, ...computeScore(v, meds, cfg) })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tasks - a.tasks);
  };
  const names = [...new Set(recs.map((r) => r.agent))];
  const agents = names.map((n) => { const mine = recs.filter((r) => r.agent === n), l = mine[mine.length - 1]!; return { agent: n, role: l.role, model: l.model, soul: l.soul, project: l.project, ...computeScore(mine, meds, cfg, staleOpen(n, now)) }; })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tasks - a.tasks);
  return { at: now, minGraded: cfg.minGraded, weights: cfg.weights, agents, byRole: group((r) => r.role), byModel: group((r) => r.model ?? "unknown"), bySoul: group((r) => r.soul ?? "none") };
}

/** Panel-auth reads (same auth as /agentnet/usage). The grade POST is root-only and lives in routes.ts with the other admin routes. */
export function agentnetScoreRoutes(api: Hono<Env>) {
  api.get("/agentnet/scores", (c) => c.json(allScores()));
  api.get("/agentnet/agents/:name/score", (c) => {
    const name = String(c.req.param("name"));
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    return c.json(agentScore(name));
  });
  /** Every finished task of an agent name, graded or not, live or gone: root backfills grades from this (2026-11-08). */
  api.get("/agentnet/agents/:name/tasks", (c) => {
    const name = String(c.req.param("name"));
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    settle(); return c.json({ agent: name, tasks: records("WHERE agent = ?", name).map(slim) });
  });
}
