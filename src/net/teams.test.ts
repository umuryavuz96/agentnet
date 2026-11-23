import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase, db } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const tr = await import("./teamRoutes");
const tm = await import("./teams");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); tr.agentnetTeamPanelRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const panel = (method: string, path: string, body?: unknown) => app.request(`/api/v1/agentnet-panel${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  // root -> {lead-1, dev-1, dev-2, other-1}; teammates under DIFFERENT bosses so only the team rule lets them talk
  for (const [name, boss] of [["root", null], ["lead-1", "root"], ["dev-1", "lead-1"], ["dev-2", "root"], ["other-1", "root"]] as const) tok[name] = rt.createAgent({ name, boss: boss ?? undefined, job: "t", by: "test" }).token;
});

describe("teams", () => {
  test("only root creates; the lead becomes a member; list and get", async () => {
    expect((await j(await call("dev-1", "POST", "/teams", { name: "Turntable" }))).status).toBe(403);
    const r = await j(await call("root", "POST", "/teams", { name: "Turntable", goal: "ship the 3D turntable", lead: "lead-1", members: ["dev-1", "dev-2"] }));
    expect(r.status).toBe(201); expect(r.body.team.id).toBe("turntable"); expect(r.body.team.members.sort()).toEqual(["dev-1", "dev-2", "lead-1"]);
    expect((await j(await call("root", "POST", "/teams", { name: "Turntable" }))).status).toBe(422); // duplicate id
    expect((await j(await call("dev-1", "GET", "/teams"))).body.teams.length).toBe(1);
    expect((await j(await call("dev-1", "GET", "/teams/turntable"))).body.team.goal).toBe("ship the 3D turntable");
    expect((await j(await call("dev-1", "GET", "/teams/nope"))).status).toBe(404);
  });

  test("message rule: teammates talk across bosses, outsiders still cannot; boss rule is kept", async () => {
    expect((await j(await call("dev-1", "POST", "/send", { to: "dev-2", body: "hello across bosses" }))).status).toBe(200); // dev-1 boss lead-1, dev-2 boss root
    expect((await j(await call("dev-2", "POST", "/send", { to: "lead-1", body: "hi lead" }))).status).toBe(200);
    expect((await j(await call("dev-1", "POST", "/send", { to: "other-1", body: "no" }))).status).toBe(403);
    expect((await j(await call("dev-1", "POST", "/send", { to: "lead-1", body: "boss rule" }))).status).toBe(200);
    await call("root", "POST", "/teams/turntable/members", { remove: ["dev-2"] });
    expect((await j(await call("dev-2", "POST", "/send", { to: "dev-1", body: "removed" }))).status).toBe(403);
    await call("root", "POST", "/teams/turntable/members", { add: ["dev-2"] });
  });

  test("channel: send to team:<id> stores one history row and delivers to every other member", async () => {
    const r = await j(await call("dev-1", "POST", "/send", { to: "team:turntable", body: "rev2 is up", kind: "info", subject: "rev2" }));
    expect(r.status).toBe(200); expect(r.body.delivered).toBe(2);
    const inbox = await j(await call("dev-2", "POST", "/inbox", { peek: true }));
    expect(inbox.body.messages.some((m: { subject: string; body: string }) => m.subject === "[Turntable] rev2" && m.body === "rev2 is up")).toBe(true);
    expect((await j(await call("dev-1", "POST", "/inbox", { peek: true }))).body.messages.some((m: { body: string }) => m.body === "rev2 is up")).toBe(false); // not to the sender
    const t = await j(await call("lead-1", "GET", "/teams/turntable"));
    expect(t.body.channel.length).toBe(1); expect(t.body.channel[0].from).toBe("dev-1");
    expect((await j(await call("other-1", "POST", "/send", { to: "team:turntable", body: "intruder" }))).status).toBe(403);
    expect((await j(await call("root", "POST", "/send", { to: "team:turntable", body: "root may post" }))).status).toBe(200);
    expect((await j(await call("dev-1", "POST", "/send", { to: "team:nope", body: "x" }))).status).toBe(404);
  });

  test("board: team tasks with an owner; claim, start, done", async () => {
    expect((await j(await call("other-1", "POST", "/teams/turntable/tasks", { text: "x" }))).status).toBe(403);
    const add = await j(await call("lead-1", "POST", "/teams/turntable/tasks", { titles: ["model", "materials"], owner: "dev-1" }));
    expect(add.body.tasks.map((t: { owner: string }) => t.owner)).toEqual(["dev-1", "dev-1"]);
    const id = add.body.tasks[1].id;
    expect((await j(await call("dev-2", "POST", `/teams/turntable/tasks/${id}/done`))).status).toBe(403); // owned by dev-1
    expect((await j(await call("dev-1", "POST", `/teams/turntable/tasks/${id}/start`))).body.tasks[1].status).toBe("in_progress");
    expect((await j(await call("dev-1", "POST", `/teams/turntable/tasks/${id}/done`))).body.tasks[1].status).toBe("done");
    const free = await j(await call("dev-2", "POST", "/teams/turntable/tasks", { text: "sound" }));
    const fid = free.body.tasks[2].id;
    expect((await j(await call("dev-2", "POST", `/teams/turntable/tasks/${fid}/claim`))).body.tasks[2].owner).toBe("dev-2");
    expect((await j(await call("dev-1", "POST", "/teams/turntable/tasks", { text: "y", owner: "other-1" }))).status).toBe(422); // owner must be a member
  });

  test("spawn with a team adds the member; an unknown team is ignored; archive ends the rule; panel mount acts as root", async () => {
    expect((await j(await call("root", "POST", "/spawn", { name: "dev-3", boss: "root", team: "turntable" }))).status).toBe(201);
    expect((await j(await call("root", "GET", "/teams/turntable"))).body.team.members).toContain("dev-3");
    expect((await j(await call("root", "POST", "/spawn", { name: "dev-4", boss: "root", team: "agmsg-old-team" }))).status).toBe(201);
    const p = await j(await panel("POST", "/teams", { name: "Panel Team", lead: "dev-4" })); expect(p.status).toBe(201);
    expect((await j(await panel("POST", "/teams/panel-team/messages", { body: "from the panel" }))).body.delivered).toBe(1); // the lead (starting agents queue their inbox)
    const gated = await j(await call("other-1", "POST", "/send", { to: "dev-2", body: "before archive" }));
    expect(gated.status).toBe(403); expect(JSON.stringify(gated.body)).toContain("lead lead-1"); // an outsider goes through the lead
    expect((await j(await call("root", "POST", "/send", { to: "dev-2", body: "root always" }))).status).toBe(200); // root is never gated
    expect((await j(await call("root", "POST", "/teams/turntable/archive"))).body.team.state).toBe("archived");
    expect((await j(await call("root", "POST", "/send", { to: "dev-2", body: "after archive" }))).status).toBe(200); // archived team no longer gates
    expect((await j(await call("dev-1", "GET", "/teams"))).body.teams.map((t: { id: string }) => t.id)).not.toContain("turntable");
  });
});

describe("teams close themselves", () => {
  const mk = (name: string) => { tok[name] = rt.createAgent({ name, boss: "root", job: "t", by: "test" }).token; };
  const state = async (id: string) => (await j(await call("root", "GET", `/teams/${id}`))).body.team.state;
  const despawn = async (name: string) => j(await call("root", "POST", "/despawn", { agent: name }));

  test("the last despawn archives the team; one live member keeps it open; a team with no agent yet stays open", async () => {
    mk("ca-1"); mk("ca-2");
    expect((await j(await call("root", "POST", "/teams", { name: "Closer", members: ["ca-1", "ca-2"] }))).status).toBe(201);
    expect((await j(await call("root", "POST", "/teams", { name: "Waiting", goal: "agents join later", members: ["ca-later-1"] }))).status).toBe(201); // council.sh: team first, agents a moment later
    const first = await despawn("ca-1"); expect(first.status).toBe(200); expect(first.body.teams_archived).toBeUndefined();
    expect(await state("closer")).toBe("active");
    const last = await despawn("ca-2"); expect(last.body.teams_archived).toEqual(["closer"]);
    expect(await state("closer")).toBe("archived");
    expect(await state("waiting")).toBe("active");
    expect((await j(await call("root", "GET", "/teams"))).body.teams.map((t: { id: string }) => t.id)).not.toContain("closer");
  });

  test("a team with a live channel bot (kind member) is not archived when the last agent leaves", async () => {
    rt.createAgent({ name: "ca-chan", boss: "root", job: "t", by: "test", kind: "member" }); mk("ca-3");
    await call("root", "POST", "/teams", { name: "Bot Team", members: ["ca-chan", "ca-3"] });
    expect((await despawn("ca-3")).body.teams_archived).toBeUndefined();
    expect(await state("bot-team")).toBe("active");
  });

  test("a team created with zero agents is not archived by an unrelated despawn", async () => {
    mk("ca-solo");
    await call("root", "POST", "/teams", { name: "Empty Team", goal: "agents join later" });
    await call("root", "POST", "/teams", { name: "Other Team", members: ["ca-solo"] });
    expect((await despawn("ca-solo")).body.teams_archived).toEqual(["other-team"]);
    expect(await state("empty-team")).toBe("active");
  });

  test("the director alone does not keep a team open: members [root, x-1], despawn x-1 -> archived", async () => {
    mk("x-1");
    await call("root", "POST", "/teams", { name: "With Director", members: ["root", "x-1"] });
    expect((await despawn("x-1")).body.teams_archived).toEqual(["with-director"]);
    expect(await state("with-director")).toBe("archived");
  });

  test("an agent joining an archived team brings it back (spawn --team and members add)", async () => {
    mk("ca-4");
    await call("root", "POST", "/teams", { name: "Back", members: ["ca-4"] });
    expect((await despawn("ca-4")).body.teams_archived).toEqual(["back"]);
    expect(await state("back")).toBe("archived");
    expect((await j(await call("root", "POST", "/spawn", { name: "ca-5", boss: "root", team: "back", goal: "come back to life" }))).status).toBe(201);
    expect(await state("back")).toBe("active");
    expect((await despawn("ca-5")).body.teams_archived).toEqual(["back"]);
    mk("ca-6");
    await call("root", "POST", "/teams/back/members", { add: ["ca-6"] });
    expect(await state("back")).toBe("active");
  });

});

describe("member bosses", () => {
  test("team detail carries each member's last boss, also after despawn", async () => {
    const r = await j(await call("root", "POST", "/teams", { name: "Bosses", goal: "check last known bosses", lead: "lead-1", members: ["dev-1"] }));
    expect(r.body.bosses).toEqual({ "lead-1": "root", "dev-1": "lead-1" });
    await call("root", "POST", "/despawn", { name: "dev-1" });
    expect((await j(await call("root", "GET", "/teams/bosses"))).body.bosses["dev-1"]).toBe("lead-1");
  });
});

describe("a reused agent name never inherits an old team", () => {
  const mk = (name: string) => { tok[name] = rt.createAgent({ name, boss: "root", job: "t", by: "test" }).token; };
  const team = async (id: string) => (await j(await call("root", "GET", `/teams/${id}`))).body.team;
  const spawn = async (b: Record<string, unknown>) => j(await call("root", "POST", "/spawn", { boss: "root", goal: "reuse check done", ...b }));
  const despawn = async (name: string) => j(await call("root", "POST", "/despawn", { agent: name }));

  test("spawn wd-1 in team A, despawn it, spawn wd-1 in team B: it is in B only and A does not list it", async () => {
    mk("wd-keep"); // keeps team A open after wd-1 leaves
    await call("root", "POST", "/teams", { name: "Reuse A", goal: "first job", members: ["wd-keep"] });
    expect((await spawn({ name: "wd-1", team: "reuse-a" })).status).toBe(201);
    expect([...(await team("reuse-a")).members].sort()).toEqual(["wd-1", "wd-keep"]);
    await despawn("wd-1");
    const a = await team("reuse-a");
    expect(a.state).toBe("active"); expect(a.members).toEqual(["wd-keep"]); expect(a.past).toEqual(["wd-1"]);
    expect((await spawn({ name: "wd-1", team: "reuse-b" })).status).toBe(201); // reuse-b is new: created by the spawn
    expect((await team("reuse-b")).members).toEqual(["wd-1"]);
    const a2 = await team("reuse-a");
    expect(a2.members).toEqual(["wd-keep"]); expect(a2.past).toEqual(["wd-1"]);
  });

  test("a despawned agent cannot message its old team; the name that comes back to the same team is a member again", async () => {
    mk("wd-peer"); mk("wd-2");
    await call("root", "POST", "/teams", { name: "Reuse C", goal: "talk", members: ["wd-peer", "wd-2"] });
    expect(tm.sameTeam("wd-peer", "wd-2")).toBe(true);
    await despawn("wd-2");
    mk("wd-2"); // same name, different job, no team
    expect(tm.sameTeam("wd-peer", "wd-2")).toBe(false);
    await call("root", "POST", "/teams/reuse-c/members", { add: ["wd-2"] });
    expect(tm.sameTeam("wd-peer", "wd-2")).toBe(true);
    const c = await team("reuse-c"); expect([...c.members].sort()).toEqual(["wd-2", "wd-peer"]); expect(c.past).toEqual([]);
  });

  test("a lead that left leads nobody: a reused lead name opens no gate", async () => {
    mk("wl-1"); mk("wl-m");
    await call("root", "POST", "/teams", { name: "Reuse Led", goal: "led", lead: "wl-1", members: ["wl-m"] });
    expect(tm.leadGate("wl-m")).toBe("wl-1");
    await despawn("wl-1");
    mk("wl-1");
    expect(tm.leadGate("wl-m")).toBeNull();
  });
});

describe("spawn --team <new id> creates the team", () => {
  const spawn = async (b: Record<string, unknown>) => j(await call("root", "POST", "/spawn", { goal: "new team check", ...b }));
  const team = async (id: string) => (await j(await call("root", "GET", `/teams/${id}`))).body.team;

  test("id, name, goal and project come from the spawn; root as boss leaves it lead-less", async () => {
    const r = await spawn({ name: "nt-1", boss: "root", team: "nt-room", goal: "ship the new team", project: "/tmp/nt-project" });
    expect(r.status).toBe(201); expect(r.body.team).toBe("nt-room");
    const t = await team("nt-room");
    expect(t).toMatchObject({ id: "nt-room", name: "nt-room", goal: "ship the new team", project: "/tmp/nt-project", lead: null, members: ["nt-1"], state: "active" });
  });

  test("a boss that is not root leads the new team and is a member", async () => {
    tok["nt-lead"] = rt.createAgent({ name: "nt-lead", boss: "root", job: "t", by: "test" }).token;
    expect((await spawn({ name: "nt-2", boss: "nt-lead", team: "nt-led" })).status).toBe(201);
    const t = await team("nt-led"); expect(t.lead).toBe("nt-lead"); expect([...t.members].sort()).toEqual(["nt-2", "nt-lead"]);
  });

  test("a second spawn into it joins; an id that is no team id is ignored", async () => {
    expect((await spawn({ name: "nt-3", boss: "root", team: "nt-room" })).status).toBe(201);
    expect((await team("nt-room")).members).toEqual(["nt-1", "nt-3"]);
    const r = await spawn({ name: "nt-4", boss: "root", team: "Old Agmsg Team" });
    expect(r.status).toBe(201); expect(r.body.team).toBeNull();
  });
});

describe("stale teams close", () => {
  const mk = (name: string) => { tok[name] = rt.createAgent({ name, boss: "root", job: "t", by: "test" }).token; };
  const retired = (name: string) => { rt.retireAgent(rt.byName(name)!, "replaced"); }; // gone without the despawn hook: the data a pre-fix server left
  const team = async (id: string) => (await j(await call("root", "GET", `/teams/${id}`))).body.team;
  const root = (n: string) => n === "root";

  test("closeStaleTeams moves gone members to past, archives a team with no live member, leaves unspawned names and live members alone; dry run changes nothing", async () => {
    mk("st-live"); mk("st-gone-1"); mk("st-gone-2"); retired("st-gone-1"); retired("st-gone-2");
    await call("root", "POST", "/teams", { name: "Stale Dead", goal: "dead job", members: ["st-gone-1", "st-gone-2"] });
    await call("root", "POST", "/teams", { name: "Stale Mixed", goal: "mixed job", members: ["st-live", "st-gone-1"] });
    await call("root", "POST", "/teams", { name: "Stale Waiting", goal: "waiting job", members: ["st-never-1", "st-gone-2"] });
    const dry = tm.closeStaleTeams(root, { dry: true });
    expect(dry.map((c) => c.team).sort()).toEqual(["stale-dead", "stale-mixed", "stale-waiting"]);
    expect((await team("stale-dead")).members).toEqual(["st-gone-1", "st-gone-2"]); // untouched
    const done = tm.closeStaleTeams(root);
    expect(done.find((c) => c.team === "stale-dead")).toEqual({ team: "stale-dead", left: ["st-gone-1", "st-gone-2"], archived: true });
    expect(done.find((c) => c.team === "stale-mixed")).toEqual({ team: "stale-mixed", left: ["st-gone-1"], archived: false });
    expect(await team("stale-dead")).toMatchObject({ state: "archived", members: [], past: ["st-gone-1", "st-gone-2"] });
    expect(await team("stale-mixed")).toMatchObject({ state: "active", members: ["st-live"], past: ["st-gone-1"] });
    expect(await team("stale-waiting")).toMatchObject({ state: "archived", members: [], past: ["st-gone-2", "st-never-1"] }); // no live member: closed, whoever was planned too
    expect(tm.closeStaleTeams(root)).toEqual([]); // once: a second run finds nothing
  });

  test("an archived team that still lists members (old data, or archived by hand) gets them moved to past, so a reused name is not shown in it", async () => {
    mk("st-reuse-1");
    await call("root", "POST", "/teams", { name: "Stale Old", goal: "finished long ago", members: ["st-reuse-1"] });
    await call("root", "POST", "/teams/stale-old/archive");
    expect(await team("stale-old")).toMatchObject({ state: "archived", members: [], past: ["st-reuse-1"] });
    tm.closeStaleTeams(root); // nothing left to clean
    expect(tm.closeStaleTeams(root).filter((c) => c.team === "stale-old")).toEqual([]);
    db().run("UPDATE team_members SET left_at = NULL WHERE team_id = 'stale-old'"); // the old data: archived, names still listed
    expect(tm.closeStaleTeams(root, { dry: true }).filter((c) => c.team === "stale-old")).toEqual([{ team: "stale-old", left: ["st-reuse-1"], archived: true, was: "archived" }]);
    tm.closeStaleTeams(root);
    expect(await team("stale-old")).toMatchObject({ state: "archived", members: [], past: ["st-reuse-1"] });
  });

  test("a team that never had an agent is never touched", async () => {
    await call("root", "POST", "/teams", { name: "Stale Empty", goal: "agents join later" });
    tm.closeStaleTeams(root);
    expect((await team("stale-empty")).state).toBe("active");
  });
});
