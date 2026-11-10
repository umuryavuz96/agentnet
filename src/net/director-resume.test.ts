// Director resume and reset (SPEC-director-resume-reset-2026-11-10). Never spawns tmux or claude: every start/stop goes through stubs.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
delete process.env.TMUX;
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const dr = await import("./director");

const app = new Hono<Env>(); app.use("*", tracing);
const api = new Hono<Env>(); rt.agentnetRoutes(api); dr.directorRoutes(api); app.route("/api/v1", api);
let rootTok = "";
const call = (method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${rootTok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const director = async () => (await (await call("GET", "/agent-director")).json()) as Record<string, unknown>;

beforeAll(() => {
  useDatabase(new Database(":memory:")); st._reset();
  rootTok = rt.createAgent({ name: "root", job: "director", by: "test" }).token;
});

describe("A: /exit leaves the director offline, not forgotten", () => {
  test("hello then bye: hadRoot true, root false", async () => {
    await call("POST", "/agentnet/hello", { session: "s1", pid: 41001 });
    expect((await director()).root).toBe(true);
    await call("POST", "/agentnet/bye", { reason: "exit" });
    const d = await director();
    expect(d.root).toBe(false);
    expect(d.hadRoot).toBe(true);
    expect(st.get("root#1")?.life).toBe("gone");
  });
});

describe("B: resume the last session", () => {
  const all = { bun: true, claude: true, tmux: true, python3: true };
  const dir = mkdtempSync(join(tmpdir(), "dir-"));
  const ID = "0f1e2d3c-1111-2222-3333-444455556666";
  const run = (calls: string[][]) => (c: string, a: string[]) => { calls.push([c, ...a]); return { status: 0 }; };
  test("directorCommand adds --resume after --plugin-dir, quoted", () => {
    expect(dr.directorCommand("/x", { repo: "/r", port: 3096, host: "127.0.0.1", resume: ID })).toEndWith(`claude --plugin-dir "$AGENTNET_MOD" --resume '${ID}'`);
    expect(dr.directorCommand("/x", { repo: "/r", port: 3096, host: "127.0.0.1" })).not.toContain("--resume");
  });
  test("transcript path: every non-alphanumeric char becomes a dash", () => {
    expect(dr.transcriptSlug("/Users/a.b/my_proj")).toBe("-Users-a-b-my-proj");
    expect(dr.transcriptPath("/Users/you/projects/agentnet", ID, "/H")).toBe(`/H/.claude/projects/-Users-you-projects-agentnet/${ID}.jsonl`);
  });
  test("transcript found: resumed; missing or bad id: fresh with a reason", () => {
    const calls: string[][] = [];
    const r = dr.startDirector(dir, run(calls), all, () => false, { resume: ID, hasTranscript: () => true });
    expect(r).toMatchObject({ ok: true, resumed: true });
    expect(calls[0]!.at(-1)).toContain(`--resume '${ID}'`);
    const calls2: string[][] = [];
    const r2 = dr.startDirector(dir, run(calls2), all, () => false, { resume: ID, hasTranscript: () => false });
    expect(r2).toMatchObject({ ok: true, resumed: false }); expect(r2.why).toBeTruthy();
    expect(calls2[0]!.at(-1)).not.toContain("--resume");
    const r3 = dr.startDirector(dir, run([]), all, () => false, { resume: "x'; rm -rf /", hasTranscript: () => true });
    expect(r3).toMatchObject({ resumed: false });
    expect(dr.startDirector(dir, run([]), all, () => false).resumed).toBeUndefined(); // no resume asked
  });
  test("GET carries last: session, dir, at", async () => {
    const d = await director();
    expect(d.last).toMatchObject({ session: "s1" });
    expect(typeof (d.last as { at: number }).at).toBe("number");
  });
});

describe("C: reset the director", () => {
  const { toLegacy, isPanelWrite } = require("./mount") as typeof import("./mount");
  test("route mapping and panel-write gate (root only)", () => {
    expect(toLegacy("/v1/panel/director/reset")).toBe("/api/v1/agent-director/reset");
    expect(isPanelWrite("POST", "/api/v1/agent-director/reset")).toBe(true);
    expect(isPanelWrite("GET", "/api/v1/agent-director/reset")).toBe(false);
  });
  test("root live: stops the tmux session, backs up, forgets root; other agents stay", async () => {
    rt.createAgent({ name: "worker-1", boss: "root", job: "w", by: "test" });
    const calls: string[] = [], lines: string[] = [];
    const r = await dr.resetDirector({
      pid: () => 41999, session: () => "agentnet-root", killSession: (s) => (calls.push("kill " + s), true), signal: () => calls.push("signal"), gone: async () => true,
      backup: (l) => lines.push(l),
      forget: () => { const a = rt.byName("root"); if (a) rt.retireAgent(a, "reset"); st.flush(); return st.forgetByName("root"); },
    });
    expect(r).toMatchObject({ ok: true, stopped: true });
    expect(calls).toEqual(["kill agentnet-root"]);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).rows[0].name).toBe("root");
    const d = await director();
    expect(d.hadRoot).toBe(false); expect(d.root).toBe(false); expect(d.last).toBeNull();
    expect(st.all().some((a) => a.name === "worker-1")).toBe(true);
    expect(rt.byName("root")).toBeNull(); // the name is free for a new director
  });
  test("root gone already: nothing to stop, still forgotten and backed up", async () => {
    rt.createAgent({ name: "root", job: "director", by: "test" });
    const calls: string[] = [], lines: string[] = [];
    const r = await dr.resetDirector({
      pid: () => null, session: () => null, killSession: () => (calls.push("kill"), true), signal: () => calls.push("signal"), gone: async () => true,
      backup: (l) => lines.push(l), forget: () => { const a = rt.byName("root"); if (a) rt.retireAgent(a, "reset"); st.flush(); return st.forgetByName("root"); },
    });
    expect(r).toMatchObject({ ok: true, stopped: false });
    expect(calls).toEqual([]); expect(lines.length).toBe(1);
  });
  test("no tmux session: SIGTERM the pid; if it will not die, nothing is forgotten", async () => {
    const calls: string[] = [];
    const r = await dr.resetDirector({ pid: () => 41998, session: () => null, killSession: () => false, signal: (p) => calls.push("signal " + p), gone: async () => false, backup: () => calls.push("backup"), forget: () => (calls.push("forget"), []) });
    expect(r.ok).toBe(false); expect(calls).toEqual(["signal 41998"]);
  });
});
