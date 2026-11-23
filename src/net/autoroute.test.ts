import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let d = "";
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "autoroute-"));
  process.env.AGENTNET_HOME = d;
  process.env.AGENTNET_USAGE_FILE = join(d, "usage.json"); process.env.USAGE_GUARD_FILE = join(d, "none"); process.env.USAGE_OVERRIDE_FILE = join(d, "none2");
});
afterEach(() => { for (const k of ["AGENTNET_HOME", "AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE"]) delete process.env[k]; rmSync(d, { recursive: true, force: true }); });
const usage = (pct: number) => writeFileSync(join(d, "usage.json"), JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: [{ key: "five_hour", pct, resetsAt: null, hours: 5 }] } }));
const { routeSpawn, RouteBlocked, roleCandidates } = await import("./autoroute");

test("defaults 2/2/1 pick model, effort and audit line", async () => {
  usage(10);
  const r = await routeSpawn({ name: "backend-1", job: "check a typo" });
  expect(r.model).toBeTruthy(); expect(r.effort).toBeTruthy();
  expect(r.audit).toMatch(/^mode=normal model=\w+ effort=\w+ score=\d+ usage=10 reason=scope2 nov2 risk1 backend\+0/);
});

test("scope, novelty, risk and ask change the pick", async () => {
  usage(10);
  const lo = await routeSpawn({ name: "backend-1", scope: 1, novelty: 1, risk: 0, ask: "quick" });
  const hi = await routeSpawn({ name: "backend-1", scope: 5, novelty: 3, risk: 2, ask: "proper job" });
  expect(lo.audit).toContain("score=-2"); expect(hi.audit).toMatch(/score=\d{2}/);
  expect(lo.model).not.toBe(hi.model);
});

test("explicit model and effort win, and the audit says so", async () => {
  usage(10);
  const r = await routeSpawn({ name: "backend-1", model: "opus", effort: "max" });
  expect(r.model).toBe("opus"); expect(r.effort).toBe("max"); expect(r.audit).toContain("explicit:opus");
});

test("an explicit full model id is kept untouched", async () => {
  usage(10);
  expect((await routeSpawn({ name: "backend-1", model: "claude-opus-5-5" })).model).toBe("claude-opus-5-5");
});

test("explicit soul is kept; the soul line is skipped", async () => {
  usage(10);
  const r = await routeSpawn({ name: "backend-1", soul: "my/soul" });
  expect(r.soul).toBe("my/soul"); expect(r.audit).not.toContain("soul=");
});

test("reserve mode refuses, even with an explicit model", async () => {
  usage(95);
  await expect(routeSpawn({ name: "backend-1" })).rejects.toBeInstanceOf(RouteBlocked);
  await expect(routeSpawn({ name: "backend-1", model: "opus" })).rejects.toThrow(/reserve/);
});

test("role candidates: name, trailing dash parts dropped, the brain's role, then the default", () => {
  expect(roleCandidates("web-dev-brains-1", "web-dev")).toEqual(["web-dev-brains-1", "web-dev", "web", "researcher"]);
  expect(roleCandidates("house-mcp-1", "backend")).toEqual(["house-mcp-1", "house", "backend", "researcher"]);
  expect(roleCandidates("merge-color-3", "ios-dev")).toEqual(["merge-color-3", "merge", "mobile-dev", "researcher"]);
  expect(roleCandidates("backend-1")).toEqual(["backend-1", "researcher"]); // pick-model.sh drops the -1 itself
});

test("a name that is no role is routed by its stripped name, else its brain, else the default role (never left on the default model)", async () => {
  usage(85); // eco (default trigger 80)
  const stripped = await routeSpawn({ name: "web-dev-brains-1", brainName: "web-dev" });
  expect(stripped.audit).toMatch(/^mode=eco model=sonnet .* web-dev\+0/);
  const byBrain = await routeSpawn({ name: "house-mcp-1", brainName: "backend" });
  expect(byBrain.audit).toMatch(/^mode=eco model=sonnet .* backend\+0/);
  const mapped = await routeSpawn({ name: "merge-color-3", brainName: "motion" });
  expect(mapped.audit).toContain("designer+");
  const dflt = await routeSpawn({ name: "zzz-1" });
  expect(dflt.audit).toContain("researcher-1"); expect(dflt.model).toBeTruthy();
});
