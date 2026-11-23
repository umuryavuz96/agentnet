// The one-folder rule end to end: with a temp HOME and a scratch AGENTNET_HOME, the Hooks page writes, `install-hooks --write`
// and an adopt apply aimed at the user's files leave every file under HOME byte-identical (path, size, sha256, mtime).
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeWorkspace } from "./helpers/adoptFixture";

const REPO = resolve(import.meta.dir, "..");
const HOME = mkdtempSync(join(tmpdir(), "an-nohome-")), AN = mkdtempSync(join(tmpdir(), "an-nodata-"));
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(AN, { recursive: true, force: true }); });

const snapshot = (dir: string, out = new Map<string, string>()): Map<string, string> => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n), s = statSync(p);
    if (s.isDirectory()) snapshot(p, out);
    else out.set(p, `${s.size} ${createHash("sha256").update(readFileSync(p)).digest("hex")} ${s.mtimeMs}`);
  }
  return out;
};
const env = (): Record<string, string> => {
  const e: Record<string, string> = { PATH: process.env.PATH ?? "", HOME, AGENTNET_HOME: AN, AGENTNET_SWEEP: "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" /* bun itself caches under HOME */, USAGE_GUARD_FILE: "/nonexistent/agentnet-test-usage.json" };
  if (process.env.BUN_INSTALL) e.BUN_INSTALL = process.env.BUN_INSTALL;
  return e;
};
const run = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, ...args], { cwd: REPO, env: env(), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

test("Hooks page, install-hooks --write and adopt apply leave HOME byte-identical", async () => {
  // the user's world: ~/.claude/settings.json with one hook, ~/.claude.json, and a project with .claude/settings.json and CLAUDE.md
  const { ws } = makeWorkspace(HOME);
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(join(HOME, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] } }, null, 2) + "\n");
  writeFileSync(join(HOME, ".claude.json"), JSON.stringify({ mcpServers: { pigeon: { command: "pigeon-mcp" } } }, null, 2) + "\n");
  const before = snapshot(HOME);

  const cli = await run(["run", "src/cli.ts", "install-hooks", "--write"]);
  expect(cli.code).toBe(0);
  const base = join(AN, "claude", "base", "settings.json");
  expect(cli.out).toContain(base);
  const refused = await run(["run", "src/cli.ts", "install-hooks", "--write", "--target", join(HOME, ".claude", "settings.json")]);
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("agentnet: refusing to write outside its folder: ");

  const child = await run(["run", "test/fixtures/outside-writes-child.ts", ws]);
  expect(child.code).toBe(0);
  const r = JSON.parse(child.out.trim().split("\n").pop()!) as Record<string, any>;
  expect(r.root).toBe(AN);
  expect(r.external).toEqual({ file: "~/.claude/settings.json", hooks: [{ event: "Stop", matcher: null, command: "echo user-hook" }], readOnly: true });
  expect([r.saveStatus, r.offStatus, r.onStatus]).toEqual([200, 200, 200]);
  expect(r.added).toBeGreaterThan(0);
  expect(r.scanStatus).toBe(200); expect(r.planStatus).toBe(200); expect(r.applyStatus).toBe(200);
  expect(r.ops.filter((o: string) => ["park-hook", "park-mcp", "disable-lines"].includes(o))).toEqual([]);
  expect(r.manual).toBeGreaterThan(0);

  expect(snapshot(HOME)).toEqual(before);
  // the writes landed in agentnet's own base settings instead
  const s = JSON.parse(readFileSync(base, "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  expect(cmds.length).toBeGreaterThan(r.added);
  expect(cmds.some((c) => c.includes("triage.py"))).toBe(true);
  expect(statSync(base).mode & 0o777).toBe(0o600);
  expect(statSync(join(AN, "claude", "base")).mode & 0o777).toBe(0o700);
}, 60_000);
