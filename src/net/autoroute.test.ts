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
const { routeSpawn, RouteBlocked } = await import("./autoroute");

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

test("unknown role is left unrouted, not an error", async () => {
  usage(10);
  const r = await routeSpawn({ name: "zzz-1", model: "sonnet" });
  expect(r.model).toBe("sonnet"); expect(r.audit).toBeNull();
});
