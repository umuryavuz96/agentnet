// Step 3: one Claude Code config dir per agent (docs/internal/one-folder/SPEC-step3-config-dir.md).
// $AGENTNET_HOME/agents/<name>/claude/ is the agent's CLAUDE_CONFIG_DIR: settings, trust, history and transcripts live there.
// It is used only when usesOwnDir(agent) holds: the agent's account has a secret file AND claude/base/.complete exists (the import
// filled the base). Otherwise everything stays on ~/.claude as before, so an account alone never moves agents onto an empty base.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, chmodSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../core/config";
import { db } from "../core/db";
import { assertInHome } from "../core/paths";
import { accountFile, ACCOUNT_ENV, DEFAULT_ACCOUNT } from "./accounts";
import { preAnswerProject } from "./claude-trust";
import { claudeHome } from "./feed";

export const baseDir = () => join(ROOT, "claude", "base");
export const agentConfigDir = (name: string) => join(ROOT, "agents", name, "claude");
/** The import step (or the owner, by hand) writes this marker once the base holds the owner's settings, CLAUDE.md, rules, skills and MCP. */
export const baseComplete = () => existsSync(join(baseDir(), ".complete"));
/** The one switch: an agent runs on its own config dir only with an account secret and a complete base. */
export const usesOwnDir = (a: { account?: string | null } | null | undefined): boolean => !!a && !!accountFile(a.account ?? DEFAULT_ACCOUNT) && baseComplete();

/** The account of the newest row of a name; null when no such agent. */
const accountOfName = (name: string): string | null | undefined => {
  try { const r = db().query("SELECT account FROM agents WHERE name = ? ORDER BY gen DESC LIMIT 1").get(name) as { account: string | null } | null; return r ? r.account ?? DEFAULT_ACCOUNT : undefined; } catch { return undefined; }
};
/** Where a reader finds the agent's transcripts: its own dir when it runs there (and the dir was prepared), else ~/.claude
 *  (root, channel bots, old agents, and every agent before the owner's login). */
export function configDirOf(a: string | { name: string; account?: string | null } | null | undefined): string {
  if (!a) return claudeHome();
  const row = typeof a === "string" ? { name: a, account: accountOfName(a) } : a.account === undefined ? { name: a.name, account: accountOfName(a.name) } : a;
  return row.account !== undefined && usesOwnDir(row) && existsSync(agentConfigDir(row.name)) ? agentConfigDir(row.name) : claudeHome();
}
/** Every projects/ folder a whole-history reader scans: ~/.claude/projects plus agents/<name>/claude/projects. */
export function allProjectDirs(): string[] {
  const out = [join(claudeHome(), "projects")];
  try { for (const n of readdirSync(join(ROOT, "agents"))) { const p = join(agentConfigDir(n), "projects"); if (existsSync(p)) out.push(p); } } catch { /* no agents dir */ }
  return out;
}

const readJson = (f: string): Record<string, unknown> => { try { const j = JSON.parse(readFileSync(f, "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; } };
const writeJson = (f: string, j: unknown) => { assertInHome(f, "agent config"); const tmp = `${f}.agentnet-${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, f); chmodSync(f, 0o600); };
/** Absolute-path permission patterns (Claude Code: `//abs/path`), for the home and, when it differs, its real path. */
const absPats = (rel: string): string[] => { const roots = new Set([ROOT]); try { roots.add(realpathSync(ROOT)); } catch { /* none */ } return [...roots].map((r) => `/${join(r, rel)}`); };
/** What an agent's tools may never read or edit: the run dir (every token, its own too: the plugin reads its token in-process,
 *  not through a tool), the account secrets and any agent token file.
 *  No Bash sandbox on top (step 7, checked on Claude Code 2.1.327): turning it on also narrows network and writes, and neither can be
 *  opened back up. The CLI schema says "Unlike allowedDomains, a bare "*" is accepted here (deny-all)", so there is no allow-all
 *  network. The docs (code.claude.com/docs/en/sandboxing) say unlisted hosts follow the permission mode, and auto mode refuses them.
 *  The same page says writes default to "the current working directory (cwd), the per-user temp directory" and added dirs.
 *  So an agent keeps these permission rules only, and they cover the Read and Edit tools, not every shell command. */
export function denyRules(): string[] {
  const out: string[] = [];
  for (const rel of ["run/**", "accounts/**", "agents/*/token"]) for (const p of absPats(rel)) out.push(`Read(${p})`, `Edit(${p})`);
  for (const p of absPats("lines/**")) out.push(`Edit(${p})`); // step 8a: only the server writes a line's self; the agent may read its own
  return out;
}
/** Step 8 proof fix: the agent's file tools may not rewrite its own transcripts (projects/) or session files (sessions/), which
 *  the server reads to check upgrade proofs. A shell command still can (SECURITY.md, the one-OS-user limit). */
export const ownTranscriptDeny = (name: string): string[] =>
  ["projects/**", "sessions/**"].flatMap((rel) => absPats(join("agents", name, "claude", rel))).flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
const LINKS = ["CLAUDE.md", "rules", "skills", "agents", "commands"];

export interface Prepared { dir: string; own: boolean; account: string; kind?: string; env?: string; file?: string; enabled: string[]; mcpServers: string[] }
/** Make (or refresh) agents/<name>/claude: settings.json from the base plus the deny rules and no auto-update, .claude.json with trust
 *  for the project and the base's user-scope MCP servers, and links to the base CLAUDE.md, rules, skills, agents and commands.
 *  Re-running keeps what Claude Code wrote there (projects/, history, its own .claude.json keys): only our keys are merged. */
export function prepareConfig(name: string, o: { project: string; mcp?: string[]; account?: string | null }): Prepared {
  const account = o.account || DEFAULT_ACCOUNT, acc = accountFile(account), dir = agentConfigDir(name);
  assertInHome(dir, "agent config dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  // settings.json: the base, then ours on top
  const base = readJson(join(baseDir(), "settings.json")), sf = join(dir, "settings.json"), s = { ...readJson(sf), ...structuredClone(base) } as Record<string, unknown>;
  const perms = (s.permissions && typeof s.permissions === "object" && !Array.isArray(s.permissions) ? { ...(s.permissions as Record<string, unknown>) } : {}) as Record<string, unknown>;
  perms.deny = [...new Set([...(Array.isArray(perms.deny) ? (perms.deny as unknown[]).filter((x): x is string => typeof x === "string") : []), ...denyRules(), ...ownTranscriptDeny(name)])];
  s.permissions = perms;
  // auto-update off: Claude Code 2.1.x migrates the legacy autoUpdates:false preference into env DISABLE_AUTOUPDATER (checked in the binary)
  s.env = { ...(s.env && typeof s.env === "object" && !Array.isArray(s.env) ? s.env as Record<string, unknown> : {}), DISABLE_AUTOUPDATER: "1" };
  writeJson(sf, s);
  // .claude.json: trust + project .mcp.json answers (preAnswerProject merges), user-scope servers from the base, autoUpdates false
  const cf = join(dir, ".claude.json");
  if (!existsSync(cf)) writeJson(cf, {});
  const tr = preAnswerProject(o.project, { file: cf, enable: o.mcp ?? ["playwright"], backupDir: join(ROOT, "backups") });
  if (tr.error) throw new Error(`could not pre-answer the first-run questions: ${tr.error}`);
  const c = readJson(cf), baseMcp = readJson(join(baseDir(), "mcp.json")).mcpServers as Record<string, unknown> | undefined;
  const servers = baseMcp && typeof baseMcp === "object" && !Array.isArray(baseMcp) ? baseMcp : {};
  c.mcpServers = { ...(c.mcpServers && typeof c.mcpServers === "object" && !Array.isArray(c.mcpServers) ? c.mcpServers as Record<string, unknown> : {}), ...structuredClone(servers) };
  c.autoUpdates = false;
  writeJson(cf, c);
  // links into the base; a real file or dir Claude Code (or someone) put there is left alone
  for (const n of LINKS) {
    const src = join(baseDir(), n), dst = join(dir, n);
    let st: ReturnType<typeof lstatSync> | null = null; try { st = lstatSync(dst); } catch { /* none */ }
    if (st && !st.isSymbolicLink()) continue;
    if (!existsSync(src)) { if (st) unlinkSync(dst); continue; }
    if (st && readlinkSync(dst) === src) continue;
    if (st) unlinkSync(dst);
    symlinkSync(src, dst);
  }
  return { dir, own: usesOwnDir({ account }), account, ...(acc ? { kind: acc.kind, env: ACCOUNT_ENV[acc.kind], file: acc.file } : {}), enabled: tr.enabled, mcpServers: Object.keys(servers) };
}
