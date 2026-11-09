// Agent score: pure math over finished-task records (no DB, no clock). Documented in docs/agent-score.md.
// Five sub-scores (0-100): quality (root grade), firstTimeRight (the owner's rounds), efficiency (cost vs role median),
// reliability (task-list hygiene) and rework. The score is their weighted mean, shown only from `minGraded` graded tasks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/config";

export interface ScoreConfig {
  weights: { quality: number; firstTimeRight: number; efficiency: number; reliability: number; rework: number };
  minGraded: number;
  /** Points for 0, 1, 2, 3, >=4 owner rounds. */
  roundsPoints: number[];
  /** Efficiency at exactly the role's median cost per task; 0 cost = 100, `effZeroAt` x median = 0. */
  effAtMedian: number;
  /** A task cost ratio above this is cut (one runaway task must not sink an agent). */
  ratioCap: number;
  staleMs: number; promptStartMs: number; reworkWindowMs: number; costGraceMs: number;
  bands: { min: number; name: string }[];
}
export const DEFAULTS: ScoreConfig = {
  weights: { quality: 30, firstTimeRight: 20, efficiency: 20, reliability: 15, rework: 15 },
  minGraded: 3, roundsPoints: [100, 70, 45, 25, 10], effAtMedian: 75, ratioCap: 4,
  staleMs: 2 * 3600_000, promptStartMs: 10 * 60_000, reworkWindowMs: 24 * 3600_000, costGraceMs: 3 * 60_000,
  bands: [{ min: 80, name: "great" }, { min: 60, name: "good" }, { min: 40, name: "fair" }, { min: 0, name: "poor" }],
};
/** var/config/agent-score.json over the defaults, read on each call (tune without a restart). Bad file = defaults. */
export function scoreConfig(): ScoreConfig {
  const d: ScoreConfig = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const j = JSON.parse(readFileSync(join(ROOT, "config", "agent-score.json"), "utf8")) as Partial<ScoreConfig>;
    Object.assign(d.weights, j.weights ?? {}); delete j.weights;
    if (Array.isArray(j.roundsPoints) && j.roundsPoints.length >= 2 && j.roundsPoints.every((n) => typeof n === "number")) d.roundsPoints = j.roundsPoints; delete j.roundsPoints;
    Object.assign(d, j);
  } catch { /* defaults */ }
  return d;
}

export interface TaskRecord {
  id?: number; agent: string; role: string; model: string | null; soul: string | null; project: string | null;
  taskId: number; text: string; startedAt: number | null; doneAt: number;
  tokens: number | null; costUsd: number | null;
  /** Hygiene facts taken when the task was done. */
  listedFirst: boolean; promptStart: boolean; promptDone: boolean; noteFilled: boolean;
  grade: number | null; note: string | null; rework: boolean; reworkAt: number | null; ownerRounds: number | null; gradedAt: number | null;
}
export interface SubScores { quality: number | null; firstTimeRight: number | null; efficiency: number | null; reliability: number | null; rework: number | null }
export interface Score {
  tasks: number; graded: number; score: number | null; band: string | null; sub: SubScores;
  costPerTask: number | null; avgGrade: number | null; avgRounds: number | null;
}

export const roleOf = (name: string) => name.replace(/-\d+$/, "");
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
export const gradePoints = (g: number) => clamp(((g - 1) / 4) * 100);
export const roundsPoints = (n: number, pts = DEFAULTS.roundsPoints) => pts[Math.min(Math.max(0, Math.floor(n)), pts.length - 1)]!;

/** Median cost of a done task per role, over every record that has a cost. The yardstick for efficiency. */
export function roleMedians(all: TaskRecord[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of all) if (r.costUsd != null) (by.get(r.role) ?? by.set(r.role, []).get(r.role)!).push(r.costUsd);
  return new Map([...by].map(([k, v]) => [k, median(v)!]));
}

/** Score a set of records (one agent, one role, one model, one soul). `stale` = open tasks older than staleMs (each counts as a failed task). */
export function computeScore(recs: TaskRecord[], medians: Map<string, number>, cfg: ScoreConfig = DEFAULTS, stale = 0): Score {
  const graded = recs.filter((r) => r.grade != null);
  const quality = mean(graded.map((r) => gradePoints(r.grade!)));
  const rounded = graded.filter((r) => r.ownerRounds != null);
  const ftr = mean(rounded.map((r) => roundsPoints(r.ownerRounds!, cfg.roundsPoints)));
  // rework: a flag only counts when root set it within the window after the task was done
  const reworked = (r: TaskRecord) => r.rework && (r.reworkAt == null || r.reworkAt - r.doneAt <= cfg.reworkWindowMs);
  const rework = graded.length ? 100 * (1 - graded.filter(reworked).length / graded.length) : null;
  const ratios = recs.filter((r) => r.costUsd != null && (medians.get(r.role) ?? 0) > 0).map((r) => Math.min(cfg.ratioCap, r.costUsd! / medians.get(r.role)!));
  const ratio = mean(ratios);
  // r = 0 -> 100, r = 1 -> effAtMedian, linear down to 0 (clamped)
  const efficiency = ratio == null ? null : clamp(100 - (100 - cfg.effAtMedian) * ratio);
  const checks = recs.reduce((n, r) => n + +r.listedFirst + +r.promptStart + +r.promptDone + +r.noteFilled, 0);
  const reliability = recs.length + stale ? (100 * checks) / (4 * (recs.length + stale)) : null;
  const sub: SubScores = { quality, firstTimeRight: ftr, efficiency, reliability, rework };
  // weighted mean over the sub-scores that exist (missing data never counts as zero)
  let w = 0, s = 0;
  for (const k of Object.keys(sub) as (keyof SubScores)[]) { const v = sub[k]; if (v != null && cfg.weights[k] > 0) { w += cfg.weights[k]; s += cfg.weights[k] * v; } }
  const score = graded.length >= cfg.minGraded && w > 0 ? Math.round(s / w) : null;
  const costs = recs.filter((r) => r.costUsd != null).map((r) => r.costUsd!);
  return {
    tasks: recs.length, graded: graded.length, score, band: score == null ? null : (cfg.bands.find((b) => score >= b.min)?.name ?? null), sub,
    costPerTask: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null, avgGrade: mean(graded.map((r) => r.grade!)), avgRounds: mean(rounded.map((r) => r.ownerRounds!)),
  };
}
