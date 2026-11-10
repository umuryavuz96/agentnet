import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeServer, json } from "../../test/fake";
import { makeFixture } from "../../test/updateFixture";
import { check, readCache } from "./check";

const release = (o: Record<string, unknown> = {}) => json({ tag_name: "v0.4.0", html_url: "https://github.com/umuryavuz96/agentnet/releases/tag/v0.4.0", body: "notes", published_at: "2026-11-09T00:00:00Z", ...o });
const servers: { stop(): void }[] = [];
function gh(handler: () => Response) {
  const f = fakeServer({ "GET /repos/umuryavuz96/agentnet/releases/latest": handler });
  servers.push(f); process.env.AGENTNET_UPDATE_API = f.url;
  return f;
}
afterEach(() => { servers.splice(0).forEach((s) => s.stop()); delete process.env.AGENTNET_UPDATE_API; delete process.env.AGENTNET_UPDATE_CHECK; });
const setup = () => { const f = makeFixture(); let t = 1_000_000_000_000; return { repo: f.work, home: mkdtempSync(join(tmpdir(), "an-chk-")), tick: (ms: number) => { t += ms; }, now: () => t }; };

describe("check (T17)", () => {
  test("two calls within 10 min make one request; the answer is parsed", async () => {
    const s = setup(), f = gh(() => release());
    const a = await check({ ...s });
    const b = await check({ ...s });
    expect(f.calls).toHaveLength(1);
    expect(a.latest).toEqual({ tag: "v0.4.0", version: "0.4.0", url: "https://github.com/umuryavuz96/agentnet/releases/tag/v0.4.0", notes: "notes", publishedAt: "2026-11-09T00:00:00Z" });
    expect(b).toEqual(a);
    expect(f.calls[0]!.headers["user-agent"]).toStartWith("agentnet/");
    expect(f.calls[0]!.headers.accept).toBe("application/vnd.github+json");
    expect(readCache(s.home)?.latest?.tag).toBe("v0.4.0");
  });
  test("after 10 min it asks again", async () => {
    const s = setup(), f = gh(() => release());
    await check({ ...s }); s.tick(TTL() + 1); await check({ ...s });
    expect(f.calls).toHaveLength(2);
  });
  test("a 304 keeps the cached answer, sends If-None-Match and refreshes checkedAt", async () => {
    const s = setup(); let n = 0;
    const f = gh(() => (n++ === 0 ? new Response(JSON.stringify({ tag_name: "v0.4.0", html_url: "https://github.com/x/y/releases/tag/v0.4.0", body: "n", published_at: "p" }), { headers: { "content-type": "application/json", etag: 'W/"abc"' } }) : new Response(null, { status: 304 })));
    const a = await check({ ...s });
    expect(a.etag).toBe('W/"abc"'); expect(f.calls[0]!.headers["if-none-match"]).toBeUndefined();
    s.tick(TTL() + 1);
    const b = await check({ ...s });
    expect(f.calls).toHaveLength(2); expect(f.calls[1]!.headers["if-none-match"]).toBe('W/"abc"');
    expect(b.latest).toEqual(a.latest); expect(b.error).toBeUndefined(); expect(b.etag).toBe('W/"abc"'); expect(b.checkedAt).toBeGreaterThan(a.checkedAt);
    expect(readCache(s.home)?.checkedAt).toBe(b.checkedAt);
  });
  test("force waits at least 60 s between real requests", async () => {
    const s = setup(), f = gh(() => release());
    await check({ ...s });
    s.tick(30_000); await check({ ...s, force: true });
    expect(f.calls).toHaveLength(1);
    s.tick(31_000); await check({ ...s, force: true });
    expect(f.calls).toHaveLength(2);
  });
  test("AGENTNET_UPDATE_CHECK=0: no request, no cache file", async () => {
    const s = setup(), f = gh(() => release());
    process.env.AGENTNET_UPDATE_CHECK = "0";
    const r = await check({ ...s, force: true });
    expect(r.latest).toBeNull(); expect(f.calls).toHaveLength(0);
    expect(existsSync(join(s.home, "data", "update-check.json"))).toBe(false);
  });
  test("errors are cached; a previous answer survives an outage", async () => {
    const s = setup(); let fail = false;
    const f = gh(() => (fail ? new Response("down", { status: 503 }) : release()));
    await check({ ...s });
    fail = true; s.tick(TTL() + 1);
    const e = await check({ ...s });
    expect(e.error).toContain("503"); expect(e.latest?.tag).toBe("v0.4.0");
    await check({ ...s }); await check({ ...s });
    expect(f.calls).toHaveLength(2); // the failure was cached: no request per page load
  });
  test("tags that are not releases, http urls and giant notes", async () => {
    const s = setup(); gh(() => release({ tag_name: "v0.5.0-rc1" }));
    expect((await check({ ...s })).latest).toBeNull();
    const t = setup(); gh(() => release({ html_url: "http://x", body: "x".repeat(30_000) }));
    const r = await check({ ...t });
    expect(r.latest?.url).toBe(""); expect(r.latest?.notes).toHaveLength(20_000);
  });
  test("no network call is made for a repo without a GitHub url", async () => {
    const s = setup(), f = gh(() => release());
    process.env.AGENTNET_UPDATE_REPO = "bad repo";
    try { const r = await check({ ...s }); expect(r.error).toBeTruthy(); expect(f.calls).toHaveLength(0); } finally { delete process.env.AGENTNET_UPDATE_REPO; }
  });
});
const TTL = () => 10 * 60_000;
