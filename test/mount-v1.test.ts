// Step 7 §3: /v1/panel/agent-import* and /v1/panel/accounts* reach the same handlers as their /api/v1 paths (through makeFetch).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-mount-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../src/core/db");
useDatabase(new Database(":memory:"));
{ const st = await import("../src/net/store"); st._reset(); st.ensureSchema(); } // a fresh DB gets the full agents schema, whatever ran before in this process
type Env = import("../src/core/http").Env;
const { tracing } = await import("../src/core/http");
const { importRoutes } = await import("../src/net/agent-import");
const { accountRoutes } = await import("../src/net/accounts");
const { makeFetch } = await import("../src/server");

const app = new Hono<Env>(); app.use("*", tracing);
const api = new Hono<Env>();
api.use("*", async (c, next) => { c.set("auth", "token" as never); await next(); }); // the root token: rootOnly passes
importRoutes(api); accountRoutes(api);
app.route("/api/v1", api);
const fetch = makeFetch(app);
const get = async (path: string, method = "GET") => { const r = await fetch(new Request(`http://127.0.0.1${path}`, { method })); const body = await r.json().catch(() => null) as Record<string, unknown> | null; if (body) delete body.trace_id; return { status: r.status, body } as const; }; // trace ids differ per request

test("mount: /v1/agent-import and /v1/accounts reach the same handlers", async () => {
  for (const [v1, legacy] of [["/v1/panel/agent-import", "/api/v1/agent-import"], ["/v1/panel/agent-import/proposal", "/api/v1/agent-import/proposal"], ["/v1/panel/accounts", "/api/v1/accounts"]]) {
    const a = await get(v1!), b = await get(legacy!);
    expect(b.body, legacy).not.toBeNull(); // a JSON answer from the handler, not Hono's plain-text miss
    expect(a, v1).toEqual(b);
  }
  expect((await get("/v1/panel/accounts")).body).toHaveProperty("accounts");
  expect((await get("/v1/panel/agent-import/nope")).status).toBe(404);
});
