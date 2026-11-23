import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-scores-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const sc = await import("./scores");

const api = new Hono<Env>(); rt.agentnetRoutes(api); sc.agentnetScoreRoutes(api);
const app = new Hono<Env>(); app.use("*", tracing); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const panel = (path: string) => app.request(`/api/v1/agentnet${path}`);

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset(); sc.useScoreDb(new Database(":memory:"));
  for (const [name, boss] of [["root", null], ["web-dev-1", "root"], ["web-dev-2", "root"]] as const) tok[name] = rt.createAgent({ name, boss: boss ?? undefined, job: "t", by: "test", model: "sonnet", standing: true }).token; // standing: root grades these by hand
});

/** An agent runs one job: a plan of one step (job 1: set by the agent; later jobs: opened by root), one priced turn, the step closed, the done report. */
async function finish(who: string, n: number, usage: Record<string, unknown> = { input_tokens: 1_000_000, output_tokens: 100_000, model: "claude-sonnet-5-5" }, gen = 1) {
  const id = `${who}#${gen}`;
  await call(who, "POST", "/hello", { session: "s", pid: 1 });
  if (st.get(id)!.jobs?.length) await call("root", "POST", "/jobs", { agent: who, goal: `job ${n}`, steps: [`step of job ${n}`] });
  else await call(who, "POST", "/plan", { steps: [`step of job ${n}`] });
  st.emit({ agent: id, type: "ToolFinished", data: { tool: "Edit", tool_use_id: `w${n}` }, source: "mod", ts: Date.now() });
  st.emit({ agent: id, type: "TurnEnded", data: { usage }, source: "mod", ts: Date.now() }); st.flush();
  await call(who, "POST", "/steps/done", { evidence: ["check: bun test 0 fail"], goal: "g", result: "r" });
  const r = await j(await call(who, "POST", "/report", { summary: `job ${n} done`, state: "done" }));
  return { job: r.body?.job_closed as number, status: r.status };
}

describe("grade auth", () => {
  test("no token 401, agent token 403, no closed job 404, bad input 422", async () => {
    expect((await call("nope", "POST", "/agents/web-dev-1/grade", { grade: 5 })).status).toBe(401);
    expect((await call("web-dev-1", "POST", "/agents/web-dev-1/grade", { grade: 5 })).status).toBe(403); // an agent cannot grade itself
    expect((await call("web-dev-2", "POST", "/agents/web-dev-1/grade", { grade: 5 })).status).toBe(403);
    const none = await j(await call("root", "POST", "/agents/web-dev-1/grade", { grade: 5 }));
    expect(none.status).toBe(404); expect(none.body.detail).toContain("web-dev-1 has no closed job yet"); // nothing closed yet
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { task_id: "x", grade: 5 })).status).toBe(422);
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { job: "x", grade: 5 })).status).toBe(422);
  });
  test("the score reads are panel routes, not agent routes", () => {
    expect(rt.agentPath("/api/v1/agentnet/agents/web-dev-1/grade")).toBe(true);
    expect(rt.agentPath("/api/v1/agentnet/agents/web-dev-1/score")).toBe(false);
    expect(rt.agentPath("/api/v1/agentnet/scores")).toBe(false);
  });
});

describe("record, grade, score", () => {
  test("a closed job becomes a record with role, model and a closed-window cost; ungraded = n/a", async () => {
    const f = await finish("web-dev-1", 1);
    expect(f.status).toBe(200); expect(f.job).toBe(1);
    const s = await j(await panel("/agents/web-dev-1/score"));
    expect(s.status).toBe(200); expect(s.body.tasks).toBe(1); expect(s.body.graded).toBe(0); expect(s.body.score).toBeNull(); expect(s.body.role).toBe("web-dev");
    sc.settle(Date.now() + 10 * 60_000); // past the grace window
    const s2 = (await j(await panel("/agents/web-dev-1/score"))).body;
    expect(s2.costPerTask).toBeCloseTo(2 + 1.0, 5); // sonnet-5 list: 1M in x $2 + 0.1M out x $10
    expect(s2.sub.reliability).toBe(100); expect(s2.discipline).toMatchObject({ jobs: 1, steps: 1, score: 100 });
  });
  test("root grades a job by its number (default: the newest); the 'rework:' note prefix sets rework; 3 graded jobs give a number", async () => {
    await finish("web-dev-1", 2); await finish("web-dev-1", 3);
    const g1 = await j(await call("root", "POST", "/agents/web-dev-1/grade", { job: 1, grade: 5, note: "clean", owner_rounds: 0 }));
    expect(g1.status).toBe(200); expect(g1.body.record.grade).toBe(5); expect(g1.body.record.ownerRounds).toBe(0); expect(g1.body.job).toEqual({ agent_id: "web-dev-1#1", job: 1 });
    expect(st.get("web-dev-1#1")!.jobs![0]).toMatchObject({ grade: 5, gradeNote: "clean" }); // the card of that run shows it
    await call("root", "POST", "/agents/web-dev-1/grade", { job: 2, grade: 3, note: "rework: buzzing again", owner_rounds: 2 });
    expect((await j(await panel("/agents/web-dev-1/score"))).body.score).toBeNull(); // 2 graded
    const g3 = await j(await call("root", "POST", "/agents/web-dev-1/grade", { grade: 4, rework: false, owner_rounds: 1 })); // no job named: the newest closed one
    expect(g3.status).toBe(200); expect(g3.body.job).toEqual({ agent_id: "web-dev-1#1", job: 3 });
    await call("root", "POST", "/agents/web-dev-1/grade", { job: 3, grade: 4, owner_rounds: 1 });
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { job: 3, grade: 9 })).status).toBe(422);
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { job: 3, grade: 4, owner_rounds: -1 })).status).toBe(422);
    const miss = await j(await call("root", "POST", "/agents/web-dev-1/grade", { job: 7, grade: 4 }));
    expect(miss.status).toBe(404); expect(miss.body.detail).toBe("no closed job 7 of web-dev-1. Closed jobs of web-dev-1: gen 1 job 3, gen 1 job 2, gen 1 job 1.");
    const old = await j(await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 2, grade: 4 }));
    expect(old.status).toBe(404); expect(old.body.detail).toContain("Tasks are no longer graded one by one: grade the job");
    const s = (await j(await panel("/agents/web-dev-1/score"))).body;
    expect(s.graded).toBe(3); expect(s.score).toBeGreaterThan(0); expect(s.score).toBeLessThanOrEqual(100);
    expect(s.sub.quality).toBeCloseTo((100 + 50 + 75) / 3, 5); expect(s.sub.firstTimeRight).toBeCloseTo((100 + 45 + 70) / 3, 5); expect(s.sub.rework).toBeCloseTo(100 * 2 / 3, 5);
    expect(s.last.length).toBe(3); expect(s.last[0]).toMatchObject({ unit: "job", agent_id: "web-dev-1#1", job: 3 }); expect(s.lastAvgRounds).toBe(1);
  });
  test("a name used twice: the grade lands on the generation that is named, by default the newest", async () => {
    await finish("web-dev-2", 1);
    expect((await call("root", "POST", "/despawn", { agent: "web-dev-2" })).status).toBe(200);
    tok["web-dev-2"] = rt.createAgent({ name: "web-dev-2", boss: "root", job: "t", by: "test", model: "sonnet", standing: true }).token;
    expect(st.get("web-dev-2#2")).not.toBeNull();
    await finish("web-dev-2", 1, undefined, 2);
    const now = await j(await call("root", "POST", "/agents/web-dev-2/grade", { grade: 2, note: "second run" }));
    expect(now.body.job).toEqual({ agent_id: "web-dev-2#2", job: 1 });
    const first = await j(await call("root", "POST", "/agents/web-dev-2/grade", { gen: 1, job: 1, grade: 5, note: "first run" }));
    expect(first.body.job).toEqual({ agent_id: "web-dev-2#1", job: 1 });
    const rows = (await j(await panel("/agents/web-dev-2/tasks"))).body.jobs as { agent_id: string; gen: number; job: number; grade: number; note: string }[];
    expect(rows.map((r) => [r.agent_id, r.gen, r.job, r.grade, r.note]).sort()).toEqual([["web-dev-2#1", 1, 1, 5, "first run"], ["web-dev-2#2", 2, 1, 2, "second run"]]);
    expect(st.get("web-dev-2#1")!.jobs![0]!.grade).toBe(5); expect(st.get("web-dev-2#2")!.jobs![0]!.grade).toBe(2);
    const miss = await j(await call("root", "POST", "/agents/web-dev-2/grade", { gen: 3, grade: 4 }));
    expect(miss.status).toBe(404); expect(miss.body.detail).toContain("Closed jobs of web-dev-2: gen 2 job 1, gen 1 job 1.");
  });
  test("/scores aggregates by agent, role, model and soul", async () => {
    const r = (await j(await panel("/scores"))).body;
    expect(r.agents.map((a: { agent: string }) => a.agent).sort()).toEqual(["web-dev-1", "web-dev-2"]);
    expect(r.byRole[0].key).toBe("web-dev"); expect(r.byRole[0].tasks).toBe(5);
    expect(r.byModel.length).toBeGreaterThan(0); expect(r.bySoul[0].key).toBe("none");
    expect(r.weights.quality).toBe(30); expect(r.minGraded).toBe(3);
    expect(r.discipline).toMatchObject({ jobs: 5, steps: 5, all: 100 });
  });
  test("a job is recorded once: the despawn after its report does not make a second record", async () => {
    const before = (await j(await panel("/agents/web-dev-1/score"))).body.tasks;
    expect((await call("root", "POST", "/despawn", { agent: "web-dev-1" })).status).toBe(200);
    expect((await j(await panel("/agents/web-dev-1/score"))).body.tasks).toBe(before);
  });
  test("bad agent name on the panel read is 422", async () => { expect((await panel("/agents/BAD_NAME/score")).status).toBe(422); });
  test("/scores groups brain jobs by brain name with the versions seen (soul = name@vN)", async () => {
    tok["motion-1"] = rt.createAgent({ name: "motion-1", boss: "root", job: "t", by: "test", model: "sonnet", soul: "motion@v3", standing: true }).token;
    await finish("motion-1", 1);
    expect((await call("root", "POST", "/agents/motion-1/grade", { grade: 4, note: "ok" })).status).toBe(200);
    const r = (await j(await panel("/scores"))).body;
    expect(r.byBrain).toEqual([expect.objectContaining({ key: "motion", versions: [3], graded: 1 })]);
    expect(r.bySoul.map((g: { key: string }) => g.key)).toContain("motion@v3");
  });
});
