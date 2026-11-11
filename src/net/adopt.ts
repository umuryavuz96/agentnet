// Adopt an existing workspace: the state machine and the routes (panel + the two root-only agent tools).
// idle -> scanning -> reported -> planned -> applying -> applied (-> rolledback). One adopt operation at a time.
// The heavy parts live in adopt-scan / -report / -plan / -apply; this file only orders them and keeps state in $AGENTNET_HOME/adopt.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { ROOT } from "../core/config";
import { problem, type Env } from "../core/http";
import { audit, logEvent } from "../core/logger";
import { writeAtomic } from "./adopt-safe";
import { collectFacts, type Facts } from "./adopt-scan";
import { MAX_ACTIONS, validateReport, type Action, type AdoptReport, type Evidence, type Finding } from "./adopt-report";
import { buildPlan, type Picks, type Plan } from "./adopt-plan";
import { applyPlan, listRuns, noteLateFile, rollbackRun } from "./adopt-apply";
import { explainReport } from "./adopt-explain";
import { launchView, setBeforeAnswer, setParkedMcp } from "./launch";
import { checkDir, ensureDirectorHome, hasRoot, hasSession, killScanSession as realKill, SESSION, startDirector as realStart, writeScanMarker } from "./director";
import { createdOf } from "./windows";
import { byName, retireAgent } from "./routes";
import { loadRoles } from "./arsenal";
import { wsRoles } from "./workspace";
import { scriptOf } from "./hooks";
import { redactText } from "./adopt-safe";

export type Phase = "idle" | "scanning" | "reported" | "planned" | "applying" | "applied" | "rolledback";
export interface AdoptState { phase: Phase; workspace: string | null; mode: "clean" | "adopt" | null; scanner: "director" | "static" | null; scanId: string | null; planId: string | null; runId: string | null; scanStartedAt: number | null; error: string | null; updatedAt: number }
const EMPTY: AdoptState = { phase: "idle", workspace: null, mode: null, scanner: null, scanId: null, planId: null, runId: null, scanStartedAt: null, error: null, updatedAt: 0 };
/** The director has this long to report; a session that never shows up is declared failed after SESSION_GRACE_MS. */
export const SCAN_TIMEOUT_MS = 180_000, SESSION_GRACE_MS = 20_000;

/** Test seam: the tmux side effects. Tests replace these; production never does. */
// Lazy wrappers: director.ts imports routes -> adopt.ts, so its exports may not exist yet when this line runs.
export const seams = {
  startDirector: ((...a: Parameters<typeof realStart>) => realStart(...a)) as typeof realStart,
  killScanSession: ((...a: Parameters<typeof realKill>) => realKill(...a)) as typeof realKill,
  hasSession: ((...a: Parameters<typeof hasSession>) => hasSession(...a)) as typeof hasSession,
  hasRoot: (() => hasRoot()) as typeof hasRoot,
};
const startDirector: typeof realStart = (...a) => seams.startDirector(...a);
const killScanSession = () => seams.killScanSession();
/** The scan session joins as "root" (agentnet-join.sh). Once it is stopped its row must go too, or the real director's join is refused
 *  with "root is live already". Only when this flow started a director scan; a root that is not the scan's is left alone. */
export function retireScanRoot(): boolean {
  const st = loadState(); if (st.scanner !== "director" || st.phase === "applied") return false;
  const a = byName("root"); if (!a) return false;
  retireAgent(a, "replaced"); return true;
}

const dirOf = () => join(ROOT, "adopt");
const cur = (f: string) => join(dirOf(), "current", f);
const readJson = <T>(f: string): T | null => { try { return JSON.parse(readFileSync(f, "utf8")) as T; } catch { return null; } };
const putJson = (f: string, v: unknown) => { mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 }); writeAtomic(f, JSON.stringify(v, null, 2) + "\n", 0o600); };
export const loadState = (): AdoptState => ({ ...EMPTY, ...(readJson<Partial<AdoptState>>(join(dirOf(), "state.json")) ?? {}) });
export function setState(patch: Partial<AdoptState>): AdoptState {
  const s = { ...loadState(), ...patch, updatedAt: Date.now() };
  putJson(join(dirOf(), "state.json"), s);
  return s;
}
const clearCurrent = () => rmSync(join(dirOf(), "current"), { recursive: true, force: true });
const loadFacts = () => readJson<Facts & { scanId: string }>(cur("facts.json"));
const loadReport = () => readJson<AdoptReport>(cur("report.json"));
const loadPlan = () => readJson<Plan>(cur("plan.json"));
const newScanId = () => "scan-" + randomBytes(4).toString("hex");
const newRunId = (d = new Date()) => "run-" + d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
/** Role names that ship with agentnet (not the ones a previous adopt run added). */
const builtinRoles = () => { const w = new Set(Object.keys(wsRoles())); return Object.keys(loadRoles().roles).filter((r) => !w.has(r)); };

// ---------- the Basic scan: findings straight from the signals, no model ----------
const AGENT_OK = /^[a-z0-9][a-z0-9-]{0,30}$/;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function staticReport(facts: Facts): { summary: string; findings: Finding[] } {
  const sig = (id: string) => facts.signals.filter((s) => s.id === id);
  const ev = (s: { ref: string; file?: unknown; path?: unknown }, quote?: string): Evidence => ({ signal: s.ref, path: String(s.file ?? s.path ?? facts.workspace), ...(quote ? { quote } : {}) });
  const findings: Finding[] = [];
  let aid = 0, fid = 0;
  const A = () => `a${++aid}`;
  const hookCmd = (file: string, event: string, matcher: string | null, shown: string): string | null => {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };
      for (const g of j.hooks?.[event] ?? []) if ((g.matcher ?? null) === matcher) for (const h of g.hooks ?? []) if (typeof h.command === "string" && redactText(h.command).slice(0, 200) === shown) return h.command.slice(0, 200);
    } catch { /* unreadable: no action */ }
    return null;
  };
  // 1. hooks + MCP servers that look like message exchange
  const coord: { f: Finding["evidence"]; a: Action[] } = { f: [], a: [] };
  for (const s of sig("S-HOOK-INJECT")) {
    const c = hookCmd(String(s.file), String(s.event), (s.matcher as string | null) ?? null, String(s.command));
    coord.f.push(ev(s, String(s.command)));
    if (c) coord.a.push({ id: A(), op: "park-hook", file: String(s.file), event: String(s.event), matcher: (s.matcher as string | null) ?? null, commandIncludes: c });
  }
  for (const s of sig("S-MCP")) { coord.f.push(ev(s, `${s.server}: ${s.command}`)); coord.a.push({ id: A(), op: "park-mcp", file: String(s.file), server: String(s.server) }); }
  if (coord.f.length) findings.push({ id: `f${++fid}`, kind: "coordination-system", title: "Something here moves messages between agents", about: "Hooks or tool servers in this workspace mention inboxes, messages or teams. They may be a second coordination system that clashes with agentnet. This basic scan cannot tell for sure.", confidence: "low", risk: "medium", agents: [], evidence: coord.f.slice(0, 8), suggestion: "switch-off", actions: coord.a.slice(0, MAX_ACTIONS) });
  // 2. identity claims
  const ids = sig("S-INSTR-IDENTITY");
  if (ids.length) findings.push({ id: `f${++fid}`, kind: "identity-claim", title: "Instructions say who the main agent is", about: "A rules file tells the agent it is a named coordinator. The agentnet director would take that name. agentnet rules win either way; you can also switch those lines off.", confidence: "low", risk: "low", agents: [], evidence: ids.slice(0, 8).map((s) => ({ ...ev(s, String(s.text)), line: Number(s.line) })), suggestion: "neutralise-lines", actions: ids.slice(0, 12).map((s) => ({ id: A(), op: "disable-lines" as const, file: String(s.file), fromLine: Number(s.line), toLine: Number(s.line), why: "names the main agent" })) });
  // 3. instruction lines about messaging
  const msgs = sig("S-INSTR-MSG");
  if (msgs.length) findings.push({ id: `f${++fid}`, kind: "workspace-instructions", title: "Instructions tell agents how to message each other", about: "These lines say how agents send messages or report. agentnet rules outrank them. Switch them off only if you want them gone from the file.", confidence: "low", risk: "low", agents: [], evidence: msgs.slice(0, 8).map((s) => ({ ...ev(s, String((s.lines as { text: string }[])[0]?.text ?? "")), line: Number(s.fromLine) })), suggestion: "neutralise-lines", actions: msgs.slice(0, 12).map((s) => ({ id: A(), op: "disable-lines" as const, file: String(s.file), fromLine: Number(s.fromLine), toLine: Number(s.toLine), why: "message routing" })) });
  // 4. repo agents -> workspace souls
  const defs = sig("S-REPO-AGENT-DEF"), used = new Set<string>(), souls: Action[] = [], sev: Evidence[] = [];
  for (const s of defs) {
    const name = String(s.name ?? basename(String(s.repo))).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
    if (!AGENT_OK.test(name) || used.has(name) || souls.length >= 12) continue;
    used.add(name); sev.push(ev(s));
    souls.push(s.claudeMdOnly ? { id: A(), op: "register-souls", repo: String(s.repo), name, source: "claude-md" } : { id: A(), op: "register-souls", repo: String(s.repo), name, source: "agent-def", defFile: String(s.file) });
  }
  if (souls.length) findings.push({ id: `f${++fid}`, kind: "agent-definitions", title: `${souls.length} repo ${souls.length === 1 ? "agent" : "agents"} found`, about: "These repos have their own agent definition or rules. Adding them as workspace souls lets you spawn them by name; each starts in its repo with its own rules.", confidence: "high", risk: "low", agents: [...used].slice(0, 30), evidence: sev.slice(0, 8), suggestion: "adopt-as-souls", actions: souls });
  // 5. runners: report only
  const man: Action[] = [], rev: Evidence[] = [];
  for (const s of sig("S-RUNNER-TMUX")) { rev.push(ev(s, String(s.session))); man.push({ id: A(), op: "manual", title: `Stop the tmux session ${s.session}`, command: `tmux kill-session -t ${sq(String(s.session))}`, why: "It runs an agent of the old setup. agentnet will not stop it for you." }); }
  for (const s of sig("S-RUNNER-LAUNCHD")) { rev.push(ev(s, String(s.label))); man.push({ id: A(), op: "manual", title: `Unload the launch agent ${s.label}`, command: `launchctl unload ${sq(String(s.file))}`, why: "A background job starts agents of the old setup." }); }
  for (const s of sig("S-RUNNER-CRON")) { rev.push({ signal: s.ref, path: facts.workspace, quote: String(s.line).slice(0, 160) }); man.push({ id: A(), op: "manual", title: "Remove a cron line that runs agents", command: "crontab -e", why: `Line: ${String(s.line).slice(0, 120)}` }); }
  if (man.length) findings.push({ id: `f${++fid}`, kind: "scheduled-runner", title: "Old agents may still be running", about: "Sessions or jobs on this machine run agents of the old setup. agentnet will not touch them: copy the commands, run them yourself, then scan again.", confidence: "medium", risk: "medium", agents: [], evidence: rev.slice(0, 8), suggestion: "manual", actions: man.slice(0, 12) });
  const n = facts.signals.length;
  return { summary: findings.length ? `Basic scan: ${n} signal${n === 1 ? "" : "s"}, ${findings.length} thing${findings.length === 1 ? "" : "s"} to look at.` : "Basic scan found nothing here that coordinates agents.", findings };
}

// ---------- scan, report, plan, apply, rollback ----------
type Fail = { ok: false; status: 400 | 409 | 422 | 500; title: string; detail: string; errors?: string[] };
type Ok<T> = { ok: true } & T;

/** The one place a report enters: validate against the facts of the active scan, store, move to `reported`. */
export function submitReport(raw: unknown, scanner: "director" | "static"): Ok<{ report: AdoptReport }> | Fail {
  const st = loadState(), facts = loadFacts();
  if (st.phase !== "scanning" || !facts) return { ok: false, status: 409, title: "Conflict", detail: "no scan in progress" };
  const v = validateReport(raw, facts, { scanId: facts.scanId, scanner, builtinRoles: builtinRoles() });
  if (!v.ok) return { ok: false, status: 400, title: "Bad Request", detail: `the report did not validate: ${v.errors.slice(0, 5).join("; ")}`, errors: v.errors };
  putJson(cur("report.json"), v.report);
  setState({ phase: "reported", error: null });
  audit("agent:root", "agentnet.adopt.report", facts.scanId, "ok", undefined, { findings: v.report.findings.length, scanner });
  return { ok: true, report: v.report };
}

export function startScan(dirIn: unknown, mode: "director" | "static"): Ok<{ scanId: string; phase: Phase }> | Fail {
  const st = loadState();
  if (st.phase === "scanning" || st.phase === "applying") return { ok: false, status: 409, title: "Conflict", detail: `an adopt run is in progress (${st.phase})` };
  const d = checkDir(dirIn);
  if ("error" in d) return { ok: false, status: 400, title: "Bad Request", detail: d.error };
  const stub = process.env.AGENTNET_ADOPT_STUB;
  if (mode === "director" && !stub) {
    if (seams.hasRoot()) return { ok: false, status: 409, title: "Conflict", detail: "a director is already running" };
    if (seams.hasSession()) return { ok: false, status: 409, title: "Conflict", detail: `a tmux session ${SESSION} already exists` };
  }
  const facts = collectFacts(d.dir), scanId = newScanId();
  clearCurrent();
  putJson(cur("facts.json"), { ...facts, scanId });
  setState({ phase: "scanning", workspace: d.dir, mode: "adopt", scanner: mode, scanId, planId: null, runId: null, scanStartedAt: Date.now(), error: null });
  audit("panel", "agentnet.adopt.scan", scanId, "ok", undefined, { mode, signals: facts.signals.length });
  if (mode === "static") {
    const r = submitReport(staticReport(facts), "static");
    if (!r.ok) { setState({ phase: "idle", error: r.detail }); return r; }
  } else if (stub) { // tests and screenshots: a canned report goes through the same validation, no tmux, no claude
    let raw: unknown; try { raw = JSON.parse(readFileSync(stub, "utf8")); } catch (e) { setState({ phase: "idle", error: "stub file unreadable" }); return { ok: false, status: 500, title: "Internal Error", detail: String(e) }; }
    const r = submitReport(raw, "director");
    if (!r.ok) { setState({ phase: "idle", error: r.detail }); return r; }
  } else {
    const r = startDirector(d.dir, undefined, undefined, undefined, { mode: "scan", root: ROOT, roots: facts.roots });
    if (!r.ok) { setState({ phase: "idle", error: r.detail ?? "could not start" }); return { ok: false, status: r.code === "running" ? 409 : r.code === "bad-dir" ? 400 : 422, title: r.code ?? "failed", detail: r.detail ?? "could not start the scan session" }; }
    const created = createdOf(SESSION); if (created) writeScanMarker(created, ROOT);
  }
  return { ok: true, scanId, phase: loadState().phase };
}

export function cancelScan(): { ok: true; killed: boolean } {
  const killed = (() => { try { return killScanSession(); } catch { return false; } })();
  try { retireScanRoot(); } catch { /* none */ }
  if (loadState().phase !== "applying") { clearCurrent(); setState({ phase: "idle", scanId: null, planId: null, error: null, scanStartedAt: null }); }
  audit("panel", "agentnet.adopt.cancel", "scan", "ok");
  return { ok: true, killed };
}

export function makePlan(scanId: unknown, picks: unknown): Ok<{ plan: Plan }> | Fail {
  const st = loadState(), report = loadReport();
  if (!report || (st.phase !== "reported" && st.phase !== "planned")) return { ok: false, status: 409, title: "Conflict", detail: "no report to plan from. Scan first." };
  if (scanId !== st.scanId) return { ok: false, status: 409, title: "Conflict", detail: "that scan is not the current one" };
  const p0 = picks as (Picks & { skipActions?: string[] }) | null;
  const p = p0 && { ...p0, actions: { ...(p0.actions ?? {}), ...Object.fromEntries((Array.isArray(p0.skipActions) ? p0.skipActions : []).map((a) => [a, false])) } };
  if (!p || typeof p !== "object" || typeof p.findings !== "object" || !p.findings) return { ok: false, status: 400, title: "Bad Request", detail: "picks.findings is required" };
  const r = buildPlan(report, { findings: p.findings, ...(p.actions ? { actions: p.actions } : {}) }, { runId: newRunId(), root: ROOT });
  if (!r.ok) return { ok: false, status: 400, title: "Bad Request", detail: r.errors.join("; "), errors: r.errors };
  putJson(cur("plan.json"), r.plan);
  setState({ phase: "planned", planId: r.plan.planId, runId: r.plan.runId });
  audit("panel", "agentnet.adopt.plan", r.plan.runId, "ok", undefined, { ops: r.plan.ops.length });
  return { ok: true, plan: r.plan };
}

setParkedMcp(() => (loadPlan()?.ops ?? []).flatMap((o) => (o.op === "park-mcp" ? [o.server] : [])));

/** Answering an MCP dialog makes Claude Code write <workspace>/.claude/settings.local.json: put it in the run first, so Rollback undoes it. */
setBeforeAnswer((kind) => {
  if (kind === "trust") return null;
  const st = loadState();
  if (st.mode !== "adopt" || st.phase !== "applied" || !st.runId || !st.workspace) return null; // clean mode and plain starts changed nothing in a workspace run
  const e = noteLateFile(st.runId, join(st.workspace, ".claude", "settings.local.json"), ROOT);
  return e ? `Could not back up settings.local.json first, so nothing was answered: ${e}` : null;
});

export async function applyCurrent(planId: unknown, confirmGlobal: boolean): Promise<Ok<{ runId: string; director: { ok: boolean; detail?: string } }> | Fail> {
  const st = loadState(), plan = loadPlan();
  if (st.phase === "applying") return { ok: false, status: 409, title: "Conflict", detail: "an apply is already running" };
  if (!plan || st.phase !== "planned" || planId !== st.planId || plan.planId !== planId) return { ok: false, status: 409, title: "Conflict", detail: "That is not the current plan. Preview again." };
  setState({ phase: "applying" });
  const facts = loadFacts();
  const r = await applyPlan(plan, { root: ROOT, confirmGlobal, builtinRoles: builtinRoles(), repos: facts?.repos.map((x) => x.path) });
  if (!r.ok) {
    setState({ phase: "reported", planId: null, error: r.error });
    audit("panel", "agentnet.adopt.apply", plan.runId, "failed", undefined, { error: r.error });
    return { ok: false, status: r.status, title: r.status === 409 ? "Conflict" : r.status === 400 ? "Bad Request" : "Internal Error", detail: r.error };
  }
  try { killScanSession(); } catch { /* no tmux */ }
  try { retireScanRoot(); } catch { /* none */ }
  const souls = plan.ops.flatMap((o) => (o.op === "register-souls" ? [o.name] : []));
  const sd = startDirector(plan.workspace, undefined, undefined, undefined, { mode: "adopt", root: ROOT, repos: facts?.repos.map((x) => x.path), souls });
  setState({ phase: "applied", runId: plan.runId, error: sd.ok ? null : sd.detail ?? "director not started" });
  audit("panel", "agentnet.adopt.apply", plan.runId, "ok", undefined, { files: r.manifest.files.length, director: sd.ok });
  return { ok: true, runId: plan.runId, director: { ok: sd.ok, ...(sd.detail ? { detail: sd.detail } : {}) } };
}

/** Reset director: undo an applied adopt run (backed-up files restored, files adopt created removed, files you changed since kept), then forget the whole adopt state. The workspace itself is never deleted. */
export function resetAdopt(): string[] {
  const out: string[] = [], st = loadState();
  if (st.mode === "adopt" && st.phase === "applied" && st.runId) {
    try { const r = rollbackRun(st.runId, { root: ROOT }); out.push(`adopt run ${st.runId} rolled back: ${r.restored.length} restored, ${r.removed.length} removed, ${r.kept.length} kept`); } catch (e) { out.push(`adopt rollback failed: ${(e as Error).message}`); }
  }
  try { killScanSession(); } catch { /* no tmux */ }
  for (const f of [join(dirOf(), "state.json"), join(dirOf(), "current")]) { if (existsSync(f)) { rmSync(f, { recursive: true, force: true }); out.push(f); } }
  return out;
}
export function doRollback(runId: unknown, force: boolean) {
  const r = rollbackRun(typeof runId === "string" && runId ? runId : undefined, { root: ROOT, force });
  if (r.ok && !r.nothingToDo) { const s = loadState(); if (!s.runId || s.runId === r.runId) setState({ phase: "rolledback" }); }
  audit("panel", "agentnet.adopt.rollback", r.runId ?? "none", r.ok ? "ok" : "failed", undefined, { restored: r.restored.length, kept: r.kept.length });
  return r;
}

/** Clean mode: the director gets its own home, the project is attached with --add-dir. Nothing in the project is read or changed. */
export function startClean(dirIn: unknown): Ok<{ session?: string; attach?: string }> | Fail {
  const st = loadState();
  if (st.phase === "scanning" || st.phase === "applying") return { ok: false, status: 409, title: "Conflict", detail: `an adopt run is in progress (${st.phase})` };
  if (seams.hasRoot()) return { ok: false, status: 409, title: "Conflict", detail: "a director is already running" };
  const r = startDirector(dirIn, undefined, undefined, undefined, { mode: "clean", root: ROOT });
  if (!r.ok) return { ok: false, status: r.code === "running" ? 409 : r.code === "bad-dir" ? 400 : 422, title: r.code ?? "failed", detail: r.detail ?? "could not start" };
  ensureDirectorHome(ROOT);
  const d = checkDir(dirIn);
  setState({ phase: "applied", mode: "clean", workspace: "dir" in d ? d.dir : null, scanner: null, scanId: null, planId: null, runId: null, error: null });
  audit("panel", "agentnet.adopt.clean", "dir" in d ? d.dir : "?", "ok");
  return { ok: true, session: r.session, attach: r.attach };
}

/** What the page sees. A director scan that never reports is marked failed here (180 s, or no session after 20 s). */
export function view() {
  let st = loadState(), scan: { state: "idle" | "reading" | "ready" | "failed"; error: string | null } = { state: "idle", error: null };
  if (st.phase === "scanning") {
    const age = Date.now() - (st.scanStartedAt ?? Date.now());
    if (st.scanner === "director" && !process.env.AGENTNET_ADOPT_STUB && (age > SCAN_TIMEOUT_MS || (age > SESSION_GRACE_MS && !seams.hasSession()))) scan = { state: "failed", error: age > SCAN_TIMEOUT_MS ? "the director did not report in time" : "the scan session ended without a report" };
    else scan = { state: "reading", error: null };
  } else if (st.phase === "reported" || st.phase === "planned") scan = { state: "ready", error: null };
  return { ...st, launch: launchView(), failed: scan.state === "failed" ? scan.error : null, scan, facts: st.phase === "idle" ? null : (() => { const f = loadFacts(); return f ? { signals: f.signals.length, repos: f.repos.length, skipped: f.skipped } : null; })(), report: explainReport(loadReport(), loadFacts()), plan: st.phase === "planned" || st.phase === "applying" ? loadPlan() : null, runs: listRuns(ROOT).slice(0, 5) };
}

// ---------- routes ----------
const fail = (c: Context<Env>, r: Fail) => problem(c, r.status, r.title, r.detail, r.errors ? { errors: r.errors } : undefined);
const body = async (c: Context<Env>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

export function adoptRoutes(api: Hono<Env>): void {
  api.get("/agent-adopt", (c) => c.json(view()));
  api.post("/agent-adopt/scan", async (c) => {
    const b = await body(c), r = startScan(b.dir, b.mode === "static" ? "static" : "director");
    return r.ok ? c.json(r) : fail(c, r);
  });
  api.post("/agent-adopt/cancel", (c) => c.json(cancelScan()));
  api.post("/agent-adopt/plan", async (c) => { const b = await body(c), r = makePlan(b.scanId, b.picks); return r.ok ? c.json(r.plan) : fail(c, r); });
  api.post("/agent-adopt/apply", async (c) => { const b = await body(c), r = await applyCurrent(b.planId, b.confirmGlobal === true); return r.ok ? c.json(r) : fail(c, r); });
  api.post("/agent-adopt/rollback", async (c) => { const b = await body(c), r = doRollback(b.runId, b.force === true); return r.ok ? c.json(r) : problem(c, 422, "failed", r.error ?? "rollback failed"); });
  api.post("/agent-adopt/clean", async (c) => { const b = await body(c), r = startClean(b.dir); return r.ok ? c.json(r) : fail(c, r); });
}

/** Root-only agent tools (called from agentnetRoutes after its auth): the scan phase gate is here. */
export function adoptFacts(c: Context<Env>) {
  const st = loadState(), facts = loadFacts();
  if (st.phase !== "scanning" || !facts) return problem(c, 409, "Conflict", "no scan in progress");
  return c.json(facts);
}
export function adoptReportRoute(c: Context<Env>, raw: Record<string, unknown>) {
  const r = submitReport(raw, "director");
  if (!r.ok) { logEvent("warn", "adopt report refused", { detail: r.detail }); return fail(c, r); }
  return c.json({ ok: true, scanId: r.report.scanId, findings: r.report.findings.length, phase: "reported" });
}
