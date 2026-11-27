import { describe, expect, test } from "bun:test";
import { CUT_TTL, cutLately, cutTurn, ownerCapable, ownerHas, ownerPush, ownerReady, ownerReset, ownerTake, ownerTakeCut, setOwnerAbortable, setOwnerCapable, setOwnerWaker } from "./ownerPlugin";
import { pollOpened } from "./liveness";

describe("owner queue", () => {
  test("push wakes the poll; take empties (at most once)", () => {
    ownerReset(); setOwnerCapable("a-1", true); const woke: string[] = []; setOwnerWaker((n) => woke.push(n));
    ownerPush("a-1", { nonce: "n", text: "t", at: 1 }); ownerPush("a-1", { nonce: null, text: "u", at: 2 });
    expect(woke).toEqual(["a-1", "a-1"]); expect(ownerReady("a-1")).toBe(true);
    expect(ownerTake("a-1").map((i) => i.text)).toEqual(["t", "u"]); expect(ownerTake("a-1")).toEqual([]);
    expect(ownerReady("a-1")).toBe(false);
  });
  test("held until a plugin that can take it says hello; sends without a nonce are never merged", () => {
    ownerReset(); setOwnerWaker(() => {});
    ownerPush("a-1", { nonce: null, text: "t", at: 1 }); ownerPush("a-1", { nonce: null, text: "t", at: 2 });
    expect(ownerCapable("a-1")).toBe(false); expect(ownerReady("a-1")).toBe(false); expect(ownerTake("a-1")).toEqual([]);
    expect(ownerHas("a-1")).toBe(true);
    setOwnerCapable("a-1", true);
    expect(ownerCapable("a-1")).toBe(true); expect(ownerTake("a-1")).toHaveLength(2);
  });
});

describe("ending the turn through the plugin", () => {
  test("only a polling plugin that can abort takes a cut; the poll takes it once", () => {
    ownerReset(); const woke: string[] = []; setOwnerWaker((n) => woke.push(n));
    setOwnerCapable("c-1", true); pollOpened("c-1#1");
    expect(cutTurn("c-1", "c-1#1", "t1")).toBe(false); // an older plugin: owner chat, no abort
    setOwnerAbortable("c-1", true);
    expect(cutTurn("c-1", "never-polled", "t1")).toBe(false);
    expect(ownerReady("c-1")).toBe(false); expect(cutLately("c-1")).toBe(false);
    expect(cutTurn("c-1", "c-1#1", "t1")).toBe(true);
    expect(woke).toEqual(["c-1"]); expect(ownerReady("c-1")).toBe(true); expect(cutLately("c-1")).toBe(true);
    expect(ownerTakeCut("c-1")).toBe("t1"); expect(ownerTakeCut("c-1")).toBeNull(); expect(ownerReady("c-1")).toBe(false);
  });
  test("a cut the plugin did not fetch in time is dropped, so it never ends a later turn", () => {
    ownerReset(); setOwnerWaker(() => {}); setOwnerCapable("c-2", true); setOwnerAbortable("c-2", true); pollOpened("c-2#1");
    cutTurn("c-2", "c-2#1", "");
    expect(ownerTakeCut("c-2", Date.now() + CUT_TTL + 1)).toBeNull();
  });
});
