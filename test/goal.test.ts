import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "an-goal-"));
process.env.AGENTNET_HOME = home;
const ENV = ["AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE"];
beforeAll(() => { process.env.AGENTNET_USAGE_FILE = join(home, "usage.json"); process.env.USAGE_GUARD_FILE = join(home, "none"); process.env.USAGE_OVERRIDE_FILE = join(home, "none2"); writeFileSync(join(home, "usage.json"), JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: [{ key: "five_hour", pct: 10, resetsAt: null, hours: 5 }] } })); });
afterAll(() => { for (const k of ENV) delete process.env[k]; process.env.AGENTNET_REQUIRE_GOAL = "0"; }); // the test preload turns the rule off for other files
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown) => f(new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), LOOP);
const detail = async (r: Response) => JSON.stringify(await r.json());

test("spawn: goal missing or short is 422; a good goal is stored and shown", async () => {
  process.env.AGENTNET_REQUIRE_GOAL = "1";
  for (const goal of [undefined, "", "short"]) {
    const r = await call("/v1/admin/spawn", { name: "goal-1", job: "fix a typo", goal });
    expect(r.status).toBe(422); expect(await detail(r)).toContain("goal is required: what does done look like?");
  }
  expect((await call("/v1/agent/agents/goal-1")).status).toBe(404);
  const ok = await call("/v1/admin/spawn", { name: "goal-1", job: "fix a typo", goal: "typo fixed and committed" });
  expect(ok.status).toBe(201); expect((await ok.json() as { goal: string }).goal).toBe("typo fixed and committed");
  const a = await (await call("/v1/agent/agents/goal-1")).json() as { agent: { goal: string } };
  expect(a.agent.goal).toBe("typo fixed and committed");
});

test("spawn: channel-bot members are exempt", async () => {
  process.env.AGENTNET_REQUIRE_GOAL = "1";
  expect((await call("/v1/admin/spawn", { name: "bot-1", job: "channel bot", kind: "member" })).status).toBe(201);
});

test("team create: goal required, 422 without, stored with", async () => {
  process.env.AGENTNET_REQUIRE_GOAL = "1";
  const r = await call("/v1/agent/teams", { name: "Alpha" });
  expect(r.status).toBe(422); expect(await detail(r)).toContain("goal is required");
  const ok = await call("/v1/agent/teams", { name: "Alpha", goal: "alpha shipped and verified" });
  expect(ok.status).toBe(201); expect((await ok.json() as { team: { goal: string } }).team.goal).toBe("alpha shipped and verified");
});

test("spawn: the auto team inherits the agent goal", async () => {
  process.env.AGENTNET_REQUIRE_GOAL = "1";
  const r = await call("/v1/admin/spawn", { name: "goal-2", job: "build x", goal: "x built and tested", project: "/tmp/goalproj" });
  expect(r.status).toBe(201);
  const t = (await r.json() as { team: string | null }).team;
  if (t) expect(((await (await call(`/v1/agent/teams/${t}`)).json()) as { team: { goal: string } }).team.goal).toBe("x built and tested");
});

test("AGENTNET_REQUIRE_GOAL=0 lets old callers through", async () => {
  process.env.AGENTNET_REQUIRE_GOAL = "0";
  expect((await call("/v1/admin/spawn", { name: "old-1", job: "legacy caller" })).status).toBe(201);
  expect((await call("/v1/agent/teams", { name: "Legacy" })).status).toBe(201);
  const a = await (await call("/v1/agent/agents/old-1")).json() as { agent: { goal: string | null } };
  expect(a.agent.goal).toBeNull();
});

test("migration: the goal column is added to an old agents table, rows kept", async () => {
  const { Database } = await import("bun:sqlite"); const { useDatabase, db } = await import("../src/core/db"); const st = await import("../src/net/store");
  const old = new Database(":memory:");
  old.run("CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, gen INTEGER NOT NULL, job TEXT, boss TEXT, model TEXT, effort TEXT, soul TEXT, project TEXT, spawned_by TEXT, spawned_at INTEGER NOT NULL, token_hash TEXT UNIQUE, archived_at INTEGER, placement TEXT)");
  old.run("INSERT INTO agents (id, name, gen, spawned_at) VALUES ('a#1', 'a', 1, 1)");
  useDatabase(old); st._reset(); st.ensureSchema();
  expect((db().query("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name)).toContain("goal");
  expect((db().query("SELECT goal FROM agents WHERE id = 'a#1'").get() as { goal: string | null }).goal).toBeNull();
});
