import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LAN, LOOP } from "../../test/helpers";
import type { Env } from "../core/http";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-ars-home-"));

const dir = mkdtempSync(join(tmpdir(), "arsenal-"));
beforeAll(() => {
  process.env.AGENTNET_ARSENAL_DIR = dir; process.env.AGENTNET_SOUL_LOG = join(dir, "log.jsonl");
  mkdirSync(join(dir, "r"));
  writeFileSync(join(dir, "r", "a.md"), "---\nname: a\n---\nBe A.");
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ generated: "x", agents: [
    { id: "r/a", name: "a", repo: "o/r", path: "r/a.md", stars: 5, licence: "MIT", category: "frontend", description: "d", tools: [], tags: [] },
    { id: "r/evil", name: "e", repo: "o/r", path: "../outside.md", stars: 1, licence: "MIT", category: "qa", description: "d", tools: [], tags: [] }] }));
  writeFileSync(join(dir, "roles.json"), JSON.stringify({ roles: { "web-dev": { default: "r/a" } } }));
  writeFileSync(join(dir, "log.jsonl"), JSON.stringify({ ts: "t", soul: "r/a", role: "web-dev", score: 4, kw: 0, reason: "role default" }) + "\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function app() {
  const { arsenalRoutes } = await import("./arsenal");
  const a = new Hono<Env>(), api = new Hono<Env>();
  arsenalRoutes(api); a.route("/api/v1", api); return a;
}
test("lists catalog, roles and decisions", async () => {
  const j = await (await (await app()).request("/api/v1/arsenal", {}, LAN)).json() as any;
  expect(j.agents.length).toBe(2); expect(j.roles["web-dev"].default).toBe("r/a"); expect(j.decisions[0].soul).toBe("r/a");
});
test("persona body, and no path escape", async () => {
  const a = await app();
  expect(((await (await a.request("/api/v1/arsenal/agent?id=r/a", {}, LAN)).json()) as any).body).toContain("Be A.");
  expect((await a.request("/api/v1/arsenal/agent?id=r/evil", {}, LAN)).status).toBe(404);
});
test("roles save checks ids, needs admin, backs up", async () => {
  const body = (r: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r) });
  expect((await (await app()).request("/api/v1/arsenal/roles", body({ roles: {} }), LAN)).status).toBe(403);
  const a = await app();
  expect((await a.request("/api/v1/arsenal/roles", body({ roles: { qa: { default: "nope" } } }), LOOP)).status).toBe(400);
  expect((await a.request("/api/v1/arsenal/roles", body({ roles: { qa: { default: "r/a", categories: ["qa"] } } }), LOOP)).status).toBe(200);
  expect(JSON.parse(readFileSync(join(dir, "roles.json"), "utf8")).roles.qa.default).toBe("r/a");
  expect(readFileSync(join(dir, "roles.json.bak-agentnet"), "utf8")).toContain("web-dev");
});

test("roles write: forwarded caller gets 403, loopback 200", async () => {
  const body = (h: Record<string, string>) => ({ method: "PUT", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify({ roles: { ui: { default: "r/a" } } }) });
  const a = await app();
  expect((await a.request("/api/v1/arsenal/roles", body({ "X-Forwarded-For": "10.0.0.5" }), LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/arsenal/roles", body({}), LOOP)).status).toBe(200);
});

test("default arsenal is the catalogue shipped in the repo, and every entry's persona file exists", async () => {
  const saved = process.env.AGENTNET_ARSENAL_DIR, saved2 = process.env.ARSENAL_DIR;
  delete process.env.AGENTNET_ARSENAL_DIR; delete process.env.ARSENAL_DIR;
  try {
    const { loadCatalog, personaOf } = await import("./arsenal");
    const c = loadCatalog();
    expect(c.agents.length).toBeGreaterThan(400);
    for (const e of c.agents) expect(personaOf(e.id)?.body.length ?? 0).toBeGreaterThan(0);
  } finally { if (saved !== undefined) process.env.AGENTNET_ARSENAL_DIR = saved; if (saved2 !== undefined) process.env.ARSENAL_DIR = saved2; }
});
