// A/A noise: same arm against itself. Usage: bun scripts/evals/noise.ts --brain verifier [--repeat 6] [--run] [--home DIR]
// With --run it first runs 3 tasks x repeat tries (arm "AA"); then prints the spread from the stored rows
// (odd repeats against even repeats, per task) and the noise band used as the threshold (spec section 4).
import { findTask, openResults, runOnce } from "./run";
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const brain = arg("--brain")!, n = Number(arg("--repeat", "6")), home = arg("--home") ?? process.env.AGENTNET_HOME ?? `${process.env.HOME}/.local/share/agentnet`;
const tasks = (arg("--tasks", "verifier-seed-sum,verifier-seed-clean,verifier-seed-order")!).split(",");
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
if (process.argv.includes("--run")) for (const id of tasks) for (let k = 1; k <= n; k++) runOnce(findTask(id, home), brain, null, "sonnet", "AA", k, home);
const d = openResults(home);
let band = 0, flips = 0, total = 0;
console.log("task\truns\tpass\tcost mean\tcost CV\twall mean ms\todd-vs-even cost diff");
for (const id of tasks) {
  const rows = d.query(`SELECT repeat, pass, cost_usd c, wall_ms w FROM eval_runs WHERE task_id=? AND arm='AA' AND brain=? ORDER BY repeat`).all(id, brain) as { repeat: number; pass: number; c: number; w: number }[];
  if (!rows.length) continue;
  const odd = rows.filter((r) => r.repeat % 2).map((r) => r.c), even = rows.filter((r) => !(r.repeat % 2)).map((r) => r.c);
  const diff = Math.abs(mean(odd) - mean(even)) / (mean(rows.map((r) => r.c)) || 1);
  band = Math.max(band, diff); total += rows.length; flips += new Set(rows.map((r) => r.pass)).size > 1 ? 1 : 0;
  console.log(`${id}\t${rows.length}\t${rows.filter((r) => r.pass).length}/${rows.length}\t${mean(rows.map((r) => r.c)).toFixed(4)}\t${(sd(rows.map((r) => r.c)) / (mean(rows.map((r) => r.c)) || 1)).toFixed(2)}\t${Math.round(mean(rows.map((r) => r.w)))}\t${(diff * 100).toFixed(1)}%`);
}
const spend = (d.query(`SELECT sum(cost_usd) s FROM eval_runs WHERE arm='AA'`).get() as { s: number }).s;
console.log(`noise band (cost): ${(band * 100).toFixed(1)}%; tasks with pass flips: ${flips}; A/A spend: ${spend?.toFixed(2)} USD over ${total} runs`);
