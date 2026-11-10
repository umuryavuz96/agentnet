// agentnet page state: one EventSource on /api/v1/agentnet/stream, nothing else. `hello` replaces the
// whole map (first frame and every reconnect), `agent` is an RFC 7386 merge patch of one row, `gone` drops the row at
// once, `msg` appends to the thread list, `ping` keeps the "stale" badge away. A real gap (data.prev is not the seq of
// the last frame applied) closes and reopens the stream, which answers with a fresh `hello`. No polling anywhere.
import { reactive, computed, watch } from "vue";
import { api, url } from "./ui/api";

export type Life = "starting" | "live" | "stopping" | "gone" | "failed";
export type Activity = "working" | "idle" | "waiting" | "blocked";
export interface Task { id: number; text: string; status: "pending" | "in_progress" | "done" }
/** One live agent: the service's `Snapshot` fold (server/agentnet/store.ts) plus the precomputed `doing` (stream.ts). */
export interface AgentRow {
  id: string; name: string; job: string | null; boss: string | null; model: string | null; effort: string | null;
  life: Life; lifeSince: number; state: Activity; stateSince: number;
  action: { tool: string; target: string | null; at: number } | null;
  reported: { doing: string | null; progress: number | null; phase: string | null; blockedOn: string | null; at: number } | null;
  tasks: Task[];
  context: { tokens: number; window: number; pct: number } | null; cost: number | null;
  lastMsg: { dir: "in" | "out"; peer: string; kind: string; snippet: string; at: number } | null;
  doing: string | null; seq: number; progressPct?: number | null;
  /** What "done" looks like for this agent (the outcome, not the job); absent on agents spawned before the rule. */
  goal?: string | null;
  soul?: string | null; audit?: string | null; project?: string | null; spawnedAt?: number; session?: string | null; pid?: number | null; version?: string | null; goneReason?: string | null;
  turn?: { id: string; startedAt: number; snippet: string | null; tools: number } | null; turns?: number;
  lastTool?: { tool: string; target: string | null; ok: boolean; ms: number | null; at: number } | null;
  weekly?: { pct: number; resetsAt: string | null } | null;
  /** The auto-compact window this agent was spawned with, in tokens; absent for root and older agents (they keep the model window). */
  compactWindow?: number | null;
  /** Background work under the agent (subagents, shells, monitors); finished rows leave 2 min after they end. */
  bg?: BgRow[];
  [k: string]: unknown;
}
export type BgKind = "subagent" | "shell" | "monitor";
export type BgState = "running" | "done" | "failed" | "killed";
export interface BgRow { id: string; kind: BgKind; label: string; /** the raw command, when `label` is a summary sentence made from it */ cmd?: string; state: BgState; startedAt: number; endedAt: number | null }
export { BG_KEEP_MS, bgVisible, bgShown } from "./bg";
export { ctxView } from "./ctx";
/** A message as the snapshot lists it; `subject` and `reply_to` arrive with M9 and are optional until then. */
export interface Msg { id: number | null; from: string; to: string; kind: string; body: string; at: number; subject?: string | null; reply_to?: number | null }

// ---------- owner checks: a real-world question the asker wrote, with the answer buttons it chose. Pending ones stay until the owner taps; an answered one stays 10 s, coloured by the tone of the answer. ----------
export type Tone = "good" | "bad" | "neutral";
export interface CheckOption { label: string; tone: Tone }
export interface Check { id: number; agent: string; team: string | null; project: string | null; question: string; detail: string | null; createdBy: string; createdAt: number; state: "pending" | "answered"; options: CheckOption[]; answer: string | null; answerTone: Tone | null; note: string | null; resolvedAt: number | null }
export const ANSWER_SHOW_MS = 10_000;
/** The sheet: `list` shows every waiting check, `id` one check (0 = none). */
export const checkUi = reactive({ id: 0, list: false });
const leave = new Map<number, ReturnType<typeof setTimeout>>();
function putCheck(k: Check) {
  net.checks[k.id] = k;
  clearTimeout(leave.get(k.id)); leave.delete(k.id);
  if (k.state === "answered") {
    const left = Math.max(0, Math.min(ANSWER_SHOW_MS, ANSWER_SHOW_MS - (Date.now() - (k.resolvedAt ?? Date.now()))));
    leave.set(k.id, setTimeout(() => { delete net.checks[k.id]; leave.delete(k.id); }, left));
  }
}
/** Pending checks, oldest first. */
export const pendingChecks = computed(() => Object.values(net.checks).filter((c) => c.state === "pending").sort((a, b) => a.id - b.id));
/** The owner taps one of the buttons the asker wrote. The note is optional. Returns an error text, or "" on success. */
export async function answerCheck(id: number, option: string, note: string): Promise<string> {
  try {
    const r = await fetch(url(`v1/panel/checks/${id}/resolve`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option, ...(note.trim() ? { note: note.trim() } : {}) }) });
    const j = await r.json().catch(() => null) as { check?: Check; detail?: string } | null;
    if (!r.ok) return j?.detail ?? `HTTP ${r.status}`;
    if (j?.check) putCheck(j.check);
    return "";
  } catch (e) { return (e as Error).message; }
}

const STALE_MS = 2 * 15_000 + 2_000; // two missed pings (ping every 15 s) plus a little slack
const MAX_MSGS = 300;

export const net = reactive({
  agents: {} as Record<string, AgentRow>,
  messages: [] as Msg[],
  checks: {} as Record<number, Check>,
  seq: 0,
  connected: false,
  lastFrameAt: 0,
  now: Date.now(),
});

/** Merge patch (RFC 7386) into a reactive row: `null` deletes, objects and arrays are replaced whole (the service sends them whole). */
function merge(row: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete row[k]; else row[k] = v; }
}

type Frame = { event: string; data: Record<string, unknown> };
let es: EventSource | null = null;
let queue: Frame[] = [];
let raf = 0;
let users = 0;
let tick: ReturnType<typeof setInterval> | undefined;

function apply(f: Frame) {
  const d = f.data;
  net.lastFrameAt = Date.now();
  if (f.event === "hello") {
    net.agents = (d.agents ?? {}) as Record<string, AgentRow>;
    net.messages = ((d.messages ?? []) as Msg[]).slice(-MAX_MSGS);
    net.seq = Number(d.seq) || 0;
    net.checks = {}; for (const k of (d.checks ?? []) as Check[]) putCheck(k);
    return;
  }
  if (f.event === "ping") return;
  // A real gap: this frame does not follow the last one applied. The stream restarts and its `hello` resyncs us.
  if (typeof d.prev === "number" && d.prev !== net.seq) { reopen(); return; }
  if (typeof d.seq === "number") net.seq = d.seq;
  if (f.event === "agent") {
    const id = String(d.id), patch = (d.patch ?? {}) as Record<string, unknown>, row = net.agents[id];
    if (row) merge(row, patch); else net.agents[id] = patch as AgentRow;
  } else if (f.event === "gone") {
    delete net.agents[String(d.id)];
  } else if (f.event === "check") {
    putCheck(d as unknown as Check);
  } else if (f.event === "msg") {
    net.messages.push({ id: typeof d.id === "number" ? d.id : null, from: String(d.from), to: String(d.to), kind: String(d.kind ?? "info"), body: String(d.body ?? d.snippet ?? ""), at: Number(d.at) || Date.now(),
      subject: (d.subject as string | undefined) ?? null, reply_to: (d.reply_to as number | undefined) ?? null });
    if (net.messages.length > MAX_MSGS) net.messages.splice(0, net.messages.length - MAX_MSGS);
  }
}

function flush() { raf = 0; const q = queue; queue = []; for (const f of q) { apply(f); if (!es) break; } }
/** Frames of one animation frame land together (a burst of hook events is one render). A hidden tab gets no rAF: apply now. */
function enqueue(f: Frame) {
  if (f.event === "hello") queue = []; // a hello supersedes anything still waiting
  queue.push(f);
  if (document.hidden) { if (raf) { cancelAnimationFrame(raf); } flush(); return; }
  if (!raf) raf = requestAnimationFrame(flush);
}

function open() {
  es = new EventSource(url("v1/panel/stream"));
  for (const ev of ["hello", "agent", "gone", "msg", "check", "ping"]) {
    es.addEventListener(ev, (e) => { try { enqueue({ event: ev, data: JSON.parse((e as MessageEvent).data) }); } catch { /* malformed frame: ignored */ } });
  }
  es.addEventListener("open", () => { net.connected = true; });
  es.addEventListener("error", () => { // EventSource reconnects by itself (the server re-sends `hello`); a stream closed for good (401, long outage) is reopened
    net.connected = false;
    if (es?.readyState === EventSource.CLOSED && users > 0) setTimeout(() => { if (users > 0 && es?.readyState === EventSource.CLOSED) reopen(); }, 3_000);
  });
}
function close() { es?.close(); es = null; queue = []; if (raf) cancelAnimationFrame(raf); raf = 0; net.connected = false; }
function reopen() { close(); open(); }

// A hidden tab holds no streams: Chrome allows 6 HTTP/1.1 connections per host, and every background tab with an open
// EventSource eats one. On hide both streams close; on show they reopen and the stream's own `hello` resyncs the map.
function onVisibility() {
  if (document.hidden) { if (users > 0) close(); if (hUsers > 0) closeHooks(); }
  else { if (users > 0 && !es) open(); if (hUsers > 0 && !hes) openHooks(); }
}
document.addEventListener("visibilitychange", onVisibility);

/** Ref-counted: the first view to mount opens the stream, the last one to unmount closes it. */
export function useAgentnet() {
  if (users++ === 0) { if (!document.hidden) open(); tick = setInterval(() => (net.now = Date.now()), 2_000); }
  return () => { if (--users === 0) { close(); clearInterval(tick); } };
}

/** "stale since" once two pings in a row were missed; null while frames keep arriving. */
export const staleSince = computed(() => (net.lastFrameAt && net.now - net.lastFrameAt > STALE_MS ? net.lastFrameAt : null));

/** Layout key: the card grid regroups only when the set of id:boss:job changes, never on a status patch. */
export const layoutKey = computed(() => Object.values(net.agents).map((a) => `${a.id}:${a.boss ?? ""}:${a.job ?? ""}`).sort().join("|"));

/** The page is shown only when the service is mounted (AGENTNET=1): the snapshot answers 200. */
export async function agentnetAvailable(): Promise<boolean> {
  try { return (await fetch(url("v1/panel/snapshot"))).ok; } catch { return false; }
}

// ---------- Terminal windows (M8). Until backend-1 ships them the routes are missing: the buttons go disabled. ----------
// ---------- teams (v1): records live on the service, the page polls them (they change rarely) ----------
export interface Team { id: string; name: string; goal: string | null; lead: string | null; project: string | null; created: number; state: "active" | "archived"; members: string[]; tasks?: number; open?: number }
export interface TeamTask { id: number; team: string; text: string; owner: string | null; status: "pending" | "in_progress" | "done"; created: number; updated: number }
export interface TeamMsg { id: number; from: string; kind: string; subject: string; body: string; at: number }
export const teams = reactive({ list: [] as Team[] });
export async function loadTeams() { try { const r = await api<{ teams: Team[] }>("v1/panel/teams"); teams.list = r.teams; } catch { /* keeps the last list; the route is absent on an older server */ } }
/** Poll while the Agents page is open; returns the stop function. */
/** New agents wait here until the team list has been re-read (at most ~1 s). Teams are polled every 5 s, so without this a
 *  freshly spawned team member was drawn under its boss first and jumped into its team a few seconds later (user report 2026-11-09). */
export const placing = reactive(new Set<string>());
export function useTeams() {
  void loadTeams();
  const t = setInterval(() => { if (!document.hidden) void loadTeams(); }, 5000);
  let seen: Set<string> | null = null;
  const stopW = watch(() => Object.values(net.agents).map((a) => a.name), (names) => {
    if (!seen) { seen = new Set(names); return; } // first snapshot: the initial loadTeams covers it
    const fresh = names.filter((n) => !seen!.has(n)); for (const n of names) seen.add(n);
    if (!fresh.length) return;
    for (const n of fresh) placing.add(n);
    const done = () => { for (const n of fresh) placing.delete(n); };
    const cap = setTimeout(done, 1500); // never hide an agent for long, even if the teams call hangs
    void loadTeams().finally(() => { clearTimeout(cap); done(); });
  }, { immediate: true });
  return () => { clearInterval(t); stopW(); };
}
/** Changes only when a team's identity, lead or member set changes (the map relayouts on it). */
export const teamsKey = computed(() => teams.list.filter((t) => t.state === "active").map((t) => `${t.id}:${t.name}:${t.lead ?? ""}:${[...t.members].sort().join(",")}`).join("|") + `|p:${[...placing].join(",")}`);
/** A job tapped on the map: the owner's panel opens its Jobs fold on it (AgentnetJobs reads this; stale after 5 s). */
export const jobFocus = reactive({ id: "", n: 0, at: 0 });
export const windows = reactive({ available: true as boolean, busy: "" as string });
/** POST an open/close call. A 404 with no problem body = the route is not there yet (pre-M8); a problem body = a real answer. */
export async function windowCall(path: string): Promise<{ ok: boolean; detail?: string; code?: string }> {
  windows.busy = path;
  try {
    const r = await fetch(url(`v1/panel${path}`), { method: "POST" });
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => null) as { detail?: string; title?: string; code?: string } | null;
    if (r.status === 404 && !body?.detail) { windows.available = false; return { ok: false, detail: "Terminal windows arrive with M8" }; }
    return { ok: false, detail: body?.detail ?? body?.title ?? `HTTP ${r.status}`, code: body?.code };
  } catch (e) { return { ok: false, detail: (e as Error).message }; }
  finally { windows.busy = ""; }
}

/** "mcp__claude-in-chrome__computer · click" -> "Chrome: computer · click"; "Bash · ls" stays. Plain text passes through untouched. */
export function humanDoing(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  // A turn started by a channel message carries the raw prompt: '<channel source="plugin:chat:chat" ...>text</channel>' -> "Chat: text".
  const ch = /^\s*<channel\b[^>]*?source="(?:plugin:)?([A-Za-z0-9_-]+)[^"]*"[^>]*>\s*([\s\S]*?)(?:<\/channel>|$)/.exec(s);
  if (!ch && /^\s*<channel\b[^>]*$/.test(s)) { const src = /source="(?:plugin:)?([A-Za-z0-9_-]+)/.exec(s)?.[1] ?? "Channel"; return `${src.charAt(0).toUpperCase()}${src.slice(1)} message`; } // tag clipped by an older mod
  if (ch) { const src = ch[1]; return `${src.charAt(0).toUpperCase()}${src.slice(1)}: ${ch[2].replace(/\s+/g, " ").trim()}`; }
  // A turn started by an agentnet delivery: 'The agentnet plugin sent a message:\n#85 [report] backend-1: "…"' -> 'Report from backend-1: "…"'.
  const an = /^The agentnet plugin sent a message:\s*#\d+\s*\[(\w+)\]\s*([^:]+):\s*([\s\S]*)/.exec(s);
  if (an) return `${an[1].charAt(0).toUpperCase()}${an[1].slice(1)} from ${an[2].trim()}: ${an[3].replace(/\s+/g, " ").trim()}`;
  return s.replace(/^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)/, (_m, server: string, tool: string) => {
    const nice = server.replace(/^claude[-_]?(ai|in)?[-_]/i, "").replace(/[-_]+/g, " ").trim() || server;
    return `${nice.charAt(0).toUpperCase()}${nice.slice(1)}: ${tool.replace(/_/g, " ")}`;
  });
}

// ---------- hooks (server-wide, not per agent: the hook logs carry no agent name) ----------
export interface HookNode { script: string; name: string; events: string[]; enabled: boolean; live: boolean }
export interface HookFire { script: string; name: string; agent?: string | null; at: number; ms: number | null; ok: boolean; skipped?: boolean; reason?: string }
export const hooks = reactive({ nodes: [] as HookNode[], fires: [] as HookFire[], lastFire: {} as Record<string, number> });
let hes: EventSource | null = null;
let hUsers = 0;
/** Ref-counted like useAgentnet: hook list from /agent-hooks/nodes, live fires from /agent-hooks/stream (last 30 kept). */
function openHooks() {
  fetch(url("v1/panel/hooks/nodes")).then((r) => r.json()).then((j: { nodes?: HookNode[] }) => { hooks.nodes = j.nodes ?? []; }).catch(() => { /* no hook lane */ });
  hes = new EventSource(url("v1/panel/hooks/stream"));
  hes.addEventListener("fire", (e) => {
    try { const f = JSON.parse((e as MessageEvent).data) as HookFire; hooks.fires.unshift(f); if (hooks.fires.length > 30) hooks.fires.length = 30; if (!f.skipped) hooks.lastFire[f.script] = Date.now(); } catch { /* malformed */ }
  });
}
function closeHooks() { hes?.close(); hes = null; }
export function useAgentHooks() {
  if (hUsers++ === 0 && !document.hidden) openHooks();
  return () => { if (--hUsers === 0) closeHooks(); };
}

// ---------- usage per agent (GET /agentnet/usage): who spent the tokens in the 5-hour and weekly windows ----------
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export interface UsageAgent { agent: string; live: boolean; model: string | null; context: { tokens: number; window: number; pct: number } | null; costNow: number | null; fiveHour: Tokens; weekly: Tokens; weeklyShare: number | null; byModel: Record<string, Tokens> }
export interface UsageWindow { since: number; kind: string; accountPct: number | null; resetsAt: string | null }
export interface UsageData { at: number; windows: { fiveHour: UsageWindow; weekly: UsageWindow }; agents: UsageAgent[] }
export const usage = reactive({ data: null as UsageData | null, err: "" });
/** Work the agent did itself: input plus output tokens. Cache reads are re-reads of the same context and would drown everything else. */
export const worked = (t: Tokens) => t.input + t.output;
let uTimer: ReturnType<typeof setInterval> | undefined;
let uUsers = 0;
async function loadUsage() {
  if (document.hidden) return;
  try { const r = await fetch(url("v1/panel/usage")); if (!r.ok) throw new Error(`HTTP ${r.status}`); usage.data = await r.json() as UsageData; usage.err = ""; }
  catch (e) { usage.err = (e as Error).message; }
}
/** Ref-counted poll every 30 s while a view shows usage (it is a computed total, not a stream: no extra connection). */
export function useUsage() {
  if (uUsers++ === 0) { void loadUsage(); uTimer = setInterval(loadUsage, 30_000); }
  return () => { if (--uUsers === 0) clearInterval(uTimer); };
}

// ---------- scorecard (GET /agentnet/scores, /agentnet/agents/:name/score): docs/agent-score.md ----------
export interface SubScores { quality: number | null; firstTimeRight: number | null; efficiency: number | null; reliability: number | null; rework: number | null }
export interface ScoreBase { tasks: number; graded: number; score: number | null; band: string | null; sub: SubScores; costPerTask: number | null; avgGrade: number | null; avgRounds: number | null }
/** Task discipline (docs/task-discipline.md): 0-100 plus the share of finished tasks that kept each habit. */
export interface Discipline { tasks: number; open: number; score: number | null; checks: Record<"listedFirst" | "started" | "onTime" | "notBatch" | "oneAtATime", number | null> }
export interface DisciplineDay { day: string; score: number | null; tasks: number; open: number; checks: Discipline["checks"]; agents: Record<string, { score: number | null; tasks: number }> }
export interface AgentScoreRow extends ScoreBase { discipline: Discipline; agent: string; role: string; model: string | null; soul: string | null; project: string | null }
export interface GroupScoreRow extends ScoreBase { key: string }
export interface ScoresData { discipline: { days: DisciplineDay[]; today: DisciplineDay | null; all: number | null }; at: number; minGraded: number; weights: Record<keyof SubScores, number>; agents: AgentScoreRow[]; byRole: GroupScoreRow[]; byModel: GroupScoreRow[]; bySoul: GroupScoreRow[] }
export interface ScoreGrade { id: number; task_id: number; text: string; grade: number | null; grade_raw: number | null; penalty: number; note: string | null; rework: boolean; owner_rounds: number | null; done_at: number; graded_at: number | null; cost_usd: number | null }
export interface AgentScore extends ScoreBase { discipline: Discipline; agent: string; role: string; minGraded: number; weights: Record<keyof SubScores, number>; last: ScoreGrade[]; lastAvgRounds: number | null }
export const scores = reactive({ data: null as ScoresData | null, err: "" });
let sTimer: ReturnType<typeof setInterval> | undefined;
let sUsers = 0;
async function loadScores() {
  if (document.hidden) return;
  try { const r = await fetch(url("v1/panel/scores")); if (!r.ok) throw new Error(`HTTP ${r.status}`); scores.data = await r.json() as ScoresData; scores.err = ""; }
  catch (e) { scores.err = (e as Error).message; }
}
/** Ref-counted poll every 60 s while the Scores section is open. */
export function useScores() {
  if (sUsers++ === 0) { void loadScores(); sTimer = setInterval(loadScores, 60_000); }
  return () => { if (--sUsers === 0) clearInterval(sTimer); };
}
/** One agent's score block for the side panel; null when the agent has no finished task yet. */
export async function fetchAgentScore(name: string): Promise<AgentScore | null> {
  try { const r = await fetch(url(`v1/panel/agents/${encodeURIComponent(name)}/score`)); return r.ok ? await r.json() as AgentScore : null; } catch { return null; }
}
