import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const run = async (extra: Record<string, string> = {}) => {
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: t, AGENTNET_HOME: join(t, "data"), ARSENAL_DIR: t, TMPDIR: t, STUB_LOG: log, AGENTNET_URL: `${f.url}/api/v1/agentnet`, ...extra };
    // Async spawn: the fake server lives in this process.
    const p = Bun.spawn([process.execPath, "run", "src/cli.ts", "spawn", "t-2", "--job", "j", "--no-wait"], { env, cwd: REPO, stdout: "pipe", stderr: "pipe" });
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
    expect(soul).toContain("agentnet bg '<description>'");
    // Literal on purpose: the spawner must not leak the old Server OS tool path into the house rules.
    expect(soul).not.toContain("server-dash");
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
