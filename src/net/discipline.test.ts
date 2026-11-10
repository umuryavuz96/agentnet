import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-disc-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const sc = await import("./scores");
const d = await import("./discipline");
const { ROOT } = await import("../core/config"); // the data folder the first test file of the run set
type TaskRecord = import("./score").TaskRecord;

const rec = (o: Partial<TaskRecord> & { taskId: number; doneAt: number }): TaskRecord => ({ id: o.taskId, agent: "a-1", role: "a", model: null, soul: null, project: null, text: "t", startedAt: o.doneAt - 120_000, tokens: null, costUsd: null,
  listedFirst: true, promptStart: true, promptDone: true, noteFilled: true, grade: null, note: null, rework: false, reworkAt: null, ownerRounds: null, gradedAt: null, ...o });

describe("discipline math", () => {
  test("flags: a clean run passes every check", () => {
    const f = d.flagRecords([rec({ taskId: 1, doneAt: 1_000_000 }), rec({ taskId: 2, doneAt: 1_500_000 })]);
    expect([...f.values()].every((x) => d.flagCount(x) === 0)).toBe(true);
    expect(d.disciplineOf([...f.values()]).score).toBe(100);
  });
  test("flags: batch close (<60 s after the previous done) and overlap are caught, a long task is not a batch", () => {
    const f = d.flagRecords([rec({ taskId: 1, doneAt: 1_000_000, startedAt: 900_000 }), rec({ taskId: 2, doneAt: 1_030_000, startedAt: 990_000 }), rec({ taskId: 3, doneAt: 1_050_000, startedAt: 800_000 })]);
    expect(f.get(2)!.notBatch).toBe(false); // 30 s after #1, ran 40 s and started inside #1's window: also an overlap
    expect(f.get(2)!.oneAtATime).toBe(false);
    expect(f.get(3)!.notBatch).toBe(true); // ran 250 s: not a batch
    expect(f.get(1)!.notBatch).toBe(true);
  });
  test("never started = fails started and onTime; open tasks at despawn count as failed tasks", () => {
    const f = d.flagRecords([rec({ taskId: 1, doneAt: 1_000_000, startedAt: null, promptStart: false })]).get(1)!;
    expect(f.started).toBe(false);
    expect(d.disciplineOf([f], 1).score).toBe(30); // 3 of 5 checks on one task, none on the open one
    expect(d.disciplineOf([]).score).toBeNull();
  });
  test("grade penalty: per flag, capped, never below 1", () => {
    expect(d.adjustGrade(5, 0)).toEqual({ grade: 5, penalty: 0 });
    expect(d.adjustGrade(5, 2)).toEqual({ grade: 4, penalty: 1 });
    expect(d.adjustGrade(5, 5).grade).toBe(3); // cap 2
    expect(d.adjustGrade(1, 4)).toEqual({ grade: 1, penalty: 0 });
  });
  test("gate: grace, exempt, empty list, nothing started, all done, ok", () => {
    const base = { exempt: false, spawnedAt: 0, now: 10 * 60_000 }, cfg = { ...d.DEFAULTS };
    expect(d.gateReason({ ...base, now: 60_000, tasks: [] }, cfg)).toBeNull();
    expect(d.gateReason({ ...base, exempt: true, tasks: [] }, cfg)).toBeNull();
    expect(d.gateReason({ ...base, tasks: [] }, cfg)).toContain("Add your tasks first");
    expect(d.gateReason({ ...base, tasks: [{ status: "pending" }] }, cfg)).toContain("task_start");
    expect(d.gateReason({ ...base, tasks: [{ status: "done" }] }, cfg)).toContain("all your tasks are done");
    expect(d.gateReason({ ...base, tasks: [{ status: "in_progress" }] }, cfg)).toBeNull();
    expect(d.gateReason({ ...base, tasks: [] }, { ...cfg, workGate: false })).toBeNull();
  });
  test("daily rows pool agents per local day and keep per-agent scores", () => {
    const by = new Map([["a-1", [rec({ taskId: 1, doneAt: Date.now() })]], ["b-1", [rec({ taskId: 1, doneAt: Date.now(), agent: "b-1", listedFirst: false })]]]);
    const rows = d.dailyRows(by);
    expect(rows).toHaveLength(1); expect(rows[0]!.tasks).toBe(2); expect(rows[0]!.agents["a-1"]!.score).toBe(100); expect(rows[0]!.agents["b-1"]!.score).toBe(80); expect(rows[0]!.score).toBe(90);
  });
});

const api = new Hono<Env>(); rt.agentnetRoutes(api); sc.agentnetScoreRoutes(api);
const app = new Hono<Env>(); app.use("*", tracing); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
let prev: string | undefined;
beforeAll(() => {
  prev = process.env.AGENTNET_TASK_STRICT; process.env.AGENTNET_TASK_STRICT = "1";
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  const old = Date.now() - 3600_000; // spawned an hour ago: the 2-minute grace is over
  tok.root = rt.createAgent({ name: "root", job: "t", by: "test" }).token;
  tok["be-1"] = rt.createAgent({ name: "be-1", boss: "root", job: "t", by: "test" }, old).token;
  tok["fresh-1"] = rt.createAgent({ name: "fresh-1", boss: "root", job: "t", by: "test" }).token;
});
afterAll(() => { if (prev === undefined) delete process.env.AGENTNET_TASK_STRICT; else process.env.AGENTNET_TASK_STRICT = prev; });

describe("strict rules over the API", () => {
  test("B2 gate: empty list, nothing started, ok once a task runs; root and a fresh agent are exempt", async () => {
    let g = (await j(await call("be-1", "GET", "/gate"))).body;
    expect(g.allow).toBe(false); expect(g.reason).toContain("Add your tasks first");
    await call("be-1", "POST", "/tasks", { titles: ["one", "two"] });
    g = (await j(await call("be-1", "GET", "/gate"))).body;
    expect(g.allow).toBe(false); expect(g.reason).toContain("mcp__agentnet__task_start");
    await call("be-1", "POST", "/tasks/1/start");
    expect((await j(await call("be-1", "GET", "/gate"))).body.allow).toBe(true);
    expect((await j(await call("root", "GET", "/gate"))).body.allow).toBe(true);
    expect((await j(await call("fresh-1", "GET", "/gate"))).body.allow).toBe(true); // first 2 minutes
    expect(rt.agentPath("/api/v1/agentnet/gate")).toBe(true);
  });
  test("B3 one at a time", async () => {
    const r = await j(await call("be-1", "POST", "/tasks/2/start"));
    expect(r.status).toBe(409); expect(r.body.detail).toBe("agentnet: finish or done task 1 first (one task at a time).");
  });
  test("B1 done on a never-started task", async () => {
    const r = await j(await call("be-1", "POST", "/tasks/2/done", {}));
    expect(r.status).toBe(409); expect(r.body.detail).toBe("agentnet: task 2 was never started. Start it first with mcp__agentnet__task_start, then mark it done.");
  });
  test("B4 report done with open tasks is refused; progress report is fine; refused no more once all are done", async () => {
    const r = await j(await call("be-1", "POST", "/report", { summary: "all done", state: "done" }));
    expect(r.status).toBe(409); expect(r.body.detail).toContain("cannot report done while 2 tasks are open (1, 2)");
    expect((await call("be-1", "POST", "/report", { summary: "halfway", state: "progress" })).status).toBe(200);
    expect((await call("be-1", "POST", "/tasks/1/done", {})).status).toBe(200);
    expect((await call("be-1", "POST", "/tasks/2/start")).status).toBe(200);
    expect((await call("be-1", "POST", "/tasks/2/done", {})).status).toBe(200);
    expect((await call("be-1", "POST", "/report", { summary: "all done", state: "done" })).status).toBe(200);
  });
  test("B4 despawn with open tasks warns root and still despawns", async () => {
    await call("fresh-1", "POST", "/tasks", { titles: ["left open"] });
    const r = await j(await call("root", "POST", "/despawn", { agent: "fresh-1" }));
    expect(r.status).toBe(200); expect(r.body.state).toBe("gone"); expect(r.body.warning).toContain("despawned with 1 open task"); expect(r.body.open_tasks).toEqual([1]);
  });
  test("config switches turn each rule off", async () => {
    const dir = ROOT, fs = await import("node:fs");
    fs.mkdirSync(join(dir, "config"), { recursive: true });
    fs.writeFileSync(join(dir, "config", "task-discipline.json"), JSON.stringify({ strictDone: false, workGate: false, maxInProgress: 2, blockDoneReport: false }));
    try {
      await call("be-1", "POST", "/tasks", { titles: ["x", "y", "z"] });
      expect((await j(await call("be-1", "GET", "/gate"))).body.allow).toBe(true);
      expect((await call("be-1", "POST", "/tasks/3/start")).status).toBe(200);
      expect((await call("be-1", "POST", "/tasks/4/start")).status).toBe(200); // two allowed
      expect((await call("be-1", "POST", "/tasks/5/start")).status).toBe(409);
      expect((await call("be-1", "POST", "/tasks/5/done", {})).status).toBe(200); // B1 off
      expect((await call("be-1", "POST", "/report", { summary: "done", state: "done" })).status).toBe(200); // B4 off
    } finally { fs.rmSync(join(dir, "config", "task-discipline.json")); }
  });
});

describe("B5 grade penalty and the A numbers", () => {
  test("a flagged task is graded lower, raw kept; the discipline numbers and the snapshot file exist", async () => {
    // be-1 closed tasks 1 and 2 in quick succession in the tests above: task 2 is a batch close and never listed-first-checked
    const g = await j(await call("root", "POST", "/agents/be-1/grade", { task_id: 2, grade: 5 }));
    expect(g.status).toBe(200);
    const r = g.body.record; expect(r.gradeRaw).toBe(5); expect(r.grade).toBeLessThan(5); expect(r.penalty).toBeGreaterThan(0); expect(r.grade).toBe(5 - r.penalty);
    const s = sc.agentScore("be-1"); expect(s.discipline.tasks).toBeGreaterThan(0); expect(s.discipline.score).toBeLessThan(100);
    const all = sc.allScores(); expect(all.discipline.days.length).toBeGreaterThan(0); expect(all.agents.find((a) => a.agent === "be-1")!.discipline.score).not.toBeNull();
    const rows = sc.snapshotDiscipline(); expect(rows.length).toBeGreaterThan(0);
    const file = readFileSync(join(ROOT, "data", "discipline.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(file.map((x) => x.day)).toContain(d.dayOf(Date.now()));
    sc.snapshotDiscipline(); // same day again replaces the line, never duplicates it
    expect(readFileSync(join(ROOT, "data", "discipline.jsonl"), "utf8").trim().split("\n")).toHaveLength(file.length);
    expect((await app.request("/api/v1/agentnet/discipline")).status).toBe(200);
  });
});
