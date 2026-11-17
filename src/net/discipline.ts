// Task discipline: the config switches of the plan rules, the 0-100 discipline score per agent and per day, the daily snapshot file,
// and the work gate decision. Pure math over the facts of closed jobs (scores.ts job_scores). Doc: docs/task-discipline.md.
// Config: <home>/config/task-discipline.json over DEFAULTS, read on each call.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/config";

export interface DisciplineConfig {
  /** The work gate (PreToolUse in the mod) blocks work tools while the agent has no plan. */
  workGate: boolean;
  /** report state=done is refused while steps are open. */
  blockDoneReport: boolean;
  /** Time after spawn in which the gate lets everything through. Reading is never gated, so this only covers the first tool calls. */
  graceMs: number;
}
export const DEFAULTS: DisciplineConfig = { workGate: true, blockDoneReport: true, graceMs: 120_000 };

/** AGENTNET_TASK_STRICT=0 turns the gate and the report rule off (old tests, a host that wants only the score); =1 forces the defaults on. */
export function disciplineConfig(): DisciplineConfig {
  const d: DisciplineConfig = { ...DEFAULTS };
  try { const j = JSON.parse(readFileSync(join(ROOT, "config", "task-discipline.json"), "utf8")) as Partial<DisciplineConfig>; for (const k of Object.keys(DEFAULTS) as (keyof DisciplineConfig)[]) if (typeof j[k] === typeof d[k]) (d as unknown as Record<string, unknown>)[k] = j[k]; } catch { /* defaults */ }
  if (process.env.AGENTNET_TASK_STRICT === "0") Object.assign(d, { workGate: false, blockDoneReport: false });
  return d;
}

// ---------- the score ----------
/** Five numbers, each 0-100, over the steps of closed jobs: work was seen in a done step, a done step has verified proof, a step was in
 *  the plan (not added later), a step was not dropped, a step was not left open when the job closed. */
export const CHECKS = ["workSeen", "evidence", "planKept", "notDropped", "closed"] as const;
export type Check = (typeof CHECKS)[number];
/** What a closed job leaves behind for the score (one row of job_scores). */
export interface JobFacts { agent: string; closedAt: number; steps: number; done: number; added: number; dropped: number; openAtClose: number; noWork: number; verified: number }
export interface Discipline { jobs: number; steps: number; score: number | null; checks: Record<Check, number | null> }
/** The score is the mean of the five numbers that exist. Null with no step. */
export function disciplineOf(jobs: JobFacts[]): Discipline {
  const sum = (k: keyof JobFacts) => jobs.reduce((a, j) => a + (j[k] as number), 0), pct = (part: number, of: number) => (of ? Math.round((100 * part) / of) : null);
  const steps = sum("steps"), done = sum("done");
  const checks: Record<Check, number | null> = { workSeen: pct(done - sum("noWork"), done), evidence: pct(sum("verified"), done), planKept: pct(steps - sum("added"), steps), notDropped: pct(steps - sum("dropped"), steps), closed: pct(steps - sum("openAtClose"), steps) };
  const have = CHECKS.map((k) => checks[k]).filter((v): v is number => v != null);
  return { jobs: jobs.length, steps, score: have.length ? Math.round(have.reduce((a, b) => a + b, 0) / have.length) : null, checks };
}

// ---------- daily numbers ----------
const dayOf = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** One day of the trend. Lines written before jobs existed have `tasks` and the five old check names instead of `jobs` and `steps`. */
export interface DayRow { day: string; score: number | null; jobs: number; steps: number; checks: Record<Check, number | null>; agents: Record<string, { score: number | null; jobs: number }> }
/** One row per day a job closed (local time): all agents pooled plus each agent. */
export function dailyRows(jobs: JobFacts[]): DayRow[] {
  const days = new Map<string, JobFacts[]>();
  for (const j of jobs) { const d = dayOf(j.closedAt); (days.get(d) ?? days.set(d, []).get(d)!).push(j); }
  return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, list]) => {
    const all = disciplineOf(list), names = [...new Set(list.map((j) => j.agent))];
    return { day, score: all.score, jobs: all.jobs, steps: all.steps, checks: all.checks, agents: Object.fromEntries(names.map((n) => { const x = disciplineOf(list.filter((j) => j.agent === n)); return [n, { score: x.score, jobs: x.jobs }]; })) };
  });
}

// ---------- daily snapshot (<home>/data/discipline.jsonl, one line per day, newest write of a day wins) ----------
const snapPath = () => join(ROOT, "data", "discipline.jsonl");
/** Every stored line, old shape and new. */
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
export interface GateInput { exempt: boolean; spawnedAt: number; hasPlan: boolean; now: number }
/** null = allowed, else the message the agent reads. The gate asks one thing: is there a plan. The agentnet tools, ToolSearch and the tools that only read (Read, Grep, Glob) are never asked (the mod skips them). */
export function gateReason(i: GateInput, cfg: DisciplineConfig = disciplineConfig()): string | null {
  if (!cfg.workGate || i.exempt || i.hasPlan || i.now - i.spawnedAt < cfg.graceMs) return null;
  return "agentnet plan gate: you have no plan yet. Read your brief, then set your plan with mcp__agentnet__plan_set: at most 7 steps, the outcomes the brief asks for.";
}
