// Brains page API: the brain inventory (read only, frontmatter only, never the body text) plus how often each brain was
// spawned and its average job grade. Agents and grades store the brain as `soul` = "<name>@v<n>".
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { problem, type Env } from "../core/http";
import { rootOnly } from "../core/access";
import { brainsDir, listBrains } from "./brains";
import { personaOf } from "./arsenal";
import { all } from "./store";
import { scoreDb } from "./scores";

const brainOf = (soul: string | null | undefined): { name: string; v: number } | null => {
  const m = /^([a-z0-9][a-z0-9-]*)@v(\d+)$/.exec(soul ?? "");
  return m ? { name: m[1]!, v: Number(m[2]) } : null;
};

export function brainsView() {
  const inv = listBrains(), uses = new Map<string, number>();
  for (const s of all()) { const b = brainOf(s.soul); if (b) uses.set(b.name, (uses.get(b.name) ?? 0) + 1); }
  const grades = new Map<string, { sum: number; n: number }>();
  try {
    for (const r of scoreDb().query("SELECT soul, grade FROM job_scores WHERE grade IS NOT NULL AND soul LIKE '%@v%'").all() as { soul: string; grade: number }[]) {
      const b = brainOf(r.soul); if (!b) continue;
      const g = grades.get(b.name) ?? { sum: 0, n: 0 }; g.sum += r.grade; g.n++; grades.set(b.name, g);
    }
  } catch { /* no score db: no grades */ }
  return { ...inv, brains: inv.brains.map((b) => { const g = grades.get(b.name); return { ...b, uses: uses.get(b.name) ?? 0, graded: g?.n ?? 0, grade_avg: g ? Math.round((g.sum / g.n) * 10) / 10 : null }; }) };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const q = (x: string) => JSON.stringify(x); // a JSON string is a valid YAML scalar

/** Turn one persona of the catalog into a brain file (STANDARD.md layout, version 1). Never overwrites; commits when the dir is a git repo. */
export function importBrain(catalogId: string, name: string, today = new Date().toISOString().slice(0, 10)): { name: string; file: string; committed: boolean } | { error: string; status: 400 | 404 | 409 } {
  if (!NAME.test(name)) return { error: "name must be lowercase letters, digits and dashes (max 40)", status: 400 };
  const p = personaOf(catalogId);
  if (!p) return { error: `no persona ${catalogId} in the catalog`, status: 404 };
  const dir = brainsDir(), file = join(dir, `${name}.md`);
  if (!existsSync(dir)) return { error: `brains folder ${dir} does not exist`, status: 404 };
  if (existsSync(file)) return { error: `a brain or note named ${name} already exists`, status: 409 }; // case-insensitive disks: DESIGN.md blocks "design" too
  const body = p.body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const desc = (p.entry.description || p.entry.name).replace(/\s+/g, " ").trim().slice(0, 300);
  const fm = ["---", `name: ${name}`, `description: ${q(desc)}`, "version: 1", "changelog:",
    `  - {v: 1, date: ${today}, msg: null, change: ${q(`imported from ${catalogId}`)}}`, "reads: []", "skills: []", "---"].join("\n");
  writeFileSync(file, `${fm}\n${body}\n`, { flag: "wx" });
  let committed = false;
  if (existsSync(join(dir, ".git"))) {
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    committed = git("add", "--", `${name}.md`) && git("commit", "-q", "-m", `brain(${name}): v1 imported from ${catalogId} (agentnet Brains page)`, "--", `${name}.md`);
  }
  return { name, file, committed };
}

export function brainsRoutes(api: Hono<Env>) {
  api.get("/brains", (c) => c.json(brainsView()));
  api.post("/brains/import", rootOnly, async (c) => {
    const b = await c.req.json().catch(() => null) as { catalogId?: unknown; name?: unknown } | null;
    if (typeof b?.catalogId !== "string" || typeof b?.name !== "string") return problem(c, 400, "Bad Request", "catalogId and name needed");
    const r = importBrain(b.catalogId, b.name.trim());
    return "error" in r ? problem(c, r.status, r.status === 409 ? "Conflict" : r.status === 404 ? "Not Found" : "Bad Request", r.error) : c.json(r, 201);
  });
}
