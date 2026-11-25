import { describe, expect, test } from "bun:test";
import { ownerHas, ownerPush, ownerReset, ownerTake, setOwnerCapable, setOwnerWaker, viaPlugin } from "./ownerPlugin";

describe("viaPlugin", () => {
  test("default on for a capable plugin; flag 0 = off, 1 = all, list = those; via overrides", () => {
    ownerReset(); setOwnerCapable("a-1", true);
    expect(viaPlugin("a-1", undefined, undefined)).toBe(true); // default on
    expect(viaPlugin("a-1", undefined, "")).toBe(true);
    expect(viaPlugin("a-1", undefined, "0")).toBe(false);      // turned off
    expect(viaPlugin("a-1", "plugin", "0")).toBe(false);
    expect(viaPlugin("b-1", undefined, undefined)).toBe(false); // not capable: tmux
    expect(viaPlugin("b-1", "plugin", "1")).toBe(false); // not capable
    expect(viaPlugin("a-1", undefined, "1")).toBe(true);
    expect(viaPlugin("a-1", undefined, "x-1, a-1")).toBe(true);
    expect(viaPlugin("a-1", undefined, "x-1")).toBe(false);
    expect(viaPlugin("a-1", "plugin", "x-1")).toBe(true);
    expect(viaPlugin("a-1", "tmux", "1")).toBe(false);
    expect(viaPlugin("a-1", undefined, undefined, true)).toBe(false); // mid-turn: tmux, so it lands in the turn
    expect(viaPlugin("a-1", "plugin", undefined, true)).toBe(true);   // A/B measurements still force it
    setOwnerCapable("a-1", false); expect(viaPlugin("a-1", undefined, "1")).toBe(false);
  });
  test("push wakes the poll; take empties (at most once)", () => {
    ownerReset(); const woke: string[] = []; setOwnerWaker((n) => woke.push(n));
    ownerPush("a-1", { nonce: "n", text: "t", at: 1 }); ownerPush("a-1", { nonce: null, text: "u", at: 2 });
    expect(woke).toEqual(["a-1", "a-1"]); expect(ownerHas("a-1")).toBe(true);
    expect(ownerTake("a-1").map((i) => i.text)).toEqual(["t", "u"]); expect(ownerTake("a-1")).toEqual([]);
  });
});
