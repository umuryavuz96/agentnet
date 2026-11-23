import { expect, test } from "bun:test";
import { agoMs, chartGeom, checkText, groupByRole, nearest, pickShare, r1, STATUS, type LineRow } from "./lines";

const row = (line: string, role: string, status: LineRow["status"], baseline: number | null = null): LineRow => ({ line, role, status, current: 1, baseline, parent: null, jobs: 0, lastReward: null, lastPick: null });

test("lines: grouped by role A-Z, retired last, names in numeric order", () => {
  const g = groupByRole([row("web-10", "web", "active", 4), row("ops-1", "ops", "active"), row("web-2", "web", "retired", 4.9), row("web-9", "web", "probation", 3.1)]);
  expect(g.map((x) => x.role)).toEqual(["ops", "web"]);
  expect(g[1].lines.map((l) => l.line)).toEqual(["web-9", "web-10", "web-2"]);
  expect(g[1].live).toBe(2);
  expect(g[1].best).toBe(4); // a retired line never counts as the role's best
});
test("lines: every status has an icon and a word", () => {
  for (const s of ["active", "probation", "retired"] as const) { expect(STATUS[s].icon).toBeTruthy(); expect(STATUS[s].label.length).toBeGreaterThan(3); }
  expect(new Set(Object.values(STATUS).map((s) => s.icon)).size).toBe(3);
});
test("lines: chart y is the fixed 1-5 scale and skips missing baselines", () => {
  const g = chartGeom([{ gen: 1, job: 1, at: 0, reward: 5, baseline: null }, { gen: 2, job: 1, at: 0, reward: 1, baseline: 1 }, { gen: 3, job: 1, at: 0, reward: 5, baseline: 5 }], 228, 132);
  expect(g.yOf(1)).toBe(g.y0); expect(g.yOf(5)).toBe(g.y1); expect(g.yOf(9)).toBe(g.y1);
  expect(g.path.startsWith("M")).toBe(true); expect(g.path.split("L").length).toBe(2);
  expect(g.xs[0]).toBe(g.x0); expect(g.xs[2]).toBe(g.x1);
  expect(nearest(g.xs, g.x1 - 3)).toBe(2);
});
test("lines: labels", () => {
  expect(r1(null)).toBe("–"); expect(r1(4.26)).toBe("4.3"); expect(r1(4)).toBe("4.0");
  expect(agoMs(null)).toBe("never"); expect(agoMs(1000, 1000 + 3 * 3600e3)).toBe("3 h ago");
  expect(checkText({ tool: "Bash", command_includes: "ui-check", output_includes: "PASS" })).toBe('Bash call containing "ui-check", output has "PASS"');
  expect(checkText({ judgment: true })).toContain("judgment");
  expect(pickShare([{ id: 1, ts: 0, chosen: "a", prob: 0.7, p: 0.7, fallback: false, candidates: [] }, { id: 2, ts: 0, chosen: "b", prob: null, p: null, fallback: true, candidates: [] }], "a")).toEqual({ chosen: 1, total: 2, fallback: 1 });
});
