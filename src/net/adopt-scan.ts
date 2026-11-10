// Collector for "adopt an existing workspace": deterministic, cheap observations (signals) about how a folder coordinates agents.
// No LLM, no network, no product names. A signal is a reason for the director to look, never a verdict.
// Reads only through adopt-safe's path policy, within hard limits (200 files, 2 MB, 5 s). Never opens secrets.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { allowedRead, denyReason, redactText, sha256Text } from "./adopt-safe";
import { scriptOf } from "./hooks";

/** Behaviour lexicon: plain words, no product names. Whole-word, case-insensitive; `_ - / .` count as separators. */
export const LEXICON = ["send", "inbox", "outbox", "message", "msg", "mail", "mailbox", "channel", "queue", "poll", "unread", "notify", "deliver", "relay", "broadcast", "handoff", "dispatch", "team", "coordinator", "report to"];
const norm = (s: string) => " " + s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
const LEX_NORM = LEXICON.map((w) => ({ w, n: " " + w + " " }));
/** The lexicon words found in a text (whole word). */
export const lexHits = (s: string): string[] => { const n = norm(s); return LEX_NORM.filter((x) => n.includes(x.n)).map((x) => x.w); };

const HOOK_EVENTS = ["UserPromptSubmit", "SessionStart", "Stop", "PostToolUse", "PreToolUse", "Notification"];
const MSG_VERB = /\b(send|reply|report|notify|ping|poll|hand[- ]?off|check (?:your |the )?inbox)\b/i;
const MSG_OBJ = /\b(agents?|teams?|coordinators?|leads?|boss|main|teammates?|inbox|channels?)\b/i;
const MCP_TOKEN = /\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/;
const ID_PHRASE = /\byou are\b|\byour name is\b|\bwe are\b/i;
const ID_ROLE = /\b(main|coordinator|lead|boss|manager|orchestrator|director|agent|owner|architect)\b/i;
const HOME_PATH = /(?:~|\$HOME|\$\{HOME\})\/[\w.\-/]+/g;

export const LIMITS = { files: 200, bytes: 2_000_000, ms: 5000 };
const GROUP_GAP = 3;
const clip = (s: string) => redactText(s.trim()).slice(0, 160);

export interface Hit { line: number; text: string }
export type Signal = { ref: string; id: string; file?: string; [k: string]: unknown };
export interface RepoInfo { path: string; hasClaudeMd: boolean; agentDefs: string[]; settingsFiles: string[] }
export interface Facts {
  version: 1; workspace: string; scannedAt: string;
  /** What the director session may read (the scan gate roots). Paths named by signals are readable too. */
  roots: string[];
  repos: RepoInfo[]; signals: Signal[]; skipped: { what: string; why: string }[]; limits: typeof LIMITS;
}
export interface CollectOpts {
  /** `tmux list-panes -a -F '#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_start_command}'` output */
  tmux?: () => string;
  /** `crontab -l` output */
  crontab?: () => string;
  /** launch agent jobs (label + program arguments) */
  launchd?: () => { file: string; label: string; args: string[] }[];
  now?: () => number;
  /** called with every path the collector actually reads (tests assert that secrets are never opened) */
  onRead?: (path: string) => void;
}

const home = () => process.env.HOME ?? homedir();
const run = (cmd: string[]): string => {
  const env = { ...process.env }; delete env.TMUX;
  const p = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `exit ${p.exitCode}`);
  return p.stdout.toString();
};
const defaultTmux = () => run(["tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_start_command}"]);
const defaultCrontab = () => run(["crontab", "-l"]);
const defaultLaunchd = () => {
  const d = join(home(), "Library/LaunchAgents");
  if (!existsSync(d)) return [];
  const out: { file: string; label: string; args: string[] }[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith(".plist")).sort()) {
    try {
      const j = JSON.parse(run(["plutil", "-convert", "json", "-o", "-", "--", join(d, f)])) as { Label?: string; ProgramArguments?: unknown };
      out.push({ file: join(d, f), label: String(j.Label ?? f), args: Array.isArray(j.ProgramArguments) ? j.ProgramArguments.map(String) : [] });
    } catch { /* unreadable plist: ignore */ }
  }
  return out;
};

export function collectFacts(workspaceIn: string, opts: CollectOpts = {}): Facts {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const workspace = resolve(workspaceIn);
  const skipped: Facts["skipped"] = [];
  const signals: Signal[] = [];
  const skip = (what: string, why: string) => { if (!skipped.some((s) => s.what === what && s.why === why)) skipped.push({ what, why }); };
  let files = 0, bytes = 0, over = false;

  const claudeDir = join(home(), ".claude");
  const roots = [workspace, ...(existsSync(claudeDir) ? [claudeDir] : [])];
  const scriptRoots = [join(home(), "scripts"), join(home(), "bin"), join(home(), ".local")].filter(existsSync);
  const allRoots = [...roots, ...scriptRoots];

  /** The one door for reading text: policy, budget, clock. Returns null when refused. */
  const read = (path: string, readRoots = allRoots): string | null => {
    if (now() - t0 > LIMITS.ms) { skip("limits", "5 s wall clock reached"); over = true; return null; }
    if (files >= LIMITS.files) { skip("limits", "200 file limit reached"); over = true; return null; }
    if (!allowedRead(path, readRoots)) return null;
    let st; try { st = statSync(path); } catch { return null; }
    if (!st.isFile()) return null;
    if (bytes + st.size > LIMITS.bytes) { skip("limits", "2 MB limit reached"); over = true; return null; }
    try { opts.onRead?.(path); const t = readFileSync(path, "utf8"); files++; bytes += st.size; return t; } catch { return null; }
  };
  const readJson = (path: string, readRoots?: string[]): Record<string, unknown> | null => {
    const t = read(path, readRoots); if (t === null) return null;
    try { const j = JSON.parse(t) as unknown; return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null; } catch { skip(path, "not valid JSON"); return null; }
  };
  const push = (id: string, s: Record<string, unknown>) => signals.push({ ref: "", id, ...s } as Signal);

  // ---- repos (workspace itself if it is one, plus children up to depth 2)
  const repoPaths = findRepos(workspace);
  const repos: RepoInfo[] = repoPaths.map((p) => {
    const defDir = join(p, ".claude/agents");
    let defs: string[] = []; try { defs = readdirSync(defDir).filter((x) => x.endsWith(".md")).sort(); } catch { /* none */ }
    const sf = [".claude/settings.json", ".claude/settings.local.json"].filter((x) => existsSync(join(p, x)));
    return { path: p, hasClaudeMd: existsSync(join(p, "CLAUDE.md")), agentDefs: defs, settingsFiles: sf };
  });
  // projects dirs = workspace + repos (a repo may be the workspace)
  const projects = [...new Set([workspace, ...repoPaths])];

  // ---- S-REPO-AGENT-DEF
  for (const r of repos) for (const f of r.agentDefs) {
    const file = join(r.path, ".claude/agents", f);
    const t = read(file); if (t === null) continue;
    const fm = frontMatter(t);
    push("S-REPO-AGENT-DEF", { file, repo: r.path, name: fm.name ?? basename(f, ".md"), description: clip(fm.description ?? ""), tools: fm.tools ?? null, model: fm.model ?? null, bodyLength: fm.body.length, sha: sha256Text(t) });
  }
  for (const r of repos) if (r.hasClaudeMd && !r.agentDefs.length) push("S-REPO-AGENT-DEF", { file: join(r.path, "CLAUDE.md"), repo: r.path, name: basename(r.path), claudeMdOnly: true });

  // ---- S-MCP
  const mcpFrom = (file: string, servers: unknown, allow: string[], extra?: string[]) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
      const d = (def && typeof def === "object" ? def : {}) as { command?: unknown; args?: unknown; url?: unknown };
      const command = typeof d.command === "string" ? d.command : "";
      const args = Array.isArray(d.args) ? d.args.map(String) : [];
      const perms = allow.filter((a) => a.startsWith(`mcp__${name}__`));
      const words = new Set<string>();
      for (const s of [name, command, ...args, ...perms, ...(extra ?? []).filter((x) => x.startsWith(`mcp__${name}__`))]) lexHits(s).forEach((w) => words.add(w));
      if (!words.size) continue;
      push("S-MCP", { file, server: name, command: redactText([command, ...args].join(" ")).slice(0, 160), url: typeof d.url === "string" ? redactText(d.url).slice(0, 160) : null, words: [...words], permissions: perms.slice(0, 10) });
    }
  };
  const settingsFiles: { file: string; json: Record<string, unknown>; project: string | null }[] = [];
  const loadSettings = (file: string, project: string | null) => { const j = readJson(file); if (j) settingsFiles.push({ file, json: j, project }); };
  loadSettings(join(claudeDir, "settings.json"), null);
  for (const p of projects) for (const n of ["settings.json", "settings.local.json"]) loadSettings(join(p, ".claude", n), p);
  // instruction files (read once; also used to spot mcp__ tokens)
  const instrFiles: string[] = [];
  const addInstr = (f: string) => { if (existsSync(f) && !instrFiles.includes(f)) instrFiles.push(f); };
  for (const p of projects) { addInstr(join(p, "CLAUDE.md")); addInstr(join(p, "AGENTS.md")); addInstr(join(p, ".claude/CLAUDE.md")); for (const f of mdTree(join(p, ".claude/rules"))) addInstr(f); }
  addInstr(join(claudeDir, "CLAUDE.md")); for (const f of mdTree(join(claudeDir, "rules"), false)) addInstr(f);
  const instrText = new Map<string, string>();
  for (const f of instrFiles) { const t = read(f); if (t !== null) instrText.set(f, t); }
  const instrMcp = [...instrText.values()].flatMap((t) => t.match(new RegExp(MCP_TOKEN, "g")) ?? []);

  const allowOf = (j: Record<string, unknown>): string[] => { const p = j.permissions as { allow?: unknown } | undefined; return Array.isArray(p?.allow) ? p!.allow.map(String) : []; };
  const mcpFiles: { file: string; servers: unknown; allow: string[] }[] = [];
  for (const p of projects) { const j = readJson(join(p, ".mcp.json")); if (j) mcpFiles.push({ file: join(p, ".mcp.json"), servers: j.mcpServers, allow: [] }); }
  for (const s of settingsFiles) mcpFiles.push({ file: s.file, servers: s.json.mcpServers, allow: allowOf(s.json) });
  const allAllow = settingsFiles.flatMap((s) => allowOf(s.json));
  const cj = readJson(join(home(), ".claude.json"), [home()]);
  if (cj) {
    mcpFiles.push({ file: join(home(), ".claude.json"), servers: cj.mcpServers, allow: allAllow });
    const proj = cj.projects as Record<string, { mcpServers?: unknown }> | undefined;
    for (const p of projects) if (proj?.[p]?.mcpServers) mcpFiles.push({ file: join(home(), ".claude.json"), servers: proj[p].mcpServers, allow: allAllow });
  }
  for (const m of mcpFiles) mcpFrom(m.file, m.servers, [...m.allow, ...allAllow], instrMcp);

  // ---- S-HOOK-INJECT
  const stateMentions: { from: string; text: string }[] = [];
  for (const s of settingsFiles) {
    const hooks = s.json.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== "object") continue;
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event]; if (!Array.isArray(groups)) continue;
      for (const g of groups as { matcher?: unknown; hooks?: unknown }[]) {
        if (!Array.isArray(g?.hooks)) continue;
        for (const h of g.hooks as { command?: unknown }[]) {
          if (typeof h?.command !== "string") continue;
          const command = h.command;
          const words = new Set(lexHits(command));
          let scriptPath: string | null = null; const hits: Hit[] = [];
          const sp = resolveScript(scriptOf(command), s.project);
          if (sp && existsSync(sp)) {
            const body = read(sp);
            if (body !== null) {
              scriptPath = sp;
              body.split("\n").forEach((ln, i) => { const w = lexHits(ln); if (w.length) { w.forEach((x) => words.add(x)); if (hits.length < 20) hits.push({ line: i + 1, text: clip(ln) }); stateMentions.push({ from: sp, text: ln }); } });
            }
          }
          if (!words.size) continue;
          push("S-HOOK-INJECT", { file: s.file, event, matcher: typeof g.matcher === "string" ? g.matcher : null, command: redactText(command).slice(0, 200), scriptPath, words: [...words], hits });
        }
      }
    }
  }

  // ---- S-INSTR-MSG / S-INSTR-IDENTITY
  for (const [file, text] of instrText) {
    const lines = text.split("\n");
    const msg: Hit[] = [];
    lines.forEach((ln, i) => { if ((MSG_VERB.test(ln) && MSG_OBJ.test(ln)) || MCP_TOKEN.test(ln)) { msg.push({ line: i + 1, text: clip(ln) }); stateMentions.push({ from: file, text: ln }); } });
    for (const grp of groupLines(msg)) push("S-INSTR-MSG", { file, fromLine: grp[0].line, toLine: grp[grp.length - 1].line, lines: grp });
    lines.slice(0, 80).forEach((ln, i) => { if (ID_PHRASE.test(ln) && ID_ROLE.test(ln)) push("S-INSTR-IDENTITY", { file, line: i + 1, text: clip(ln) }); });
  }

  // ---- S-STATE-DIR
  const seen = new Set<string>();
  for (const m of stateMentions) for (const raw of m.text.match(HOME_PATH) ?? []) {
    const p = join(home(), raw.replace(/^(~|\$HOME|\$\{HOME\})\//, "")).replace(/[.,;:)]+$/, "");
    if (seen.has(p) || seen.size >= 20) continue; seen.add(p);
    if (!existsSync(p) || denyReason(p, [home()])) continue; // existence and size only, never contents; denied names are not even stat'ed further
    const st = statSync(p);
    push("S-STATE-DIR", { path: p, mentionedIn: m.from, isDir: st.isDirectory(), size: st.size });
  }

  // ---- runners (read-only commands; a failure is a skipped signal, never an error)
  const underRoot = (s: string) => projects.some((p) => s.includes(p));
  try {
    for (const ln of (opts.tmux ?? defaultTmux)().split("\n")) {
      if (!ln.trim()) continue;
      const [session = "", cmd = "", path = "", start = ""] = ln.split("\t");
      if (session.startsWith("agentnet-")) continue;
      if (/\bclaude\b/.test(cmd + " " + start) || underRoot(path)) push("S-RUNNER-TMUX", { session, command: redactText(cmd).slice(0, 80), path, startCommand: redactText(start).slice(0, 160) });
    }
  } catch (e) { skip("S-RUNNER-TMUX", `tmux not readable: ${String((e as Error).message).slice(0, 80)}`); }
  try {
    for (const j of (opts.launchd ?? defaultLaunchd)()) {
      const joined = j.args.join(" ");
      if (/\bclaude\b/.test(joined) || lexHits(joined).length || underRoot(joined)) push("S-RUNNER-LAUNCHD", { file: j.file, label: j.label, args: redactText(joined).slice(0, 200) });
    }
  } catch (e) { skip("S-RUNNER-LAUNCHD", `launch agents not readable: ${String((e as Error).message).slice(0, 80)}`); }
  try {
    for (const ln of (opts.crontab ?? defaultCrontab)().split("\n")) {
      if (!ln.trim() || ln.trim().startsWith("#")) continue;
      if (/\bclaude\b/.test(ln) || underRoot(ln)) push("S-RUNNER-CRON", { line: redactText(ln.trim()).slice(0, 200) });
    }
  } catch { skip("S-RUNNER-CRON", "crontab not readable"); }

  if (over && !skipped.length) skip("limits", "a limit was reached");
  signals.forEach((s, i) => { s.ref = "g" + (i + 1); });
  return { version: 1, workspace, scannedAt: new Date(now()).toISOString(), roots, repos, signals, skipped, limits: LIMITS };
}

/** Front matter (--- key: value ---) and the body after it. Flat keys only; enough for agent definitions. */
export function frontMatter(t: string): { name?: string; description?: string; tools?: string; model?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
  if (!m) return { body: t };
  const kv: Record<string, string> = {};
  for (const ln of m[1].split("\n")) { const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(ln); if (k) kv[k[1]] = k[2].trim().replace(/^["']|["']$/g, ""); }
  return { name: kv.name, description: kv.description, tools: kv.tools, model: kv.model, body: t.slice(m[0].length) };
}

function resolveScript(tok: string, project: string | null): string | null {
  if (!tok || tok.startsWith("-")) return null;
  let p = tok.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, project ?? "\0").replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home());
  if (p.includes("\0") || p.includes("$")) return null;
  if (!isAbsolute(p)) { if (!project) return null; p = resolve(project, p); }
  return p;
}
function mdTree(dir: string, deep = true): string[] {
  const out: string[] = [];
  let names: string[] = []; try { names = readdirSync(dir).sort(); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    try { const st = lstatSync(p); if (st.isDirectory() && deep) out.push(...mdTree(p)); else if (st.isFile() && n.endsWith(".md")) out.push(p); } catch { /* gone */ }
  }
  return out;
}
function groupLines(hs: Hit[]): Hit[][] {
  const out: Hit[][] = [];
  for (const h of hs) { const last = out[out.length - 1]; if (last && h.line - last[last.length - 1].line <= GROUP_GAP) last.push(h); else out.push([h]); }
  return out;
}

/** Git repos: the folder itself when it is one, plus children up to depth 2. Folder names only; nothing is read. */
export function findRepos(workspace: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (existsSync(join(d, ".git"))) out.push(d);
    if (depth >= 2) return;
    let names: string[] = []; try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const p = join(d, n);
      try { if (lstatSync(p).isDirectory()) walk(p, depth + 1); } catch { /* gone */ }
    }
  };
  walk(resolve(workspace), 0);
  return out;
}

/** The free pre-check for the setup window: file existence and counts only, no contents read. */
export function precheck(dir: string, tmux: () => string = defaultTmux): { instructions: boolean; claudeDir: boolean; repos: number; agentDefs: number; tmuxAgents: number } {
  const repos = findRepos(dir);
  let agentDefs = 0;
  for (const r of repos) { try { agentDefs += readdirSync(join(r, ".claude/agents")).filter((x) => x.endsWith(".md")).length; } catch { /* none */ } }
  let tmuxAgents = 0;
  try { for (const ln of tmux().split("\n")) { if (!ln.trim()) continue; const [session = "", cmd = "", path = "", start = ""] = ln.split("\t"); if (!session.startsWith("agentnet-") && (/\bclaude\b/.test(cmd + " " + start) || path.startsWith(resolve(dir)))) tmuxAgents++; } } catch { /* no tmux */ }
  return { instructions: ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"].some((f) => existsSync(join(dir, f))), claudeDir: existsSync(join(dir, ".claude")), repos: repos.length, agentDefs, tmuxAgents };
}
