import { expect, test } from "bun:test";
import { nextRun, parseCron } from "./cron";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test("parse: valid and invalid expressions", () => {
  expect(parseCron("*/5 * * * *")).not.toBeNull();
  expect(parseCron("0 10,17 * * 1-5")).not.toBeNull();
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "5-2 * * * *", "a * * * *", "* * * * MON"]) expect(parseCron(bad)).toBeNull();
  expect(parseCron("0 0 * * 7")!.dow.has(0)).toBe(true);
});

test("next run: every minute, steps, strictly after now", () => {
  const t = at(2026, 11, 9, 14, 3);
  expect(nextRun("* * * * *", t)).toBe(at(2026, 11, 9, 14, 4));
  expect(nextRun("*/15 * * * *", t)).toBe(at(2026, 11, 9, 14, 15));
  expect(nextRun("*/15 * * * *", at(2026, 11, 9, 14, 15))).toBe(at(2026, 11, 9, 14, 30));
  expect(nextRun("*/15 * * * *", t + 30_000)).toBe(at(2026, 11, 9, 14, 15)); // seconds do not matter
});

test("next run: daily list, rolls to next day and month and year", () => {
  expect(nextRun("0 10,17 * * *", at(2026, 11, 9, 9, 0))).toBe(at(2026, 11, 9, 10, 0));
  expect(nextRun("0 10,17 * * *", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 9, 17, 0));
  expect(nextRun("0 10,17 * * *", at(2026, 11, 9, 17, 0))).toBe(at(2026, 11, 10, 10, 0));
  expect(nextRun("30 8 1 * *", at(2026, 11, 9, 9, 0))).toBe(at(2026, 12, 1, 8, 30));
  expect(nextRun("0 0 1 1 *", at(2026, 11, 9, 9, 0))).toBe(at(2027, 1, 1, 0, 0));
});

test("next run: day of week, and dom OR dow when both are restricted", () => {
  // 2026-11-09 is a Monday
  expect(nextRun("0 9 * * 1", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 16, 9, 0));
  expect(nextRun("0 9 * * 0", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 15, 9, 0));
  expect(nextRun("0 9 * * 7", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 15, 9, 0));
  expect(nextRun("0 9 15 * 1", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 15, 9, 0)); // the 15th OR a Monday: the 15th comes first
  expect(nextRun("0 9 10 * 1", at(2026, 11, 9, 10, 0))).toBe(at(2026, 11, 10, 9, 0));
});

test("next run: impossible date and invalid input", () => {
  expect(nextRun("0 0 31 2 *", at(2026, 1, 1))).toBeNull();
  expect(nextRun("nope", at(2026, 1, 1))).toBeNull();
  expect(nextRun("0 0 29 2 *", at(2026, 3, 1))).toBe(at(2028, 2, 29, 0, 0)); // leap day
});
