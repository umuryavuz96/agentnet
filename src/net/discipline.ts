// Task discipline: config switches for the strict rules, the 0-100 discipline score per agent and per day, the daily snapshot file,
// and the work gate decision. Pure math over agent_scores rows (score.ts TaskRecord) plus agent_events for the despawn check.
// Doc: docs/task-discipline.md. Config: <home>/config/task-discipline.json over DEFAULTS, read on each call.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/config";
import type { TaskRecord } from "./score";

export interface DisciplineConfig {
  /** B1: task_done on a task that was never started is refused. */
  strictDone: boolean;
  /** B2: the work gate (PreToolUse in the mod) blocks work tools while no task is in progress. */
  workGate: boolean;
  /** B3: tasks allowed in progress at once (1 = one at a time; 2 for parallel waits). 0 turns the rule off. */
  maxInProgress: number;
  /** B4: report state=done is refused while tasks are open. */
  blockDoneReport: boolean;
  /** B5: grade points taken off per discipline flag of a task when root grades (0 = off), and the total cap. */
  gradePenalty: number; gradePenaltyCap: number;
  /** B2 grace after spawn. */
  graceMs: number;
  /** A done within this long after the agent's previous done is a batch close (unless the task ran longer than this). */
  batchMs: number;
  /** A start within this long after the previous done (or the first add) is on time. */
  onTimeMs: number;
}
export const DEFAULTS: DisciplineConfig = { strictDone: true, workGate: true, maxInProgress: 1, blockDoneReport: true, gradePenalty: 0.5, gradePenaltyCap: 2, graceMs: 120_000, batchMs: 60_000, onTimeMs: 10 * 60_000 };

/** AGENTNET_TASK_STRICT=0 turns every strict rule off (old tests, a host that wants only the score); =1 forces the defaults on. */
export function disciplineConfig(): DisciplineConfig {
  const d: DisciplineConfig = { ...DEFAULTS };
  try { Object.assign(d, JSON.parse(readFileSync(join(ROOT, "config", "task-discipline.json"), "utf8")) as Partial<DisciplineConfig>); } catch { /* defaults */ }
  if (process.env.AGENTNET_TASK_STRICT === "0") Object.assign(d, { strictDone: false, workGate: false, maxInProgress: 0, blockDoneReport: false, gradePenalty: 0 });
  return d;
}

// ---------- flags and score ----------
export const CHECKS = ["listedFirst", "started", "onTime", "notBatch", "oneAtATime"] as const;
export type Check = (typeof CHECKS)[number];
/** Per finished task: true = the habit held. */
export type TaskFlags = Record<Check, boolean>;

/** Flags for every record of ONE agent (sorted by doneAt inside). Key = record id, else `task_id`. */
export function flagRecords(recs: TaskRecord[], cfg: Pick<DisciplineConfig, "batchMs"> = DEFAULTS): Map<number, TaskFlags> {
  const sorted = [...recs].sort((a, b) => a.doneAt - b.doneAt), out = new Map<number, TaskFlags>();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1]?.doneAt;
    const batch = prev != null && r.doneAt - prev < cfg.batchMs && !(r.startedAt != null && r.doneAt - r.startedAt > cfg.batchMs);
    const overlap = r.startedAt != null && sorted.some((o, j) => j !== i && o.startedAt != null && o.startedAt < r.doneAt && r.startedAt! < o.doneAt);
    out.set(r.id ?? r.taskId, { listedFirst: r.listedFirst, started: r.startedAt != null, onTime: r.promptStart, notBatch: !batch, oneAtATime: !overlap });
  });
  return out;
}
export const flagCount = (f: TaskFlags) => CHECKS.filter((k) => !f[k]).length;

export interface Discipline { tasks: number; open: number; score: number | null; checks: Record<Check, number | null> }
/** 0-100: share of passed checks over finished tasks plus open-at-despawn tasks (each fails every check). Null with no task. */
export function disciplineOf(flags: TaskFlags[], openAtDespawn = 0): Discipline {
  const n = flags.length + openAtDespawn, checks = {} as Record<Check, number | null>;
  for (const k of CHECKS) checks[k] = n ? Math.round((100 * flags.filter((f) => f[k]).length) / n) : null;
  const score = n ? Math.round((100 * flags.reduce((a, f) => a + CHECKS.length - flagCount(f), 0)) / (CHECKS.length * n)) : null;
  return { tasks: flags.length, open: openAtDespawn, score, checks };
}

/** B5: the grade after the penalty. Same grade back when the rule is off or no flag is set. Never below 1. */
export function adjustGrade(raw: number, flags: number, cfg: Pick<DisciplineConfig, "gradePenalty" | "gradePenaltyCap"> = DEFAULTS): { grade: number; penalty: number } {
  const penalty = Math.min(cfg.gradePenaltyCap, flags * cfg.gradePenalty), grade = Math.max(1, raw - penalty);
  return { grade, penalty: raw - grade };
}

// ---------- daily numbers ----------
const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export interface DayRow { day: string; score: number | null; tasks: number; open: number; checks: Record<Check, number | null>; agents: Record<string, { score: number | null; tasks: number }> }
/** One row per day (by doneAt, local time): all agents pooled plus each agent. `openByDay` = open tasks of agents despawned that day, per agent name. */
export function dailyRows(byAgent: Map<string, TaskRecord[]>, openByDay: Map<string, Map<string, number>> = new Map(), cfg: DisciplineConfig = DEFAULTS): DayRow[] {
  const days = new Map<string, Map<string, TaskFlags[]>>();
  for (const [name, recs] of byAgent) {
    const fl = flagRecords(recs, cfg);
    for (const r of recs) { const d = dayOf(r.doneAt), m = days.get(d) ?? days.set(d, new Map()).get(d)!; (m.get(name) ?? m.set(name, []).get(name)!).push(fl.get(r.id ?? r.taskId)!); }
  }
  for (const d of openByDay.keys()) if (!days.has(d)) days.set(d, new Map());
  return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, agents]) => {
    const open = openByDay.get(day) ?? new Map<string, number>(), names = new Set([...agents.keys(), ...open.keys()]);
    const pooled = [...agents.values()].flat(), openN = [...open.values()].reduce((a, b) => a + b, 0), all = disciplineOf(pooled, openN);
    return { day, score: all.score, tasks: all.tasks, open: openN, checks: all.checks, agents: Object.fromEntries([...names].map((n) => { const x = disciplineOf(agents.get(n) ?? [], open.get(n) ?? 0); return [n, { score: x.score, tasks: x.tasks }]; })) };
  });
}

// ---------- daily snapshot (<home>/data/discipline.jsonl, one line per day, newest write of a day wins) ----------
const snapPath = () => join(ROOT, "data", "discipline.jsonl");
export function readSnapshots(): (DayRow & { at: number })[] {
  try { return readFileSync(snapPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
/** Write (or replace) the line of `row.day`. Returns the file path. */
export function writeSnapshot(row: DayRow, now = Date.now()): string {
  const keep = readSnapshots().filter((r) => r.day !== row.day);
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(snapPath(), [...keep, { ...row, at: now }].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return snapPath();
}
export { dayOf };

// ---------- the work gate ----------
export interface GateInput { exempt: boolean; spawnedAt: number; tasks: { status: string }[]; now: number }
/** null = allowed, else the message the agent reads. Task tools, ToolSearch and the inbox are never asked (the mod skips them). */
export function gateReason(i: GateInput, cfg: DisciplineConfig = disciplineConfig()): string | null {
  if (!cfg.workGate || i.exempt || i.now - i.spawnedAt < cfg.graceMs) return null;
  if (i.tasks.some((t) => t.status === "in_progress")) return null;
  if (!i.tasks.length) return "agentnet task gate: your task list is empty. Add your tasks first with mcp__agentnet__task_add (one per brief item), then mcp__agentnet__task_start the one you work on.";
  if (i.tasks.some((t) => t.status !== "done")) return "agentnet task gate: no task is in progress. Mark the one you are working on with mcp__agentnet__task_start before using other tools.";
  return "agentnet task gate: all your tasks are done. Add the next task with mcp__agentnet__task_add and start it, or report to your boss.";
}
