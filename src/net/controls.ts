// Agent controls on the panel: what an agent has scheduled (session crons, monitors, external cron jobs linked to it),
// Run now, Stop (interrupt the turn) and Close (despawn). Every control tells the agent's boss with an admin message.
// Panel auth (root-only writes, see mount.ts isPanelWrite); not the agent token.
import { readFileSync, statSync } from "node:fs";
import type { Hono } from "hono";
import { audit, logEvent } from "../core/logger";
import { problem, type Env } from "../core/http";
import { nextRun } from "./cron";
import { emit, flush, get, type Snapshot } from "./store";
import { byName, enqueueMessage, PANEL, resolveTo, retireAgent, subjectOf, NAME_RE, type AgentRow } from "./routes";
import { hasSession, interrupt, realTmux, sessionOf, type Tmux } from "./windows";

export interface Schedule {
  id: string; kind: "session-cron" | "monitor" | "cron-job"; label: string; cron?: string; nextRunAt?: number; startedAt?: number;
  source: string; /** a Run now exists for this row (monitors have none) */ canRun: boolean;
  /** cron jobs started with Run now: running since startedAt; the last finished run (time, ok, duration) */
  running?: boolean; lastRun?: { at: number; ok: boolean; ms: number };
}
/** Run now processes of cron jobs, by job name: in flight and the last finished one (in memory; a restart forgets them). */
const inFlight = new Map<string, number>(), lastRuns = new Map<string, { at: number; ok: boolean; ms: number }>();
export const SESSION_CRON_TTL_MS = 7 * 86_400_000; // CronCreate jobs auto-expire after 7 days

// ---------- external cron jobs: ~/scripts/crontabs/jobs.json (card "agent") + all.cron (schedule and command) ----------
// Both are opt-in (set them in $AGENTNET_HOME/config/env): without them only session schedules and monitors show.
const jobsFile = () => process.env.AGENTNET_JOBS_JSON ?? "";
const cronFile = () => process.env.AGENTNET_ALL_CRON ?? "";
const cache = new Map<string, { m: number; v: unknown }>();
function cached<T>(file: string, parse: (text: string) => T, empty: T): T {
  if (!file) return empty;
  try {
    const m = statSync(file).mtimeMs, hit = cache.get(file);
    if (hit && hit.m === m) return hit.v as T;
    const v = parse(readFileSync(file, "utf8")); cache.set(file, { m, v }); return v;
  } catch { return empty; }
}
/** Job name → agent name, for the cards that carry "agent". */
const cardAgents = (): Record<string, string> => cached(jobsFile(), (t) => {
  const j = JSON.parse(t) as Record<string, { agent?: unknown }>, out: Record<string, string> = {};
  for (const [k, v] of Object.entries(j)) if (v && typeof v.agent === "string") out[k] = v.agent;
  return out;
}, {});
export interface CronLine { job: string; cron: string; command: string }
/** The active (non-comment) lines of all.cron that run through cron_wrap.sh: job name, 5-field schedule, command. */
export function cronLines(): CronLine[] {
  return cached(cronFile(), (t) => {
    const out: CronLine[] = [];
    for (const raw of t.split("\n")) {
      const l = raw.trim(); if (!l || l.startsWith("#")) continue;
      const m = /^((?:\S+\s+){4}\S+)\s+(.+)$/.exec(l); if (!m) continue;
      const w = /cron_wrap\.sh\s+(?:--\S+\s+)*(?:"([^"]+)"|(\S+))/.exec(m[2]!); if (!w) continue;
      out.push({ job: (w[1] ?? w[2])!, cron: m[1]!, command: m[2]! });
    }
    return out;
  }, [] as CronLine[]);
}
export const cronLineOf = (job: string) => cronLines().find((l) => l.job === job);

// ---------- the schedules of one agent ----------
export function schedulesOf(s: Snapshot, now = Date.now()): Schedule[] {
  const out: Schedule[] = [];
  for (const x of s.schedules ?? []) {
    const at = x.recurring ? nextRun(x.cron, now) : nextRun(x.cron, x.createdAt);
    if (at === null || at <= now && !x.recurring) continue;           // a one-shot that already fired
    if (x.recurring && now - x.createdAt > SESSION_CRON_TTL_MS) continue; // auto-expired
    out.push({ id: x.id, kind: "session-cron", label: x.prompt.slice(0, 80) || x.id, cron: x.cron, nextRunAt: at, startedAt: x.createdAt, source: "CronCreate", canRun: true });
  }
  for (const b of s.bg ?? []) if (b.kind === "monitor" && b.state === "running") out.push({ id: b.id, kind: "monitor", label: b.label, startedAt: b.startedAt, source: "Monitor", canRun: false });
  const mine = cardAgents();
  for (const [job, agent] of Object.entries(mine)) {
    if (agent !== s.name) continue;
    const line = cronLineOf(job);
    const since = inFlight.get(job), last = lastRuns.get(job);
    out.push({ id: `cron:${job}`, kind: "cron-job", label: job, cron: line?.cron, nextRunAt: line ? nextRun(line.cron, now) ?? undefined : undefined, source: "jobs.json", canRun: !!line,
      ...(since ? { running: true, startedAt: since } : {}), ...(last ? { lastRun: last } : {}) });
  }
  return out;
}

// ---------- admin actions: the boss always hears about them ----------
export const stamp = (now: number) => new Date(now).toLocaleString("sv-SE"); // 2026-11-09 14:03:22, local time
/** Tell the boss (and root, when the boss is someone else), put the action in the agent's event log. Returns who was told. */
export function adminAction(target: AgentRow, action: "stop" | "close" | "run-now", detail: string, now = Date.now()): string[] {
  const verb = action === "stop" ? "stopped" : action === "close" ? "closed" : `triggered job ${detail} on`;
  const who = process.env.AGENTNET_OWNER_NAME?.trim() || "The owner";
  const text = `${who} ${verb} ${target.name} from the agentnet panel at ${stamp(now)}.`;
  emit({ agent: target.id, type: "AdminAction", data: { action, by: who, detail: detail || null }, source: "service", ts: now });
  const told: string[] = [];
  for (const n of new Set([target.boss ?? "root", "root"])) {
    if (n === target.name) continue;
    const to = resolveTo(n); if (!to) continue;
    if (enqueueMessage(PANEL, to, text, "info", null, subjectOf(`admin: ${action} ${target.name}`, text), now).state !== "gone") told.push(to.name);
  }
  flush();
  return told;
}

// ---------- run now ----------
export interface RunDeps { spawn: (command: string, onExit?: (code: number) => void) => void; tmux: Tmux; kill?: Parameters<typeof retireAgent>[3] }
const realRun: RunDeps = { tmux: realTmux, spawn: (command, onExit) => { const p = Bun.spawn(["/bin/bash", "-c", command], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }); p.unref(); if (onExit) void p.exited.then(onExit, () => onExit(-1)); } };
/** all.cron escapes a literal % as \% (cron itself treats a bare % as a newline); the shell wants the plain character. */
const unescapePct = (c: string) => c.replace(/\\%/g, "%");

export function agentControlRoutes(api: Hono<Env>, deps: RunDeps = realRun) {
  const find = (name: string) => (NAME_RE.test(name) ? byName(name) : null);
  api.get("/agentnet/agents/:name/schedules", (c) => {
    const t = find(String(c.req.param("name"))), s = t && get(t.id);
    if (!t || !s) return problem(c, 404, "Not Found", "no live agent by that name");
    return c.json({ agent: t.name, now: Date.now(), schedules: schedulesOf(s) });
  });
  api.post("/agentnet/agents/:name/run-schedule", async (c) => {
    const t = find(String(c.req.param("name"))), s = t && get(t.id);
    if (!t || !s) return problem(c, 404, "Not Found", "no live agent by that name");
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>, id = typeof b.id === "string" ? b.id : "";
    const sched = schedulesOf(s).find((x) => x.id === id);
    if (!sched) return problem(c, 404, "Not Found", "no such scheduled job on this agent");
    if (sched.kind === "monitor") return problem(c, 422, "Can't do that", "a monitor has no run now");
    let told: string[];
    if (sched.kind === "session-cron") {
      const prompt = s.schedules?.find((x) => x.id === id)?.prompt ?? "";
      const out = enqueueMessage(PANEL, t, `run scheduled job ${id} now: ${prompt}`, "task", null, subjectOf(`run scheduled job ${id} now`, ""));
      flush();
      if (out.state === "gone") return problem(c, 410, "Gone", `${t.name} is gone; nothing stored`);
      told = adminAction(t, "run-now", id);
    } else {
      const line = cronLineOf(id.slice(5));
      if (!line) return problem(c, 404, "Not Found", "that job is not in all.cron");
      if (inFlight.has(line.job)) return problem(c, 409, "Already running", `${line.job} is already running`);
      const t0 = Date.now(); inFlight.set(line.job, t0);
      const done = (code: number) => { inFlight.delete(line.job); lastRuns.set(line.job, { at: Date.now(), ok: code === 0, ms: Date.now() - t0 }); };
      try { deps.spawn(unescapePct(line.command), done); } catch (e) { inFlight.delete(line.job); return problem(c, 500, "Run failed", (e as Error).message); }
      logEvent("info", "agentnet: run now", { agent: t.name, job: line.job });
      told = adminAction(t, "run-now", line.job);
    }
    audit(c.get("actor"), "agentnet.run-now", `${t.name}:${id}`, "ok", c.get("trace"));
    return c.json({ agent: t.name, id, kind: sched.kind, started: true, told });
  });
  api.post("/agentnet/agents/:name/stop", (c) => {
    const name = String(c.req.param("name")), t = find(name);
    if (name === "root") return problem(c, 403, "Forbidden", "root cannot be stopped from the panel");
    if (!t) return problem(c, 404, "Not Found", "no live agent by that name");
    const session = sessionOf(t.name);
    if (!hasSession(session, deps.tmux)) return problem(c, 404, "Not Found", `no tmux session ${session}`);
    const wasWorking = get(t.id)?.state === "working";
    if (!interrupt(session, deps.tmux)) return problem(c, 500, "Stop failed", "tmux refused the keys");
    const told = adminAction(t, "stop", "");
    audit(c.get("actor"), "agentnet.stop", t.id, "ok", c.get("trace"));
    return c.json({ agent: t.name, stopped: true, wasWorking, told });
  });
  api.post("/agentnet/agents/:name/despawn", (c) => {
    const name = String(c.req.param("name")), t = find(name);
    if (name === "root") return problem(c, 403, "Forbidden", "root cannot be despawned");
    if (!t) return problem(c, 404, "Not Found", "no live agent by that name");
    const told = adminAction(t, "close", ""); // before the retire: the boss hears about it even when the agent is gone a moment later
    const closed = retireAgent(t, "despawn", Date.now(), deps.kill);
    audit(c.get("actor"), "agentnet.despawn", t.id, "ok", c.get("trace"), { via: "panel", ...(closed.length ? { teams_archived: closed.join(",") } : {}) });
    return c.json({ agent: t.id, state: "gone", told, ...(closed.length ? { teams_archived: closed } : {}) });
  });
}
