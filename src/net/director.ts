// First-run setup of the director (the root agent). The page shows a "Set up your director" card while no root is live.
// GET reports what is installed and the one command that starts Claude Code as the director; POST starts that command
// in a detached tmux session. The start route is root only (this machine or the root token), see mount.ts isPanelWrite.
// The request body carries one thing, the project folder: it must be an existing absolute directory and is quoted
// for the shell. No command text from a request ever reaches a shell.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Hono } from "hono";
import { HOST, PORT } from "../core/config";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { live } from "./store";
import { healRootSession, rootPid, rootSession } from "./windows";
import { all } from "./store";
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
export function directorCommand(dir: string, repo = REPO, port = PORT, host = HOST): string {
  const url = port === 3096 && host === "127.0.0.1" ? "" : `AGENTNET_URL=${sq(`http://${host}:${port}/api/v1/agentnet`)} `;
  return `cd ${sq(dir)} && eval "$(${url}${sq(join(repo, "scripts", "agentnet-join.sh"))} root Director ${sq(dir)})" && claude --plugin-dir "$AGENTNET_MOD"`;
}

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

export interface StartResult { ok: boolean; code?: "no-tmux" | "no-claude" | "bad-dir" | "running" | "failed"; detail?: string; session?: string; attach?: string }

/** Start the director in a detached tmux session. `run` is replaceable so tests never spawn tmux. */
export function startDirector(rawDir: unknown, run: (cmd: string, args: string[]) => { status: number | null; stderr?: string } = (c, a) => { const r = spawnSync(c, a, { encoding: "utf8" }); return { status: r.status, stderr: r.stderr }; }, t: Tools = tools(), exists: () => boolean = hasSession): StartResult {
  if (!t.tmux) return { ok: false, code: "no-tmux", detail: "tmux is not installed. Copy the command and run it in a terminal." };
  if (!t.claude) return { ok: false, code: "no-claude", detail: "Claude Code (claude) is not installed. Install it, then copy the command." };
  const d = checkDir(rawDir);
  if ("error" in d) return { ok: false, code: "bad-dir", detail: d.error };
  if (exists()) return { ok: false, code: "running", detail: `A tmux session ${SESSION} already exists. Attach with: tmux attach -t ${SESSION}` };
  const r = run("tmux", ["new-session", "-d", "-s", SESSION, "-c", d.dir, "sh", "-c", directorCommand(d.dir)]);
  if (r.status !== 0) return { ok: false, code: "failed", detail: (r.stderr ?? "").trim() || "tmux could not start the session." };
  logEvent("info", "director started", { session: SESSION, dir: d.dir });
  return { ok: true, session: SESSION, attach: `tmux attach -t ${SESSION}` };
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

export function directorRoutes(api: Hono<Env>): void {
  api.post("/agent-director/move", async (c) => {
    const r = await moveDirector();
    return r.ok ? c.json(r) : problem(c, 422, r.code ?? "failed", r.detail ?? "could not move");
  });
  api.get("/agent-director", (c) => {
    const q = c.req.query("dir"), home = homedir();
    const d = checkDir(q ?? home);
    const dir = "dir" in d ? d.dir : home;
    return c.json({ home, dir, dirError: "error" in d ? d.error : null, tools: tools(), root: hasRoot(), hadRoot: all().some((a) => a.name === "root"), triage: triageNow(), session: hasSession(), sessionName: SESSION, command: directorCommand(dir) });
  });
  api.post("/agent-director/pick-folder", async (c) => {
    const r = await pickFolder();
    if (r.ok) return c.json({ dir: r.dir });
    if (r.code === "cancelled") return c.json({ dir: null, cancelled: true });
    return problem(c, r.code === "unsupported" ? 501 : 500, r.code, r.detail);
  });
  api.post("/agent-director/start", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { dir?: unknown; restart?: boolean };
    healRootSession();
    if (b.restart && !hasRoot() && hasSession()) spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`], { stdio: "ignore" }); // Not running card: a leftover shell session of the dead director must not block the start
    const r = startDirector(b.dir ?? defaultDirectorDir()); // no folder given (the Start director button on a Not running card): where root last ran
    if (r.ok) return c.json(r);
    const status = r.code === "running" ? 409 : r.code === "bad-dir" ? 400 : 422;
    return problem(c, status, r.code ?? "failed", r.detail ?? "could not start");
  });
}
