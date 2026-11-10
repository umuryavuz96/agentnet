import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-mount-"));
const { V1_PATHS, toLegacy } = await import("../src/net/mount");
const { agentPath } = await import("../src/net/routes");

const sample = (p: string) => p.replace("{id}", p.startsWith("/v1/agent/tasks") || p.includes("/checks/") ? "3" : "t-1").replace("{name}", "a-1").replace("{tid}", "3").replace("{op}", "start");
describe("toLegacy", () => {
  test("every v1 path maps to an agent or panel route", () => {
    for (const p of V1_PATHS.filter((x) => x !== "/v1/health")) {
      const l = toLegacy(sample(p));
      expect(l, p).not.toBeNull();
      const bare = l!.replace(/^\/api\/v1/, "");
      const panel = /^\/(agentnet\/(snapshot|stream|usage|scores|discipline|summary|windows\/close-all|agents\/[a-z0-9-]+\/(score|tasks|message|open|close|schedules|stop|despawn|run-schedule|prompt|feed))|agentnet-panel\/(teams.*|checks(\/\d+\/resolve)?)|trails\/(search|stats)|bgjobs(\/[A-Za-z0-9._-]+(\/file)?)?|arsenal(\/(agent|roles))?|agent-routing|agent-compact|agent-hooks(\/.*)?|agent-update(\/.*)?|agent-director(\/(start|move|pick-folder|reset))?)$/.test(bare);
      expect(agentPath(l!) || panel, `${p} -> ${l}`).toBe(true);
    }
  });
  test("spawn lives only under admin", () => { expect(toLegacy("/v1/agent/spawn")).toBeNull(); });
  test("health is served directly", () => { expect(toLegacy("/v1/health")).toBeNull(); });
});

describe("toLegacy: phase 5b panel paths", () => {
  const cases: [string, string | null][] = [
    ["/v1/panel/summary", "/api/v1/agentnet/summary"], ["/v1/panel/bgjobs", "/api/v1/bgjobs"], ["/v1/panel/bgjobs/j-1.a", "/api/v1/bgjobs/j-1.a"],
    ["/v1/panel/bgjobs/j1/file", "/api/v1/bgjobs/j1/file"], ["/v1/panel/arsenal", "/api/v1/arsenal"], ["/v1/panel/arsenal/agent", "/api/v1/arsenal/agent"],
    ["/v1/panel/arsenal/roles", "/api/v1/arsenal/roles"], ["/v1/panel/routing", "/api/v1/agent-routing"], ["/v1/panel/compact", "/api/v1/agent-compact"], ["/v1/panel/hooks", "/api/v1/agent-hooks"],
    ["/v1/panel/hooks/nodes", "/api/v1/agent-hooks/nodes"], ["/v1/panel/hooks/stream", "/api/v1/agent-hooks/stream"], ["/v1/panel/hooks/fires", "/api/v1/agent-hooks/fires"],
    ["/v1/panel/hooks/ab12cd/enabled", "/api/v1/agent-hooks/ab12cd/enabled"], ["/v1/panel/hooks/rollback", "/api/v1/agent-hooks/rollback"],
    ["/v1/panel/bgjobs/../x", null], ["/v1/panel/arsenal/other", null],
  ];
  for (const [from, to] of cases) test(from, () => { expect(toLegacy(from)).toBe(to); });
  test("isPanelWrite covers PUT and the moved write paths", async () => {
    const { isPanelWrite } = await import("../src/net/mount");
    expect(isPanelWrite("PUT", "/api/v1/arsenal/roles")).toBe(true); expect(isPanelWrite("PUT", "/api/v1/agent-routing")).toBe(true);
    expect(isPanelWrite("POST", "/api/v1/agent-hooks/rollback")).toBe(true); expect(isPanelWrite("GET", "/api/v1/agent-routing")).toBe(false);
  });
});
