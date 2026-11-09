import { describe, expect, test } from "bun:test";
import { runUpdateCli } from "../src/update/cli";
import { headCommit } from "../src/update/git";
import { makeFixture, sh } from "./updateFixture";

async function cli(f: ReturnType<typeof makeFixture>, args: string[]) {
  const lines: string[] = [];
  const code = await runUpdateCli(args, { repo: f.work, home: f.home, allowLocalOrigin: true, out: (l) => lines.push(l) });
  return { code, text: lines.join("\n") };
}

describe("update --check", () => {
  test("T4: already newest: exit 0 and says so", async () => {
    const f = makeFixture();
    sh(f.work, "pull", "--ff-only", "origin", "main");
    const r = await cli(f, ["--check"]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("already on v0.4.0 (newest)");
  });
  test("T5: update available: exit 10, plan printed, HEAD unchanged", async () => {
    const f = makeFixture();
    const before = headCommit(f.work);
    const r = await cli(f, ["--check"]);
    expect(r.code).toBe(10);
    expect(r.text).toContain("v0.3.0 -> v0.4.0");
    expect(r.text).toContain("## 0.4.0");
    expect(r.text).toContain("## 0.3.1");
    expect(r.text).not.toContain("## 0.3.0");
    expect(headCommit(f.work)).toBe(before);
  });
  test("refused: exit 1 with the code", async () => {
    const f = makeFixture();
    sh(f.work, "remote", "remove", "origin");
    const r = await cli(f, ["--check"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("refused (no-origin)");
  });
  test("unknown option: exit 2", async () => {
    const r = await cli(makeFixture(), ["--force"]);
    expect(r.code).toBe(2);
  });
});

// ---- the update path (T6-T12): install/build/restart/doctor are injected, git is real on the fixture ----
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquire, release } from "../src/update/lock";
import { runUpdate, type Exec, type RunDeps } from "../src/update/run";
import type { Mode, ServiceApi } from "../src/update/service";

function harness(f: ReturnType<typeof makeFixture>, o: { failInstall?: boolean; failBuild?: boolean; health?: (v: string) => boolean; mode?: Mode; doctor?: string[][]; resetTo?: RunDeps["resetTo"]; installOnlyFirst?: boolean } = {}) {
  const calls: string[] = [];
  let installs = 0, restarts = 0;
  const exec: Exec = async (cmd, { cwd }) => {
    expect(cwd).toBe(f.work); // every command runs in the fixture, never elsewhere
    if (cmd[1] === "install") { calls.push("install"); installs++; return o.failInstall && (!o.installOnlyFirst || installs === 1) ? { code: 1, out: "noise\nerror: lockfile had changes\n" } : { code: 0, out: "" }; }
    calls.push("build");
    if (o.failBuild) return { code: 1, out: "vite: Build failed in 1s\nerror during build" };
    const out = cmd[cmd.indexOf("--outDir") + 1]!;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), "new build");
    return { code: 0, out: "" };
  };
  const service: ServiceApi = {
    detectMode: async () => o.mode ?? "launchd",
    restart: async () => { restarts++; calls.push("restart"); },
    waitHealth: async (v) => (o.health ? o.health(v) : true),
  };
  const queue = [...(o.doctor ?? [[], []])];
  const deps: RunDeps = { exec, service, doctorFails: async () => queue.shift() ?? [], healthMs: 50, ...(o.resetTo ? { resetTo: o.resetTo } : {}) };
  return { deps, calls, restarts: () => restarts };
}
const run = (f: ReturnType<typeof makeFixture>, deps: RunDeps) => runUpdate({ repo: f.work, home: f.home, source: "cli", allowLocalOrigin: true, deps });
const distText = (f: ReturnType<typeof makeFixture>) => readFileSync(join(f.work, "web", "dist", "index.html"), "utf8");

describe("runUpdate", () => {
  test("T6 happy path", async () => {
    const f = makeFixture(), h = harness(f);
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("updated");
    expect(r.from).toBe("v0.3.0"); expect(r.to).toBe("v0.4.0");
    expect(sh(f.work, "rev-parse", "HEAD")).toBe(sh(f.work, "rev-parse", "v0.4.0^{commit}"));
    expect(distText(f)).toBe("new build");
    expect(readFileSync(join(f.work, "web", "dist.prev", "index.html"), "utf8")).toBe("old build");
    expect(existsSync(join(f.work, "web", "dist.next"))).toBe(false);
    expect(h.restarts()).toBe(1);
    expect(r.changelog).toContain("## 0.4.0"); expect(r.changelog).toContain("## 0.3.1"); expect(r.changelog).not.toContain("## 0.3.0");
    expect(r.steps.map((s) => s.state)).toEqual(Array(8).fill("ok"));
    // job log, state, last, lock released
    const log = readFileSync(join(f.home, "run", `update-${r.id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(log[0].type).toBe("start"); expect(log[log.length - 1].type).toBe("done");
    expect(JSON.parse(readFileSync(join(f.home, "run", "update-state.json"), "utf8")).outcome).toBe("updated");
    expect(JSON.parse(readFileSync(join(f.home, "run", "update-last.json"), "utf8")).prevVersion).toBe("v0.3.0");
    expect(existsSync(join(f.home, "run", "update.lock"))).toBe(false);
  });
  test("foreground mode: restart and health skipped, still updated", async () => {
    const f = makeFixture(), h = harness(f, { mode: "foreground" });
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("updated");
    expect(r.steps.find((s) => s.id === "restart")!.state).toBe("skipped");
    expect(r.steps.find((s) => s.id === "restart")!.detail).toContain("Restart agentnet yourself");
    expect(r.steps.find((s) => s.id === "health")!.state).toBe("skipped");
    expect(h.restarts()).toBe(0);
  });
  test("current: nothing runs", async () => {
    const f = makeFixture(); sh(f.work, "pull", "--ff-only", "origin", "main");
    const h = harness(f);
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("current"); expect(h.calls).toEqual([]);
  });
  test("expectTag mismatch: refused target-changed, nothing moves", async () => {
    const f = makeFixture(), h = harness(f), before = sh(f.work, "rev-parse", "HEAD");
    const r = await runUpdate({ repo: f.work, home: f.home, source: "web", expectTag: "v0.3.1", allowLocalOrigin: true, deps: h.deps });
    expect(r.outcome).toBe("refused"); expect(r.reason).toBe("target-changed");
    expect(sh(f.work, "rev-parse", "HEAD")).toBe(before);
  });
  test("T7 install fails: rolled back", async () => {
    const f = makeFixture(), before = sh(f.work, "rev-parse", "HEAD"), h = harness(f, { failInstall: true, installOnlyFirst: true });
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("rolled-back");
    expect(r.reason).toStartWith("install failed");
    expect(r.reason).toContain("lockfile had changes");
    expect(sh(f.work, "rev-parse", "HEAD")).toBe(before);
    expect(distText(f)).toBe("old build");
    expect(existsSync(join(f.work, "web", "dist.next"))).toBe(false);
    expect(h.restarts()).toBe(0);
    expect(r.steps.find((s) => s.id === "build")!.state).toBe("skipped");
  });
  test("T8 build fails: rolled back, no dist.next", async () => {
    const f = makeFixture(), before = sh(f.work, "rev-parse", "HEAD"), h = harness(f, { failBuild: true });
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("rolled-back"); expect(r.reason).toStartWith("build failed");
    expect(sh(f.work, "rev-parse", "HEAD")).toBe(before);
    expect(distText(f)).toBe("old build");
    expect(existsSync(join(f.work, "web", "dist.next"))).toBe(false);
  });
  test("T9 health fails: rolled back, restarted twice, old web restored", async () => {
    const f = makeFixture(), before = sh(f.work, "rev-parse", "HEAD");
    const h = harness(f, { health: (v) => v === "0.3.0" });
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("rolled-back"); expect(r.reason).toStartWith("health failed");
    expect(h.restarts()).toBe(2);
    expect(sh(f.work, "rev-parse", "HEAD")).toBe(before);
    expect(distText(f)).toBe("old build");
  });
  test("T10 doctor: a failure that was already there does not roll back; a new one does", async () => {
    const f = makeFixture();
    const ok = await run(f, harness(f, { doctor: [["tmux"], ["tmux"]] }).deps);
    expect(ok.outcome).toBe("updated");
    const g = makeFixture(), before = sh(g.work, "rev-parse", "HEAD");
    const bad = await run(g, harness(g, { doctor: [["tmux"], ["tmux", "python3"]] }).deps);
    expect(bad.outcome).toBe("rolled-back"); expect(bad.reason).toContain("python3");
    expect(sh(g.work, "rev-parse", "HEAD")).toBe(before);
  });
  test("T11 rollback fails: manual commands with the previous commit", async () => {
    const f = makeFixture(), before = sh(f.work, "rev-parse", "HEAD");
    const h = harness(f, { failBuild: true, resetTo: () => { throw new Error("index.lock exists"); } });
    const r = await run(f, h.deps);
    expect(r.outcome).toBe("rollback-failed");
    expect(r.reason).toContain("index.lock exists");
    expect(r.manual![0]).toContain(`reset --hard ${before}`);
    expect(existsSync(join(f.home, "run", "update.lock"))).toBe(false);
  });
  test("T12 lock: second run refuses; a dead pid lock is replaced", async () => {
    const f = makeFixture(), h = harness(f);
    expect(acquire(f.home, "upd-1")).not.toBeNull();
    const second = await run(f, h.deps);
    expect(second.outcome).toBe("refused"); expect(second.reason).toBe("locked"); expect(second.hint).toContain("upd-1");
    expect(h.calls).toEqual([]);
    release(f.home, "upd-1");
    writeFileSync(join(f.home, "run", "update.lock"), JSON.stringify({ id: "upd-0", pid: 2 ** 22 + 999, startedAt: 1 }));
    expect((await run(f, h.deps)).outcome).toBe("updated");
  });
  test("a rollback stores skipTag in the state file and the next run keeps it", async () => {
    const f = makeFixture();
    expect((await run(f, harness(f, { failBuild: true }).deps)).outcome).toBe("rolled-back");
    const st = () => JSON.parse(readFileSync(join(f.home, "run", "update-state.json"), "utf8"));
    expect(st().skipTag).toBe("v0.4.0");
    expect((await run(f, harness(f).deps)).outcome).toBe("updated");
    expect(st().skipTag).toBe("v0.4.0"); // cleared only by a newer tag in the auto gate, never by a success of this tag
  });
  test("keeps only the 10 newest job logs", async () => {
    const f = makeFixture(); mkdirSync(join(f.home, "run"), { recursive: true });
    for (let i = 1; i <= 12; i++) writeFileSync(join(f.home, "run", `update-upd-${1000 + i}.jsonl`), "{}\n");
    await run(f, harness(f).deps);
    expect(readdirSync(join(f.home, "run")).filter((n) => /^update-upd-\d+\.jsonl$/.test(n))).toHaveLength(10);
  });
});

describe("update CLI run", () => {
  test("non-TTY without --yes: exit 2; --yes runs; prints steps and changelog", async () => {
    const f = makeFixture(), h = harness(f);
    const lines: string[] = [];
    const base = { repo: f.work, home: f.home, allowLocalOrigin: true, out: (l: string) => lines.push(l), deps: h.deps };
    expect(await runUpdateCli([], { ...base, isTTY: false })).toBe(2);
    expect(lines.join("\n")).toContain("add --yes to run without asking");
    expect(h.calls).toEqual([]);
    lines.length = 0;
    expect(await runUpdateCli(["--yes"], base)).toBe(0);
    const t = lines.join("\n");
    expect(t).toMatch(/ok\s+install/); expect(t).toContain("updated to v0.4.0"); expect(t).toContain("## 0.4.0");
  });
  test("TTY: n declines, y runs", async () => {
    const f = makeFixture(), h = harness(f);
    const base = { repo: f.work, home: f.home, allowLocalOrigin: true, out: () => {}, deps: h.deps, isTTY: true };
    expect(await runUpdateCli([], { ...base, ask: async () => false })).toBe(0);
    expect(h.calls).toEqual([]);
    expect(await runUpdateCli([], { ...base, ask: async () => true })).toBe(0);
    expect(h.calls).toContain("build");
  });
  test("exit codes: rolled back 1, rollback failed 3", async () => {
    const f = makeFixture(), g = makeFixture();
    const mk = (fx: typeof f, h: ReturnType<typeof harness>) => ({ repo: fx.work, home: fx.home, allowLocalOrigin: true, out: () => {}, deps: h.deps });
    expect(await runUpdateCli(["--yes"], mk(f, harness(f, { failBuild: true })))).toBe(1);
    expect(await runUpdateCli(["--yes"], mk(g, harness(g, { failBuild: true, resetTo: () => { throw new Error("x"); } })))).toBe(3);
  });
  test("--from-web needs a job id and --expect needs a release tag", async () => {
    const f = makeFixture(), out = () => {};
    const base = { repo: f.work, home: f.home, allowLocalOrigin: true, out };
    expect(await runUpdateCli(["--from-web", "nope"], base)).toBe(2);
    expect(await runUpdateCli(["--expect", "main"], base)).toBe(2);
  });
});
