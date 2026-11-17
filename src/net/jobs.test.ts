import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const st = await import("./store");
const jb = await import("./jobs");

const T0 = 1_700_000_000_000;
type S = NonNullable<ReturnType<typeof st.reduce>>;
const base = (): S => st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a#1", name: "a", gen: 1, boss: "lead-1", goal: "ship it" }, source: "spawn" })!;
const ev = (s: S, type: string, data: Record<string, unknown> = {}, ts = T0 + 1) => st.reduce(s, { type, ts, data, source: "mcp" })!;
const work = (s: S, ts: number) => ev(s, "ToolFinished", { tool: "Bash", tool_use_id: "u" + ts }, ts);
const plan = (s: S, n = 3, ts = T0 + 1) => ev(ev(s, "JobOpened", { by: "root", goal: "ship it", brief: "/p/BRIEF.md" }, ts), "PlanSet", { steps: Array.from({ length: n }, (_, i) => `step ${i + 1}`), origin: "brief" }, ts);
const statuses = (s: S) => s.jobs!.at(-1)!.steps.map((x) => x.status);

describe("job fold", () => {
  test("a plan makes step 1 active; the tasks view follows the steps", () => {
    const s = plan(base());
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs![0]).toMatchObject({ id: 1, goal: "ship it", brief: "/p/BRIEF.md", openedBy: "root", plan: 3, closedAt: null, outcome: null });
    expect(statuses(s)).toEqual(["active", "pending", "pending"]);
    expect(s.jobs![0]!.steps[0]).toMatchObject({ n: 1, origin: "brief", activatedAt: T0 + 1, workCalls: 0 });
    expect(s.tasks.map((t) => [t.id, t.status])).toEqual([[1, "in_progress"], [2, "pending"], [3, "pending"]]);
    expect(st.doing(s)).toBe("step 1 (task)");
  });
  test("step closed: evidence kept, the next step becomes active, work calls are counted per step", () => {
    let s = work(work(plan(base()), T0 + 2), T0 + 3);
    s = ev(s, "ToolFinished", { tool: "mcp__agentnet__inbox" }, T0 + 4); // not work
    s = ev(s, "StepClosed", { evidence: [{ kind: "commit", value: "abc1234", ok: true }], note: "built" }, T0 + 5);
    const [one, two] = s.jobs![0]!.steps;
    expect(one).toMatchObject({ status: "done", closedAt: T0 + 5, workCalls: 2, note: "built", evidence: [{ kind: "commit", value: "abc1234", ok: true }] });
    expect(two).toMatchObject({ status: "active", activatedAt: T0 + 5, workCalls: 0 });
    s = ev(s, "StepClosed", { evidence: [{ kind: "none", value: "thinking only", ok: null }] }, T0 + 6);
    expect(jb.jobCounts(s.jobs![0]!)).toMatchObject({ plan: 3, planDone: 2, done: 2, open: 1, noWork: 1, withEvidence: 1, verified: 1 });
  });
  test("a step added later is marked, does not move the plan total, and runs after the active step", () => {
    let s = ev(plan(base()), "StepAdded", { text: "new scope", origin: "boss", originMsg: 77 }, T0 + 2);
    const j = s.jobs![0]!;
    expect(j.plan).toBe(3);
    expect(j.steps[3]).toMatchObject({ n: 4, added: true, after: 1, origin: "boss", originMsg: 77, status: "pending" });
    s = ev(s, "StepClosed", { evidence: [] }, T0 + 3);
    expect(statuses(s)).toEqual(["done", "pending", "pending", "active"]); // 4 was added while 1 was active: it runs next
    s = ev(s, "StepClosed", { evidence: [] }, T0 + 4);
    expect(statuses(s)).toEqual(["done", "active", "pending", "done"]);
    expect(jb.jobCounts(s.jobs![0]!)).toMatchObject({ plan: 3, planDone: 1, added: 1, done: 2 });
  });
  test("dropping the active step moves on; a dropped step leaves the tasks view", () => {
    const s = ev(plan(base()), "StepDropped", { n: 1, reason: "not needed" }, T0 + 2);
    expect(s.jobs![0]!.steps[0]).toMatchObject({ status: "dropped", reason: "not needed", closedAt: T0 + 2 });
    expect(statuses(s)).toEqual(["dropped", "active", "pending"]);
    expect(s.tasks.map((t) => t.id)).toEqual([2, 3]);
  });
  test("job closed: open steps are dropped with the reason, the next plan opens job 2", () => {
    let s = ev(plan(base()), "StepClosed", { evidence: [] }, T0 + 2);
    s = ev(s, "JobClosed", { outcome: "failed", reason: "failed" }, T0 + 3);
    expect(s.jobs![0]).toMatchObject({ closedAt: T0 + 3, outcome: "failed" });
    expect(s.jobs![0]!.steps.map((x) => [x.status, x.reason])).toEqual([["done", undefined], ["dropped", "failed: unfinished"], ["dropped", "failed"]]);
    s = ev(ev(s, "JobOpened", { by: "lead-1", goal: "round two" }, T0 + 4), "PlanSet", { steps: ["only one"], origin: "boss" }, T0 + 4);
    expect(s.jobs!.map((j) => [j.id, j.goal, j.plan])).toEqual([[1, "ship it", 3], [2, "round two", 1]]);
    expect(s.tasks).toEqual([{ id: 1, text: "only one", status: "in_progress", startedAt: T0 + 4 }]);
  });
  test("despawn closes the job: nothing stays open on a gone agent; an exit does not", () => {
    let s = ev(plan(base()), "AgentGone", { reason: "exit" }, T0 + 2);
    expect(s.jobs![0]!.closedAt).toBeNull();
    s = ev(s, "AgentGone", { reason: "despawn" }, T0 + 3);
    expect(s.jobs![0]).toMatchObject({ closedAt: T0 + 3, outcome: "dropped" });
    expect(s.jobs![0]!.steps.map((x) => x.reason)).toEqual(["despawn: unfinished", "despawn", "despawn"]);
    let d = plan(base(), 1); d = ev(d, "StepClosed", { evidence: [] }, T0 + 2); d = ev(d, "AgentGone", { reason: "despawn" }, T0 + 3);
    expect(d.jobs![0]!.outcome).toBe("done"); // every step was closed, only the report was missing
  });
  test("a grade lands on the job it names", () => {
    let s = ev(plan(base(), 1), "JobClosed", { outcome: "done" }, T0 + 2);
    s = ev(s, "JobGraded", { job: 1, grade: 4, note: "ok" }, T0 + 3);
    expect(s.jobs![0]).toMatchObject({ grade: 4, gradeNote: "ok" });
  });
});

describe("old task events", () => {
  test("they open a legacy job with no caps and keep their old meaning", () => {
    let s = base();
    for (let i = 0; i < 15; i++) s = ev(s, "TaskAdded", { text: `t${i + 1}` }, T0 + 1 + i);
    const j = s.jobs![0]!;
    expect(j).toMatchObject({ id: 1, legacy: true, openedBy: "old tool", plan: 15 });
    expect(s.tasks.every((t) => t.status === "pending")).toBe(true); // nothing is in work until task_start says so
    s = ev(s, "TaskStarted", { id: 2 }, T0 + 20);
    s = ev(s, "TaskDone", { id: 2 }, T0 + 21);
    expect(s.tasks[1]).toEqual({ id: 2, text: "t2", status: "done", startedAt: T0 + 20, doneAt: T0 + 21 });
    expect(s.jobs![0]!.steps[1]!.evidence).toEqual([{ kind: "none", value: "old tool", ok: null }]);
    s = ev(s, "TaskAdded", { text: "late" }, T0 + 22);
    expect(s.jobs![0]!.steps.at(-1)).toMatchObject({ n: 16, added: true });
    expect(s.jobs![0]!.plan).toBe(15);
  });
  test("a fold from before jobs existed is taken over on its next task event", () => {
    const old: S = { ...base(), tasks: [{ id: 1, text: "a", status: "done", startedAt: T0 + 1, doneAt: T0 + 2 }, { id: 2, text: "b", status: "in_progress", startedAt: T0 + 3 }, { id: 3, text: "c", status: "pending" }] };
    expect(jb.jobsOf(old)[0]).toMatchObject({ legacy: true, plan: 3 });
    expect(jb.tasksOf(jb.jobsOf(old)[0])).toEqual(old.tasks);
    const s = ev(old, "TaskDone", { id: 2 }, T0 + 4);
    expect(s.jobs![0]!.steps.map((x) => x.status)).toEqual(["done", "done", "pending"]);
    expect(s.tasks[1]).toMatchObject({ status: "done", doneAt: T0 + 4 });
  });
  test("a new plan replaces a legacy list that has nothing closed", () => {
    let s = ev(ev(base(), "TaskAdded", { text: "x" }), "PlanSet", { steps: ["a", "b"] }, T0 + 2);
    expect(s.jobs![0]!.legacy).toBeUndefined();
    expect(s.jobs![0]!.steps.map((x) => x.text)).toEqual(["a", "b"]);
    expect(s.jobs![0]!.steps[0]!.origin).toBe("self");
  });
});

describe("asks", () => {
  const msg = (s: S, id: number, peer: string, kind = "task", ts = T0 + id) => ev(s, "MessageReceived", { msg_id: id, peer, kind, subject: `ask ${id}`, snippet: "body" }, ts);
  test("a task message from the boss or root is an ask; a reply with reply_to closes it", () => {
    let s = msg(msg(msg(msg(base(), 5, "lead-1"), 6, "root"), 7, "peer-1"), 8, "lead-1", "info");
    expect(s.asks!.map((a) => a.id)).toEqual([5, 6]);
    expect(s.asks![0]).toMatchObject({ from: "lead-1", subject: "ask 5", closedAt: null });
    s = ev(s, "MessageSent", { msg_id: 9, peer: "lead-1", kind: "answer", reply_to: 5 }, T0 + 20);
    expect(jb.openAsks(s).map((a) => a.id)).toEqual([6]);
    expect(s.asks![0]).toMatchObject({ closedAt: T0 + 20, closedBy: "reply" });
  });
  test("an ask that became a step, or a closed job, closes it", () => {
    let s = msg(msg(plan(base()), 5, "lead-1"), 6, "lead-1");
    s = ev(s, "StepAdded", { text: "new scope", origin: "boss", originMsg: 5 }, T0 + 30);
    expect(s.asks![0]).toMatchObject({ closedBy: "step", step: 4 });
    s = ev(s, "JobClosed", { outcome: "done" }, T0 + 40);
    expect(s.asks![1]).toMatchObject({ closedBy: "report", closedAt: T0 + 40 });
  });
});

describe("plan rules", () => {
  const job = (n: number, extra: Partial<import("./jobs").Job> = {}) => ({ ...plan(base(), n).jobs![0]!, ...extra });
  test("plan_set: 1 to 7 steps, fixed after the first close, root may allow more", () => {
    expect(jb.planError(null, [])).toContain("needs steps");
    expect(jb.planError(null, Array(8).fill("x"))).toContain("at most 7");
    expect(jb.planError(null, Array(7).fill("x"))).toBeNull();
    expect(jb.planError(job(1, { planMax: 9 }), Array(9).fill("x"))).toBeNull();
    const closed = ev(plan(base()), "StepClosed", { evidence: [] }).jobs![0]!;
    expect(jb.planError(closed, ["a"])).toContain("fixed once a step is closed");
  });
  test("step_add: 12 in total, 2 of your own; a legacy job has no cap", () => {
    let s = plan(base(), 7);
    for (let i = 0; i < 5; i++) s = ev(s, "StepAdded", { text: `b${i}`, origin: "boss", originMsg: 100 + i }, T0 + 2 + i);
    expect(jb.addError(s.jobs![0]!, "boss", "one more")).toContain("cap is 12");
    let t = plan(base(), 2);
    expect(jb.addError(t.jobs![0]!, "self", "")).toContain("needs a text");
    t = ev(ev(t, "StepAdded", { text: "s1", origin: "self" }), "StepAdded", { text: "s2", origin: "self" });
    expect(jb.addError(t.jobs![0]!, "self", "s3")).toContain("2 steps of your own");
    expect(jb.addError(t.jobs![0]!, "boss", "b")).toBeNull();
    expect(jb.addError({ ...s.jobs![0]!, legacy: true }, "self", "x")).toBeNull();
  });
  test("ceremony steps are spotted", () => {
    for (const t of ["Final report to root", "Status line every 10 minutes", "Read the brief", "Commit and report", "report"]) expect(jb.isCeremony(t)).toBe(true);
    for (const t of ["Build the plan block", "Fix the wrong-project bug", "Reporting page shows the plan"]) expect(jb.isCeremony(t)).toBe(false);
  });
  test("brief steps: the numbered lines under ## Steps", () => {
    const md = "# Brief\n\n1. not this\n\n## Steps\n\n1. **Server** and store\n2) Routes with `step_done`\n- a bullet\n3. Plugin tools\n\n## Rules\n1. nor this\n";
    expect(jb.briefSteps(md)).toEqual(["Server and store", "Routes with step_done", "Plugin tools"]);
    expect(jb.briefSteps("# no steps here\n1. x")).toEqual([]);
  });
  test("the plan summary names every step, its proof and the open asks", () => {
    let s = ev(plan(base(), 2), "StepClosed", { evidence: [{ kind: "commit", value: "abc1234", ok: true }] }, T0 + 2);
    s = ev(s, "StepDropped", { n: 2, reason: "moved to job 2" }, T0 + 3);
    const text = jb.planSummary(s.jobs![0]!, [{ id: 9, from: "root", subject: "fix the header", at: T0, closedAt: null }]);
    expect(text).toBe("Plan of job 1: 1/2 done, 1 dropped\n1.1 done: step 1 [commit abc1234 ok] (no work seen)\n1.2 dropped: step 2 (moved to job 2)\nOpen asks: #9 fix the header");
  });
});
