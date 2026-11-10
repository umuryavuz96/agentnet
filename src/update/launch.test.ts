import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchEnv, launchFile, readLaunch, recordLaunch, startPlan } from "./launch";

const tmp = () => mkdtempSync(join(tmpdir(), "an-launch-"));

describe("launch record", () => {
  test("keeps only AGENTNET_* and PATH", () => {
    expect(launchEnv({ AGENTNET_PORT: "3296", PATH: "/bin", HOME: "/h", SECRET: "x", AGENTNET_HOME: "/a" })).toEqual({ AGENTNET_PORT: "3296", PATH: "/bin", AGENTNET_HOME: "/a" });
  });
  test("write then read, private file", () => {
    const home = tmp();
    const l = recordLaunch(home, { version: "0.4.2", pid: 11, execPath: "/bin/bun", argv: ["/bin/bun", "/r/src/server.ts"], cwd: "/r", env: { AGENTNET_PORT: "3296", HOME: "/h" }, now: 5 });
    expect(readLaunch(home)).toEqual(l);
    expect(l.env).toEqual({ AGENTNET_PORT: "3296" });
    expect(statSync(launchFile(home)).mode & 0o777).toBe(0o600);
  });
  test("missing or broken record reads as null", () => {
    const home = tmp();
    expect(readLaunch(home)).toBeNull();
    recordLaunch(home, { version: "1" });
    writeFileSync(launchFile(home), '{"pid":1}');
    expect(readLaunch(home)).toBeNull();
    writeFileSync(launchFile(home), "nope");
    expect(readLaunch(home)).toBeNull();
  });
  test("startPlan: recorded exe, script and folder; recorded env wins over the base env", () => {
    const home = tmp();
    const l = recordLaunch(home, { version: "1", pid: 1, execPath: "/bin/bun", argv: ["/bin/bun", "/r/src/server.ts"], cwd: "/r", env: { AGENTNET_PORT: "3296" } });
    const p = startPlan(l, { AGENTNET_PORT: "3096", HOME: "/h" });
    expect(p.cmd).toBe("/bin/bun"); expect(p.args).toEqual(["/r/src/server.ts"]); expect(p.cwd).toBe("/r");
    expect(p.env).toMatchObject({ AGENTNET_PORT: "3296", HOME: "/h" });
    expect(JSON.parse(readFileSync(launchFile(home), "utf8")).version).toBe("1");
  });
});
