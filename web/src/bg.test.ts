import { describe, expect, test } from "bun:test";
import { bgShown, bgVisible, BG_KEEP_MS, BG_STALE_MS } from "./bg";
import type { BgRow } from "./net";
const row = (o: Partial<BgRow>): BgRow => ({ id: "x", kind: "shell", label: "l", state: "running", startedAt: 0, endedAt: null, ...o });
describe("bg rows", () => {
  test("running past an hour is stale, fresh is running", () => {
    expect(bgShown(row({}), BG_STALE_MS - 1)).toBe("running");
    expect(bgShown(row({}), BG_STALE_MS + 1)).toBe("stale");
    expect(bgShown(row({ state: "done", endedAt: 5 }), BG_STALE_MS * 2)).toBe("done");
  });
  test("finished rows leave after 2 min, stale rows 2 min after turning stale", () => {
    expect(bgVisible([row({ state: "done", endedAt: 0 })], BG_KEEP_MS - 1)).toHaveLength(1);
    expect(bgVisible([row({ state: "done", endedAt: 0 })], BG_KEEP_MS + 1)).toHaveLength(0);
    expect(bgVisible([row({})], BG_STALE_MS + 1)).toHaveLength(1);
    expect(bgVisible([row({})], BG_STALE_MS + BG_KEEP_MS + 1)).toHaveLength(0);
  });
});
