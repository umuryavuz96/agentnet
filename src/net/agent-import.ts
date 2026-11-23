// Step 4: import the owner's Claude Code setup into agentnet's own folder (docs/internal/one-folder/SPEC-step4-import.md).
// scan -> proposal items -> decide -> preview (a closed op list) -> apply -> rollback. Sources (~/.claude, ~/.claude.json, the project)
// are only read, never edited: everything accepted is copied into $AGENTNET_HOME/claude/base, and .complete is written last.
// Accepted agents and teams become standing staff, started through the normal spawn path (spawn-agent.sh).
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HOST, PORT, ROOT } from "../core/config";
import { db } from "../core/db";
import { problem, type Env } from "../core/http";
import { logEvent } from "../core/logger";
import { assertInHome } from "../core/paths";
import { capFor, denyReason, redactText, sha256File, sha256Text, writeAtomic } from "./adopt-safe";
import { findRepos, frontMatter } from "./adopt-scan";
import { unifiedDiff } from "./adopt-plan";
import type { AdoptReport } from "./adopt-report";
import { accountFile, DEFAULT_ACCOUNT } from "./accounts";
import { MODELS } from "./routing";
import { emit, flush, get, live } from "./store";
import { byName, killAgent, retireAgent, type AgentRow } from "./routes";
import { archiveTeam, createTeam, getTeam, teamsOf } from "./teams";
import { registerSouls, removeSouls, wsDir } from "./workspace";

// ---------- items ----------
export type ItemKind = "instruction" | "rule" | "skill" | "agent-def" | "command" | "hook" | "settings-env" | "mcp" | "plugin" | "agent" | "team";
export interface AgentEdits { name?: string; model?: string | null; boss?: string | null; team?: string | null; director?: boolean }
export interface TeamEdits { name?: string; lead?: string | null; members?: string[] }
export interface Item {
  id: string; kind: ItemKind; source: string; /** relative to $AGENTNET_HOME; "" when nothing is copied */ target: string;
  summary: string; reason: string; accept: boolean; badges: string[]; edits?: AgentEdits & TeamEdits;
  /** agents and teams: standing staff */ standing?: 1;
  /** where the data sits in the source, never the value: hook position, env key, MCP server name, agent def file */
  at?: { event?: string; group?: number; hook?: number; key?: string; server?: string; file?: string; script?: string; session?: string };
}
export const BADGE = { outside: "runs a script outside the folder", secret: "holds a secret", project: "project", manual: "manual" } as const;
const SECRET_KEY = /TOKEN|KEY|SECRET|PASSWORD/i;
const NAME_RE = /^[a-z0-9-]{1,32}$/;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
const baseRel = (...p: string[]) => join("claude", "base", ...p);

export interface CollectOpts {
  llm?: boolean;
  /** the director's validated report: only read when llm is on */
  report?: AdoptReport | null;
  /** `tmux list-panes -a -F '#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_start_command}'` */
  tmux?: () => string;
  onRead?: (path: string) => void;
}

/** Read a text file only when the path policy allows it (adopt-safe.denyReason), else null. */
function readOk(path: string, roots: string[], onRead?: (p: string) => void): string | null {
  if (denyReason(path, roots)) return null;
  try { const st = statSync(path); if (!st.isFile() || st.size > capFor(path)) return null; onRead?.(path); return readFileSync(path, "utf8"); } catch { return null; }
}
const readJsonOk = (path: string, roots: string[], onRead?: (p: string) => void): Obj | null => { const t = readOk(path, roots, onRead); if (t === null) return null; try { const j = JSON.parse(t); return isObj(j) ? j : null; } catch { return null; } };
const files = (d: string, test: (n: string) => boolean): string[] => { try { return readdirSync(d).filter((n) => { try { return test(n) && lstatSync(join(d, n)).isFile(); } catch { return false; } }).sort(); } catch { return []; } };
const dirs = (d: string): string[] => { try { return readdirSync(d).filter((n) => { try { return lstatSync(join(d, n)).isDirectory(); } catch { return false; } }).sort(); } catch { return []; } };

/** The one script a hook command runs from ~/.claude/hooks, or null. Tokens are split on spaces, quotes stripped, ~ and $HOME expanded. */
export function hookScript(command: string, home: string): string | null {
  const dir = join(home, ".claude", "hooks"), hits = new Set<string>();
  for (const raw of command.split(/\s+/)) {
    const tok = raw.replace(/^["']|["';]$/g, "").replace(/^(~|\$HOME|\$\{HOME\})(?=\/)/, home);
    if (!isAbsolute(tok)) continue;
    const p = resolve(tok);
    if (dirname(p) === dir) { try { if (statSync(p).isFile()) hits.add(p); } catch { /* missing */ } }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}
/** The command with the script path swapped for its copy in the base (every spelling of the path in the command). */
export function rewriteCommand(command: string, script: string, home: string, root: string): string {
  const to = join(root, baseRel("hooks", basename(script))), rel = script.slice(home.length);
  return command.split(/(\s+)/).map((t) => { const b = t.replace(/^["']|["';]$/g, ""); return [script, "~" + rel, "$HOME" + rel, "${HOME}" + rel].includes(b) ? t.replace(b, to) : t; }).join("");
}

/** Every source in ~/.claude, ~/.claude.json and the chosen project as one item each, with target, default and badges. No LLM unless o.llm. */
export function collectImport(home: string, projectDir?: string | null, o: CollectOpts = {}): Item[] {
  const cd = join(home, ".claude"), cj = join(home, ".claude.json"), project = projectDir ? resolve(projectDir) : null;
  const roots = [cd, cj, ...(project ? [project] : [])], out: Item[] = [], rd = o.onRead;
  const add = (i: Item) => out.push(i);
  if (readOk(join(cd, "CLAUDE.md"), roots, rd) !== null) add({ id: "instruction:CLAUDE.md", kind: "instruction", source: join(cd, "CLAUDE.md"), target: baseRel("CLAUDE.md"), summary: "Your global CLAUDE.md", reason: "the base every agent reads", accept: true, badges: [] });
  for (const [sub, kind, label] of [["rules", "rule", "Rule"], ["agents", "agent-def", "Agent definition"], ["commands", "command", "Command"]] as const)
    for (const n of files(join(cd, sub), (x) => x.endsWith(".md"))) { const p = join(cd, sub, n); if (denyReason(p, roots)) continue; add({ id: `${kind}:${n}`, kind, source: p, target: baseRel(sub, n), summary: `${label} ${n}`, reason: `copied to the base ${sub} folder`, accept: true, badges: [] }); }
  for (const n of dirs(join(cd, "skills"))) { const p = join(cd, "skills", n); if (denyReason(p, roots)) continue; add({ id: `skill:${n}`, kind: "skill", source: p, target: baseRel("skills", n), summary: `Skill ${n}`, reason: "copied to the base skills folder", accept: true, badges: [] }); }

  const sf = join(cd, "settings.json"), s = readJsonOk(sf, roots, rd);
  if (s) {
    if (isObj(s.hooks)) for (const [event, groups] of Object.entries(s.hooks)) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((g, gi) => { if (isObj(g) && Array.isArray(g.hooks)) g.hooks.forEach((h, hi) => {
        if (!isObj(h) || typeof h.command !== "string") return;
        const script = hookScript(h.command, home), m = typeof g.matcher === "string" && g.matcher ? ` (${g.matcher})` : "";
        add({ id: `hook:${event}:${gi}:${hi}`, kind: "hook", source: sf, target: baseRel("settings.json"), summary: `${event}${m}: ${redactText(h.command).slice(0, 160)}`,
          reason: script ? `the script is copied to the base hooks folder and the command points at the copy` : "the command keeps its path: agentnet may read and run outside its folder, never write",
          accept: true, badges: script ? [] : [BADGE.outside], at: { event, group: gi, hook: hi, ...(script ? { script } : {}) } });
      }); });
    }
    if (isObj(s.env)) for (const k of Object.keys(s.env)) {
      const secret = SECRET_KEY.test(k);
      add({ id: `env:${k}`, kind: "settings-env", source: sf, target: baseRel("settings.json"), summary: `Setting env ${k} (value hidden)`, reason: secret ? "looks like a secret: off by default, keep secrets in an account" : "copied to the base settings", accept: !secret, badges: secret ? [BADGE.secret] : [], at: { key: k } });
    }
    const other = Object.keys(s).filter((k) => k !== "hooks" && k !== "env");
    if (other.length) add({ id: "settings:keys", kind: "settings-env", source: sf, target: baseRel("settings.json"), summary: `Other settings: ${other.join(", ")}`, reason: "copied to the base settings", accept: true, badges: [] });
  }

  const cjj = readJsonOk(cj, roots, rd);
  if (cjj && isObj(cjj.mcpServers)) for (const [n, v] of Object.entries(cjj.mcpServers)) add({ id: `mcp:${n}`, kind: "mcp", source: cj, target: baseRel("mcp.json"), summary: `MCP server ${n}: ${mcpWhat(v)}`, reason: "user MCP server, copied to the base mcp.json", accept: true, badges: [], at: { server: n } });
  if (project) {
    const pm = readJsonOk(join(project, ".mcp.json"), roots, rd);
    if (pm && isObj(pm.mcpServers)) for (const [n, v] of Object.entries(pm.mcpServers)) add({ id: `mcp-project:${n}`, kind: "mcp", source: join(project, ".mcp.json"), target: baseRel("mcp.json"), summary: `Project MCP server ${n}: ${mcpWhat(v)}`, reason: "the project keeps its own .mcp.json", accept: false, badges: [BADGE.project], at: { server: n } });
  }
  const pj = readJsonOk(join(cd, "plugins", "installed_plugins.json"), roots, rd);
  if (pj) { const ps = isObj(pj.plugins) ? pj.plugins : pj; for (const n of Object.keys(ps).filter((k) => k !== "version")) add({ id: `plugin:${n}`, kind: "plugin", source: join(cd, "plugins", "installed_plugins.json"), target: "", summary: `Plugin ${n}: install again from the panel`, reason: "plugins are not copied in this step", accept: false, badges: [BADGE.manual] }); }

  // agents and teams: deterministic (project agent definitions, tmux sessions running claude), then the director's findings when llm is on
  const names = new Set<string>();
  const agent = (name: string, i: Omit<Item, "id" | "kind" | "target" | "accept" | "standing" | "edits">, e: AgentEdits = {}) => {
    const n = slug(name); if (!n || names.has(n)) return; names.add(n);
    add({ id: `agent:${n}`, kind: "agent", target: join("agents", n, "staff.json"), accept: true, standing: 1, edits: { name: n, model: e.model ?? null, boss: e.boss ?? "root", team: e.team ?? null, ...(e.director ? { director: true } : {}) }, ...i });
  };
  if (project) for (const repo of findRepos(project)) for (const n of files(join(repo, ".claude", "agents"), (x) => x.endsWith(".md"))) {
    const p = join(repo, ".claude", "agents", n), t = readOk(p, roots, rd); if (t === null) continue;
    const fm = frontMatter(t), model = fm.model && MODELS.includes(fm.model) ? fm.model : null;
    agent(fm.name || n.replace(/\.md$/, ""), { source: p, summary: `Agent ${fm.name || n} from ${basename(repo)}${fm.description ? `: ${redactText(fm.description).slice(0, 120)}` : ""}`, reason: "an agent definition in the project: it becomes a soul and a standing agent", badges: [], at: { file: p } }, { model });
  }
  try {
    for (const ln of (o.tmux ?? defaultTmux)().split("\n")) {
      const [session = "", cmd = "", , start = ""] = ln.split("\t");
      if (!session || session.startsWith("agentnet-") || !/\bclaude\b/.test(`${cmd} ${start}`)) continue;
      agent(session, { source: `tmux:${session}`, summary: `Claude session ${session} running in tmux`, reason: "a Claude Code session that runs today: it becomes a standing agent", badges: [], at: { session } });
    }
  } catch { /* no tmux */ }
  if (o.llm && o.report) for (const f of o.report.findings) {
    if (f.kind === "coordination-system" && f.agents.length >= 2) {
      const n = slug(f.title), members = f.agents.map(slug).filter(Boolean);
      if (n && !out.some((x) => x.id === `team:${n}`)) add({ id: `team:${n}`, kind: "team", source: `finding:${f.id}`, target: "", summary: `Team ${f.title}: ${members.join(", ")}`, reason: redactText(f.about).slice(0, 300), accept: true, standing: 1, badges: [], edits: { name: n, lead: members[0] ?? null, members } });
      for (const m of members) agent(m, { source: `finding:${f.id}`, summary: `Agent ${m} from the director's scan`, reason: redactText(f.about).slice(0, 300), badges: [] }, { team: n, boss: m === members[0] ? "root" : members[0] });
    } else if (f.kind === "agent-definitions" || f.kind === "identity-claim") for (const m of f.agents) agent(m, { source: `finding:${f.id}`, summary: `Agent ${m} from the director's scan`, reason: redactText(f.about).slice(0, 300), badges: [] }, { director: f.kind === "identity-claim" });
  }
  return out;
}
const mcpWhat = (v: unknown) => (isObj(v) ? redactText(String(v.url ?? v.command ?? v.type ?? "")).slice(0, 80) : "");
const defaultTmux = () => { const env = { ...process.env }; delete env.TMUX; const p = Bun.spawnSync(["tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_start_command}"], { env, stdout: "pipe", stderr: "pipe" }); if (p.exitCode !== 0) throw new Error("no tmux"); return p.stdout.toString(); };

// ---------- run state ----------
export type RunPhase = "proposed" | "previewed" | "applying" | "applied" | "failed" | "rolledback" | "cancelled";
export interface Decision { accept: boolean; edits?: AgentEdits & TeamEdits }
export interface AgentDef { name: string; model: string | null; boss: string; team: string | null; director: boolean; project: string; job: string; goal: string; soul: string | null; account: string | null; standing: true }
export type ImportOp = { id: string; item: string | null; status?: "ok" | "failed" | "skipped"; error?: string } & (
  | { op: "copy-file"; source: string; target: string; sha: string; size: number }
  | { op: "copy-dir"; source: string; target: string; files: { rel: string; sha: string; size: number }[] }
  | { op: "rewrite-hook-path"; source: string; target: string; sha: string; size: number; from: string; to: string; diff: string }
  | { op: "register-soul"; name: string; repo: string; defFile: string; sha: string }
  | { op: "write-base-settings" | "write-base-mcp"; target: string; beforeSha: string | null; afterSha: string; diff: string; conflicts: string[]; sources: { file: string; sha: string }[] }
  | { op: "mark-complete"; target: string }
  | { op: "create-team"; team: { id: string; name: string; lead: string | null; members: string[]; goal: string } }
  | { op: "create-agent"; target: string; agent: AgentDef }
  | { op: "start-agent"; name: string });
export const OPS = ["copy-file", "copy-dir", "rewrite-hook-path", "register-soul", "write-base-settings", "write-base-mcp", "create-agent", "create-team", "start-agent", "mark-complete"] as const;
export interface ImportPlan { planId: string; runId: string; ops: ImportOp[]; files: { target: string; size: number }[]; warnings: string[] }
export interface ManifestFile { target: string; beforeSha: string | null; afterSha: string; backup: string | null }
export interface ImportManifest { runId: string; files: ManifestFile[]; dirs: string[]; agents: { name: string; id: string }[]; teams: string[]; souls: boolean; complete: boolean }
export interface Run {
  runId: string; phase: RunPhase; home: string; project: string | null; llm: boolean; createdAt: number;
  items: Item[]; decisions: Record<string, Decision>; plan?: ImportPlan; manifest?: ImportManifest; error?: string; errors?: string[];
}
export interface Progress { type: "import.progress"; runId: string; phase: string; op?: string; opId?: string; target?: string; status?: string; detail?: string; at: number }

const runDir = (root: string, runId: string) => join(root, "import", runId);
const saveRun = (root: string, r: Run) => { const d = runDir(root, r.runId); mkdirSync(d, { recursive: true, mode: 0o700 }); writeAtomic(join(d, "run.json"), JSON.stringify(r, null, 2) + "\n", 0o600); };
let cur: Run | null = null;
const listeners = new Set<(p: Progress) => void>();
/** Subscribe to import.progress events (SSE route, tests). Returns the unsubscribe function. */
export const onProgress = (f: (p: Progress) => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const log: Progress[] = [];
function progress(p: Omit<Progress, "type" | "at">) {
  const e: Progress = { type: "import.progress", at: Date.now(), ...p };
  log.push(e); if (log.length > 300) log.shift();
  for (const f of listeners) { try { f(e); } catch { /* listener gone */ } }
}
export const recentProgress = (runId?: string) => log.filter((p) => !runId || p.runId === runId);
export const OPEN: RunPhase[] = ["proposed", "previewed", "applying"];
export const currentRun = (): Run | null => cur;
/** Tests: forget the in-memory run. */
export const _resetImport = () => { cur = null; log.length = 0; };

/** Test seams: the spawn path, the tmux check and the kill a rollback uses. Production never replaces them. */
export const importSeams = {
  spawn: async (d: AgentDef): Promise<{ ok: boolean; error?: string }> => {
    const host = HOST === "0.0.0.0" ? "127.0.0.1" : HOST, repo = join(import.meta.dir, "..", "..");
    const args = ["spawn", d.name, "--standing", "--no-wait", "--project", d.project, "--job", d.job, "--goal", d.goal, "--boss", d.boss,
      ...(d.model ? ["--model", d.model] : []), ...(d.team ? ["--team", d.team] : []), ...(d.soul ? ["--soul", d.soul] : []), ...(d.account ? ["--account", d.account] : [])];
    const p = Bun.spawn([process.execPath, "run", join(repo, "src", "cli.ts"), ...args], { env: { ...process.env, AGENTNET_ROOT_TOKEN_FILE: join(ROOT, "run", "root.token"), AGENTNET_URL: `http://${host}:${PORT}/api/v1/agentnet` }, stdout: "pipe", stderr: "pipe" });
    const [err, code] = [await new Response(p.stderr).text(), await p.exited];
    return code === 0 ? { ok: true } : { ok: false, error: redactText(err.trim().split("\n").slice(-2).join(" ")).slice(0, 300) || `exit ${code}` };
  },
  hasSession: (s: string): boolean => Bun.spawnSync(["tmux", "has-session", "-t", `=${s}`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0,
  kill: (pid: number | null, placement: string | null, name?: string) => killAgent(pid, placement, name),
};

export interface ScanOpts extends CollectOpts { home?: string; root?: string; dir?: string | null }
export function startScan(o: ScanOpts = {}): { ok: true; runId: string; items: number } | { ok: false; status: 409 | 422; error: string } {
  if (cur && OPEN.includes(cur.phase)) return { ok: false, status: 409, error: `import run ${cur.runId} is open (${cur.phase}): apply, roll back or cancel it first` };
  const home = o.home ?? process.env.HOME ?? homedir(), root = o.root ?? ROOT;
  if (o.dir) { try { if (!statSync(o.dir).isDirectory()) throw new Error(); } catch { return { ok: false, status: 422, error: "dir is not a folder" }; } }
  const runId = `imp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  progress({ runId, phase: "scan", status: "started" });
  const items = collectImport(home, o.dir ?? null, o);
  cur = { runId, phase: "proposed", home, project: o.dir ? resolve(o.dir) : null, llm: !!o.llm, createdAt: Date.now(), items, decisions: {} };
  saveRun(root, cur);
  progress({ runId, phase: "scan", status: "done", detail: `${items.length} items` });
  logEvent("info", "import scan", { runId, items: items.length, llm: !!o.llm });
  return { ok: true, runId, items: items.length };
}
export function cancelRun(root = ROOT): { ok: boolean; error?: string } {
  if (!cur || !["proposed", "previewed"].includes(cur.phase)) return { ok: false, error: "no open run to cancel" };
  cur.phase = "cancelled"; saveRun(root, cur); progress({ runId: cur.runId, phase: "cancel", status: "done" });
  return { ok: true };
}

// ---------- decide ----------
const itemOn = (r: Run, i: Item) => r.decisions[i.id]?.accept ?? i.accept;
const edited = (r: Run, i: Item) => ({ ...(i.edits ?? {}), ...(r.decisions[i.id]?.edits ?? {}) });
export function decide(input: unknown, root = ROOT): { ok: true; decided: number } | { ok: false; status: 409 | 422; errors: string[] } {
  const r = cur; if (!r || !["proposed", "previewed"].includes(r.phase)) return { ok: false, status: 409, errors: ["no open run to decide on: scan first"] };
  const list = isObj(input) && Array.isArray(input.items) ? input.items : null;
  if (!list) return { ok: false, status: 422, errors: ["items is required"] };
  const errors: string[] = [], next: Record<string, Decision> = { ...r.decisions };
  for (const [k, d] of list.entries()) {
    if (!isObj(d) || typeof d.id !== "string" || typeof d.accept !== "boolean") { errors.push(`items[${k}]: id and accept are required`); continue; }
    const it = r.items.find((x) => x.id === d.id); if (!it) { errors.push(`items[${k}]: no such item ${d.id}`); continue; }
    const e = isObj(d.edits) ? d.edits : undefined;
    if (e && it.kind !== "agent" && it.kind !== "team") { errors.push(`${d.id}: only agents and teams take edits`); continue; }
    const ed: AgentEdits & TeamEdits = {};
    if (e) {
      if (e.name !== undefined) ed.name = String(e.name);
      if (e.model !== undefined) ed.model = e.model === null ? null : String(e.model);
      if (e.boss !== undefined) ed.boss = e.boss === null ? null : String(e.boss);
      if (e.team !== undefined) ed.team = e.team === null ? null : String(e.team);
      if (e.lead !== undefined) ed.lead = e.lead === null ? null : String(e.lead);
      if (Array.isArray(e.members)) ed.members = e.members.map(String);
      if (typeof e.director === "boolean") ed.director = e.director;
    }
    next[d.id] = { accept: d.accept, ...(e ? { edits: ed } : {}) };
  }
  if (!errors.length) errors.push(...validateStaff({ ...r, decisions: next }));
  if (errors.length) return { ok: false, status: 422, errors };
  r.decisions = next; if (r.phase === "previewed") { r.phase = "proposed"; delete r.plan; }
  saveRun(root, r);
  return { ok: true, decided: list.length };
}
/** Names match [a-z0-9-]{1,32} and are unique against live agents and the import; models are known; a boss exists or is imported. */
function validateStaff(r: Run): string[] {
  const errs: string[] = [], agents = r.items.filter((i) => i.kind === "agent" && itemOn(r, i)), teams = r.items.filter((i) => i.kind === "team" && itemOn(r, i));
  const names = agents.map((a) => edited(r, a).name ?? ""), liveNames = new Set(live().map((s) => s.name)), teamNames = new Set(teams.map((t) => edited(r, t).name ?? ""));
  names.forEach((n, k) => {
    const id = agents[k]!.id, e = edited(r, agents[k]!);
    if (!NAME_RE.test(n)) errors(id, `name must match [a-z0-9-]{1,32}`);
    else if (names.indexOf(n) !== k) errors(id, `name ${n} is used twice in the import`);
    else if (liveNames.has(n)) errors(id, `name ${n} is a live agent already`);
    if (e.model && !MODELS.includes(e.model)) errors(id, `model must be one of ${MODELS.join(", ")}`);
    if (e.boss && e.boss !== "root" && !names.includes(e.boss) && !byName(e.boss)) errors(id, `boss ${e.boss} is neither a live agent nor in the import`);
    if (e.boss === n) errors(id, "an agent cannot be its own boss");
    if (e.team && !teamNames.has(e.team) && !getTeam(e.team)) errors(id, `team ${e.team} is neither an existing team nor in the import`);
  });
  for (const t of teams) { const e = edited(r, t); if (!e.name || !NAME_RE.test(e.name)) errors(t.id, "team name must match [a-z0-9-]{1,32}"); if (e.lead && !names.includes(e.lead) && !byName(e.lead)) errors(t.id, `lead ${e.lead} is neither a live agent nor in the import`); }
  return errs;
  function errors(id: string, m: string) { errs.push(`${id}: ${m}`); }
}

// ---------- preview ----------
const abs = (root: string, rel: string) => join(root, rel);
const shaOrNull = (f: string) => { try { return existsSync(f) ? sha256File(f) : null; } catch { return null; } };
const readJson = (f: string): Obj => { try { const j = JSON.parse(readFileSync(f, "utf8")); return isObj(j) ? j : {}; } catch { return {}; } };
/** env and header values (and secret-looking keys) blanked: what a diff may show. */
const mask = (v: unknown, key = ""): unknown => {
  if (Array.isArray(v)) return v.map((x) => mask(x));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(env|headers)$/i.test(k) && isObj(x) ? Object.fromEntries(Object.keys(x).map((e) => [e, "***"])) : mask(x, k)]));
  return SECRET_KEY.test(key) && typeof v === "string" ? "***" : v;
};
const dump = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Merge { text: string; diff: string; conflicts: string[]; sources: { file: string; sha: string }[]; beforeSha: string | null }
/** claude/base/settings.json after the import: what is there now (the Hooks page writes it), plus the accepted hooks, env and other keys.
 *  A key both sides set takes the import's value and is listed as a conflict. Hooks are added per event; an identical command is not added twice. */
function mergeSettings(r: Run, root: string): Merge | null {
  const on = r.items.filter((i) => itemOn(r, i) && (i.kind === "hook" || i.kind === "settings-env"));
  if (!on.length) return null;
  const src = on[0]!.source, s = readJson(src), target = abs(root, baseRel("settings.json")), before = existsSync(target) ? readJson(target) : null;
  const out = structuredClone(before ?? {}) as Obj, conflicts: string[] = [];
  for (const i of on) {
    if (i.kind === "hook") {
      const g = (isObj(s.hooks) ? (s.hooks as Obj)[i.at!.event!] : null) as Obj[] | null, grp = g?.[i.at!.group!], h = isObj(grp) && Array.isArray(grp.hooks) ? grp.hooks[i.at!.hook!] : null;
      if (!isObj(h) || typeof h.command !== "string") throw new Error(`${i.id}: the hook is gone from ${src}`);
      const cmd = i.at!.script ? rewriteCommand(h.command, i.at!.script, r.home, root) : h.command, matcher = isObj(grp) && typeof grp.matcher === "string" ? grp.matcher : undefined;
      const hooks = (isObj(out.hooks) ? out.hooks : (out.hooks = {})) as Obj, list = (Array.isArray(hooks[i.at!.event!]) ? hooks[i.at!.event!] : (hooks[i.at!.event!] = [])) as Obj[];
      if (list.some((x) => isObj(x) && Array.isArray(x.hooks) && x.hooks.some((y) => isObj(y) && y.command === cmd))) continue;
      let tg = list.find((x) => isObj(x) && (x.matcher ?? undefined) === matcher && Array.isArray(x.hooks));
      if (!tg) { tg = { ...(matcher !== undefined ? { matcher } : {}), hooks: [] }; list.push(tg); }
      (tg.hooks as unknown[]).push({ ...h, command: cmd });
    } else if (i.at?.key) {
      const k = i.at.key, v = isObj(s.env) ? (s.env as Obj)[k] : undefined;
      if (v === undefined) throw new Error(`${i.id}: the env key is gone from ${src}`);
      const env = (isObj(out.env) ? out.env : (out.env = {})) as Obj;
      if (k in env && !same(env[k], v)) conflicts.push(`env.${k}`);
      env[k] = v;
    } else for (const [k, v] of Object.entries(s)) {
      if (k === "hooks" || k === "env") continue;
      if (before && k in before && !same(before[k], v)) conflicts.push(k);
      out[k] = structuredClone(v);
    }
  }
  return { text: dump(out), diff: unifiedDiff(before ? dump(mask(before)) : "", dump(mask(out)), "a/claude/base/settings.json", "b/claude/base/settings.json"), conflicts, sources: [{ file: src, sha: sha256File(src) }], beforeSha: shaOrNull(target) };
}
function mergeMcp(r: Run, root: string): Merge | null {
  const on = r.items.filter((i) => itemOn(r, i) && i.kind === "mcp");
  if (!on.length) return null;
  const target = abs(root, baseRel("mcp.json")), before = existsSync(target) ? readJson(target) : null, out = structuredClone(before ?? {}) as Obj, conflicts: string[] = [];
  const servers = (isObj(out.mcpServers) ? out.mcpServers : (out.mcpServers = {})) as Obj, srcs = new Map<string, string>();
  for (const i of on) {
    const j = readJson(i.source), v = isObj(j.mcpServers) ? (j.mcpServers as Obj)[i.at!.server!] : undefined;
    if (v === undefined) throw new Error(`${i.id}: the server is gone from ${i.source}`);
    if (i.at!.server! in servers && !same(servers[i.at!.server!], v)) conflicts.push(`mcpServers.${i.at!.server}`);
    servers[i.at!.server!] = structuredClone(v); srcs.set(i.source, sha256File(i.source));
  }
  return { text: dump(out), diff: unifiedDiff(before ? dump(mask(before)) : "", dump(mask(out)), "a/claude/base/mcp.json", "b/claude/base/mcp.json"), conflicts, sources: [...srcs].map(([file, sha]) => ({ file, sha })), beforeSha: shaOrNull(target) };
}
const treeFiles = (d: string, base = d): string[] => { const out: string[] = []; for (const n of readdirSync(d).sort()) { const p = join(d, n), st = lstatSync(p); if (st.isDirectory()) out.push(...treeFiles(p, base)); else if (st.isFile()) out.push(relative(base, p)); } return out; };
export const importPlanId = (p: Pick<ImportPlan, "runId" | "ops">) => "iplan-" + sha256Text(JSON.stringify({ runId: p.runId, ops: p.ops.map(({ status: _s, error: _e, ...o }) => ("diff" in o ? { ...o, diff: undefined } : o)) })).slice(0, 16);

/** The closed op list for the accepted items: file ops, then .complete, then teams and agents (director, leads, members). No side effects. */
export function buildImportPlan(r: Run, root = ROOT): { ok: true; plan: ImportPlan } | { ok: false; errors: string[] } {
  const ops: ImportOp[] = [], warnings: string[] = [], errors: string[] = [], roots = [join(r.home, ".claude"), join(r.home, ".claude.json"), ...(r.project ? [r.project] : [])];
  let n = 0; const id = () => `o${++n}`;
  for (const i of r.items) {
    if (!itemOn(r, i)) continue;
    if (i.kind === "instruction" || i.kind === "rule" || i.kind === "agent-def" || i.kind === "command") {
      if (denyReason(i.source, roots)) { errors.push(`${i.id}: ${i.source} may not be read`); continue; }
      ops.push({ id: id(), item: i.id, op: "copy-file", source: i.source, target: i.target, sha: sha256File(i.source), size: statSync(i.source).size });
    } else if (i.kind === "skill") {
      const fl = treeFiles(i.source).filter((f) => !denyReason(join(i.source, f), roots));
      ops.push({ id: id(), item: i.id, op: "copy-dir", source: i.source, target: i.target, files: fl.map((f) => ({ rel: f, sha: sha256File(join(i.source, f)), size: statSync(join(i.source, f)).size })) });
    } else if (i.kind === "hook" && i.at?.script) {
      const s = readJson(i.source), g = ((s.hooks as Obj)[i.at.event!] as Obj[])[i.at.group!]!, cmd = String((g.hooks as Obj[])[i.at.hook!]!.command), to = rewriteCommand(cmd, i.at.script, r.home, root);
      const target = baseRel("hooks", basename(i.at.script));
      if (!ops.some((o) => o.op === "rewrite-hook-path" && o.target === target)) ops.push({ id: id(), item: i.id, op: "rewrite-hook-path", source: i.at.script, target, sha: sha256File(i.at.script), size: statSync(i.at.script).size, from: redactText(cmd), to: redactText(to), diff: unifiedDiff(redactText(cmd) + "\n", redactText(to) + "\n", `a/${i.id}`, `b/${i.id}`) });
    }
  }
  try {
    const s = mergeSettings(r, root); if (s) { ops.push({ id: id(), item: null, op: "write-base-settings", target: baseRel("settings.json"), beforeSha: s.beforeSha, afterSha: sha256Text(s.text), diff: s.diff, conflicts: s.conflicts, sources: s.sources }); for (const c of s.conflicts) warnings.push(`base settings: the import's value replaces ${c}`); }
    const m = mergeMcp(r, root); if (m) { ops.push({ id: id(), item: null, op: "write-base-mcp", target: baseRel("mcp.json"), beforeSha: m.beforeSha, afterSha: sha256Text(m.text), diff: m.diff, conflicts: m.conflicts, sources: m.sources }); for (const c of m.conflicts) warnings.push(`base mcp.json: the import's value replaces ${c}`); }
  } catch (e) { errors.push((e as Error).message); }
  if (r.items.some((i) => itemOn(r, i) && (i.kind === "instruction" || i.kind === "rule"))) ops.push({ id: id(), item: null, op: "mark-complete", target: baseRel(".complete") });
  else warnings.push("no CLAUDE.md and no rule accepted: .complete is not written, agents keep ~/.claude");

  // standing staff: teams first (spawn adds members to them), then agents: the director, team leads, members
  const agents = r.items.filter((i) => i.kind === "agent" && itemOn(r, i)), teams = r.items.filter((i) => i.kind === "team" && itemOn(r, i));
  const leads = new Set(teams.map((t) => edited(r, t).lead).filter((x): x is string => !!x));
  for (const t of teams) { const e = edited(r, t), nm = e.name!; ops.push({ id: id(), item: t.id, op: "create-team", team: { id: nm, name: nm, lead: e.lead ?? null, members: (e.members ?? []).filter((m) => m !== e.lead), goal: `Standing team ${nm}, imported by run ${r.runId}` } }); }
  const rank = (i: Item) => { const e = edited(r, i); return e.director ? 0 : leads.has(e.name ?? "") ? 1 : 2; };
  const acct = accountFile(DEFAULT_ACCOUNT) ? DEFAULT_ACCOUNT : null;
  for (const a of [...agents].sort((x, y) => rank(x) - rank(y))) {
    const e = edited(r, a), name = e.name!;
    const soul = a.at?.file && r.project ? `ws/${name}` : null;
    if (soul) ops.push({ id: id(), item: a.id, op: "register-soul", name, repo: findRepos(r.project!).filter((x) => a.at!.file!.startsWith(x + "/")).sort((x, y) => y.length - x.length)[0] ?? r.project!, defFile: a.at!.file!, sha: sha256File(a.at!.file!) });
    const team = e.team ?? teams.map((t) => edited(r, t)).find((t) => t.lead === name || t.members?.includes(name))?.name ?? null;
    const def: AgentDef = { name, model: e.model ?? null, boss: e.director ? "root" : e.boss ?? "root", team, director: !!e.director, project: r.project ?? r.home, job: `Standing ${e.director ? "director" : "agent"} ${name}, imported by run ${r.runId}: ${a.summary}`.slice(0, 300), goal: `Standing agent ${name} stays available for work from its boss`, soul, account: acct, standing: true };
    ops.push({ id: id(), item: a.id, op: "create-agent", target: join("agents", name, "staff.json"), agent: def });
    ops.push({ id: id(), item: a.id, op: "start-agent", name });
  }
  for (const o of ops) if (!(OPS as readonly string[]).includes(o.op)) errors.push(`${o.id}: ${o.op} is not an import op`);
  if (errors.length) return { ok: false, errors };
  const fileList: ImportPlan["files"] = [];
  for (const o of ops) {
    if (o.op === "copy-file" || o.op === "rewrite-hook-path") fileList.push({ target: o.target, size: o.size });
    else if (o.op === "copy-dir") for (const f of o.files) fileList.push({ target: join(o.target, f.rel), size: f.size });
    else if (o.op === "write-base-settings" || o.op === "write-base-mcp") fileList.push({ target: o.target, size: 0 });
    else if (o.op === "create-agent") fileList.push({ target: o.target, size: 0 });
  }
  // sizes of the merged files: computed again (the text itself never leaves this module)
  const ms = (() => { try { return { s: mergeSettings(r, root), m: mergeMcp(r, root) }; } catch { return { s: null, m: null }; } })();
  for (const f of fileList) { if (f.target === baseRel("settings.json") && ms.s) f.size = Buffer.byteLength(ms.s.text); if (f.target === baseRel("mcp.json") && ms.m) f.size = Buffer.byteLength(ms.m.text); }
  const plan = { planId: "", runId: r.runId, ops, files: [...fileList, ...(ops.some((o) => o.op === "mark-complete") ? [{ target: baseRel(".complete"), size: 0 }] : [])], warnings };
  plan.planId = importPlanId(plan);
  return { ok: true, plan };
}
export function preview(root = ROOT): { ok: true; plan: ImportPlan } | { ok: false; status: 409 | 422; errors: string[] } {
  const r = cur; if (!r || !["proposed", "previewed"].includes(r.phase)) return { ok: false, status: 409, errors: ["no open run to preview: scan first"] };
  const v = validateStaff(r); if (v.length) return { ok: false, status: 422, errors: v };
  const p = buildImportPlan(r, root); if (!p.ok) return { ok: false, status: 422, errors: p.errors };
  r.plan = p.plan; r.phase = "previewed"; saveRun(root, r);
  progress({ runId: r.runId, phase: "preview", status: "done", detail: `${p.plan.ops.length} ops` });
  return p;
}

// ---------- apply ----------
let applying = false;
export async function applyImport(planId: unknown, root = ROOT): Promise<{ ok: true; runId: string; manifest: ImportManifest; errors: string[] } | { ok: false; status: 400 | 409 | 500; error: string }> {
  const r = cur;
  if (!r || r.phase !== "previewed" || !r.plan) return { ok: false, status: 409, error: "no previewed run: preview first" };
  if (planId !== r.plan.planId || importPlanId(r.plan) !== r.plan.planId) return { ok: false, status: 409, error: "the plan changed since the preview: preview again" };
  if (applying) return { ok: false, status: 409, error: "an import is applying" };
  applying = true; r.phase = "applying"; saveRun(root, r);
  const m: ImportManifest = { runId: r.runId, files: [], dirs: [], agents: [], teams: [], souls: false, complete: false };
  r.manifest = m; const errs: string[] = [];
  const backupDir = join(runDir(root, r.runId), "backup");
  const mkd = (d: string) => { const missing: string[] = []; for (let x = d; !existsSync(x); x = dirname(x)) missing.push(x); for (const x of missing.reverse()) { assertInHome(x, "import", root); mkdirSync(x, { mode: 0o700 }); m.dirs.push(x); } };
  /** write one target file in the home, with a backup of what was there */
  const put = (rel: string, write: (target: string) => void) => {
    const target = abs(root, rel); assertInHome(target, "import", root);
    mkd(dirname(target));
    const before = shaOrNull(target); let backup: string | null = null;
    if (before !== null && !m.files.some((f) => f.target === target)) { backup = join(backupDir, rel); mkdirSync(dirname(backup), { recursive: true, mode: 0o700 }); copyFileSync(target, backup); chmodSync(backup, 0o600); }
    let entry = m.files.find((f) => f.target === target);
    if (!entry) { entry = { target, beforeSha: before, afterSha: "", backup }; m.files.push(entry); }
    write(target); entry.afterSha = sha256File(target);
  };
  const step = (o: ImportOp, status: "ok" | "failed" | "skipped", error?: string) => { o.status = status; if (error) o.error = error; progress({ runId: r.runId, phase: "apply", op: o.op, opId: o.id, status, ...("target" in o ? { target: o.target } : {}), ...(error ? { detail: error } : {}) }); saveRun(root, r); };
  let fileFailed = false;
  try {
    for (const o of r.plan.ops) {
      if (o.op === "create-team" || o.op === "create-agent" || o.op === "start-agent") continue;
      if (fileFailed) { step(o, "skipped", "an earlier op failed"); continue; }
      try {
        if (o.op === "copy-file" || o.op === "rewrite-hook-path") {
          if (shaOrNull(o.source) !== o.sha) throw new Error(`${o.source} changed since preview`);
          put(o.target, (t) => { copyFileSync(o.source, t); chmodSync(t, o.op === "rewrite-hook-path" ? 0o700 : 0o600); });
          if (shaOrNull(abs(root, o.target)) !== o.sha) throw new Error(`${o.source} changed since preview`);
        } else if (o.op === "copy-dir") {
          const now = treeFiles(o.source).filter((f) => !denyReason(join(o.source, f), [o.source]));
          if (!same(now, o.files.map((f) => f.rel)) || o.files.some((f) => shaOrNull(join(o.source, f.rel)) !== f.sha)) throw new Error(`${o.source} changed since preview`);
          for (const f of o.files) put(join(o.target, f.rel), (t) => { copyFileSync(join(o.source, f.rel), t); chmodSync(t, statSync(join(o.source, f.rel)).mode & 0o111 ? 0o700 : 0o600); });
        } else if (o.op === "register-soul") {
          if (shaOrNull(o.defFile) !== o.sha) throw new Error(`${o.defFile} changed since preview`);
          const res = registerSouls([{ repo: o.repo, name: o.name, source: "agent-def", defFile: o.defFile }], { runId: r.runId, dir: wsDir() });
          m.souls = true; if (res.errors.length) throw new Error(res.errors.join("; "));
        } else if (o.op === "write-base-settings" || o.op === "write-base-mcp") {
          for (const s of o.sources) if (shaOrNull(s.file) !== s.sha) throw new Error(`${s.file} changed since preview`);
          if (shaOrNull(abs(root, o.target)) !== o.beforeSha) throw new Error(`${o.target} changed since preview`);
          const mg = o.op === "write-base-settings" ? mergeSettings(r, root) : mergeMcp(r, root);
          if (!mg || sha256Text(mg.text) !== o.afterSha) throw new Error(`${o.target} would change differently than previewed`);
          put(o.target, (t) => writeAtomic(t, mg.text, 0o600));
        } else if (o.op === "mark-complete") {
          put(o.target, (t) => writeAtomic(t, JSON.stringify({ runId: r.runId, at: new Date().toISOString() }) + "\n", 0o600)); m.complete = true;
        }
        step(o, "ok");
      } catch (e) { fileFailed = true; errs.push(`${o.id} ${o.op}: ${(e as Error).message}`); step(o, "failed", (e as Error).message); }
    }
    if (fileFailed) {
      for (const o of r.plan.ops) if (!o.status) step(o, "skipped", "the run stopped before the agent ops");
      r.phase = "failed"; r.error = errs[0]; r.errors = errs; saveRun(root, r);
      logEvent("warn", "import apply stopped", { runId: r.runId, failed: errs.length });
      return { ok: false, status: 409, error: `${errs.join("; ")}. Nothing was started; roll back or preview again.` };
    }
    // standing staff: after .complete, so the agents start on the filled base (own config dir with an account)
    for (const o of r.plan.ops) {
      try {
        if (o.op === "create-team") {
          if (getTeam(o.team.id)) throw new Error(`team ${o.team.id} exists already`);
          createTeam({ id: o.team.id, name: o.team.name, goal: o.team.goal, project: r.project ?? undefined });
          m.teams.push(o.team.id); step(o, "ok");
        } else if (o.op === "create-agent") {
          put(o.target, (t) => writeAtomic(t, JSON.stringify(o.agent, null, 2) + "\n", 0o600)); step(o, "ok");
        } else if (o.op === "start-agent") {
          const def = r.plan.ops.find((x): x is Extract<ImportOp, { op: "create-agent" }> => x.op === "create-agent" && x.agent.name === o.name)!.agent;
          const res = await importSeams.spawn(def);
          const row = byName(o.name); if (row) m.agents.push({ name: o.name, id: row.id });
          if (!res.ok) throw new Error(res.error ?? "spawn failed");
          if (row?.standing !== 1 && row) db().run("UPDATE agents SET standing = 1 WHERE id = ?", [row.id]);
          if (def.team && row) { const t = getTeam(def.team); if (t && def.name === r.plan.ops.find((x): x is Extract<ImportOp, { op: "create-team" }> => x.op === "create-team" && x.team.id === def.team)?.team.lead) { const { updateTeam } = await import("./teams"); updateTeam(def.team, { lead: def.name }); } }
          step(o, "ok");
        }
      } catch (e) { errs.push(`${o.id} ${o.op}: ${(e as Error).message}`); step(o, "failed", (e as Error).message); }
    }
    r.phase = "applied"; if (errs.length) r.errors = errs; saveRun(root, r);
    progress({ runId: r.runId, phase: "apply", status: "done", detail: `${m.files.length} files, ${m.agents.length} agents, ${m.teams.length} teams` });
    logEvent("info", "import applied", { runId: r.runId, files: m.files.length, agents: m.agents.length, teams: m.teams.length, errors: errs.length });
    return { ok: true, runId: r.runId, manifest: m, errors: errs };
  } catch (e) {
    r.phase = "failed"; r.error = (e as Error).message; saveRun(root, r);
    return { ok: false, status: 500, error: `import failed: ${(e as Error).message}. Roll back with run ${r.runId}.` };
  } finally { applying = false; }
}

// ---------- rollback ----------
export interface ImportRollback { ok: boolean; runId: string; removed: string[]; restored: string[]; kept: { file: string; why: string }[]; agents: string[]; teams: string[]; order: string[]; error?: string }
const loadRun = (root: string, runId: string): Run | null => { if (cur?.runId === runId) return cur; try { return JSON.parse(readFileSync(join(runDir(root, runId), "run.json"), "utf8")) as Run; } catch { return null; } };
/** Undo one run, in this order: .complete, the agents (retired, no grade), the teams (archived), the files (created ones deleted, changed ones restored).
 *  Only paths the manifest lists, all inside the home; sources are never touched. */
export function rollbackImport(runId: unknown, root = ROOT): ImportRollback {
  const id = typeof runId === "string" ? runId : "", out: ImportRollback = { ok: false, runId: id, removed: [], restored: [], kept: [], agents: [], teams: [], order: [] };
  if (!/^imp-[a-z0-9-]+$/.test(id)) return { ...out, error: "runId is required" };
  const r = loadRun(root, id); if (!r || !r.manifest) return { ...out, error: `no applied run ${id}` };
  if (r.phase === "rolledback") return { ...out, ok: true, error: "already rolled back" };
  if (r.phase === "applying") return { ...out, error: "that run is still applying" };
  const m = r.manifest, done = (f: string, why?: string) => (why ? out.kept.push({ file: f, why }) : null);
  // 1. .complete first: agents spawned from now on stay on ~/.claude
  const comp = m.files.find((f) => f.target.endsWith(`${join("claude", "base", ".complete")}`));
  if (comp && existsSync(comp.target)) { assertInHome(comp.target, "import rollback", root); rmSync(comp.target); out.removed.push(comp.target); }
  out.order.push("complete");
  // 2. agents
  for (const a of m.agents) { const row = db().query("SELECT * FROM agents WHERE id = ? AND archived_at IS NULL").get(a.id) as AgentRow | null; if (row) { retireAgent(row, "despawn", Date.now(), importSeams.kill); out.agents.push(a.name); } }
  out.order.push("agents");
  // 3. teams
  for (const t of m.teams) if (archiveTeam(t)) out.teams.push(t);
  out.order.push("teams");
  // 4. files
  for (const f of [...m.files].reverse()) {
    if (f === comp) continue;
    try { assertInHome(f.target, "import rollback", root); } catch (e) { done(f.target, (e as Error).message); continue; }
    const now = shaOrNull(f.target);
    if (now === f.beforeSha) continue;
    if (now !== null && now !== f.afterSha) { done(f.target, "edited after the import: kept"); continue; }
    if (f.backup) { if (!existsSync(f.backup)) { done(f.target, "backup is missing"); continue; } writeAtomic(f.target, readFileSync(f.backup), 0o600); out.restored.push(f.target); }
    else if (now !== null) { rmSync(f.target); out.removed.push(f.target); }
  }
  if (m.souls) out.removed.push(...removeSouls({ runId: r.runId, dir: wsDir() }));
  for (const d of [...m.dirs].sort((a, b) => b.length - a.length)) { try { assertInHome(d, "import rollback", root); if (!readdirSync(d).length) rmdirSync(d); } catch { /* not empty or gone */ } }
  out.order.push("files");
  r.phase = "rolledback"; saveRun(root, r);
  progress({ runId: r.runId, phase: "rollback", status: "done", detail: `${out.removed.length} removed, ${out.restored.length} restored, ${out.agents.length} agents, ${out.teams.length} teams` });
  logEvent("info", "import rolled back", { runId: r.runId, removed: out.removed.length, restored: out.restored.length, kept: out.kept.length });
  return { ...out, ok: true };
}

// ---------- standing staff after a server restart ----------
export const RESTART_MAX = 10;
/** Every standing agent whose last state was running and whose tmux session is gone is started again through the spawn path (max 10 per boot).
 *  AGENTNET_RESTART_STANDING=0 turns it off. Root and members (channel bots) are not restarted here. */
export async function restartStanding(o: { max?: number } = {}): Promise<string[]> {
  if (process.env.AGENTNET_RESTART_STANDING === "0") return [];
  const rows = db().query("SELECT * FROM agents WHERE standing = 1 AND archived_at IS NULL AND kind = 'agent' AND name != 'root' ORDER BY spawned_at, rowid").all() as AgentRow[];
  const started: string[] = [];
  for (const a of rows) {
    if (started.length >= (o.max ?? RESTART_MAX)) { logEvent("warn", "standing restart: limit reached", { limit: o.max ?? RESTART_MAX, left: rows.length - started.length }); break; }
    const s = get(a.id); if (!s || (s.life !== "live" && s.life !== "starting")) continue;
    const session = a.placement && /^agentnet-/.test(a.placement) ? a.placement : `agentnet-${a.name}`;
    if (importSeams.hasSession(session)) continue;
    emit({ agent: a.id, type: "AgentGone", data: { reason: "server-restart" }, source: "service", ts: Date.now() }); flush();
    const def: AgentDef = { name: a.name, model: a.model, boss: a.boss ?? "root", team: teamsOf(a.name)[0]?.id ?? null, director: false, project: a.project ?? process.env.HOME ?? homedir(), job: a.job ?? `Standing agent ${a.name}`, goal: a.goal ?? `Standing agent ${a.name} stays available for work from its boss`, soul: a.soul, account: a.account ?? null, standing: true };
    const res = await importSeams.spawn(def);
    logEvent(res.ok ? "info" : "warn", `standing restart: ${a.name} ${res.ok ? "started again" : "failed"}`, res.ok ? {} : { error: res.error });
    started.push(a.name);
  }
  return started;
}

// ---------- routes (panel auth; writes are root only via isPanelWrite) ----------
// GET /agent-import carries the plan (with each op's status after an apply): the same plan preview already sent, so a reopened
// setup window can redraw the op lines and see whether the import started a director.
const view = () => { const r = cur; return r ? { runId: r.runId, phase: r.phase, project: r.project, llm: r.llm, items: r.items.length, planId: r.plan?.planId ?? null, error: r.error ?? null, errors: r.errors ?? [], manifest: r.manifest ?? null, plan: r.plan ?? null } : { runId: null, phase: "idle" }; };
const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<Obj> => { try { const b = await c.req.json(); return isObj(b) ? b : {}; } catch { return {}; } };
/** The director's latest validated report, for llm items. Lazy: adopt.ts pulls in the server modules. */
const latestReport = async (): Promise<AdoptReport | null> => { try { return (await import("./adopt")).loadStateReport() ?? null; } catch { return null; } };
export function importRoutes(api: Hono<Env>) {
  api.get("/agent-import", (c) => c.json(view()));
  api.get("/agent-import/proposal", (c) => { const r = cur; if (!r) return problem(c, 404, "Not Found", "no import run"); return c.json({ runId: r.runId, items: r.items.map((i) => ({ ...i, accept: itemOn(r, i), ...(i.edits || r.decisions[i.id]?.edits ? { edits: edited(r, i) } : {}) })) }); });
  api.post("/agent-import/scan", async (c) => {
    const b = await body(c), llm = b.llm === true;
    const res = startScan({ dir: typeof b.dir === "string" && b.dir ? b.dir : null, llm, report: llm ? await latestReport() : null });
    return res.ok ? c.json({ runId: res.runId, items: res.items }) : problem(c, res.status, res.status === 409 ? "Conflict" : "Can't do that", res.error);
  });
  api.post("/agent-import/cancel", (c) => { const r = cancelRun(); return r.ok ? c.json(view()) : problem(c, 409, "Conflict", r.error!); });
  api.post("/agent-import/decide", async (c) => { const r = decide(await body(c)); return r.ok ? c.json(r) : c.json({ title: "Can't do that", status: r.status, errors: r.errors }, r.status); });
  api.post("/agent-import/preview", (c) => { const r = preview(); return r.ok ? c.json(r.plan) : c.json({ title: "Can't do that", status: r.status, errors: r.errors }, r.status); });
  api.post("/agent-import/apply", async (c) => { const b = await body(c), r = await applyImport(b.planId); return r.ok ? c.json(r) : problem(c, r.status, "Apply failed", r.error); });
  api.post("/agent-import/rollback", async (c) => { const b = await body(c), r = rollbackImport(b.runId); return r.ok ? c.json(r) : problem(c, 422, "Rollback failed", r.error ?? "rollback failed"); });
  api.get("/agent-import/stream", (c) => streamSSE(c, async (stream) => {
    const q: Progress[] = [...recentProgress(cur?.runId)]; let wake: (() => void) | null = null;
    const off = onProgress((p) => { q.push(p); wake?.(); });
    try {
      let beat = Date.now();
      while (!stream.aborted) {
        while (q.length) await stream.writeSSE({ event: "import.progress", data: JSON.stringify(q.shift()) });
        await new Promise<void>((res) => { wake = res; setTimeout(res, 1000); }); wake = null;
        if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
      }
    } finally { off(); }
  }));
}
