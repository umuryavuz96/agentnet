import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-boot-"));
const { buildApp, makeFetch } = await import("../src/server");
const { db } = await import("../src/core/db");

{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../src/core/db"); useDatabase(new Database(":memory:")); (await import("../src/net/store"))._reset(); }
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: makeFetch(buildApp()), idleTimeout: 0 });
afterAll(() => { server.stop(true); });
const base = `http://127.0.0.1:${server.port}/api/v1`;
const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
let t1 = "";

describe("boot", () => {
  test("spawn returns 201 and a 0600 token file", async () => {
    const r = await call("", "POST", "/agentnet/spawn", { name: "t-1", boss: "root", job: "boot" });
    expect(r.status).toBe(201);
    const b = await r.json() as { token_file: string };
    expect(statSync(b.token_file).mode & 0o777).toBe(0o600);
    t1 = (await Bun.file(b.token_file).text()).trim();
  });
  test("hello with the agent token", async () => {
    const r = await call(t1, "POST", "/agentnet/hello", {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as { agent: { name: string } }).agent.name).toBe("t-1");
  });
  test("send to root, root polls it", async () => {
    expect((await call(t1, "POST", "/agentnet/send", { to: "root", body: "hi" })).status).toBe(200);
    const r = await call("", "GET", "/agentnet/poll?wait=0");
    expect(JSON.stringify(await r.json())).toContain("hi");
  });
  test("stream sends hello first", async () => {
    const ac = new AbortController();
    const r = await fetch(`${base}/agentnet/stream`, { signal: ac.signal });
    const reader = r.body!.getReader();
    const first = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no chunk in 1s")), 1000))]);
    expect(new TextDecoder().decode(first.value)).toContain("event: hello");
    ac.abort();
  });
  test("member kind is stored", async () => {
    expect((await call("", "POST", "/agentnet/spawn", { name: "m-1", kind: "member" })).status).toBe(201);
    expect((db().query("SELECT kind FROM agents WHERE name = 'm-1'").get() as { kind: string }).kind).toBe("member");
  });
  test("unknown route is a problem+json 404", async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
  });

  test("real Bun.serve: /v1/admin/spawn with no token over loopback is root (peer survives the path rewrite)", async () => {
    const r = await fetch(`http://127.0.0.1:${server.port}/v1/admin/spawn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "v1-1" }) });
    expect(r.status).toBe(201);
  });
});
