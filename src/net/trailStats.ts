// Is the trail RAG used? Reads var/logs/trail-inject.jsonl (auto-injects and trail_search calls) and decides per row with hits whether a hit was
// later USED: within 30 min the same agent touched one of the hit's files (Read/Edit/Write target) or named its commit / note in a tool call.
// A cheap heuristic on purpose: the agent event log already has every tool target, nothing new is recorded about the model's reasoning.
import { existsSync, readFileSync } from "node:fs";
import type { Hono } from "hono";
import { db } from "../core/db";
import type { Env } from "../core/http";
import { ensureSchema } from "./store";
import { injectLog } from "./trails";

export interface Row { ts: string; agent: string; source: string; query: string; hits: string[]; files?: string[]; ms?: number | null; skipped?: string | null }
export interface Touch { ts: number; target: string }
export const USED_WINDOW_MS = 30 * 60_000;
const SEARCH = "trail_search";

/** Did the agent use a hit? `touches` = the agent's tool targets (file paths, commands) in event order. null = cannot tell (no hits, or an old row with neither files nor a commit id). */
export function usedOf(row: Row, touches: Touch[]): boolean | null {
  if (!row.hits.length) return null;
  const t0 = Date.parse(row.ts); if (!Number.isFinite(t0)) return null;
  const needles: string[] = [];
  for (const f of row.files ?? []) { const base = f.split("/").pop(); if (f.length >= 4) needles.push(f); if (base && base.length >= 4) needles.push(base); }
  for (const h of row.hits) { const [kind, id] = [h.split(":")[0], h.slice(h.indexOf(":") + 1)]; if (kind === "commit" && id.length >= 7) needles.push(id.slice(0, 7)); if (kind === "note") needles.push(id); }
  if (!needles.length) return null;
  // Event targets are cut at 80 chars, so a long path may end mid-name: also match the last three path segments as a prefix of the hit file's.
  const tails = (row.files ?? []).map((f) => f.split("/").slice(-3).join("/")).filter((f) => f.length >= 10);
  const tail3 = (t: string) => t.split("/").slice(-3).join("/");
  const hit = touches.some((x) => x.ts > t0 && x.ts - t0 <= USED_WINDOW_MS && (needles.some((n) => x.target.includes(n)) || (x.target.includes("/") && tail3(x.target).length >= 10 && tails.some((f) => f.startsWith(tail3(x.target))))));
  return hit || row.files !== undefined ? hit : null; // an old row logged no files: only a commit/note mention can prove use, silence proves nothing
}

export function readRows(path = injectLog(), since = 0): Row[] {
  if (!existsSync(path)) return [];
  const out: Row[] = [];
  for (const l of readFileSync(path, "utf8").split("\n")) { if (!l.trim()) continue; try { const r = JSON.parse(l) as Row; if (r.ts && Date.parse(r.ts) >= since) out.push({ ...r, hits: r.hits ?? [] }); } catch { /* skip a torn line */ } }
  return out;
}

/** The agent's tool targets since `from` (ToolFinished carries the target and is persisted; ToolStarted is in-memory only). */
/** agent_id is "name#n": a range on the (agent_id, seq) index. The old `LIKE 'name#%'` is case-insensitive in SQLite, so it scanned all of agent_events for every hit (about 0.6 s each, 51 s for 14 days). '$' is the character after '#'. */
export function touchesOf(agent: string, from: number, to: number): Touch[] {
  ensureSchema();
  return (db().query("SELECT ts, data FROM agent_events WHERE agent_id >= ? AND agent_id < ? AND type IN ('ToolFinished', 'ToolStarted') AND ts > ? AND ts <= ? ORDER BY ts").all(agent + "#", agent + "$", from, to) as { ts: number; data: string }[])
    .map((r) => { try { return { ts: r.ts, target: String((JSON.parse(r.data) as { target?: unknown }).target ?? "") }; } catch { return { ts: r.ts, target: "" }; } })
    .filter((x) => x.target);
}

const norm = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
export interface Stats {
  days: { day: string; searches: number; injects: number }[];
  totals: { searches: number; injects: number; injected: number; injectRate: number | null; searchHitRate: number | null; used: number; checkable: number; usedRate: number | null };
  topQueries: { query: string; n: number }[];
  agents: { agent: string; searches: number; injects: number; injected: number; used: number; checkable: number }[];
  latest: { ts: string; agent: string; source: string; query: string; hits: string[]; used: boolean | null; ms: number | null }[];
}
/** Pure: rows + a touches lookup in, the whole panel out. A generator: it yields every 20 rows so a caller can give the event loop back; computeStats drives it straight through. */
export function* statsSteps(rows: Row[], touches: (agent: string, from: number, to: number) => Touch[], now = Date.now(), dayCount = 14): Generator<void, Stats> {
  const days = new Map<string, { searches: number; injects: number }>();
  for (let i = dayCount - 1; i >= 0; i--) days.set(new Date(now - i * 86400_000).toISOString().slice(0, 10), { searches: 0, injects: 0 });
  const agents = new Map<string, Stats["agents"][number]>(), q = new Map<string, number>(), cache = new Map<string, Touch[]>();
  let searches = 0, injects = 0, injected = 0, searchHits = 0, used = 0, checkable = 0;
  const latest: Stats["latest"] = [];
  let n = 0;
  for (const r of rows) {
    if (++n % 20 === 0) yield;
    const isSearch = r.source === SEARCH, ag = agents.get(r.agent) ?? agents.set(r.agent, { agent: r.agent, searches: 0, injects: 0, injected: 0, used: 0, checkable: 0 }).get(r.agent)!;
    const d = days.get(r.ts.slice(0, 10));
    if (isSearch) { searches++; ag.searches++; if (d) d.searches++; if (r.hits.length) searchHits++; const k = norm(r.query); if (k) q.set(k, (q.get(k) ?? 0) + 1); }
    else { injects++; ag.injects++; if (d) d.injects++; if (r.hits.length) { injected++; ag.injected++; } }
    let u: boolean | null = null;
    if (r.hits.length) {
      const t0 = Date.parse(r.ts), key = `${r.agent}:${Math.floor(t0 / 60_000)}`;
      const ts = cache.get(key) ?? cache.set(key, touches(r.agent, t0, t0 + USED_WINDOW_MS)).get(key)!;
      u = usedOf(r, ts);
      if (u !== null) { checkable++; ag.checkable++; if (u) { used++; ag.used++; } }
    }
    latest.push({ ts: r.ts, agent: r.agent, source: r.source, query: r.query.replace(/\s+/g, " ").slice(0, 140), hits: r.hits, used: u, ms: r.ms ?? null });
  }
  return {
    days: [...days].map(([day, v]) => ({ day, ...v })),
    totals: { searches, injects, injected, injectRate: injects ? injected / injects : null, searchHitRate: searches ? searchHits / searches : null, used, checkable, usedRate: checkable ? used / checkable : null },
    topQueries: [...q].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([query, n]) => ({ query, n })),
    agents: [...agents.values()].sort((a, b) => b.searches + b.injects - (a.searches + a.injects)),
    latest: latest.filter((x) => x.hits.length).slice(-20).reverse(),
  };
}

export function computeStats(rows: Row[], touches: (agent: string, from: number, to: number) => Touch[], now = Date.now(), dayCount = 14): Stats {
  const it = statsSteps(rows, touches, now, dayCount);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/** Stale-while-revalidate: serve the last result at once with its time; when it is older than `ttl`, start ONE background recompute that yields to the event loop, so requests stay fast while it runs. Nothing is computed while nobody asks. */
export interface Cached { stats: Stats; at: number }
export interface CacheOpts { onReady?: (days: number) => void; ttl?: number; now?: () => number; compute?: (days: number, now: number) => Promise<Stats> }
export function statsCache(opts: CacheOpts = {}) {
  const ttl = opts.ttl ?? 5 * 60_000, clock = opts.now ?? Date.now;
  const slot = new Map<number, Cached>(), running = new Map<number, Promise<void>>();
  const compute = opts.compute ?? (async (days: number, now: number) => {
    const it = statsSteps(readRows(injectLog(), now - days * 86400_000), touchesOf, now, days);
    for (;;) { const r = it.next(); if (r.done) return r.value; await new Promise<void>((res) => setTimeout(res, 0)); }
  });
  function start(days: number) {
    if (running.has(days)) return;
    const t = clock();
    running.set(days, compute(days, t).then((stats) => { slot.set(days, { stats, at: clock() }); opts.onReady?.(days); }).catch(() => { /* keep the old result */ }).finally(() => { running.delete(days); }));
  }
  /** The last result, or null while the first one is computing. A result older than ttl still returns at once and starts a recompute. */
  function get(days: number): (Cached & { refreshing: boolean }) | null {
    const c = slot.get(days);
    if (!c || clock() - c.at > ttl) start(days);
    return c ? { ...c, refreshing: running.has(days) } : null;
  }
  /** Start a recompute now (one at a time per days value). */
  const refresh = (days: number) => start(days);
  return { get, refresh, idle: () => Promise.all(running.values()).then(() => undefined), runs: () => running.size };
}
/** Called when a background compute finishes, so the panel stream can tell open pages (no client polling). */
const readySubs = new Set<() => void>();
export const onStatsReady = (fn: () => void) => { readySubs.add(fn); return () => { readySubs.delete(fn); }; };
const cache = statsCache({ onReady: () => { for (const f of readySubs) f(); } });

/** Who is looking at Trails: while at least one stream client watches, recompute every `every` ms (5 min); nobody watching, no compute. */
export function statsWatch(c: { get(days: number): unknown; refresh(days: number): void }, opts: { days?: number; every?: number; set?: (fn: () => void, ms: number) => unknown; clear?: (t: unknown) => void } = {}) {
  const days = opts.days ?? 14, every = opts.every ?? 5 * 60_000;
  const set = opts.set ?? ((fn, ms) => setInterval(fn, ms)), clear = opts.clear ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  const ids = new Set<string>(); let timer: unknown = null;
  return {
    add(id: string) { ids.add(id); if (timer === null) { c.get(days); timer = set(() => c.refresh(days), every); } }, // get(): first look, or an old result, starts one compute
    remove(id: string) { ids.delete(id); if (!ids.size && timer !== null) { clear(timer); timer = null; } },
    size: () => ids.size,
  };
}
export const trailsWatch = statsWatch(cache);

/** Panel auth: GET /trails/stats?days=14 */
export function trailStatsRoute(api: Hono<Env>) {
  api.get("/trails/stats", (c) => {
    const days = Math.min(60, Math.max(1, Number(c.req.query("days")) || 14));
    const r = cache.get(days);
    return c.json(r ? { ...r.stats, at: r.at, refreshing: r.refreshing } : { computing: true });
  });
}
