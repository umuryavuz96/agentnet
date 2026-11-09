// Auto-compact window for spawned agents (CLAUDE_CODE_AUTO_COMPACT_WINDOW). One default plus an optional override per role,
// kept in config/spawn.json as strings like "300k". The spawn path reads it with compactFor(name); changes apply to new spawns only.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { dir } from "../core/config";
import { problem, type Env } from "../core/http";
import { rootOnly } from "../core/access";

export const COMPACT_DEFAULT = "300k", COMPACT_MIN = 100, COMPACT_MAX = 1000;
export const SPAWN_FILE = () => process.env.AGENTNET_SPAWN_FILE ?? join(dir("config"), "spawn.json");
export interface CompactCfg { default: string; roles: Record<string, string> }

/** "300k", "300000", "1m", 300000 -> "300k"; null when not a number or outside 100k..1000k. */
export function normWindow(v: unknown): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(String(v ?? "")); if (!m) return null;
  const n = Number(m[1]), u = m[2]!.toLowerCase(), k = Math.round(u === "m" ? n * 1000 : u === "k" ? n : n / 1000);
  return k >= COMPACT_MIN && k <= COMPACT_MAX ? `${k}k` : null;
}
export const windowTokens = (v: string): number => Number.parseInt(v, 10) * 1000;
/** Role of an agent name: the name without its trailing -N (backend-1 -> backend). */
export const roleOf = (name: string) => name.replace(/-\d+$/, "");

export function readCompact(): CompactCfg {
  let j: { compact_window?: unknown; roles?: Record<string, unknown> } = {};
  try { j = JSON.parse(readFileSync(SPAWN_FILE(), "utf8")); } catch { /* none yet */ }
  const roles: Record<string, string> = {};
  for (const [r, v] of Object.entries(j.roles ?? {})) { const w = normWindow(v); if (w) roles[r] = w; }
  return { default: normWindow(j.compact_window) ?? COMPACT_DEFAULT, roles };
}
/** The window for a new agent: its role's override, else the default. */
export const compactFor = (name: string, cfg = readCompact()): string => cfg.roles[roleOf(name)] ?? cfg.default;

export function saveCompact(input: { default?: unknown; roles?: unknown }): CompactCfg {
  const cur = readCompact(), d = input.default === undefined ? cur.default : normWindow(input.default);
  if (!d) throw new Error(`default must be ${COMPACT_MIN}k to ${COMPACT_MAX}k`);
  const roles: Record<string, string> = {};
  if (input.roles !== undefined) {
    if (!input.roles || typeof input.roles !== "object") throw new Error("roles must be an object");
    for (const [r, v] of Object.entries(input.roles as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(r)) throw new Error(`bad role name: ${r}`);
      const w = normWindow(v); if (!w) throw new Error(`${r} must be ${COMPACT_MIN}k to ${COMPACT_MAX}k`);
      roles[r] = w;
    }
  } else Object.assign(roles, cur.roles);
  const f = SPAWN_FILE(); let rest: Record<string, unknown> = {};
  try { rest = JSON.parse(readFileSync(f, "utf8")); } catch { /* new file */ }
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify({ ...rest, compact_window: d, roles }, null, 2) + "\n"); renameSync(f + ".tmp", f);
  return { default: d, roles };
}

const payload = () => ({ ...readCompact(), min: `${COMPACT_MIN}k`, max: `${COMPACT_MAX}k`, fallback: COMPACT_DEFAULT });
export function compactRoutes(api: Hono<Env>) {
  api.get("/agent-compact", (c) => c.json(payload()));
  api.put("/agent-compact", rootOnly, async (c) => {
    const b = await c.req.json().catch(() => null) as { default?: unknown; roles?: unknown } | null;
    if (!b || typeof b !== "object") return problem(c, 400, "Bad Request", "default and roles needed");
    try { saveCompact(b); return c.json(payload()); } catch (e) { return problem(c, 400, "Bad Request", (e as Error).message); }
  });
}
