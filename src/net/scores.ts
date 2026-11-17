// Agent scorecard storage + API. One record per closed job (job_scores), in its own SQLite file (data/agent-scores.db, the trails.db
// pattern: never the live DB). Rows of agent_scores are the per-task records from before jobs existed: read, never written.
// Cost comes from the agent event log (TurnEnded.usage in the job window) at API list prices. Math: score.ts and discipline.ts; doc: docs/agent-score.md.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ROOT } from "../core/config";
import { db } from "../core/db";
import { logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { costUsd, loadPrices, priceFor, type Tok } from "../core/prices";
import { all, emit, flush } from "./store";
import { jobCounts, type Job } from "./jobs";
import { dailyRows, dayOf, disciplineOf, readSnapshots as readSnaps, type DayRow, type JobFacts, writeSnapshot } from "./discipline";
import { computeScore, roleMedians, roleOf, scoreConfig, type TaskRecord } from "./score";

let handle: Database | null = null;
/** Tests point this at :memory:. */
export function useScoreDb(d: Database | null) { handle = d; if (d) init(d); }
function init(d: Database) {
  d.run(`CREATE TABLE IF NOT EXISTS agent_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT, soul TEXT, project TEXT,
    task_id INTEGER NOT NULL, text TEXT NOT NULL, started_at INTEGER, done_at INTEGER NOT NULL, tokens INTEGER, cost_usd REAL, cost_settled INTEGER NOT NULL DEFAULT 0,
    listed_first INTEGER NOT NULL DEFAULT 0, prompt_start INTEGER NOT NULL DEFAULT 0, prompt_done INTEGER NOT NULL DEFAULT 0, note_filled INTEGER NOT NULL DEFAULT 0,
    grade INTEGER, note TEXT, rework INTEGER NOT NULL DEFAULT 0, rework_at INTEGER, owner_rounds INTEGER, graded_at INTEGER, UNIQUE (agent_id, task_id))`);
  d.run("CREATE INDEX IF NOT EXISTS agent_scores_agent ON agent_scores (agent, done_at)");
  for (const col of ["grade_raw REAL", "penalty REAL"]) try { d.run(`ALTER TABLE agent_scores ADD COLUMN ${col}`); } catch { /* there already */ }
  d.run(`CREATE TABLE IF NOT EXISTS job_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, agent_id TEXT NOT NULL, gen INTEGER NOT NULL, role TEXT NOT NULL, model TEXT, soul TEXT, project TEXT,
    job_id INTEGER NOT NULL, goal TEXT, opened_at INTEGER NOT NULL, closed_at INTEGER NOT NULL, outcome TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0,
    plan INTEGER NOT NULL DEFAULT 0, steps INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL DEFAULT 0, self_added INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
    open_at_close INTEGER NOT NULL DEFAULT 0, no_work INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER, cost_usd REAL, cost_settled INTEGER NOT NULL DEFAULT 0, grade INTEGER, note TEXT, rework INTEGER NOT NULL DEFAULT 0, rework_at INTEGER, owner_rounds INTEGER, graded_at INTEGER, UNIQUE (agent_id, job_id))`);
  d.run("CREATE INDEX IF NOT EXISTS job_scores_agent ON job_scores (agent, closed_at)");
}
function sdb(): Database {
  if (handle) return handle;
  mkdirSync(join(ROOT, "data"), { recursive: true });
  handle = new Database(join(ROOT, "data", "agent-scores.db")); handle.run("PRAGMA journal_mode = WAL"); init(handle);
  return handle;
}

// ---------- reading the event log ----------
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

interface Row { id: number; agent: string; agent_id: string; role: string; model: string | null; soul: string | null; project: string | null; task_id: number; text: string; started_at: number | null; done_at: number; tokens: number | null; cost_usd: number | null; cost_settled: number; listed_first: number; prompt_start: number; prompt_done: number; note_filled: number; grade: number | null; grade_raw: number | null; penalty: number | null; note: string | null; rework: number; rework_at: number | null; owner_rounds: number | null; graded_at: number | null }
const rec = (r: Row): TaskRecord => ({ id: r.id, agent: r.agent, role: r.role, model: r.model, soul: r.soul, project: r.project, taskId: r.task_id, text: r.text, startedAt: r.started_at, doneAt: r.done_at, tokens: r.tokens, costUsd: r.cost_usd,
  listedFirst: !!r.listed_first, promptStart: !!r.prompt_start, promptDone: !!r.prompt_done, noteFilled: !!r.note_filled, grade: r.grade, gradeRaw: r.grade_raw, penalty: r.penalty, note: r.note, rework: !!r.rework, reworkAt: r.rework_at, ownerRounds: r.owner_rounds, gradedAt: r.graded_at });

interface JobRow { id: number; agent: string; agent_id: string; gen: number; role: string; model: string | null; soul: string | null; project: string | null; job_id: number; goal: string | null; opened_at: number; closed_at: number; outcome: string; legacy: number;
  plan: number; steps: number; done: number; added: number; self_added: number; dropped: number; open_at_close: number; no_work: number; verified: number;
  tokens: number | null; cost_usd: number | null; cost_settled: number; grade: number | null; note: string | null; rework: number; rework_at: number | null; owner_rounds: number | null; graded_at: number | null }
const factsOf = (r: JobRow): JobFacts => ({ agent: r.agent, closedAt: r.closed_at, steps: r.steps, done: r.done, added: r.added, dropped: r.dropped, openAtClose: r.open_at_close, noWork: r.no_work, verified: r.verified });
/** A closed job as a score record. A job planned with the old tools has no discipline number: the facts it would need were never taken. */
const jobRec = (r: JobRow): TaskRecord => ({ id: r.id, agent: r.agent, agentId: r.agent_id, unit: "job", role: r.role, model: r.model, soul: r.soul, project: r.project, taskId: r.job_id, text: r.goal ?? `job ${r.job_id}`, startedAt: r.opened_at, doneAt: r.closed_at,
  tokens: r.tokens, costUsd: r.cost_usd, listedFirst: false, promptStart: false, promptDone: false, noteFilled: false, reliability: r.legacy ? null : disciplineOf([factsOf(r)]).score,
  grade: r.grade, note: r.note, rework: !!r.rework, reworkAt: r.rework_at, ownerRounds: r.owner_rounds, gradedAt: r.graded_at });

// ---------- writing ----------
export interface Who { id: string; name: string; model?: string | null; soul?: string | null; project?: string | null }
const genOf = (id: string) => Number(/#(\d+)$/.exec(id)?.[1] ?? 1);
/** Called when a job closes (the report, a failed report, a despawn). One row per job; a second call for the same job changes nothing.
 *  Never throws: a score problem must not break the report. */
export function recordJob(who: Who, job: Job): number | null {
  try {
    if (job.closedAt == null) return null;
    const c = jobCounts(job);
    const r = sdb().run(`INSERT OR IGNORE INTO job_scores (agent, agent_id, gen, role, model, soul, project, job_id, goal, opened_at, closed_at, outcome, legacy, plan, steps, done, added, self_added, dropped, open_at_close, no_work, verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [who.name, who.id, genOf(who.id), roleOf(who.name), who.model ?? null, who.soul ?? null, who.project ?? null, job.id, job.goal?.slice(0, 300) ?? null, job.openedAt, job.closedAt, job.outcome ?? "done", +!!job.legacy,
      c.plan, c.total, c.done, c.added, c.selfAdded, c.dropped, c.unfinished, c.noWork, c.verified]);
    return r.changes ? Number(r.lastInsertRowid) : null;
  } catch (e) { logEvent("warn", "job score record failed", { agent: who.name, error: (e as Error).message }); return null; }
}

/** Fill in tokens and cost for closed jobs whose window has closed (close + grace). The first job of an agent counts from its spawn. Cheap: only unsettled rows. */
export function settle(now = Date.now()) {
  const cfg = scoreConfig();
  for (const r of sdb().query("SELECT * FROM job_scores WHERE cost_settled = 0 AND closed_at + ? <= ?").all(cfg.costGraceMs, now) as JobRow[]) {
    const c = windowCost(r.agent_id, r.job_id === 1 ? 0 : r.opened_at, r.closed_at + cfg.costGraceMs);
    sdb().run("UPDATE job_scores SET tokens = ?, cost_usd = ?, cost_settled = 1 WHERE id = ?", [c.tokens, c.costUsd, r.id]);
  }
}

/** Body of the grade POST: grade (1-5), note, rework, owner_rounds, and which job: `job` (its number) and `gen` (the agent's generation).
 *  Without them: the newest closed job of the newest generation of that name. `task_id` grades a per-task record from before jobs existed. */
export type GradeInput = Record<string, unknown>;
export type GradeError = { error: string; status: 404 | 422 };
/** Root's grade of a closed job. The job is named by generation and number, so a name that was used twice never gets the grade on the wrong run. */
export function grade(agent: string, i: GradeInput, now = Date.now()): { record: TaskRecord; job: { agent_id: string; job: number } | null } | GradeError {
  const g = Number(i.grade), rounds = i.owner_rounds, int = (x: unknown) => x == null || Number.isInteger(Number(x));
  if (i.task_id != null && !Number.isInteger(Number(i.task_id))) return { error: "task_id must be an integer", status: 422 };
  if (!int(i.job) || !int(i.gen)) return { error: "job and gen must be integers", status: 422 };
  if (!Number.isInteger(g) || g < 1 || g > 5) return { error: "grade must be an integer 1-5", status: 422 };
  if (rounds != null && !(Number.isInteger(Number(rounds)) && Number(rounds) >= 0)) return { error: "owner_rounds must be an integer >= 0", status: 422 };
  const note = typeof i.note === "string" && i.note.trim() ? i.note.trim().slice(0, 500) : null;
  const rework = i.rework === true || (note != null && /^rework:/i.test(note));
  const set = [g, note, +rework, rework ? now : null, rounds == null ? null : Number(rounds), now];
  const rows = sdb().query("SELECT * FROM job_scores WHERE agent = ? ORDER BY gen DESC, job_id DESC").all(agent) as JobRow[];
  const valid = rows.length ? `Closed jobs of ${agent}: ${rows.slice(0, 8).map((r) => `gen ${r.gen} job ${r.job_id}`).join(", ")}.` : `${agent} has no closed job yet: a job closes with its done report, or at despawn.`;
  if (i.task_id != null && i.job == null) { // a record from before jobs existed
    const old = sdb().query("SELECT * FROM agent_scores WHERE agent = ? AND task_id = ? ORDER BY done_at DESC LIMIT 1").get(agent, Number(i.task_id)) as Row | null;
    if (!old) return { error: `no finished task ${Number(i.task_id)} of ${agent} on record. Tasks are no longer graded one by one: grade the job (leave task_id out). ${valid}`, status: 404 };
    sdb().run("UPDATE agent_scores SET grade = ?, grade_raw = ?, penalty = 0, note = ?, rework = ?, rework_at = ?, owner_rounds = COALESCE(?, owner_rounds), graded_at = ? WHERE id = ?", [g, ...set, old.id]);
    return { record: rec(sdb().query("SELECT * FROM agent_scores WHERE id = ?").get(old.id) as Row), job: null };
  }
  const gen = i.gen != null ? Number(i.gen) : rows[0]?.gen, row = rows.find((r) => r.gen === gen && (i.job == null || r.job_id === Number(i.job)));
  if (!row) return { error: `no closed job${i.job != null ? ` ${Number(i.job)}` : ""}${i.gen != null ? ` in generation ${gen}` : ""} of ${agent}. ${valid}`, status: 404 };
  sdb().run("UPDATE job_scores SET grade = ?, note = ?, rework = ?, rework_at = ?, owner_rounds = COALESCE(?, owner_rounds), graded_at = ? WHERE id = ?", [...set, row.id]);
  emit({ agent: row.agent_id, type: "JobGraded", data: { job: row.job_id, grade: g, note }, source: "service", ts: now }); flush(); // the card of that run shows the grade
  return { record: jobRec(sdb().query("SELECT * FROM job_scores WHERE id = ?").get(row.id) as JobRow), job: { agent_id: row.agent_id, job: row.job_id } };
}

// ---------- reading ----------
const taskRecords = (where = "", ...args: string[]) => (sdb().query(`SELECT * FROM agent_scores ${where} ORDER BY done_at`).all(...args) as Row[]).map(rec);
const jobRows = (where = "", ...args: string[]) => sdb().query(`SELECT * FROM job_scores ${where} ORDER BY closed_at`).all(...args) as JobRow[];
/** Every score record: the closed jobs, and the per-task records from before jobs existed. */
const records = (where = "", ...args: string[]) => [...taskRecords(where, ...args), ...jobRows(where, ...args).map(jobRec)];
/** Steps an agent has had in work for more than staleMs right now. */
function staleOpen(name: string, now: number): number {
  const cfg = scoreConfig(); let n = 0;
  for (const s of all()) if (s.name === name && s.life !== "gone" && s.life !== "failed") for (const t of s.tasks) if (t.status === "in_progress" && t.startedAt != null && now - t.startedAt > cfg.staleMs) n++;
  return n;
}
const slim = (r: TaskRecord) => ({ id: r.id, unit: r.unit ?? "task", ...(r.unit === "job" ? { agent_id: r.agentId, job: r.taskId } : { task_id: r.taskId, grade_raw: r.gradeRaw ?? r.grade, penalty: r.penalty ?? 0 }), text: r.text, grade: r.grade, note: r.note, rework: r.rework, owner_rounds: r.ownerRounds, done_at: r.doneAt, graded_at: r.gradedAt, cost_usd: r.costUsd });
const slimJob = (r: JobRow) => ({ id: r.id, agent_id: r.agent_id, gen: r.gen, job: r.job_id, goal: r.goal, outcome: r.outcome, legacy: !!r.legacy, opened_at: r.opened_at, closed_at: r.closed_at,
  plan: r.plan, steps: r.steps, done: r.done, added: r.added, self_added: r.self_added, dropped: r.dropped, open_at_close: r.open_at_close, no_work: r.no_work, verified: r.verified,
  discipline: r.legacy ? null : disciplineOf([factsOf(r)]).score, grade: r.grade, note: r.note, rework: !!r.rework, owner_rounds: r.owner_rounds, graded_at: r.graded_at, cost_usd: r.cost_usd });

/** The jobs the discipline numbers are made of: closed, and planned with the plan tools. */
const facts = (where = "WHERE legacy = 0", ...args: string[]) => jobRows(where, ...args).map(factsOf);
/** Discipline of one agent name: the score over its closed jobs and the five numbers. */
export const agentDiscipline = (name: string) => disciplineOf(facts("WHERE legacy = 0 AND agent = ?", name));
/** Per-day trend over every agent. */
export const disciplineDays = (): DayRow[] => dailyRows(facts());
export function disciplineSummary(now = Date.now()) {
  const days = disciplineDays(), today = days.find((d) => d.day === dayOf(now)) ?? null, total = disciplineOf(facts());
  return { days: days.slice(-30), today, all: total.score, checks: total.checks, jobs: total.jobs, steps: total.steps };
}
/** Write today's (or `day`'s) line of <home>/data/discipline.jsonl, plus any earlier day that has no line yet. Returns the rows written. */
export function snapshotDiscipline(day?: string, now = Date.now()): DayRow[] {
  const have = new Set(readSnaps().map((r) => r.day)), rows = disciplineDays().filter((r) => (day ? r.day === day : !have.has(r.day) || r.day === dayOf(now)));
  for (const r of rows) writeSnapshot(r, now);
  return rows;
}

export function agentScore(name: string, now = Date.now()) {
  settle(now);
  const cfg = scoreConfig(), mine = records("WHERE agent = ?", name), meds = roleMedians(records());
  const last = mine.filter((r) => r.grade != null).sort((a, b) => (b.gradedAt ?? 0) - (a.gradedAt ?? 0) || (b.id ?? 0) - (a.id ?? 0)).slice(0, 5);
  const lastRounds = last.filter((r) => r.ownerRounds != null).map((r) => r.ownerRounds!);
  return { agent: name, role: roleOf(name), ...computeScore(mine, meds, cfg, staleOpen(name, now)), minGraded: cfg.minGraded, weights: cfg.weights, last: last.map(slim), lastAvgRounds: lastRounds.length ? lastRounds.reduce((a, b) => a + b, 0) / lastRounds.length : null, discipline: agentDiscipline(name) };
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
  const agents = names.map((n) => { const mine = recs.filter((r) => r.agent === n), l = mine.reduce((a, b) => (b.doneAt >= a.doneAt ? b : a)); return { agent: n, role: l.role, model: l.model, soul: l.soul, project: l.project, ...computeScore(mine, meds, cfg, staleOpen(n, now)), discipline: agentDiscipline(n) }; })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.tasks - a.tasks);
  return { at: now, minGraded: cfg.minGraded, weights: cfg.weights, agents, byRole: group((r) => r.role), byModel: group((r) => r.model ?? "unknown"), bySoul: group((r) => r.soul ?? "none"), discipline: disciplineSummary(now) };
}

/** Panel-auth reads (same auth as /agentnet/usage). The grade POST is root-only and lives in routes.ts with the other admin routes. */
export function agentnetScoreRoutes(api: Hono<Env>) {
  api.get("/agentnet/scores", (c) => c.json(allScores()));
  api.get("/agentnet/discipline", (c) => c.json({ ...disciplineSummary(), snapshots: readSnaps() }));
  api.get("/agentnet/agents/:name/score", (c) => {
    const name = String(c.req.param("name"));
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    return c.json(agentScore(name));
  });
  /** Every closed job of an agent name (and its per-task records from before jobs existed), graded or not, live or gone: root grades from this. */
  api.get("/agentnet/agents/:name/tasks", (c) => {
    const name = String(c.req.param("name"));
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) return problem(c, 422, "Can't do that", "bad agent name");
    settle(); return c.json({ agent: name, jobs: jobRows("WHERE agent = ?", name).map(slimJob), tasks: taskRecords("WHERE agent = ?", name).map(slim) });
  });
}
