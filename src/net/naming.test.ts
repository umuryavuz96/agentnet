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
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${rootTok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
let rootTok = "";
const GOAL = "numbering test goal";
/** Spawn by role (the service picks the number); returns the final name from the reply. */
const spawnRole = async (role: string, team?: string) => { const r = await j(await call("POST", "/spawn", { role, team, goal: GOAL, job: "t", boss: "root", model: "sonnet", soul: "none" })); expect(r.status).toBe(201); return r.body.name as string; };
const despawn = (name: string) => call("POST", "/despawn", { agent: name });
const team = (name: string, members: string[] = []) => call("POST", "/teams", { name, goal: GOAL, members });

beforeAll(() => { useDatabase(new Database(":memory:")); st._reset(); rootTok = rt.createAgent({ name: "root", job: "t", by: "test" }).token; });

describe("agent numbers", () => {
  test("(a) a team member list that still holds despawned mobile-dev-20 and researcher-6 does not push the number up", async () => {
    await team("game-old", [...Array.from({ length: 20 }, (_, i) => `mobile-dev-${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `researcher-${i + 1}`)]); // every number up to 20 / 6 was used once and despawned
    expect(await spawnRole("mobile-dev", "game-old")).toBe("mobile-dev-1");
    expect(await spawnRole("researcher", "game-old")).toBe("researcher-1");
    expect((await j(await call("GET", "/teams/game-old"))).body.team.members).toContain("mobile-dev-1");
  });

  test("(b) two teams that both want a live mobile-dev get -1 and -2 (names stay unique machine-wide)", async () => {
    await despawn("mobile-dev-1");
    await team("team-a"); await team("team-b");
    expect(await spawnRole("mobile-dev", "team-a")).toBe("mobile-dev-1");
    expect(await spawnRole("mobile-dev", "team-b")).toBe("mobile-dev-2");
  });

  test("(c) a hole is filled: live -1 and -3 gives -2", async () => {
    for (const n of ["web-dev-1", "web-dev-2", "web-dev-3"]) rt.createAgent({ name: n, boss: "root", job: "t", by: "test" });
    await despawn("web-dev-2");
    expect(await spawnRole("web-dev")).toBe("web-dev-2");
    expect(await spawnRole("web-dev")).toBe("web-dev-4");
  });

  test("a despawned number is free again, an archived row never counts", async () => {
    const a = await spawnRole("qa"), b = await spawnRole("qa");
    expect([a, b]).toEqual(["qa-1", "qa-2"]);
    await despawn("qa-1"); await despawn("qa-2");
    expect(await spawnRole("qa")).toBe("qa-1");
  });

  test("(d) an explicit name of a live agent is refused with the reason; the name of a gone agent is accepted", async () => {
    const live = await j(await call("POST", "/spawn", { name: "web-dev-1", goal: GOAL, job: "t", boss: "root" }));
    expect(live.status).toBe(422); expect(JSON.stringify(live.body)).toContain("web-dev-1 is live already");
    await despawn("web-dev-1");
    const again = await j(await call("POST", "/spawn", { name: "web-dev-1", goal: GOAL, job: "t", boss: "root" }));
    expect(again.status).toBe(201); expect(again.body.name).toBe("web-dev-1");
    expect(rt.byName("web-dev-1")!.id).toBe("web-dev-1#2"); // history stays separate: name#gen
  });

  test("(e) a role without a number: the service picks, the spawn reply carries the final name", async () => {
    const r = await j(await call("POST", "/spawn", { role: "mobile-dev", goal: GOAL, job: "t", boss: "root" }));
    expect(r.status).toBe(201); expect(r.body.name).toMatch(/^mobile-dev-\d+$/); expect(r.body.agent).toBe(`${r.body.name}#1`);
    const plan = await j(await call("POST", "/plan-spawn", { role: "reviewer", job: "t" }));
    expect(plan.body.plan.name).toBe("reviewer-1");
  });
});
