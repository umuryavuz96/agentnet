// Owner (2026-11-24): "the tool trails are getting duplicated on every message got in between them". Text between tool
// calls splits a plan step's work into several runs; each run drew the step header and the plan's next nodes again.
// railLinks joins them: a later run in the same step goes on without a header, only the last one draws what is next.
import { expect, test } from "bun:test";
import { railLinks, railSteps, type FeedItem, type PlanBit, type Row } from "../web/src/chatFeed";

const call = (id: string, ts: number): FeedItem => ({ id, kind: "step", ts, title: "Reading a.ts", status: "ok" }) as FeedItem;
const step = (n: number, status: PlanBit["status"], at?: number, end?: number): PlanBit => ({ n, job: 1, text: `step ${n}`, status, at, end, proofs: [] });
const work = (key: string, items: FeedItem[]): Row => ({ key, at: items[0]!.ts, type: "work", items, steps: items.length, thoughts: 0, failed: 0, running: false, ms: 0 });
const text = (key: string, at: number): Row => ({ key, at, type: "assistant", text: "note" }) as Row;

test("three runs under one open step read as one trail: one header, next nodes only on the last", () => {
  const plan = [step(1, "done", 0, 100), step(2, "active", 100), step(3, "pending"), step(4, "pending")];
  const rows = [work("w1", [call("a", 110)]), text("t1", 120), work("w2", [call("b", 130)]), text("t2", 140), work("w3", [call("c", 150)])];
  const l = railLinks(rows, plan);
  expect([...l.entries()]).toEqual([["w1", { cont: false, tail: false }], ["w2", { cont: true, tail: false }], ["w3", { cont: true, tail: true }]]);
  expect(railSteps(rows[0]!.type === "work" ? rows[0].items : [], plan, false)!.map((g) => g.step?.n)).toEqual([2]);
  expect(railSteps([call("c", 150)], plan, true)!.map((g) => g.step?.n)).toEqual([2, 3, 4]);
});

test("a run that crosses into a new step starts fresh there and the run before keeps its tail", () => {
  const plan = [step(1, "done", 0, 100), step(2, "active", 100), step(3, "pending")];
  const rows = [work("w1", [call("a", 50)]), work("w2", [call("b", 90), call("c", 110)]), work("w3", [call("d", 120)])];
  const l = railLinks(rows, plan);
  expect(l.get("w1")).toEqual({ cont: false, tail: false });
  expect(l.get("w2")).toEqual({ cont: true, tail: false });
  expect(l.get("w3")).toEqual({ cont: true, tail: true });
});

test("runs in different steps stay separate trails", () => {
  const plan = [step(1, "done", 0, 100), step(2, "active", 100), step(3, "pending")];
  const l = railLinks([work("w1", [call("a", 50)]), work("w2", [call("b", 150)])], plan);
  expect(l.get("w1")).toEqual({ cont: false, tail: true });
  expect(l.get("w2")).toEqual({ cont: false, tail: true });
});
