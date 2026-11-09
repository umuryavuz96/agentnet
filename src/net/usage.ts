// Who used it: per-agent token usage over the 5-hour and weekly windows, from data that already exists.
//  tokens  = sum of TurnEnded.usage in the agent event log (the mod posts it for every finished turn of the main thread)
//  context = the agent's live ContextMeasured fold; costNow = its CostMeasured fold (cumulative for the current session)
//  weekly window = claude-usage.json week.resetsAt - 7 days; the account-wide pct comes from the same file.
// Nothing is estimated. A missing source shows up in `sources` with the reason, and its field stays null.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { db } from "../core/db";
import { dir } from "../core/config";
import type { Env } from "../core/http";
import { all, ensureSchema } from "./store";
import { agentnetScoreRoutes } from "./scores";

const FIVE_H = 5 * 3600_000, WEEK = 7 * 86400_000;
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export interface AgentUsage { agent: string; live: boolean; model: string | null; context: { tokens: number; window: number; pct: number } | null; costNow: number | null; fiveHour: Tokens; weekly: Tokens; weeklyShare: number | null; byModel: Record<string, Tokens> }
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
const add = (t: Tokens, u: Record<string, unknown>) => { const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : 0); t.input += n("input_tokens"); t.output += n("output_tokens"); t.cacheRead += n("cache_read_input_tokens"); t.cacheWrite += n("cache_creation_input_tokens"); t.turns++; };
const billable = (t: Tokens) => t.input + t.output + t.cacheWrite; // cache reads are re-reads of the same context: they would swamp the share

/** claude-usage.json: account-wide week pct and reset time; `fiveHour` is null when the plan has no session limit. */
function accountWindows(): { week: { pct: number; resetsAt: number } | null; fiveHour: { pct: number; resetsAt: number } | null; reason: string | null } {
  const f = process.env.AGENTNET_USAGE_FILE ?? join(process.env.USAGE_DATA_DIR ?? dir("data"), "claude-usage.json");
  if (!existsSync(f)) return { week: null, fiveHour: null, reason: "claude-usage.json missing" };
  try {
    const last = (JSON.parse(readFileSync(f, "utf8")) as { last?: { session?: { pct?: number; resetsAt?: number } | null; week?: { pct?: number; resetsAt?: number } | null } }).last;
    const pick = (w?: { pct?: number; resetsAt?: number } | null) => (w && typeof w.pct === "number" && typeof w.resetsAt === "number" ? { pct: w.pct, resetsAt: w.resetsAt } : null);
    return { week: pick(last?.week), fiveHour: pick(last?.session), reason: null };
  } catch { return { week: null, fiveHour: null, reason: "claude-usage.json unreadable" }; }
}

export function usageByAgent(now = Date.now()) {
  ensureSchema();
  const acct = accountWindows();
  const weekStart = acct.week ? acct.week.resetsAt * 1000 - WEEK : now - WEEK, fiveStart = now - FIVE_H;
  const by = new Map<string, AgentUsage>();
  const get = (name: string) => by.get(name) ?? by.set(name, { agent: name, live: false, model: null, context: null, costNow: null, fiveHour: zero(), weekly: zero(), weeklyShare: null, byModel: {} }).get(name)!;
  for (const s of all()) { const u = get(s.name); u.live ||= s.life !== "gone" && s.life !== "failed"; u.model = s.model ?? u.model; if (s.life === "live" || !u.context) { u.context = s.context; u.costNow = s.cost; } }
  const rows = db().query("SELECT agent_id, ts, data FROM agent_events WHERE type = 'TurnEnded' AND ts >= ?").all(Math.min(weekStart, fiveStart)) as { agent_id: string; ts: number; data: string }[];
  for (const r of rows) {
    let usage: Record<string, unknown> | null = null; try { usage = (JSON.parse(r.data) as { usage?: Record<string, unknown> | null }).usage ?? null; } catch { /* skip */ }
    if (!usage) continue;
    const u = get(r.agent_id.split("#")[0]), model = typeof usage.model === "string" ? usage.model : "unknown";
    if (r.ts >= weekStart) { add(u.weekly, usage); add(u.byModel[model] ??= zero(), usage); }
    if (r.ts >= fiveStart) add(u.fiveHour, usage);
  }
  const agents = [...by.values()], total = agents.reduce((a, u) => a + billable(u.weekly), 0);
  for (const u of agents) u.weeklyShare = total ? Math.round((billable(u.weekly) / total) * 1000) / 10 : null;
  agents.sort((a, b) => billable(b.weekly) - billable(a.weekly));
  return {
    at: now,
    windows: {
      fiveHour: { since: fiveStart, kind: "rolling", accountPct: acct.fiveHour?.pct ?? null, resetsAt: acct.fiveHour ? acct.fiveHour.resetsAt * 1000 : null },
      weekly: { since: weekStart, kind: acct.week ? "plan" : "rolling", accountPct: acct.week?.pct ?? null, resetsAt: acct.week ? acct.week.resetsAt * 1000 : null },
    },
    sources: {
      tokens: "agent_events TurnEnded.usage (main thread of each agentnet agent; sub-agent and non-agentnet sessions are not counted)",
      context: "agent fold ContextMeasured", costNow: "agent fold CostMeasured (cumulative for the current session, not per window)",
      accountPct: acct.reason ?? (acct.fiveHour ? "claude-usage.json" : "claude-usage.json (week only: no 5-hour session limit on this plan, so fiveHour.accountPct is null and the 5-hour columns are a rolling 5 h sum)"),
      share: "weeklyShare = percent of the tracked agents' input+output+cacheWrite tokens this week, not of the account limit",
    },
    agents,
  };
}

export function agentnetUsageRoutes(api: Hono<Env>) {
  api.get("/agentnet/usage", (c) => c.json(usageByAgent())); // panel auth, like /agentnet/snapshot
  agentnetScoreRoutes(api); // scorecard reads, same panel auth
}
