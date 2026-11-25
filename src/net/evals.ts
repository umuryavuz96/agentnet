// Brain evals summary for the Evals page (read only): turns eval_runs rows (scripts/evals/run.ts, results.db) into one entry per
// brain with its arms in time order. See docs/internal/SPEC-brain-evals.md sections 3, 4 and 8.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ROOT } from "../core/config";
import type { Env } from "../core/http";

export interface EvalRun { task_id: string; brain: string; version: string; lessons_hash: string; arm: string; repeat: number; pass: number; cost_usd: number | null; tokens_in: number | null; tokens_out: number | null; wall_ms: number | null; at: number }
export interface ArmStat { version: string; lessons: string; arm: string; tasks: number; tries: number; passRate: number; reliability: number; costPerPassed: number | null; costTotal: number; medianWallMs: number; perTask: { task: string; tries: number; pass: number; costMean: number }[] }
export interface Paired { tasks: number; needed: number; ready: boolean; base: ArmStat | null; lessons: ArmStat | null; savedPerJob: number | null }
export interface BrainEval { name: string; smoke: boolean; arms: ArmStat[]; noiseBand: number | null; paired: Paired }

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** One arm = one (brain version, lessons hash, arm label). Cost per passed task = cost of EVERY try (failed ones included) divided by
 *  passed tries, so arms with different repeat counts compare; null when nothing passed. Reliability = tasks where all repeats pass. */
export function armStat(rows: EvalRun[]): ArmStat {
  const byTask = new Map<string, EvalRun[]>(); for (const r of rows) (byTask.get(r.task_id) ?? byTask.set(r.task_id, []).get(r.task_id)!).push(r);
  const passedTries = rows.filter((r) => r.pass).length;
  const allPass = [...byTask.values()].filter((t) => t.every((r) => r.pass)).length;
  const cost = rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const f = rows[0]!;
  return { version: f.version, lessons: f.lessons_hash, arm: f.arm, tasks: byTask.size, tries: rows.length, passRate: rows.filter((r) => r.pass).length / rows.length, reliability: allPass / byTask.size,
    costPerPassed: passedTries ? cost / passedTries : null, costTotal: cost, medianWallMs: median(rows.map((r) => r.wall_ms ?? 0)),
    perTask: [...byTask].map(([task, t]) => ({ task, tries: t.length, pass: t.filter((r) => r.pass).length, costMean: mean(t.map((r) => r.cost_usd ?? 0)) })) };
}

/** A/A threshold: the largest relative gap between the mean cost of odd and even repeats of one task. null when no task has 2+ repeats. */
export function noiseBand(aa: EvalRun[]): number | null {
  const byTask = new Map<string, EvalRun[]>(); for (const r of aa) (byTask.get(r.task_id) ?? byTask.set(r.task_id, []).get(r.task_id)!).push(r);
  let band: number | null = null;
  for (const t of byTask.values()) {
    const odd = t.filter((r) => r.repeat % 2).map((r) => r.cost_usd ?? 0), even = t.filter((r) => !(r.repeat % 2)).map((r) => r.cost_usd ?? 0);
    if (!odd.length || !even.length) continue;
    const d = Math.abs(mean(odd) - mean(even)) / (mean(t.map((r) => r.cost_usd ?? 0)) || 1); band = Math.max(band ?? 0, d);
  }
  return band;
}

const PAIRS_NEEDED = 3;
const rank = (arm: string) => (arm === "base" ? 0 : arm === "all" ? 1 : 2);
/** Base against lessons on the tasks both arms have run (never 4 tasks against 2). Numbers only from 3+ paired tasks. */
export function pairedOf(rs: EvalRun[]): Paired {
  const base = rs.filter((r) => r.arm === "base"), les = rs.filter((r) => r.arm === "all");
  const both = new Set([...new Set(base.map((r) => r.task_id))].filter((t) => les.some((r) => r.task_id === t)));
  const b = base.filter((r) => both.has(r.task_id)), l = les.filter((r) => both.has(r.task_id));
  const ready = both.size >= PAIRS_NEEDED && b.length > 0 && l.length > 0;
  const bs = ready ? armStat(b) : null, ls = ready ? armStat(l) : null;
  return { tasks: both.size, needed: PAIRS_NEEDED, ready, base: bs, lessons: ls, savedPerJob: bs?.costPerPassed != null && ls?.costPerPassed != null ? bs.costPerPassed - ls.costPerPassed : null };
}

/** `seeded` = ids of smoke tasks (hand-seeded, too easy to separate arms): they stay out of the charts, pairing and system card. */
export function evalsSummary(rows: EvalRun[], seeded: Set<string> = new Set()): { brains: BrainEval[] } {
  const by = new Map<string, EvalRun[]>(); for (const r of rows) (by.get(r.brain) ?? by.set(r.brain, []).get(r.brain)!).push(r);
  const brains = [...by].map(([name, all]): BrainEval => {
    const rs = all.filter((r) => !seeded.has(r.task_id));
    const arms = new Map<string, EvalRun[]>(); for (const r of rs) { const k = `${r.version}|${r.lessons_hash}|${r.arm}`; (arms.get(k) ?? arms.set(k, []).get(k)!).push(r); }
    const list = [...arms.values()].sort((a, b) => rank(a[0]!.arm) - rank(b[0]!.arm) || Math.min(...a.map((r) => r.at)) - Math.min(...b.map((r) => r.at))).map(armStat);
    return { name, smoke: rs.length === 0, arms: list, noiseBand: noiseBand(rs.filter((r) => r.arm === "AA")), paired: pairedOf(rs) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { brains };
}

export interface ExamInfo { id: string; brain: string; kind: string; status: string; project: string; what: string; steps: string[]; checks: number; proof: boolean; smoke: boolean }
/** The frozen exams of the bank: what each tests, its steps and how many hidden checks (their commands stay hidden). */
export function examList(bank: string): ExamInfo[] {
  if (!existsSync(bank)) return [];
  const out: ExamInfo[] = [];
  for (const b of readdirSync(bank)) for (const f of readdirSync(join(bank, b)).filter((x) => x.endsWith(".json"))) {
    try {
      const t = JSON.parse(readFileSync(join(bank, b, f), "utf8")); const checks = (t.checks ?? []) as { type: string }[];
      out.push({ id: t.id, brain: t.brain, kind: t.kind, status: t.status, project: String(t.repo ?? "").split("/").pop() ?? "", what: t.what ?? String(t.prompt ?? "").slice(0, 160), steps: t.steps ?? [], checks: checks.filter((c) => c.type !== "proof" && c.type !== "verdict").length, proof: checks.some((c) => c.type === "proof"), smoke: !!t.seed });
    } catch { /* skip a broken file */ }
  }
  return out.sort((a, b) => a.brain.localeCompare(b.brain) || a.id.localeCompare(b.id));
}

/** Brain x exam grid: per exam task and arm label, passed tries / tries and mean cost. */
export function examGrid(rows: EvalRun[]) {
  const g = new Map<string, { brain: string; task: string; arm: string; tries: number; pass: number; cost: number }>();
  for (const r of rows) { const k = `${r.brain}|${r.task_id}|${r.version}|${r.lessons_hash}|${r.arm}`; const e = g.get(k) ?? g.set(k, { brain: r.brain, task: r.task_id, arm: `${r.version.replace(/^[^@]*@/, "")} ${r.arm}${r.lessons_hash !== "e3b0c442" ? " +L" : ""}`, tries: 0, pass: 0, cost: 0 }).get(k)!; e.tries++; e.pass += r.pass ? 1 : 0; e.cost += r.cost_usd ?? 0; }
  return [...g.values()].map((e) => ({ brain: e.brain, task: e.task, arm: e.arm, tries: e.tries, pass: e.pass, costMean: e.cost / e.tries }));
}

/** Whole-system view from the paired results only: per brain base vs lessons USD and tokens per passed try, and the saving
 *  (base - lessons cost per passed try) x real jobs of that brain. Negative when lessons cost more; never clamped. */
export function systemView(brains: BrainEval[], jobs: Record<string, number>) {
  const per = brains.filter((b) => !b.smoke).map((b) => {
    const p = b.paired;
    return { brain: b.name, pairedTasks: p.tasks, needed: p.needed, ready: p.ready, baseUsd: p.base?.costPerPassed ?? null, lessonsUsd: p.lessons?.costPerPassed ?? null, jobs: jobs[b.name] ?? 0, savedUsd: p.savedPerJob != null ? p.savedPerJob * (jobs[b.name] ?? 0) : null };
  });
  const known = per.filter((x) => x.savedUsd != null);
  return { brains: per, savedUsdEstimate: known.length ? known.reduce((n, x) => n + (x.savedUsd ?? 0), 0) : null, basis: "estimate: (base cost per passed try - lessons cost per passed try) on paired tasks x real jobs of that brain; minus when lessons cost more" };
}

export function evalsRoutes(api: Hono<Env>) {
  api.get("/evals/summary", (c) => {
    const f = join(ROOT, "evals", "results.db");
    if (!existsSync(f)) return c.json({ brains: [] });
    const d = new Database(f, { readwrite: true });
    try {
      const rows = d.query("SELECT task_id, brain, version, lessons_hash, arm, repeat, pass, cost_usd, tokens_in, tokens_out, wall_ms, at FROM eval_runs").all() as EvalRun[];
      const jobs: Record<string, number> = {}; const sf = join(ROOT, "data", "agent-scores.db");
      if (existsSync(sf)) { const sd = new Database(sf, { readonly: true }); try { for (const r of sd.query("SELECT substr(soul,1,instr(soul,'@')-1) b, count(*) n FROM job_scores WHERE soul LIKE '%@%' GROUP BY b").all() as { b: string; n: number }[]) jobs[r.b] = r.n; } catch { /* no table */ } finally { sd.close(); } }
      const exams = examList(join(ROOT, "evals", "bank")), seeded = new Set(exams.filter((e) => e.smoke).map((e) => e.id));
      const sum = evalsSummary(rows, seeded);
      return c.json({ ...sum, exams, grid: examGrid(rows.filter((r) => !seeded.has(r.task_id))), system: systemView(sum.brains, jobs) });
    } finally { d.close(); }
  });
}
