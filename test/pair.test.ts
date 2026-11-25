// Device pairing (RFC 8628 shape): an app asks for a code, the owner approves it in the web, the app's poll gets a device token.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAN, LOOP } from "./helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-pair-"));
delete process.env.AGENTNET_LOOPBACK_ROOT; delete process.env.AGENTNET_PANEL_LOGIN;
const { buildApp, makeFetch } = await import("../src/server");
const HOME = (await import("../src/core/config")).ROOT;
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const pair = await import("../src/net/pair");
const f = makeFetch(buildApp());
const ROOT_T = readFileSync(join(HOME, "run/root.token"), "utf8").trim(), PANEL_T = readFileSync(join(HOME, "run/panel.token"), "utf8").trim();
type Init = { method?: string; token?: string; body?: unknown; env?: unknown; headers?: Record<string, string> };
const req = (path: string, i: Init = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json", host: "x", ...i.headers };
  if (i.token) headers.authorization = `Bearer ${i.token}`;
  return f(new Request(`http://x${path}`, { method: i.method ?? "GET", headers, body: i.body === undefined ? undefined : JSON.stringify(i.body) }), i.env ?? LOOP);
};
type Start = { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number };
let ip = 0; // each start from its own address, so the rate limit only bites in its own test
const start = async (name = "Test Mac: agentnet app") => {
  const r = await req("/v1/pair/start", { method: "POST", body: { name }, headers: { "x-forwarded-for": `10.1.0.${++ip}` } });
  expect(r.status).toBe(200);
  return (await r.json()) as Start;
};
const poll = (device_code: string) => req("/v1/pair/poll", { method: "POST", body: { device_code } });
const approve = (user_code: string, token = PANEL_T) => req("/api/v1/pair/approve", { method: "POST", token, body: { user_code } });
const SNAP = "/api/v1/agentnet/snapshot";
let agentTok = "";

beforeEach(() => { pair.pairClock.now = () => Date.now(); });

describe("pair", () => {
  test("start: short user code, long device code, 10 min expiry, approval link", async () => {
    const s = await start();
    expect(s.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(s.device_code.length).toBeGreaterThanOrEqual(43);
    expect(s.expires_in).toBe(600);
    expect(s.interval).toBe(5);
    expect(s.verification_uri_complete).toBe(`http://x/#/pair?code=${s.user_code}`);
  });
  test("start needs a name; unknown device code on poll is 400 invalid_grant", async () => {
    expect((await req("/v1/pair/start", { method: "POST", body: {}, headers: { "x-forwarded-for": "10.2.0.1" } })).status).toBe(400);
    const r = await poll("nope");
    expect(r.status).toBe(400); expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  });
  test("poll before approval: authorization_pending", async () => {
    const r = await poll((await start()).device_code);
    expect(r.status).toBe(400); expect(((await r.json()) as { error: string }).error).toBe("authorization_pending");
  });
  test("owner lists the request, approves; poll returns a device token once; it works on panel routes", async () => {
    const s = await start("Kitchen Mac: agentnet app");
    const list = (await (await req("/api/v1/pair/requests", { token: PANEL_T })).json()) as { requests: { user_code: string; name: string }[] };
    expect(list.requests.find((x) => x.user_code === s.user_code)?.name).toBe("Kitchen Mac: agentnet app");
    expect(JSON.stringify(list)).not.toContain(s.device_code);
    expect((await approve(s.user_code)).status).toBe(200);
    const r = await poll(s.device_code);
    expect(r.status).toBe(200);
    const t = (await r.json()) as { access_token: string; token_type: string; device_id: string };
    expect(t.token_type).toBe("bearer");
    expect((await req(SNAP, { token: t.access_token })).status).toBe(200);
    // device code is single use
    expect(((await (await poll(s.device_code)).json()) as { error: string }).error).toBe("invalid_grant");
    // stored hashed: the raw token is nowhere in the table
    const { db } = await import("../src/core/db");
    const rows = db().query("SELECT * FROM device_tokens").all();
    expect(JSON.stringify(rows)).not.toContain(t.access_token);
    // listed under devices with last use
    const d = (await (await req("/api/v1/pair/devices", { token: PANEL_T })).json()) as { devices: { id: string; name: string; last_used: number | null }[] };
    const mine = d.devices.find((x) => x.id === t.device_id)!;
    expect(mine.name).toBe("Kitchen Mac: agentnet app");
    expect(mine.last_used).toBeGreaterThan(0);
  });
  test("device token is a panel credential: it may write panel routes and approve", async () => {
    const s = await start(); await approve(s.user_code);
    const tok = ((await (await poll(s.device_code)).json()) as { access_token: string }).access_token;
    const s2 = await start();
    expect((await approve(s2.user_code, tok)).status).toBe(200);
  });
  test("deny: poll says access_denied", async () => {
    const s = await start();
    expect((await req("/api/v1/pair/deny", { method: "POST", token: PANEL_T, body: { user_code: s.user_code } })).status).toBe(200);
    const r = await poll(s.device_code);
    expect(r.status).toBe(400); expect(((await r.json()) as { error: string }).error).toBe("access_denied");
  });
  test("expiry after 10 min: poll says expired_token, approve is 404", async () => {
    const s = await start();
    const t0 = Date.now(); pair.pairClock.now = () => t0 + 601_000;
    expect((await approve(s.user_code)).status).toBe(404);
    const r = await poll(s.device_code);
    expect(r.status).toBe(400); expect(((await r.json()) as { error: string }).error).toBe("expired_token");
  });
  test("rate limit: the 6th start from one address in a minute is 429", async () => {
    const hit = () => req("/v1/pair/start", { method: "POST", body: { name: "x" }, headers: { "x-forwarded-for": "10.3.0.1" } });
    for (let i = 0; i < 5; i++) expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
    // a direct LAN peer counts by its own address, not a header it sends
    const lan = () => req("/v1/pair/start", { method: "POST", body: { name: "x" }, env: LAN, headers: { "x-forwarded-for": `10.4.0.${++ip}` } });
    for (let i = 0; i < 5; i++) expect((await lan()).status).toBe(200);
    expect((await lan()).status).toBe(429);
  });
  test("agent token: 403 on approve, deny, list, devices, revoke; no credential: 401", async () => {
    const sp = await req("/api/v1/agentnet/spawn", { method: "POST", body: { name: "pair-agent" }, token: ROOT_T });
    expect(sp.status).toBe(201);
    agentTok = readFileSync(((await sp.json()) as { token_file: string }).token_file, "utf8").trim();
    const s = await start();
    expect((await approve(s.user_code, agentTok)).status).toBe(403);
    expect((await req("/api/v1/pair/deny", { method: "POST", token: agentTok, body: { user_code: s.user_code } })).status).toBe(403);
    expect((await req("/api/v1/pair/requests", { token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/pair/devices", { token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/pair/devices/x", { method: "DELETE", token: agentTok })).status).toBe(403);
    expect((await req("/api/v1/pair/requests")).status).toBe(401);
    expect(((await (await poll(s.device_code)).json()) as { error: string }).error).toBe("authorization_pending");
  });
  test("revoke: the device token gets 401 and drops off the list", async () => {
    const s = await start(); await approve(s.user_code);
    const t = (await (await poll(s.device_code)).json()) as { access_token: string; device_id: string };
    expect((await req(SNAP, { token: t.access_token })).status).toBe(200);
    expect((await req(`/api/v1/pair/devices/${t.device_id}`, { method: "DELETE", token: PANEL_T })).status).toBe(200);
    expect((await req(SNAP, { token: t.access_token })).status).toBe(401);
    const d = (await (await req("/api/v1/pair/devices", { token: PANEL_T })).json()) as { devices: { id: string }[] };
    expect(d.devices.some((x) => x.id === t.device_id)).toBe(false);
    expect((await req(`/api/v1/pair/devices/${t.device_id}`, { method: "DELETE", token: PANEL_T })).status).toBe(404);
  });
  test("revoke ends that device's open stream at once, so the app re-checks and pairs again", async () => {
    const s = await start(); await approve(s.user_code);
    const t = (await (await poll(s.device_code)).json()) as { access_token: string; device_id: string };
    const other = (await req("/api/v1/agentnet/stream", { token: PANEL_T })).body!.getReader();
    const r = await req("/api/v1/agentnet/stream", { token: t.access_token });
    expect(r.status).toBe(200);
    const rd = r.body!.getReader(), dec = new TextDecoder();
    expect(dec.decode((await rd.read()).value)).toContain("event: hello");
    await other.read();
    expect((await req(`/api/v1/pair/devices/${t.device_id}`, { method: "DELETE", token: PANEL_T })).status).toBe(200);
    // the stream closes well before its 15 s heartbeat
    const end = await Promise.race([(async () => { for (;;) { if ((await rd.read()).done) return "closed"; } })(), Bun.sleep(2000).then(() => "open")]);
    expect(end).toBe("closed");
    // a stream on another credential stays open
    const still = await Promise.race([other.read().then(() => "data"), Bun.sleep(300).then(() => "open")]);
    expect(still).toBe("open");
    await other.cancel(); await rd.cancel().catch(() => {});
  });
  test("v1 panel paths map onto the pair routes", async () => {
    expect((await req("/v1/panel/pair/requests", { token: PANEL_T })).status).toBe(200);
    expect((await req("/v1/panel/devices", { token: PANEL_T })).status).toBe(200);
  });
});
