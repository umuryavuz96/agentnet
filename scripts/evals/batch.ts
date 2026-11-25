// Batch: one brain, arms run on the brain's whole exam (every ready non-smoke task), r repeats each (docs/internal/SPEC-brain-evals.md 15).
// Runs are shuffled (fixed seed) so time drift hits both arms alike, and 3 run at once. Safe to restart: runs already in results.db are skipped.
// Stops launching at weekly usage >= 85 % (usage.json) and exits 3. Usage: bun scripts/evals/batch.ts --brain web-dev --brains-copy DIR [--repeat 3] [--par 3] [--arms base,all] [--home DIR]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openResults, type Task } from "./run";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HOME = arg("--home") ?? process.env.AGENTNET_HOME ?? join(homedir(), ".local", "share", "agentnet");
const brain = arg("--brain")!, copy = arg("--brains-copy")!, reps = Number(arg("--repeat", "3")), par = Number(arg("--par", "3")), arms = (arg("--arms", "base,all")!).split(",");
const USAGE_STOP = Number(arg("--usage-stop", "85"));
const usage = () => { try { return Number(JSON.parse(readFileSync(join(homedir(), ".claude/hooks/state/usage.json"), "utf8")).windows.seven_day.used); } catch { return 100; } };

// the "all" arm carries the candidate lessons of the brain copy; base carries none
const lessons = join(tmpdir(), `lessons-${brain}.txt`);
const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(copy, `${brain}.md`), "utf8"))![1]!;
const items = [...fm.matchAll(/^  - (\{"id".*\})$/gm)].map((m) => JSON.parse(m[1]!).text as string);
writeFileSync(lessons, items.map((t) => `- ${t}`).join("\n") + "\n");

const dir = join(HOME, "evals", "bank", brain);
const tasks = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task & { status: string; seed?: string }).filter((t) => t.status === "ready" && !t.seed);
const done = new Set((openResults(HOME).query("SELECT task_id, arm, repeat FROM eval_runs WHERE brain=?").all(brain) as { task_id: string; arm: string; repeat: number }[]).map((r) => `${r.task_id}|${r.arm}|${r.repeat}`));
let jobs = tasks.flatMap((t) => arms.flatMap((a) => Array.from({ length: reps }, (_, k) => ({ id: t.id, arm: a, k: k + 1 })))).filter((j) => !done.has(`${j.id}|${j.arm}|${j.k}`));
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
jobs = jobs.map((j) => ({ j, r: rnd() })).sort((a, b) => a.r - b.r).map((x) => x.j);
console.log(`${brain}: ${tasks.length} ready tasks, ${jobs.length} runs to do (${done.size} already in results.db), parallel ${par}`);

let running = 0, finished = 0, stop = false;
const run = (j: { id: string; arm: string; k: number }) => new Promise<void>((res) => {
  running++;
  const p = Bun.spawn(["bun", join(import.meta.dir, "run.ts"), j.id, "--brain", brain, "--arm", j.arm, "--only", String(j.k), "--lessons", j.arm === "all" ? lessons : "off", "--home", HOME], { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTNET_BRAINS_DIR: process.env.AGENTNET_BRAINS_DIR ?? join(homedir(), ".agents", "brains") } });
  new Response(p.stdout).text().then((o) => { finished++; running--; console.log(`done ${finished}/${jobs.length} ${j.id} ${j.arm} #${j.k}: ${(o.match(/"pass":(true|false)/) ?? [])[0] ?? "no row"} ${(o.match(/"cost_usd":[0-9.]+/) ?? [])[0] ?? ""} usage ${usage()}`); res(); });
});
// memory pressure (16 GB box): below 25 % free memory drop to 2 parallel runs
const freePct = () => Number((/free percentage: (\d+)%/.exec(Bun.spawnSync(["memory_pressure"]).stdout.toString()) ?? [])[1] ?? 100);
const live: Promise<void>[] = [];
for (const j of jobs) {
  while (running >= (freePct() < 25 ? Math.min(par, 2) : par)) await Promise.race(live);
  if (usage() >= USAGE_STOP) { stop = true; console.log(`PAUSED: weekly usage ${usage()} >= ${USAGE_STOP}`); break; }
  const p = run(j); live.push(p); p.then(() => live.splice(live.indexOf(p), 1));
}
await Promise.all(live);
console.log(stop ? "paused" : "batch complete"); process.exit(stop ? 3 : 0);
