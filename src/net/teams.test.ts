import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const tr = await import("./teamRoutes");

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
    const gated = await j(await call("root", "POST", "/send", { to: "dev-2", body: "before archive" }));
    expect(gated.status).toBe(403); expect(JSON.stringify(gated.body)).toContain("lead lead-1"); // root goes through the lead too
    expect((await j(await call("root", "POST", "/teams/turntable/archive"))).body.team.state).toBe("archived");
    expect((await j(await call("root", "POST", "/send", { to: "dev-2", body: "after archive" }))).status).toBe(200); // archived team no longer gates
    expect((await j(await call("dev-1", "GET", "/teams"))).body.teams.map((t: { id: string }) => t.id)).not.toContain("turntable");
  });
});
