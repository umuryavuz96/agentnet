// Teams v1: a real team record on top of the implicit "same boss" grouping. Data only (no routes): routes.ts imports sameTeam for the
// message rule, teamRoutes.ts builds the HTTP surface. Members are agent NAMES (a respawn keeps its seat). The lead is always a member.
import { db } from "../core/db";
import { ensureSchema } from "./store";

export const TEAM_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
export interface Team { id: string; name: string; goal: string | null; lead: string | null; project: string | null; created: number; state: "active" | "archived"; members: string[] }
export interface TeamTask { id: number; team: string; text: string; owner: string | null; status: "pending" | "in_progress" | "done"; created: number; updated: number }
interface TRow { id: string; name: string; goal: string | null; lead: string | null; project: string | null; created_at: number; state: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const members = (id: string) => (db().query("SELECT agent FROM team_members WHERE team_id = ? ORDER BY added_at, agent").all(id) as { agent: string }[]).map((r) => r.agent);
const toTeam = (r: TRow): Team => ({ id: r.id, name: r.name, goal: r.goal, lead: r.lead, project: r.project, created: r.created_at, state: r.state === "archived" ? "archived" : "active", members: members(r.id) });

export function getTeam(id: string): Team | null { ensureSchema(); const r = db().query("SELECT * FROM teams WHERE id = ?").get(id) as TRow | null; return r ? toTeam(r) : null; }
export function listTeams(all = false): Team[] { ensureSchema(); return (db().query(`SELECT * FROM teams ${all ? "" : "WHERE state = 'active'"} ORDER BY created_at, id`).all() as TRow[]).map(toTeam); }

/** Every new agent and team needs a goal: the outcome that means it is done (not what it does). AGENTNET_REQUIRE_GOAL=0 turns the rule off for old callers. */
export const GOAL_MIN = 8, GOAL_MSG = "goal is required: what does done look like?";
export const goalRequired = () => process.env.AGENTNET_REQUIRE_GOAL !== "0";
/** Null when fine, else the 422 detail. */
export const goalError = (g: unknown): string | null => (!goalRequired() || (typeof g === "string" && g.trim().length >= GOAL_MIN) ? null : GOAL_MSG);
export interface TeamInput { name: string; goal?: string; lead?: string; project?: string; members?: string[]; id?: string }
export function createTeam(i: TeamInput, now = Date.now()): Team {
  ensureSchema();
  const name = i.name.trim(); if (!name || name.length > 60) throw new Error("name is required (max 60 characters)");
  const id = i.id ?? slug(name); if (!TEAM_ID.test(id)) throw new Error("team id must match ^[a-z0-9][a-z0-9-]{1,39}$");
  if (getTeam(id)) throw new Error(`team ${id} exists already`);
  if (i.lead && !NAME_RE.test(i.lead)) throw new Error("lead must be an agent name");
  db().run("INSERT INTO teams (id, name, goal, lead, project, created_at) VALUES (?, ?, ?, ?, ?, ?)", [id, name, i.goal?.slice(0, 500) ?? null, i.lead ?? null, i.project ?? null, now]);
  for (const m of new Set([...(i.lead ? [i.lead] : []), ...(i.members ?? [])])) if (NAME_RE.test(m)) addMember(id, m, now);
  return getTeam(id)!;
}
export function updateTeam(id: string, p: { name?: string; goal?: string | null; lead?: string | null; project?: string | null }): Team | null {
  const t = getTeam(id); if (!t) return null;
  const name = p.name?.trim() || t.name, goal = p.goal === undefined ? t.goal : p.goal?.slice(0, 500) ?? null, lead = p.lead === undefined ? t.lead : p.lead, project = p.project === undefined ? t.project : p.project;
  if (lead && !NAME_RE.test(lead)) throw new Error("lead must be an agent name");
  db().run("UPDATE teams SET name = ?, goal = ?, lead = ?, project = ? WHERE id = ?", [name, goal, lead, project, id]);
  if (lead) addMember(id, lead);
  return getTeam(id);
}
export function archiveTeam(id: string): Team | null { if (!getTeam(id)) return null; db().run("UPDATE teams SET state = 'archived' WHERE id = ?", [id]); return getTeam(id); }
export function addMember(id: string, agent: string, now = Date.now()) { db().run("INSERT OR IGNORE INTO team_members (team_id, agent, added_at) VALUES (?, ?, ?)", [id, agent, now]); }
export function removeMember(id: string, agent: string) { db().run("DELETE FROM team_members WHERE team_id = ? AND agent = ?", [id, agent]); const t = getTeam(id); if (t?.lead === agent) db().run("UPDATE teams SET lead = NULL WHERE id = ?", [id]); }
/** Active teams an agent sits in. */
export function teamsOf(agent: string): Team[] { ensureSchema(); return (db().query("SELECT t.* FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.agent = ? AND t.state = 'active' ORDER BY t.created_at").all(agent) as TRow[]).map(toTeam); }
/** The message rule: two agents may talk, whoever their boss is, when they share an active team (the lead is a member). */
export function sameTeam(a: string, b: string): boolean {
  ensureSchema();
  return !!db().query("SELECT 1 FROM team_members x JOIN team_members y ON y.team_id = x.team_id JOIN teams t ON t.id = x.team_id WHERE x.agent = ? AND y.agent = ? AND t.state = 'active' LIMIT 1").get(a, b);
}
const liveAgent = (name: string) => !!db().query("SELECT 1 FROM agents WHERE name = ? AND archived_at IS NULL").get(name);
/** Teams where `agent` is a non-lead member of a team that has a live lead: the lead is the only door into them for outsiders.
 *  A lead that was despawned (no live agent row) opens no door, so the gate lifts and the boss chain and root reach the members. */
const gatedTeams = (agent: string) => teamsOf(agent).filter((t) => t.lead && t.lead !== agent && liveAgent(t.lead));
/** The lead of the active team `to` belongs to, when `to` is not that lead; else null. */
export const leadGate = (to: string): string | null => gatedTeams(to)[0]?.lead ?? null;
/** Does the lead gate let `from` reach `to`? Yes when `to` is gated by no team, or `from` sits in one of the teams that gate it. */
export function gatePasses(from: string, to: string): boolean {
  const g = gatedTeams(to);
  return !g.length || g.some((t) => t.members.includes(from));
}
export const isMember = (id: string, agent: string) => !!db().query("SELECT 1 FROM team_members WHERE team_id = ? AND agent = ?").get(id, agent);

// ---------- board ----------
const toTask = (r: { id: number; team_id: string; text: string; owner: string | null; status: string; created_at: number; updated_at: number }): TeamTask =>
  ({ id: r.id, team: r.team_id, text: r.text, owner: r.owner, status: r.status === "done" ? "done" : r.status === "in_progress" ? "in_progress" : "pending", created: r.created_at, updated: r.updated_at });
export const teamTasks = (id: string): TeamTask[] => (db().query("SELECT * FROM team_tasks WHERE team_id = ? ORDER BY id").all(id) as never[]).map(toTask);
export function addTeamTask(id: string, text: string, owner: string | null, now = Date.now()): TeamTask {
  const r = db().run("INSERT INTO team_tasks (team_id, text, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [id, text.trim().slice(0, 300), owner, now, now]);
  return teamTasks(id).find((t) => t.id === Number(r.lastInsertRowid))!;
}
export const getTeamTask = (tid: number): TeamTask | null => { const r = db().query("SELECT * FROM team_tasks WHERE id = ?").get(tid) as never; return r ? toTask(r) : null; };
export function setTeamTask(tid: number, p: { status?: TeamTask["status"]; owner?: string | null }, now = Date.now()): TeamTask | null {
  const t = getTeamTask(tid); if (!t) return null;
  db().run("UPDATE team_tasks SET status = ?, owner = ?, updated_at = ? WHERE id = ?", [p.status ?? t.status, p.owner === undefined ? t.owner : p.owner, now, tid]);
  return getTeamTask(tid);
}
