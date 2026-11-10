import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

const home = mkdtempSync(join(tmpdir(), "an-wss-"));
const repo = join(home, "harbor", "ios");
const ENV = ["AGENTNET_HOME", "AGENTNET_WORKSPACE_DIR", "AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE"];
const old: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AGENTNET_HOME = home;
beforeAll(() => {
  process.env.AGENTNET_WORKSPACE_DIR = join(home, "workspace");
  process.env.AGENTNET_USAGE_FILE = join(home, "usage.json"); process.env.USAGE_GUARD_FILE = join(home, "none"); process.env.USAGE_OVERRIDE_FILE = join(home, "none2");
  writeFileSync(join(home, "usage.json"), JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: [{ key: "five_hour", pct: 10, resetsAt: null, hours: 5 }] } }));
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "ios rules");
});
afterAll(() => { for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown) => f(new Request(`http://x${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), LOOP);
const plan = async (b: object) => (await (await call("/v1/admin/plan-spawn", b)).json() as { plan: { name: string; soul: string; project: string; reasons: string[] } }).plan;

test("role of a workspace soul starts in its repo with its soul", async () => {
  const { registerSouls } = await import("../src/net/workspace");
  registerSouls([{ repo, name: "ios", source: "claude-md" }], { runId: "run-9" });
  const p = await plan({ role: "ios", job: "fix the login screen" });
  expect(p).toMatchObject({ name: "ios-1", soul: "ws/ios", project: repo });
  expect(p.reasons).toContain("soul ws/ios: workspace soul from run run-9");
  expect(p.reasons).toContain(`project ${repo}: the soul's repo`);
});
test("an explicit soul or project wins", async () => {
  expect((await plan({ role: "ios", soul: "ws/other", job: "x" })).soul).toBe("ws/other");
  const other = join(home, "elsewhere"); mkdirSync(other);
  const p = await plan({ role: "ios", project: other, job: "x" });
  expect(p.project).toBe(other); expect(p.reasons.join()).not.toContain("the soul's repo");
});
test("project_default (script cwd fallback) does not block the workspace repo", async () => {
  const p = await plan({ role: "ios", project: home, project_default: true, job: "x" });
  expect(p).toMatchObject({ soul: "ws/ios", project: repo });
});
test("spawn stores the repo as the agent project and returns it", async () => {
  const r = await call("/v1/admin/spawn", { role: "ios", job: "fix it", goal: "login screen fixed and tested", project: home, project_default: true });
  expect(r.status).toBe(201);
  const j = await r.json() as { name: string; soul: string; project: string };
  expect(j).toMatchObject({ name: "ios-1", soul: "ws/ios", project: repo });
  const a = await (await call(`/v1/agent/agents/${j.name}`)).json() as { agent: { project: string } };
  expect(a.agent.project).toBe(repo);
});
