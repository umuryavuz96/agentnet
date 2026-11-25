// Lesson migration, DRY RUN only (docs/internal/SPEC-brain-evals.md 15.6): reads every per-agent lesson, drops duplicates, finds the
// agent's brain from its latest job_scores.soul, classifies a theme, flags project-specific lessons, prints brain x theme x count.
// Writes nothing unless --write DIR: then it copies the brains folder to DIR (never the live one) and adds the candidates to each brain file's `lessons:` frontmatter.
// Usage: bun scripts/evals/migrate-lessons.ts [--home DIR] [--list] [--write DIR]
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const i = process.argv.indexOf("--home");
const HOME = i > 0 ? process.argv[i + 1]! : process.env.AGENTNET_HOME ?? join(homedir(), ".local", "share", "agentnet");
export const THEMES: [string, RegExp][] = [
  ["proof", /\b(proof|screenshot|evidence|quote|"?0 failures"?|PASS line|not tested|verified?|re-?run)\b/i],
  ["layout", /\b(ui-check|layout|1920|390|scroll|shots?|viewport|cut[- ]?off|overflow)\b/i],
  ["numbers", /\b(numbers?|measured|figures?|sum|count|total|percent|USD)\b/i],
  ["scope", /\b(scope|exactly|only what|extra|brief|acceptance criteria|restate)\b/i],
  ["process", /\b(plan|step|status|report|commit|despawn|checkpoint|close)\b/i],
  ["tooling", /\b(test|build|typecheck|lint|install|restart|server|port)\b/i],
  ["communication", /\b(ask|question|send|message|reply|options?)\b/i],
];
export const themeOf = (t: string) => THEMES.find(([, re]) => re.test(t))?.[0] ?? "other";
/** A lesson that names a project, a file path or a file name is project specific: it stays out of the brain text. */
export function projectSpecific(t: string, projects: string[]) {
  return /\b(3d office|fault \d+|desk-facing)\b/i.test(t) || projects.some((p) => p.length > 3 && new RegExp(`\\b${p.replace(/[^a-z0-9]+/gi, "[ -]?")}\\b`, "i").test(t)) || /\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(ts|vue|js|css|md|json|sh|py)\b/.test(t);
}
const strip = (t: string) => t.replace(/^(Don't|Upgrade not followed|Owner complaint):\s*/i, "").replace(/\s*\((reward|baseline)[^)]*\)\s*$/i, "").trim();
const norm = (t: string) => t.replace(/\s*\((reward|baseline)[^)]*\)\s*/gi, " ").replace(/^(Don't|Upgrade not followed|Owner complaint):\s*/i, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

if (import.meta.main) {
  const db = new Database(join(HOME, "data", "agent-scores.db"), { readonly: true });
  const soulOf = new Map<string, string>(); // line (agent name) -> latest soul
  for (const r of db.query("SELECT agent, soul FROM job_scores WHERE soul LIKE '%@v%' ORDER BY closed_at").all() as { agent: string; soul: string }[]) soulOf.set(r.agent, r.soul);
  const projects = [...new Set((db.query("SELECT DISTINCT project FROM job_scores WHERE project IS NOT NULL").all() as { project: string }[]).map((r) => basename(r.project)))];
  const raw: { line: string; text: string }[] = [];
  const lines = join(HOME, "lines");
  if (existsSync(lines)) for (const l of readdirSync(lines)) {
    const self = join(lines, l, "self"); if (!existsSync(self)) continue;
    for (const v of readdirSync(self)) { const f = join(self, v, "lessons.md"); if (existsSync(f)) for (const t of readFileSync(f, "utf8").split("\n")) if (t.trim()) raw.push({ line: l, text: t.trim() }); }
  }
  for (const r of db.query("SELECT line, lesson FROM line_versions WHERE lesson IS NOT NULL AND lesson != ''").all() as { line: string; lesson: string }[]) raw.push({ line: r.line, text: r.lesson.trim() });
  const seen = new Set<string>(), kept: { brain: string; theme: string; text: string; line: string }[] = [];
  let dup = 0, spec = 0, nobrain = 0, skipped = 0;
  for (const r of raw) {
    const k = norm(r.text); if (!k || seen.has(k)) { dup++; continue; } seen.add(k);
    if (projectSpecific(r.text, projects)) { spec++; continue; }
    const brain = soulOf.get(r.line)?.split("@")[0]; if (!brain) { nobrain++; continue; }
    if (/^Upgrade not followed:/i.test(r.text)) skipped++;
    kept.push({ brain, theme: themeOf(r.text), text: strip(r.text), line: r.line });
  }
  console.log(`read ${raw.length} lesson lines; duplicates dropped ${dup}; project-specific flagged ${spec}; no brain found ${nobrain}; candidates ${kept.length} (${skipped} came from skipped upgrades)`);
  const t = new Map<string, number>(); for (const k of kept) t.set(`${k.brain}\t${k.theme}`, (t.get(`${k.brain}\t${k.theme}`) ?? 0) + 1);
  console.log("brain\ttheme\tcount"); for (const [k, v] of [...t].sort()) console.log(`${k}\t${v}`);
  if (process.argv.includes("--list")) for (const k of kept) console.log(`- [${k.brain}/${k.theme}] ${k.text.slice(0, 140)}`);
  const w = process.argv.indexOf("--write");
  if (w > 0) {
    const out = process.argv[w + 1]!, src = process.env.AGENTNET_BRAINS_DIR ?? join(homedir(), ".agents", "brains");
    if (out === src) throw new Error("refusing to write into the source brains folder");
    cpSync(src, out, { recursive: true });
    for (const b of new Set(kept.map((k) => k.brain))) {
      const f = join(out, `${b}.md`); if (!existsSync(f)) continue;
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readFileSync(f, "utf8")); if (!m) continue;
      const items = kept.filter((k) => k.brain === b).map((k, n) => `  - ${JSON.stringify({ id: `${b}-l${n + 1}`, text: k.text, theme: k.theme, origin_line: k.line, status: "candidate", added: "2026-11-24" })}`);
      writeFileSync(f, `---\n${m[1]}\nlessons:\n${items.join("\n")}\n---\n${m[2]}`);
    }
    console.log(`wrote candidates into a copy: ${out}`);
  }
}
