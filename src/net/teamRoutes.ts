// Teams v1 HTTP surface. One handler set, mounted twice: under /agentnet (agent token or loopback = root) and under /agentnet-panel
// (panel auth, acts as root). Creating, editing, archiving and changing members is root only; members and the lead use the channel and the board.
import type { Hono, Context } from "hono";
import { db } from "../core/db";
import { problem, type Env } from "../core/http";
import { audit } from "../core/logger";
import { flush, ensureSchema } from "./store";
import { ADMIN, BODY_MAX, body, bad, enqueueMessage, isRoot, kindOf, nameMap, releaseBoss, resolveTo, subjectOf, syncBosses, type Ctx } from "./routes";
import { addMember, addTeamTask, archiveTeam, createTeam, getTeam, getTeamTask, isMember, listTeams, removeMember, setTeamTask, teamTasks, updateTeam, NAME_RE, type Team } from "./teams";

type A = Parameters<typeof enqueueMessage>[0];
const CHANNEL_KEEP = 80;

/** Channel send: one canonical row (the history, state 'channel') plus one normal queued delivery per member other than the sender. */
export function sendTeam(from: A, teamId: string, text: string, kind: Parameters<typeof enqueueMessage>[3], subject: string, now = Date.now()):
  { id?: number; team?: string; delivered?: number; held?: number; gone?: string[]; error?: string; status: 403 | 404 | 422 | 200 } {
  ensureSchema();
  const t = getTeam(teamId); if (!t || t.state !== "active") return { error: `no active team ${teamId}`, status: 404 };
  if (!isRoot(from) && !isMember(t.id, from.name)) return { error: "only team members may post in the channel", status: 403 };
  if (!text.trim()) return { error: "body is empty", status: 422 };
  const r = db().run("INSERT INTO messages (from_agent, to_agent, body, kind, subject, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'channel')", [from.id, "team:" + t.id, text, kind, subject, now]);
  const id = Number(r.lastInsertRowid); let delivered = 0, held = 0; const gone: string[] = [];
  for (const m of t.members) {
    if (m === from.name) continue;
    const to = resolveTo(m); if (!to) { gone.push(m); continue; }
    const out = enqueueMessage(from, to, text, kind, null, `[${t.name}] ${subject}`, now);
    if (out.id == null) { gone.push(m); continue; }
    db().run("UPDATE messages SET channel_id = ? WHERE id = ?", [id, out.id]);
    if (out.state === "held") held++; else delivered++;
  }
  flush();
  return { id, team: t.id, delivered, held, gone, status: 200 };
}

const view = (t: Team) => ({ ...t, tasks: teamTasks(t.id).length, open: teamTasks(t.id).filter((x) => x.status !== "done").length });
function channel(id: string) {
  const names = nameMap();
  const rows = db().query("SELECT * FROM messages WHERE to_agent = ? ORDER BY id DESC LIMIT ?").all("team:" + id, CHANNEL_KEEP) as { id: number; from_agent: string; body: string; kind: string; subject: string | null; created_at: number }[];
  return rows.reverse().map((m) => ({ id: m.id, from: names.get(m.from_agent) ?? m.from_agent, kind: kindOf(m.kind), subject: m.subject ?? subjectOf(undefined, m.body), body: m.body, at: m.created_at }));
}
const detail = (t: Team) => ({ team: t, tasks: teamTasks(t.id), channel: channel(t.id) });
const names = (x: unknown): string[] => (Array.isArray(x) ? x : []).map((n) => String(n)).filter((n) => NAME_RE.test(n)).slice(0, 40);

export function teamRoutes(r: Hono<Env>, actorOf: (c: Context) => A, base = "/teams") {
  const guardRoot = (c: Context) => (isRoot(actorOf(c)) ? null : problem(c, 403, "Forbidden", "root only"));
  r.get(base, (c) => c.json({ teams: listTeams(c.req.query("all") === "1").map(view) }));
  r.post(base, async (c) => {
    const no = guardRoot(c); if (no) return no;
    const b = await body(c);
    try {
      const t = createTeam({ name: String(b.name ?? ""), goal: typeof b.goal === "string" ? b.goal : undefined, lead: typeof b.lead === "string" && b.lead ? b.lead : undefined, project: typeof b.project === "string" ? b.project : undefined, members: names(b.members), id: typeof b.id === "string" && b.id ? b.id : undefined });
      syncBosses(t.id);
      audit(`agent:${actorOf(c).name}`, "agentnet.team-create", t.id, "ok", c.get("trace")); return c.json(detail(t), 201);
    } catch (e) { return bad(c, (e as Error).message); }
  });
  r.get(`${base}/:id`, (c) => { const t = getTeam(c.req.param("id")); return t ? c.json(detail(t)) : problem(c, 404, "Not Found", "no such team"); });
  r.post(`${base}/:id`, async (c) => {
    const no = guardRoot(c); if (no) return no;
    const b = await body(c);
    try {
      const t = updateTeam(c.req.param("id"), { name: typeof b.name === "string" ? b.name : undefined, goal: "goal" in b ? (typeof b.goal === "string" ? b.goal : null) : undefined, lead: "lead" in b ? (typeof b.lead === "string" && b.lead ? b.lead : null) : undefined, project: "project" in b ? (typeof b.project === "string" ? b.project : null) : undefined });
      if (t && "lead" in b) syncBosses(t.id); // a new lead: its members report to it
      return t ? c.json(detail(t)) : problem(c, 404, "Not Found", "no such team");
    } catch (e) { return bad(c, (e as Error).message); }
  });
  r.post(`${base}/:id/archive`, (c) => { const no = guardRoot(c); if (no) return no; const t = archiveTeam(c.req.param("id")); return t ? c.json(detail(t)) : problem(c, 404, "Not Found", "no such team"); });
  r.post(`${base}/:id/members`, async (c) => {
    const no = guardRoot(c); if (no) return no;
    const id = c.req.param("id"), b = await body(c); if (!getTeam(id)) return problem(c, 404, "Not Found", "no such team");
    for (const m of names(b.add)) addMember(id, m);
    for (const m of names(b.remove)) { const before = getTeam(id)!; removeMember(id, m); releaseBoss(m, before); }
    syncBosses(id); // joiners report to the lead
    return c.json(detail(getTeam(id)!));
  });
  r.post(`${base}/:id/messages`, async (c) => {
    const a = actorOf(c), b = await body(c), text = typeof b.body === "string" ? b.body : "";
    if (text.length > BODY_MAX) return bad(c, `body over ${BODY_MAX} characters`);
    const out = sendTeam(a, c.req.param("id"), text, kindOf(b.kind), subjectOf(b.subject, text));
    return out.error ? problem(c, out.status, "Can't do that", out.error) : c.json(out);
  });
  // ----- board: team-level tasks with an owner -----
  const canBoard = (a: A, t: Team) => isRoot(a) || isMember(t.id, a.name);
  r.post(`${base}/:id/tasks`, async (c) => {
    const a = actorOf(c), t = getTeam(c.req.param("id")), b = await body(c);
    if (!t) return problem(c, 404, "Not Found", "no such team");
    if (!canBoard(a, t)) return problem(c, 403, "Forbidden", "team members only");
    const titles = (Array.isArray(b.titles) ? b.titles : [b.text ?? b.title]).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
    if (!titles.length) return bad(c, "text or titles required");
    const owner = typeof b.owner === "string" && b.owner ? b.owner : null;
    if (owner && !t.members.includes(owner)) return bad(c, `${owner} is not in the team`);
    for (const x of titles) addTeamTask(t.id, x, owner);
    return c.json({ tasks: teamTasks(t.id) });
  });
  r.post(`${base}/:id/tasks/:tid/:op`, async (c) => {
    const a = actorOf(c), t = getTeam(c.req.param("id")), op = c.req.param("op"), task = getTeamTask(Number(c.req.param("tid")));
    if (!t || !task || task.team !== t.id) return problem(c, 404, "Not Found", "no such team task");
    if (!["start", "done", "claim"].includes(op)) return bad(c, "op must be start, done or claim");
    if (!canBoard(a, t)) return problem(c, 403, "Forbidden", "team members only");
    const mine = task.owner === a.name || t.lead === a.name || isRoot(a);
    if (op === "claim") { if (task.owner && !mine) return problem(c, 403, "Forbidden", `owned by ${task.owner}`); setTeamTask(task.id, { owner: a.name, status: task.status === "pending" ? "in_progress" : task.status }); }
    else { if (task.owner && !mine) return problem(c, 403, "Forbidden", `owned by ${task.owner}`); setTeamTask(task.id, { status: op === "start" ? "in_progress" : "done", owner: task.owner ?? (isRoot(a) ? null : a.name) }); }
    return c.json({ tasks: teamTasks(t.id) });
  });
}

/** Panel-auth mount (the Agents page): everything under /agentnet-panel/teams acts as root. */
export function agentnetTeamPanelRoutes(api: Hono<Env>) { teamRoutes(api as never, () => ADMIN, "/agentnet-panel/teams"); }
