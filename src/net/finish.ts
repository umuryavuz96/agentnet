// Step 7b: the server finishes an agent on its accepted done report (docs/internal/one-folder/SPEC-step7b-despawn.md).
// In the same request: a provisional auto grade with notes and the cost record, the handover file, cleanup of the agent's processes and
// bg jobs (a keep-list is honoured, worktrees are only listed), unfinished-work warnings, one message per dependent, despawn through
// retireAgent, the onDespawn handlers and one AgentFinished event. Root reviews afterwards: the review bucket (auto grades not yet
// confirmed) pings root's session every review_ping_min minutes while it is not empty, and never when it is empty.
// Every process listing and signal goes through `Procs`, so tests never touch real processes.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir, ROOT } from "../core/config";
import { agentRecordsDir, legacyRecordsDir } from "../core/layout";
import { db } from "../core/db";
import { logEvent } from "../core/logger";
import { ownedRunning, stopJob } from "./bgjobs";
import { jobsOf, openAsks, openSteps, type Ask, type Job } from "./jobs";
import { ADMIN, byName, enqueueMessage, goodPid, inTree, resolveTo, retireAgent, type AgentRow } from "./routes";
import { clearAutoGrade, reviewBucket, setAutoGrade, windowCost } from "./scores";
/** Step 8a: root's grade or confirm replaced an auto grade (fired from scores.ts); lines.ts re-runs keep/revert on it. */
export { onRegrade, type Regrade } from "./scores";
import { all, emit, flush, get } from "./store";
import { clearPendingKill, markPendingKill } from "./sweep";
import { trailsDir } from "./trails";
import { realTmux, sessionOf, underTest } from "./windows";

// ---------- the grade ----------
export interface Signals { steps: number; verified: number; refusals: number; failedChecks: number; /** Failed checks left out: an `expected:` line of the same step names them. */ expected?: number }
/** 1-5 from hard signals only: the share of closed steps with verified proof, refused step_done/report calls, failed checks in the evidence. */
export function autoGrade(s: Signals): number {
  const share = s.steps > 0 ? s.verified / s.steps : 0.5;
  let g = share >= 0.9 ? 5 : share >= 0.7 ? 4 : share >= 0.5 ? 3 : share >= 0.25 ? 2 : 1;
  g -= s.refusals >= 5 ? 2 : s.refusals >= 2 ? 1 : 0;
  g -= Math.min(2, s.failedChecks);
  return Math.max(1, Math.min(5, g));
}
export const signalNote = (s: Signals) => `auto: ${s.verified}/${s.steps} steps verified, ${s.refusals} refusal${s.refusals === 1 ? "" : "s"}, ${s.failedChecks} failed check${s.failedChecks === 1 ? "" : "s"}${s.expected ? `, ${s.expected} expected` : ""}`;
const failed = (v: string) => /\bFAIL(ED|URE)?\b/.test(v) || /\b[1-9]\d* fail/i.test(v); // same test as evidence.ts
/** A failed check line is named by an `expected:` line of its step: one contains the other (case-insensitive). A short `expected:`
 *  ("fail") names nothing, so it cannot blank every failed check. */
const namedBy = (check: string, exp: string[]) => { const c = check.toLowerCase().trim(); return exp.some((x) => (x.length >= 6 && c.includes(x)) || (c.length >= 6 && x.includes(c))); };
/** The signals of a closed job: its done steps, their proof, and the Refused events (not the work gate) since the job opened. */
export function signalsOf(agentId: string, job: Job): Signals {
  const done = job.steps.filter((x) => x.status === "done");
  const refusals = (db().query("SELECT data FROM agent_events WHERE agent_id = ? AND type = 'Refused' AND ts >= ?").all(agentId, job.openedAt) as { data: string }[])
    .filter((r) => { try { const rule = (JSON.parse(r.data) as { rule?: string }).rule; return rule !== "gate" && rule !== "upgrade-first"; } catch { return true; } }).length;
  let failedChecks = 0, expected = 0;
  for (const x of done) {
    const exp = x.evidence.filter((e) => e.kind === "expected").map((e) => e.value.toLowerCase().trim());
    for (const e of x.evidence) if (e.kind === "check" && failed(e.value)) { if (namedBy(e.value, exp)) expected++; else failedChecks++; }
  }
  // Refused events are the agent's real mistakes on our server: `expected:` never excludes them (root msg 7332).
  return { steps: done.length, verified: done.filter((x) => x.evidence.some((e) => e.ok === true)).length, refusals, failedChecks, ...(expected ? { expected } : {}) };
}

// ---------- processes ----------
export interface ProcRow { pid: number; ppid: number; command: string; /** AGENTNET_AGENT from its env; undefined when the env could not be read. */ agent?: string | null; keep?: boolean }
export interface Procs {
  /** Same-user processes. */
  table(): ProcRow[];
  panePids(session: string): number[];
  portPids(port: number): number[];
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  alive(pid: number): boolean;
  later(fn: () => void, ms: number): void;
  killSession(session: string): void;
}
const text = (cmd: string[]) => { try { const p = Bun.spawnSync(cmd, { stderr: "ignore" }); return p.exitCode === 0 ? new TextDecoder().decode(p.stdout) : ""; } catch { return ""; } };
const tagOf = (env: string) => ({ agent: /(?:^|\s|\0)AGENTNET_AGENT=([a-z0-9][a-z0-9-]*)(?=\s|\0|$)/.exec(env)?.[1] ?? null, keep: /(?:^|\s|\0)AGENTNET_KEEP=1(?=\s|\0|$)/.test(env) });
/** The real machine. Under `bun test` it sees nothing and signals nothing: a fixture named like a live agent must never reach it. */
export function realProcs(): Procs {
  const inert = () => underTest();
  return {
    table() {
      if (inert()) return [];
      const uid = process.getuid?.() ?? -1, rows: ProcRow[] = [];
      for (const l of text(["/bin/ps", "-A", "-ww", "-o", "pid=,ppid=,uid=,command="]).split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(l); if (!m || Number(m[3]) !== uid) continue;
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[4]!, agent: undefined });
      }
      if (process.platform === "darwin") { // ps -E appends the environment after the arguments: read only what comes after the command
        const withEnv = new Map<number, string>();
        for (const l of text(["/bin/ps", "-A", "-E", "-ww", "-o", "pid=,command="]).split("\n")) { const m = /^\s*(\d+)\s(.*)$/.exec(l); if (m) withEnv.set(Number(m[1]), m[2]!); }
        if (withEnv.size) for (const r of rows) { const e = withEnv.get(r.pid); if (e != null) Object.assign(r, tagOf(e.startsWith(r.command) ? e.slice(r.command.length) : "")); }
      } else for (const r of rows) { try { Object.assign(r, tagOf(readFileSync(`/proc/${r.pid}/environ`, "utf8"))); } catch { /* gone or not ours */ } }
      return rows;
    },
    panePids: (session) => inert() ? [] : realTmux.run(["list-panes", "-t", `=${session}:`, "-F", "#{pane_pid}"]).out.split("\n").map((x) => Number(x.trim())).filter((n) => n > 1),
    portPids: (port) => inert() ? [] : text(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n").map(Number).filter((n) => n > 1),
    signal: (pid, sig) => { if (!inert() && goodPid(pid)) try { process.kill(pid, sig); } catch { /* gone */ } },
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } },
    later: (fn, ms) => { setTimeout(() => { try { fn(); } catch { /* gone */ } }, ms).unref?.(); },
    killSession: (session) => { if (!inert()) realTmux.run(["kill-session", "-t", `=${session}`]); },
  };
}
export const realGit = (args: string[], cwd: string): string | null => { try { const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "ignore" }); return p.exitCode === 0 ? new TextDecoder().decode(p.stdout) : null; } catch { return null; } };

export interface Keep { pid?: number; port?: number; reason: string }
export const keepsOf = (a: Pick<AgentRow, "keep_list">): Keep[] => { try { const l = JSON.parse(a.keep_list ?? "[]"); return Array.isArray(l) ? l : []; } catch { return []; } };
export interface Stopped { pid: number; command: string; port?: number; signal: "SIGTERM"; bgjob?: string }
export interface Kept { pid: number; command: string; reason: string; port?: number }
export const STOP_GRACE_MS = 5000;
/** Which processes belong to the agent (its pane tree + same-user processes tagged AGENTNET_AGENT=<name>), minus the ones never touched
 *  (the server, root, pid 1, other agents' pane trees), split into kept and to-stop. Pure over `d`: nothing is signalled here. */
export function collect(a: AgentRow, d: Procs, serverPid = process.pid): { stop: Stopped[]; kept: Kept[] } {
  const rows = d.table(), byPid = new Map(rows.map((r) => [r.pid, r])), ppid = (p: number) => byPid.get(p)?.ppid ?? null;
  const own = d.panePids(sessionOf(a.name));
  const others = all().filter((s) => s.id !== a.id && s.life !== "gone" && s.life !== "failed").flatMap((s) => d.panePids(sessionOf(s.name)));
  const rootPid = (() => { const r = byName("root"); return r ? get(r.id)?.pid ?? null : null; })();
  const never = new Set<number>([1, serverPid, ...(rootPid ? [rootPid] : [])]);
  const keepPid = new Map<number, Keep>();
  for (const k of keepsOf(a)) { if (k.pid) keepPid.set(k.pid, k); if (k.port) for (const p of d.portPids(k.port)) keepPid.set(p, k); }
  const cands = new Map<number, ProcRow>();
  for (const p of own) cands.set(p, byPid.get(p) ?? { pid: p, ppid: 0, command: "" });
  for (const r of rows) if (r.agent === a.name || inTree(r.pid, own, ppid)) cands.set(r.pid, r);
  const stop: Stopped[] = [], kept: Kept[] = [];
  for (const r of cands.values()) {
    if (never.has(r.pid) || !goodPid(r.pid) || (others.length && inTree(r.pid, others, ppid))) continue;
    const k = keepPid.get(r.pid);
    if (k || r.keep) kept.push({ pid: r.pid, command: r.command.slice(0, 120), reason: k?.reason ?? "AGENTNET_KEEP=1", ...(k?.port ? { port: k.port } : {}) });
    else stop.push({ pid: r.pid, command: r.command.slice(0, 120), signal: "SIGTERM" });
  }
  return { stop, kept };
}
/** Stop what `collect` found and the agent's running bg jobs (bgjobs.ts stop path); SIGKILL after 5 s; the tmux session last. */
export function cleanup(a: AgentRow, d: Procs, serverPid: number) {
  const { stop, kept } = collect(a, d, serverPid), keptPids = new Set(kept.map((k) => k.pid)), stopPids = new Set(stop.map((s) => s.pid));
  for (const s of stop) { d.signal(s.pid, "SIGTERM"); d.later(() => { if (d.alive(s.pid)) d.signal(s.pid, "SIGKILL"); }, STOP_GRACE_MS); }
  const never = new Set([1, serverPid]);
  for (const j of ownedRunning(a.name, d.alive)) {
    if (keptPids.has(j.pid) || never.has(j.pid)) continue;
    if (stopPids.has(j.pid)) { const s = stop.find((x) => x.pid === j.pid)!; s.bgjob = j.id; continue; } // already signalled above
    if (stopJob(j.id, d, STOP_GRACE_MS)) stop.push({ pid: j.pid, command: j.desc, signal: "SIGTERM", bgjob: j.id });
  }
  markPendingKill(a.id, Date.now() + STOP_GRACE_MS + 500); // a restart before the timer fires: the boot sweep does the kill (sweep.ts)
  d.later(() => { d.killSession(sessionOf(a.name)); clearPendingKill(a.id); }, STOP_GRACE_MS + 500);
  return { stopped: stop, kept };
}
/** Git worktrees of the project made after the spawn: listed, never removed. */
function worktreesAfter(a: AgentRow, git: typeof realGit): string[] {
  if (!a.project) return [];
  const paths = (git(["worktree", "list", "--porcelain"], a.project) ?? "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).slice(1);
  return paths.filter((p) => { try { const st = statSync(p); return (st.birthtimeMs || st.ctimeMs) >= a.spawned_at; } catch { return false; } });
}
/** Unfinished work, never blocking: one line per dirty repo in the project (the project itself, or the repos one level down), and open steps. */
function warningsOf(a: AgentRow, job: Job | null, git: typeof realGit): string[] {
  const out: string[] = [];
  if (a.project && existsSync(a.project)) {
    const repos = git(["rev-parse", "--show-toplevel"], a.project) != null ? [a.project]
      : (() => { try { return readdirSync(a.project!).map((n) => join(a.project!, n)).filter((p) => existsSync(join(p, ".git"))); } catch { return []; } })();
    for (const r of repos) { const n = (git(["status", "--porcelain"], r) ?? "").split("\n").filter(Boolean).length; if (n) out.push(`${r}: ${n} uncommitted file${n > 1 ? "s" : ""}`); }
  }
  const open = job ? openSteps(job) : [];
  if (open.length) out.push(`${open.length} open step${open.length > 1 ? "s" : ""}: ${open.map((x) => `${job!.id}.${x.n} ${x.text.slice(0, 60)}`).join("; ")}`);
  return out;
}

// ---------- handover ----------
export const recordsDir = (name: string) => agentRecordsDir(name, ROOT);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === "string" && x.trim() ? [x] : []).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
/** Gotchas from the agent's decision notes written since its spawn. */
function noteGotchas(a: AgentRow): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(trailsDir()).filter((n) => n.includes(`-${a.name}-`) && n.endsWith(".md"))) {
      const p = join(trailsDir(), f); if (statSync(p).mtimeMs < a.spawned_at) continue;
      const md = readFileSync(p, "utf8"); if (!new RegExp(`^agent: ${a.name}$`, "m").test(md)) continue;
      const sec = /\n## Gotchas\n([\s\S]*?)(?:\n## |\s*$)/.exec(md)?.[1] ?? "";
      out.push(...sec.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean));
    }
  } catch { /* no notes */ }
  return out;
}
function writeHandover(a: AgentRow, report: string, gotchas: unknown, warnings: string[]): string {
  const d = recordsDir(a.name); mkdirSync(d, { recursive: true, mode: 0o700 });
  const file = join(d, `handover-${a.gen}.md`), g = [...new Set([...list(gotchas), ...noteGotchas(a)])];
  const sec = (h: string, l: string[]) => (l.length ? `\n## ${h}\n${l.map((x) => `- ${x}`).join("\n")}\n` : "");
  writeFileSync(file, `# Handover: ${a.name} gen ${a.gen}\n\n## Last report\n${report.trim()}\n${sec("Warnings", warnings)}${sec("Gotchas", g)}`, { mode: 0o600 });
  return file;
}
/** The newest handover of a name, cut to `max` bytes: the next spawn of that name gets it in its boot prompt, after the trails. */
export function handoverFor(name: string, max = 2000): string {
  try {
    // newest gen wins; on a tie the new dir wins (listed first, stable sort)
    const ls = (d: string) => { try { return readdirSync(d).map((n) => ({ d, m: /^handover-(\d+)\.md$/.exec(n) })).filter((x): x is { d: string; m: RegExpExecArray } => !!x.m); } catch { return []; } };
    const f = [...ls(recordsDir(name)), ...ls(legacyRecordsDir(name, ROOT))].sort((x, y) => Number(y.m[1]) - Number(x.m[1]))[0]; // one-folder fallback: remove after 0.7
    if (!f) return "";
    const t = readFileSync(join(f.d, f.m[0]), "utf8"), b = Buffer.from(t);
    return b.length <= max ? t : b.subarray(0, max - 20).toString("utf8").replace(/�+$/, "") + "\n[handover cut]";
  } catch { return ""; }
}

// ---------- dependents ----------
const SERVICE = (): AgentRow => ({ ...ADMIN, id: "@agentnet", name: "agentnet" }); // lazy: routes.ts imports this module
export const toRoot = (body: string, subject: string) => { const r = resolveTo("root"); const s = r ? enqueueMessage(SERVICE(), r, body, "info", null, subject) : null; if (!s || s.state === "gone") enqueueMessage(SERVICE(), ADMIN, body, "info", null, subject); };
const lastCommit = (job: Job | null) => job?.steps.flatMap((x) => x.evidence).filter((e) => e.kind === "commit").at(-1)?.value.split(/\s/)[0] ?? "none";
/** (a) Senders of asks that were open when the done report came in (the report closed them): one message each, the boss excluded (it has the report).
 *  (b) Live agents holding an open ask FROM this agent: the ask closes with reason "finished" and the holder is told no answer is needed.
 *  One message per agent, both reasons merged. Returns the names told. */
function tellDependents(a: AgentRow, job: Job | null, report: string, asksAtReport: Ask[]): string[] {
  const head = `${a.name} finished. Last commit ${lastCommit(job)}. Report: ${report.replace(/\s+/g, " ").trim().slice(0, 200)}`;
  const msgs = new Map<string, string[]>();
  for (const k of asksAtReport) if (k.from !== a.boss && k.from !== a.name) msgs.set(k.from, msgs.get(k.from) ?? []);
  for (const s of all()) {
    if (s.id === a.id || s.life === "gone" || s.life === "failed") continue;
    const mine = openAsks(s).filter((k) => k.from === a.name);
    for (const k of mine) emit({ agent: s.id, type: "AskClosed", data: { id: k.id, reason: "finished", by: a.name }, source: "service" });
    if (mine.length) msgs.set(s.name, [...(msgs.get(s.name) ?? []), ...mine.map((k) => `Your open ask #${k.id} from ${a.name} is closed: no answer is needed.`)]);
  }
  const told: string[] = [];
  for (const [name, extra] of msgs) {
    const to = resolveTo(name); if (!to) continue;
    if (enqueueMessage(a, to, [head, ...extra].join("\n"), "info", null, `${a.name} finished`).state !== "gone") told.push(name);
  }
  // its own asks still open (the report closes them; a legacy job may not): closed with reason finished
  const own = get(a.id); for (const k of own ? openAsks(own) : []) emit({ agent: a.id, type: "AskClosed", data: { id: k.id, reason: "finished" }, source: "service" });
  flush();
  return told;
}

// ---------- handlers ----------
export interface FinishPayload { agent: string; gen: number; job: number; grade: number; provisional: boolean; finished: Finished }
type Handler = { name: string; fn: (p: FinishPayload) => unknown; timeoutMs: number };
const handlers: Handler[] = [];
/** Runs after the despawn, in order. A throw or a timeout is logged and never blocks. Returns an unsubscribe. */
export function onDespawn(name: string, fn: (p: FinishPayload) => unknown, o: { timeoutMs?: number } = {}): () => void {
  const h = { name, fn, timeoutMs: o.timeoutMs ?? 10_000 }; handlers.push(h);
  return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
}
/** Project handlers: config/despawn-handlers.json [{name, command}]; the payload on stdin, cwd the home. */
function projectHandlers(): Handler[] {
  let l: unknown; try { l = JSON.parse(readFileSync(join(dir("config"), "despawn-handlers.json"), "utf8")); } catch { return []; }
  return (Array.isArray(l) ? l : []).filter((h): h is { name: string; command: string } => !!h && typeof h.name === "string" && typeof h.command === "string").map((h) => ({ name: h.name, timeoutMs: 10_000, fn: async (p: FinishPayload) => {
    const proc = Bun.spawn(["/bin/sh", "-c", h.command], { cwd: ROOT, stdin: new TextEncoder().encode(JSON.stringify(p)), stdout: "ignore", stderr: "ignore" });
    const t = setTimeout(() => proc.kill("SIGKILL"), 10_000); try { const c = await proc.exited; if (c !== 0) throw new Error(`exit ${c}`); } finally { clearTimeout(t); }
  } }));
}
async function runHandlers(p: FinishPayload) {
  for (const h of [...handlers, ...projectHandlers()]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => h.fn(p)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${h.timeoutMs} ms`)), h.timeoutMs); })]);
    } catch (e) { logEvent("warn", "onDespawn handler failed", { handler: h.name, agent: p.agent, error: (e as Error).message }); }
    finally { clearTimeout(timer); }
  }
}

// ---------- finish ----------
export interface Finished { grade: number; provisional: true; stopped: Stopped[]; kept: Kept[]; left: string[]; warnings: string[]; handover: string; told: string[] }
export const finishDeps: { procs: Procs; git: typeof realGit; serverPid: number } = { procs: realProcs(), git: realGit, serverPid: process.pid };
/** A standing agent is never auto-finished. */
export const isStanding = (a: Pick<AgentRow, "standing">) => Number(a.standing ?? 0) === 1;
/** Finish an agent whose done report was just accepted. On a throw the report stands, the agent stays live, the auto grade is undone and
 *  root gets one message; the error is rethrown to the caller. */
export async function finishAgent(a: AgentRow, ctx: { report: string; gotchas?: unknown; asksAtReport: Ask[] }, d = finishDeps, now = Date.now()): Promise<Finished> {
  const s = get(a.id), job = s ? jobsOf(s).filter((j) => j.closedAt != null).at(-1) ?? null : null;
  if (!s || !job) throw new Error(`${a.name} has no closed job to finish`);
  const sig = signalsOf(a.id, job), grade = autoGrade(sig);
  let graded = false;
  try {
    const c = windowCost(a.id, a.spawned_at, now);
    graded = setAutoGrade(a.id, job.id, { grade, note: signalNote(sig), report: ctx.report.split("\n")[0] ?? "", tokensIn: c.tokensIn, tokensOut: c.tokensOut, cacheRead: c.cacheRead, tokens: c.tokens, costUsd: c.costUsd,
      wallMs: now - a.spawned_at, model: s.model ?? a.model, effort: s.effort ?? a.effort }, now);
    const warnings = warningsOf(a, job, d.git), left = worktreesAfter(a, d.git);
    if (left.length) warnings.push(`worktrees left in place: ${left.join(", ")}`);
    const handover = writeHandover(a, ctx.report, ctx.gotchas, warnings);
    const { stopped, kept } = cleanup(a, d.procs, d.serverPid);
    const told = tellDependents(a, job, ctx.report, ctx.asksAtReport);
    retireAgent(a, "despawn", now, () => { /* cleanup() above stopped the processes and ends the session */ });
    const finished: Finished = { grade, provisional: true, stopped, kept, left, warnings, handover, told };
    await runHandlers({ agent: a.name, gen: a.gen, job: job.id, grade, provisional: true, finished });
    emit({ agent: a.id, type: "AgentFinished", data: { agent: a.name, gen: a.gen, job: job.id, grade, ts: now }, source: "service", ts: now, dedup: `finished:${a.id}:${job.id}` }); flush();
    return finished;
  } catch (e) {
    if (graded) clearAutoGrade(a.id, job.id);
    const msg = (e as Error).message;
    logEvent("warn", "auto-finish failed", { agent: a.name, error: msg });
    toRoot(`Auto-finish of ${a.name} (gen ${a.gen}, job ${job.id}) failed: ${msg}. Its report is stored and it is still live: despawn and grade it by hand.`, `auto-finish of ${a.name} failed`);
    flush();
    throw e;
  }
}

// ---------- review bucket ----------
export function reviewPingMin(): number {
  try { const v = (JSON.parse(readFileSync(join(dir("config"), "despawn.json"), "utf8")) as { review_ping_min?: unknown }).review_ping_min; if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1440) return v; } catch { /* default */ }
  return 10;
}
const pingFile = () => join(dir("data"), "review-ping.json");
const lastPing = (): number => { try { const n = Number((JSON.parse(readFileSync(pingFile(), "utf8")) as { at?: unknown }).at); return Number.isFinite(n) ? n : 0; } catch { return 0; } };
export const _resetReviewPing = () => { try { writeFileSync(pingFile(), JSON.stringify({ at: 0 })); } catch { /* none */ } };
/** The bucket with each item's age in minutes (review_list). */
export const reviewList = (now = Date.now()) => reviewBucket().map((r) => ({ ...r, report: (r.report ?? "").split("\n")[0] ?? "", ageMin: Math.max(0, Math.round((now - (r.gradedAt ?? r.closedAt)) / 60_000)) }));
/** One tick: a non-empty bucket pings root's session once per review_ping_min (the last ping time is stored, so a restart cannot ping twice
 *  inside one interval); an empty bucket sends nothing. Returns true when it sent. */
export function reviewTick(now = Date.now()): boolean {
  const last = lastPing();
  if (last && now - last < reviewPingMin() * 60_000) return false;
  const items = reviewList(now); if (!items.length) return false;
  const lines = items.map((r) => `- ${r.agent} gen ${r.gen} job ${r.job}: auto ${r.grade}/5, "${r.report.slice(0, 120)}", ${r.ageMin} min`);
  toRoot(`${items.length} auto grade${items.length > 1 ? "s wait" : " waits"} for review. Confirm (confirm) or grade (grade) each; review_list has them.\n${lines.join("\n")}`, `review: ${items.length} auto grade${items.length > 1 ? "s" : ""}`);
  flush();
  mkdirSync(dir("data"), { recursive: true }); writeFileSync(pingFile(), JSON.stringify({ at: now }));
  return true;
}
let reviewTimer: ReturnType<typeof setInterval> | null = null;
export function startReviewTimer() { if (!reviewTimer) { reviewTimer = setInterval(() => { try { reviewTick(); } catch (e) { logEvent("warn", "review tick failed", { error: String(e) }); } }, 60_000); reviewTimer.unref?.(); } }
