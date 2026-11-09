// Claude Code hooks (~/.claude/settings.json "hooks"): list them with a plain description, switch one on or off, and
// show how the ones that keep a log have been doing. Claude Code has no per-hook "disabled" flag, so a hook that is
// switched off is taken out of settings.json and parked in the data folder (hooks-disabled.json); switching it on puts it back.
// Every write: back up settings.json first, change only the "hooks" key, validate the result, write atomically, and
// restore the backup if anything looks wrong. "Roll back" puts the newest backup back.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { homedir } from "node:os";
import { dir } from "../core/config";
import { problem, type Env } from "../core/http";
import { rootOnly } from "../core/access";

export interface RawHook { type?: string; command?: string; timeout?: number; [k: string]: unknown }
interface Group { matcher?: string; hooks: RawHook[]; [k: string]: unknown }
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };
interface Parked { id: string; event: string; matcher: string | null; groupIndex: number; hookIndex: number; hook: RawHook; at: number }

export interface HookRun { at: number; ms: number | null; ok: boolean; text: string }
export interface HookInfo {
  id: string; event: string; matcher: string | null; command: string; script: string; timeout: number | null; enabled: boolean;
  name: string; about: string; log: string | null; runs: number; failures: number; avgMs: number | null; p95Ms: number | null; lastAt: number | null; recent: HookRun[];
}

const SETTINGS = () => process.env.CLAUDE_SETTINGS_FILE ?? join(homedir(), ".claude", "settings.json");
const PARKED = () => join(process.env.AGENTNET_HOOKS_DATA ?? process.env.HOOKS_DATA_DIR ?? dir("data"), "hooks-disabled.json");
const LOGS = () => process.env.AGENTNET_HOOK_LOGS ?? process.env.HOOK_LOG_DIR ?? dir("logs");
const KEEP_BACKUPS = 12;

/** One catalogue entry: plain words for a hook, found by a regex over its command; `log` + `script` say which JSONL log it keeps. */
export interface CatalogEntry { match: RegExp; name: string; about: string; log?: string; script?: string }
const CATALOG_FILE = () => process.env.AGENTNET_HOOK_CATALOG ?? join(dir("config"), "hook-catalog.json");
let catCache: { file: string; mtime: number; list: CatalogEntry[] } | null = null;
/** The catalogue from `$AGENTNET_HOME/config/hook-catalog.json`: a JSON array of { match, name, about, log?, script? } where `match` is a
 *  regex source. A missing or broken file gives an empty catalogue, and every hook then gets a generic line built from its event. */
export function catalog(): CatalogEntry[] {
  const file = CATALOG_FILE();
  let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch { catCache = null; return []; }
  if (catCache && catCache.file === file && catCache.mtime === mtime) return catCache.list;
  let list: CatalogEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (Array.isArray(raw)) for (const e of raw as Record<string, unknown>[]) {
      if (typeof e?.match !== "string" || typeof e.name !== "string" || typeof e.about !== "string") continue;
      try { list.push({ match: new RegExp(e.match), name: e.name, about: e.about, log: typeof e.log === "string" ? e.log : undefined, script: typeof e.script === "string" ? e.script : undefined }); } catch { /* bad regex: skip the entry */ }
    }
  } catch { list = []; }
  catCache = { file, mtime, list };
  return list;
}
const EVENT_ABOUT: Record<string, string> = {
  SessionStart: "Runs when a session starts or resumes.", SessionEnd: "Runs when a session ends.", Stop: "Runs when Claude finishes a turn.",
  StopFailure: "Runs when a turn ends in an error.", SubagentStop: "Runs when a sub-agent finishes.", UserPromptSubmit: "Runs on every prompt you send, before Claude sees it.",
  PreToolUse: "Runs before a tool call and may block it.", PostToolUse: "Runs after a tool call.", Notification: "Runs when Claude raises a notification.", PermissionRequest: "Runs when Claude asks for permission.",
};

export const hookId = (event: string, matcher: string | null, command: string) => createHash("sha1").update(`${event}\0${matcher ?? ""}\0${command}`).digest("hex").slice(0, 10);
const scriptOf = (cmd: string) => { const w = cmd.trim().split(/\s+/).filter((x) => !/^(node|python3?|bash|sh)$/.test(x) && !x.endsWith("/python") && !x.endsWith("/bin/python")); return w[w.length - 1] ?? cmd; };

function readSettings(): { raw: string; json: Settings } {
  const raw = readFileSync(SETTINGS(), "utf8");
  return { raw, json: JSON.parse(raw) as Settings };
}
function readParked(): Parked[] { try { return JSON.parse(readFileSync(PARKED(), "utf8")) as Parked[]; } catch { return []; } }
function writeParked(p: Parked[]) { mkdirSync(dirname(PARKED()), { recursive: true }); const t = PARKED() + ".tmp"; writeFileSync(t, JSON.stringify(p, null, 2)); renameSync(t, PARKED()); }

// ---------- logs ----------
interface LogLine { ts?: string; ms?: number; latency_ms?: number; err?: unknown; error?: unknown; dry?: boolean; test?: boolean; skip?: boolean; reason?: string; p?: string; ack?: string; route?: string; kind?: string; agent?: string }
function readLog(file: string): LogLine[] {
  try { return readFileSync(join(LOGS(), file), "utf8").split("\n").filter(Boolean).slice(-400).map((l) => { try { return JSON.parse(l) as LogLine; } catch { return {}; } }); } catch { return []; }
}
/** Logs hold "backend-1" (triage, auto-ack, usage-guard, pretrust) or "agentnet/backend-1" (task-guard); null when no agent. */
const agentOf = (a?: unknown) => (typeof a === "string" && a ? a.replace(/^agentnet\//, "") : null);
const when = (ts?: string) => { const t = ts ? Date.parse(ts) : NaN; return Number.isFinite(t) ? t : 0; };
export function logStats(file: string) {
  const lines = readLog(file).filter((l) => l.ts);
  const ms = lines.map((l) => l.ms ?? l.latency_ms).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  const runs: HookRun[] = lines.slice(-6).reverse().map((l) => ({ at: when(l.ts), ms: l.ms ?? l.latency_ms ?? null, ok: !(l.err || l.error), text: String(l.ack ?? (l.route ? `${l.kind ?? ""} → ${l.route}` : l.p) ?? "").slice(0, 90) }));
  return {
    runs: lines.length, failures: lines.filter((l) => l.err || l.error).length,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, p95Ms: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] : null,
    lastAt: lines.length ? when(lines[lines.length - 1].ts) : null, recent: runs,
  };
}

// ---------- live: a hook that keeps a log "fires" whenever a line is appended to it (fs.watch, no timer) ----------
export interface HookFire { script: string; name: string; /** agentnet agent that fired it; null = a non-agentnet session (the main bot, you) */ agent: string | null; at: number; ms: number | null; ok: boolean; skipped?: boolean; reason?: string }
const logHooks = () => catalog().filter((k) => k.log && k.script).map((k) => ({ file: k.log!, script: k.script!, name: k.name }));
const subs = new Set<(f: HookFire) => void>();
const offsets = new Map<string, number>();
let logWatch: FSWatcher | null = null;
function toFire(h: { script: string; name: string }, j: LogLine): HookFire {
  return { script: h.script, name: h.name, agent: agentOf(j.agent), at: when(j.ts) || Date.now(), ms: j.ms ?? j.latency_ms ?? null, ok: !(j.err || j.error),
    ...(j.skip ? { skipped: true, reason: String(j.reason ?? "").slice(0, 120) } : {}) };
}
/** Recent fires from every hook log, newest first. `agent` filters to one agentnet agent. Reads only the log tails, no watcher. */
export function recentFires(agent?: string, limit = 50): HookFire[] {
  const out: HookFire[] = [];
  for (const h of logHooks()) for (const j of readLog(h.file)) {
    if (!j.ts || j.dry || j.test) continue;
    if (agent && agentOf(j.agent) !== agent) continue;
    out.push(toFire(h, j));
  }
  return out.sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(200, limit)));
}
function readNew(h: { file: string; script: string; name: string }) {
  const path = join(LOGS(), h.file);
  let size = 0; try { size = statSync(path).size; } catch { return; }
  let off = offsets.get(path) ?? size;
  if (size < off) off = 0; // rotated
  if (size === off) { offsets.set(path, off); return; }
  const buf = Buffer.alloc(size - off), fd = openSync(path, "r");
  try { readSync(fd, buf, 0, buf.length, off); } finally { closeSync(fd); }
  const text = buf.toString("utf8"), end = text.lastIndexOf("\n") + 1; // only whole lines; the rest waits for its newline
  offsets.set(path, off + Buffer.byteLength(text.slice(0, end)));
  for (const l of text.slice(0, end).split("\n").filter(Boolean)) {
    let j: LogLine; try { j = JSON.parse(l) as LogLine; } catch { continue; }
    if (j.dry || j.test) continue; // dry-run / test lines (AUTO_ACK_DRY=1 …) are not real firings
    for (const s of subs) s(toFire(h, j)); // skipped = the hook ran and chose to do nothing: muted, no pulse
  }
}
function startLogWatch() {
  if (logWatch) return;
  for (const h of logHooks()) { try { offsets.set(join(LOGS(), h.file), statSync(join(LOGS(), h.file)).size); } catch { offsets.set(join(LOGS(), h.file), 0); } }
  try { logWatch = watch(LOGS(), { persistent: false }, (_e, name) => { for (const h of logHooks()) if (!name || name === h.file) readNew(h); }); logWatch.on("error", () => { logWatch = null; }); } catch { logWatch = null; }
}
/** Subscribe to hook firings; returns the unsubscribe function. The watcher runs only while someone listens. */
export function onHookFire(cb: (f: HookFire) => void): () => void {
  subs.add(cb); startLogWatch();
  return () => { subs.delete(cb); if (!subs.size) { logWatch?.close(); logWatch = null; offsets.clear(); } };
}

// ---------- list ----------
export function listHooks(): HookInfo[] {
  const { json } = readSettings();
  const out: HookInfo[] = [];
  const mk = (event: string, matcher: string | null, h: RawHook, enabled: boolean): HookInfo => {
    const command = String(h.command ?? ""), k = catalog().find((x) => x.match.test(command));
    const st = k?.log ? logStats(k.log) : null;
    return {
      id: hookId(event, matcher, command), event, matcher, command, script: basename(scriptOf(command)), timeout: typeof h.timeout === "number" ? h.timeout : null, enabled,
      name: k?.name ?? basename(scriptOf(command)), about: k?.about ?? EVENT_ABOUT[event] ?? "A custom hook.", log: k?.log ?? null,
      runs: st?.runs ?? 0, failures: st?.failures ?? 0, avgMs: st?.avgMs ?? null, p95Ms: st?.p95Ms ?? null, lastAt: st?.lastAt ?? null, recent: st?.recent ?? [],
    };
  };
  for (const [event, groups] of Object.entries(json.hooks ?? {})) for (const g of groups) for (const h of g.hooks ?? []) out.push(mk(event, g.matcher ?? null, h, true));
  for (const p of readParked()) out.push(mk(p.event, p.matcher, p.hook, false));
  return out;
}

// ---------- safe write ----------
export function backups(): string[] {
  const f = SETTINGS(), d = dirname(f), pre = basename(f) + ".bak-agentnet-";
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(pre)).sort() .map((n) => join(d, n)) : [];
}
function backup(): string {
  const f = SETTINGS(), b = `${f}.bak-agentnet-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17)}`;
  copyFileSync(f, b);
  for (const old of backups().slice(0, -KEEP_BACKUPS)) try { unlinkSync(old); } catch { /* ignore */ }
  return b;
}
/** Write `next` as the new settings, but only if it differs from `prev` in the "hooks" key alone. */
function commit(prev: Settings, next: Settings): void {
  const { hooks: _a, ...restPrev } = prev, { hooks: _b, ...restNext } = next;
  if (JSON.stringify(restPrev) !== JSON.stringify(restNext)) throw new Error("refusing to change anything but hooks");
  const text = JSON.stringify(next, null, 2), f = SETTINGS(), b = backup();
  try {
    const check = JSON.parse(text) as Settings;
    if (JSON.stringify({ ...check, hooks: 0 }) !== JSON.stringify({ ...prev, hooks: 0 })) throw new Error("validation failed");
    const t = f + ".tmp-agentnet";
    writeFileSync(t, text, { mode: statSync(f).mode & 0o777 });
    renameSync(t, f);
    JSON.parse(readFileSync(f, "utf8"));
  } catch (e) { copyFileSync(b, f); throw e; }
}

/** Switch one hook off (taken out of settings.json, parked) or on (put back where it was). Returns the new list. */
export function setHookEnabled(id: string, enabled: boolean): HookInfo[] {
  const { json } = readSettings(), prev = structuredClone(json), parked = readParked();
  json.hooks ??= {};
  if (!enabled) {
    for (const [event, groups] of Object.entries(json.hooks)) {
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi], hi = (g.hooks ?? []).findIndex((h) => hookId(event, g.matcher ?? null, String(h.command ?? "")) === id);
        if (hi < 0) continue;
        const [hook] = g.hooks.splice(hi, 1);
        parked.push({ id, event, matcher: g.matcher ?? null, groupIndex: gi, hookIndex: hi, hook, at: Date.now() });
        if (!g.hooks.length) groups.splice(gi, 1);
        if (!groups.length) delete json.hooks[event];
        commit(prev, json); writeParked(parked);
        return listHooks();
      }
    }
    throw new Error("hook not found");
  }
  const pi = parked.findIndex((p) => p.id === id);
  if (pi < 0) throw new Error("hook not found");
  const p = parked[pi];
  const groups = (json.hooks[p.event] ??= []);
  const near = groups[p.groupIndex];
  if (near && (near.matcher ?? null) === p.matcher) near.hooks.splice(Math.min(p.hookIndex, near.hooks.length), 0, p.hook);
  else { const g: Group = { hooks: [p.hook] }; if (p.matcher) g.matcher = p.matcher; groups.splice(Math.min(p.groupIndex, groups.length), 0, g); }
  parked.splice(pi, 1);
  commit(prev, json); writeParked(parked);
  return listHooks();
}

/** Put the newest backup back (and park nothing: the parked list is cleared because the backup is the truth). */
export function rollback(): { restored: string } {
  const list = backups(), last = list[list.length - 1];
  if (!last) throw new Error("no backup yet");
  const { json: prev } = readSettings(), restored = JSON.parse(readFileSync(last, "utf8")) as Settings;
  commit(prev, { ...prev, hooks: restored.hooks }); // keeps every other key as it is now
  // hooks that came back are no longer parked; hooks that are missing from the restored file stay parked
  const live = new Set(Object.entries(restored.hooks ?? {}).flatMap(([e, gs]) => gs.flatMap((g) => (g.hooks ?? []).map((h) => hookId(e, g.matcher ?? null, String(h.command ?? ""))))));
  writeParked(readParked().filter((p) => !live.has(p.id)));
  return { restored: basename(last) };
}

/** One node per distinct hook script: the events it runs on, whether any of its entries is on, whether it keeps a log. */
export function hookNodes() {
  const by = new Map<string, { script: string; name: string; events: string[]; enabled: boolean; live: boolean }>();
  for (const h of listHooks()) {
    const n = by.get(h.script) ?? by.set(h.script, { script: h.script, name: h.name, events: [], enabled: false, live: false }).get(h.script)!;
    if (!n.events.includes(h.event)) n.events.push(h.event);
    n.enabled ||= h.enabled; n.live ||= !!h.log;
  }
  return [...by.values()];
}

export function hooksRoutes(api: Hono<Env>) {
  api.get("/agent-hooks/nodes", (c) => { try { return c.json({ nodes: hookNodes() }); } catch { return c.json({ nodes: [] }); } });
  // Live: one "fire" event per line appended to a hook's log.
  // ?agent=<name> only sends that agent's fires.
  api.get("/agent-hooks/stream", (c) => streamSSE(c, async (stream) => {
    const q: HookFire[] = [], only = c.req.query("agent") || null; let wake: (() => void) | null = null;
    const off = onHookFire((f) => { if (only && f.agent !== only) return; q.push(f); wake?.(); });
    stream.onAbort(() => { off(); wake?.(); });
    await stream.writeSSE({ event: "ready", data: "{}" });
    let beat = Date.now();
    while (!stream.aborted) {
      if (!q.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (q.length) await stream.writeSSE({ event: "fire", data: JSON.stringify(q.shift()) });
      if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
    }
    off();
  }));
  // Past fires for the panel: GET /agent-hooks/fires?agent=backend-1&limit=50 -> { agent, fires: HookFire[] } (newest first).
  api.get("/agent-hooks/fires", rootOnly, (c) => c.json({ agent: c.req.query("agent") || null, fires: recentFires(c.req.query("agent") || undefined, Number(c.req.query("limit")) || 50) }));
  api.get("/agent-hooks", (c) => { try { return c.json({ hooks: listHooks(), backups: backups().map((b) => basename(b)) }); } catch (e) { return c.json({ hooks: [], backups: [], error: String((e as Error).message) }); } });
  api.post("/agent-hooks/:id/enabled", rootOnly, async (c) => {
    const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return problem(c, 400, "Bad Request", "enabled must be true or false");
    try { return c.json({ hooks: setHookEnabled(c.req.param("id"), body.enabled), backups: backups().map((b) => basename(b)) }); } catch (e) { return problem(c, 400, "Bad Request", String((e as Error).message)); }
  });
  api.post("/agent-hooks/rollback", rootOnly, (c) => { try { const r = rollback(); return c.json({ ...r, hooks: listHooks(), backups: backups().map((b) => basename(b)) }); } catch (e) { return problem(c, 400, "Bad Request", String((e as Error).message)); } });
}
