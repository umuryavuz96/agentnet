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
  for (const [name, boss] of [["root", null], ["web-dev-1", "root"], ["web-dev-2", "root"]] as const) tok[name] = rt.createAgent({ name, boss: boss ?? undefined, job: "t", by: "test", model: "sonnet" }).token;
});

/** An agent adds a task, starts it, does a tool call and one priced turn, then marks it done with a filled note. */
async function finish(who: string, n: number, usage: Record<string, unknown> = { input_tokens: 1_000_000, output_tokens: 100_000, model: "claude-sonnet-5-5" }) {
  const id = `${who}#1`, t0 = Date.now() - 600_000 + n * 1000;
  await call(who, "POST", "/hello", { session: "s", pid: 1 });
  await call(who, "POST", "/tasks", { titles: [`task ${n}`] });
  const taskId = st.get(id)!.tasks.length;
  await call(who, "POST", `/tasks/${taskId}/start`);
  st.emit({ agent: id, type: "TurnEnded", data: { usage }, source: "mod", ts: Date.now() }); st.flush();
  const r = await j(await call(who, "POST", `/tasks/${taskId}/done`, { goal: "g", result: "r" }));
  return { taskId, status: r.status, t0 };
}

describe("grade auth", () => {
  test("no token 401, agent token 403, unknown agent / unfinished task 404, bad input 422", async () => {
    expect((await call("nope", "POST", "/agents/web-dev-1/grade", { task_id: 1, grade: 5 })).status).toBe(401);
    expect((await call("web-dev-1", "POST", "/agents/web-dev-1/grade", { task_id: 1, grade: 5 })).status).toBe(403); // an agent cannot grade itself
    expect((await call("web-dev-2", "POST", "/agents/web-dev-1/grade", { task_id: 1, grade: 5 })).status).toBe(403);
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 1, grade: 5 })).status).toBe(404); // nothing finished yet
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { task_id: "x", grade: 5 })).status).toBe(422);
  });
  test("the score reads are panel routes, not agent routes", () => {
    expect(rt.agentPath("/api/v1/agentnet/agents/web-dev-1/grade")).toBe(true);
    expect(rt.agentPath("/api/v1/agentnet/agents/web-dev-1/score")).toBe(false);
    expect(rt.agentPath("/api/v1/agentnet/scores")).toBe(false);
  });
});

describe("record, grade, score", () => {
  test("a done task becomes a record with role, model and a closed-window cost; ungraded = n/a", async () => {
    const f = await finish("web-dev-1", 1);
    expect(f.status).toBe(200);
    const s = await j(await panel("/agents/web-dev-1/score"));
    expect(s.status).toBe(200); expect(s.body.tasks).toBe(1); expect(s.body.graded).toBe(0); expect(s.body.score).toBeNull(); expect(s.body.role).toBe("web-dev");
    sc.settle(Date.now() + 10 * 60_000); // past the grace window
    const s2 = (await j(await panel("/agents/web-dev-1/score"))).body;
    expect(s2.costPerTask).toBeCloseTo(2 + 1.0, 5); // sonnet-5 list: 1M in x $2 + 0.1M out x $10
    expect(s2.sub.reliability).toBeGreaterThan(0);
  });
  test("root grades with owner_rounds; the 'rework:' note prefix sets rework; 3 graded tasks give a number", async () => {
    await finish("web-dev-1", 2); await finish("web-dev-1", 3);
    const g1 = await j(await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 1, grade: 5, note: "clean", owner_rounds: 0 }));
    expect(g1.status).toBe(200); expect(g1.body.record.grade).toBe(5); expect(g1.body.record.ownerRounds).toBe(0);
    await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 2, grade: 3, note: "rework: buzzing again", owner_rounds: 2 });
    expect((await j(await panel("/agents/web-dev-1/score"))).body.score).toBeNull(); // 2 graded
    const g3 = await j(await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 3, grade: 4, rework: false, owner_rounds: 1 }));
    expect(g3.status).toBe(200);
    await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 3, grade: 4, owner_rounds: 1 });
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 3, grade: 9 })).status).toBe(422);
    expect((await call("root", "POST", "/agents/web-dev-1/grade", { task_id: 3, grade: 4, owner_rounds: -1 })).status).toBe(422);
    const s = (await j(await panel("/agents/web-dev-1/score"))).body;
    expect(s.graded).toBe(3); expect(s.score).toBeGreaterThan(0); expect(s.score).toBeLessThanOrEqual(100);
    expect(s.sub.quality).toBeCloseTo((100 + 50 + 75) / 3, 5); expect(s.sub.firstTimeRight).toBeCloseTo((100 + 45 + 70) / 3, 5); expect(s.sub.rework).toBeCloseTo(100 * 2 / 3, 5);
    expect(s.last.length).toBe(3); expect(s.last[0].task_id).toBe(3); expect(s.lastAvgRounds).toBe(1);
  });
  test("/scores aggregates by agent, role, model and soul", async () => {
    await finish("web-dev-2", 1);
    const r = (await j(await panel("/scores"))).body;
    expect(r.agents.map((a: { agent: string }) => a.agent).sort()).toEqual(["web-dev-1", "web-dev-2"]);
    expect(r.byRole[0].key).toBe("web-dev"); expect(r.byRole[0].tasks).toBe(4);
    expect(r.byModel.length).toBeGreaterThan(0); expect(r.bySoul[0].key).toBe("none");
    expect(r.weights.quality).toBe(30); expect(r.minGraded).toBe(3);
  });
  test("a re-sent done event does not make a second record", async () => {
    const before = (await j(await panel("/agents/web-dev-1/score"))).body.tasks;
    await call("web-dev-1", "POST", "/events", { events: [{ type: "TaskDone", data: { id: 1 } }] });
    expect((await j(await panel("/agents/web-dev-1/score"))).body.tasks).toBe(before);
  });
  test("bad agent name on the panel read is 422", async () => { expect((await panel("/agents/BAD_NAME/score")).status).toBe(422); });
});
