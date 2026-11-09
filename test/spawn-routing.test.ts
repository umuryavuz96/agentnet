import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "an-sr-"));
process.env.AGENTNET_HOME = home;
const ENV = ["AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE"]; // set per test file: bun shares one process, so undo it after
beforeAll(() => { process.env.AGENTNET_USAGE_FILE = join(home, "usage.json"); process.env.USAGE_GUARD_FILE = join(home, "none"); process.env.USAGE_OVERRIDE_FILE = join(home, "none2"); });
afterAll(() => { for (const k of ENV) delete process.env[k]; });
const usage = (pct: number) => writeFileSync(join(home, "usage.json"), JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: [{ key: "five_hour", pct, resetsAt: null, hours: 5 }] } }));
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown) => f(new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), LOOP);

test("spawn without model/soul routes, replies with the audit line and keeps it on the record", async () => {
  usage(10);
  const r = await call("/v1/admin/spawn", { name: "backend-9", job: "check a typo" });
  expect(r.status).toBe(201);
  const j = await r.json() as { model: string; effort: string; audit: string };
  expect(j.model).toBeTruthy(); expect(j.audit).toContain(`model=${j.model}`);
  const a = await (await call("/v1/agent/agents/backend-9")).json() as { agent: { model: string; effort: string; audit: string } };
  expect(a.agent.model).toBe(j.model); expect(a.agent.effort).toBe(j.effort); expect(a.agent.audit).toBe(j.audit);
});

test("explicit model wins over the pick", async () => {
  usage(10);
  const j = await (await call("/v1/admin/spawn", { name: "backend-8", model: "haiku" })).json() as { model: string };
  expect(j.model).toBe("haiku");
});

test("reserve mode refuses with 409 and creates no agent", async () => {
  usage(95);
  const r = await call("/v1/admin/spawn", { name: "backend-7" });
  expect(r.status).toBe(409); expect(JSON.stringify(await r.json())).toContain("reserve");
  expect((await call("/v1/agent/agents/backend-7")).status).toBe(404);
});

test("members are not routed", async () => {
  usage(95);
  const r = await call("/v1/admin/spawn", { name: "backend-6", kind: "member" });
  expect(r.status).toBe(201); expect((await r.json() as { audit: unknown }).audit).toBeNull();
});
