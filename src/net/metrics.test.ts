import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-metrics-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const sc = await import("./scores");
const m = await import("./metrics");

const MON = Date.parse("2026-11-16T10:00:00Z"), DAY = 86_400_000, MIN = 60_000;
const NOW = Date.parse("2026-11-21T12:00:00Z");
const rec = (o: Partial<import("./metrics").Rec> = {}): import("./metrics").Rec => ({ role: "web-dev", project: null, closedAt: MON, wallMs: 10 * MIN, costUsd: 1, tokens: 100, rework: false, ownerRounds: 0, ownerComplaint: false, ...o });

describe("weeks and medians", () => {
  test("weekOf is the Monday, UTC", () => {
    expect(m.weekOf(Date.parse("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
    expect(m.weekOf(Date.parse("2026-11-22T23:59:00Z"))).toBe("2026-11-16");
    expect(m.weekOf(Date.parse("2026-11-23T00:00:01Z"))).toBe("2026-11-23");
  });
  test("lastWeeks ends with the current week", () => {
    const w = m.lastWeeks(NOW, 3);
    expect(w).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
  });
  test("median of odd, even and empty", () => {
    expect(m.median([5, 1, 3])).toBe(3);
    expect(m.median([1, 2, 3, 10])).toBe(2.5);
    expect(m.median([])).toBeNull();
  });
});

describe("kinds", () => {
  test("role names sort into kinds, first rule wins", () => {
    expect(m.kindOf("web-dev-2")).toBe("web UI");
    expect(m.kindOf("site-designer")).toBe("web UI");
    expect(m.kindOf("game-designer")).toBe("game");
    expect(m.kindOf("ios-dev-x")).toBe("mobile");
    expect(m.kindOf("backend")).toBe("backend");
    expect(m.kindOf("redesign-taste")).toBe("design");
    expect(m.kindOf("researcher")).toBe("research & plan");
    expect(m.kindOf("zzz")).toBe("other");
  });
  test("a role that says nothing falls back to the goal; the owner's rules go first", () => {
    expect(m.kindOfRec({ role: "zzz", goal: "fix the api route" })).toBe("backend");
    expect(m.kindOfRec({ role: "zzz", goal: null })).toBe("other");
    expect(m.kindOfRec({ role: "web-dev", goal: null }, [["mine", /web/]])).toBe("mine");
  });
});

describe("trend", () => {
  test("per kind and week: medians, rates, n and the thin flag", () => {
    const t = m.trend([
      rec({ wallMs: 10 * MIN, costUsd: 1, rework: true, ownerRounds: 1 }),
      rec({ wallMs: 30 * MIN, costUsd: 3, ownerRounds: 0 }),
      rec({ wallMs: 20 * MIN, costUsd: 2, ownerRounds: 0 }),
      rec({ role: "backend", wallMs: 5 * MIN }),
      rec({ closedAt: MON - 70 * DAY }), // outside the 8 weeks
    ], { now: NOW });
    expect(t.total).toBe(4);
    expect(t.kinds.map((k) => k.kind)).toEqual(["web UI", "backend"]);
    const p = t.kinds[0].points.at(-1)!;
    expect(p).toMatchObject({ week: "2026-11-16", n: 3, wallMin: 20, costUsd: 2, nCost: 3, reworkRate: 0.33, rounds: 0.33, nRounds: 3, caughtRate: 0.33, nCaught: 3, thin: false });
    expect(t.kinds[0].points[0]).toMatchObject({ n: 0, wallMin: null, thin: false });
    expect(t.kinds[1].points.at(-1)).toMatchObject({ n: 1, thin: true });
    expect(t.thin).toBe(1);
  });
  test("unknown owner rounds are not zero: caught rate counts only known jobs", () => {
    const t = m.trend([rec({ ownerRounds: null }), rec({ ownerRounds: null, ownerComplaint: true }), rec({ ownerRounds: 0 }), rec({ ownerRounds: 2 })], { now: NOW });
    const p = t.kinds[0].points.at(-1)!;
    expect(p.nCaught).toBe(3); // the first job is unknown
    expect(p.caughtRate).toBe(0.67);
    expect(p.nRounds).toBe(2);
    expect(p.rounds).toBe(1);
  });
  test("fill rates flag sparse fields", () => {
    const t = m.trend([rec({ costUsd: null, ownerRounds: null }), rec({ costUsd: null, ownerRounds: null }), rec({ costUsd: 1 })], { now: NOW });
    const f = Object.fromEntries(t.fill.map((x) => [x.field, x]));
    expect(f["cost"]).toMatchObject({ have: 1, of: 3, pct: 33, sparse: true });
    expect(f["wall time"].sparse).toBe(false);
  });
  test("an empty list gives an empty trend, not a crash", () => {
    const t = m.trend([], { now: NOW });
    expect(t.kinds).toEqual([]);
    expect(m.formatTrend(t)).toContain("0 closed jobs");
  });
  test("formatTrend prints only weeks with jobs, marks thin ones and names sparse fields", () => {
    const out = m.formatTrend(m.trend([rec({ costUsd: null }), rec({ costUsd: null })], { now: NOW }));
    expect(out).toContain("web UI (2)");
    expect(out).toContain("2026-11-16  2*");
    expect(out).not.toContain("2026-11-09 ");
    expect(out).toContain("too sparse to trust: cost, tokens".replace(", tokens", "") );
  });
});

describe("reading the databases", () => {
  test("jobs: wall falls back to closed minus opened; complaints join on agent and job", () => {
    const s = new Database(":memory:"); sc.useScoreDb(s);
    const main = new Database(":memory:"); useDatabase(main);
    main.run("CREATE TABLE IF NOT EXISTS owner_learned (goal_id INTEGER, agent_id TEXT, job_id INTEGER, type TEXT, at INTEGER)");
    main.run("INSERT INTO owner_learned VALUES (1, 'a#1', 1, 'complaint', 0), (2, 'a#1', 2, 'praise', 0)");
    const ins = "INSERT INTO job_scores (agent, agent_id, gen, role, job_id, goal, opened_at, closed_at, outcome, wall_ms, cost_usd, rework, owner_rounds) VALUES ('a','a#1',1,'web-dev',?,?,?,?, 'done', ?, ?, ?, ?)";
    s.run(ins, [1, "g", MON, MON + 5 * MIN, null, 2.5, 1, null]);
    s.run(ins, [2, "g", MON, MON + 7 * MIN, 9 * MIN, null, 0, 0]);
    const r = m.loadRecords("job", s, main);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ wallMs: 5 * MIN, costUsd: 2.5, rework: true, ownerRounds: null, ownerComplaint: true });
    expect(r[1]).toMatchObject({ wallMs: 9 * MIN, costUsd: null, ownerComplaint: false });
  });
  test("old tasks: wall is done minus started, null without a start", () => {
    const s = new Database(":memory:"); sc.useScoreDb(s);
    const ins = "INSERT INTO agent_scores (agent, agent_id, role, task_id, text, started_at, done_at, tokens) VALUES ('a','a#1','web-dev',?, 't', ?, ?, 0)";
    s.run(ins, [1, MON, MON + 3 * MIN]); s.run(ins, [2, null, MON]);
    const r = m.loadRecords("task", s, new Database(":memory:"));
    expect(r.map((x) => x.wallMs)).toEqual([3 * MIN, null]);
    expect(r[0].tokens).toBeNull();
  });
  test("the route answers with the trend and ignores a bad weeks value", async () => {
    const s = new Database(":memory:"); sc.useScoreDb(s); useDatabase(new Database(":memory:"));
    s.run("INSERT INTO job_scores (agent, agent_id, gen, role, job_id, opened_at, closed_at, outcome) VALUES ('a','a#1',1,'backend',1,?,?, 'done')", [Date.now() - MIN, Date.now()]);
    const api = new Hono(); m.metricsRoute(api as never);
    const r = await api.request("/agentnet/metrics?weeks=abc");
    const b = await r.json() as import("./metrics").Trend;
    expect(r.status).toBe(200);
    expect(b.weeks).toHaveLength(8);
    expect(b.kinds[0].kind).toBe("backend");
    expect(((await (await api.request("/agentnet/metrics?weeks=3&unit=task")).json()) as import("./metrics").Trend)).toMatchObject({ unit: "task", total: 0 });
  });
});

describe("daily series for the usage and cost charts", () => {
  const D = (n: number) => NOW - n * DAY; // n days before NOW (NOW is 2026-11-21)
  test("14 days, oldest first, a day without jobs is null and not zero", () => {
    const d = m.dailySeries([rec({ closedAt: D(0), costUsd: 2, tokens: 1000 })], NOW);
    expect(d.days.length).toBe(14);
    expect(d.days[0]).toBe("2026-11-08");
    expect(d.days[13]).toBe("2026-11-21");
    const all = d.cost[0];
    expect(all.kind).toBe("All work");
    expect(all.points[12]).toMatchObject({ n: 0, value: null, few: false });
    expect(all.points[13]).toMatchObject({ n: 1, value: 2, few: true });
  });
  test("median per day, per kind plus all work, 3 jobs is not few", () => {
    const rs = [1, 2, 9].map((c) => rec({ closedAt: D(1), costUsd: c })).concat([rec({ role: "backend-dev", closedAt: D(1), costUsd: 5 })]);
    const d = m.dailySeries(rs, NOW);
    expect(d.cost.map((l) => l.kind)).toEqual(["All work", "web UI", "backend"]);
    expect(d.cost[0].points[12]).toMatchObject({ n: 4, value: 3.5, few: false });
    expect(d.cost[1].points[12]).toMatchObject({ n: 3, value: 2, few: false });
    expect(d.cost[2].points[12]).toMatchObject({ n: 1, value: 5, few: true });
  });
  test("first 7 and last 7 days are medians over the jobs, jobs without the measure are skipped", () => {
    const rs = [rec({ closedAt: D(12), costUsd: 4 }), rec({ closedAt: D(9), costUsd: 6 }), rec({ closedAt: D(2), costUsd: 1 }), rec({ closedAt: D(1), costUsd: null, tokens: null }), rec({ closedAt: D(20), costUsd: 99 })];
    const l = m.dailySeries(rs, NOW).cost[0];
    expect(l).toMatchObject({ first: 5, nFirst: 2, last: 1, nLast: 1 });
    expect(m.dailySeries(rs, NOW).tokens[0].nLast).toBe(1);
  });
});
