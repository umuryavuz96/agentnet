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
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agentnet/spawn", "/api/v1/agentnet/agents/t-2/handover", "/api/v1/agentnet/agents/t-2/placement"]);
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
    expect(f.calls[2]!.body).toEqual({ tmux: "agentnet-t-2" });
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
    expect(far.exitCode).toBe(0); expect(f.calls.at(-3)!.body).toMatchObject({ project: repo, brief });
  });
  test("a current folder outside any repo is refused, unless --project-ok or --project names it", async () => {
    const { t, f, run } = setup();
    const r = await run({}, [], t);
    expect(r.exitCode).toBe(1); expect(r.stderr).toContain("is not inside a project repo"); expect(f.calls).toHaveLength(0);
    const ok = await run({}, ["--project-ok"], t);
    expect(ok.exitCode).toBe(0); expect(f.calls[0]!.body).toMatchObject({ brief: null, project_default: true });
    const named = await run({}, ["--project", t], REPO);
    expect(named.exitCode).toBe(0); expect(named.stderr).toContain("is not a git repo"); expect(f.calls.at(-3)!.body).toMatchObject({ project_default: false }); expect(realpathSync(String((f.calls.at(-3)!.body as { project: string }).project))).toBe(realpathSync(t));
  });
  test("pre-spawn check refuses", async () => {
    const { f, run } = setup();
    const r = await run({ AGENTNET_PRESPAWN_CHECK: "false" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing to spawn");
    expect(f.calls).toHaveLength(0);
  });
  test("--print-boot with an own config dir: CLAUDE_CONFIG_DIR, the secret read with $(cat), never the literal", async () => {
    const t = tmp("an-spawn-own-"), bin = join(t, "bin"); mkdirSync(bin); const log = join(t, "stub.log");
    for (const n of ["tmux", "claude"]) { writeFileSync(join(bin, n), '#!/bin/sh\necho "$0 $*" >> "$STUB_LOG"\n'); chmodSync(join(bin, n), 0o755); }
    const secretFile = join(t, "data", "accounts", "main", "oauth-token"), SECRET = "sk-ant-oat01-BOOTSECRET-xyz";
    mkdirSync(join(t, "data", "accounts", "main"), { recursive: true }); writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const cfgDir = join(t, "data", "agents", "t-2", "claude");
    const f = fakeServer({
      "POST /api/v1/agentnet/spawn": () => json({ token_file: join(t, "t-2.token"), agent: "t-2#1", state: "starting", own_config: true, account: "main" }, 201),
      "POST /api/v1/agentnet/agents/t-2/prepare-config": () => json({ own: true, dir: cfgDir, env: "CLAUDE_CODE_OAUTH_TOKEN", file: secretFile }),
    });
    servers.push(f);
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, STUB_LOG: log, AGENTNET_URL: `${f.url}/api/v1/agentnet` };
    const p = Bun.spawn([process.execPath, "run", join(REPO, "src/cli.ts"), "spawn", "t-2", "--job", "j", "--account", "main", "--print-boot", "--mcp", "playwright"], { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    expect(code).toBe(0);
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agentnet/spawn", "/api/v1/agentnet/agents/t-2/handover", "/api/v1/agentnet/agents/t-2/prepare-config"]); // no tmux, no placement
    expect(f.calls[0]!.body).toMatchObject({ account: "main" });
    expect(f.calls[2]!.body).toEqual({ project: REPO, mcp: "playwright" });
    expect(out).toContain(`export CLAUDE_CONFIG_DIR=${cfgDir}`);
    expect(out).toContain(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${secretFile})"`);
    expect(out + err).not.toContain(SECRET);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("new-session");
  });
  test("--print-boot without an own config dir: the boot text is today's (no CLAUDE_CONFIG_DIR, no secret env)", async () => {
    const { f, run, t } = setup();
    const p = Bun.spawn([process.execPath, "run", join(REPO, "src/cli.ts"), "spawn", "t-2", "--job", "j", "--print-boot"], { env: { PATH: `${join(t, "bin")}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, STUB_LOG: join(t, "stub.log"), AGENTNET_URL: `${f.url}/api/v1/agentnet` }, cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [out, code] = [await new Response(p.stdout).text(), await p.exited]; void run;
    expect(code).toBe(0);
    expect(f.calls.map((c) => c.path)).toEqual(["/api/v1/agentnet/spawn", "/api/v1/agentnet/agents/t-2/handover"]);
    expect(out).toContain("export AGENTNET_TOKEN_FILE="); expect(out).toContain("claude --plugin-dir");
    expect(out).not.toContain("CLAUDE_CONFIG_DIR"); expect(out).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
  test("handover: fetched on every spawn, without a boot prompt, with TRAIL_INJECT=0, and exactly once with a boot prompt", async () => {
    const t = tmp("an-spawn-ho-"), bin = join(t, "bin"); mkdirSync(bin);
    for (const n of ["tmux", "claude"]) { writeFileSync(join(bin, n), '#!/bin/sh\necho "$0 $*" >> "$STUB_LOG"\n'); chmodSync(join(bin, n), 0o755); }
    const HO = "# Handover: t-2 gen 1\n\n## Last report\nparser half done";
    const f = fakeServer({
      "POST /api/v1/agentnet/spawn": () => json({ token_file: join(t, "t-2.token"), agent: "t-2#2", state: "starting" }, 201),
      "GET /api/v1/agentnet/agents/t-2/handover": () => json({ text: HO }),
      "POST /api/v1/agentnet/trail/inject": () => json({ text: "Past trails: [1] one hit", skipped: null }),
    });
    servers.push(f);
    const boot = async (extra: Record<string, string>, args: string[]) => {
      const env = { PATH: `${bin}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, STUB_LOG: join(t, "stub.log"), AGENTNET_URL: `${f.url}/api/v1/agentnet`, ...extra };
      const p = Bun.spawn([process.execPath, "run", join(REPO, "src/cli.ts"), "spawn", "t-2", "--job", "j", "--print-boot", ...args], { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
      const [out, code] = [await new Response(p.stdout).text(), await p.exited];
      expect(code).toBe(0);
      return out;
    };
    const count = (s: string, x: string) => s.split(x).length - 1;
    const plain = await boot({}, []);
    expect(count(plain, "Handover from the last t-2:")).toBe(1); expect(plain).toContain("parser half done");
    const off = await boot({ TRAIL_INJECT: "0" }, ["--boot-prompt", "Continue the parser."]);
    expect(count(off, "Handover from the last t-2:")).toBe(1); expect(off).not.toContain("Past trails");
    const both = await boot({}, ["--boot-prompt", "Continue the parser."]);
    expect(count(both, "Handover from the last t-2:")).toBe(1); expect(count(both, "parser half done")).toBe(1);
    expect(both.indexOf("Past trails")).toBeLessThan(both.indexOf("Handover from the last t-2:")); // after the trails, as before
    const none = fakeServer({ "POST /api/v1/agentnet/spawn": () => json({ token_file: join(t, "t-2.token"), agent: "t-2#1", state: "starting" }, 201), "GET /api/v1/agentnet/agents/t-2/handover": () => new Response(null, { status: 204 }) });
    servers.push(none);
    expect(await boot({ AGENTNET_URL: `${none.url}/api/v1/agentnet` }, [])).not.toContain("Handover from");
  });
  test("key file becomes bearer header", async () => {
    const { t, f, run } = setup();
    const kf = join(t, "bearer.txt"); writeFileSync(kf, "k");
    expect((await run({ AGENTNET_ROOT_TOKEN_FILE: kf })).exitCode).toBe(0);
    expect(f.calls[0]!.headers.authorization).toBe("Bearer k");
  });
});
