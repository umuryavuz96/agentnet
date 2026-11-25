// Publish gate for an exam task (docs/internal/SPEC-brain-evals.md 15.3): every hidden check must FAIL on the frozen snapshot (ref)
// and PASS on the fix commit (source.commit). Prints one table row per task and check. `proof` and `verdict` checks need an agent
// text and are skipped here. Usage: bun scripts/evals/validate.ts <task-id>... [--home DIR]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTask, runChecks } from "./run";

const ids = process.argv.slice(2).filter((a, i, v) => !a.startsWith("--") && v[i - 1] !== "--home");
let bad = 0;
console.log("task\tcheck\tparent\tfix\tverdict");
for (const id of ids) {
  const t = findTask(id), checks = t.checks.filter((c) => c.type !== "proof" && c.type !== "verdict");
  const at = (ref: string) => {
    const dir = mkdtempSync(join(tmpdir(), "agentnet-validate-")), wt = join(dir, "wt");
    try {
      const r = Bun.spawnSync(["git", "-C", t.repo, "worktree", "add", "--detach", wt, ref]); if (r.exitCode !== 0) throw new Error(`worktree ${ref}: ${r.stderr}`);
      if (t.setup) Bun.spawnSync(["sh", "-c", t.setup], { cwd: wt, stdout: "ignore", stderr: "ignore" });
      return runChecks(checks, wt, "");
    } finally { Bun.spawnSync(["git", "-C", t.repo, "worktree", "remove", "--force", wt]); rmSync(dir, { recursive: true, force: true }); }
  };
  const fix = (t as unknown as { source: { commit: string } }).source.commit;
  const parent = at(t.ref), after = at(fix);
  checks.forEach((c, i) => {
    const ok = !parent[i]!.ok && after[i]!.ok; if (!ok) bad++;
    console.log(`${id}\t${c.type}:${String(c.cmd ?? c.path ?? "").slice(0, 60)}\t${parent[i]!.ok ? "pass" : "FAIL"}\t${after[i]!.ok ? "pass" : "FAIL"}\t${ok ? "VALID" : "REJECT"}`);
  });
  if (!checks.length) { bad++; console.log(`${id}\t(none)\t-\t-\tREJECT: no machine check`); }
}
console.log(bad ? `${bad} rejected` : "all valid");
process.exit(bad ? 1 : 0);
