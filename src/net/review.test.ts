// Review findings H1, H2, M1, M3: each test fails on the code before the fix.
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
const lv = await import("./liveness");
const wn = await import("./windows");

const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); rt.agentnetRoutes(api); app.route("/api/v1", api);
const tok: Record<string, string> = {};
const call = (who: string, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1/agentnet${path}`, { method, headers: { authorization: `Bearer ${tok[who] ?? who}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const tick = () => Bun.sleep(3); // epochs are in ms

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  for (const n of ["root", "evil-1", "victim-1", "ghost-1"]) tok[n] = rt.createAgent({ name: n, boss: n === "root" ? undefined : "root", job: "t", by: "test" }).token;
});

describe("H1: a reported pid is never trusted", () => {
  test("hello keeps only an integer above 1", async () => {
    for (const bad of [-1, 0, 1, 1.5, "abc", null]) {
      const r = await j(await call("evil-1", "POST", "/hello", { session: `s-${String(bad)}`, pid: bad }));
      expect(r.body.agent.pid).toBeNull();
    }
    expect((await j(await call("evil-1", "POST", "/hello", { session: "s-ok", pid: 4242 }))).body.agent.pid).toBe(4242);
  });
  test("goodPid and inTree", () => {
    expect([-1, 0, 1, 2.5, NaN, "x"].map((x) => rt.goodPid(x))).toEqual([null, null, null, null, null, null]);
    expect(rt.goodPid(77)).toBe(77);
    const parent: Record<number, number> = { 30: 20, 20: 10, 10: 1 };
    const ppid = (p: number) => parent[p] ?? null;
    expect(rt.inTree(30, [10], ppid)).toBe(true); expect(rt.inTree(10, [10], ppid)).toBe(true);
    expect(rt.inTree(30, [99], ppid)).toBe(false); expect(rt.inTree(1, [1], ppid)).toBe(false);
  });
  test("despawn signals a pid only when it sits inside the agent's own tmux pane", () => {
    const parent: Record<number, number> = { 30: 20, 20: 10, 500: 1 };
    const sent: [number, string][] = [], later: (() => void)[] = [];
    const tmux: import("./windows").Tmux = { run: (a) => a[0] === "list-panes" ? { code: 0, out: "10\n" } : { code: 0, out: "1700000000\n" } };
    const deps = { tmux, ppid: (p: number) => parent[p] ?? null, signal: (p: number, s: string) => { sent.push([p, s]); }, later: (fn: () => void) => { later.push(fn); } };
    rt.killAgent(500, null, "evil-1", deps);   // foreign pid (say the main bot's claude)
    rt.killAgent(-1, null, "evil-1", deps);    // kill(-1) would hit every process of the user
    expect(sent).toEqual([]);
    rt.killAgent(30, null, "evil-1", deps);    // its own claude, a child of the pane
    expect(sent).toEqual([[30, "SIGTERM"]]);
    later.forEach((f) => f()); expect(sent.filter(([, s]) => s === "SIGKILL")).toEqual([[30, "SIGKILL"]]);
    for (const [p] of sent) expect(p).toBe(30);
  });
});

describe("H2: dedup keys are per agent and per life", () => {
  test("an agent cannot pre-empt another agent's gone event", async () => {
    await call("victim-1", "POST", "/hello", { session: "v1", pid: 31001 });
    await call("evil-1", "POST", "/events", { events: [{ type: "ContextMeasured", data: { tokens: 1, window: 2, pct: 1 }, dedup: "gone:victim-1#1" }] });
    await call("victim-1", "POST", "/bye", { reason: "exit" });
    expect(st.get("victim-1#1")?.life).toBe("gone");
  });
  test("an agent that came back after gone can go gone again", async () => {
    await call("ghost-1", "POST", "/hello", { session: "g1", pid: 31002 });
    await call("ghost-1", "POST", "/bye", { reason: "exit" });
    expect(st.get("ghost-1#1")?.life).toBe("gone");
    await tick();
    await call("ghost-1", "POST", "/hello", { session: "g1", pid: 31002 }); // same session and pid: a resume
    expect(st.get("ghost-1#1")?.life).toBe("live");
    await tick();
    await call("ghost-1", "POST", "/bye", { reason: "exit" });
    expect(st.get("ghost-1#1")?.life).toBe("gone"); // before the fix the second gone was dropped: a ghost on the page
    await tick();
    await call("ghost-1", "POST", "/hello", { session: "g2", pid: 31003 });
    const s = st.get("ghost-1#1")!;
    lv.sweep(s.connectedAt! + 5000, () => false, null); // the sweep path: pid dead
    expect(st.get("ghost-1#1")?.life).toBe("gone");
  });
  test("despawn after the agent already said bye still records the despawn", async () => {
    const t = rt.createAgent({ name: "late-1", boss: "root", by: "test" });
    await call(t.token, "POST", "/hello", { session: "l1", pid: 31004 });
    await call(t.token, "POST", "/bye", { reason: "exit" });
    rt.retireAgent(rt.byName("late-1")!, "despawn", Date.now(), () => {});
    expect(st.get("late-1#1")?.goneReason).toBe("despawn");
  });
});

describe("M1: root cannot be despawned", () => {
  test("403 and the root row stays", async () => {
    const r = await call("root", "POST", "/despawn", { agent: "root" });
    expect(r.status).toBe(403); expect(rt.byName("root")).not.toBeNull(); expect(st.get("root#1")?.life).not.toBe("gone");
  });
});

describe("M3: a delayed kill never hits a newer session of the same name", () => {
  const fake = (created: { v: string }) => { const calls: string[][] = []; const t: import("./windows").Tmux = { run: (a) => { calls.push(a); return a[0] === "display-message" ? { code: 0, out: created.v + "\n" } : a[0] === "list-panes" ? { code: 0, out: "" } : { code: 0, out: "" }; } }; return { t, calls }; };
  test("killAgent: same session_created kills, a newer one is left alone", () => {
    for (const [after, killed] of [["100", true], ["200", false]] as const) {
      const created = { v: "100" }, f = fake(created), later: (() => void)[] = [];
      rt.killAgent(null, null, "a-1", { tmux: f.t, ppid: () => null, signal: () => {}, later: (fn) => { later.push(fn); } });
      created.v = after; later.forEach((fn) => fn());
      expect(f.calls.some((c) => c[0] === "kill-session" && c[2] === "=agentnet-a-1")).toBe(killed);
    }
  });
  test("reaper: a session re-created within the delay survives", async () => {
    const created = { v: "100" }, f = fake(created);
    st.emit({ agent: "r#1", type: "AgentSpawned", data: { id: "r#1", name: "r" }, source: "spawn" }); st.flush();
    const off = wn.startSessionReaper(f.t, 10);
    st.emit({ agent: "r#1", type: "AgentGone", data: { reason: "exit" }, source: "mod" }); st.flush();
    created.v = "200"; await Bun.sleep(40); off?.();
    expect(f.calls.some((c) => c[0] === "kill-session")).toBe(false);
  });
});
