// Pre-accept Claude Code's "do you trust this folder" question for a folder agentnet itself starts the director in.
// Claude Code keeps the answer in <config>/.claude.json: projects["<dir>"].hasTrustDialogAccepted. We merge one flag into that file,
// never overwrite it: parse, set, write a temp file next to it, rename. A copy of the old file goes to the backup folder first.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
