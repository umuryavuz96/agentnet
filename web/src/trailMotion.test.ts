// Which motion a change of the live row plays. The earlier port waited for "done" and "next started" in one frame; the
// live stream sends them apart, so the head and the opening branch never ran. These cases keep both orders working.
import { expect, test } from "bun:test";
import { trailChange, type TrailSig } from "./trailMotion";
const s = (p: Partial<TrailSig>): TrailSig => ({ name: "a", done: [0, 1], cur: 2, check: 0, rows: [], ...p });

test("done and next start in one frame: finish and arrival together", () => {
  expect(trailChange(s({}), s({ done: [0, 1, 2], cur: 3 }))).toEqual({ how: "complete", from: 2, to: 3 });
});
test("done alone, then start alone: the finish first, the arrival second, from the last done step", () => {
  expect(trailChange(s({}), s({ done: [0, 1, 2], cur: -1 }))).toEqual({ how: "complete", from: 2, to: -1 });
  expect(trailChange(s({ done: [0, 1, 2], cur: -1 }), s({ done: [0, 1, 2], cur: 3 }))).toEqual({ how: "start", from: 2, to: 3 });
});
test("first step starts with nothing done: no head run", () => {
  expect(trailChange(s({ done: [], cur: -1 }), s({ done: [], cur: 0 }))).toEqual({ how: "start", from: -1, to: 0 });
});
test("question arrives, question answered, a new call row", () => {
  expect(trailChange(s({}), s({ check: 7 })).how).toBe("gate");
  expect(trailChange(s({ check: 7 }), s({})).how).toBe("answer");
  expect(trailChange(s({ rows: ["act:1"] }), s({ rows: ["act:2"] })).how).toBe("tick");
});
test("another agent in the open panel: redraw, no step motion", () => {
  expect(trailChange(s({}), s({ name: "b", done: [0, 1, 2], cur: 3 })).how).toBe("agent");
});
