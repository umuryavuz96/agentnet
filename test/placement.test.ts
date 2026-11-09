import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "an-pl-"));
process.env.AGENTNET_HOME = home;
const ENV = ["AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE"]; // bun shares one process across test files: undo after
beforeAll(() => {
  process.env.AGENTNET_USAGE_FILE = join(home, "usage.json"); process.env.USAGE_GUARD_FILE = join(home, "none"); process.env.USAGE_OVERRIDE_FILE = join(home, "none2");
  writeFileSync(join(home, "usage.json"), JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: [{ key: "five_hour", pct: 10, resetsAt: null, hours: 5 }] } }));
});
afterAll(() => { for (const k of ENV) delete process.env[k]; });
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown, method = body ? "POST" : "GET") => f(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), LOOP);
const plan = async (b: unknown) => ((await (await call("/v1/admin/plan-spawn", b)).json()) as { plan: any }).plan;
const agents = async () => ((await (await call("/v1/agent/agents?all=1")).json()) as { agents: { name: string }[] }).agents.map((a) => a.name);
const logLines = () => (existsSync(join(home, "logs", "model-routing.jsonl")) ? Bun.file(join(home, "logs", "model-routing.jsonl")).text() : Promise.resolve(""));

test("plan_spawn has no side effects: no agent, no team, no routing log line", async () => {
  const before = (await agents()).length, log = await logLines();
  const p = await plan({ job: "build an api endpoint", project: "/tmp/proj-a", role: "backend" });
  expect(p.name).toBe("backend-1"); expect(p.team).toBeNull(); expect(p.boss).toBe("root");
  expect((await agents()).length).toBe(before); expect(await logLines()).toBe(log);
  expect((await (await call("/v1/agent/teams")).json() as { teams: unknown[] }).teams.length).toBe(0);
  expect(p.model).toBeTruthy(); expect(p.compactWindow).toBe(300000); expect(p.reasons.join("\n")).toContain("no team");
});

test("naming picks the next free N", async () => {
  expect((await call("/v1/admin/spawn", { name: "backend-1", job: "x", project: "/tmp/proj-a" })).status).toBe(201);
  expect((await call("/v1/admin/spawn", { name: "backend-2", job: "x", project: "/tmp/other" })).status).toBe(201);
  expect((await plan({ job: "x", role: "backend", project: "/tmp/none" })).name).toBe("backend-3");
});

test("role is inferred from whole job words; the reason names them", async () => {
  const doc = await plan({ job: "fix a typo in agentnet README", project: "/tmp/none" });
  expect(doc.role).toBe("doc"); expect(doc.name).toBe("doc-1"); expect(doc.reasons[0]).toBe('role doc: job words "readme", "typo"');
  expect((await plan({ job: "verify the checkout flow with a screenshot", project: "/tmp/none" })).role).toBe("qa");
  const ui = await plan({ job: "fix the css on the settings page", project: "/tmp/none" });
  expect(ui.role).toBe("web-dev"); expect(ui.reasons[0]).toContain('"css"');
});

test("role inference: whole words only, tie goes to list order, no match = default_role", async () => {
  expect((await plan({ job: "apis and servers", project: "/tmp/none" })).role).toBe("backend"); // no whole-word hit: default
  expect((await plan({ job: "apis and servers", project: "/tmp/none" })).reasons[0]).toContain("the default");
  expect((await plan({ job: "write the docs for the api", project: "/tmp/none" })).role).toBe("doc"); // doc and backend tie at 1: doc is earlier
});

test("role keywords are editable in placement.json", async () => {
  writeFileSync(join(home, "config-placement2.json"), JSON.stringify({ default_role: "lookup", role_keywords: { qa: ["smoke"] } }));
  process.env.AGENTNET_PLACEMENT_FILE = join(home, "config-placement2.json");
  try {
    expect((await plan({ job: "run a smoke run", project: "/tmp/none" })).role).toBe("qa");
    expect((await plan({ job: "screenshot it", project: "/tmp/none" })).role).toBe("lookup"); // qa's list was replaced
  } finally { delete process.env.AGENTNET_PLACEMENT_FILE; }
});

test("a second agent on the same project proposes a team with no lead; spawn creates it with both members, boss root", async () => {
  const p = await plan({ job: "write tests", role: "qa", project: "/tmp/proj-a" });
  expect(p.team).toMatchObject({ id: "proj-a-dev", action: "create", lead: null }); expect(p.boss).toBe("root");
  const r = await call("/v1/admin/spawn", { job: "write tests", role: "qa", project: "/tmp/proj-a" });
  expect(r.status).toBe(201);
  const j = await r.json() as { name: string; boss: string; team: string };
  expect(j).toMatchObject({ name: "qa-1", boss: "root", team: "proj-a-dev" });
  const t = await (await call("/v1/agent/teams/proj-a-dev")).json() as { team: { lead: string; members: string[]; project: string } };
  expect(t.team.members.sort()).toEqual(["backend-1", "qa-1"]); expect(t.team.project).toBe("/tmp/proj-a");
});

test("an existing team on the project is joined; with no lead the boss stays root", async () => {
  const p = await plan({ job: "review", role: "reviewer", project: "/tmp/proj-a/" });
  expect(p.team).toMatchObject({ id: "proj-a-dev", action: "join" }); expect(p.boss).toBe("root");
  const j = await (await call("/v1/admin/spawn", { job: "review", role: "reviewer", project: "/tmp/proj-a" })).json() as { name: string; team: string };
  expect(j.team).toBe("proj-a-dev");
  const t = await (await call("/v1/agent/teams/proj-a-dev")).json() as { team: { members: string[] } };
  expect(t.team.members).toContain(j.name);
});

test("explicit inputs win and the reasons say so", async () => {
  const p = await plan({ job: "x", name: "lookup-7", boss: "root", model: "haiku", soul: "my/soul", project: "/tmp/proj-a" });
  expect(p).toMatchObject({ name: "lookup-7", boss: "root", model: "haiku", soul: "my/soul" }); // auto team has no lead: explicit boss holds
  const r = p.reasons.join("\n");
  expect(r).toContain("name lookup-7: explicit"); expect(r).toContain("boss root: explicit"); expect(r).not.toContain("overrides explicit"); expect(r).toContain("model haiku: explicit"); expect(r).toContain("soul my/soul: explicit");
});

test("team-by-project off: no team", async () => {
  writeFileSync(join(home, "config-placement.json"), JSON.stringify({ team_by_project: false }));
  process.env.AGENTNET_PLACEMENT_FILE = join(home, "config-placement.json");
  try { const p = await plan({ job: "x", role: "qa", project: "/tmp/proj-a" }); expect(p.team).toBeNull(); expect(p.boss).toBe("root"); expect(p.reasons.join("\n")).toContain("team-by-project is off"); }
  finally { delete process.env.AGENTNET_PLACEMENT_FILE; }
});

test("plan_spawn needs a job and is root only", async () => {
  expect((await call("/v1/admin/plan-spawn", { project: "/tmp/x" })).status).toBe(422);
  expect((await call("/v1/admin/plan-spawn?job=fix%20a%20typo&role=lookup")).status).toBe(200);
});
