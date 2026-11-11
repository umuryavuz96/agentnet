// First-run setup of the director (the root agent). The page shows a "Set up your director" card while no root is live.
// GET reports what is installed and the one command that starts Claude Code as the director; POST starts that command
// in a detached tmux session. The start route is root only (this machine or the root token), see mount.ts isPanelWrite.
// The request body carries one thing, the project folder: it must be an existing absolute directory and is quoted
// for the shell. No command text from a request ever reaches a shell.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Hono } from "hono";
import { HOST, PORT, ROOT } from "../core/config";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { all, flush, forgetByName, live } from "./store";
import { byName, retireAgent } from "./routes";
import { clearDeath, createdOf, findRootSession, hasSession as tmuxHas, healRootSession, killSession, realTmux, rootPid, rootSession, type Tmux } from "./windows";
import { listHooks, readHookLog } from "./hooks";
import { templates } from "./hook-templates";
import { precheck } from "./adopt-scan";
import { answerDialog, clearLaunch, launchView, markLaunch } from "./launch";
import { acceptTrust } from "./claude-trust";

export const REPO = join(import.meta.dir, "..", "..");
/** The director runs in the root agent's tmux session, so Open window on root finds it. */
export const SESSION = rootSession();

export interface Tools { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }
export const tools = (): Tools => ({ bun: !!process.versions.bun, claude: !!Bun.which("claude"), tmux: !!Bun.which("tmux"), python3: !!Bun.which("python3") });

/** POSIX single-quote: safe for any string, newlines included. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How the director session starts. clean: own home, the project attached with --add-dir. adopt: runs in the workspace, its instructions stay, agentnet precedence is appended.
 *  scan: adopt's folder, read-only phase (the plugin gate reads the env). No mode = the plain legacy command, no soul. */
export type DirectorMode = "clean" | "adopt" | "scan";
export interface CommandOpts { mode?: DirectorMode; repo?: string; port?: number; host?: string; resume?: string; promptFile?: string; home?: string; roots?: string[] }

/** First message of the scan session: an interactive claude waits at an empty prompt otherwise (D8). It is the last argument, after every flag, because --add-dir style flags are variadic and would swallow it.
 *  --setting-sources user: the workspace's project and local settings (hooks, MCP approvals) never load, so claude has nothing to ask or to write into the workspace (D6, D9). --strict-mcp-config: project .mcp.json servers are ignored. */
export const SCAN_PROMPT = "Begin the scan.";

/** The command that makes a Claude Code session the director: join as "root", then start claude with the plugin.
 *  AGENTNET_URL goes inside the substitution (a prefix before eval would apply too late for it) and only when the server is not on the default port, so a scratch instance never points at the real one. */
export function directorCommand(dir: string, o: CommandOpts = {}): string {
  const { mode, repo = REPO, port = PORT, host = HOST, resume, promptFile, home = join(ROOT, "director"), roots } = o;
  const url = port === 3096 && host === "127.0.0.1" ? "" : `AGENTNET_URL=${sq(`http://${host}:${port}/api/v1/agentnet`)} `;
  const join_ = (p: string) => `eval "$(${url}${sq(join(repo, "scripts", "agentnet-join.sh"))} root Director ${sq(p)})"`;
  const tail = `claude --plugin-dir "$AGENTNET_MOD"${promptFile ? ` --append-system-prompt-file ${sq(promptFile)}` : ""}`;
  if (mode === "clean") return `cd ${sq(home)} && ${join_(home)} && ${tail}${resume ? ` --resume ${sq(resume)}` : ""} --add-dir ${sq(dir)}`;
  if (mode === "scan") return `cd ${sq(dir)} && export AGENTNET_ADOPT_PHASE=scan AGENTNET_ADOPT_ROOTS=${sq((roots?.length ? roots : [dir]).join(":"))} && ${join_(dir)} && ${tail} --setting-sources user --strict-mcp-config -n scan ${sq(SCAN_PROMPT)}`;
  return `cd ${sq(dir)} && ${join_(dir)} && ${tail}${resume ? ` --resume ${sq(resume)}` : ""}`;
}

const ASSETS = join(REPO, "assets", "director");
const asset = (f: string) => readFileSync(join(ASSETS, f), "utf8").trim();
const HOUSE_RULES = "# House rules\nUse the agentnet tools (send, inbox, report, task_add/task_start/task_done, set_status) for messages, tasks and reports. Keep your task list live. Never contact external services or send secrets anywhere.";
export interface PromptInput { mode: DirectorMode; workspace?: string; repos?: string[]; souls?: string[] }
/** The director's system prompt: base soul, in adopt mode the precedence block, then the house rules. The scan session gets the base soul plus scan.md. */
export function composeDirectorPrompt(i: PromptInput): string {
  if (i.mode === "scan") return `${asset("director.md")}\n\n${asset("scan.md")}\n`;
  const list = (a?: string[]) => (a?.length ? a.join(", ") : "none");
  const prec = i.mode === "adopt" ? "\n\n" + asset("precedence-adopt.md").replace("{{workspace}}", () => i.workspace ?? "").replace("{{repos}}", () => list(i.repos)).replace("{{souls}}", () => list(i.souls)) : "";
  return `${asset("director.md")}${prec}\n\n${HOUSE_RULES}\n`;
}
/** Where the composed prompt lives. Scan and real director never share a file. */
export const promptPath = (mode: DirectorMode, root = ROOT): string => join(root, "run", "souls", mode === "scan" ? "agentnet-director-scan.md" : "agentnet-director.md");
/** Write the prompt (0600, tmp + rename) and return its path. */
export function writeDirectorPrompt(i: PromptInput, root = ROOT): string {
  const p = promptPath(i.mode, root);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, composeDirectorPrompt(i), { mode: 0o600 });
  renameSync(tmp, p);
  return p;
}
/** The clean director's home: a folder holding only a short CLAUDE.md. Never overwrites a CLAUDE.md the user edited. */
const HOME_NOTE = "This folder is the agentnet Director's home. Projects are attached with --add-dir.\n";
export function ensureDirectorHome(root = ROOT): string {
  const h = join(root, "director");
  mkdirSync(h, { recursive: true });
  const f = join(h, "CLAUDE.md");
  if (!existsSync(f)) writeFileSync(f, HOME_NOTE);
  return h;
}

/** The scan session is told apart from a later session of the same name by tmux session_created, kept in this marker. */
export const scanMarkerPath = (root = ROOT): string => join(root, "adopt", "scan-session");
export function writeScanMarker(created: string, root = ROOT): void {
  const p = scanMarkerPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, created + "\n", { mode: 0o600 });
}
/** Kill the scan session only when it is still the one the marker names. Always clears the marker. Returns true when a session was killed. */
export function killScanSession(session: string = SESSION, t: Tmux = realTmux, root = ROOT): boolean {
  const p = scanMarkerPath(root);
  let want = "";
  try { want = readFileSync(p, "utf8").trim(); } catch { return false; }
  try { unlinkSync(p); } catch { /* gone */ }
  if (!want || createdOf(session, t) !== want) return false;
  return killSession(session, t);
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

/** A running director session. A session whose process exited (kept by remain-on-exit) is read, killed and counts as gone. */
export const hasSession = (): boolean => tmuxHas(SESSION);
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
export function startDirector(rawDir: unknown, run: (cmd: string, args: string[]) => { status: number | null; stderr?: string } = (c, a) => { const r = spawnSync(c, a, { encoding: "utf8" }); return { status: r.status, stderr: r.stderr }; }, t: Tools = tools(), exists: () => boolean = hasSession, opts: { resume?: string; hasTranscript?: (dir: string, session: string) => boolean; mode?: DirectorMode; root?: string; repos?: string[]; souls?: string[]; roots?: string[] } = {}): StartResult {
  if (!t.tmux) return { ok: false, code: "no-tmux", detail: "tmux is not installed. Copy the command and run it in a terminal." };
  if (!t.claude) return { ok: false, code: "no-claude", detail: "Claude Code (claude) is not installed. Install it, then copy the command." };
  const d = checkDir(rawDir);
  if ("error" in d) return { ok: false, code: "bad-dir", detail: d.error };
  if (exists()) { const detail = `A director session (${SESSION}) is already running. Use Reset director on the Agents page to stop it, then start again.`; markLaunch(SESSION, Date.now(), detail); return { ok: false, code: "running", detail }; }
  let resume: string | undefined, why: string | undefined;
  if (opts.resume) {
    if (!SESSION_ID.test(opts.resume)) why = "The last session id is not valid.";
    else if (!(opts.hasTranscript ?? ((dir, id) => existsSync(transcriptPath(dir, id))))(d.dir, opts.resume)) why = "The last conversation file was not found.";
    else resume = opts.resume;
  }
  const mode = opts.mode, root = opts.root ?? ROOT;
  let cmd: string, cwd = d.dir;
  if (!mode) cmd = directorCommand(d.dir, { resume });
  else {
    const promptFile = writeDirectorPrompt({ mode, workspace: d.dir, repos: opts.repos, souls: opts.souls }, root);
    const home = mode === "clean" ? ensureDirectorHome(root) : undefined;
    if (home) cwd = home;
    cmd = directorCommand(d.dir, { mode, resume, promptFile, roots: opts.roots, ...(home ? { home } : {}) });
  }
  if (process.env.AGENTNET_NO_DIRECTOR_START) return { ok: true, session: SESSION, attach: `tmux attach -t ${SESSION}` }; // scratch and screenshot runs: validate, write the prompt, never spawn
  clearDeath(SESSION);
  // Claude Code asks "do you trust this folder" once per folder. Answer it ahead of time for the folder we start in (merge, with a backup); the pane watcher is the fallback.
  const trusted = [...new Set([cwd, d.dir])];
  const tr = acceptTrust([cwd]);
  if (tr.error) logEvent("warn", "trust not pre-accepted", { error: tr.error });
  // remain-on-exit for this session only (never -g): when claude exits the pane stays, so the server can read why (windows.ts reapDead)
  const r = run("tmux", ["new-session", "-d", "-s", SESSION, "-c", cwd, "sh", "-c", cmd, ";", "set-option", "-t", `=${SESSION}:`, "remain-on-exit", "on"]);
  if (r.status !== 0) { const detail = (r.stderr ?? "").trim() || "tmux could not start the session."; markLaunch(SESSION, Date.now(), detail); return { ok: false, code: "failed", detail }; }
  markLaunch(SESSION, Date.now(), undefined, trusted);
  logEvent("info", "director started", { session: SESSION, dir: d.dir, mode: mode ?? "plain", resumed: !!resume });
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
  /** First-run state: forget everything setup left behind (adopt state, launch mark, prompt files). Returns what it cleared, for the log. */
  clean?: () => string[] | Promise<string[]>;
}
/** Remove what a director setup wrote under the agentnet home, so the next setup is a first run. Never touches a project folder, ~/.claude, or a CLAUDE.md the user edited. */
export function cleanDirectorFiles(root = ROOT): string[] {
  const out: string[] = [];
  clearLaunch(); clearDeath(SESSION);
  for (const f of [promptPath("adopt", root), promptPath("scan", root), scanMarkerPath(root)]) { try { if (existsSync(f)) { unlinkSync(f); out.push(f); } } catch { /* gone */ } }
  const note = join(root, "director", "CLAUDE.md");
  try { if (readFileSync(note, "utf8") === HOME_NOTE) { unlinkSync(note); out.push(note); } rmdirSync(join(root, "director")); } catch { /* edited, missing or not empty: leave it */ }
  return out;
}
const realReset: ResetDeps = {
  pid: rootPid, session: (pid) => { const s = findRootSession(realTmux, pid && alive(pid) ? pid : null); return s && tmuxHas(s) ? s : null; },
  killSession: (s) => killSession(s), signal: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } },
  gone: async (pid) => { for (let i = 0; i < 30; i++) { if (!alive(pid)) return true; await Bun.sleep(100); } return false; },
  backup: (line) => { const dir = join(ROOT, "data"); mkdirSync(dir, { recursive: true }); appendFileSync(join(dir, "director-resets.jsonl"), line + "\n"); },
  forget: () => { const a = byName("root"); if (a) retireAgent(a, "reset"); flush(); return forgetByName("root"); },
  clean: async () => [...(await import("./adopt")).resetAdopt(), ...cleanDirectorFiles()], // adopt.ts imports this file: load it lazily
};
/** Reset the director: stop it if it runs, back up root's row, forget root so the first-run setup shows again.
 *  Never touches other agents, teams, tasks, transcripts or ~/.claude. */
export async function resetDirector(d: ResetDeps = realReset, now = Date.now()): Promise<{ ok: boolean; stopped: boolean; detail?: string; cleaned?: string[] }> {
  const pid = d.pid(); let stopped = false;
  if (pid) {
    const s = d.session(pid);
    if (s) { d.killSession(s); stopped = true; }
    else if (pid > 1) { d.signal(pid); stopped = true; }
    if (stopped && pid > 1 && !(await d.gone(pid))) return { ok: false, stopped, detail: "The director did not stop. Close it in its own terminal, then try again." };
  }
  const rows = d.forget();
  d.backup(JSON.stringify({ at: new Date(now).toISOString(), rows }));
  const cleaned = (await d.clean?.()) ?? [];
  logEvent("info", "director reset", { stopped, rows: rows.length, cleaned });
  return { ok: true, stopped, ...(cleaned.length ? { cleaned } : {}) };
}

export function directorRoutes(api: Hono<Env>): void {
  api.post("/agent-director/answer", async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { option?: unknown };
    if (typeof b.option !== "string" || !/^[a-z-]{1,16}$/.test(b.option)) return problem(c, 400, "Bad Request", "option is required");
    const r = answerDialog(b.option);
    return r.ok ? c.json({ ok: true, kind: r.kind }) : problem(c, 409, "Conflict", r.reason);
  });
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
    return c.json({ home, dir, dirError: "error" in d ? d.error : null, tools: tools(), root: hasRoot(), hadRoot: all().some((a) => a.name === "root"), last: lastDirector(), triage: triageNow(), session: hasSession(), sessionName: SESSION, command: directorCommand(dir), precheck: precheck(dir), launch: launchView() });
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
