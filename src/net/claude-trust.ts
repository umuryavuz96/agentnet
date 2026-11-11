// Pre-accept Claude Code's "do you trust this folder" question for a folder agentnet itself starts the director in.
// Claude Code keeps the answer in <config>/.claude.json: projects["<dir>"].hasTrustDialogAccepted. We merge one flag into that file,
// never overwrite it: parse, set, write a temp file next to it, rename. A copy of the old file goes to the backup folder first.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../core/config";

export const claudeJsonPath = (env: Record<string, string | undefined> = process.env, home = homedir()): string =>
  env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");

export interface TrustResult { changed: string[]; error?: string }
/** Mark each folder trusted (and its real path, when that differs). Does nothing when the file is missing (a first run: Claude Code makes it, and the pane watcher answers) or is not valid JSON. */
export function acceptTrust(dirs: string[], o: { file?: string; backupDir?: string; now?: number } = {}): TrustResult {
  const file = o.file ?? claudeJsonPath();
  if (!existsSync(file)) return { changed: [] };
  try {
    const text = readFileSync(file, "utf8");
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || Array.isArray(j)) return { changed: [], error: "Claude Code's config is not a JSON object." };
    const projects = (j.projects && typeof j.projects === "object" && !Array.isArray(j.projects) ? j.projects : (j.projects = {})) as Record<string, Record<string, unknown>>;
    const want = new Set<string>();
    for (const d of dirs) { want.add(d); try { want.add(realpathSync(d)); } catch { /* not on disk yet */ } }
    const changed: string[] = [];
    for (const d of want) {
      const e = projects[d];
      if (e && typeof e === "object" && e.hasTrustDialogAccepted === true) continue;
      projects[d] = { ...(e && typeof e === "object" ? e : {}), hasTrustDialogAccepted: true };
      changed.push(d);
    }
    if (!changed.length) return { changed };
    const dir = o.backupDir ?? join(ROOT, "backups");
    mkdirSync(dir, { recursive: true });
    const bak = join(dir, `claude.json.${o.now ?? Date.now()}.bak`);
    copyFileSync(file, bak); chmodSync(bak, 0o600);
    const indent = /^\{\n( +)"/.exec(text)?.[1]?.length ?? 2;
    const tmp = `${file}.agentnet-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, indent) + (text.endsWith("\n") ? "\n" : ""), { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
    return { changed };
  } catch (e) {
    return { changed: [], error: (e as Error).message };
  }
}

/** Names of the servers every .mcp.json from `dir` up to the root declares (Claude Code asks about each one the first time). */
export function mcpJsonServers(dir: string): string[] {
  const out = new Set<string>();
  for (let d = dir, i = 0; i < 40; i++) {
    try {
      const j = JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
      if (j && j.mcpServers && typeof j.mcpServers === "object") for (const n of Object.keys(j.mcpServers)) out.add(n);
    } catch { /* none or unreadable */ }
    const up = dirname(d); if (up === d) break; d = up;
  }
  return [...out];
}

/** Answer Claude Code's first-run questions for a folder an agent is spawned in, so the session never waits at a dialog:
 *  workspace trust, and the .mcp.json "enable these servers" question. Only the servers in `enable` are enabled; every other server
 *  found is disabled. Answers already in the file are kept. Same safe write as acceptTrust (backup, temp file, rename). */
export function preAnswerProject(dir: string, o: { enable?: string[]; file?: string; backupDir?: string; now?: number } = {}): TrustResult & { enabled: string[]; disabled: string[] } {
  const file = o.file ?? claudeJsonPath(), enable = new Set(o.enable ?? ["playwright"]);
  const none = { changed: [] as string[], enabled: [] as string[], disabled: [] as string[] };
  if (!existsSync(file)) return none;
  try {
    const text = readFileSync(file, "utf8");
    const j = JSON.parse(text) as Record<string, unknown>;
    if (!j || typeof j !== "object" || Array.isArray(j)) return { ...none, error: "Claude Code's config is not a JSON object." };
    const projects = (j.projects && typeof j.projects === "object" && !Array.isArray(j.projects) ? j.projects : (j.projects = {})) as Record<string, Record<string, unknown>>;
    const dirs = new Set<string>([dir]); try { dirs.add(realpathSync(dir)); } catch { /* not on disk */ }
    const servers = mcpJsonServers(dir), changed: string[] = [], enabled: string[] = [], disabled: string[] = [];
    for (const d of dirs) {
      const before = JSON.stringify(projects[d] ?? null);
      const e = (projects[d] && typeof projects[d] === "object" ? projects[d] : (projects[d] = {})) as Record<string, unknown>;
      e.hasTrustDialogAccepted = true;
      const on = Array.isArray(e.enabledMcpjsonServers) ? (e.enabledMcpjsonServers as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const off = Array.isArray(e.disabledMcpjsonServers) ? (e.disabledMcpjsonServers as unknown[]).filter((x): x is string => typeof x === "string") : [];
      for (const n of servers) if (!on.includes(n) && !off.includes(n)) (enable.has(n) ? (on.push(n), enabled.push(n)) : (off.push(n), disabled.push(n)));
      if (servers.length || Array.isArray(e.enabledMcpjsonServers)) e.enabledMcpjsonServers = on;
      if (servers.length || Array.isArray(e.disabledMcpjsonServers)) e.disabledMcpjsonServers = off;
      if (JSON.stringify(e) !== before) changed.push(d);
    }
    if (!changed.length) return none;
    const bdir = o.backupDir ?? join(ROOT, "backups");
    mkdirSync(bdir, { recursive: true });
    const bak = join(bdir, `claude.json.${o.now ?? Date.now()}.bak`);
    copyFileSync(file, bak); chmodSync(bak, 0o600);
    const indent = /^\{\n( +)"/.exec(text)?.[1]?.length ?? 2;
    const tmp = `${file}.agentnet-${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, indent) + (text.endsWith("\n") ? "\n" : ""), { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
    return { changed, enabled: [...new Set(enabled)], disabled: [...new Set(disabled)] };
  } catch (e) {
    return { ...none, error: (e as Error).message };
  }
}
