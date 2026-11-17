import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-disc-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { db, useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const sc = await import("./scores");
const d = await import("./discipline");
const jb = await import("./jobs");
const { ROOT } = await import("../core/config"); // the data folder the first test file of the run set
type JobFacts = import("./discipline").JobFacts;

const facts = (o: Partial<JobFacts> = {}): JobFacts => ({ agent: "a-1", closedAt: Date.now(), steps: 4, done: 4, added: 0, dropped: 0, openAtClose: 0, noWork: 0, verified: 4, ...o });

describe("discipline math", () => {
  test("a clean job passes every check", () => {
    const x = d.disciplineOf([facts()]);
    expect(x).toEqual({ jobs: 1, steps: 4, score: 100, checks: { workSeen: 100, evidence: 100, planKept: 100, notDropped: 100, closed: 100 } });
  });
  test("the five numbers: work seen, verified proof, plan kept, not dropped, closed", () => {
    const x = d.disciplineOf([facts({ steps: 10, done: 8, added: 2, dropped: 1, openAtClose: 1, noWork: 2, verified: 4 })]);
    expect(x.checks).toEqual({ workSeen: 75, evidence: 50, planKept: 80, notDropped: 90, closed: 90 });
    expect(x.score).toBe(77);
  });
  test("no step = no score; a job with nothing done has no work or proof number", () => {
    expect(d.disciplineOf([]).score).toBeNull();
    const x = d.disciplineOf([facts({ steps: 2, done: 0, openAtClose: 2, verified: 0 })]);
    expect(x.checks).toEqual({ workSeen: null, evidence: null, planKept: 100, notDropped: 100, closed: 0 });
    expect(x.score).toBe(67);
  });
  test("gate: grace, exempt, no plan, a plan, switched off", () => {
    const cfg = { ...d.DEFAULTS }, base = { exempt: false, spawnedAt: 0, hasPlan: false, now: 600_000 };
    expect(d.gateReason({ ...base, now: 60_000 }, cfg)).toBeNull();
    expect(d.gateReason({ ...base, exempt: true }, cfg)).toBeNull();
    expect(d.gateReason(base, cfg)).toContain("mcp__agentnet__plan_set");
    expect(d.gateReason({ ...base, hasPlan: true }, cfg)).toBeNull();
    expect(d.gateReason(base, { ...cfg, workGate: false })).toBeNull();
  });
  test("daily rows pool agents per local day and keep per-agent scores", () => {
    const rows = d.dailyRows([facts(), facts({ agent: "b-1", verified: 0 })]);
    expect(rows).toHaveLength(1); expect(rows[0]!.jobs).toBe(2); expect(rows[0]!.steps).toBe(8);
    expect(rows[0]!.agents["a-1"]!.score).toBe(100); expect(rows[0]!.agents["b-1"]!.score).toBe(80); expect(rows[0]!.score).toBe(90);
  });
});

const api = new Hono<Env>(); rt.agentnetRoutes(api); sc.agentnetScoreRoutes(api);
const app = new Hono<Env>(); app.use("*", tracing); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const job = (name: string, gen = 1) => st.get(`${name}#${gen}`)!.jobs!.at(-1)!;
const refused = (name: string) => st.events(`${name}#1`, 0, 500).filter((e) => e.type === "Refused").map((e) => e.data.rule);
const REPO = join(import.meta.dir, "..", ".."), HEAD = new TextDecoder().decode(Bun.spawnSync(["git", "-C", REPO, "rev-parse", "HEAD"]).stdout).trim();
let prev: string | undefined;
const spawn = (name: string, o: { boss?: string; at?: number; project?: string } = {}) => { tok[name] = rt.createAgent({ name, boss: o.boss ?? "root", job: "t", goal: "g", by: "test", project: o.project }, o.at ?? Date.now() - 3600_000).token; };
beforeAll(() => {
  prev = process.env.AGENTNET_TASK_STRICT; process.env.AGENTNET_TASK_STRICT = "1";
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test" }).token;
  spawn("be-1", { project: REPO }); spawn("peer-1"); spawn("old-1"); spawn("gone-1"); spawn("grow-1");
  spawn("fresh-1", { at: Date.now() }); // inside the grace time
});
afterAll(() => { if (prev === undefined) delete process.env.AGENTNET_TASK_STRICT; else process.env.AGENTNET_TASK_STRICT = prev; });

describe("the plan over the API", () => {
  test("gate: no plan is refused and logged; a plan opens it; root and a fresh agent are exempt", async () => {
    const g = (await j(await call("be-1", "GET", "/gate"))).body;
    expect(g.allow).toBe(false); expect(g.reason).toContain("you have no plan yet");
    await call("be-1", "GET", "/gate"); // the same minute: logged once
    expect(refused("be-1")).toEqual(["gate"]);
    expect((await j(await call("root", "GET", "/gate"))).body.allow).toBe(true);
    expect((await j(await call("fresh-1", "GET", "/gate"))).body.allow).toBe(true);
    for (const p of ["/gate", "/plan", "/steps", "/steps/done", "/steps/3/drop", "/jobs", "/agents/be-1/asks/7/close"]) expect(rt.agentPath(`/api/v1/agentnet${p}`)).toBe(true);
    expect(rt.agentPath("/api/v1/agentnet/steps/x/drop")).toBe(false);
  });
  test("plan_set: at most 7, step 1 active, ceremony warned, one adjust", async () => {
    const over = await j(await call("be-1", "POST", "/plan", { steps: Array.from({ length: 8 }, (_, i) => `s${i}`) }));
    expect(over.status).toBe(409); expect(over.body.detail).toContain("at most 7 steps and this has 8");
    const r = await j(await call("be-1", "POST", "/plan", { steps: ["build the store", "build the routes", "Final report to root"] }));
    expect(r.status).toBe(200); expect(r.body.next).toBe("1.1: build the store"); expect(r.body.warnings[0]).toContain('"Final report to root" looks like a chore');
    expect((await j(await call("be-1", "GET", "/gate"))).body.allow).toBe(true);
    const adj = await j(await call("be-1", "POST", "/plan", { steps: ["build the store", "build the routes", "build the tools"] }));
    expect(adj.status).toBe(200); expect(adj.body.warnings).toBeUndefined();
    expect(job("be-1")).toMatchObject({ id: 1, plan: 3, planSets: 2, openedBy: "be-1" });
    const third = await j(await call("be-1", "POST", "/plan", { steps: ["a"] }));
    expect(third.status).toBe(409); expect(third.body.detail).toContain("set and adjusted once already");
    expect(refused("be-1")).toEqual(["gate", "plan", "plan"]);
  });
  test("step_done needs evidence; a real commit is verified, a made-up one is stored as not found", async () => {
    const none = await j(await call("be-1", "POST", "/steps/done", {}));
    expect(none.status).toBe(422); expect(none.body.detail).toContain("needs proof that step 1.1 is done");
    expect((await call("be-1", "POST", "/steps/done", { evidence: ["trust me"] })).status).toBe(422);
    st.emit({ agent: "be-1#1", type: "ToolFinished", data: { tool: "Edit", tool_use_id: "w1" }, source: "mod" }); st.emit({ agent: "be-1#1", type: "TurnEnded", data: {}, source: "mod" }); st.flush();
    const ok = await j(await call("be-1", "POST", "/steps/done", { evidence: [`commit: ${HEAD.slice(0, 10)}`, "check: bun test 34 pass 0 fail"], note: "store built" }));
    expect(ok.status).toBe(200); expect(ok.body.closed).toBe("1.1"); expect(ok.body.next).toBe("1.2: build the routes");
    expect(ok.body.evidence).toEqual([{ kind: "commit", value: HEAD.slice(0, 10), ok: true }, { kind: "check", value: "bun test 34 pass 0 fail", ok: true }]);
    expect(job("be-1").steps[0]).toMatchObject({ status: "done", workCalls: 1, note: "store built" });
    const fake = await j(await call("be-1", "POST", "/steps/done", { evidence: ["commit: deadbeef1234", "file: no/such/file.ts", "check: 3 fail"] }));
    expect(fake.status).toBe(200); expect(fake.body.evidence.map((e: { ok: unknown }) => e.ok)).toEqual([false, false, false]); expect(fake.body.warnings[0]).toContain("not found: commit deadbeef1234");
    expect(jb.jobCounts(job("be-1"))).toMatchObject({ done: 2, verified: 1, noWork: 1 });
  });
  test("step_add: a boss message id or self; two of your own; the ask it came from is closed", async () => {
    const m = (await j(await call("root", "POST", "/send", { to: "be-1", body: "also add an export", kind: "task", subject: "export" }))).body.msg_id;
    const p = (await j(await call("peer-1", "POST", "/send", { to: "be-1", body: "do my thing", kind: "task" }))).body.msg_id;
    expect(st.get("be-1#1")!.asks!.map((a) => [a.id, a.closedAt])).toEqual([[m, null]]); // a peer's task message is not an ask
    const bad = await j(await call("be-1", "POST", "/steps", { text: "peer scope", because: p }));
    expect(bad.status).toBe(422); expect(bad.body.detail).toContain("from your boss or root");
    expect((await call("be-1", "POST", "/steps", { text: "export", because: m })).status).toBe(200);
    expect(job("be-1").steps.at(-1)).toMatchObject({ n: 4, added: true, after: 3, origin: "boss", originMsg: m });
    expect(st.get("be-1#1")!.asks![0]).toMatchObject({ closedBy: "step", step: 4 });
    expect((await call("be-1", "POST", "/steps", { text: "own 1", because: "self" })).status).toBe(200);
    expect((await call("be-1", "POST", "/steps", { text: "own 2" })).status).toBe(200);
    const third = await j(await call("be-1", "POST", "/steps", { text: "own 3", because: "self" }));
    expect(third.status).toBe(409); expect(third.body.detail).toContain("2 steps of your own");
    expect(job("be-1").plan).toBe(3); expect(jb.jobCounts(job("be-1"))).toMatchObject({ added: 3, selfAdded: 2 });
  });
  test("a follow-up ask closes with reply_to, or root closes it", async () => {
    const m1 = (await j(await call("root", "POST", "/send", { to: "be-1", body: "the header is cut", kind: "task" }))).body.msg_id;
    const m2 = (await j(await call("root", "POST", "/send", { to: "be-1", body: "and the footer", kind: "task" }))).body.msg_id;
    await call("be-1", "POST", "/send", { to: "root", body: "fixed in abc", kind: "answer", reply_to: m1 });
    expect(jb.openAsks(st.get("be-1#1")!).map((a) => a.id)).toEqual([m2]);
    expect((await call("be-1", "POST", `/agents/be-1/asks/${m2}/close`)).status).toBe(403);
    expect((await call("root", "POST", `/agents/be-1/asks/${m2}/close`)).status).toBe(200);
    expect(st.get("be-1#1")!.asks!.find((a) => a.id === m2)).toMatchObject({ closedBy: "root" });
  });
  test("the old tools on a planned job: add is a step_add, start does nothing, done closes with 'none: old tool'; the built-in todo list stays out", async () => {
    const add = await j(await call("be-1", "POST", "/tasks", { titles: ["own 3 by the old tool"] }));
    expect(add.status).toBe(409); expect(add.body.detail).toContain("2 steps of your own");
    expect((await call("be-1", "POST", "/tasks/3/start")).status).toBe(200);
    expect(job("be-1").steps.find((x) => x.status === "active")!.n).toBe(3);
    await call("be-1", "POST", "/events", { events: [{ type: "TaskAdded", data: { text: "todo list item" } }] });
    expect(job("be-1").steps).toHaveLength(6);
    const done = await j(await call("be-1", "POST", "/tasks/3/done", {}));
    expect(done.status).toBe(200); expect(job("be-1").steps[2]).toMatchObject({ status: "done", evidence: [{ kind: "none", value: "old tool", ok: null }] });
    expect(job("be-1").steps.find((x) => x.status === "active")!.n).toBe(4); // the step added while 3 was active runs next
  });
  test("step_drop needs a reason; the report is refused while steps are open, then closes the job with the plan summary", async () => {
    expect((await call("be-1", "POST", "/steps/5/drop", {})).status).toBe(422);
    expect((await call("be-1", "POST", "/steps/5/drop", { reason: "not needed after all" })).status).toBe(200);
    expect((await call("be-1", "POST", "/steps/9/drop", { reason: "x" })).status).toBe(404);
    const early = await j(await call("be-1", "POST", "/report", { summary: "all done", state: "done" }));
    expect(early.status).toBe(409); expect(early.body.detail).toContain("cannot report done while 2 steps are open (1.4, 1.6)");
    expect((await call("be-1", "POST", "/report", { summary: "halfway", state: "progress" })).status).toBe(200);
    await call("be-1", "POST", "/steps/done", { evidence: ["none: checked by hand"] });
    await call("be-1", "POST", "/steps/done", { evidence: [`commit: ${HEAD}`] });
    expect((await j(await call("be-1", "POST", "/steps/done", { evidence: ["none: x"] }))).body.detail).toContain("Every step is closed");
    const r = await j(await call("be-1", "POST", "/report", { summary: "all done", state: "done" }));
    expect(r.status).toBe(200); expect(r.body.job_closed).toBe(1);
    const text = (db().query("SELECT body FROM messages WHERE id = ?").get(r.body.msg_id) as { body: string }).body;
    expect(text).toStartWith("all done\n\nPlan of job 1: 3/3 done, +3 added, 1 dropped\n1.1 done: build the store [commit ");
    expect(text).toContain("1.5 dropped: own 1 (added, self) (not needed after all)");
    expect(job("be-1")).toMatchObject({ closedAt: expect.any(Number), outcome: "done" });
    const after = await j(await call("be-1", "POST", "/plan", { steps: ["more"] }));
    expect(after.status).toBe(409); expect(after.body.detail).toContain("your job is closed");
    expect(refused("be-1")).toEqual(["gate", "plan", "plan", "evidence", "evidence", "because", "self-cap", "self-cap", "drop-reason", "no-step", "report-open-steps", "no-step", "job-closed"]);
  });
  test("job_open: boss or root, only when the old job is closed; the plan comes from the steps or the brief; max_steps lifts the plan cap", async () => {
    expect((await call("peer-1", "POST", "/jobs", { agent: "be-1", goal: "x" })).status).toBe(403);
    expect((await call("root", "POST", "/jobs", { agent: "be-1" })).status).toBe(422);
    const brief = join(mkdtempSync(join(tmpdir(), "sd-brief-")), "BRIEF.md");
    writeFileSync(brief, "# Round two\n\n## Steps\n1. Fix the header\n2. Fix the footer\n\n## Rules\n1. no push\n");
    const r = await j(await call("root", "POST", "/jobs", { agent: "be-1", goal: "round two is on the page", brief }));
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ agent: "be-1", job: 2, steps: 2 });
    expect(job("be-1")).toMatchObject({ id: 2, goal: "round two is on the page", brief, openedBy: "root", plan: 2 });
    expect(job("be-1").steps.map((x) => [x.text, x.origin, x.status])).toEqual([["Fix the header", "brief", "active"], ["Fix the footer", "brief", "pending"]]);
    expect(st.get("be-1#1")!.tasks.map((t) => t.text)).toEqual(["Fix the header", "Fix the footer"]);
    const twice = await j(await call("root", "POST", "/jobs", { agent: "be-1", goal: "three" }));
    expect(twice.status).toBe(409); expect(twice.body.detail).toContain("job 2 of be-1 is still open");
    const nine = await j(await call("root", "POST", "/jobs", { agent: "peer-1", goal: "long recipe", steps: Array.from({ length: 9 }, (_, i) => `s${i}`) }));
    expect(nine.body.steps).toBe(0); expect(nine.body.warnings[0]).toContain("has 9 steps and a plan has at most 7");
    expect((await call("peer-1", "POST", "/report", { summary: "nothing to do", state: "failed" })).status).toBe(200); // a failed report closes it
    const lifted = await j(await call("root", "POST", "/jobs", { agent: "peer-1", goal: "long recipe", steps: Array.from({ length: 9 }, (_, i) => `s${i}`), max_steps: 9 }));
    expect(lifted.body.steps).toBe(9); expect(job("peer-1")).toMatchObject({ id: 2, plan: 9, planMax: 9 });
  });
  test("the cap: 12 steps in total, and root hears once when the plan grew by more than half", async () => {
    await call("grow-1", "POST", "/plan", { steps: ["a", "b"] });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push((await j(await call("root", "POST", "/send", { to: "grow-1", body: `more ${i}`, kind: "task" }))).body.msg_id);
    for (let i = 0; i < 10; i++) expect((await call("grow-1", "POST", "/steps", { text: `more ${i}`, because: ids[i] })).status).toBe(200);
    const r = await j(await call("grow-1", "POST", "/steps", { text: "the 13th", because: ids[0] }));
    expect(r.status).toBe(409); expect(r.body.detail).toContain("this job has 12 steps and the cap is 12");
    const warned = db().query("SELECT body FROM messages WHERE body LIKE 'The plan of grow-1%'").all() as { body: string }[];
    expect(warned).toHaveLength(1); expect(warned[0]!.body).toContain("2 steps in the plan, 2 added since");
  });
  test("an agent that still uses the old tools: no cap, start and done as before, the done report closes its job", async () => {
    st.emit({ agent: "old-1#1", type: "TaskAdded", data: { text: "t1" }, source: "mcp" }); st.flush(); // its list is from before the plan tools
    const add = await j(await call("old-1", "POST", "/tasks", { titles: Array.from({ length: 14 }, (_, i) => `t${i + 2}`) }));
    expect(add.status).toBe(200); expect(add.body.tasks).toHaveLength(15);
    expect(job("old-1")).toMatchObject({ legacy: true, plan: 15, openedBy: "old tool" });
    await call("old-1", "POST", "/events", { events: [{ type: "TaskAdded", data: { text: "from the built-in todo list" } }] }); // still mirrored on an old list
    expect(st.get("old-1#1")!.tasks).toHaveLength(16); await call("old-1", "POST", "/tasks/16/done", {});
    expect((await j(await call("old-1", "GET", "/gate"))).body.allow).toBe(true);
    expect((await j(await call("old-1", "POST", "/tasks/2/start"))).body.tasks[1].status).toBe("in_progress");
    expect((await j(await call("old-1", "POST", "/tasks/3/done", {}))).body.tasks[2].status).toBe("done"); // never started: allowed
    expect((await j(await call("old-1", "POST", "/report", { summary: "done", state: "done" }))).body.detail).toContain("Finish them with mcp__agentnet__task_done first");
    for (let i = 1; i <= 15; i++) await call("old-1", "POST", `/tasks/${i}/done`, {});
    const r = await j(await call("old-1", "POST", "/report", { summary: "done", state: "done" }));
    expect(r.status).toBe(200); expect(r.body.job_closed).toBe(1);
    expect((db().query("SELECT body FROM messages WHERE id = ?").get(r.body.msg_id) as { body: string }).body).toBe("done"); // no plan summary on an old list
    await call("old-1", "POST", "/tasks", { titles: ["a second round"] });
    expect(job("old-1")).toMatchObject({ id: 2, legacy: true }); expect(st.get("old-1#1")!.tasks).toHaveLength(1);
  });
  test("the old names are not a way around the plan: a first task_add is the plan, and a closed job is not reopened", async () => {
    spawn("new-1");
    await call("new-1", "POST", "/events", { events: [{ type: "TaskAdded", data: { text: "built-in todo" } }] });
    expect(st.get("new-1#1")!.jobs ?? []).toHaveLength(0); // the built-in todo list opens nothing
    const over = await j(await call("new-1", "POST", "/tasks", { titles: Array.from({ length: 8 }, (_, i) => `t${i}`) }));
    expect(over.status).toBe(409); expect(over.body.detail).toContain("at most 7 steps");
    expect((await call("new-1", "POST", "/tasks", { titles: ["one", "two"] })).status).toBe(200);
    expect(job("new-1")).toMatchObject({ plan: 2, openedBy: "new-1" }); expect(job("new-1").legacy).toBeUndefined();
    await call("new-1", "POST", "/tasks/1/done", {}); await call("new-1", "POST", "/tasks/2/done", {});
    expect((await call("new-1", "POST", "/report", { summary: "done", state: "done" })).status).toBe(200);
    const mine = await j(await call("root", "POST", "/tasks", { titles: Array.from({ length: 15 }, (_, i) => `r${i}`) })); // root has no job that closes: its list stays a plain list
    expect(mine.status).toBe(200); expect(mine.body.tasks).toHaveLength(15); expect(job("root")).toMatchObject({ legacy: true });
    const again = await j(await call("new-1", "POST", "/tasks", { titles: ["three"] }));
    expect(again.status).toBe(409); expect(again.body.detail).toContain("the job of new-1 is closed");
  });
  test("despawn closes the job: open steps are left open on the record, root is warned", async () => {
    await call("gone-1", "POST", "/plan", { steps: ["one", "two", "three"] });
    await call("gone-1", "POST", "/steps/done", { evidence: ["none: x"] });
    const r = await j(await call("root", "POST", "/despawn", { agent: "gone-1" }));
    expect(r.status).toBe(200); expect(r.body.state).toBe("gone"); expect(r.body.warning).toContain("despawned with 2 open tasks"); expect(r.body.open_tasks).toEqual([2, 3]);
    expect(job("gone-1")).toMatchObject({ outcome: "dropped", closedAt: expect.any(Number) });
    expect(job("gone-1").steps.map((x) => [x.status, x.unfinished, x.reason])).toEqual([["done", undefined, undefined], ["dropped", true, "despawn: unfinished"], ["dropped", true, "despawn"]]);
    const rows = (await j(await app.request("/api/v1/agentnet/agents/gone-1/tasks"))).body.jobs;
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ agent_id: "gone-1#1", job: 1, outcome: "dropped", steps: 3, done: 1, open_at_close: 2, dropped: 0 });
  });
  test("config switches turn the gate and the report rule off", async () => {
    const fs = await import("node:fs");
    fs.mkdirSync(join(ROOT, "config"), { recursive: true });
    fs.writeFileSync(join(ROOT, "config", "task-discipline.json"), JSON.stringify({ workGate: false, blockDoneReport: false }));
    try {
      spawn("off-1");
      expect((await j(await call("off-1", "GET", "/gate"))).body.allow).toBe(true);
      await call("off-1", "POST", "/plan", { steps: ["x", "y"] });
      expect((await call("off-1", "POST", "/report", { summary: "done", state: "done" })).status).toBe(200);
      expect(job("off-1").steps.map((x) => x.unfinished)).toEqual([true, true]);
    } finally { fs.rmSync(join(ROOT, "config", "task-discipline.json")); }
  });
});

describe("the numbers", () => {
  test("a closed job gives the five numbers; jobs made with the old tools are left out; the snapshot file is written", async () => {
    const s = sc.agentScore("be-1"); // job 1: 6 steps, 5 done (1 with no work seen... the fold counted one Edit), 3 added, 1 dropped
    expect(s.discipline).toMatchObject({ jobs: 1, steps: 6 });
    expect(s.discipline.checks).toEqual({ workSeen: 20, evidence: 40, planKept: 50, notDropped: 83, closed: 100 });
    expect(s.discipline.score).toBe(59);
    expect(sc.agentScore("old-1").discipline.score).toBeNull();
    const all = sc.allScores(); expect(all.discipline.days).toHaveLength(1); expect(all.discipline.jobs).toBeGreaterThanOrEqual(3);
    expect(all.agents.find((a) => a.agent === "be-1")!.discipline.score).toBe(59);
    const rows = sc.snapshotDiscipline(); expect(rows.length).toBeGreaterThan(0);
    const file = readFileSync(join(ROOT, "data", "discipline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(file.map((x) => x.day)).toContain(d.dayOf(Date.now())); expect(Object.keys(file.at(-1).checks)).toEqual([...d.CHECKS]);
    sc.snapshotDiscipline(); // same day again replaces the line, never duplicates it
    expect(readFileSync(join(ROOT, "data", "discipline.jsonl"), "utf8").trim().split("\n")).toHaveLength(file.length);
    const page = await j(await app.request("/api/v1/agentnet/discipline"));
    expect(page.status).toBe(200); expect(Object.keys(page.body.checks)).toEqual([...d.CHECKS]);
  });
});
