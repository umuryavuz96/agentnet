// Workspace souls: personas generated from a repo's own agent definition (or a stub that points at its CLAUDE.md).
// They live in $AGENTNET_HOME/workspace, never in the vendored arsenal, so the shipped catalog is never written.
// arsenal.ts merges these files after the shipped ones; scripts/spawn-agent.sh and pick-soul.sh read them too.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../core/config";
import { allowedRead } from "./adopt-safe";

export const wsDir = (): string => process.env.AGENTNET_WORKSPACE_DIR ?? join(ROOT, "workspace");
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;

export interface WsEntry {
  id: string; name: string; repo: string; path: string; stars: number; licence: string; category: string; description: string;
  tools: string[]; model_hint: string | null; tags: string[]; review: { status: string; note?: string };
  workspace: true; project: string; role?: string; source: string; sourceSha: string; run: string;
}
interface WsRoles { version: number; roles: Record<string, { default: string; alternates: string[]; categories: string[] }> }
export interface SoulInput { repo: string; name: string; source: "agent-def" | "claude-md"; defFile?: string }
export interface RegisterResult { created: string[]; entries: WsEntry[]; roleClash: string[]; errors: string[] }

const j = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
export function wsCatalog(dir = wsDir()): WsEntry[] {
  const c = j(join(dir, "catalog.json"));
  return Array.isArray(c?.agents) ? c.agents.filter((a: any) => a && typeof a.id === "string" && a.id.startsWith("ws/") && a.workspace === true) : [];
}
export function wsRoles(dir = wsDir()): WsRoles["roles"] {
  const r = j(join(dir, "roles.json"));
  return r && typeof r.roles === "object" && r.roles ? r.roles : {};
}
function writeJson(f: string, v: unknown): void {
  mkdirSync(dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  writeFileSync(t, JSON.stringify(v, null, 2) + "\n");
  renameSync(t, f);
}

/** Front matter of a definition: name, description, tools, model. Body = the rest. A small reader for the flat keys agent files use. */
export function parseDef(text: string): { fm: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, string> = {};
  for (const l of m[1]!.split(/\r?\n/)) { const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(l); if (k) fm[k[1]!.toLowerCase()] = k[2]!.trim().replace(/^["']|["']$/g, ""); }
  return { fm, body: text.slice(m[0].length).trim() };
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const list = (s?: string): string[] => (s ? s.replace(/^\[|\]$/g, "").split(",").map((x) => x.trim()).filter(Boolean) : []);

/** Build one soul body. agent-def: the definition body plus a repo line. claude-md: a stub that points at the repo's CLAUDE.md. */
export function soulBody(i: SoulInput, defText?: string): string {
  if (i.source === "agent-def" && defText !== undefined) return `${parseDef(defText).body}\n\nYour repo is ${i.repo}. Work there.\n`;
  return `You are the ${i.name} agent for the repository at ${i.repo}. Read and follow ${join(i.repo, "CLAUDE.md")} for every rule about this repo. Coordination (messages, tasks, reports) goes through agentnet only.\n\nYour repo is ${i.repo}. Work there.\n`;
}

/** Register workspace souls. Creates souls/<name>.md and catalog/roles entries; source files are only read. A name that is also a shipped role
 *  gets a catalog entry but no role mapping (roleClash). A bad input is skipped and reported, the rest go on. */
export function registerSouls(inputs: SoulInput[], o: { runId: string; builtinRoles?: string[]; dir?: string }): RegisterResult {
  const dir = o.dir ?? wsDir(), res: RegisterResult = { created: [], entries: [], roleClash: [], errors: [] };
  const cat = wsCatalog(dir), roles = wsRoles(dir), builtin = new Set(o.builtinRoles ?? []);
  for (const i of inputs) {
    if (!AGENT_NAME.test(i.name)) { res.errors.push(`${i.name}: not a valid agent name`); continue; }
    const repo = resolve(i.repo);
    let defText: string | undefined, source = join(repo, "CLAUDE.md");
    if (i.source === "agent-def") {
      const f = i.defFile ? resolve(i.defFile) : "";
      if (!f || !(f + sep).startsWith(repo + sep) || !allowedRead(f, [repo])) { res.errors.push(`${i.name}: definition file is missing or not readable inside ${repo}`); continue; }
      defText = readFileSync(f, "utf8"); source = f;
    }
    const { fm } = parseDef(defText ?? "");
    const rel = `souls/${i.name}.md`, id = `ws/${i.name}`;
    const clash = builtin.has(i.name);
    if (clash) res.roleClash.push(i.name);
    const body = soulBody({ ...i, repo }, defText);
    const soulFile = join(dir, rel);
    mkdirSync(dirname(soulFile), { recursive: true });
    writeFileSync(soulFile, body, { mode: 0o600 });
    const entry: WsEntry = {
      id, name: i.name, repo: basename(repo), path: rel, stars: 0, licence: "user", category: "workspace",
      description: fm.description || `Workspace agent for ${repo}`, tools: list(fm.tools), model_hint: fm.model || null,
      tags: [...new Set([basename(repo).toLowerCase(), i.name, ...list(fm.tags)])], review: { status: "user-approved", note: `registered by run ${o.runId}` },
      workspace: true, project: repo, ...(clash ? {} : { role: i.name }), source, sourceSha: sha(defText ?? ""), run: o.runId,
    };
    const at = cat.findIndex((a) => a.id === id);
    if (at >= 0) cat[at] = entry; else cat.push(entry);
    if (!clash) roles[i.name] = { default: id, alternates: [], categories: [] };
    if (!res.created.includes(soulFile)) res.created.push(soulFile);
    res.entries.push(entry);
  }
  if (res.entries.length) { writeJson(join(dir, "catalog.json"), { version: 1, agents: cat }); writeJson(join(dir, "roles.json"), { version: 1, roles }); res.created.push(join(dir, "catalog.json"), join(dir, "roles.json")); }
  return res;
}

/** Rollback: drop the entries, role mappings and soul files of the given run (or all when no run). Deletes the catalog/roles files when they end up empty. */
export function removeSouls(o: { runId?: string; dir?: string } = {}): string[] {
  const dir = o.dir ?? wsDir(), cat = wsCatalog(dir), roles = wsRoles(dir), gone: string[] = [];
  const keep = cat.filter((a) => (o.runId ? a.run !== o.runId : false));
  for (const a of cat) if (!keep.includes(a)) {
    const f = resolve(dir, a.path);
    if (f.startsWith(resolve(dir) + sep) && existsSync(f)) { rmSync(f); gone.push(f); }
    for (const [r, d] of Object.entries(roles)) if (d.default === a.id) delete roles[r];
  }
  const cf = join(dir, "catalog.json"), rf = join(dir, "roles.json");
  if (keep.length) { writeJson(cf, { version: 1, agents: keep }); writeJson(rf, { version: 1, roles }); }
  else for (const f of [cf, rf]) if (existsSync(f)) { rmSync(f); gone.push(f); }
  return gone;
}

/** Persona text of a workspace entry, confined to the workspace folder. */
export function wsPersona(id: string, dir = wsDir()): { entry: WsEntry; body: string } | null {
  const entry = wsCatalog(dir).find((a) => a.id === id);
  if (!entry) return null;
  const root = resolve(dir), f = resolve(root, entry.path);
  if (!f.startsWith(root + sep) || !existsSync(f)) return null;
  return { entry, body: readFileSync(f, "utf8").slice(0, 200_000) };
}
/** The workspace role for a name, if any: its default soul and the repo. */
export function wsRoleSoul(role: string, dir = wsDir()): WsEntry | null {
  const d = wsRoles(dir)[role];
  return d ? wsCatalog(dir).find((a) => a.id === d.default) ?? null : null;
}
