// Personas ("arsenal"): the vendored persona catalog (catalog.json), role defaults (roles.json) and the soul-routing log.
// The page reads the catalog and edits only roles.json; the persona files are never written here.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { dir } from "../core/config";
import { problem, type Env } from "../core/http";
import { rootOnly } from "../core/access";
import { wsCatalog, wsDir, wsPersona, wsRoles } from "./workspace";

const ARS = () => process.env.AGENTNET_ARSENAL_DIR ?? process.env.ARSENAL_DIR ?? join(import.meta.dir, "..", "..", "arsenal"); // default: the catalogue shipped in this repo
const LOG = () => process.env.AGENTNET_SOUL_LOG ?? process.env.SOUL_LOG ?? join(dir("logs"), "soul-routing.jsonl");
const j = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

export interface Entry { id: string; name: string; repo: string; path: string; source_url?: string; stars: number; licence: string; category: string; description: string; tools: string[]; model_hint: string | null; tags: string[]; review?: { status: string; note?: string }; workspace?: true; project?: string; role?: string; source?: string; sourceSha?: string; run?: string }
export interface RoleDef { default: string; alternates?: string[]; categories?: string[] }
export interface Roles { version?: number; roles: Record<string, RoleDef> }
export interface SoulDecision { ts: string; agent: string; role: string; job: string; ask: string; soul: string; score: number; kw: number; reason: string }

export function loadCatalog(): { generated: string | null; agents: Entry[] } {
  const c = j(join(ARS(), "catalog.json"));
  const agents: Entry[] = Array.isArray(c?.agents) ? c.agents.filter((a: any) => a && typeof a.id === "string").map((a: any) => ({
    id: a.id, name: String(a.name ?? a.id), repo: String(a.repo ?? ""), path: String(a.path ?? ""), source_url: a.source_url, stars: Number(a.stars ?? 0), licence: String(a.licence ?? ""),
    category: String(a.category ?? "general"), description: String(a.description ?? ""), tools: Array.isArray(a.tools) ? a.tools.map(String) : [], model_hint: a.model_hint ?? null,
    tags: Array.isArray(a.tags) ? a.tags.map(String) : [], review: a.review })) : [];
  const ws: Entry[] = wsCatalog().filter((a) => !agents.some((x) => x.id === a.id)); // workspace souls come after the shipped ones, never replace them
  return { generated: c?.generated ?? null, agents: [...agents, ...ws] };
}
const shippedRoles = (): Roles => { const r = j(join(ARS(), "roles.json")); return r && typeof r.roles === "object" ? r : { roles: {} }; };
/** Shipped role defaults plus workspace roles; a shipped role is never replaced by a workspace one. */
export const loadRoles = (): Roles => { const r = shippedRoles(); return { ...r, roles: { ...wsRoles(), ...r.roles } }; };

/** Persona text of one catalog entry; the path must stay inside the arsenal folder. */
export function personaOf(id: string): { entry: Entry; body: string } | null {
  const entry = loadCatalog().agents.find((a) => a.id === id);
  if (!entry) return null;
  if (entry.workspace) { const w = wsPersona(id); return w ? { entry, body: w.body } : null; } // confined to the workspace folder
  const root = resolve(ARS()), f = resolve(root, entry.path);
  if (!f.startsWith(root + sep) || !existsSync(f)) return null;
  return { entry, body: readFileSync(f, "utf8").slice(0, 200_000) };
}

export function checkRoles(r: unknown, ids: Set<string>): string | null {
  const roles = (r as Roles)?.roles;
  if (!roles || typeof roles !== "object") return "roles object needed";
  for (const [name, d] of Object.entries<RoleDef>(roles)) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return `role name ${name} is not valid`;
    if (typeof d?.default !== "string" || !ids.has(d.default)) return `${name}: default ${String(d?.default)} is not in the catalog`;
    if (d.alternates && (!Array.isArray(d.alternates) || d.alternates.some((x) => !ids.has(x)))) return `${name}: an alternate is not in the catalog`;
    if (d.categories && (!Array.isArray(d.categories) || d.categories.some((x) => typeof x !== "string"))) return `${name}: categories must be text`;
  }
  return null;
}
export function saveRoles(r: Roles): Roles {
  const err = checkRoles(r, new Set(loadCatalog().agents.map((a) => a.id)));
  if (err) throw new Error(err);
  const wsr = new Set(Object.keys(wsRoles()).filter((k) => !(k in shippedRoles().roles)));
  const clean: Roles = { version: 1, roles: Object.fromEntries(Object.entries(r.roles).filter(([k]) => !wsr.has(k)).map(([k, d]) => [k, { default: d.default, alternates: d.alternates ?? [], categories: d.categories ?? [] }])) };
  const f = join(ARS(), "roles.json");
  if (existsSync(f)) copyFileSync(f, f + ".bak-agentnet");
  const t = f + ".tmp-agentnet";
  writeFileSync(t, JSON.stringify(clean, null, 2));
  JSON.parse(readFileSync(t, "utf8"));
  renameSync(t, f);
  return clean;
}

export function soulDecisions(limit = 40): SoulDecision[] {
  try {
    return readFileSync(LOG(), "utf8").split("\n").filter(Boolean).slice(-limit).reverse().map((l) => { try { const x = JSON.parse(l); return { ts: x.ts, agent: x.agent ?? "", role: x.role ?? "", job: x.job ?? "", ask: x.ask ?? "", soul: x.soul ?? "", score: x.score ?? 0, kw: x.kw ?? 0, reason: x.reason ?? "" }; } catch { return null; } }).filter((x): x is SoulDecision => !!x);
  } catch { return []; }
}

export function arsenalRoutes(api: Hono<Env>) {
  api.get("/arsenal", (c) => {
    const cat = loadCatalog();
    return c.json({ generated: cat.generated, agents: cat.agents, roles: loadRoles().roles, decisions: soulDecisions(), sources: j(join(ARS(), "sources.json")) ?? null });
  });
  api.get("/arsenal/agent", (c) => {
    const p = personaOf(c.req.query("id") ?? "");
    return p ? c.json(p) : problem(c, 404, "Not Found", "no such persona");
  });
  api.put("/arsenal/roles", rootOnly, async (c) => {
    const body = await c.req.json().catch(() => null) as Roles | null;
    try { return c.json({ roles: saveRoles(body as Roles).roles }); } catch (e) { return problem(c, 400, "Bad Request", String((e as Error).message)); }
  });
}
