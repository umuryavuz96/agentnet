// Step 7b: the server finishes an agent on its accepted done report. Scratch home, fixture agents, stubbed procs (no real process is
// listed or signalled), an injected clock for the review tick. Spec: docs/internal/one-folder/SPEC-step7b-despawn.md.
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-finish-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { db, useDatabase } = await import("../src/core/db");
const { tracing } = await import("../src/core/http");
type Env = import("../src/core/http").Env;
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sc = await import("../src/net/scores");
const fin = await import("../src/net/finish");
const { openAsks } = await import("../src/net/jobs");
type ProcRow = import("../src/net/finish").ProcRow;

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (p: Response | Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json().catch(() => null) as any }; };

// ---------- the stubbed machine ----------
let table: ProcRow[] = [], panes: Record<string, number[]> = {}, ports: Record<number, number[]> = {};
const signals: [number, string][] = [], killed: string[] = [];
let tableThrows = false;
fin.finishDeps.procs = {
  table: () => { if (tableThrows) throw new Error("injected: process table failed"); return table; },
  panePids: (s) => panes[s] ?? [], portPids: (p) => ports[p] ?? [],
  signal: (pid, sig) => { signals.push([pid, sig]); }, alive: () => true, later: (fn) => fn(), killSession: (s) => { killed.push(s); },
};
const signalled = () => new Set(signals.map((s) => s[0]));
beforeEach(() => { table = []; panes = {}; ports = {}; signals.length = 0; killed.length = 0; tableThrows = false; });

let n = 0;
/** A fixture agent with one job of `steps` steps, live (hello), every step closed with the given proof. Returns its name and id. */
async function agent(o: { standing?: boolean; boss?: string; project?: string; steps?: number; evidence?: (i: number) => string[]; pid?: number } = {}) {
  const name = `fx-${++n}`, made = rt.createAgent({ name, boss: o.boss ?? "root", job: "t", goal: "g", by: "test", project: o.project, standing: o.standing }, Date.now() - 60_000);
  tok[name] = made.token;
  await call(name, "POST", "/hello", { session: `s-${name}`, pid: o.pid ?? 40_000 + n });
  rt.startJob(made.id, { by: "root", goal: "fixture job", steps: Array.from({ length: o.steps ?? 3 }, (_, i) => `outcome ${i + 1}`) });
  return { name, id: made.id };
}
async function closeSteps(name: string, steps = 3, evidence: (i: number) => string[] = () => ["check: bun test 9 pass 0 fail"]) {
  for (let i = 0; i < steps; i++) expect((await call(name, "POST", "/steps/done", { evidence: evidence(i) })).status).toBe(200);
}
const report = (name: string, summary = `Done: ${name} built it.\nMore detail.`, extra: Record<string, unknown> = {}) => j(call(name, "POST", "/report", { summary, state: "done", ...extra }));
const toRoot = () => { const r = rt.byName("root")!; return db().query("SELECT * FROM messages WHERE to_agent IN (?, '@admin') AND from_agent = '@agentnet' ORDER BY id").all(r.id) as { body: string; subject: string }[]; };
const rowOf = (id: string) => sc.jobScoreRow(id, 1)!;

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test", standing: true }).token;
});

test("auto-finish: done report finishes a non-standing agent in the same request", async () => {
  const a = await agent(); await closeSteps(a.name);
  const r = await report(a.name);
  expect(r.status).toBe(200);
  expect(r.body.job_closed).toBe(1);
  expect(r.body.finished).toMatchObject({ provisional: true });
  expect(r.body.finished.grade).toBeGreaterThanOrEqual(1);
  expect((await call(a.name, "POST", "/hello", {})).status).toBe(401); // retired in the same request
  expect(killed).toContain(`agentnet-${a.name}`); // the session stub was called
  expect(rt.byName(a.name)).toBeNull();
});

test("auto-finish: auto grade row is provisional with notes and cost", async () => {
  const a = await agent();
  st.emit({ agent: a.id, type: "TurnEnded", data: { usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 10, model: "claude-sonnet-5-5" } }, source: "hook" }); st.flush();
  await closeSteps(a.name);
  await report(a.name);
  const row = rowOf(a.id);
  expect(row).toMatchObject({ grade_source: "auto", provisional: 1, tokens_in: 120, tokens_out: 30, cache_read: 900, report: `Done: ${a.name} built it.` });
  expect(row.grade).toBeGreaterThanOrEqual(1); expect(row.grade).toBeLessThanOrEqual(5);
  expect(row.note).toBe("auto: 3/3 steps verified, 0 refusals, 0 failed checks");
  expect(row.wall_ms).toBeGreaterThan(0);
  expect(row.tokens).toBe(120 + 30 + 10); // in + out + cache creation, as windowCost counts it
});

test("auto-finish: handlers ran and handover written", async () => {
  const seen: unknown[] = [];
  const off = fin.onDespawn("test", (p) => { seen.push(p); });
  try {
    const a = await agent(); await closeSteps(a.name);
    const r = await report(a.name, "Handover test report body", { gotchas: ["the cache is per process"] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agent: a.name, gen: 1, job: 1, provisional: true, finished: { handover: r.body.finished.handover } });
    const file = join(fin.recordsDir(a.name), "handover-1.md");
    expect(r.body.finished.handover).toBe(file);
    const md = readFileSync(file, "utf8");
    expect(md).toContain("Handover test report body"); expect(md).toContain("the cache is per process");
    expect(fin.handoverFor(a.name)).toContain("Handover test report body"); // the next spawn of the name gets it
  } finally { off(); }
});

test("auto-finish: one AgentFinished event", async () => {
  const a = await agent(); await closeSteps(a.name);
  await report(a.name);
  const ev = st.events(a.id, 0, 500).filter((e) => e.type === "AgentFinished");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.data).toMatchObject({ agent: a.name, gen: 1, job: 1 });
});

test("auto-finish: standing agent stays up after done report", async () => {
  const a = await agent({ standing: true }); await closeSteps(a.name);
  const r = await report(a.name);
  expect(r.status).toBe(200); expect(r.body.finished).toBeUndefined();
  expect((await call(a.name, "POST", "/hello", {})).status).toBe(200);
  expect(st.get(a.id)!.life).toBe("live");
  const row = rowOf(a.id);
  expect(row.grade).toBeNull(); expect(row.grade_source).toBe("root"); expect(row.provisional).toBe(0);
  expect(killed).toEqual([]); expect(signals).toEqual([]);
});

test("auto-finish: finish error keeps the report and the agent", async () => {
  const a = await agent(); await closeSteps(a.name);
  const before = toRoot().length;
  tableThrows = true;
  const r = await report(a.name, "Report that must stay");
  expect(r.status).toBe(200); expect(r.body.finished).toBeUndefined();
  const stored = db().query("SELECT body FROM messages WHERE from_agent = ? AND kind = 'report'").all(a.id) as { body: string }[];
  expect(stored).toHaveLength(1); expect(stored[0]!.body).toContain("Report that must stay");
  expect((await call(a.name, "POST", "/hello", {})).status).toBe(200); // still live: token works
  expect(rt.byName(a.name)).not.toBeNull();
  const msgs = toRoot().slice(before);
  expect(msgs).toHaveLength(1); expect(msgs[0]!.body).toContain(`Auto-finish of ${a.name}`); expect(msgs[0]!.body).toContain("injected");
  expect(rowOf(a.id).grade_source).toBe("root"); // the auto grade is undone: nothing waits for review
  expect(signals).toEqual([]);
});

test("cleanup: env-tagged process outside the pane is stopped", async () => {
  const a = await agent(); await closeSteps(a.name);
  panes[`agentnet-${a.name}`] = [5000];
  table = [
    { pid: 5000, ppid: 1, command: "-zsh", agent: a.name }, { pid: 5001, ppid: 5000, command: "claude", agent: a.name },
    { pid: 7000, ppid: 1, command: "bun run scratch-server.ts --port 3199", agent: a.name }, // nohup'd: not in the pane tree
    { pid: 7100, ppid: 1, command: "unrelated", agent: null },
  ];
  const r = await report(a.name);
  expect(r.body.finished.stopped.map((s: { pid: number }) => s.pid).sort()).toEqual([5000, 5001, 7000]);
  expect(r.body.finished.stopped.find((s: { pid: number }) => s.pid === 7000)).toMatchObject({ command: "bun run scratch-server.ts --port 3199", signal: "SIGTERM" });
  expect(signals).toContainEqual([7000, "SIGTERM"]); expect(signals).toContainEqual([7000, "SIGKILL"]); // alive() stays true in the stub: SIGKILL after the grace
  expect(signalled().has(7100)).toBe(false);
});

test("cleanup: kept process is listed, not signalled", async () => {
  const a = await agent(); await closeSteps(a.name);
  expect((await j(call(a.name, "POST", "/keep", { pid: 8002, reason: "preview server for the owner" }))).status).toBe(200);
  expect((await j(call(a.name, "POST", "/keep", { port: 4555, reason: "docs site" }))).status).toBe(200);
  expect((await call(a.name, "POST", "/keep", { reason: "nothing named" })).status).toBe(422);
  ports[4555] = [8003];
  table = [
    { pid: 8001, ppid: 1, command: "watcher", agent: a.name, keep: true }, // AGENTNET_KEEP=1
    { pid: 8002, ppid: 1, command: "preview", agent: a.name },
    { pid: 8003, ppid: 1, command: "docs", agent: a.name },
    { pid: 8004, ppid: 1, command: "build", agent: a.name },
  ];
  const r = await report(a.name);
  const kept = r.body.finished.kept as { pid: number; reason: string; port?: number }[];
  expect(kept.map((k) => k.pid).sort()).toEqual([8001, 8002, 8003]);
  expect(kept.find((k) => k.pid === 8001)!.reason).toBe("AGENTNET_KEEP=1");
  expect(kept.find((k) => k.pid === 8002)!.reason).toBe("preview server for the owner");
  expect(kept.find((k) => k.pid === 8003)).toMatchObject({ reason: "docs site", port: 4555 });
  for (const p of [8001, 8002, 8003]) expect(signalled().has(p)).toBe(false);
  expect(signalled().has(8004)).toBe(true);
});

test("cleanup: other agents and the server are never signalled", async () => {
  const other = await agent();
  const a = await agent({ pid: 9100 }); await closeSteps(a.name);
  const rootPid = 9900; await call("root", "POST", "/hello", { session: "s-root", pid: rootPid });
  panes[`agentnet-${a.name}`] = [9100];
  panes[`agentnet-${other.name}`] = [9200];
  table = [
    { pid: 9100, ppid: 1, command: "claude", agent: a.name },
    { pid: process.pid, ppid: 1, command: "agentnet serve", agent: a.name }, // the server started from the agent's shell
    { pid: rootPid, ppid: 1, command: "claude (root)", agent: a.name },
    { pid: 1, ppid: 0, command: "launchd", agent: a.name },
    { pid: 9200, ppid: 1, command: "claude (other)", agent: other.name }, { pid: 9201, ppid: 9200, command: "bun x", agent: a.name }, // in the other agent's pane tree
  ];
  const r = await report(a.name);
  expect(r.body.finished.stopped.map((s: { pid: number }) => s.pid)).toEqual([9100]);
  for (const p of [process.pid, rootPid, 1, 9200, 9201]) expect(signalled().has(p)).toBe(false);
  expect(killed).toEqual([`agentnet-${a.name}`]);
});

test("warnings: dirty repo warns and dependents get one message", async () => {
  const repo = mkdtempSync(join(tmpdir(), "an-finish-repo-"));
  for (const c of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"]]) Bun.spawnSync(["git", "-C", repo, ...c]);
  writeFileSync(join(repo, "a.txt"), "1"); Bun.spawnSync(["git", "-C", repo, "add", "."]); Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "init"]);
  writeFileSync(join(repo, "a.txt"), "2"); writeFileSync(join(repo, "b.txt"), "new");
  const boss = await agent({ standing: true });
  const x = await agent({ boss: boss.name, project: repo, steps: 2 });
  const y = await agent({ boss: x.name, standing: true }); // works for x: holds an open ask FROM x
  await call(x.name, "POST", "/send", { to: y.name, body: "build the parser", kind: "task" });
  await call("root", "POST", "/send", { to: x.name, body: "also check the logs", kind: "task" }); // root waits on x: an open ask TO x
  await call(boss.name, "POST", "/send", { to: x.name, body: "ship it", kind: "task" }); // the boss gets the report, not a second message
  expect(openAsks(st.get(y.id)!).map((k) => k.from)).toEqual([x.name]);
  await closeSteps(x.name, 2, (i) => (i === 1 ? ["commit: abc1234", "check: bun test 3 pass 0 fail"] : ["check: bun test 3 pass 0 fail"]));
  const r = await report(x.name, "Parser shipped");
  expect(r.body.finished.warnings).toContain(`${repo}: 2 uncommitted files`);
  expect(readFileSync(r.body.finished.handover, "utf8")).toContain("2 uncommitted files");
  const sent = db().query("SELECT to_agent, body FROM messages WHERE from_agent = ? AND kind != 'report' AND body LIKE ?").all(x.id, `${x.name} finished.%`) as { to_agent: string; body: string }[];
  const to = sent.map((m) => m.to_agent).sort();
  expect(to).toEqual([rt.byName("root")!.id, y.id].sort()); // one each: root (its ask was open), y (holds x's ask); never the boss
  expect(new Set(to).size).toBe(to.length);
  const toY = sent.find((m) => m.to_agent === y.id)!.body;
  expect(toY).toContain(`${x.name} finished. Last commit `); expect(toY).toContain("Report: Parser shipped"); expect(toY).toContain("no answer is needed");
  expect(openAsks(st.get(y.id)!)).toEqual([]);
  expect(r.body.finished.told.sort()).toEqual(["root", y.name].sort());
});

test("handlers: throwing and slow handlers do not block", async () => {
  const ran: string[] = [];
  const offs = [
    fin.onDespawn("throws", () => { ran.push("throws"); throw new Error("boom"); }),
    fin.onDespawn("slow", () => { ran.push("slow"); return new Promise((res) => setTimeout(res, 10_000)); }, { timeoutMs: 50 }),
    fin.onDespawn("after", () => { ran.push("after"); }),
  ];
  try {
    const a = await agent(); await closeSteps(a.name);
    const t0 = performance.now();
    const r = await report(a.name);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.body.finished).toBeDefined();
    expect(ran).toEqual(["throws", "slow", "after"]);
    expect(rt.byName(a.name)).toBeNull();
  } finally { for (const o of offs) o(); }
});

test("autoGrade maps hard signals to 1-5", () => {
  const cases: [import("../src/net/finish").Signals, number][] = [
    [{ steps: 5, verified: 5, refusals: 0, failedChecks: 0 }, 5],
    [{ steps: 5, verified: 4, refusals: 0, failedChecks: 0 }, 4],
    [{ steps: 4, verified: 2, refusals: 0, failedChecks: 0 }, 3],
    [{ steps: 5, verified: 1, refusals: 0, failedChecks: 0 }, 1],
    [{ steps: 5, verified: 2, refusals: 0, failedChecks: 0 }, 2],
    [{ steps: 5, verified: 5, refusals: 2, failedChecks: 0 }, 4],
    [{ steps: 5, verified: 5, refusals: 6, failedChecks: 0 }, 3],
    [{ steps: 5, verified: 5, refusals: 0, failedChecks: 1 }, 4],
    [{ steps: 5, verified: 0, refusals: 9, failedChecks: 3 }, 1],
  ];
  for (const [s, g] of cases) expect([s, fin.autoGrade(s)]).toEqual([s, g]);
  for (const s of cases.map((c) => c[0])) { const g = fin.autoGrade(s); expect(g).toBeGreaterThanOrEqual(1); expect(g).toBeLessThanOrEqual(5); }
  expect(fin.autoGrade({ steps: 5, verified: 1, refusals: 0, failedChecks: 0 })).toBeLessThanOrEqual(2); // mostly not verified
  const base = { steps: 4, verified: 4, refusals: 0, failedChecks: 0 };
  expect(fin.autoGrade({ ...base, failedChecks: 1 })).toBeLessThanOrEqual(fin.autoGrade(base) - 1);
  expect(fin.signalNote(base)).toBe("auto: 4/4 steps verified, 0 refusals, 0 failed checks");
});

// Step 8b.1 (root msgs 7330, 7332): an `expected:` line keeps a failed check of the SAME step out of the grade; Refused always counts.
const FORGED = "check: forged curl proof refused: 10 pass 1 fail";
async function signalsFor(evidence: (i: number) => string[], refused: string[] = []) {
  const a = await agent(); await closeSteps(a.name, 3, evidence);
  for (const rule of refused) st.emit({ agent: a.id, type: "Refused", data: { rule, detail: `x ${rule}` }, source: "service" });
  st.flush();
  const { openJob } = await import("../src/net/jobs");
  return fin.signalsOf(a.id, openJob(st.get(a.id)!)!);
}
test("auto grade: failed check named by expected: in the same step does not lower the grade", async () => {
  const s = await signalsFor((i) => i === 1 ? ["check: bun test 9 pass 0 fail", FORGED, "expected: forged curl proof refused"] : ["check: bun test 9 pass 0 fail"]);
  expect(s).toMatchObject({ steps: 3, verified: 3, refusals: 0, failedChecks: 0, expected: 1 });
  expect(fin.autoGrade(s)).toBe(5);
  expect(fin.signalNote(s)).toBe("auto: 3/3 steps verified, 0 refusals, 0 failed checks, 1 expected");
  // a too-short expected: ("fail") names nothing
  const short = await signalsFor((i) => i === 1 ? ["check: bun test 9 pass 0 fail", FORGED, "expected: fail"] : ["check: bun test 9 pass 0 fail"]);
  expect(short.failedChecks).toBe(1); expect(fin.autoGrade(short)).toBe(4);
});
test("auto grade: a Refused event named in expected: still counts", async () => {
  const s = await signalsFor((i) => ["check: bun test 9 pass 0 fail", "expected: refused step-proof and refused report-first"].slice(0, i === 0 ? 2 : 1), ["step-proof", "report-first"]);
  expect(s.refusals).toBe(2); expect(s.expected ?? 0).toBe(0);
  expect(fin.autoGrade(s)).toBe(4);
});
test("auto grade: expected: on another step excludes nothing", async () => {
  const s = await signalsFor((i) => i === 0 ? ["check: bun test 9 pass 0 fail", "expected: forged curl proof refused"] : i === 1 ? ["check: bun test 9 pass 0 fail", FORGED] : ["check: bun test 9 pass 0 fail"]);
  expect(s.failedChecks).toBe(1); expect(s.expected ?? 0).toBe(0);
  expect(fin.autoGrade(s)).toBe(4);
});

test("review: ping only when the bucket is not empty", async () => {
  sc.useScoreDb(new Database(":memory:")); fin._resetReviewPing();
  const pings = () => toRoot().filter((m) => m.subject.startsWith("review:"));
  const t0 = Date.now(), M = 60_000, before = pings().length;
  for (const t of [0, 3, 9, 10, 25]) expect(fin.reviewTick(t0 + t * M)).toBe(false);
  expect(pings().length).toBe(before);
  const a = await agent(); await closeSteps(a.name, 3, (i) => [i ? "check: bun test 1 pass 0 fail" : "none: nothing to show"]);
  await report(a.name, "Finished the review fixture\nsecond line");
  const g = rowOf(a.id).grade;
  const T = Date.now() + 2 * M;
  expect([0, 3, 9].map((t) => fin.reviewTick(T + t * M))).toEqual([true, false, false]);
  expect(pings().length).toBe(before + 1);
  expect(fin.reviewTick(T + 10 * M)).toBe(true);
  expect(pings().length).toBe(before + 2);
  const body = pings().at(-1)!.body;
  expect(body).toContain(`${a.name} gen 1 job 1: auto ${g}/5, "Finished the review fixture"`);
  expect(body).toMatch(/, 1[12] min/); // its age at the 10-minute tick
  expect(body).not.toContain("second line");
});

test("review: confirm and root grade both empty the bucket and fire onRegrade", async () => {
  sc.useScoreDb(new Database(":memory:")); fin._resetReviewPing();
  const seen: import("../src/net/scores").Regrade[] = [];
  const off = sc.onRegrade((r) => { seen.push(r); });
  try {
    const a = await agent(); await closeSteps(a.name); await report(a.name);
    const b = await agent(); await closeSteps(b.name); await report(b.name);
    const auto = rowOf(b.id).grade;
    expect((await j(call("root", "GET", "/review"))).body.items.map((i: { agent: string }) => i.agent)).toEqual([a.name, b.name]);
    expect((await call(a.name, "GET", "/review")).status).toBe(401); // retired token; a live non-root gets 403
    const c = await j(call("root", "POST", `/agents/${a.name}/confirm`, { gen: 1, note: "looked at the diff" }));
    expect(c.status).toBe(200);
    expect(rowOf(a.id)).toMatchObject({ grade_source: "root-confirmed", provisional: 0 });
    expect(rowOf(a.id).note).toContain("looked at the diff");
    expect((await j(call("root", "POST", `/agents/${b.name}/grade`, { grade: 2, note: "missed the spec" }))).status).toBe(200);
    expect(rowOf(b.id)).toMatchObject({ grade_source: "root", provisional: 0, grade: 2 });
    expect(rowOf(b.id).note).toContain(`auto was ${auto}`); expect(rowOf(b.id).note).toContain("missed the spec");
    expect(seen.map((r) => [r.agent, r.source])).toEqual([[a.name, "root-confirmed"], [b.name, "root"]]);
    expect((await j(call("root", "GET", "/review"))).body.items).toEqual([]);
    expect((await call("root", "POST", `/agents/${a.name}/confirm`, { gen: 1 })).status).toBe(404); // nothing left to confirm
    expect(fin.reviewTick(Date.now())).toBe(false);
    const live = await agent({ standing: true });
    expect((await call(live.name, "GET", "/review")).status).toBe(403);
  } finally { off(); }
});

test("handover: the boot prompt of the next spawn gets it after the trails", async () => {
  const a = await agent(); await closeSteps(a.name); await report(a.name, "Notes for my successor");
  expect(existsSync(join(fin.recordsDir(a.name), "handover-1.md"))).toBe(true);
  const r = await j(call("root", "GET", `/agents/${a.name}/handover`));
  expect(r.status).toBe(200); expect(r.body.text).toContain("Notes for my successor");
  const other = await agent({ standing: true });
  expect((await call(other.name, "GET", `/agents/${a.name}/handover`)).status).toBe(403); // root only
  expect((await call("root", "GET", "/agents/no-such-1/handover")).status).toBe(204);
  const ti = await j(call("root", "POST", "/trail/inject", { agent: a.name, text: "continue the parser" }));
  expect(ti.status).toBe(200); expect(ti.body.text ?? "").not.toContain("Notes for my successor"); // not added twice: spawn-agent.sh fetches it on its own
  expect(Buffer.byteLength(fin.handoverFor(a.name))).toBeLessThanOrEqual(2000);
});
