import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMode, LAUNCHD_LABEL, listenerPid, restart, serviceLabel, serviceUnit, SYSTEMD_UNIT, waitHealth, type Sh } from "./service";
import { fakeServer, json } from "../../test/fake";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const darwin = process.platform === "darwin";
const mac = darwin ? test : test.skip, linux = process.platform === "linux" ? test : test.skip;

function plist(home: string, dir: string, port: number) {
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    `<dict><key>WorkingDirectory</key>\n<string>${dir}</string><key>EnvironmentVariables</key><dict><key>AGENTNET_PORT</key>\n<string>${port}</string></dict></dict>`);
}
function unit(home: string, dir: string, port: number) {
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`), `[Service]\nWorkingDirectory=${dir}\nEnvironment="AGENTNET_PORT=${port}"\n`);
}
const loaded: Sh = (cmd) => (cmd[0] === "launchctl" ? { code: 0, out: "pid = 4242" } : cmd[0] === "systemctl" && cmd[2] === "is-active" ? { code: 0, out: "active" }
  : cmd.includes("FragmentPath") ? { code: 0, out: "" } : { code: 0, out: "4242" }); // empty FragmentPath: detectMode uses the default unit path

describe("detectMode (C)", () => {
  mac("launchd when the unit is loaded, in this repo, on this port", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-");
    plist(home, repo, 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 3096, home }, undefined, loaded)).toBe("launchd");
    expect(await detectMode({ repo, host: "127.0.0.1", port: 3096, home }, 4242, loaded)).toBe("launchd");
  });
  mac("unit file points at another checkout: not launchd, no restart", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-");
    plist(home, tmp("an-other-"), 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 59997, home }, undefined, loaded)).toBe("unknown");
  });
  mac("unit file on another port: not launchd", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-");
    plist(home, repo, 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 59997, home }, undefined, loaded)).toBe("unknown");
  });
  mac("loaded unit owned by another pid: not launchd", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-");
    plist(home, repo, 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 3096, home }, 99, loaded)).not.toBe("launchd");
  });
  mac("no unit file: foreground when a server answers", async () => {
    const f = fakeServer({ "GET /v1/health": () => json({ name: "agentnet", version: "0.3.0" }) });
    try {
      const port = Number(new URL(f.url).port);
      expect(await detectMode({ repo: tmp("an-r-"), host: "127.0.0.1", port, home: tmp("an-h-") }, undefined, loaded)).toBe("foreground");
    } finally { f.stop(); }
  });
  linux("systemd: unit in another dir is ignored", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-");
    unit(home, tmp("an-other-"), 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 3096, home }, undefined, loaded)).toBe("unknown");
    unit(home, repo, 3096);
    expect(await detectMode({ repo, host: "127.0.0.1", port: 3096, home }, undefined, loaded)).toBe("systemd");
  });
});

describe("service label and unit (AGENTNET_SERVICE_LABEL / _UNIT)", () => {
  test("default, override, and refusal of odd characters", () => {
    expect(serviceLabel({})).toBe(LAUNCHD_LABEL); expect(serviceUnit({})).toBe(SYSTEMD_UNIT);
    expect(serviceLabel({ AGENTNET_SERVICE_LABEL: "dev.agentnet.updtest" })).toBe("dev.agentnet.updtest");
    expect(serviceUnit({ AGENTNET_SERVICE_UNIT: "agentnet-test_2" })).toBe("agentnet-test_2");
    for (const bad of ["a b", "../x", "a/b", "x;y", "$(id)"]) {
      expect(() => serviceLabel({ AGENTNET_SERVICE_LABEL: bad })).toThrow("may only contain");
      expect(() => serviceUnit({ AGENTNET_SERVICE_UNIT: bad })).toThrow("may only contain");
    }
  });
  mac("a custom label is found by its own unit file, at the path launchctl reports", async () => {
    const home = tmp("an-h-"), repo = tmp("an-r-"), elsewhere = tmp("an-plist-");
    const file = join(elsewhere, "x.plist");
    writeFileSync(file, `<dict><key>WorkingDirectory</key>\n<string>${repo}</string><key>EnvironmentVariables</key><dict><key>AGENTNET_PORT</key>\n<string>3299</string></dict></dict>`);
    const seen: string[][] = [];
    const run: Sh = (cmd) => { seen.push(cmd); return { code: 0, out: `gui/501/dev.agentnet.updtest = {\n\tpath = ${file}\n\tpid = 4242\n}` }; };
    process.env.AGENTNET_SERVICE_LABEL = "dev.agentnet.updtest";
    try {
      expect(await detectMode({ repo, host: "127.0.0.1", port: 3299, home }, 4242, run)).toBe("launchd");
      expect(seen[0]!.at(-1)).toMatch(/^gui\/\d+\/dev\.agentnet\.updtest$/);
      // same unit, but it belongs to another repo or port: never ours
      expect(await detectMode({ repo: tmp("an-r2-"), host: "127.0.0.1", port: 3299, home }, 4242, run)).toBe("unknown");
      expect(await detectMode({ repo, host: "127.0.0.1", port: 59995, home }, 4242, run)).toBe("unknown");
      const k: string[][] = [];
      await restart("launchd", (c) => { k.push(c); return { code: 0, out: "" }; });
      expect(k[0]!.at(-1)).toMatch(/\/dev\.agentnet\.updtest$/);
    } finally { delete process.env.AGENTNET_SERVICE_LABEL; }
  });
  mac("a bad label in the environment is not a service: no launchctl call, no restart of anything", async () => {
    const seen: string[][] = [];
    process.env.AGENTNET_SERVICE_LABEL = "../evil";
    try {
      expect(await detectMode({ repo: tmp("an-r-"), host: "127.0.0.1", port: 59996, home: tmp("an-h-") }, undefined, (c) => { seen.push(c); return { code: 0, out: "" }; })).toBe("unknown");
      expect(seen).toEqual([]);
      await expect(restart("launchd", () => ({ code: 0, out: "" }))).rejects.toThrow("may only contain");
    } finally { delete process.env.AGENTNET_SERVICE_LABEL; }
  });
});

describe("restart and health", () => {
  test("restart runs the manager command, refuses foreground", async () => {
    const seen: string[][] = [];
    await restart("launchd", (c) => { seen.push(c); return { code: 0, out: "" }; });
    await restart("systemd", (c) => { seen.push(c); return { code: 0, out: "" }; });
    expect(seen[0]!.slice(0, 3)).toEqual(["launchctl", "kickstart", "-k"]);
    expect(seen[1]).toEqual(["systemctl", "--user", "restart", SYSTEMD_UNIT]);
    await expect(restart("foreground")).rejects.toThrow("cannot restart");
    await expect(restart("launchd", () => ({ code: 5, out: "boom" }))).rejects.toThrow("boom");
  });
  test("waitHealth passes on the wanted version only", async () => {
    let v = "0.3.0";
    const f = fakeServer({ "GET /v1/health": () => json({ name: "agentnet", version: v }) });
    try {
      const c = { repo: "", host: "127.0.0.1", port: Number(new URL(f.url).port) };
      expect(await waitHealth(c, "0.4.0", 300, 50)).toBe(false);
      setTimeout(() => { v = "0.4.0"; }, 100);
      expect(await waitHealth(c, "0.4.0", 2000, 50)).toBe(true);
    } finally { f.stop(); }
  });
  test("listenerPid reads lsof output", () => {
    expect(listenerPid(1, () => ({ code: 0, out: "123\n456" }))).toBe(123);
    expect(listenerPid(1, () => ({ code: 1, out: "" }))).toBeUndefined();
  });
});
