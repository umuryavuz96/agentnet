import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sd-controls-"));
process.env.AGENTNET_HOME ??= dir;
process.env.AGENTNET_JOBS_JSON = join(dir, "jobs.json");
process.env.AGENTNET_ALL_CRON = join(dir, "all.cron");
writeFileSync(process.env.AGENTNET_JOBS_JSON, JSON.stringify({ "digest-job": { agent: "ctl-agent", about: "x" }, "other-job": { agent: "someone-else" }, "no-line": { agent: "ctl-agent" } }));
writeFileSync(process.env.AGENTNET_ALL_CRON, [
  "# comment", "0 10,17 * * * /Users/x/scripts/lib/cron_wrap.sh \"digest-job\" /usr/bin/python3 /x/digest.py --pct 5\\%",
  "*/5 * * * * /Users/x/scripts/lib/cron_wrap.sh --always other-job /bin/true", "",
].join("\n"));

const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const ct = await import("./controls");
const { nextRun } = await import("./cron");

const spawned: string[] = [], exits: ((code: number) => void)[] = [], keys: string[][] = [], sessions = new Set<string>(["agentnet-ctl-agent"]);
const tmux: import("./windows").Tmux = { run: (a) => { keys.push(a); if (a[0] === "has-session") return { code: sessions.has(a[2]!.replace(/^=/, "")) ? 0 : 1, out: "" }; return { code: 0, out: "" }; } };
const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); ct.agentControlRoutes(api, { spawn: (c, onExit) => { spawned.push(c); if (onExit) exits.push(onExit); }, tmux, kill: () => {} }); app.route("/api/v1", api);
const req = (method: string, path: string, body?: unknown) => app.request(`/api/v1/agentnet/agents/ctl-agent${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const inbox = (to: string) => (rt.nameMap(), (useDatabaseRows(to)));
let dbh: InstanceType<typeof Database>;
const useDatabaseRows = (to: string) => (dbh.query("SELECT m.* FROM messages m WHERE m.to_agent = ? ORDER BY id").all(to) as { from_agent: string; kind: string; subject: string; body: string }[]);
const aid = (n: string) => st.live().find((s) => s.name === n)!.id;

beforeEach(() => {
  dbh = new Database(":memory:"); useDatabase(dbh); st._reset(); spawned.length = 0; keys.length = 0; sessions.clear(); sessions.add("agentnet-ctl-agent");
  rt.createAgent({ name: "lead-1", boss: "root", job: "t", by: "test" });
  rt.createAgent({ name: "ctl-agent", boss: "lead-1", job: "t", by: "test" });
});

/** The /bg route as the hooks call it, through the agent's own token. */
const bg = async (item: Record<string, unknown>) => {
  const a = new Hono<Env>(); a.use("*", tracing); const x = new Hono<Env>(); rt.agentnetRoutes(x); a.route("/api/v1", x);
  const tokenFile = (dbh.query("SELECT token_file FROM agents WHERE name = 'ctl-agent'").get() as { token_file: string }).token_file;
  const token = (await Bun.file(tokenFile).text()).trim();
  const r = await a.request("/api/v1/agentnet/bg", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ items: [item] }) });
  st.flush(); return r;
};

describe("schedule capture (POST /bg kind schedule)", () => {
  test("CronCreate adds a session cron, CronDelete removes it, bad items are dropped", async () => {
    expect(((await (await bg({ id: "a91709ac", kind: "schedule", state: "active", cron: "*/10 * * * *", prompt: "check mail ".repeat(40), recurring: true })).json()) as { accepted: number }).accepted).toBe(1);
    const s = st.get(aid("ctl-agent"))!;
    expect(s.schedules).toHaveLength(1); expect(s.schedules![0]!.id).toBe("a91709ac"); expect(s.schedules![0]!.cron).toBe("*/10 * * * *");
    expect(s.schedules![0]!.prompt.length).toBe(200); expect(s.schedules![0]!.recurring).toBe(true);
    expect(((await (await bg({ id: "x", kind: "schedule", state: "bogus" })).json()) as { accepted: number }).accepted).toBe(0);
    await bg({ id: "a91709ac", kind: "schedule", state: "gone" });
    expect(st.get(aid("ctl-agent"))!.schedules).toEqual([]);
  });
  test("an agent that goes away loses its session crons", async () => {
    await bg({ id: "j1", kind: "schedule", state: "active", cron: "* * * * *", prompt: "p" });
    const id = aid("ctl-agent");
    st.emit({ agent: id, type: "AgentGone", data: { reason: "exit" }, source: "mod" }); st.flush();
    expect(st.get(id)!.schedules).toEqual([]);
  });
});

describe("schedulesOf", () => {
  const snap = (extra: Partial<import("./store").Snapshot>) => ({ ...st.get(aid("ctl-agent"))!, ...extra });
  test("session cron: next run from the expression; a one-shot that fired and a 7-day-old recurring job are hidden", () => {
    const now = new Date(2026, 10, 9, 14, 3).getTime();
    const mk = (id: string, cron: string, recurring: boolean, createdAt: number) => ({ id, cron, prompt: `do ${id}`, recurring, createdAt });
    const out = ct.schedulesOf(snap({ schedules: [mk("a", "*/15 * * * *", true, now - 3600_000), mk("old", "*/15 * * * *", true, now - 8 * 86_400_000), mk("fired", "0 9 * * *", false, now - 3600_000 * 9), mk("pending", "0 18 * * *", false, now - 60_000)] }), now);
    const sc = out.filter((x) => x.kind === "session-cron");
    expect(sc.map((x) => x.id)).toEqual(["a", "pending"]);
    expect(sc[0]!).toMatchObject({ kind: "session-cron", cron: "*/15 * * * *", nextRunAt: new Date(2026, 10, 9, 14, 15).getTime(), canRun: true, source: "CronCreate" });
    expect(sc[1]!.nextRunAt).toBe(new Date(2026, 10, 9, 18, 0).getTime());
  });
  test("monitor: only running ones, with start time and no run now", () => {
    const out = ct.schedulesOf(snap({ bg: [{ id: "bg:m1", kind: "monitor", label: "tail log", state: "running", startedAt: 1000, endedAt: null }, { id: "bg:m2", kind: "monitor", label: "old", state: "done", startedAt: 1, endedAt: 2 }, { id: "bg:s1", kind: "shell", label: "sh", state: "running", startedAt: 1, endedAt: null }] }));
    expect(out.filter((x) => x.kind === "monitor")).toEqual([{ id: "bg:m1", kind: "monitor", label: "tail log", startedAt: 1000, source: "Monitor", canRun: false }]);
  });
  test("cron job: linked by the jobs.json agent field, schedule from all.cron; no line = no next run, not runnable", () => {
    const now = new Date(2026, 10, 9, 9, 0).getTime();
    const out = ct.schedulesOf(snap({}), now);
    expect(out.map((x) => x.id).sort()).toEqual(["cron:digest-job", "cron:no-line"]);
    expect(out.find((x) => x.id === "cron:digest-job")!).toMatchObject({ kind: "cron-job", label: "digest-job", cron: "0 10,17 * * *", nextRunAt: nextRun("0 10,17 * * *", now), canRun: true });
    expect(out.find((x) => x.id === "cron:no-line")!).toMatchObject({ canRun: false, nextRunAt: undefined });
  });
  test("cronLines reads the job name with and without quotes and flags", () => {
    expect(ct.cronLines().map((l) => l.job)).toEqual(["digest-job", "other-job"]);
  });
});

describe("routes", () => {
  test("GET schedules lists them; unknown agent is 404", async () => {
    await bg({ id: "j1", kind: "schedule", state: "active", cron: "*/5 * * * *", prompt: "ping" });
    const r = await req("GET", "/schedules"); expect(r.status).toBe(200);
    const b = (await r.json()) as { schedules: { id: string; nextRunAt: number }[] };
    expect(b.schedules.map((x) => x.id)).toContain("j1"); expect(b.schedules.find((x) => x.id === "j1")!.nextRunAt).toBeGreaterThan(Date.now());
    expect((await app.request("/api/v1/agentnet/agents/nobody-here/schedules")).status).toBe(404);
  });
  test("Run now, session cron: the agent gets a task message from admin with the prompt; the boss is told", async () => {
    await bg({ id: "j1", kind: "schedule", state: "active", cron: "*/5 * * * *", prompt: "ping the build" });
    const r = await req("POST", "/run-schedule", { id: "j1" }); expect(r.status).toBe(200);
    const msgs = inbox(aid("ctl-agent")); expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from_agent: "@panel", kind: "task", body: "run scheduled job j1 now: ping the build" });
    const told = inbox(aid("lead-1")); expect(told).toHaveLength(1);
    expect(told[0]!.subject).toBe("admin: run-now ctl-agent"); expect(told[0]!.kind).toBe("info");
    expect(told[0]!.body).toMatch(/^The owner triggered job j1 on ctl-agent from the agentnet panel at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.$/);
  });
  test("Run now, cron job: runs the exact all.cron command (\\% unescaped), nothing for a monitor or unknown id", async () => {
    const r = await req("POST", "/run-schedule", { id: "cron:digest-job" }); expect(r.status).toBe(200);
    expect(spawned).toEqual(["/Users/x/scripts/lib/cron_wrap.sh \"digest-job\" /usr/bin/python3 /x/digest.py --pct 5%"]);
    expect(inbox(aid("lead-1")).at(-1)!.body).toContain("triggered job digest-job on ctl-agent");
    expect((await req("POST", "/run-schedule", { id: "cron:no-line" })).status).toBe(404); // not runnable: no all.cron line
    expect((await req("POST", "/run-schedule", { id: "cron:other-job" })).status).toBe(404); // linked to another agent
    expect((await req("POST", "/run-schedule", { id: "nope" })).status).toBe(404);
    await bg({ id: "bg:m1", kind: "monitor", state: "running", label: "m" });
    expect(spawned).toHaveLength(1);
    exits.splice(0).forEach((f) => f(0));
  });
  test("Run now, cron job: shows running at once, refuses a second run, then reports the last run", async () => {
    expect((await req("POST", "/run-schedule", { id: "cron:digest-job" })).status).toBe(200);
    const row = async () => ((await (await app.request("/api/v1/agentnet/agents/ctl-agent/schedules")).json()) as { schedules: import("./controls").Schedule[] }).schedules.find((x) => x.id === "cron:digest-job")!;
    expect(await row()).toMatchObject({ running: true }); expect((await row()).startedAt).toBeGreaterThan(0);
    expect((await req("POST", "/run-schedule", { id: "cron:digest-job" })).status).toBe(409);
    exits.splice(0).forEach((f) => f(1));
    const r = await row(); expect(r.running).toBeUndefined(); expect(r.lastRun).toMatchObject({ ok: false });
  });
  test("Stop: one Escape to the agent's tmux pane, boss told, agent stays live", async () => {
    const r = await req("POST", "/stop"); expect(r.status).toBe(200);
    expect(keys).toContainEqual(["send-keys", "-t", "=agentnet-ctl-agent:", "Escape"]);
    expect(keys.filter((k) => k[0] === "send-keys")).toHaveLength(1);
    expect(inbox(aid("lead-1")).at(-1)!).toMatchObject({ subject: "admin: stop ctl-agent", from_agent: "@panel" });
    expect(inbox(aid("lead-1")).at(-1)!.body).toMatch(/^The owner stopped ctl-agent from the agentnet panel at /);
    expect(st.get(aid("ctl-agent"))!.life).not.toBe("gone");
    sessions.clear(); expect((await req("POST", "/stop")).status).toBe(404); // no session, nothing sent
  });
  test("Close: despawns the agent, boss and root hear about it, event log has the action", async () => {
    const id = aid("ctl-agent");
    const r = await req("POST", "/despawn"); expect(r.status).toBe(200);
    expect(((await r.json()) as { told: string[] }).told).toEqual(["lead-1", "root"]);
    expect(st.get(id)!.life).toBe("gone"); expect(st.get(id)!.goneReason).toBe("despawn");
    expect(inbox(aid("lead-1")).at(-1)!.body).toMatch(/^The owner closed ctl-agent from the agentnet panel at /);
    expect(inbox(rt.ADMIN.id).at(-1)!.subject).toBe("admin: close ctl-agent"); // no live root: the pseudo-row gets the copy
    expect(st.events(id).some((e) => e.type === "AdminAction" && (e.data as { action: string }).action === "close")).toBe(true);
    expect((await req("POST", "/despawn")).status).toBe(404);
  });
  test("Close: the last live member leaving archives its team, a team with a live member stays open", async () => {
    const { createTeam, getTeam } = await import("./teams");
    createTeam({ id: "ctl-team", name: "ctl-team", members: ["ctl-agent"] });
    createTeam({ id: "ctl-shared", name: "ctl-shared", members: ["ctl-agent", "lead-1"] });
    const r = (await (await req("POST", "/despawn")).json()) as { teams_archived?: string[] };
    expect(r.teams_archived).toEqual(["ctl-team"]);
    expect(getTeam("ctl-team")!.state).toBe("archived"); expect(getTeam("ctl-shared")!.state).toBe("active");
  });
  test("root cannot be stopped or closed from the panel; the message shows as from admin", async () => {
    for (const p of ["/stop", "/despawn"]) expect((await app.request(`/api/v1/agentnet/agents/root${p}`, { method: "POST" })).status).toBe(403);
    expect(rt.nameMap().get("@panel")).toBe("admin");
  });
});
