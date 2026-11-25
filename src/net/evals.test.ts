import { expect, test } from "bun:test";
import { armStat, evalsSummary, examGrid, noiseBand, pairedOf, systemView, type EvalRun } from "./evals";
const r = (o: Partial<EvalRun>): EvalRun => ({ task_id: "t1", brain: "b", version: "b@v1", lessons_hash: "x", arm: "A", repeat: 1, pass: 1, cost_usd: 1, tokens_in: 0, tokens_out: 0, wall_ms: 1000, at: 1, ...o });
test("cost per passed task counts failed tries", () => {
  const a = armStat([r({ repeat: 1 }), r({ repeat: 2 }), r({ repeat: 3, pass: 0, cost_usd: 2 })]);
  expect(a.passRate).toBeCloseTo(2 / 3); expect(a.reliability).toBe(0); expect(a.costPerPassed).toBe(2);
});
test("nothing passed gives null cost per passed", () => {
  expect(armStat([r({ pass: 0 }), r({ repeat: 2, pass: 0 })]).costPerPassed).toBeNull();
});
test("noise band is the odd-vs-even gap", () => {
  expect(noiseBand([r({ repeat: 1, cost_usd: 1 }), r({ repeat: 2, cost_usd: 1.2 })])).toBeCloseTo(0.2 / 1.1);
  expect(noiseBand([r({})])).toBeNull();
});
test("arms: base first, then lessons, whatever the time order", () => {
  const s = evalsSummary([r({ arm: "all", lessons_hash: "n", at: 1 }), r({ arm: "base", at: 5 })]);
  expect(s.brains[0]!.arms.map((a) => a.arm)).toEqual(["base", "all"]);
});
test("smoke tasks stay out; a smoke-only brain has no verdict", () => {
  const s = evalsSummary([r({ task_id: "seed" })], new Set(["seed"]));
  expect(s.brains[0]!.smoke).toBe(true); expect(s.brains[0]!.arms).toEqual([]);
});
test("paired compares only tasks both arms ran and waits below 3", () => {
  const two = [r({ arm: "base", task_id: "a" }), r({ arm: "all", task_id: "a" }), r({ arm: "base", task_id: "b" }), r({ arm: "all", task_id: "b" }), r({ arm: "all", task_id: "c" })];
  expect(pairedOf(two).ready).toBe(false); expect(pairedOf(two).tasks).toBe(2);
  const three = [...two, r({ arm: "base", task_id: "c", cost_usd: 3 })];
  const p = pairedOf(three); expect(p.ready).toBe(true); expect(p.base!.tries).toBe(3); expect(p.lessons!.tries).toBe(3); expect(p.savedPerJob).toBeCloseTo(5 / 3 - 1, 5);
});
test("grid counts passed tries per task and arm", () => {
  const g = examGrid([r({ repeat: 1 }), r({ repeat: 2, pass: 0, cost_usd: 3 })]);
  expect(g).toEqual([{ brain: "b", task: "t1", arm: "v1 A +L", tries: 2, pass: 1, costMean: 2 }]);
});
test("system saving is (base - lessons) x jobs and goes negative when lessons cost more", () => {
  const mk = (lessonsCost: number) => evalsSummary(["a", "b", "c"].flatMap((t) => [r({ arm: "base", task_id: t, cost_usd: 2 }), r({ arm: "all", task_id: t, cost_usd: lessonsCost })]));
  expect(systemView(mk(1).brains, { b: 10 }).savedUsdEstimate).toBe(10);
  expect(systemView(mk(3).brains, { b: 10 }).savedUsdEstimate).toBe(-10);
  expect(systemView(evalsSummary([r({ arm: "base" })]).brains, { b: 10 }).savedUsdEstimate).toBeNull();
});
