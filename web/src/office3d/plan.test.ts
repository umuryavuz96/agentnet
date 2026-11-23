// The 3D office must re-plan when a new agent or team shows up, without a page reload (2026-11-18).
import { expect, test } from "bun:test";
import { makePlan, peopleKey } from "./plan";

const ag = (name: string, life = "live") => ({ name, life });
const person = (name: string, boss: string | null = "root") => ({ name, model: null, state: "idle" as const, boss, doing: "" });

test("peopleKey changes when a starting agent turns live", () => {
  const before = { "a#1": ag("a"), "b#1": ag("b", "starting") };
  const after = { "a#1": ag("a"), "b#1": ag("b", "live") };
  expect(peopleKey(after, new Set())).not.toBe(peopleKey(before, new Set()));
});
test("peopleKey changes when a live agent stops being live, and when one is still being placed", () => {
  const live = { "a#1": ag("a"), "b#1": ag("b") };
  expect(peopleKey({ ...live, "b#1": ag("b", "gone") }, new Set())).not.toBe(peopleKey(live, new Set()));
  expect(peopleKey(live, new Set(["b"]))).not.toBe(peopleKey(live, new Set()));
});
test("peopleKey ignores order and non-live rows", () => {
  expect(peopleKey({ x: ag("a"), y: ag("b") }, new Set())).toBe(peopleKey({ y: ag("b"), x: ag("a") }, new Set()));
  expect(peopleKey({ x: ag("a"), y: ag("b", "starting") }, new Set())).toBe(peopleKey({ x: ag("a") }, new Set()));
});
test("a new agent and a new team appear in the plan", () => {
  const one = makePlan({ agents: [person("root", null), person("dev-1")], teams: [], aspect: 1.6 });
  expect(one.agents.map((a) => a.name).sort()).toEqual(["dev-1", "root"]);
  const two = makePlan({ agents: [person("root", null), person("dev-1"), person("qa-2", "dev-1")], teams: [{ id: "t1", name: "t1", lead: "dev-1", members: ["dev-1", "qa-2"], goal: "" }], aspect: 1.6 });
  expect(two.agents.some((a) => a.name === "qa-2")).toBe(true);
  expect(two.rooms.some((r) => r.id === "t1" && r.people.length === 2)).toBe(true);
});
