import { expect, test } from "bun:test";
import { trailView, dur, short } from "./trailView";
import type { AgentRow, Check } from "./net";

const row = (o: Partial<AgentRow>): AgentRow => ({ id: "a", name: "a", job: null, boss: null, model: null, effort: null, life: "live", lifeSince: 0, state: "working", stateSince: 100, action: null, reported: null, tasks: [], context: null, cost: null, lastMsg: null, doing: null, seq: 0, ...o });
const T = (s: string[]) => s.map((st, i) => ({ id: i + 1, text: "t" + i, status: st as "done" }));

test("working: current step, word from the running call", () => {
  const v = trailView(row({ tasks: T(["done", "in_progress", "pending"]), action: { tool: "Bash", target: "ls", at: 500 } }));
  expect(v).toMatchObject({ n: 3, done: 1, cur: 1, count: "1/3", mode: "work", word: "Running a command", since: 500 });
});
test("working: the timer counts the step, not the running call", () => {
  const tasks = [{ id: 1, text: "t0", status: "in_progress" as const, startedAt: 200 }];
  expect(trailView(row({ tasks, action: { tool: "Bash", target: "ls", at: 500 } })).since).toBe(200);
  expect(trailView(row({ tasks, action: null })).since).toBe(200);
});
test("gate wins over work; cur falls back to the first open step", () => {
  const ck = { id: 1, agent: "a", createdAt: 900, state: "pending" } as Check;
  expect(trailView(row({ tasks: T(["done", "pending"]) }), ck)).toMatchObject({ mode: "gate", word: "Waiting for you", since: 900, cur: 1 });
});
test("blocked, idle, all done, none, closed", () => {
  expect(trailView(row({ state: "blocked", tasks: T(["in_progress"]) })).mode).toBe("block");
  expect(trailView(row({ state: "idle", tasks: T(["done", "pending"]) })).word).toBe("Idle");
  expect(trailView(row({ state: "idle", tasks: T(["done", "done"]) })).word).toBe("All 2 done");
  expect(trailView(row({ state: "idle" })).mode).toBe("none");
  expect(trailView(row({ life: "gone", tasks: T(["done", "pending"]) })).word).toBe("Closed · 1 open");
});
test("timers", () => {
  expect(dur(26_000)).toBe("26s"); expect(dur(192_000)).toBe("3m 12s"); expect(dur(3_840_000)).toBe("1h 04m");
  expect(short(8_000)).toBe("8s"); expect(short(120_000)).toBe("2m");
});

// ---- an agent with a job: the trail reads the plan ----
import type { Job, Step } from "./net";
const S = (n: number, status: Step["status"], x: Partial<Step> = {}): Step => ({ n, text: "s" + n, origin: "brief", originMsg: null, status, evidence: [], addedAt: 0, workCalls: 0, ...x });
const J = (steps: Step[], x: Partial<Job> = {}): Job => ({ id: 2, goal: null, brief: null, openedBy: "root", openedAt: 0, closedAt: null, outcome: null, plan: steps.filter((s) => !s.added).length, steps, ...x });

test("a job: the count is plan steps over the fixed total, rows are the plan first, then added, dropped included", () => {
  const job = J([S(1, "done"), S(5, "dropped", { added: true, reason: "x" }), S(2, "active", { activatedAt: 300 }), S(3, "pending"), S(4, "done", { added: true })]);
  const v = trailView(row({ jobs: [job], action: { tool: "Bash", target: "ls", at: 500 } }));
  expect(v.count).toBe("1/3");
  expect(v.plan).toMatchObject({ plan: 3, done: 1, added: 2 });
  expect(v.steps.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  expect(v.steps.map((s) => s.status)).toEqual(["done", "in_progress", "pending", "done", "dropped"]);
  expect(v).toMatchObject({ mode: "work", cur: 1, since: 300, n: 5 });
});

test("a job: closed, not reported, no plan yet, closed out on a gone agent", () => {
  expect(trailView(row({ state: "idle", jobs: [J([S(1, "done")], { closedAt: 9, outcome: "done" })] })).word).toBe("Job 2 done");
  expect(trailView(row({ state: "idle", jobs: [J([S(1, "done"), S(2, "dropped", { reason: "x" })])] })).word).toBe("Not reported yet");
  expect(trailView(row({ state: "idle", jobs: [J([S(1, "done"), S(2, "pending")])] })).word).toBe("Idle");
  expect(trailView(row({ jobs: [] }))).toMatchObject({ mode: "none", word: "No plan yet" });
  expect(trailView(row({}))).toMatchObject({ mode: "none", word: "No plan yet", count: "" });
  expect(trailView(row({ jobs: [J([])] }))).toMatchObject({ mode: "none", word: "No plan yet", count: "", plan: null });
  const gone = J([S(1, "done"), S(2, "dropped", { unfinished: true, activatedAt: 5 }), S(3, "dropped", { unfinished: true })], { closedAt: 9, outcome: "dropped" });
  expect(trailView(row({ life: "gone", jobs: [gone] })).word).toBe("Closed · 2 open");
});

test("a job run with the old task tools reads as the plain list", () => {
  const v = trailView(row({ jobs: [J([S(1, "done"), S(2, "active"), S(3, "pending", { added: true })], { legacy: true })] }));
  expect(v).toMatchObject({ count: "1/3", plan: null, cur: 1 });
  expect(v.job?.legacy).toBe(true);
  expect(v.steps.map((s) => s.id)).toEqual([1, 2, 3]);
});

test("an agent from before jobs keeps its old trail", () => {
  const v = trailView(row({ tasks: T(["done", "in_progress"]) }));
  expect(v).toMatchObject({ count: "1/2", job: null, plan: null });
  expect(v.steps).toHaveLength(2);
});
