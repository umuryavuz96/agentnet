import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOP } from "../../test/helpers";
import { makeWorkspace } from "../../test/helpers/adoptFixture";

const tmp = mkdtempSync(join(tmpdir(), "an-adopt-"));
const { ws, home } = makeWorkspace(tmp);
const ENV = ["AGENTNET_HOME", "AGENTNET_WORKSPACE_DIR", "HOME", "AGENTNET_ADOPT_STUB", "TMUX"];
const old: Record<string, string | undefined> = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
process.env.AGENTNET_HOME = join(tmp, "agentnet"); process.env.AGENTNET_WORKSPACE_DIR = join(tmp, "agentnet", "workspace"); process.env.HOME = home; delete process.env.TMUX;
mkdirSync(process.env.AGENTNET_HOME, { recursive: true });
afterAll(() => { for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
const { buildApp, makeFetch } = await import("../server");
{ const { Database } = await import("bun:sqlite"); const { useDatabase } = await import("../core/db"); useDatabase(new Database(":memory:")); (await import("./store"))._reset(); }
const { seams, loadState, setState } = await import("./adopt");
const started: unknown[] = [];
seams.startDirector = ((dir: string, _r: unknown, _t: unknown, _e: unknown, opts: unknown) => { started.push({ dir, opts }); return { ok: true, session: "x", attach: "tmux a" }; }) as never;
seams.killScanSession = () => false; seams.hasRoot = () => false; seams.hasSession = () => false;
const f = makeFetch(buildApp());
const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => f(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), LOOP);
const snap = (dir: string, out = new Map<string, string>()): Map<string, string> => {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) snap(p, out); else out.set(p, readFileSync(p, "utf8")); }
  return out;
};
beforeAll(() => { setState({ phase: "idle" }); });

test("v1 panel paths reach the legacy routes", async () => {
  const r = await call("/v1/panel/adopt");
  expect(r.status).toBe(200);
  expect(((await r.json()) as { phase: string }).phase).toBe("idle");
});

test("agent routes: report and facts are refused when no scan runs", async () => {
  expect((await call("/v1/admin/adopt/report", { summary: "x", findings: [] })).status).toBe(409);
  expect((await call("/v1/admin/adopt/facts")).status).toBe(409);
});

test("scan (static) -> plan -> apply -> rollback restores every byte", async () => {
  const before = snap(ws);
  const s = await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" });
  expect(s.status).toBe(200);
  const st = (await (await call("/v1/panel/adopt")).json()) as { phase: string; scanId: string; report: { findings: { id: string; kind: string }[] } };
  expect(st.phase).toBe("reported");
  expect(st.report.findings.length).toBeGreaterThan(0);
  const picks = Object.fromEntries(st.report.findings.filter((x) => x.kind !== "scheduled-runner").map((x) => [x.id, "apply"]));
  expect((await call("/v1/panel/adopt/plan", { scanId: "scan-nope", picks: { findings: picks } })).status).toBe(409);
  const p = await call("/v1/panel/adopt/plan", { scanId: st.scanId, picks: { findings: picks } });
  expect(p.status).toBe(200);
  const plan = (await p.json()) as { planId: string; ops: unknown[] };
  expect(plan.ops.length).toBeGreaterThan(0);
  expect(snap(ws)).toEqual(before); // preview changes nothing
  expect((await call("/v1/panel/adopt/apply", { planId: "plan-other" })).status).toBe(409);
  const a = await call("/v1/panel/adopt/apply", { planId: plan.planId });
  expect(a.status).toBe(200);
  expect(loadState().phase).toBe("applied");
  expect(started.length).toBe(1);
  expect(snap(ws)).not.toEqual(before);
  const rb = await call("/v1/panel/adopt/rollback", {});
  expect(rb.status).toBe(200);
  expect(snap(ws)).toEqual(before);
  expect(loadState().phase).toBe("rolledback");
});

test("the report the page gets explains each finding and the planned structure", async () => {
  await Bun.sleep(1100);
  await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" });
  const v = (await (await call("/v1/panel/adopt")).json()) as { report: { findings: { id: string; kind: string; change: { before: string; after: string } }[]; after: { director: { name: string }; messaging: string; agents: { name: string; soul: string }[]; stay: { kind: string }[]; off: { kind: string; findingId: string; actionId: string; optional: boolean }[] } } };
  for (const x of v.report.findings) { expect(x.change.before.length).toBeGreaterThan(5); expect(x.change.after.length).toBeGreaterThan(5); }
  const a = v.report.after;
  expect(a.director.name).toBe("root"); expect(a.messaging).toBe("agentnet");
  expect(a.agents.map((x) => x.name).sort()).toEqual(["bff", "chameleon", "e2e", "ios", "kmp"]);
  expect(a.agents[0]!.soul).toBe(`ws/${a.agents[0]!.name}`);
  expect(a.off.some((o) => o.kind === "mcp")).toBe(true);
  expect(a.off.filter((o) => o.kind === "instructions").every((o) => o.optional)).toBe(true);
  expect(a.stay.some((o) => o.kind === "hook")).toBe(false); // the only flagged hook is parked; "Stop" is not a finding
  expect(a.stay.some((o) => o.kind === "instructions")).toBe(true);
  expect(JSON.stringify(v)).not.toContain("sk-live");
});

test("answering the MCP dialog backs up settings.local.json first, Rollback undoes what Claude Code wrote (new and existing file)", async () => {
  await Bun.sleep(1100);
  const { markLaunch, answerDialog, clearLaunch } = await import("./launch");
  const local = join(ws, ".claude", "settings.local.json");
  for (const existing of [false, true]) {
    await Bun.sleep(1100);
    if (existing) writeFileSync(local, '{"mine":1}\n');
    const before = snap(ws);
    await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" });
    const st = (await (await call("/v1/panel/adopt")).json()) as { scanId: string; report: { findings: { id: string }[] } };
    const p = await (await call("/v1/panel/adopt/plan", { scanId: st.scanId, picks: { findings: { [st.report.findings[0]!.id]: "apply" } } })).json() as { planId: string };
    expect((await call("/v1/panel/adopt/apply", { planId: p.planId })).status).toBe(200);
    // a fake pane: single MCP dialog; Enter makes "Claude Code" write the file
    let cursor = 2;
    const screen = () => ["New MCP server found in this project: lint", "  " + (cursor === 0 ? "❯" : " ") + " Use this MCP server", "  " + (cursor === 1 ? "❯" : " ") + " Use this and all future MCP servers in this project", "  " + (cursor === 2 ? "❯" : " ") + " Continue without using this MCP server"].join("\n");
    clearLaunch(); markLaunch("agentnet-root");
    const r = answerDialog("use", { capture: screen, pause: () => {}, keys: (_s, k) => { for (const x of k) { if (x === "Up") cursor--; if (x === "Enter") { mkdirSync(join(ws, ".claude"), { recursive: true }); writeFileSync(local, '{"enabledMcpjsonServers":["lint"]}\n'); } } } });
    expect(r.ok).toBe(true);
    expect(readFileSync(local, "utf8")).toContain("enabledMcpjsonServers");
    expect((await call("/v1/panel/adopt/rollback", {})).status).toBe(200);
    expect(snap(ws)).toEqual(before); // new file removed, existing one back byte for byte
    if (existing) { expect(readFileSync(local, "utf8")).toBe('{"mine":1}\n'); await Bun.$`rm ${local}`; }
  }
});

test("the CLI rollback path (doRollback) also moves the panel state to rolledback (D2)", async () => {
  const { doRollback } = await import("./adopt");
  await Bun.sleep(1100); // run ids are timestamped to the second
  await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" });
  const st = (await (await call("/v1/panel/adopt")).json()) as { scanId: string; report: { findings: { id: string; kind: string }[] } };
  const picks = Object.fromEntries(st.report.findings.filter((x) => x.kind !== "scheduled-runner").map((x) => [x.id, "apply"]));
  const plan = (await (await call("/v1/panel/adopt/plan", { scanId: st.scanId, picks: { findings: picks } })).json()) as { planId: string };
  const ap = await call("/v1/panel/adopt/apply", { planId: plan.planId });
  expect(ap.status).toBe(200);
  expect(loadState().phase).toBe("applied");
  expect(doRollback(undefined, false).ok).toBe(true);
  expect(loadState().phase).toBe("rolledback");
});

test("a second scan while one is running is refused; cancel resets", async () => {
  setState({ phase: "scanning" });
  expect((await call("/v1/panel/adopt/scan", { dir: ws, mode: "static" })).status).toBe(409);
  expect((await call("/v1/panel/adopt/cancel", {})).status).toBe(200);
  expect(loadState().phase).toBe("idle");
});

test("a director scan reports through the stub file and goes through the real validation", async () => {
  const stub = join(tmp, "stub.json");
  writeFileSync(stub, JSON.stringify({ summary: "s", findings: [{ id: "f1", kind: "other", title: "t", about: "a", confidence: "low", risk: "low", agents: [], evidence: [{ signal: "g999", path: ws }], suggestion: "manual", actions: [] }] }));
  process.env.AGENTNET_ADOPT_STUB = stub;
  const r = await call("/v1/panel/adopt/scan", { dir: ws, mode: "director" });
  delete process.env.AGENTNET_ADOPT_STUB;
  expect(r.status).toBe(400); // g999 is not a signal of this scan
  expect(loadState().phase).toBe("idle");
});

test("bad dir is a 400", async () => {
  expect((await call("/v1/panel/adopt/scan", { dir: "rel", mode: "static" })).status).toBe(400);
});

test("openapi lists the adopt routes", () => {
  const y = readFileSync(join(import.meta.dir, "../../spec/openapi.yaml"), "utf8");
  for (const p of ["/v1/panel/adopt:", "/v1/panel/adopt/apply:", "/v1/admin/adopt/report:"]) expect(y).toContain(p);
  expect(existsSync(ws)).toBe(true);
});
