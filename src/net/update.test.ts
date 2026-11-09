import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import pkg from "../../package.json";
const CUR = pkg.version; // current version comes from package.json, so a version bump does not break these tests

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-upd-home-"));
const { autoGate, autoTick, spawnPlan, updateRoutes, updaterArgv } = await import("./update");
const { isPanelWrite, toLegacy, V1_PATHS } = await import("./mount");
const { acquire } = await import("../update/lock");
const { makeFixture, sh } = await import("../../test/updateFixture");
const { LAN, LOOP } = await import("../../test/helpers");
import type { Mode } from "../update/service";

const LATEST = { tag: "v0.5.0", version: "0.5.0", url: "https://github.com/umuryavuz96/agentnet/releases/tag/v0.5.0", notes: "## 0.5.0\n- x", publishedAt: "2026-11-09T00:00:00Z" };
function setup(o: { mode?: Mode; latest?: typeof LATEST | null } = {}) {
  const f = makeFixture();
  mkdirSync(join(f.home, "data"), { recursive: true });
  writeFileSync(join(f.home, "data", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: o.latest === undefined ? LATEST : o.latest }));
  const spawned: { argv: string[]; mode: Mode; id: string }[] = [];
  const deps = { repo: f.work, home: f.home, allowLocalOrigin: true, mode: async () => o.mode ?? ("launchd" as Mode), spawnUpdater: (argv: string[], mode: Mode, id: string) => { spawned.push({ argv, mode, id }); } };
  const api = new Hono(); updateRoutes(api as never, deps);
  const app = new Hono(); app.route("/api/v1", api);
  const call = (method: string, path: string, body?: unknown, env: unknown = LOOP) =>
    app.request(`/api/v1/agent-update${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }, env as never);
  return { f, deps, spawned, call };
}
afterEach(() => { delete process.env.AGENTNET_WEB_UPDATE; delete process.env.AGENTNET_AUTO_UPDATE; delete process.env.AGENTNET_AUTO_UPDATE_HOUR; });

describe("status", () => {
  test("available update, nothing blocked", async () => {
    const s = setup();
    const j = await (await s.call("GET", "")).json() as any;
    expect(j).toMatchObject({ current: CUR, latest: "0.5.0", available: true, mode: "launchd", auto: { enabled: false, hour: 4 }, job: null });
    expect(j.web).toEqual({ enabled: true, blocked: null });
    expect(j.notes).toContain("## 0.5.0"); expect(j.releaseUrl).toStartWith("https://");
    expect(j.published).toBe(LATEST.publishedAt);
  });
  test("a finished job carries endedAt (the page shows it for 10 minutes), a running one does not", async () => {
    const s = setup(); mkdirSync(join(s.f.home, "run"), { recursive: true });
    const file = join(s.f.home, "run", "update-state.json");
    writeFileSync(file, JSON.stringify({ id: "upd-1", from: "v0.4.0", to: "v0.5.0", outcome: "updated", steps: [] }));
    const j = ((await (await s.call("GET", "")).json()) as any).job;
    expect(j).toMatchObject({ id: "upd-1", outcome: "updated" }); expect(Math.abs(j.endedAt - Date.now() / 1000)).toBeLessThan(30);
    writeFileSync(file, JSON.stringify({ id: "upd-2", running: true, from: "v0.4.0", to: "v0.5.0", startedAt: Date.now() }));
    expect(((await (await s.call("GET", "")).json()) as any).job.endedAt).toBeUndefined();
  });
  test("blocked reasons: web-disabled, no-service, preflight code", async () => {
    process.env.AGENTNET_WEB_UPDATE = "0";
    expect(((await (await setup().call("GET", "")).json()) as any).web.blocked.code).toBe("web-disabled");
    delete process.env.AGENTNET_WEB_UPDATE;
    expect(((await (await setup({ mode: "foreground" }).call("GET", "")).json()) as any).web.blocked.code).toBe("no-service");
    const s = setup(); writeFileSync(join(s.f.work, "CHANGELOG.md"), "edited");
    expect(((await (await s.call("GET", "")).json()) as any).web.blocked).toMatchObject({ code: "dirty", hint: "Commit or stash your changes first." });
  });
  test("no latest: not available", async () => {
    expect(((await (await setup({ latest: null }).call("GET", "")).json()) as any).available).toBe(false);
  });
});

describe("POST run", () => {
  test("T13 AGENTNET_WEB_UPDATE=0: 403", async () => {
    const s = setup(); process.env.AGENTNET_WEB_UPDATE = "0";
    const r = await s.call("POST", "/run", { tag: "v0.5.0" });
    expect(r.status).toBe(403); expect(((await r.json()) as any).code).toBe("web-disabled");
    expect(s.spawned).toHaveLength(0);
  });
  test("T14 bad bodies", async () => {
    const s = setup();
    const post = async (b: unknown) => (await s.call("POST", "/run", b)).status;
    expect(await post({ tag: "main" })).toBe(400);
    expect(await post({ tag: "v0.5.0", cmd: "x" })).toBe(400);
    expect(await post({ tag: "v0.5.0;rm" })).toBe(400);
    expect(await post({})).toBe(400);
    expect(await post("not json")).toBe(400);
    expect(await post(["v0.5.0"])).toBe(400);
    expect(await post({ tag: 4 })).toBe(400);
    const old = await s.call("POST", "/run", { tag: "v0.3.1" });
    expect(old.status).toBe(409); expect(((await old.json()) as any).code).toBe("not-latest");
    expect(await post({ tag: "v9.9.9" })).toBe(409);
    expect(s.spawned).toHaveLength(0);
  });
  test("no cached release: 409 not-latest", async () => {
    expect((await setup({ latest: null }).call("POST", "/run", { tag: "v0.5.0" })).status).toBe(409);
  });
  test("T15 not loopback: 403, also for check", async () => {
    const s = setup();
    expect((await s.call("POST", "/run", { tag: "v0.5.0" }, LAN)).status).toBe(403);
    expect((await s.call("POST", "/check", {}, LAN)).status).toBe(403);
    expect(s.spawned).toHaveLength(0);
  });
  test("T16 good: 202 and exactly the fixed argv", async () => {
    const s = setup();
    const r = await s.call("POST", "/run", { tag: "v0.5.0" });
    expect(r.status).toBe(202);
    const { id } = (await r.json()) as { id: string };
    expect(id).toMatch(/^upd-\d+$/);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.argv).toEqual([process.execPath, join(s.f.work, "src", "cli.ts"), "update", "--yes", "--from-web", id, "--expect", "v0.5.0"]);
    expect(s.spawned[0]!.mode).toBe("launchd");
    expect(JSON.parse(readFileSync(join(s.f.home, "run", "update-state.json"), "utf8"))).toMatchObject({ id, running: true, from: `v${CUR}`, to: "v0.5.0" });
  });
  test("blocked or locked: 409 and nothing spawns", async () => {
    const a = setup({ mode: "foreground" });
    expect(((await (await a.call("POST", "/run", { tag: "v0.5.0" })).json()) as any).code).toBe("no-service");
    const b = setup(); acquire(b.f.home, "upd-1");
    const r = await b.call("POST", "/run", { tag: "v0.5.0" });
    expect(r.status).toBe(409); expect(((await r.json()) as any).code).toBe("locked");
    expect(a.spawned.length + b.spawned.length).toBe(0);
  });
  test("double click: second POST within a minute is 409 locked and keeps the first state", async () => {
    const s = setup();
    const a = (await (await s.call("POST", "/run", { tag: "v0.5.0" })).json()) as { id: string };
    const r = await s.call("POST", "/run", { tag: "v0.5.0" });
    expect(r.status).toBe(409); expect(((await r.json()) as any).code).toBe("locked");
    expect(s.spawned).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.f.home, "run", "update-state.json"), "utf8")).id).toBe(a.id);
  });
  test("spawnPlan: detached, and home/host/port are explicit even with the env vars unset", () => {
    const argv = ["/bin/bun", "/r/src/cli.ts", "update"];
    const bare = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
    const l = spawnPlan("/r", "/h", argv, "launchd", "upd-1", bare);
    expect(l.opts.detached).toBe(true);
    expect(l.opts.env).toMatchObject({ AGENTNET_HOME: "/h", AGENTNET_PORT: expect.stringMatching(/^\d+$/), AGENTNET_HOST: expect.any(String) });
    const sd = spawnPlan("/r", "/h", argv, "systemd", "upd-1", bare);
    expect(sd.cmd).toBe("systemd-run");
    for (const k of ["AGENTNET_HOME=/h", "AGENTNET_PORT=", "AGENTNET_HOST=", "PATH=/usr/bin"]) expect(sd.args.some((a) => a.startsWith(`--setenv=${k}`))).toBe(true);
    expect(sd.args.slice(-3)).toEqual(argv);
    const named = spawnPlan("/r", "/h", argv, "systemd", "upd-1", { ...bare, AGENTNET_SERVICE_UNIT: "agentnet-x", AGENTNET_SERVICE_LABEL: "dev.x" });
    expect(named.args).toContain("--setenv=AGENTNET_SERVICE_UNIT=agentnet-x"); expect(named.args).toContain("--setenv=AGENTNET_SERVICE_LABEL=dev.x");
    expect(spawnPlan("/r", "/h", argv, "launchd", "upd-1", { ...bare, AGENTNET_SERVICE_LABEL: "dev.x" }).opts.env).toMatchObject({ AGENTNET_SERVICE_LABEL: "dev.x" });
  });
  test("updaterArgv never carries anything but the id and a tag", () => {
    expect(updaterArgv("/r", "upd-1", "v1.2.3", "auto").slice(2)).toEqual(["update", "--yes", "--from-auto", "upd-1", "--expect", "v1.2.3"]);
  });
});

describe("stream (T18)", () => {
  test("hello carries the log so far, then new lines, then it ends after done", async () => {
    const s = setup(); mkdirSync(join(s.f.home, "run"), { recursive: true });
    const file = join(s.f.home, "run", "update-upd-5.jsonl");
    const ev = (o: unknown) => JSON.stringify(o) + "\n";
    writeFileSync(file, ev({ t: 1, type: "start", id: "upd-5" }) + ev({ t: 2, type: "step", step: { id: "preflight", state: "ok" } }));
    setTimeout(() => appendFileSync(file, ev({ t: 3, type: "step", step: { id: "install", state: "ok" } }) + ev({ t: 4, type: "done", result: { outcome: "updated" } })), 800);
    const text = await (await s.call("GET", "/stream?id=upd-5")).text();
    const hello = /event: hello\ndata: (.*)/.exec(text)![1]!;
    expect(JSON.parse(hello)).toHaveLength(2);
    const later = [...text.matchAll(/event: event\ndata: (.*)/g)].map((m) => JSON.parse(m[1]!));
    expect(later.map((e) => e.type)).toEqual(["step", "done"]);
  });
  test("a finished job: everything in hello, stream closes", async () => {
    const s = setup(); mkdirSync(join(s.f.home, "run"), { recursive: true });
    writeFileSync(join(s.f.home, "run", "update-upd-6.jsonl"), JSON.stringify({ type: "start" }) + "\n" + JSON.stringify({ type: "done", result: {} }) + "\n");
    const text = await (await s.call("GET", "/stream?id=upd-6")).text();
    expect(JSON.parse(/event: hello\ndata: (.*)/.exec(text)![1]!)).toHaveLength(2);
  });
  test("bad id: empty hello", async () => {
    const text = await (await setup().call("GET", "/stream?id=../etc/passwd")).text();
    expect(text).toContain("event: hello"); expect(text).toContain("data: []");
  });
});

describe("auto update (T21)", () => {
  const base = { enabled: true, hour: 4, nowDate: new Date(2026, 10, 10, 4, 5), available: true, tag: "v0.5.0", mode: "launchd" as Mode, working: false, lastRunAt: null, skipTag: null, locked: false };
  test("gate", () => {
    expect(autoGate(base).run).toBe(true);
    expect(autoGate({ ...base, enabled: false }).run).toBe(false);
    expect(autoGate({ ...base, nowDate: new Date(2026, 10, 10, 5, 0) }).run).toBe(false);
    expect(autoGate({ ...base, working: true })).toEqual({ run: false, why: "an agent is working" });
    expect(autoGate({ ...base, skipTag: "v0.5.0" }).run).toBe(false);
    expect(autoGate({ ...base, skipTag: "v0.3.9" }).run).toBe(true);
    expect(autoGate({ ...base, mode: "foreground" }).run).toBe(false);
    expect(autoGate({ ...base, available: false }).run).toBe(false);
    expect(autoGate({ ...base, lastRunAt: base.nowDate.getTime() - 3600_000 }).run).toBe(false);
    expect(autoGate({ ...base, lastRunAt: base.nowDate.getTime() - 21 * 3600_000 }).run).toBe(true);
    expect(autoGate({ ...base, locked: true }).run).toBe(false);
  });
  test("off by default: tick does nothing", async () => {
    const s = setup();
    expect((await autoTick({ ...s.deps, now: () => new Date(2026, 10, 10, 4, 5).getTime() })).run).toBe(false);
    expect(s.spawned).toHaveLength(0);
  });
  test("on, right hour: spawns the --from-auto updater once; wrong hour does not", async () => {
    const s = setup(); process.env.AGENTNET_AUTO_UPDATE = "1";
    const wrong = await autoTick({ ...s.deps, now: () => new Date(2026, 10, 10, 9, 0).getTime() });
    expect(wrong.run).toBe(false); expect(s.spawned).toHaveLength(0);
    const r = await autoTick({ ...s.deps, now: () => new Date(2026, 10, 10, 4, 5).getTime() });
    expect(r.run).toBe(true);
    expect(s.spawned[0]!.argv.slice(2, 5)).toEqual(["update", "--yes", "--from-auto"]);
  });
  test("skipTag in the state file stops a retry of the rolled-back tag", async () => {
    const s = setup(); process.env.AGENTNET_AUTO_UPDATE = "1";
    mkdirSync(join(s.f.home, "run"), { recursive: true });
    writeFileSync(join(s.f.home, "run", "update-state.json"), JSON.stringify({ id: "upd-1", outcome: "rolled-back", skipTag: "v0.5.0" }));
    const r = await autoTick({ ...s.deps, now: () => new Date(2026, 10, 10, 4, 5).getTime() });
    expect(r.run).toBe(false); expect(s.spawned).toHaveLength(0);
  });
  test("a dirty checkout blocks the auto run too", async () => {
    const s = setup(); process.env.AGENTNET_AUTO_UPDATE = "1";
    writeFileSync(join(s.f.work, "CHANGELOG.md"), "edited");
    expect((await autoTick({ ...s.deps, now: () => new Date(2026, 10, 10, 4, 5).getTime() })).run).toBe(false);
    expect(s.spawned).toHaveLength(0);
    sh(s.f.work, "checkout", "--", "CHANGELOG.md");
  });
});

describe("mount (T22)", () => {
  test("four v1 paths map to agent-update", () => {
    expect(toLegacy("/v1/panel/update")).toBe("/api/v1/agent-update");
    for (const p of ["check", "run", "stream"]) expect(toLegacy(`/v1/panel/update/${p}`)).toBe(`/api/v1/agent-update/${p}`);
    expect(toLegacy("/v1/panel/update/other")).toBeNull();
    expect(V1_PATHS.filter((p) => p.startsWith("/v1/panel/update"))).toHaveLength(4);
  });
  test("isPanelWrite: the two POSTs, not the reads", () => {
    expect(isPanelWrite("POST", "/api/v1/agent-update/run")).toBe(true);
    expect(isPanelWrite("POST", "/api/v1/agent-update/check")).toBe(true);
    expect(isPanelWrite("GET", "/api/v1/agent-update")).toBe(false);
    expect(isPanelWrite("GET", "/api/v1/agent-update/stream")).toBe(false);
  });
});
