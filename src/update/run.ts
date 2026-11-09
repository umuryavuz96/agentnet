// The update path, shared by the CLI, the web route and auto update.
// preflight, checkout, install, build, swap, restart, health, doctor; any failure after the checkout rolls back.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sections } from "./changelog";
import { doctorLines } from "./doctor";
import * as g from "./git";
import { acquire, readLock, release } from "./lock";
import { preflight } from "./preflight";
import { makeService, manualRestart, type Mode, type ServiceApi } from "./service";
import { fromPackage, versionOf } from "./version";

export type StepId = "preflight" | "checkout" | "install" | "build" | "swap" | "restart" | "health" | "doctor";
export interface Step { id: StepId; state: "pending" | "running" | "ok" | "failed" | "skipped"; detail?: string; ms?: number }
export interface JobResult {
  id: string; from: string; to: string;
  outcome: "updated" | "rolled-back" | "rollback-failed" | "refused" | "current";
  reason?: string; hint?: string; steps: Step[]; changelog?: string; manual?: string[];
}
export type UpdateEvent =
  | { t: number; type: "start"; id: string; from: string; to: string; source: string }
  | { t: number; type: "step"; step: Step }
  | { t: number; type: "log"; line: string }
  | { t: number; type: "done"; result: JobResult };

export type Exec = (cmd: string[], o: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;
export interface RunDeps {
  exec?: Exec;
  service?: ServiceApi;
  /** Names of the doctor checks that FAIL right now. */
  doctorFails?: () => Promise<string[]>;
  resetTo?: (repo: string, commit: string) => void;
  /** How long to wait for the new version to answer on /v1/health. Default 45 s. */
  healthMs?: number;
}
export interface RunOpts {
  repo: string; home: string; source: "cli" | "web" | "auto";
  jobId?: string; expectTag?: string; onEvent?: (e: UpdateEvent) => void;
  host?: string; port?: number;
  /** Tests only; see PreOpts. */
  allowLocalOrigin?: boolean;
  deps?: RunDeps;
}

const ORDER: StepId[] = ["preflight", "checkout", "install", "build", "swap", "restart", "health", "doctor"];
const KEEP_LOGS = 10;

const defaultExec: Exec = async (cmd, { cwd, timeoutMs }) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: o + e };
};

const lastLines = (out: string, n = 20) => out.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);
/** The line that says what went wrong: first one that looks like an error, else the last one. */
export function usefulLine(out: string): string {
  const ls = lastLines(out, 200);
  return (ls.find((l) => /error|failed|cannot|not found|ERR!/i.test(l)) ?? ls[ls.length - 1] ?? "no output").slice(0, 300);
}

const writeAtomic = (file: string, text: string) => { const t = `${file}.tmp`; writeFileSync(t, text); renameSync(t, file); };

function pruneLogs(runDir: string) {
  const ids = readdirSync(runDir).map((f) => /^update-(upd-(\d+))\.jsonl$/.exec(f)).filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[2]) - Number(a[2]));
  for (const m of ids.slice(KEEP_LOGS)) rmSync(join(runDir, m[0]), { force: true });
}

export async function runUpdate(o: RunOpts): Promise<JobResult> {
  const id = o.jobId ?? `upd-${Date.now()}`;
  const host = o.host ?? process.env.AGENTNET_HOST ?? "127.0.0.1", port = o.port ?? Number(process.env.AGENTNET_PORT ?? 3096);
  const exec = o.deps?.exec ?? defaultExec;
  const svc = o.deps?.service ?? makeService({ repo: o.repo, host, port });
  const reset = o.deps?.resetTo ?? g.resetTo;
  const doctorFails = o.deps?.doctorFails ?? (async () => (await doctorLines({ root: o.home, host, port })).filter((l) => l.level === "FAIL").map((l) => l.check));
  const healthMs = o.deps?.healthMs ?? 45_000;
  const runDir = join(o.home, "run");
  mkdirSync(runDir, { recursive: true });

  if (!acquire(o.home, id)) {
    // Another job runs. Touch none of its files.
    const holder = readLock(o.home)?.id ?? "unknown";
    return { id, from: "", to: "", outcome: "refused", reason: "locked", hint: `An update is already running (job ${holder}).`, steps: [] };
  }
  const logFile = join(runDir, `update-${id}.jsonl`), stateFile = join(runDir, "update-state.json");
  const steps: Step[] = ORDER.map((s) => ({ id: s, state: "pending" }));
  const emit = (e: UpdateEvent) => { appendFileSync(logFile, JSON.stringify(e) + "\n"); o.onEvent?.(e); };
  const patch = (sid: StepId, p: Partial<Step>) => { const s = steps.find((x) => x.id === sid)!; Object.assign(s, p); emit({ t: Date.now(), type: "step", step: { ...s } }); };
  const startedAt = Date.now();
  const from = (() => { const v = fromPackage(JSON.parse(readFileSync(join(o.repo, "package.json"), "utf8")).version); return v?.tag ?? ""; })();
  let to = "";
  // skipTag: a tag that was rolled back. Auto update leaves it alone until a newer tag appears. Carried across runs.
  let skipTag: string | undefined = (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")).skipTag as string | undefined; } catch { return undefined; } })();
  const state = (running: boolean, r?: JobResult) => writeAtomic(stateFile, JSON.stringify({ ...(r ?? { id, running, from, to, startedAt }), ...(skipTag ? { skipTag } : {}) }));

  const finish = (r: Omit<JobResult, "id" | "from" | "to" | "steps">): JobResult => {
    for (const s of steps) if (s.state === "pending") s.state = "skipped";
    const result: JobResult = { id, from, to, steps: steps.map((s) => ({ ...s })), ...r };
    emit({ t: Date.now(), type: "done", result });
    if (r.outcome === "rolled-back" || r.outcome === "rollback-failed") skipTag = to;
    state(false, result);
    pruneLogs(runDir);
    return result;
  };

  try {
    state(true);
    const pre = preflight(o.repo, { allowLocalOrigin: o.allowLocalOrigin });
    to = pre.ok ? (pre.target?.tag ?? "") : "";
    emit({ t: Date.now(), type: "start", id, from, to, source: o.source });
    patch("preflight", { state: "running" });
    const t0 = Date.now();
    if (!pre.ok) { patch("preflight", { state: "failed", detail: pre.reason, ms: Date.now() - t0 }); return finish({ outcome: "refused", reason: pre.reason, hint: pre.hint }); }
    if (!pre.target) { patch("preflight", { state: "ok", detail: "already newest", ms: Date.now() - t0 }); return finish({ outcome: "current" }); }
    if (o.expectTag && o.expectTag !== pre.target.tag) {
      patch("preflight", { state: "failed", detail: "target-changed", ms: Date.now() - t0 });
      return finish({ outcome: "refused", reason: "target-changed", hint: `Expected ${o.expectTag}, but the newest release is ${pre.target.tag}.` });
    }
    const doctorBefore = new Set(await doctorFails());
    const prevCommit = g.headCommit(o.repo);
    patch("preflight", { state: "ok", ms: Date.now() - t0 });
    state(true);

    const target = pre.target, ver = versionOf(target);
    const dist = join(o.repo, "web", "dist"), next = join(o.repo, "web", "dist.next"), prev = join(o.repo, "web", "dist.prev");
    const bun = process.execPath;
    let moved = false, swapped = false, hadDist = false, restartRan = false, mode: Mode = "unknown";
    let failed: { step: StepId; msg: string } | null = null;

    const cmd = async (c: string[], timeoutMs: number) => {
      const r = await exec(c, { cwd: o.repo, timeoutMs });
      if (r.code !== 0) { for (const line of lastLines(r.out)) emit({ t: Date.now(), type: "log", line }); throw new Error(usefulLine(r.out)); }
    };
    const run = async (sid: StepId, fn: () => Promise<string | { skip: string } | void>) => {
      patch(sid, { state: "running" });
      const t = Date.now();
      try {
        const r = await fn();
        if (r && typeof r === "object") patch(sid, { state: "skipped", detail: r.skip, ms: Date.now() - t });
        else patch(sid, { state: "ok", ...(r ? { detail: r } : {}), ms: Date.now() - t });
        return true;
      } catch (e) {
        const msg = (e as Error).message;
        patch(sid, { state: "failed", detail: msg, ms: Date.now() - t });
        failed = { step: sid, msg };
        return false;
      }
    };

    (await run("checkout", async () => { moved = true; g.fastForward(o.repo, target.tag); }))
      && (await run("install", () => cmd([bun, "install", "--frozen-lockfile"], 300_000)))
      && (await run("build", async () => {
        rmSync(next, { recursive: true, force: true });
        await cmd([bun, "x", "vite", "build", "--config", "web/vite.config.ts", "--outDir", next, "--emptyOutDir"], 300_000);
        if (!existsSync(join(next, "index.html"))) throw new Error("build produced no index.html");
      }))
      && (await run("swap", async () => {
        rmSync(prev, { recursive: true, force: true });
        hadDist = existsSync(dist);
        if (hadDist) renameSync(dist, prev);
        swapped = true;
        renameSync(next, dist);
      }))
      && (await run("restart", async () => {
        mode = await svc.detectMode();
        if (mode === "foreground" || mode === "unknown") return { skip: "Restart agentnet yourself (stop it and run agentnet serve)" };
        restartRan = true;
        await svc.restart(mode);
      }))
      && (await run("health", async () => {
        if (!restartRan) return { skip: "no restart" };
        if (!(await svc.waitHealth(ver, healthMs))) throw new Error(`agentnet did not report ${ver} within ${Math.round(healthMs / 1000)} s`);
      }))
      && (await run("doctor", async () => {
        const fresh = (await doctorFails()).filter((c) => !doctorBefore.has(c));
        if (fresh.length) throw new Error(`new doctor failures: ${fresh.join(", ")}`);
      }));

    if (!failed) {
      const md = existsSync(join(o.repo, "CHANGELOG.md")) ? readFileSync(join(o.repo, "CHANGELOG.md"), "utf8") : "";
      writeAtomic(join(runDir, "update-last.json"), JSON.stringify({ prevCommit, prevVersion: from, at: Date.now() }));
      return finish({ outcome: "updated", changelog: sections(md, pre.current, target) });
    }

    // Rollback: run every step, even after one fails.
    const f = failed as { step: StepId; msg: string };
    const errs: string[] = [];
    const attempt = async (what: string, fn: () => unknown) => { try { await fn(); } catch (e) { errs.push(`${what}: ${(e as Error).message}`); } };
    emit({ t: Date.now(), type: "log", line: `${f.step} failed, rolling back to ${from}` });
    if (moved) await attempt("reset", () => reset(o.repo, prevCommit));
    await attempt("install", () => cmd([bun, "install", "--frozen-lockfile"], 300_000));
    await attempt("web files", () => {
      if (swapped) { rmSync(dist, { recursive: true, force: true }); if (hadDist) renameSync(prev, dist); }
      rmSync(next, { recursive: true, force: true });
    });
    if (restartRan) {
      await attempt("restart", () => svc.restart(mode));
      await attempt("health", async () => { if (!(await svc.waitHealth(versionOf(pre.current), healthMs))) throw new Error(`agentnet did not report ${versionOf(pre.current)} again`); });
    }
    const reason = `${f.step} failed: ${f.msg}`;
    if (!errs.length) return finish({ outcome: "rolled-back", reason });
    const manual = [`git -C ${o.repo} reset --hard ${prevCommit} && bun install && bun run web:build`, manualRestart(mode)];
    return finish({ outcome: "rollback-failed", reason: `${reason}. Rollback problems: ${errs.join("; ")}`, manual });
  } finally {
    release(o.home, id);
  }
}
