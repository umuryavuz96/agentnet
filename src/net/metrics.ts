// Is the agent system getting better? Closed jobs grouped by kind of work and by week: median wall time, median cost, how often root flagged
// rework, owner rounds per job, and how often the owner came back with a problem after the job was reported done. The owner's rounds and
// complaints count more than root's grade, which is root's own opinion, so grade is not in here at all.
// Pure fold (trend, kindOf, formatTrend) plus one reader of the two databases (loadRecords). Doc: docs/metrics.md.
import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../core/http";
import { db } from "../core/db";
import { ROOT } from "../core/config";
import { scoreDb } from "./scores";

/** One closed job (unit "job") or one old finished task (unit "task"), reduced to what the trend needs. */
export interface Rec {
  role: string; project: string | null; /** What the job was for: only read to sort a job whose role name says nothing. Never printed. */ goal?: string | null; closedAt: number;
  wallMs: number | null; costUsd: number | null; tokens: number | null;
  /** Root marked the work as needing rework. */
  rework: boolean;
  /** How many times the owner came back after "done". null: nobody recorded it (unknown, not zero). */
  ownerRounds: number | null;
  /** The owner complained or asked again about this job (ownerLearn). */
  ownerComplaint: boolean;
}
export type Unit = "job" | "task";

// ---------- kinds of work ----------
export const OTHER = "other";
/** First match wins. Matched on the whole role name (lowercase), so "site-designer" is web before it is design. */
const KIND_RULES: [string, RegExp][] = [
  ["game", /game|economy|narrative|balance|tuner|scene|playtest|player/],
  ["mobile", /ios|mobile|android|swift/],
  ["web UI", /web|site|\bui\b|-ui|front|css|vue|page/],
  ["backend", /backend|\bapi\b|server|\bdb\b|data/],
  ["design", /design|art-|logo|brand|taste|hallmark|emil|motion|animat|visual|polish/],
  ["research & plan", /research|architect|plan|council|audit|review|critic|\bqa\b|test/],
  ["ops", /\bops\b|release|cron|deploy|infra|sweep|update|merge/],
];
/** The owner's own rules: a JSON file `config/metrics-kinds.json` of {"kind": ["regex", ...]} checked before the built-in ones, so a
 *  private role naming scheme never has to live in this repo. */
function ownerRules(): [string, RegExp][] {
  try {
    const f = join(ROOT, "config", "metrics-kinds.json");
    if (!existsSync(f)) return [];
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    return Object.entries(j).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((p) => { try { return [[k, new RegExp(String(p), "i")] as [string, RegExp]]; } catch { return []; } }) : []));
  } catch { return []; }
}
export function kindOf(role: string, extra: [string, RegExp][] = []): string {
  const r = role.toLowerCase();
  for (const [k, re] of [...extra, ...KIND_RULES]) if (re.test(r)) return k;
  return OTHER;
}

/** The role name first; a job whose role says nothing is sorted by its goal text. */
export function kindOfRec(r: Pick<Rec, "role" | "goal">, extra: [string, RegExp][] = []): string {
  const k = kindOf(r.role, extra);
  return k !== OTHER || !r.goal ? k : kindOf(r.goal, extra);
}

// ---------- weeks and medians ----------
const DAY = 86_400_000;
/** The Monday (UTC) of the week of `ts`, as YYYY-MM-DD. */
export function weekOf(ts: number): string {
  const d = new Date(ts), dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, p = 2) => (x == null ? null : Math.round(x * 10 ** p) / 10 ** p);

// ---------- the fold ----------
export interface Point {
  week: string; /** Jobs closed that week. */ n: number;
  wallMin: number | null; nWall: number; costUsd: number | null; nCost: number;
  /** Share of the n jobs root flagged for rework (0..1). */ reworkRate: number | null;
  /** Mean owner rounds over the jobs where it was recorded. */ rounds: number | null; nRounds: number;
  /** Share of jobs where the owner came back (rounds > 0 or a complaint), over the jobs where that is known. */ caughtRate: number | null; nCaught: number;
  /** Fewer than THIN jobs: read the point with care. */ thin: boolean;
}
export interface KindTrend { kind: string; n: number; points: Point[] }
export interface Fill { field: string; have: number; of: number; pct: number; sparse: boolean }
/** One day of one line: the median over the jobs closed that day that have the measure (n of them). */
export interface DayPoint { day: string; n: number; value: number | null; few: boolean }
/** One line of a daily chart. first/last: median over all jobs of the first 7 and the last 7 of the days, with their counts. */
export interface DailyLine { kind: string; points: DayPoint[]; first: number | null; nFirst: number; last: number | null; nLast: number }
export interface Daily { days: string[]; tokens: DailyLine[]; cost: DailyLine[] }
export interface Trend { unit: Unit; weeks: string[]; kinds: KindTrend[]; total: number; fill: Fill[]; thin: number; at: number; daily: Daily }
export const THIN = 3, SPARSE_PCT = 60;

const known = (r: Rec) => r.ownerRounds != null || r.ownerComplaint;
const caught = (r: Rec) => (r.ownerRounds ?? 0) > 0 || r.ownerComplaint;

/** The last `weeks` weeks (oldest first, the current one last) as Monday dates. */
export function lastWeeks(now: number, weeks: number): string[] {
  const cur = Date.parse(weekOf(now) + "T00:00:00Z");
  return Array.from({ length: weeks }, (_, i) => new Date(cur - (weeks - 1 - i) * 7 * DAY).toISOString().slice(0, 10));
}

export const ALL_WORK = "All work", DAILY_DAYS = 14;
/** The last `days` days (oldest first, today last) as UTC dates. */
export function lastDays(now: number, days: number): string[] {
  const cur = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  return Array.from({ length: days }, (_, i) => new Date(cur - (days - 1 - i) * DAY).toISOString().slice(0, 10));
}
/** Tokens and cost per closed job, one point per day, per kind of work plus one line for all work. Days with no job give null, never 0. */
export function dailySeries(recs: Rec[], now: number, extra: [string, RegExp][] = [], nDays = DAILY_DAYS): Daily {
  const days = lastDays(now, nDays), idx = new Map(days.map((d, i) => [d, i])), half = nDays >> 1;
  const inRange = recs.filter((r) => idx.has(new Date(r.closedAt).toISOString().slice(0, 10)));
  const kinds = new Map<string, Rec[]>();
  for (const r of inRange) { const k = kindOfRec(r, extra); (kinds.get(k) ?? kinds.set(k, []).get(k)!).push(r); }
  const order = [...kinds.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const line = (kind: string, rs: Rec[], get: (r: Rec) => number | null, p: number): DailyLine | null => {
    const per: number[][] = days.map(() => []);
    for (const r of rs) { const v = get(r); if (v != null) per[idx.get(new Date(r.closedAt).toISOString().slice(0, 10))!].push(v); }
    if (!per.some((l) => l.length)) return null;
    const a = per.slice(0, half).flat(), b = per.slice(nDays - half).flat();
    return { kind, points: days.map((day, i) => ({ day, n: per[i].length, value: round(median(per[i]), p), few: per[i].length > 0 && per[i].length < THIN })),
      first: round(median(a), p), nFirst: a.length, last: round(median(b), p), nLast: b.length };
  };
  const make = (get: (r: Rec) => number | null, p: number) => [line(ALL_WORK, inRange, get, p), ...order.map(([k, rs]) => line(k, rs, get, p))].filter((l): l is DailyLine => !!l);
  return { days, tokens: make((r) => r.tokens, 0), cost: make((r) => r.costUsd, 2) };
}

export function trend(recs: Rec[], o: { now?: number; weeks?: number; unit?: Unit; extra?: [string, RegExp][] } = {}): Trend {
  const now = o.now ?? Date.now(), wk = lastWeeks(now, o.weeks ?? 8), set = new Set(wk);
  const inRange = recs.filter((r) => set.has(weekOf(r.closedAt)));
  const by = new Map<string, Map<string, Rec[]>>();
  for (const r of inRange) {
    const k = kindOfRec(r, o.extra), w = weekOf(r.closedAt);
    const m = by.get(k) ?? by.set(k, new Map()).get(k)!;
    (m.get(w) ?? m.set(w, []).get(w)!).push(r);
  }
  const kinds: KindTrend[] = [...by.entries()].map(([kind, m]) => {
    const points: Point[] = wk.map((week) => {
      const l = m.get(week) ?? [], wall = l.filter((r) => r.wallMs != null), cost = l.filter((r) => r.costUsd != null), rd = l.filter((r) => r.ownerRounds != null), kn = l.filter(known);
      return { week, n: l.length, wallMin: round(median(wall.map((r) => r.wallMs! / 60_000)), 1), nWall: wall.length, costUsd: round(median(cost.map((r) => r.costUsd!))), nCost: cost.length,
        reworkRate: l.length ? round(l.filter((r) => r.rework).length / l.length, 2) : null, rounds: round(mean(rd.map((r) => r.ownerRounds!))), nRounds: rd.length,
        caughtRate: kn.length ? round(kn.filter(caught).length / kn.length, 2) : null, nCaught: kn.length, thin: l.length > 0 && l.length < THIN };
    });
    return { kind, n: points.reduce((t, p) => t + p.n, 0), points };
  }).sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind));
  const N = inRange.length, fill = (field: string, f: (r: Rec) => boolean): Fill => {
    const have = inRange.filter(f).length, pct = N ? Math.round((have / N) * 100) : 0;
    return { field, have, of: N, pct, sparse: pct < SPARSE_PCT };
  };
  return { unit: o.unit ?? "job", weeks: wk, daily: dailySeries(recs, now, o.extra), kinds, total: N, thin: kinds.reduce((t, k) => t + k.points.filter((p) => p.thin).length, 0), at: now,
    fill: [fill("wall time", (r) => r.wallMs != null), fill("cost", (r) => r.costUsd != null), fill("tokens", (r) => r.tokens != null), fill("owner rounds", (r) => r.ownerRounds != null)] };
}

// ---------- the table root pastes into Telegram ----------
const pct = (x: number | null) => (x == null ? "-" : Math.round(x * 100) + "%");
const pad = (s: string | number, n: number) => String(s).padStart(n);
export function formatTrend(t: Trend): string {
  const out: string[] = [`${t.total} closed ${t.unit === "job" ? "jobs" : "old tasks"}, last ${t.weeks.length} weeks (week = Monday, UTC). * = fewer than ${THIN}.`];
  for (const k of t.kinds) {
    out.push("", `${k.kind} (${k.n})`, "week        n  wall min  cost $  rework  rounds  owner caught");
    for (const p of k.points.filter((q) => q.n > 0)) out.push(`${p.week} ${pad(p.n + (p.thin ? "*" : ""), 3)}  ${pad(p.wallMin ?? "-", 8)}  ${pad(p.costUsd ?? "-", 6)}  ${pad(pct(p.reworkRate), 6)}  ${pad(p.rounds ?? "-", 6)}  ${pad(p.caughtRate == null ? "-" : `${pct(p.caughtRate)} of ${p.nCaught}`, 12)}`);
  }
  const sp = t.fill.filter((f) => f.sparse);
  out.push("", "filled: " + t.fill.map((f) => `${f.field} ${f.pct}%`).join(", "), sp.length ? `too sparse to trust: ${sp.map((f) => f.field).join(", ")}` : "no field under " + SPARSE_PCT + "%");
  return out.join("\n");
}

// ---------- the reader ----------
interface JobRow { role: string; project: string | null; goal: string | null; closed_at: number; opened_at: number; wall_ms: number | null; cost_usd: number | null; tokens: number | null; rework: number; owner_rounds: number | null; agent_id: string; job_id: number }
interface TaskRow { role: string; project: string | null; done_at: number; started_at: number | null; cost_usd: number | null; tokens: number | null; rework: number; owner_rounds: number | null }
/** Reads the closed jobs (or old tasks) and the owner's complaints from the two databases. Tokens at 0 mean "not measured". */
export function loadRecords(unit: Unit = "job", scores = scoreDb(), main = db()): Rec[] {
  if (unit === "task") {
    return (scores.query("SELECT role, project, done_at, started_at, cost_usd, tokens, rework, owner_rounds FROM agent_scores").all() as TaskRow[]).map((r) => ({
      role: r.role, project: r.project, closedAt: r.done_at, wallMs: r.started_at != null && r.done_at >= r.started_at ? r.done_at - r.started_at : null, costUsd: r.cost_usd, tokens: r.tokens || null,
      rework: !!r.rework, ownerRounds: r.owner_rounds, ownerComplaint: false }));
  }
  const learned = new Set<string>();
  try { for (const l of main.query("SELECT agent_id, job_id FROM owner_learned WHERE type IN ('complaint','rework')").all() as { agent_id: string; job_id: number }[]) learned.add(`${l.agent_id}:${l.job_id}`); } catch { /* table not made yet */ }
  return (scores.query("SELECT role, project, goal, closed_at, opened_at, wall_ms, cost_usd, tokens, rework, owner_rounds, agent_id, job_id FROM job_scores").all() as JobRow[]).map((r) => ({
    role: r.role, project: r.project, goal: r.goal, closedAt: r.closed_at, wallMs: r.wall_ms ?? (r.closed_at >= r.opened_at ? r.closed_at - r.opened_at : null), costUsd: r.cost_usd, tokens: r.tokens || null,
    rework: !!r.rework, ownerRounds: r.owner_rounds, ownerComplaint: learned.has(`${r.agent_id}:${r.job_id}`) }));
}

export const metricsReport = (unit: Unit = "job", weeks = 8, now = Date.now()): Trend => trend(loadRecords(unit), { now, weeks, unit, extra: ownerRules() });

export function metricsRoute(api: Hono<Env>) {
  api.get("/agentnet/metrics", (c) => {
    const unit: Unit = c.req.query("unit") === "task" ? "task" : "job", w = Number(c.req.query("weeks"));
    return c.json(metricsReport(unit, Number.isInteger(w) && w >= 1 && w <= 26 ? w : 8));
  });
}
