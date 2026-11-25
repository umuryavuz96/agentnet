// Eval runner: one task, one arm, isolated worktree, hidden checks, one result row (docs/internal/SPEC-brain-evals.md section 6).
// Usage: bun scripts/evals/run.ts <task-id> --brain <name> [--lessons off|FILE] [--repeat k] [--model sonnet] [--arm A|B] [--home DIR]
// The live service is never touched: the agent runs with `claude -p`, no MCP, no agentnet env, in a temp folder.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrain } from "../../src/net/brains";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HOME = arg("--home") ?? process.env.AGENTNET_HOME ?? join(homedir(), ".local", "share", "agentnet");

export interface Result { ok: boolean; cost_usd: number; tokens_in: number; tokens_out: number; turns: number; wall_ms: number; text: string }
export interface Check { type: string; [k: string]: unknown }
export interface Task { setup?: string; id: string; brain: string; seed?: string; repo: string; ref: string; prompt: string; checks: Check[]; budget_usd: number; max_turns: number }

/** Deny rules applied to every exam run, both arms (root msg 9737): no service control, no pushes, no secrets, never the live ports. */
export const DENY = ["Bash(launchctl*)", "Bash(kill*)", "Bash(pkill*)", "Bash(killall*)", "Bash(brew services*)", "Bash(docker*)", "Bash(git push*)", "Bash(*3068*)", "Bash(*3096*)", "Bash(*.env*)", "Read(~/.env*)", "Read(//Users/*/.env*)", "Edit(~/.env*)", "Edit(//Users/*/.env*)", "Write(~/.env*)"];
export const writeSettings = (dir: string) => { const f = join(dir, "exam-settings.json"); writeFileSync(f, JSON.stringify({ permissions: { deny: DENY } })); return f; };
/** A free TCP port the run may use (the live services keep theirs). */
export function freePort(): number { const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return p; }
/** Kill only processes whose cwd is inside `root` (what an exam run left behind). Returns how many were found. */
export function killLeftovers(root: string): number {
  const out = Bun.spawnSync(["lsof", "-d", "cwd", "-Fpn"]).stdout.toString().split("\n"); let pid = 0, n = 0;
  for (const l of out) { if (l.startsWith("p")) pid = Number(l.slice(1)); else if (l.startsWith("n") && (l.slice(1) === root || l.slice(1).startsWith(root + "/")) && pid !== process.pid) { n++; try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
  return n;
}

export const openResults = (home = HOME) => {
  const d = new Database(join(home, "evals", "results.db"), { create: true }); d.run("PRAGMA journal_mode = WAL");
  d.run(`CREATE TABLE IF NOT EXISTS eval_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, brain TEXT NOT NULL, version TEXT NOT NULL, lessons_hash TEXT NOT NULL, arm TEXT NOT NULL, repeat INTEGER NOT NULL,
    model TEXT NOT NULL, pass INTEGER NOT NULL, checks_json TEXT, cost_usd REAL, tokens_in INTEGER, tokens_out INTEGER, turns INTEGER, wall_ms INTEGER, at INTEGER NOT NULL)`);
  return d;
};

/** Hidden checks run after the agent exits, on its final text and its worktree. Returns one {check, ok} per check. */
export function runChecks(checks: Check[], cwd: string, text: string): { check: string; ok: boolean }[] {
  return checks.map((c) => {
    let ok = false;
    if (c.type === "cmd") ok = Bun.spawnSync(["sh", "-c", String(c.cmd)], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    else if (c.type === "grep") { const f = join(cwd, String(c.path)); const hit = existsSync(f) && new RegExp(String(c.re), "m").test(readFileSync(f, "utf8")); ok = hit === (c.present !== false); }
    else if (c.type === "file") ok = existsSync(join(cwd, String(c.path))) === (c.exists !== false);
    else if (c.type === "proof") ok = /```|\bpass\b|\.png|\bexit 0\b|\d+ pass/i.test(text);
    else if (c.type === "verdict") { const m = /VERDICT\s+(PASS|FAIL)/i.exec(text); ok = !!m && m[1]!.toUpperCase() === c.verdict && (!c.must || new RegExp(String(c.must), "i").test(text)); }
    return { check: c.type, ok };
  });
}

export function parseResult(out: string): Result {
  const j = JSON.parse(out);
  const u = j.usage ?? {};
  return { ok: !j.is_error, cost_usd: Number(j.total_cost_usd ?? 0), tokens_in: Number(u.input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0), tokens_out: Number(u.output_tokens ?? 0), turns: Number(j.num_turns ?? 0), wall_ms: Number(j.duration_ms ?? 0), text: String(j.result ?? "") };
}

export function runOnce(task: Task, brain: string, lessonsFile: string | null, model: string, arm: string, repeat: number, home = HOME) {
  const b = loadBrain(brain), lessons = lessonsFile ? readFileSync(lessonsFile, "utf8") : "";
  const hash = createHash("sha256").update(lessons).digest("hex").slice(0, 8);
  const dir = mkdtempSync(join(tmpdir(), "agentnet-eval-")), wt = join(dir, "wt");
  try {
    if (task.seed) { cpSync(task.seed, wt, { recursive: true }); }
    else { const r = Bun.spawnSync(["git", "-C", task.repo, "worktree", "add", "--detach", wt, task.ref]); if (r.exitCode !== 0) throw new Error(`worktree: ${r.stderr}`); }
    if (task.setup) Bun.spawnSync(["sh", "-c", task.setup], { cwd: wt, stdout: "ignore", stderr: "ignore" });
    const sys = lessons.trim() ? `${b.text}\n## Lessons\n${lessons.trim()}\n` : b.text;
    const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v != null && !/^(AGENTNET|CLAUDE_CODE|CLAUDECODE|PORT$)/.test(k))) as Record<string, string>, PORT: String(freePort()) };
    const p = Bun.spawnSync(["claude", "-p", `${task.prompt}\n\nWork only inside the current folder: do not read or change other folders, and do not stop or restart any running service; if you start a server, use a free port and stop it when done.`, "--output-format", "json", "--append-system-prompt", sys, "--model", model, "--max-budget-usd", String(task.budget_usd),
      "--no-session-persistence", "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--setting-sources", "project", "--settings", writeSettings(dir)], { cwd: wt, env, stdout: "pipe", stderr: "pipe" });
    const left = killLeftovers(wt); if (left) { Bun.sleepSync(1500); killLeftovers(wt); }
    let res: Result;
    try { res = parseResult(p.stdout.toString()); } catch { res = { ok: false, cost_usd: 0, tokens_in: 0, tokens_out: 0, turns: 0, wall_ms: 0, text: `runner: ${p.stderr.toString().slice(0, 300)}` }; }
    const checks = runChecks(task.checks, wt, res.text), pass = res.ok && checks.every((c) => c.ok);
    const d = openResults(home);
    d.run(`INSERT INTO eval_runs (task_id, brain, version, lessons_hash, arm, repeat, model, pass, checks_json, cost_usd, tokens_in, tokens_out, turns, wall_ms, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [task.id, b.name, b.id, hash, arm, repeat, model, +pass, JSON.stringify(checks), res.cost_usd, res.tokens_in, res.tokens_out, res.turns, res.wall_ms, Date.now()]);
    return { task: task.id, brain: b.id, lessons_hash: hash, arm, repeat, pass, checks, cost_usd: res.cost_usd, tokens_in: res.tokens_in, tokens_out: res.tokens_out, turns: res.turns, wall_ms: res.wall_ms, tail: res.text.slice(-200) };
  } finally {
    if (!task.seed) Bun.spawnSync(["git", "-C", task.repo, "worktree", "remove", "--force", wt]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Find a task JSON anywhere in the bank. */
export function findTask(id: string, home = HOME): Task {
  const root = join(home, "evals", "bank");
  for (const b of readdirSync(root)) { const f = join(root, b, `${id}.json`); if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")); }
  throw new Error(`task not found: ${id}`);
}

if (import.meta.main) {
  const id = process.argv[2]!, brain = arg("--brain")!, les = arg("--lessons", "off")!;
  const n = Number(arg("--repeat", "1")), task = findTask(id);
  const only = arg("--only");
  for (let k = only ? Number(only) : 1; k <= (only ? Number(only) : n); k++) console.log(JSON.stringify(runOnce(task, brain, les === "off" ? null : les, arg("--model", "sonnet")!, arg("--arm", "A")!, k)));
}
