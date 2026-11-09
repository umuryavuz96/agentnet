// Placement: where a new agent lands (name, boss, team) plus its routing (model, effort, soul). One deterministic function, no AI call.
// plan_spawn returns the plan with no side effects; /spawn calls the same function for every field the caller left out, then applies the team part.
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { db } from "../core/db";
import { dir } from "../core/config";
import { ensureSchema, live } from "./store";
import { listTeams, getTeam, TEAM_ID } from "./teams";
import { compactFor, windowTokens } from "./compact";
import { routeSpawn, type RouteInput, type Routed } from "./autoroute";

/** Keywords per role for inferring the role from a job. Key order = tie-break order. */
export const ROLE_KEYWORDS: Record<string, string[]> = {
  doc: ["readme", "docs", "doc", "documentation", "typo", "copy", "changelog"],
  qa: ["test", "tests", "screenshot", "verify", "check"],
  "web-dev": ["ui", "page", "css", "vue", "frontend"],
  backend: ["api", "server", "db", "route", "endpoint"],
  designer: ["logo", "icon", "design"],
  researcher: ["research", "find", "compare", "list"],
  "mobile-dev": ["ios", "swift", "iphone"],
  devops: ["deploy", "launchd", "caddy", "dns", "docker"],
  architect: ["architecture", "plan", "tradeoff"],
  reviewer: ["review", "audit", "diff"],
  lookup: ["locate", "grep", "where"],
};
export interface PlacementConfig { team_by_project: boolean; naming: string; default_role: string; team_suffix: string; role_keywords: Record<string, string[]> }
export const PLACEMENT_DEFAULTS: PlacementConfig = { team_by_project: true, naming: "{role}-{n}", default_role: "backend", team_suffix: "-dev", role_keywords: ROLE_KEYWORDS };
/** $AGENTNET_HOME/config/placement.json; missing keys or a broken file fall back to the defaults. */
export function placementConfig(): PlacementConfig {
  try {
    const f = JSON.parse(readFileSync(process.env.AGENTNET_PLACEMENT_FILE ?? join(dir("config"), "placement.json"), "utf8"));
    const c = { ...PLACEMENT_DEFAULTS };
    if (typeof f.team_by_project === "boolean") c.team_by_project = f.team_by_project;
    if (typeof f.naming === "string" && f.naming.includes("{role}") && f.naming.includes("{n}")) c.naming = f.naming;
    if (typeof f.default_role === "string" && f.default_role) c.default_role = f.default_role;
    if (typeof f.team_suffix === "string" && /^[a-z0-9-]*$/.test(f.team_suffix)) c.team_suffix = f.team_suffix;
    if (f.role_keywords && typeof f.role_keywords === "object") {
      // A role listed in the file replaces its default list; unlisted roles keep theirs. New roles go after the defaults in the tie order.
      const rk: Record<string, string[]> = { ...ROLE_KEYWORDS };
      for (const [r, l] of Object.entries(f.role_keywords)) if (/^[a-z0-9-]+$/.test(r) && Array.isArray(l)) rk[r] = l.filter((w): w is string => typeof w === "string" && !!w.trim()).map((w) => w.trim().toLowerCase());
      c.role_keywords = rk;
    }
    return c;
  } catch { return { ...PLACEMENT_DEFAULTS }; }
}

export interface PlanInput extends Omit<RouteInput, "name"> { name?: string; role?: string; project?: string; boss?: string; team?: string }
export interface TeamPlan { id: string; action: "join" | "create"; lead: string | null; members: string[] }
export interface Plan extends Routed {
  name: string; role: string; boss: string; project: string | null; team: TeamPlan | null; reasons: string[];
  /** Auto-compact window in tokens (the panel setting, per-role override). */
  compactWindow: number;
}

const normPath = (p?: string) => (p ? resolve(p.replace(/^~(?=$|\/)/, homedir())).replace(/\/+$/, "") : null);
const tokens = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/** Role from the job: whole-word matches against each role's keyword list. Most distinct matches wins; a tie goes to the earlier role in the list; no match = the default role. */
export function inferRole(job: string, cfg: PlacementConfig): { role: string; why: string } {
  const jw = tokens(job);
  let best: { role: string; hits: string[] } | null = null;
  for (const [role, kws] of Object.entries(cfg.role_keywords)) {
    const hits = [...new Set(kws)].filter((k) => jw.has(k));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { role, hits };
  }
  return best ? { role: best.role, why: `role ${best.role}: job word${best.hits.length > 1 ? "s" : ""} ${best.hits.map((h) => `"${h}"`).join(", ")}` }
    : { role: cfg.default_role, why: `role ${cfg.default_role}: no job word matched a role keyword; the default` };
}

/** Next free `<role>-N`: no live or unarchived agent and no active-team member has the name. */
export function nextName(role: string, pattern: string): string {
  ensureSchema();
  const taken = new Set((db().query("SELECT name FROM agents WHERE archived_at IS NULL").all() as { name: string }[]).map((r) => r.name));
  for (const t of listTeams()) for (const m of t.members) taken.add(m);
  for (let n = 1; ; n++) { const name = pattern.replace("{role}", role).replace("{n}", String(n)); if (!taken.has(name)) return name; }
}

function placeTeam(name: string, project: string | null, cfg: PlacementConfig, reasons: string[]): { boss: string; team: TeamPlan | null } {
  if (!project) { reasons.push("no team: no project given; boss root"); return { boss: "root", team: null }; }
  if (!cfg.team_by_project) { reasons.push("no team: team-by-project is off; boss root"); return { boss: "root", team: null }; }
  // A team with a lead was formed on purpose (council, root) for one job: only an explicit --team joins it. Auto-join and
  // auto-create use the lead-less project teams only, and leave members of led teams alone (designer-1 landed in the hooks
  // gallery council for an unrelated logo job, 2026-11-09).
  const teams = listTeams(), led = new Set(teams.filter((t) => t.lead).flatMap((t) => t.members));
  const joined = teams.find((t) => !t.lead && t.project && normPath(t.project) === project);
  if (joined) {
    reasons.push(joined.lead ? `joins team ${joined.id} (same project); boss is its lead ${joined.lead}` : `joins team ${joined.id} (same project); it has no lead, boss root`);
    return { boss: joined.lead ?? "root", team: { id: joined.id, action: "join", lead: joined.lead, members: [...joined.members, name] } };
  }
  const other = live().find((s) => s.name !== name && s.name !== "root" && !led.has(s.name) && s.project && normPath(s.project) === project);
  if (other) {
    const base = (basename(project).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") + cfg.team_suffix).slice(0, 40);
    let id = base, k = 2; while (!TEAM_ID.test(id) || getTeam(id)) id = `${base.slice(0, 36)}-${k++}`;
    // No lead: whoever came first is not automatically fit to lead (a QA audit ended up leading a release job). Both keep
    // their own boss and share the board; a lead exists only when someone names one (council spawn, root).
    reasons.push(`new team ${id}: ${other.name} already works on this project; no lead, boss root`);
    return { boss: "root", team: { id, action: "create", lead: null, members: [other.name, name] } };
  }
  reasons.push("no team: nobody else works on this project; boss root");
  return { boss: "root", team: null };
}

/** The plan. No side effects: nothing is created and the pick scripts do not log. Explicit inputs win and say so in `reasons`. */
export async function planSpawn(i: PlanInput, opts: { log?: boolean } = {}): Promise<Plan> {
  const cfg = placementConfig(), reasons: string[] = [];
  const project = normPath(i.project);
  let name = i.name, role: string;
  if (name) { role = name.replace(/-\d+$/, ""); reasons.push(`name ${name}: explicit`); }
  else {
    if (i.role) { role = i.role; reasons.push(`role ${role}: explicit`); }
    else { const r = inferRole(i.job ?? "", cfg); role = r.role; reasons.push(r.why); }
    name = nextName(role, cfg.naming); reasons.push(`name ${name}: next free ${role} number`);
  }
  let boss: string, team: TeamPlan | null;
  if (i.team) {
    const t = getTeam(i.team);
    team = t ? { id: t.id, action: "join", lead: t.lead, members: [...t.members, name] } : null;
    boss = i.boss ?? (t?.lead ?? "root");
    reasons.push(`team ${i.team}: explicit${t ? "" : " (unknown id, ignored)"}`);
    if (i.boss) reasons.push(`boss ${i.boss}: explicit`);
  } else {
    const p = placeTeam(name, project, cfg, reasons);
    team = p.team; boss = i.boss ?? p.boss;
    if (i.boss) reasons.push(`boss ${i.boss}: explicit`);
  }
  // A member of a team with a lead reports to that lead, whatever boss was asked for (the lead itself keeps its own boss).
  if (team?.lead && team.lead !== name && boss !== team.lead) { reasons.push(`boss ${team.lead}: lead of team ${team.id}${i.boss ? ` (overrides explicit ${i.boss})` : ""}`); boss = team.lead; }
  const routed = await routeSpawn({ ...i, name, noLog: !(opts.log ?? false) });
  if (i.model) reasons.push(`model ${i.model}: explicit`); else if (routed.model) reasons.push(`model ${routed.model}, effort ${routed.effort}: routed`);
  if (i.soul) reasons.push(`soul ${i.soul}: explicit`); else if (routed.soul) reasons.push(`soul ${routed.soul}: routed`);
  return { ...routed, name, role, boss, project, team, reasons: [...reasons, `compact window ${compactFor(name)}`], compactWindow: windowTokens(compactFor(name)) };
}
