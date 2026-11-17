import { expect, test } from "bun:test";
import { pickCounts } from "./pickCounts";

test("owner-named wins and the three counts sum to the total", () => {
  const l = [{ owner: true, changed: true }, { owner: true, changed: false }, { owner: false, changed: true }, { owner: false, changed: false }, { owner: false, changed: false }];
  expect(pickCounts(l)).toEqual({ owner: 2, mode: 1, kept: 2, total: 5 });
  const c = pickCounts(l); expect(c.owner + c.mode + c.kept).toBe(c.total);
});
test("empty list is all zeros", () => { expect(pickCounts([])).toEqual({ owner: 0, mode: 0, kept: 0, total: 0 }); });
