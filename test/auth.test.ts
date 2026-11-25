// Step 1 auth (docs/internal/one-folder/SPEC-step1-auth.md): tokens everywhere, panel login, two house flags.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "./helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-auth-"));
delete process.env.AGENTNET_LOOPBACK_ROOT; delete process.env.AGENTNET_PANEL_LOGIN;
const { buildApp, makeFetch } = await import("../src/server");
const HOME = (await import("../src/core/config")).ROOT; // the home the server uses (fixed at first import in a full run)
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const f = makeFetch(buildApp());
const mode = (p: string) => statSync(join(HOME, p)).mode & 0o777;
const ROOT_T = readFileSync(join(HOME, "run/root.token"), "utf8").trim(), PANEL_T = readFileSync(join(HOME, "run/panel.token"), "utf8").trim();
const auth = await import("../src/core/auth");
type Init = { method?: string; token?: string; body?: unknown; headers?: Record<string, string> };
const req = (path: string, i: Init = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", host: "x", ...i.headers };
  if (i.token) headers.authorization = `Bearer ${i.token}`;
  return f(new Request(`http://x${path}`, { method: i.method ?? "GET", headers, body: i.body === undefined ? undefined : JSON.stringify(i.body), redirect: "manual" }), LOOP);
};
const HELLO = "/api/v1/agentnet/hello", SNAP = "/api/v1/agentnet/snapshot";
// Root proof: spawn is root-only (403 for an agent, 401 for nobody). hello itself is not a root call.
let n = 0;
const actsAsRoot = async (token?: string) => {
  const r = await req("/api/v1/agentnet/spawn", { method: "POST", body: { name: `auth-r-${++n}` }, token });
  expect(r.status).toBe(201);
  return r;
};
const newCode = async () => ((await (await req("/api/v1/login/code", { method: "POST", token: PANEL_T })).json()) as { code: string }).code;
const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];
let agentTok = "";

afterEach(() => { delete process.env.AGENTNET_LOOPBACK_ROOT; delete process.env.AGENTNET_PANEL_LOGIN; });

describe("auth", () => {
  test("12 run/ 0700, run/agentnet/ 0700, tokens 0600", () => {
    expect(mode("run")).toBe(0o700);
    expect(mode("run/agentnet")).toBe(0o700);
    expect(mode("run/root.token")).toBe(0o600);
    expect(mode("run/panel.token")).toBe(0o600);
    expect(ROOT_T).toMatch(/^[A-Za-z0-9_-]{43}$/);
    auth.ensureSecrets(); // never rewrites a token
    expect(readFileSync(join(HOME, "run/root.token"), "utf8").trim()).toBe(ROOT_T);
  });
  test("1 loopback, no token, agent route: 401", async () => { expect((await req(HELLO, { method: "POST", body: {} })).status).toBe(401); });
  test("2 loopback, unknown token, agent route: 401", async () => { expect((await req(HELLO, { method: "POST", body: {}, token: "nope-not-a-token" })).status).toBe(401); });
  test("3 loopback, no token, panel route: 401", async () => { expect((await req(SNAP)).status).toBe(401); });
  test("4 root.token on the agent route acts as root", async () => {
    const h = await req(HELLO, { method: "POST", body: {}, token: ROOT_T });
    expect(h.status).toBe(200); expect(((await h.json()) as { root: boolean }).root).toBe(true);
    const s = await actsAsRoot(ROOT_T);
    agentTok = readFileSync(((await s.json()) as { token_file: string }).token_file, "utf8").trim();
  });
  test("5 panel.token on a panel route: 200; root.token too", async () => {
    expect((await req(SNAP, { token: PANEL_T })).status).toBe(200);
    expect((await req(SNAP, { token: ROOT_T })).status).toBe(200);
    expect((await req(`${SNAP}?token=${PANEL_T}`)).status).toBe(200); // EventSource form
  });
  test("6 agent token on a root-only write: 403", async () => {
    expect(agentTok).not.toBe("");
    expect((await req("/api/v1/agentnet/spawn", { method: "POST", body: { name: "auth-x-1" }, token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/agent-routing", { method: "PUT", body: {}, token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/login/code", { method: "POST", token: agentTok })).status).toBe(403);
  });
  test("6b agent token is read-only on every panel route, not only the root-only list", async () => {
    // POST that is not on the isPanelWrite list, and a DELETE: both refused; a panel read still passes; the agent's own route still works
    expect((await req("/api/v1/agentnet/watch", { method: "POST", body: {}, token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/agent-hooks/x", { method: "DELETE", token: agentTok })).status).toBe(403);
    expect((await req(SNAP, { token: agentTok })).status).toBe(200);
    expect((await req("/api/v1/agentnet/inbox", { token: agentTok })).status).not.toBe(403);
  });
  test("6c an agent cannot speak as the owner: the owner prompt route refuses its token, nothing reaches the owner queue", async () => {
    const op = await import("../src/net/ownerPlugin"); op.ownerReset();
    process.env.AGENTNET_OWNER_VIA_PLUGIN = "1";
    try {
      for (const p of ["/api/v1/agentnet/agents/auth-r-1/prompt", "/api/v1/panel/agents/auth-r-1/prompt"]) {
        const r = await req(p, { method: "POST", body: { text: "as owner", via: "plugin" }, token: agentTok });
        expect(r.status).toBe(403);
      }
      // the agent's own send route takes no owner flag: whatever it passes, the target gets a normal delivery
      await req("/api/v1/agentnet/send", { method: "POST", body: { to: "root", body: "x", source: "owner" }, token: agentTok });
      expect(op.ownerHas("auth-r-1")).toBe(false); expect(op.ownerHas("root")).toBe(false);
    } finally { delete process.env.AGENTNET_OWNER_VIA_PLUGIN; }
  });
  test("7 login code: once, 302 + HttpOnly SameSite=Strict cookie; reuse and expiry 401", async () => {
    const code = await newCode();
    const r = await req(`/login?code=${code}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const sc = r.headers.get("set-cookie") ?? "";
    expect(sc).toContain("agentnet_session="); expect(sc).toContain("HttpOnly"); expect(sc).toContain("SameSite=Strict"); expect(sc).not.toContain("Secure");
    expect((await req(`/login?code=${code}`)).status).toBe(401);
    const old = auth.authClock.codeTtlMs; auth.authClock.codeTtlMs = -1;
    const stale = await newCode(); auth.authClock.codeTtlMs = old;
    expect((await req(`/login?code=${stale}`)).status).toBe(401);
    expect((await req("/login")).status).toBe(200);
    expect((await req("/login?code=x", { headers: { "x-forwarded-proto": "https" } })).status).toBe(401);
    const sec = await req(`/login?code=${await newCode()}`, { headers: { "x-forwarded-proto": "https" } });
    expect(sec.headers.get("set-cookie") ?? "").toContain("Secure");
  });
  test("8 cookie session reads a panel route; logout ends it", async () => {
    const ck = cookieOf(await req(`/login?code=${await newCode()}`));
    expect((await req(SNAP, { headers: { cookie: ck } })).status).toBe(200);
    expect((await req("/api/v1/logout", { method: "POST", headers: { cookie: ck, "sec-fetch-site": "same-origin" } })).status).toBe(204);
    expect((await req(SNAP, { headers: { cookie: ck } })).status).toBe(401);
  });
  test("9 cookie write: cross-site 403, same-origin passes", async () => {
    const ck = cookieOf(await req(`/login?code=${await newCode()}`));
    const W = "/api/v1/agentnet-panel/teams";
    expect((await req(W, { method: "POST", body: {}, headers: { cookie: ck, "sec-fetch-site": "cross-site", origin: "http://evil.example" } })).status).toBe(403);
    expect((await req(W, { method: "POST", body: {}, headers: { cookie: ck, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const ok = await req(W, { method: "POST", body: {}, headers: { cookie: ck, "sec-fetch-site": "same-origin" } });
    expect([401, 403]).not.toContain(ok.status);
    const byOrigin = await req(W, { method: "POST", body: {}, headers: { cookie: ck, origin: "http://x" } });
    expect([401, 403]).not.toContain(byOrigin.status);
  });
  test("10 AGENTNET_LOOPBACK_ROOT=on: test 1 acts as root, test 3 still 401", async () => {
    process.env.AGENTNET_LOOPBACK_ROOT = "on";
    const h = await req(HELLO, { method: "POST", body: {} });
    expect(h.status).toBe(200); expect(((await h.json()) as { root: boolean }).root).toBe(true);
    await actsAsRoot();
    await actsAsRoot("nope-not-a-token");
    expect((await req(SNAP)).status).toBe(401);
    process.env.AGENTNET_PANEL_LOGIN = "off";
    expect((await req(SNAP)).status).toBe(200);
  });
  test("11 AGENTNET_PANEL_LOGIN=off: test 3 gives 200, test 1 still 401", async () => {
    process.env.AGENTNET_PANEL_LOGIN = "off";
    expect((await req(SNAP)).status).toBe(200);
    expect((await req("/api/v1/agent-routing", { method: "PUT", body: {} })).status).not.toBe(403);
    expect((await req(HELLO, { method: "POST", body: {} })).status).toBe(401);
    expect(((await (await req("/v1/health")).json()) as { houseFlags: string[] }).houseFlags).toEqual(["AGENTNET_PANEL_LOGIN=off"]);
  });
  test("loopback: flag on logs deprecation and counts hits in /health", async () => {
    const { logDeprecations } = await import("../src/net/health");
    type H = { deprecations: string[]; loopbackRootHits: number };
    const h0 = (await (await req("/v1/health")).json()) as H;
    expect(h0.deprecations).toEqual([]); expect(logDeprecations(() => {})).toEqual([]);
    process.env.AGENTNET_LOOPBACK_ROOT = "on";
    const lines: string[] = [];
    expect(logDeprecations((l) => lines.push(l))).toEqual(["AGENTNET_LOOPBACK_ROOT=on: deprecated: removed in 0.8; local scripts must send run/root.token"]);
    expect(lines).toEqual(["agentnet: AGENTNET_LOOPBACK_ROOT=on: deprecated: removed in 0.8; local scripts must send run/root.token"]);
    expect((await req(HELLO, { method: "POST", body: {} })).status).toBe(200); // served by the fallback
    const h1 = (await (await req("/v1/health")).json()) as H;
    expect(h1.loopbackRootHits).toBe(h0.loopbackRootHits + 1);
    expect(h1.deprecations[0]).toContain("removed in 0.8");
  });
});
