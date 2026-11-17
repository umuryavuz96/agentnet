import { expect, test } from "bun:test";
import { buildCrew, crewState, modelShort, flatCount } from "./crewTree";
import type { AgentRow } from "./net";

const row = (name: string, boss: string | null, o: Partial<AgentRow> = {}) => ({ id: name, name, boss, life: "live", state: "idle", ...o }) as unknown as AgentRow;
const R: Record<string, AgentRow> = { lead: row("lead", "root"), a: row("a", "lead"), b: row("b", "a"), c: row("c", "root"), z: row("z", "z") };
const of = (n: string) => R[n] ?? null;

test("lead on top, members by boss link, orphans under the lead", () => {
  const t = buildCrew(["b", "a", "c", "lead"], "lead", of);
  expect(t.length).toBe(1); expect(t[0].name).toBe("lead");
  expect(t[0].kids.map((k) => k.name)).toEqual(["a", "c"]);
  expect(t[0].kids[0].kids.map((k) => k.name)).toEqual(["b"]);
  expect(flatCount(t)).toBe(4);
});
test("boss loop and self boss do not hang or drop a member", () => {
  const L = { x: row("x", "y"), y: row("y", "x"), z: R.z };
  const t = buildCrew(["x", "y", "z"], null, (n) => (L as Record<string, AgentRow>)[n] ?? null);
  expect(flatCount(t)).toBe(3);
});
test("no lead: forest by name; member without a row is off", () => {
  const t = buildCrew(["q", "c"], null, of);
  expect(t.map((n) => n.name)).toEqual(["c", "q"]); expect(t[1].state).toBe("off");
});
test("state and model names", () => {
  expect(crewState(row("a", null, { state: "working" }))).toBe("working");
  expect(crewState(row("a", null, { life: "gone" }))).toBe("done");
  expect(crewState(row("a", null, { reported: { blockedOn: "x" } as AgentRow["reported"] }))).toBe("blocked");
  expect(modelShort("claude-sonnet-5-5")).toBe("sonnet"); expect(modelShort(null)).toBeNull();
});
test("retired member (no row) keeps its last known boss", () => {
  const t = buildCrew(["lead", "a", "w"], "lead", (n) => (n === "w" ? null : of(n)), { w: "a" });
  expect(t[0].name).toBe("lead"); expect(t[0].kids.map((k) => k.name)).toEqual(["a"]); expect(t[0].kids[0].kids.map((k) => k.name)).toEqual(["w"]);
});
