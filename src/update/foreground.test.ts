// Drives the foreground restart with a real fake server on a scratch port. Never touches :3096 or the real home.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenerPid, makeService, restartForeground, waitHealth } from "./service";
import { recordLaunch } from "./launch";

const PORT = 3297, HOST = "127.0.0.1";
const dir = mkdtempSync(join(tmpdir(), "an-fg-")), data = join(dir, "home"), repo = join(dir, "repo");
mkdirSync(data); mkdirSync(repo);
// The fake server reports whatever is in ./version at start, like a new checkout would.
writeFileSync(join(repo, "server.ts"), `
import { readFileSync } from "node:fs";
const v = readFileSync("version", "utf8").trim();
if (v === "broken") process.exit(1);
Bun.serve({ hostname: "${HOST}", port: Number(process.env.AGENTNET_PORT), fetch: () => Response.json({ name: "agentnet", version: v }) });
`);
const env = { ...process.env, AGENTNET_PORT: String(PORT) };
const ctx = { repo, host: HOST, port: PORT, data };
let old: ReturnType<typeof Bun.spawn> | undefined;
const start = () => Bun.spawn([process.execPath, join(repo, "server.ts")], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
afterAll(() => { const p = listenerPid(PORT); if (p) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } old?.kill(9); });

describe("foreground restart", () => {
  test("no record: refuses and stops nothing", async () => {
    await expect(restartForeground(ctx)).rejects.toThrow("no launch record");
    expect(makeService(ctx).canRestartForeground?.()).toBe(false);
  });
  test("stops the recorded server, starts the new version detached, log goes to logs/server.log", async () => {
    writeFileSync(join(repo, "version"), "1.0.0");
    old = start();
    expect(await waitHealth(ctx, "1.0.0", 10_000, 100)).toBe(true);
    recordLaunch(data, { version: "1.0.0", pid: old.pid, execPath: process.execPath, argv: [process.execPath, join(repo, "server.ts")], cwd: repo, env });
    expect(makeService(ctx).canRestartForeground?.()).toBe(true);
    writeFileSync(join(repo, "version"), "1.1.0"); // the "checkout"
    await makeService(ctx).restart("foreground");
    expect(await waitHealth(ctx, "1.1.0", 10_000, 100)).toBe(true);
    expect(await old.exited).not.toBe(0); // SIGTERM
    expect(listenerPid(PORT)).not.toBe(old.pid);
    expect(readFileSync(join(data, "logs", "server.log"), "utf8")).toBeDefined();
  });
  test("a different process on the port is never killed", async () => {
    const pid = listenerPid(PORT)!;
    recordLaunch(data, { version: "1.1.0", pid: pid + 99999, execPath: process.execPath, argv: [process.execPath, join(repo, "server.ts")], cwd: repo, env });
    await expect(restartForeground(ctx)).rejects.toThrow("not the recorded server");
    expect(listenerPid(PORT)).toBe(pid);
  });
  test("SIGKILL after the timeout when SIGTERM is ignored", async () => {
    const pid = listenerPid(PORT)!;
    process.kill(pid, "SIGKILL"); await Bun.sleep(300);
    writeFileSync(join(repo, "version"), "2.0.0");
    writeFileSync(join(repo, "stubborn.ts"), `process.on("SIGTERM", () => {}); Bun.serve({ hostname: "${HOST}", port: ${PORT}, fetch: () => Response.json({ name: "agentnet", version: "2.0.0" }) });`);
    const stub = Bun.spawn([process.execPath, join(repo, "stubborn.ts")], { cwd: repo, env, stdout: "ignore", stderr: "ignore" });
    expect(await waitHealth(ctx, "2.0.0", 10_000, 100)).toBe(true);
    recordLaunch(data, { version: "2.0.0", pid: stub.pid, execPath: process.execPath, argv: [process.execPath, join(repo, "server.ts")], cwd: repo, env });
    writeFileSync(join(repo, "version"), "2.1.0");
    await restartForeground(ctx, 400);
    expect(await waitHealth(ctx, "2.1.0", 10_000, 100)).toBe(true);
  });
  test("a new version that dies leaves the port free, and a second restart brings the old one back", async () => {
    writeFileSync(join(repo, "version"), "broken");
    const pid = listenerPid(PORT)!;
    recordLaunch(data, { version: "2.1.0", pid, execPath: process.execPath, argv: [process.execPath, join(repo, "server.ts")], cwd: repo, env });
    await restartForeground(ctx);
    expect(await waitHealth(ctx, "2.1.0", 1500, 100)).toBe(false); // the broken one exited
    writeFileSync(join(repo, "version"), "2.1.0"); // rollback restored the checkout
    await restartForeground(ctx); // no listener: just starts
    expect(await waitHealth(ctx, "2.1.0", 10_000, 100)).toBe(true);
  });
});
