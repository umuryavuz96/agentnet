import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFS, QUICK_MAX, addQuick, parsePrefs } from "./chatPrefs";

describe("chat prefs", () => {
  test("nothing stored or broken text gives the defaults", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("{not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[1,2]")).toEqual(DEFAULT_PREFS);
  });
  test("each field is checked on its own", () => {
    expect(parsePrefs(JSON.stringify({ sendKey: "mod", busy: "nope", size: "l", quick: "x" }))).toEqual({ ...DEFAULT_PREFS, sendKey: "mod", size: "l" });
    expect(parsePrefs(JSON.stringify({ busy: "interrupt", quick: [] }))).toEqual({ ...DEFAULT_PREFS, busy: "interrupt", quick: [] });
  });
  test("quick prompts: trimmed, no repeats, no non-text, capped", () => {
    const many = Array.from({ length: 20 }, (_, i) => "p" + i);
    expect(parsePrefs(JSON.stringify({ quick: [" a ", "a", 3, "", "b"] })).quick).toEqual(["a", "b"]);
    expect(parsePrefs(JSON.stringify({ quick: many })).quick).toHaveLength(QUICK_MAX);
    expect(parsePrefs(JSON.stringify({ quick: ["x".repeat(900)] })).quick[0]).toHaveLength(400);
  });
  test("addQuick adds once and stops at the cap", () => {
    expect(addQuick(["a"], " b ")).toEqual(["a", "b"]);
    const same = ["a"];
    expect(addQuick(same, "a")).toBe(same);
    expect(addQuick(same, "  ")).toBe(same);
    const full = Array.from({ length: QUICK_MAX }, (_, i) => "p" + i);
    expect(addQuick(full, "new")).toBe(full);
  });
});
