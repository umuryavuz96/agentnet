import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-score-"));
const { computeScore, roleMedians, roleOf, gradePoints, roundsPoints, median, DEFAULTS } = await import("./score");
type R = import("./score").TaskRecord;

const H = 3600_000;
const rec = (o: Partial<R> = {}): R => ({ agent: "web-dev-1", role: "web-dev", model: "m", soul: "s", project: null, taskId: 1, text: "t", startedAt: 0, doneAt: H, tokens: 100, costUsd: 1,
  listedFirst: true, promptStart: true, promptDone: true, noteFilled: true, grade: null, note: null, rework: false, reworkAt: null, ownerRounds: null, gradedAt: null, ...o });
const graded = (n: number, o: Partial<R> = {}) => Array.from({ length: n }, (_, i) => rec({ taskId: i + 1, grade: 5, ownerRounds: 0, ...o }));

describe("helpers", () => {
  test("role = name minus -N; grade 1-5 maps to 0-100; rounds table, capped", () => {
    expect(roleOf("web-dev-12")).toBe("web-dev"); expect(roleOf("root")).toBe("root");
    expect([1, 2, 3, 4, 5].map(gradePoints)).toEqual([0, 25, 50, 75, 100]);
    expect([0, 1, 2, 3, 4, 9].map((n) => roundsPoints(n))).toEqual([100, 70, 45, 25, 10, 10]);
    expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull();
  });
  test("default weights sum to 100", () => { expect(Object.values(DEFAULTS.weights).reduce((a, b) => a + b, 0)).toBe(100); });
});

describe("computeScore edge cases", () => {
  test("no tasks at all: everything null, n/a", () => {
    const s = computeScore([], new Map());
    expect(s.score).toBeNull(); expect(s.tasks).toBe(0); expect(s.sub.quality).toBeNull(); expect(s.sub.reliability).toBeNull(); expect(s.costPerTask).toBeNull();
  });
  test("tasks but no grades: n/a, sub-scores that need no grade still show", () => {
    const rs = [rec(), rec({ taskId: 2 })], s = computeScore(rs, roleMedians(rs));
    expect(s.score).toBeNull(); expect(s.graded).toBe(0); expect(s.sub.quality).toBeNull(); expect(s.sub.reliability).toBe(100); expect(s.sub.efficiency).toBe(75);
  });
  test("one task graded 5: still n/a below 3 graded", () => {
    const rs = graded(1); expect(computeScore(rs, roleMedians(rs)).score).toBeNull();
    const two = graded(2); expect(computeScore(two, roleMedians(two)).score).toBeNull();
  });
  test("three perfect tasks: quality 100, first-time-right 100, rework 100, efficiency 75 at the median -> score 96", () => {
    const rs = graded(3), s = computeScore(rs, roleMedians(rs));
    expect(s.sub).toEqual({ quality: 100, firstTimeRight: 100, efficiency: 75, reliability: 100, rework: 100 });
    expect(s.score).toBe(Math.round((30 * 100 + 20 * 100 + 20 * 75 + 15 * 100 + 15 * 100) / 100)); // 95.. rounded
    expect(s.band).toBe("great");
  });
  test("ungraded tasks do not count in quality, rounds or rework", () => {
    const rs = [...graded(3, { grade: 3 }), rec({ taskId: 9, grade: null })], s = computeScore(rs, roleMedians(rs));
    expect(s.graded).toBe(3); expect(s.tasks).toBe(4); expect(s.sub.quality).toBe(50);
  });
  test("owner rounds: 0,1,2 average 71.7; unset rounds are skipped, not zero", () => {
    const rs = [rec({ taskId: 1, grade: 4, ownerRounds: 0 }), rec({ taskId: 2, grade: 4, ownerRounds: 1 }), rec({ taskId: 3, grade: 4, ownerRounds: 2 }), rec({ taskId: 4, grade: 4, ownerRounds: null })];
    const s = computeScore(rs, roleMedians(rs));
    expect(s.sub.firstTimeRight).toBeCloseTo((100 + 70 + 45) / 3, 5); expect(s.avgRounds).toBe(1);
  });
  test("no rounds recorded at all: first-time-right is null and its weight is dropped, not counted as 0", () => {
    const rs = graded(3, { ownerRounds: null }), s = computeScore(rs, roleMedians(rs));
    expect(s.sub.firstTimeRight).toBeNull(); expect(s.score).toBe(Math.round((30 * 100 + 20 * 75 + 15 * 100 + 15 * 100) / 80));
  });
  test("rework: flagged within 24 h counts, flagged later does not", () => {
    const rs = [rec({ taskId: 1, grade: 5, rework: true, reworkAt: H + 2 * H }), rec({ taskId: 2, grade: 5, rework: true, reworkAt: H + 30 * H }), rec({ taskId: 3, grade: 5 }), rec({ taskId: 4, grade: 5 })];
    expect(computeScore(rs, roleMedians(rs)).sub.rework).toBe(75);
  });
  test("outlier cost: one runaway task is capped at 4x the median and cannot push efficiency below 0", () => {
    const rs = [rec({ taskId: 1, costUsd: 1 }), rec({ taskId: 2, costUsd: 1 }), rec({ taskId: 3, costUsd: 1 }), rec({ taskId: 4, costUsd: 1000 })];
    const m = roleMedians(rs); expect(m.get("web-dev")).toBe(1);
    const s = computeScore(rs, m); // ratios 1,1,1,4 -> mean 1.75 -> 100 - 25*1.75
    expect(s.sub.efficiency).toBeCloseTo(100 - 25 * 1.75, 5); expect(s.costPerTask).toBeCloseTo(250.75, 2);
  });
  test("cheaper than the role median scores higher, free = 100, far over = 0", () => {
    const cheap = rec({ taskId: 1, costUsd: 0.5 }), med = rec({ taskId: 2, costUsd: 1 }), dear = rec({ taskId: 3, costUsd: 3 }), m = roleMedians([cheap, med, dear]);
    expect(computeScore([cheap], m).sub.efficiency).toBe(87.5); expect(computeScore([dear], m).sub.efficiency).toBe(25);
    expect(computeScore([rec({ costUsd: 0 })], m).sub.efficiency).toBe(100);
    expect(computeScore([rec({ costUsd: 99 })], new Map([["web-dev", 1]])).sub.efficiency).toBe(0);
  });
  test("no cost data: efficiency null, score still computed from the rest", () => {
    const rs = graded(3, { costUsd: null }), s = computeScore(rs, roleMedians(rs));
    expect(s.sub.efficiency).toBeNull(); expect(s.score).toBe(100); expect(s.costPerTask).toBeNull();
  });
  test("reliability: each missed check costs, stale open tasks count as failed tasks", () => {
    const rs = [rec({ taskId: 1, listedFirst: false }), rec({ taskId: 2, promptDone: false, noteFilled: false })];
    expect(computeScore(rs, new Map()).sub.reliability).toBe(62.5);
    expect(computeScore([rec()], new Map(), DEFAULTS, 1).sub.reliability).toBe(50);
  });
  test("custom weights apply and zero weight drops a sub-score", () => {
    const rs = graded(3, { grade: 5 }), cfg = { ...DEFAULTS, weights: { quality: 1, firstTimeRight: 0, efficiency: 0, reliability: 0, rework: 0 } };
    expect(computeScore(rs, new Map(), cfg).score).toBe(100);
  });
});
