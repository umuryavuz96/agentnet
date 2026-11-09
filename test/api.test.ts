import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAN, LOOP } from "./helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-api-"));
const { buildApp, makeFetch } = await import("../src/server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const req = (path: string, env: unknown, init: RequestInit & { token?: string } = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  return f(new Request(`http://x${path}`, { method: init.method ?? "GET", headers, body: init.body }), env);
};
const post = (path: string, env: unknown, body: unknown, token?: string) => req(path, env, { method: "POST", body: JSON.stringify(body), token });
let tok1 = "";

describe("v1 api", () => {
  test("1 spawn from loopback without token is root", async () => {
    const r = await post("/v1/admin/spawn", LOOP, { name: "a-1" });
    expect(r.status).toBe(201);
    tok1 = (await Bun.file(((await r.json()) as { token_file: string }).token_file).text()).trim();
  });
  test("2 same from LAN is 401", async () => { expect((await post("/v1/admin/spawn", LAN, { name: "a-3" })).status).toBe(401); });
  test("3 non-root token is 403", async () => { expect((await post("/v1/admin/spawn", LOOP, { name: "a-2" }, tok1)).status).toBe(403); });
  test("4 revoked token never becomes root", async () => {
    expect((await post("/v1/admin/despawn", LOOP, { agent: "a-1" })).status).toBe(200);
    const r = await post("/v1/agent/hello", LOOP, {}, tok1);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { detail: string }).detail).toBe("agentnet: revoked agent token");
  });
  test("5 health from LAN", async () => {
    const r = await req("/v1/health", LAN);
    expect(r.status).toBe(200);
    const b = await r.json() as { name: string; api: number; minClientApi: number; features: string[] };
    expect(b.name).toBe("agentnet"); expect(b.api).toBe(1); expect(b.minClientApi).toBe(1); expect(b.features).toContain("teams");
  });
  test("6 v1 and legacy agree", async () => {
    const a = await (await req("/v1/agent/agents", LOOP)).text(), b = await (await req("/api/v1/agentnet/agents", LOOP)).text();
    expect(a).toBe(b);
  });
  test("7 Agentnet-Api header everywhere", async () => {
    expect((await req("/v1/health", LAN)).headers.get("agentnet-api")).toBe("1");
    expect((await req("/v1/nope", LOOP)).headers.get("agentnet-api")).toBe("1");
    const s = await req("/v1/panel/stream", LOOP);
    expect(s.headers.get("agentnet-api")).toBe("1");
    await s.body?.cancel();
  });
  test("8 unknown v1 path is 404 problem", async () => {
    const r = await req("/v1/nope", LOOP);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
  });

  test("9 panel writes: LAN with no token is 403, loopback is 2xx", async () => {
    await post("/v1/admin/spawn", LOOP, { name: "p-1" });
    const writes: [string, unknown][] = [
      ["/v1/panel/agents/p-1/message", { body: "hi" }], ["/v1/panel/agents/p-1/open", {}], ["/v1/panel/agents/p-1/close", {}],
      ["/v1/panel/windows/close-all", {}], ["/v1/panel/teams", { name: "t" }], ["/v1/panel/teams/t/archive", {}],
      ["/v1/panel/teams/t/members", {}], ["/v1/panel/teams/t/messages", {}], ["/v1/panel/teams/t/tasks", {}], ["/v1/panel/teams/t/tasks/1/start", {}],
    ];
    for (const [p, b] of writes) expect((await post(p, LAN, b)).status, p).toBe(403);
    // loopback: only the writes that cannot touch the host's terminals
    expect((await post("/v1/panel/agents/p-1/message", LOOP, { body: "hi" })).status).toBeLessThan(300);
    expect((await post("/v1/panel/teams", LOOP, { name: "t-one" })).status).toBe(201);
  });
  test("10 panel reads stay open on the bound address and carry no token", async () => {
    const made = await (await post("/v1/admin/spawn", LOOP, { name: "p-2" })).json() as { token_file: string };
    const tok = (await Bun.file(made.token_file).text()).trim();
    for (const p of ["/v1/panel/snapshot", "/v1/panel/usage", "/v1/panel/scores", "/v1/panel/teams"]) {
      const r = await req(p, LAN);
      expect(r.status, p).toBe(200);
      const t = await r.text();
      expect(t).not.toContain(tok); expect(t).not.toContain(made.token_file);
    }
  });
  test("11 proxy headers cancel loopback root", async () => {
    for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "via"]) {
      const hdr = { "content-type": "application/json", [h]: "203.0.113.9" };
      const spawn = await f(new Request("http://x/v1/admin/spawn", { method: "POST", headers: hdr, body: JSON.stringify({ name: "px-1" }) }), LOOP);
      expect(spawn.status, h).toBe(401);
      const panel = await f(new Request("http://x/v1/panel/teams", { method: "POST", headers: hdr, body: JSON.stringify({ name: "px" }) }), LOOP);
      expect(panel.status, h).toBe(403);
    }
  });
  test("12 ?token= is never logged", async () => {
    const secret = "secret-query-token-0123456789";
    await f(new Request(`http://x/v1/agent/hello?token=${secret}`, { method: "POST", body: "{}" }), LAN); // 401: logged at info
    const { dir } = await import("../src/core/config");
    const { readFileSync, existsSync } = await import("node:fs");
    const log = join(dir("logs"), "agentnet.jsonl");
    expect(existsSync(log)).toBe(true);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("agentnet/hello"); // the request was logged
    expect(text).not.toContain(secret);
  });
});
