import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeServer, json } from "./fake";

const REPO = resolve(import.meta.dir, "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
// Async spawn: the fake servers live in this process, so a sync spawn would deadlock them.
async function cli(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: tmp("an-home-"), AGENTNET_HOME: tmp("an-data-") };
  const all = { ...base, ...env };
  const p = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], { env: all, cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, env: all };
}
const servers: { stop(): void }[] = [];
afterAll(() => servers.forEach((s) => s.stop()));
const fake = (r: Parameters<typeof fakeServer>[0]) => { const f = fakeServer(r); servers.push(f); return f; };

describe("pick-model", () => {
  test("qa example + log line", async () => {
    const r = await cli(["pick-model", "--role", "qa-1", "--scope", "2", "--novelty", "1", "--risk", "0", "--usage", "10"]);
    expect(r.out).toContain("model=haiku effort=low score=-1");
    const log = readFileSync(join(r.env.AGENTNET_HOME!, "logs", "model-routing.jsonl"), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
  });
  test("no usage file: mode=normal, no stderr noise", async () => {
    const r = await cli(["pick-model", "--role", "backend-1", "--scope", "3", "--novelty", "2", "--risk", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("mode=normal");
    expect(r.err).toBe("");
  });
  test("AGENTNET_USAGE_FILE drives the mode", async () => {
    const f = join(tmp("an-usage-"), "usage.json");
    const win = [{ key: "seven_day", pct: 85, resetsAt: Date.now() / 1000 + 3600, hours: 168 }];
    writeFileSync(f, JSON.stringify({ last: { fetchedAt: Date.now() / 1000, windows: win } }));
    const r = await cli(["pick-model", "--role", "backend-1", "--scope", "3", "--novelty", "2", "--risk", "1"], { AGENTNET_USAGE_FILE: f });
    expect(r.out).toContain("mode=eco");
    expect(r.out).toContain("usage=85");
  });
  test("backend example", async () => {
    const r = await cli(["pick-model", "--role", "backend-1", "--scope", "3", "--novelty", "2", "--risk", "1", "--usage", "10"]);
    expect(r.out).toContain("model=sonnet effort=high score=6");
  });
  test("env file sets log path, real env wins", async () => {
    const home = tmp("an-data-"), t = tmp("an-x-");
    mkdirSync(join(home, "config"));
    writeFileSync(join(home, "config", "env"), `# c\n\nMODEL_ROUTING_LOG=${t}/x.jsonl\n`);
    const a = ["pick-model", "--role", "qa-1", "--scope", "2", "--novelty", "1", "--risk", "0", "--usage", "10"];
    await cli(a, { AGENTNET_HOME: home });
    expect(readFileSync(join(t, "x.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    await cli(a, { AGENTNET_HOME: home, MODEL_ROUTING_LOG: join(t, "y.jsonl") });
    expect(existsSync(join(t, "y.jsonl"))).toBe(true);
  });
});

describe("join", () => {
  test("prints export line", async () => {
    const f = fake({ "POST /api/v1/agentnet/spawn": () => json({ token_file: "/tmp/agentnet-test.token" }) });
    const r = await cli(["join", "t-1", "test bot"], { AGENTNET_URL: `${f.url}/api/v1/agentnet` });
    expect(r.code).toBe(0);
    const line = r.out.trim();
    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("export AGENTNET_TOKEN_FILE='/tmp/agentnet-test.token' AGENTNET_AGENT='t-1'")).toBe(true);
    expect(line.match(/AGENTNET_\w+=/g)).toHaveLength(6);
    const body = f.calls[0]!.body as Record<string, unknown>;
    expect(body.kind).toBe("member"); expect(body.boss).toBe("root");
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
  });
  test("not joined when nothing answers", async () => {
    const r = await cli(["join", "t-1", "x"], { AGENTNET_URL: "http://127.0.0.1:9/api/v1/agentnet" });
    expect(r.code).toBe(1); expect(r.out).toBe(""); expect(r.err).toContain("agentnet: not joined");
  });
});

describe("despawn / status", () => {
  test("despawn posts body; 403 -> exit 1", async () => {
    const f = fake({ "POST /api/v1/agentnet/despawn": () => json({ ok: true }) });
    const r = await cli(["despawn", "t-1", "--reason", "done"], { AGENTNET_URL: `${f.url}/api/v1/agentnet` });
    expect(r.code).toBe(0);
    expect(f.calls[0]!.body).toEqual({ agent: "t-1", reason: "done" });
    const g = fake({ "POST /api/v1/agentnet/despawn": () => json({ detail: "no" }, 403) });
    expect((await cli(["despawn", "t-1"], { AGENTNET_URL: `${g.url}/api/v1/agentnet` })).code).toBe(1);
  });
  test("status lists agents", async () => {
    const f = fake({
      "GET /v1/health": () => json({ name: "agentnet", version: PKG.version, api: 1, minClientApi: 1, features: [] }),
      "GET /api/v1/agentnet/agents": () => json({ agents: [{ name: "a-1", life: "live", state: "working", doing: "x" }] }),
    });
    const r = await cli(["status"], { AGENTNET_URL: `${f.url}/api/v1/agentnet` });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`agentnet ${PKG.version} api 1 at http://127.0.0.1:`);
    expect(r.out).toMatch(/^a-1  live  working/m);
    expect((await cli(["status"], { AGENTNET_URL: "http://127.0.0.1:9/api/v1/agentnet" })).code).toBe(1);
  });
});

describe("install-service", () => {
  const mac = process.platform === "darwin";
  test("dry run renders a valid unit", async () => {
    const r = await cli(["install-service", "--dry-run"]);
    expect(r.code).toBe(0);
    const f = join(tmp("an-unit-"), "unit");
    writeFileSync(f, r.out);
    if (mac) {
      expect(Bun.spawnSync(["plutil", "-lint", f]).exitCode).toBe(0);
      expect(r.out).toContain("<string>dev.agentnet.server</string>");
      expect(r.out).toContain(r.env.AGENTNET_HOME!);
    } else { expect(r.out).toContain("ExecStart="); expect(r.out).toContain('"AGENTNET_PORT=3096"'); }
    expect(r.err).toContain("would write");
  });
  test("AGENTNET_SERVICE_LABEL / _UNIT name the unit; odd characters are refused", async () => {
    const HOME = tmp("an-home-"), env = { HOME, AGENTNET_HOME: join(HOME, "data"), AGENTNET_SERVICE_LABEL: "dev.agentnet.updtest", AGENTNET_SERVICE_UNIT: "agentnet-updtest" };
    const a = await cli(["install-service"], env);
    expect(a.code).toBe(0);
    const unit = mac ? join(HOME, "Library/LaunchAgents/dev.agentnet.updtest.plist") : join(HOME, ".config/systemd/user/agentnet-updtest.service");
    expect(existsSync(unit)).toBe(true);
    const text = readFileSync(unit, "utf8");
    if (mac) { expect(text).toContain("<string>dev.agentnet.updtest</string>"); expect(text).toMatch(/AGENTNET_SERVICE_LABEL<\/key>\s*<string>dev\.agentnet\.updtest</); }
    else { expect(text).toContain('"AGENTNET_SERVICE_UNIT=agentnet-updtest"'); expect(a.out).toContain("enable --now agentnet-updtest"); }
    const bad = await cli(["install-service", "--dry-run"], { AGENTNET_SERVICE_LABEL: "a b" });
    expect(bad.code).toBe(1); expect(bad.err).toContain("may only contain");
  });
  test("ampersand in AGENTNET_HOME still lints", async () => {
    if (!mac) return;
    const home = join(tmp("an-"), "a&b");
    const r = await cli(["install-service", "--dry-run"], { AGENTNET_HOME: home });
    const f = join(tmp("an-unit-"), "u.plist"); writeFileSync(f, r.out);
    expect(Bun.spawnSync(["plutil", "-lint", f]).exitCode).toBe(0);
    expect(r.out).toContain("a&amp;b");
  });
  test("writes once under temp HOME, second run keeps it", async () => {
    const HOME = tmp("an-home-");
    const env = { HOME, AGENTNET_HOME: join(HOME, "data") };
    const a = await cli(["install-service"], env);
    expect(a.code).toBe(0);
    const unit = mac ? join(HOME, "Library/LaunchAgents/dev.agentnet.server.plist") : join(HOME, ".config/systemd/user/agentnet.service");
    expect(existsSync(unit)).toBe(true);
    expect(a.out).toContain(mac ? "launchctl bootstrap" : "systemctl --user");
    expect((await cli(["install-service"], env)).out).toContain("exists, not overwritten");
    // .bun is the Bun runtime's own cache dir (created on Linux), not agentnet.
    expect(readdirSync(HOME).sort().every((n) => ["Library", ".config", ".bun", "data"].includes(n))).toBe(true);
  });
});

describe("bg and misc", () => {
  test("bg writes card and exit file", async () => {
    const dir = tmp("an-bg-");
    const r = await cli(["bg", "t", "--", "sh", "-c", "echo hi"], { AGENTNET_BGJOBS: dir });
    expect(r.code).toBe(0);
    const card = readdirSync(dir).find((n) => n.endsWith(".json"))!;
    expect(JSON.parse(readFileSync(join(dir, card), "utf8")).desc).toBe("t");
    const ex = join(dir, card.replace(/\.json$/, ".exit"));
    for (let i = 0; i < 30 && !existsSync(ex); i++) await Bun.sleep(100);
    expect(readFileSync(ex, "utf8").trim()).toBe("0");
  });
  test("url, plugin-dir, unknown, update", async () => {
    expect((await cli(["url"], { AGENTNET_PORT: "3196" })).out.trim()).toBe("http://127.0.0.1:3196/api/v1/agentnet");
    const pd = (await cli(["plugin-dir"])).out.trim();
    expect(existsSync(join(pd, ".claude-plugin", "plugin.json"))).toBe(true);
    expect((await cli(["frobnicate"])).code).toBe(2);
    expect((await cli(["update", "--bogus"])).code).toBe(2); // bad option; update itself is tested in test/update.test.ts on a fixture repo
  });
});

describe("adopt", () => {
  test("usage errors exit 2", async () => {
    expect((await cli(["adopt"])).code).toBe(2);
    expect((await cli(["adopt", "scan"])).code).toBe(2);
    expect((await cli(["adopt", "plan"])).code).toBe(2);
    expect((await cli(["adopt", "apply"])).code).toBe(2);
  });
  test("runs and rollback work with no server and an empty home", async () => {
    expect((await cli(["adopt", "runs"])).out).toContain("no adopt runs");
    expect((await cli(["adopt", "rollback"])).out).toContain("nothing to roll back");
  });
  test("static scan then plan and apply talk to the panel routes", async () => {
    const report = { scanId: "scan-1", summary: "Basic scan: 1 thing.", findings: [{ id: "f1", title: "A", risk: "low", actions: [{ id: "a1" }] }, { id: "f2", title: "B", risk: "high", actions: [] }] };
    const f = fake({
      "POST /api/v1/agent-adopt/scan": () => json({ ok: true, scanId: "scan-1", phase: "reported" }),
      "GET /api/v1/agent-adopt": () => json({ phase: "reported", scanId: "scan-1", report }),
      "POST /api/v1/agent-adopt/plan": () => json({ planId: "plan-1", ops: [{ op: "park-mcp", file: "/w/.mcp.json", diff: "-x\n+y" }], warnings: [], backupDir: "/b", needsConfirmGlobal: false }),
      "POST /api/v1/agent-adopt/apply": () => json({ ok: true, runId: "run-1" }),
    });
    const env = { AGENTNET_URL: `${f.url}/api/v1/agentnet` };
    const s = await cli(["adopt", "scan", "--dir", "/w", "--static"], env);
    expect(s.code).toBe(0); expect(s.out).toContain("f1"); expect(s.out).toContain("Basic scan");
    expect(f.calls.find((c) => c.path.endsWith("/scan"))?.body).toEqual({ dir: "/w", mode: "static" });
    const p = await cli(["adopt", "plan", "--scan", "scan-1"], env);
    expect(p.code).toBe(0); expect(p.out).toContain("plan-1");
    expect(f.calls.find((c) => c.path.endsWith("/plan"))?.body).toEqual({ scanId: "scan-1", picks: { findings: { f1: "apply", f2: "skip" } } });
    const a = await cli(["adopt", "apply", "--plan", "plan-1"], env);
    expect(a.code).toBe(0); expect(a.out).toContain("rollback run-1");
  });
  test("a 409 from the server prints its detail and exits 1", async () => {
    const f = fake({ "POST /api/v1/agent-adopt/apply": () => json({ detail: "That is not the current plan. Preview again." }, 409) });
    const r = await cli(["adopt", "apply", "--plan", "x"], { AGENTNET_URL: `${f.url}/api/v1/agentnet` });
    expect(r.code).toBe(1); expect(r.err).toContain("not the current plan");
  });
});
