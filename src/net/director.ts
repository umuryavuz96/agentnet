// First-run setup of the director (the root agent). The page shows a "Set up your director" card while no root is live.
// GET reports what is installed and the one command that starts Claude Code as the director; POST starts that command
// in a detached tmux session. The start route is root only (this machine or the root token), see mount.ts isPanelWrite.
// The request body carries one thing, the project folder: it must be an existing absolute directory and is quoted
// for the shell. No command text from a request ever reaches a shell.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Hono } from "hono";
import { HOST, PORT, ROOT } from "../core/config";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { all, flush, forgetByName, live } from "./store";
import { byName, retireAgent } from "./routes";
import { findRootSession, hasSession as tmuxHas, healRootSession, killSession, realTmux, rootPid, rootSession } from "./windows";
import { listHooks, readHookLog } from "./hooks";
import { templates } from "./hook-templates";

export const REPO = join(import.meta.dir, "..", "..");
/** The director runs in the root agent's tmux session, so Open window on root finds it. */
export const SESSION = rootSession();

export interface Tools { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }
export const tools = (): Tools => ({ bun: !!process.versions.bun, claude: !!Bun.which("claude"), tmux: !!Bun.which("tmux"), python3: !!Bun.which("python3") });

/** POSIX single-quote: safe for any string, newlines included. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that makes a Claude Code session the director: join as "root", then start claude with the plugin.
 *  AGENTNET_URL goes inside the substitution (a prefix before eval would apply too late for it) and only when the server is not on the default port, so a scratch instance never points at the real one. */
export function directorCommand(dir: string, repo = REPO, port = PORT, host = HOST, resume?: string): string {
  const url = port === 3096 && host === "127.0.0.1" ? "" : `AGENTNET_URL=${sq(`http://${host}:${port}/api/v1/agentnet`)} `;
  return `cd ${sq(dir)} && eval "$(${url}${sq(join(repo, "scripts", "agentnet-join.sh"))} root Director ${sq(dir)})" && claude --plugin-dir "$AGENTNET_MOD"${resume ? ` --resume ${sq(resume)}` : ""}`;
}

/** claude keeps a conversation at <config>/projects/<cwd with every non-alphanumeric char as "-">/<session>.jsonl. */
export const transcriptSlug = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, "-");
export const transcriptPath = (dir: string, session: string, home = homedir()): string => join(home, ".claude", "projects", transcriptSlug(dir), `${session}.jsonl`);
/** A session id is a uuid-like token; anything else never reaches a path or a shell. */
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A dir that can be used: absolute (or ~), exists, is a folder. Returns the resolved path or a reason. */
export function checkDir(raw: unknown): { dir: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Pick a project folder." };
  let d = raw.trim();
  if (d === "~" || d.startsWith("~/")) d = homedir() + d.slice(1);
  if (!isAbsolute(d)) return { error: "Use a full path, like /Users/you/project." };
  d = resolve(d);
  try { if (!statSync(d).isDirectory()) return { error: `${d} is not a folder.` }; } catch { return { error: `${d} does not exist.` }; }
  return { dir: d };
}

export const hasSession = (): boolean => spawnSync("tmux", ["has-session", "-t", SESSION], { stdio: "ignore" }).status === 0;
export type TriageState = "off" | "ok" | "nologin" | "switched-off" | "unknown";
const TRIAGE_WORD = /(?<![a-z0-9])triage(?![a-z0-9])/i;
const DAY = 24 * 3600_000, LAST_N = 5;
/** Is prompt triage working here? Any enabled UserPromptSubmit hook that runs the agentnet template or has "triage" in its command counts,
 *  so a house hook is recognised too. "nologin": the last 5 log records of the past 24 h are all skips for a missing key (no records = no tip). */
export function triageState(hooks: { event: string; command: string; enabled: boolean }[], tplCommand: string | null, lines: { ts?: string; skip?: boolean; reason?: string }[], now = Date.now()): TriageState {
  const mine = hooks.filter((h) => h.event === "UserPromptSubmit" && ((tplCommand !== null && h.command === tplCommand) || TRIAGE_WORD.test(h.command)));
  if (!mine.length) return "off";
  if (!mine.some((h) => h.enabled)) return "switched-off";
  const recent = lines.filter((l) => l.ts && now - Date.parse(l.ts) < DAY).sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!)).slice(-LAST_N);
  return recent.length && recent.every((l) => l.skip === true && (l.reason === "not_logged_in" || l.reason === "no_claude")) ? "nologin" : "ok";
}
export function triageNow(): TriageState {
  try { return triageState(listHooks(), templates().find((t) => t.id === "agentnet-triage")?.command ?? null, readHookLog("triage.jsonl")); } catch { return "unknown"; }
}

export const hasRoot = (): boolean => live().some((a) => a.name === "root");

export interface StartResult { ok: boolean; resumed?: boolean; why?: string; code?: "no-tmux" | "no-claude" | "bad-dir" | "running" | "failed"; detail?: string; session?: string; attach?: string }

/** Start the director in a detached tmux session. `run` is replaceable so tests never spawn tmux. */
export function startDirector(rawDir: unknown, run: (cmd: string, args: string[]) => { status: number | null; stderr?: string } = (c, a) => { const r = spawnSync(c, a, { encoding: "utf8" }); return { status: r.status, stderr: r.stderr }; }, t: Tools = tools(), exists: () => boolean = hasSession, opts: { resume?: string; hasTranscript?: (dir: string, session: string) => boolean } = {}): StartResult {
  if (!t.tmux) return { ok: false, code: "no-tmux", detail: "tmux is not installed. Copy the command and run it in a terminal." };
  if (!t.claude) return { ok: false, code: "no-claude", detail: "Claude Code (claude) is not installed. Install it, then copy the command." };
  const d = checkDir(rawDir);
  if ("error" in d) return { ok: false, code: "bad-dir", detail: d.error };
  if (exists()) return { ok: false, code: "running", detail: `A tmux session ${SESSION} already exists. Attach with: tmux attach -t ${SESSION}` };
  let resume: string | undefined, why: string | undefined;
  if (opts.resume) {
    if (!SESSION_ID.test(opts.resume)) why = "The last session id is not valid.";
    else if (!(opts.hasTranscript ?? ((dir, id) => existsSync(transcriptPath(dir, id))))(d.dir, opts.resume)) why = "The last conversation file was not found.";
    else resume = opts.resume;
  }
  const r = run("tmux", ["new-session", "-d", "-s", SESSION, "-c", d.dir, "sh", "-c", directorCommand(d.dir, REPO, PORT, HOST, resume)]);
  if (r.status !== 0) return { ok: false, code: "failed", detail: (r.stderr ?? "").trim() || "tmux could not start the session." };
  logEvent("info", "director started", { session: SESSION, dir: d.dir, resumed: !!resume });
  return { ok: true, session: SESSION, attach: `tmux attach -t ${SESSION}`, ...(opts.resume ? { resumed: !!resume, ...(why ? { why } : {}) } : {}) };
}

export type PickResult = { ok: true; dir: string } | { ok: false; code: "cancelled" | "unsupported" | "failed"; detail: string };
export type PickRun = (cmd: string[]) => Promise<{ status: number | null; out: string; err: string }>;
const realPick: PickRun = async (cmd) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" }); const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); return { status: await p.exited, out, err }; };
/** Ask the server's own desktop for a folder: macOS osascript, Linux zenity. Returns the chosen absolute path (no trailing slash). */
export async function pickFolder(run: PickRun = realPick, platform: string = process.platform, has: (b: string) => boolean = (b) => !!Bun.which(b)): Promise<PickResult> {
  let cmd: string[];
  if (platform === "darwin") cmd = ["osascript", "-e", "POSIX path of (choose folder with prompt \"Choose the director's project folder\")"];
  else if (has("zenity")) cmd = ["zenity", "--file-selection", "--directory"];
  else return { ok: false, code: "unsupported", detail: "No folder dialog on this machine. Type the path instead." };
  let r; try { r = await run(cmd); } catch { return { ok: false, code: "unsupported", detail: "No folder dialog on this machine. Type the path instead." }; }
  if (r.status === 0) { const d = r.out.trim().replace(/(.)\/+$/, "$1"); return d ? { ok: true, dir: d } : { ok: false, code: "cancelled", detail: "No folder chosen." }; }
  if (/-128|cancel/i.test(r.err) || (platform !== "darwin" && r.status === 1 && !r.err.trim())) return { ok: false, code: "cancelled", detail: "No folder chosen." };
  if (/-1743|-1712|not allowed|no display|cannot open display|display/i.test(r.err)) return { ok: false, code: "unsupported", detail: "The folder dialog cannot open here (no screen or no permission). Type the path instead." };
  return { ok: false, code: "failed", detail: "The folder dialog failed. Type the path instead." };
}

/** The folder to start the director in when nobody picked one: where root last ran (its project), else the home folder. */
export const defaultDirectorDir = (): string => { const p = all().find((a) => a.name === "root")?.project; return p && "dir" in checkDir(p) ? (checkDir(p) as { dir: string }).dir : homedir(); };
/** Root's last run, for the Not running card: its folder, its session id and when it went quiet. null when root never ran. */
export function lastDirector(): { session: string | null; dir: string | null; at: number } | null {
  const r = all().find((a) => a.name === "root");
  if (!r) return null;
  return { session: r.session, dir: r.project, at: r.lifeSince };
}
/** A director running outside tmux: its working folder (lsof), or null. */
const cwdOf = (pid: number): string | null => { const r = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" }); const m = /^n(.+)$/m.exec(r.stdout ?? ""); return m ? m[1]! : null; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
export interface MoveDeps { pid: () => number | null; cwd: (pid: number) => string | null; stop: (pid: number) => void; gone: (pid: number) => Promise<boolean>; start: (dir: string) => StartResult }
const realMove: MoveDeps = { pid: rootPid, cwd: cwdOf, stop: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }, gone: async (pid) => { for (let i = 0; i < 30; i++) { if (!alive(pid)) return true; await Bun.sleep(100); } return false; }, start: (d) => startDirector(d) };
/** Move a hand-started director into an agentnet tmux window: stop it, start it again in the same folder in agentnet-root. */
export async function moveDirector(d: MoveDeps = realMove): Promise<StartResult> {
  const pid = d.pid();
  if (!pid || pid <= 1 || !alive(pid)) return { ok: false, code: "failed", detail: "The director is not running. Use Start director." };
  const dir = d.cwd(pid) ?? defaultDirectorDir();
  d.stop(pid);
  if (!(await d.gone(pid))) return { ok: false, code: "failed", detail: "The director did not stop. Close it in its own terminal, then use Start director." };
  logEvent("info", "director moved into tmux", { pid, dir });
  return d.start(dir);
}

export interface ResetDeps {
  pid: () => number | null; session: (pid: number | null) => string | null;
  killSession: (s: string) => boolean; signal: (pid: number) => void; gone: (pid: number) => Promise<boolean>;
  backup: (line: string) => void; forget: () => unknown[];
}
const realReset: ResetDeps = {
  pid: rootPid, session: (pid) => { const s = findRootSession(realTmux, pid && alive(pid) ? pid : null); return s && tmuxHas(s) ? s : null; },
  killSession: (s) => killSession(s), signal: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } },
  gone: async (pid) => { for (let i = 0; i < 30; i++) { if (!alive(pid)) return true; await Bun.sleep(100); } return false; },
  backup: (line) => { const dir = join(ROOT, "data"); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "director-resets.jsonl"), line + "\n"); },
  forget: () => { const a = byName("root"); if (a) retireAgent(a, "reset"); flush(); return forgetByName("root"); },
};
/** Reset the director: stop it if it runs, back up root's row, forget root so the first-run setup shows again.
 *  Never touches other agents, teams, tasks, transcripts or ~/.claude. */
export async function resetDirector(d: ResetDeps = realReset, now = Date.now()): Promise<{ ok: boolean; stopped: boolean; detail?: string }> {
  const pid = d.pid(); let stopped = false;
  if (pid) {
    const s = d.session(pid);
    if (s) { d.killSession(s); stopped = true; }
    else if (pid > 1) { d.signal(pid); stopped = true; }
    if (stopped && pid > 1 && !(await d.gone(pid))) return { ok: false, stopped, detail: "The director did not stop. Close it in its own terminal, then try again." };
  }
  const rows = d.forget();
  d.backup(JSON.stringify({ at: new Date(now).toISOString(), rows }));
  logEvent("info", "director reset", { stopped, rows: rows.length });
  return { ok: true, stopped };
}

export function directorRoutes(api: Hono<Env>): void {
  api.post("/agent-director/reset", async (c) => {
    const r = await resetDirector();
    return r.ok ? c.json(r) : problem(c, 422, "failed", r.detail ?? "could not reset");
  });
  api.post("/agent-director/move", async (c) => {
    const r = await moveDirector();
    return r.ok ? c.json(r) : problem(c, 422, r.code ?? "failed", r.detail ?? "could not move");
  });
  api.get("/agent-director", (c) => {
    const q = c.req.query("dir"), home = homedir();
    const d = checkDir(q ?? home);
    const dir = "dir" in d ? d.dir : home;
    return c.json({ home, dir, dirError: "error" in d ? d.error : null, tools: tools(), root: hasRoot(), hadRoot: all().some((a) => a.name === "root"), last: lastDirector(), triage: triageNow(), session: hasSession(), sessionName: SESSION, command: directorCommand(dir) });
  });
  api.post("/agent-director/pick-folder", async (c) => {
    const r = await pickFolder();
    if (r.ok) return c.json({ dir: r.dir });
    if (r.code === "cancelled") return c.json({ dir: null, cancelled: true });
    return problem(c, r.code === "unsupported" ? 501 : 500, r.code, r.detail);
  });
  api.post("/agent-director/start", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { dir?: unknown; restart?: boolean; resume?: boolean };
    healRootSession();
    if (b.restart && !hasRoot() && hasSession()) spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`], { stdio: "ignore" }); // Not running card: a leftover shell session of the dead director must not block the start
    const r = startDirector(b.dir ?? defaultDirectorDir(), undefined, undefined, undefined, b.resume ? { resume: lastDirector()?.session ?? undefined } : {}); // no folder given (the Start director button on a Not running card): where root last ran
    if (r.ok) return c.json(r);
    const status = r.code === "running" ? 409 : r.code === "bad-dir" ? 400 : 422;
    return problem(c, status, r.code ?? "failed", r.detail ?? "could not start");
  });
}
