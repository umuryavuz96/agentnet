// `agentnet update`. The command parsing and printing live here; the work is in preflight.ts and run.ts.
import { sections } from "./changelog";
import { showFile } from "./git";
import { preflight, type PreOpts } from "./preflight";
import { runUpdate, type JobResult, type RunDeps, type UpdateEvent } from "./run";
import { parseTag } from "./version";

export interface CliOpts extends PreOpts {
  repo: string;
  home: string;
  out?: (line: string) => void;
  /** Tests: stand-ins for the terminal and the injected install/build/restart. */
  isTTY?: boolean;
  ask?: () => Promise<boolean>;
  deps?: RunDeps;
}

const secs = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);

async function askYesNo(): Promise<boolean> {
  process.stdout.write("Update now? [y/N] ");
  for await (const line of console) return /^y(es)?$/i.test(String(line).trim());
  return false;
}

export async function runUpdateCli(args: string[], o: CliOpts): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  let check = false, yes = false, source: "cli" | "web" | "auto" = "cli", jobId: string | undefined, expectTag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--check") check = true;
    else if (a === "--yes") yes = true;
    else if ((a === "--from-web" || a === "--from-auto") && /^upd-\d+$/.test(args[i + 1] ?? "")) { source = a === "--from-web" ? "web" : "auto"; jobId = args[++i]; }
    else if (a === "--expect" && parseTag(args[i + 1] ?? "")) expectTag = args[++i];
    else { out(`agentnet update: unknown or incomplete option ${a}`); return 2; }
  }
  const pre = preflight(o.repo, { home: o.home, allowLocalOrigin: o.allowLocalOrigin });
  if (!pre.ok) { out(`refused (${pre.reason}): ${pre.hint}`); return 1; }
  if (!pre.target) { out(`already on ${pre.current.tag} (newest)`); return 0; }
  out(`${pre.current.tag} -> ${pre.target.tag}`);
  const md = showFile(o.repo, `refs/tags/${pre.target.tag}`, "CHANGELOG.md");
  const log = md ? sections(md, pre.current, pre.target) : "";
  if (log) out(log);
  if (check) return 10;
  if (!yes) {
    if (!(o.isTTY ?? process.stdin.isTTY)) { out("add --yes to run without asking"); return 2; }
    if (!(await (o.ask ?? askYesNo)())) { out("not updating"); return 0; }
  }
  const onEvent = (e: UpdateEvent) => {
    if (e.type !== "step" || e.step.state === "pending" || e.step.state === "running") return;
    const tag = e.step.state === "ok" ? "ok  " : e.step.state === "failed" ? "FAIL" : "skip";
    out(`${tag} ${e.step.id.padEnd(9)}${secs(e.step.ms)}${e.step.state === "ok" ? "" : e.step.detail ? "  " + e.step.detail : ""}`.trimEnd());
  };
  const r: JobResult = await runUpdate({ repo: o.repo, home: o.home, source, jobId, expectTag, onEvent, allowLocalOrigin: o.allowLocalOrigin, deps: o.deps });
  switch (r.outcome) {
    case "updated": out(`updated to ${r.to}`); if (r.changelog) out(r.changelog); return 0;
    case "current": out(`already on ${r.from} (newest)`); return 0;
    case "refused": out(`refused (${r.reason}): ${r.hint ?? ""}`); return 1;
    case "rolled-back": out(`rolled back to ${r.from}: ${r.reason}`); return 1;
    case "rollback-failed": out(`ROLLBACK FAILED: ${r.reason}`); out("fix by hand:"); for (const m of r.manual ?? []) out(`  ${m}`); return 3;
  }
}
