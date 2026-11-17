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

describe("statsCache", () => {
  const { statsCache } = require("./trailStats") as typeof import("./trailStats");
  const empty = computeStats([], () => [], T, 1);
  const make = (ttl = 300_000) => {
    let clock = 1000, calls = 0, release: (() => void)[] = [];
    const c = statsCache({ ttl, now: () => clock, compute: () => { calls++; return new Promise((res) => release.push(() => res(empty))); } });
    return { c, tick: (ms: number) => { clock += ms; }, calls: () => calls, finish: () => { release.splice(0).forEach((f) => f()); } };
  };
  test("first call has no result, starts one compute, never two", async () => {
    const m = make();
    expect(m.c.get(14)).toBeNull(); expect(m.c.get(14)).toBeNull();
    expect(m.calls()).toBe(1);
    m.finish(); await m.c.idle();
    expect(m.c.get(14)?.at).toBe(1000);
  });
  test("fresh result is served with no recompute", async () => {
    const m = make(); m.c.get(14); m.finish(); await m.c.idle();
    m.tick(299_000);
    expect(m.c.get(14)?.refreshing).toBe(false);
    expect(m.calls()).toBe(1);
  });
  test("stale result is served at once and refreshed once in the background", async () => {
    const m = make(); m.c.get(14); m.finish(); await m.c.idle();
    m.tick(301_000);
    const r = m.c.get(14); m.c.get(14);
    expect(r?.at).toBe(1000); expect(r?.refreshing).toBe(true);
    expect(m.calls()).toBe(2);
    m.finish(); await m.c.idle();
    expect(m.c.get(14)?.at).toBe(302_000);
  });
  test("nothing computes until someone asks", () => { const m = make(); expect(m.calls()).toBe(0); });
});

describe("statsCache onReady", () => {
  const { statsCache } = require("./trailStats") as typeof import("./trailStats");
  test("fires once per finished compute, not on a fresh hit", async () => {
    const empty = computeStats([], () => [], T, 1);
    const seen: number[] = [];
    const c = statsCache({ ttl: 1000, now: () => 5, compute: async () => empty, onReady: (d) => seen.push(d) });
    c.get(14); await c.idle(); c.get(14); await c.idle();
    expect(seen).toEqual([14]);
  });
});

describe("statsWatch", () => {
  const { statsWatch, statsCache } = require("./trailStats") as typeof import("./trailStats");
  function setup() {
    let t = 1000; const fns: Array<() => void> = []; let cleared = 0, active = 0, runs = 0;
    const c = statsCache({ ttl: 300_000, now: () => t, compute: async () => { runs++; await new Promise((r) => setTimeout(r, 5)); return computeStats([], () => [], T, 1); } });
    const w = statsWatch(c, { days: 14, every: 300_000, set: (fn) => { fns.push(fn); active++; return fns.length; }, clear: () => { cleared++; active--; } });
    return { c, w, tick: () => fns[fns.length - 1]?.(), adv: (ms: number) => { t += ms; }, runs: () => runs, cleared: () => cleared, active: () => active };
  }
  test("no subscriber, no recompute", async () => {
    const s = setup(); await s.c.idle();
    expect(s.runs()).toBe(0); expect(s.active()).toBe(0);
  });
  test("subscriber: first look computes, then one recompute per 5 min tick, one at a time", async () => {
    const s = setup(); s.w.add("a"); s.w.add("b"); // second client shares the one timer
    expect(s.active()).toBe(1); await s.c.idle(); expect(s.runs()).toBe(1);
    s.adv(300_000); s.tick(); s.tick(); // a tick while one is running starts no second one
    expect(s.c.runs()).toBe(1); await s.c.idle(); expect(s.runs()).toBe(2);
    s.w.remove("a"); expect(s.active()).toBe(1); s.w.remove("b"); expect(s.active()).toBe(0); expect(s.cleared()).toBe(1);
  });
});
