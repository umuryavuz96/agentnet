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
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const bossOf = (n: string) => rt.byName(n)?.boss;
const foldBoss = (n: string) => st.get(rt.byName(n)!.id)?.boss;
const send = async (from: string, to: string) => j(await call(from, "POST", "/send", { to, body: "x" }));

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  for (const [name, boss] of [["root", null], ["lead-1", "root"], ["mem-1", "root"], ["mem-2", "root"], ["out-1", "root"], ["solo-1", "root"], ["solo-2", "root"]] as const) tok[name] = rt.createAgent({ name, boss: boss ?? undefined, job: "t", by: "test" }).token;
});

describe("lead gate", () => {
  test("a team with a lead is reached through its lead", async () => {
    expect((await j(await call("root", "POST", "/teams", { name: "Gated", lead: "lead-1", members: ["mem-1", "mem-2"] }))).status).toBe(201);
    const r = await send("out-1", "mem-1"); expect(r.status).toBe(403); expect(JSON.stringify(r.body)).toContain("send it to its lead lead-1");
    expect((await send("out-1", "lead-1")).status).toBe(200);
    expect((await send("root", "mem-1")).status).toBe(200);   // root is never gated
    expect((await send("mem-2", "mem-1")).status).toBe(200);   // teammates keep talking
    expect((await send("mem-1", "lead-1")).status).toBe(200);
    expect((await send("lead-1", "mem-1")).status).toBe(200);  // the lead is never gated
    const task = await j(await call("out-1", "POST", "/tasks", { agent: "mem-1", title: "do" })); // tasks use the same gate
    expect(task.status).toBe(403); expect(JSON.stringify(task.body)).toContain("lead lead-1");
    expect((await j(await call("lead-1", "POST", "/tasks", { agent: "mem-1", title: "do" }))).status).toBeLessThan(300);
  });
  test("a team without a lead keeps the old rules", async () => {
    expect((await j(await call("root", "POST", "/teams", { name: "Flat", members: ["solo-1", "solo-2"] }))).status).toBe(201);
    expect((await send("root", "solo-1")).status).toBe(200);
  });
  test("an archived team does not gate", async () => {
    await call("root", "POST", "/teams/gated/archive");
    expect((await send("root", "mem-1")).status).toBe(200);
  });
});

describe("lead gone", () => {
  test("members are reachable once the lead is despawned", async () => {
    for (const n of ["gl-1", "gm-1"]) tok[n] = rt.createAgent({ name: n, boss: "root", job: "t", by: "test" }).token;
    await call("root", "POST", "/teams", { name: "Orphan", lead: "gl-1", members: ["gm-1"] });
    expect((await send("out-1", "gm-1")).status).toBe(403);
    const { db } = await import("../core/db");
    db().run("UPDATE agents SET archived_at = ? WHERE name = ?", [Date.now(), "gl-1"]); // what despawn does to the row
    const after = await send("out-1", "gm-1"); expect(JSON.stringify(after.body)).not.toContain("send it to its lead"); // the dead lead is no door; normal boss rules apply
    expect((await send("root", "gm-1")).status).toBe(200);
  });
});

describe("boss follows the lead", () => {
  test("create, add, new lead, remove", async () => {
    await call("root", "POST", "/teams", { name: "Crew", lead: "lead-1", members: ["out-1"] });
    expect(bossOf("out-1")).toBe("lead-1"); expect(foldBoss("out-1")).toBe("lead-1"); expect(bossOf("lead-1")).toBe("root");
    await call("root", "POST", "/teams/crew/members", { add: ["solo-1"] });
    expect(bossOf("solo-1")).toBe("lead-1");
    await call("root", "POST", "/teams/crew/members", { add: ["mem-1"] });
    await call("root", "POST", "/teams/crew", { lead: "mem-1" });
    expect(bossOf("out-1")).toBe("mem-1"); expect(bossOf("solo-1")).toBe("mem-1"); expect(bossOf("mem-1")).not.toBe("mem-1");
    await call("root", "POST", "/teams/crew/members", { remove: ["solo-1"] });
    expect(bossOf("solo-1")).toBe(bossOf("mem-1")); expect(foldBoss("solo-1")).toBe(bossOf("mem-1"));
  });
});

describe("an agent that sits in two teams", () => {
  test("its own boss and its own team's lead stay reachable whatever older team gates the target", async () => {
    for (const [n, boss] of [["old-lead", "root"], ["eng-lead", "root"], ["eng-mem", "eng-lead"], ["boss-only", "eng-lead"], ["stranger", "root"]] as const) tok[n] = rt.createAgent({ name: n, boss, job: "t", by: "test" }).token;
    expect((await j(await call("root", "POST", "/teams", { name: "Old", lead: "old-lead", members: ["eng-lead"] }))).status).toBe(201); // eng-lead is gated by old-lead
    expect((await j(await call("root", "POST", "/teams", { name: "Eng", lead: "eng-lead", members: ["eng-mem"] }))).status).toBe(201);
    expect((await send("eng-mem", "eng-lead")).status).toBe(200);   // member -> own lead (was: "send it to its lead old-lead")
    expect((await send("boss-only", "eng-lead")).status).toBe(200); // a report that is in no team -> its boss
    expect((await send("stranger", "eng-lead")).status).toBe(403);  // an outsider is still sent to the gating lead
    expect(JSON.stringify((await send("stranger", "eng-lead")).body)).toContain("old-lead");
    expect(JSON.stringify((await j(await call("eng-mem", "POST", "/tasks", { agent: "eng-lead", title: "x" }))).body)).not.toContain("send it to its lead"); // tasks use the same gate
  });
});
