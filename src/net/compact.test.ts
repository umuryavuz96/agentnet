import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const c = await import("./compact");
beforeEach(() => { process.env.AGENTNET_SPAWN_FILE = join(mkdtempSync(join(tmpdir(), "compact-")), "spawn.json"); });

describe("compact window", () => {
  test("normWindow accepts k, m and plain numbers inside 100k..1000k", () => {
    expect(c.normWindow("300k")).toBe("300k"); expect(c.normWindow("1m")).toBe("1000k"); expect(c.normWindow(200000)).toBe("200k");
    for (const bad of ["50k", "2m", "abc", "", null, "-5k"]) expect(c.normWindow(bad)).toBeNull();
    expect(c.windowTokens("300k")).toBe(300_000);
  });
  test("no file = 300k default; role override beats default; role = name without -N", () => {
    expect(c.compactFor("backend-1")).toBe("300k");
    c.saveCompact({ default: "250k", roles: { backend: "200k" } });
    expect(c.compactFor("backend-3")).toBe("200k"); expect(c.compactFor("web-dev-1")).toBe("250k"); expect(c.roleOf("mcp-architect-12")).toBe("mcp-architect");
  });
  test("save keeps roles when only default changes; rejects bad values", () => {
    c.saveCompact({ default: "300k", roles: { qa: "150k" } });
    expect(c.saveCompact({ default: "400k" })).toEqual({ default: "400k", roles: { qa: "150k" } });
    expect(() => c.saveCompact({ default: "5k" })).toThrow(); expect(() => c.saveCompact({ roles: { "Bad Role": "200k" } })).toThrow(); expect(() => c.saveCompact({ roles: { qa: "9m" } })).toThrow();
  });
  test("PUT is root only (not from a LAN address) and GET returns bounds", async () => {
    const api = new Hono<any>(); c.compactRoutes(api);
    const g = await (await api.request("/agent-compact")).json() as any;
    expect(g.default).toBe("300k"); expect(g.min).toBe("100k"); expect(g.max).toBe("1000k");
    const bad = await api.request("/agent-compact", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ default: "1k" }) });
    expect([400, 403]).toContain(bad.status);
  });
});
