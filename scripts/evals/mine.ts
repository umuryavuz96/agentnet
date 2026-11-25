// Task miner: proposes exam tasks per brain from past jobs (docs/internal/SPEC-brain-evals.md section 2 and 9).
// Reads job_scores read-only, writes one JSON per candidate to <home>/evals/bank/<brain>/<id>.json, prints counts.
// No agent runs, no network. Usage: bun scripts/evals/mine.ts [--home DIR] [--out DIR]
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const HOME = arg("--home") ?? process.env.AGENTNET_HOME ?? join(homedir(), ".local", "share", "agentnet");
const OUT = arg("--out") ?? join(HOME, "evals", "bank");

export interface JobRow { job_id: number; opened_at: number; agent_id: string; soul: string | null; goal: string | null; project: string | null; grade: number | null; rework: number; note: string | null; report: string | null; cost_usd: number | null; wall_ms: number | null; tokens_in: number | null; tokens_out: number | null }
export type Check = { type: "cmd"; cmd: string } | { type: "file"; path: string; exists: boolean } | { type: "proof" } | { type: "layout"; width: 1920 };
export interface Task { id: string; brain: string; kind: "efficiency" | "hard"; status: "candidate"; why: string[]; source: Record<string, unknown>; repo: string; ref: string; prompt: string; checks: Check[]; budget_usd: number; max_turns: number }

// repeat complaints from the corrections list that a machine check can catch
const COMPLAINT: [string, RegExp][] = [
  ["proof", /\b(unproven|no proof|not tested|without (a )?(screenshot|proof)|claimed done)\b/i],
  ["ui-layout", /\b(scroll|cut[- ]?off|layout|overflow|1920)\b/i],
  ["numbers", /\b(unmeasured|wrong number|numbers? (do|did)n.?t)\b/i],
];
export const brainOf = (soul: string | null) => /^([a-z0-9][a-z0-9-]*)@v(\d+)$/.exec(soul ?? "");
const git = (repo: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" }); return p.exitCode === 0 ? p.stdout.toString().trim() : null; };

/** Last hex token in the report that is a real commit of the project. */
export function commitOf(repo: string, report: string | null): string | null {
  const hits = [...(report ?? "").matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]).reverse();
  for (const h of hits) { if (/^\d+$/.test(h)) continue; const full = git(repo, "rev-parse", "--verify", "-q", `${h}^{commit}`); if (full) return full; }
  return null;
}
export function complaints(r: JobRow): string[] {
  const t = `${r.note ?? ""}\n${r.goal ?? ""}`; return COMPLAINT.filter(([, re]) => re.test(t)).map(([k]) => k);
}

export function mine(db: Database): Task[] {
  const rows = db.query(`SELECT job_id, agent_id, soul, goal, project, opened_at, grade, rework, note, report, cost_usd, wall_ms, tokens_in, tokens_out FROM job_scores WHERE soul LIKE '%@v%' AND goal IS NOT NULL AND project IS NOT NULL`).all() as JobRow[];
  const out: Task[] = [];
  for (const r of rows) {
    const m = brainOf(r.soul); if (!m || !r.project || !existsSync(join(r.project, ".git"))) continue;
    const sha = commitOf(r.project, r.report); if (!sha) continue;
    // frozen state = the last commit on the fix's history made before the job opened (not the fix's own parent: the fix is often only the job's last small commit)
    const ref = git(r.project, "rev-list", "-n1", `--before=${Math.floor(r.opened_at / 1000)}`, sha); if (!ref || ref === sha) continue;
    const comp = complaints(r);
    const hard = r.rework > 0 || (r.grade != null && r.grade <= 3) || comp.length > 0;
    const eff = !hard && (r.grade ?? 0) >= 4 && r.cost_usd != null && r.wall_ms != null;
    if (!hard && !eff) continue;
    const why = hard ? [r.rework > 0 ? "rework" : "", r.grade != null && r.grade <= 3 ? `grade ${r.grade}` : "", ...comp.map((c) => `complaint ${c}`)].filter(Boolean) : ["passed, cost known"];
    const added = (git(r.project, "diff", "--name-only", "--diff-filter=A", ref, sha) ?? "").split("\n").filter((f) => f && !/^docs\//.test(f));
    const checks: Check[] = [...added.slice(0, 5).map((p): Check => ({ type: "file", path: p, exists: true }))];
    if (existsSync(join(r.project, "package.json"))) checks.push({ type: "cmd", cmd: "bun test" });
    if (hard) checks.push({ type: "proof" });
    if (comp.includes("ui-layout")) checks.push({ type: "layout", width: 1920 });
    out.push({ id: `${m[1]}-${m[2]}-j${r.job_id}-${r.agent_id.replace(/[^a-z0-9]+/gi, "")}`, brain: m[1]!, kind: hard ? "hard" : "efficiency", status: "candidate", why,
      source: { job_id: r.job_id, agent_id: r.agent_id, soul: r.soul, grade: r.grade, rework: r.rework, cost_usd: r.cost_usd, wall_ms: r.wall_ms, tokens_in: r.tokens_in, tokens_out: r.tokens_out, commit: sha },
      repo: r.project, ref, prompt: r.goal!, checks, budget_usd: 2, max_turns: 60 });
  }
  return out;
}

if (import.meta.main) {
  const db = new Database(join(HOME, "data", "agent-scores.db"), { readonly: true });
  const tasks = mine(db);
  if (existsSync(OUT)) for (const d of readdirSync(OUT)) rmSync(join(OUT, d), { recursive: true, force: true });
  for (const t of tasks) { const d = join(OUT, t.brain); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${t.id}.json`), JSON.stringify(t, null, 2) + "\n"); }
  const n = new Map<string, number>(); for (const t of tasks) n.set(`${t.brain}\t${t.kind}`, (n.get(`${t.brain}\t${t.kind}`) ?? 0) + 1);
  console.log(`bank ${OUT}: ${tasks.length} candidate tasks\nbrain\tkind\tcount`);
  for (const [k, v] of [...n].sort()) console.log(`${k}\t${v}`);
}
