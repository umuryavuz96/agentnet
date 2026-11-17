import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeServer, json } from "./fake";

const REPO = resolve(import.meta.dir, "..");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));

function setup() {
  const t = tmp("an-spawn-"), bin = join(t, "bin"); mkdirSync(bin);
  const log = join(t, "stub.log");
  for (const n of ["tmux", "claude"]) { writeFileSync(join(bin, n), '#!/bin/sh\necho "$0 $*" >> "$STUB_LOG"\n'); chmodSync(join(bin, n), 0o755); }
  const f = fakeServer({
    "POST /api/v1/agentnet/spawn": () => json({ token_file: join(t, "t-2.token"), agent: "t-2#1", state: "starting" }, 201),
    "POST /api/v1/agentnet/agents/t-2/placement": () => json({}),
  });
  servers.push(f);
  const run = async (extra: Record<string, string> = {}, args: string[] = [], cwd = REPO) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, STUB_LOG: log, AGENTNET_URL: `${f.url}/api/v1/agentnet`, ...extra };
    // Async spawn: the fake server lives in this process.
    const p = Bun.spawn([process.execPath, "run", join(REPO, "src/cli.ts"), "spawn", "t-2", "--job", "j", "--no-wait", ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    const [stderr, exitCode] = [await new Response(p.stderr).text(), await p.exited];
    return { exitCode, stderr };
  };
  return { t, log, f, run };
}

describe("spawn-agent.sh", async () => {
  test("registers, places, starts tmux, writes souls without house paths", async () => {
    const { t, log, f, run } = setup();
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agentnet/spawn", "/api/v1/agentnet/agents/t-2/placement"]);
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(f.calls[1]!.body).toEqual({ tmux: "agentnet-t-2" });
    expect(readFileSync(log, "utf8")).toContain("tmux new-session -d -s agentnet-t-2");
    const soul = readFileSync(join(t, "data", "run", "souls", "agentnet-t-2.md"), "utf8");
    expect(soul).toContain("background Bash call (run_in_background)");
    // Literal on purpose: the spawner must not leak the old Server OS tool path into the house rules.
    expect(soul).not.toContain("server-dash");
  });
  test("the brief named in the boot prompt gives the project (its repo top level) and goes to the service with --max-steps", async () => {
    const { t, f, run } = setup();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "an-repo-"))), brief = join(repo, "docs", "BRIEF-x.md");
    mkdirSync(join(repo, "docs", "deep"), { recursive: true }); writeFileSync(brief, "# x\n\n## Steps\n1. One\n"); writeFileSync(join(repo, "README.md"), "x");
    Bun.spawnSync(["git", "init", "-q", repo]);
    const r = await run({}, ["--boot-prompt", "Read README.md, then docs/BRIEF-x.md and do your part.", "--max-steps", "9"], join(repo, "docs", "deep")); // started from a helper folder of the repo
    expect(r.exitCode).toBe(0);
    expect(f.calls[0]!.body).toMatchObject({ project: repo, project_default: false, brief, max_steps: 9 }); // README.md is named first and is not the brief
    expect(r.stderr).toContain("no plan set from " + brief); // the fake service sets no plan
    const far = await run({}, ["--brief", brief], t); // started outside any repo: the brief decides
    expect(far.exitCode).toBe(0); expect(f.calls.at(-2)!.body).toMatchObject({ project: repo, brief });
  });
  test("a current folder outside any repo is refused, unless --project-ok or --project names it", async () => {
    const { t, f, run } = setup();
    const r = await run({}, [], t);
    expect(r.exitCode).toBe(1); expect(r.stderr).toContain("is not inside a project repo"); expect(f.calls).toHaveLength(0);
    const ok = await run({}, ["--project-ok"], t);
    expect(ok.exitCode).toBe(0); expect(f.calls[0]!.body).toMatchObject({ brief: null, project_default: true });
    const named = await run({}, ["--project", t], REPO);
    expect(named.exitCode).toBe(0); expect(named.stderr).toContain("is not a git repo"); expect(f.calls.at(-2)!.body).toMatchObject({ project_default: false }); expect(realpathSync(String((f.calls.at(-2)!.body as { project: string }).project))).toBe(realpathSync(t));
  });
  test("pre-spawn check refuses", async () => {
    const { f, run } = setup();
    const r = await run({ AGENTNET_PRESPAWN_CHECK: "false" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to spawn");
    expect(f.calls).toHaveLength(0);
  });
  test("key file becomes bearer header", async () => {
    const { t, f, run } = setup();
    const kf = join(t, "bearer.txt"); writeFileSync(kf, "k");
    expect((await run({ AGENTNET_ROOT_TOKEN_FILE: kf })).exitCode).toBe(0);
    expect(f.calls[0]!.headers.authorization).toBe("Bearer k");
  });
});
