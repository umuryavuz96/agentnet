// Brains: a small, fixed inventory of agent definitions the owner keeps outside this repo (default ~/.agents/brains,
// override AGENTNET_BRAINS_DIR). Each brain is a Claude Code subagent-format file `<name>.md` (YAML frontmatter + body)
// with extra fields `version`, `reads` and `skills`. Selection is deterministic: an explicit brain, else the role in
// index.json `roles`, else the role's last dash word, else index.json `default`. No index.json = brains are off.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const brainsDir = () => process.env.AGENTNET_BRAINS_DIR ?? join(homedir(), ".agents", "brains");
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Brain { name: string; version: number; id: string; text: string; why: string }
/** A named or mapped brain whose file is missing or broken: the spawn is refused (the inventory is small, so this is a bug). */
export class BrainError extends Error {}

interface Index { roles: Record<string, string>; default?: string }
function index(): Index | null {
  const f = join(brainsDir(), "index.json");
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    return { roles: j && typeof j.roles === "object" && j.roles ? j.roles : {}, default: typeof j.default === "string" ? j.default : undefined };
  } catch (e) { throw new BrainError(`brains index.json unreadable: ${(e as Error).message}`); }
}

const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
/** One brain file split into its frontmatter fields and body. Throws BrainError when missing or broken. */
function readBrain(name: string) {
  if (!NAME.test(name)) throw new BrainError(`brain name must be lowercase letters, digits, dashes: ${name}`);
  const f = join(brainsDir(), `${name}.md`);
  if (!existsSync(f)) throw new BrainError(`brain '${name}' not found in ${brainsDir()}`);
  const raw = readFileSync(f, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new BrainError(`brain '${name}' has no frontmatter`);
  let fm: Record<string, unknown>;
  try { fm = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>; } catch (e) { throw new BrainError(`brain '${name}' frontmatter: ${(e as Error).message}`); }
  const version = Number(fm.version);
  if (!Number.isInteger(version) || version < 1) throw new BrainError(`brain '${name}' needs an integer version >= 1`);
  return { fm, version, body: m[2]!, reads: list(fm.reads), skills: list(fm.skills) };
}

/** Lessons kept in the brain file (candidates and kept ones load alike; the batched eval decides). Off unless AGENTNET_BRAIN_LESSONS=1. */
function lessonsText(x: unknown): string {
  if (process.env.AGENTNET_BRAIN_LESSONS !== "1" || !Array.isArray(x)) return "";
  const l = x.map((e) => (e && typeof e === "object" ? String((e as { text?: unknown }).text ?? "").trim() : "")).filter(Boolean);
  return l.length ? `\n## Lessons\n${l.map((t) => `- ${t}`).join("\n")}\n` : "";
}

/** Parse one brain file into the text that goes first in the agent's appended system prompt. */
export function loadBrain(name: string): Omit<Brain, "why"> {
  const { fm, version, body, reads, skills } = readBrain(name);
  const head = [`# Brain: ${name} v${version}`, typeof fm.description === "string" ? fm.description : "",
    reads.length ? `Read these before any work: ${reads.join(", ")}.` : "",
    skills.length ? `Load these skills with the Skill tool before the work they cover: ${skills.join(", ")}.` : ""].filter(Boolean);
  return { name, version, id: `${name}@v${version}`, text: `${head.join("\n")}\n\n${body.trim()}\n${lessonsText(fm.lessons)}` };
}

/** The brain for a spawn, or null when brains are off (no index.json). */
export function pickBrain(role: string, explicit?: string): Brain | null {
  if (explicit) return { ...loadBrain(explicit), why: `brain ${explicit}: explicit` };
  const idx = index(); if (!idx) return null;
  const last = role.split("-").pop() ?? role;
  const [name, why] = idx.roles[role] ? [idx.roles[role]!, `role ${role}`]
    : idx.roles[last] ? [idx.roles[last]!, `role word ${last}`]
    : idx.default ? [idx.default, "default"] : [null, ""];
  if (!name) return null;
  const b = loadBrain(name);
  return { ...b, why: `brain ${b.id}: ${why}` };
}

export interface BrainChange { v: number | null; date: string | null; source: string | null; change: string }
export interface BrainInfo { name: string; version: number | null; description: string; changelog: BrainChange[]; reads: string[]; skills: string[]; lines: number; roles: string[]; error?: string }
/** The inventory for the panel: every lowercase `<name>.md` in the brains dir (DESIGN.md and other notes are skipped), frontmatter only.
 *  A broken brain is listed with `error` instead of failing the whole list. Newest changelog entry first. */
export function listBrains(): { dir: string; default: string | null; roles: Record<string, string>; brains: BrainInfo[]; error?: string } {
  const d = brainsDir();
  let idx: Index | null = null, error: string | undefined;
  try { idx = index(); } catch (e) { error = (e as Error).message; }
  const roles = idx?.roles ?? {};
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => f.endsWith(".md") && NAME.test(f.slice(0, -3))).sort(); } catch { /* no dir: empty list */ }
  const brains = files.map((f): BrainInfo => {
    const name = f.slice(0, -3), mine = Object.keys(roles).filter((r) => roles[r] === name).sort();
    try {
      const { fm, version, body, reads, skills } = readBrain(name);
      const changelog = (Array.isArray(fm.changelog) ? fm.changelog : []).map((c): BrainChange => {
        const o = (c && typeof c === "object" ? c : { change: String(c) }) as Record<string, unknown>;
        const src = o.msg != null ? `msg ${o.msg}` : o.grade != null ? `grade ${o.grade}` : o.source != null ? String(o.source) : null;
        return { v: Number.isFinite(Number(o.v)) ? Number(o.v) : null, date: o.date != null ? String(o.date) : null, source: src, change: String(o.change ?? "") };
      }).sort((a, b) => (b.v ?? 0) - (a.v ?? 0));
      return { name, version, description: typeof fm.description === "string" ? fm.description : "", changelog, reads, skills, lines: body.trim() ? body.trim().split("\n").length : 0, roles: mine };
    } catch (e) { return { name, version: null, description: "", changelog: [], reads: [], skills: [], lines: 0, roles: mine, error: (e as Error).message }; }
  });
  return { dir: d, default: idx?.default ?? null, roles, brains, ...(error ? { error } : {}) };
}
