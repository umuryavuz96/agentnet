import { describe, expect, test } from "bun:test";
const { computeStats, usedOf } = await import("./trailStats");
type Row = import("./trailStats").Row;

const T = Date.parse("2026-11-07T20:00:00Z");
const iso = (ms: number) => new Date(T + ms).toISOString();
const row = (o: Partial<Row>): Row => ({ ts: iso(0), agent: "a", source: "task_add", query: "q", hits: [], ...o });

describe("usedOf", () => {
  test("a Read of a hit file within 30 min counts, later or earlier does not", () => {
    const r = row({ hits: ["commit:80a76be"], files: ["web/src/App.vue"] });
    expect(usedOf(r, [{ ts: T + 5 * 60_000, target: "/home/x/projects/app/web/src/App.vue" }])).toBe(true);
    expect(usedOf(r, [{ ts: T + 31 * 60_000, target: "/x/web/src/App.vue" }])).toBe(false);
    expect(usedOf(r, [{ ts: T - 1000, target: "/x/web/src/App.vue" }])).toBe(false);
  });
  test("naming the commit hash or the note file in a command counts", () => {
    expect(usedOf(row({ hits: ["commit:80a76be1234"] }), [{ ts: T + 1000, target: "git show 80a76be" }])).toBe(true);
    expect(usedOf(row({ hits: ["note:2026-11-07-web-dev-1-x.md"] }), [{ ts: T + 1000, target: "var/trails/2026-11-07-web-dev-1-x.md" }])).toBe(true);
  });
  test("a path cut at 80 chars still matches by its last segments", () => {
    const r = row({ hits: ["commit:80a76be"], files: ["web/src/components/agentnet/AgentnetUsage.vue"] });
    expect(usedOf(r, [{ ts: T + 1000, target: "/home/x/projects/app/web/src/components/agentnet/AgentnetUsa" }])).toBe(true);
  });
  test("no hits, or nothing to match on, is not checkable", () => {
    expect(usedOf(row({ hits: [] }), [])).toBeNull();
    expect(usedOf(row({ hits: ["session:abc"] }), [{ ts: T + 1, target: "x" }])).toBeNull();
  });
});

describe("computeStats", () => {
  const rows: Row[] = [
    row({ source: "task_add", hits: ["commit:aaaaaaa1"], files: ["a/x.ts"], query: "fix panel" }),
    row({ source: "task_add", hits: [], skipped: "no hit above threshold" }),
    row({ source: "trail_search", agent: "b", hits: ["commit:bbbbbbb1"], files: ["b/y.ts"], query: "Teams routes", ms: 40 }),
    row({ source: "trail_search", agent: "b", hits: [], query: "teams  routes" }),
  ];
  const touches = (agent: string) => (agent === "a" ? [{ ts: T + 60_000, target: "/r/a/x.ts" }] : []);
  const s = computeStats(rows, touches, T + 3600_000, 3);
  test("counts and rates", () => {
    expect(s.totals).toMatchObject({ searches: 2, injects: 2, injected: 1, injectRate: 0.5, searchHitRate: 0.5, used: 1, checkable: 2, usedRate: 0.5 });
  });
  test("top queries merge case and spacing; per agent; latest shows hits with the used flag", () => {
    expect(s.topQueries[0]).toEqual({ query: "teams routes", n: 2 });
    expect(s.agents.find((a) => a.agent === "a")).toMatchObject({ injects: 2, injected: 1, used: 1, checkable: 1 });
    expect(s.latest.map((l) => [l.agent, l.used])).toEqual([["b", false], ["a", true]]);
    expect(s.days.length).toBe(3); expect(s.days.at(-1)).toMatchObject({ searches: 2, injects: 2 });
  });
});
