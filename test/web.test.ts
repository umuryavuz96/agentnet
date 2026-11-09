import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-web-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../src/core/db");
const st = await import("../src/net/store");
const { buildApp, makeFetch } = await import("../src/server");
const { LOOP, LAN } = await import("./helpers");

const dist = mkdtempSync(join(tmpdir(), "an-dist-")), empty = mkdtempSync(join(tmpdir(), "an-empty-"));
beforeAll(() => {
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<!doctype html><div id="app"></div>');
  writeFileSync(join(dist, "assets", "a.js"), "export {}");
  useDatabase(new Database(":memory:")); st._reset();
});
afterAll(() => { rmSync(dist, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); delete process.env.AGENTNET_WEB_DIR; });

describe("web app serving", () => {
  test("index, assets, SPA fallback, refusals", async () => {
    process.env.AGENTNET_WEB_DIR = dist;
    const app = buildApp();
    const r = await app.request("/", {}, LOOP);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const a = await app.request("/assets/a.js", {}, LOOP);
    expect(a.headers.get("content-type")).toBe("text/javascript");
    expect(a.headers.get("cache-control")).toContain("immutable");
    expect(await (await app.request("/teams", {}, LOOP)).text()).toContain('id="app"');
    expect((await app.request("/assets/..%2Fx", {}, LOOP)).status).toBe(404);
    expect((await app.request("/assets/nope.js", {}, LOOP)).status).toBe(404);
    for (const p of ["/v1/nope", "/api/v1/nope"]) { const n = await app.request(p, {}, LOOP); expect(n.status, p).toBe(404); expect(n.headers.get("content-type")).toContain("problem"); }
  });
  test("an unbuilt dist answers 503", async () => {
    process.env.AGENTNET_WEB_DIR = empty;
    expect((await buildApp().request("/", {}, LOOP)).status).toBe(503);
  });
});

describe("panel summary", () => {
  test("counts live, working and blocked; a gone agent is not counted", async () => {
    useDatabase(new Database(":memory:")); st._reset();
    const T = Date.now();
    for (const [id, name] of [["w#1", "w"], ["b#1", "b"], ["g#1", "g"]]) st.emit({ agent: id, type: "AgentSpawned", ts: T, data: { id, name }, source: "spawn" });
    st.emit({ agent: "w#1", type: "ActivityReconciled", ts: T + 1, data: { state: "working" }, source: "reconcile" });
    st.emit({ agent: "b#1", type: "ActivityReconciled", ts: T + 1, data: { state: "blocked" }, source: "reconcile" });
    st.emit({ agent: "g#1", type: "AgentGone", ts: T + 1, data: { reason: "test" }, source: "service" });
    st.flush();
    const r = await makeFetch(buildApp())(new Request("http://localhost/v1/panel/summary"), LAN) as Response; // through the v1 rewrite
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ live: 2, working: 1, blocked: 1 });
  });
});
