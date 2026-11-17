// The plan reading the panel, the card and the team panel share: a fixed total, growth counted apart, no time without work.
import { expect, test } from "bun:test";
import type { Job, Step } from "./net";
import { activeStep, countText, endedText, curJob, earlierJobs, jobWord, openAsks, plain, planCount, planLine, planSteps, proofs, stepLook, stepNo, stepTime } from "./plan";

const S = (n: number, status: Step["status"], x: Partial<Step> = {}): Step => ({ n, text: "step " + n, origin: "brief", originMsg: null, status, evidence: [], addedAt: 0, workCalls: 0, ...x });
const job = (steps: Step[], x: Partial<Job> = {}): Job => ({ id: 2, goal: "g", brief: null, openedBy: "root", openedAt: 0, closedAt: null, outcome: null, plan: steps.filter((s) => !s.added).length, steps, ...x });

test("progress counts plan steps only; added steps are a figure of their own", () => {
  const j = job([S(1, "done"), S(2, "done"), S(3, "active"), S(4, "pending"), S(5, "done", { added: true, origin: "boss", originMsg: 7 }), S(6, "dropped", { added: true, origin: "self", reason: "not needed" })]);
  const c = planCount(j);
  expect(countText(c)).toBe("2/4");
  expect(c).toEqual({ plan: 4, done: 2, added: 2, grew: false, dropped: 1, unfinished: 0 });
  expect(stepNo(j, j.steps[2])).toBe("2.3");
  expect(activeStep(j)?.n).toBe(3);
});

test("scope grew: added is more than half of the plan, not exactly half", () => {
  const plan = [S(1, "done"), S(2, "active"), S(3, "pending"), S(4, "pending")], add = (n: number) => S(n, "pending", { added: true, origin: "boss" });
  expect(planCount(job([...plan, add(5), add(6)])).grew).toBe(false);
  expect(planCount(job([...plan, add(5), add(6), add(7)])).grew).toBe(true);
});

test("steps draw as the plan first, then the added ones, whatever order they arrived in", () => {
  const j = job([S(1, "done"), S(5, "pending", { added: true, after: 1 }), S(2, "active"), S(3, "pending")]);
  expect(planSteps(j).all.map((s) => s.n)).toEqual([1, 2, 3, 5]);
  expect(planSteps(j).added.map((s) => s.n)).toEqual([5]);
});

test("a done step shows a time only when work was seen in it", () => {
  const j = job([]), old = job([], { legacy: true });
  expect(stepTime(j, S(1, "done", { workCalls: 0, activatedAt: 1000, closedAt: 2000 }))).toBe("nowork");
  expect(stepTime(j, S(1, "done", { workCalls: 3, activatedAt: 1000, closedAt: 61000 }))).toEqual({ ms: 60000 });
  expect(stepTime(j, S(1, "done", { workCalls: undefined, activatedAt: 1000, closedAt: 2000 }))).toBeNull(); // not counted, so no claim
  expect(stepTime(j, S(1, "active", { workCalls: 3, activatedAt: 1000 }))).toBeNull();
  expect(stepTime(j, S(1, "done", { workCalls: 2 }))).toBeNull();
  expect(stepTime(old, S(1, "done", { workCalls: 0, activatedAt: 1000, closedAt: 2000 }))).toBeNull(); // the old tools: no "no work seen"
  expect(stepTime(old, S(1, "done", { workCalls: 3, activatedAt: 1000, closedAt: 61000 }))).toEqual({ ms: 60000 });
  expect(plain(old)).toBe(true);
  expect(plain(j)).toBe(false);
});

test("a closed-out job: the step in work reads unfinished, the rest dropped", () => {
  const j = job([S(1, "done"), S(2, "dropped", { unfinished: true, activatedAt: 5, reason: "despawn: unfinished" }), S(3, "dropped", { unfinished: true, reason: "despawn" }), S(4, "dropped", { reason: "not needed" })], { closedAt: 9, outcome: "dropped" });
  expect(j.steps.map(stepLook)).toEqual(["done", "unfinished", "dropped", "dropped"]);
  expect(planCount(j)).toMatchObject({ dropped: 1, unfinished: 2 });
  expect(jobWord(j)).toBe("Job 2 dropped");
  expect(jobWord(job([S(1, "active")]))).toBeNull();
});

test("proof shows on done steps of a planned job, never on a job run with the old tools", () => {
  const ev = [{ kind: "commit" as const, value: "abc1234", ok: true }], old = [{ kind: "none" as const, value: "old tool", ok: null }];
  expect(proofs(job([S(1, "done", { evidence: ev })]), S(1, "done", { evidence: ev }))).toEqual(ev);
  expect(proofs(job([]), S(1, "pending", { evidence: ev }))).toEqual([]);
  expect(proofs(job([], { legacy: true }), S(1, "done", { evidence: old }))).toEqual([]);
});

test("current job, earlier jobs newest first, open asks; an agent from before jobs has none", () => {
  const a = { jobs: [job([], { id: 1, closedAt: 5, outcome: "done" }), job([], { id: 2, closedAt: 8, outcome: "blocked" }), job([S(1, "active")], { id: 3 })],
    asks: [{ id: 10, from: "root", subject: "a", at: 1, closedAt: null }, { id: 11, from: "root", subject: "b", at: 2, closedAt: 3, closedBy: "reply" as const }] };
  expect(curJob(a)?.id).toBe(3);
  expect(earlierJobs(a).map((j) => j.id)).toEqual([2, 1]);
  expect(openAsks(a).map((k) => k.id)).toEqual([10]);
  expect(curJob({})).toBeNull();
  expect(earlierJobs({})).toEqual([]);
  expect(openAsks({})).toEqual([]);
});

test("the card line: the step in work, how the job ended, or nothing", () => {
  const st = (n: number, status: Step["status"], x: Partial<Step> = {}): Step => ({ n, text: "s" + n, origin: "brief", originMsg: null, status, evidence: [], addedAt: 0, ...x });
  const jb = (steps: Step[], x: Partial<Job> = {}): Job => ({ id: 2, goal: null, brief: null, openedBy: "root", openedAt: 0, closedAt: null, outcome: null, plan: steps.length, steps, ...x });
  expect(planLine({ jobs: [jb([st(1, "done"), st(2, "active")])] })).toEqual({ no: "2.2", text: "s2" });
  expect(planLine({ jobs: [jb([st(1, "done"), st(2, "pending")])] })).toBeNull();
  expect(planLine({ jobs: [jb([st(1, "active")], { legacy: true })] })).toBeNull();
  expect(planLine({ jobs: [] })).toBeNull();
  expect(planLine({})).toBeNull();
  const done = jb([st(1, "done")], { closedAt: 9, outcome: "done" });
  expect(planLine({ jobs: [done] })).toEqual({ ended: done, at: null });
  const cut = jb([st(1, "done"), st(2, "dropped", { unfinished: true, activatedAt: 4 }), st(3, "dropped", { unfinished: true })], { closedAt: 9, outcome: "dropped" });
  expect(planLine({ jobs: [cut] })).toEqual({ ended: cut, at: "2.2" });
  expect(endedText({ ended: done, at: null }, "6m")).toBe("Job 2 done · reported 6m ago");
  expect(endedText({ ended: cut, at: "2.2" }, "6m")).toBe("Job 2 dropped at step 2.2");
});
