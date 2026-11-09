import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { LAN, LOOP } from "../../test/helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-routing-home-"));
const int = (value: number, min: number, max: number) => ({ value, type: "int", min, max, description: "x" });
const cfg = {
  version: 1,
  points: { scope_step: int(1, 0, 5) },
  usage: { window: { value: "max", type: "enum", options: ["max", "five_hour", "seven_day"], description: "x" }, modes: { careful: { min_pct: int(60, 1, 89) }, eco: { min_pct: int(80, 1, 89) }, reserve: { min_pct: int(90, 90, 100) } } },
};
let d = "";
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "routing-"));
  process.env.AGENTNET_ROUTING_FILE = join(d, "model-routing.json"); process.env.AGENTNET_USAGE_FILE = join(d, "none.json");
  process.env.USAGE_GUARD_FILE = join(d, "none2.json"); process.env.USAGE_OVERRIDE_FILE = join(d, "none3"); process.env.AGENTNET_ROUTING_LOG = join(d, "log.jsonl");
  writeFileSync(process.env.AGENTNET_ROUTING_FILE, JSON.stringify(cfg, null, 2));
});
afterEach(() => {
  for (const k of ["AGENTNET_ROUTING_FILE", "AGENTNET_USAGE_FILE", "USAGE_GUARD_FILE", "USAGE_OVERRIDE_FILE", "AGENTNET_ROUTING_LOG"]) delete process.env[k];
  rmSync(d, { recursive: true, force: true });
});

async function app() {
  const { routingRoutes } = await import("./routing");
  const api = new Hono<Env>(); routingRoutes(api); const a = new Hono<Env>(); a.route("/api/v1", api); return a;
}
const put = (changes: unknown, headers: Record<string, string> = {}) => ({ method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ changes }) });

test("read: fields, mode normal, usage unknown without a usage file", async () => {
  const j = await (await (await app()).request("/api/v1/agent-routing", {}, LAN)).json() as { fields: { path: string }[]; mode: { mode: string; windows: unknown[] }; error: string | null };
  expect(j.error).toBeNull();
  expect(j.fields.map((f) => f.path)).toContain("usage.modes.eco.min_pct");
  expect(j.mode.mode).toBe("normal"); expect(j.mode.windows).toEqual([]);
});
test("write: needs root, validates, backs up", async () => {
  const a = await app();
  expect((await a.request("/api/v1/agent-routing", put({}, { "X-Forwarded-For": "10.0.0.5" }), LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-routing", put({ "usage.modes.eco.min_pct": 70 }), LAN)).status).toBe(403);
  expect((await a.request("/api/v1/agent-routing", put({ "usage.modes.reserve.min_pct": 85 }), LOOP)).status).toBe(400);
  expect((await a.request("/api/v1/agent-routing", put({ "usage.modes.eco.min_pct": 50 }), LOOP)).status).toBe(400); // careful < eco must hold
  expect((await a.request("/api/v1/agent-routing", put({ "usage.modes.eco.min_pct": 70 }), LOOP)).status).toBe(200);
  expect(JSON.parse(readFileSync(process.env.AGENTNET_ROUTING_FILE!, "utf8")).usage.modes.eco.min_pct.value).toBe(70);
  expect(readdirSync(d).some((n) => n.includes(".bak-agentnet-"))).toBe(true);
});
test("a missing config answers with an error field, not a crash", async () => {
  rmSync(process.env.AGENTNET_ROUTING_FILE!);
  const j = await (await (await app()).request("/api/v1/agent-routing", {}, LAN)).json() as { error: string | null; fields: unknown[] };
  expect(j.error).not.toBeNull(); expect(j.fields).toEqual([]);
});
