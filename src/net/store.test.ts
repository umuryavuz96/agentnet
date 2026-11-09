import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const st = await import("./store");

const T0 = 1_700_000_000_000;
const spawn = (id = "qa-1", ts = T0) => st.emit({ agent: id, type: "AgentSpawned", data: { id, name: id, gen: 1, job: "test", boss: "root" }, source: "spawn", ts });
beforeEach(() => { useDatabase(new Database(":memory:")); st._reset(); });

describe("reduce", () => {
  test("only AgentSpawned creates a snapshot; unknown types are ignored", () => {
    expect(st.reduce(null, { type: "TurnStarted", ts: T0, data: {}, source: "mod" })).toBeNull();
    const s = st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a", name: "a", boss: "root" }, source: "spawn" })!;
    expect(s.life).toBe("starting"); expect(s.state).toBe("idle");
    expect(st.reduce(s, { type: "Nonsense", ts: T0 + 1, data: {}, source: "mod" })).toEqual({ ...s, lastEventAt: T0 + 1 });
  });
  test("turn, tool, status and tasks", () => {
    let s = st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a", name: "a" }, source: "spawn" })!;
    s = st.reduce(s, { type: "AgentConnected", ts: T0 + 1, data: { session: "sid", pid: 42, version: "2.1.319" }, source: "mod" })!;
    expect(s.life).toBe("live"); expect(s.pid).toBe(42);
    s = st.reduce(s, { type: "TurnStarted", ts: T0 + 2, data: { turn: "t1", snippet: "fix the bug" }, source: "mod" })!;
    s = st.reduce(s, { type: "ToolStarted", ts: T0 + 3, data: { tool: "Bash", target: "ls", tool_use_id: "u1" }, source: "mod" })!;
    expect(s.state).toBe("working"); expect(st.doing(s)).toBe("Bash · ls"); expect(s.turn?.tools).toBe(1);
    s = st.reduce(s, { type: "ToolFinished", ts: T0 + 4, data: { tool: "Bash", target: "ls", tool_use_id: "u1", ok: true, ms: 9 }, source: "mod" })!;
    expect(s.action).toBeNull(); expect(s.lastTool?.ms).toBe(9);
    s = st.reduce(s, { type: "TaskAdded", ts: T0 + 5, data: { text: "write tests" }, source: "mcp" })!;
    s = st.reduce(s, { type: "TaskStarted", ts: T0 + 6, data: { id: 1 }, source: "mcp" })!;
    expect(s.tasks).toEqual([{ id: 1, text: "write tests", status: "in_progress" }]);
    s = st.reduce(s, { type: "StatusReported", ts: T0 + 7, data: { doing: "halfway", progress: 50 }, source: "mcp" })!;
    expect(st.doing(s, T0 + 8)).toBe("halfway");
    s = st.reduce(s, { type: "TurnEnded", ts: T0 + 8, data: { reason: "answer" }, source: "mod" })!;
    expect(s.state).toBe("idle"); expect(s.turn).toBeNull();
    s = st.reduce(s, { type: "AgentGone", ts: T0 + 9, data: { reason: "exit" }, source: "service" })!;
    expect(s.life).toBe("gone"); expect(s.goneReason).toBe("exit");
  });
});

describe("bg rows", () => {
  const base = () => st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a", name: "a" }, source: "spawn" })!;
  const bg = (s: ReturnType<typeof base>, ts: number, d: Record<string, unknown>) => st.reduce(s, { type: "BgUpdated", ts, data: d, source: "hook" })!;
  test("running -> done keeps startedAt, sets endedAt; a late running never revives", () => {
    let s = bg(base(), T0 + 10, { id: "b1", kind: "shell", label: "sleep 60", state: "running" });
    expect(s.bg).toEqual([{ id: "b1", kind: "shell", label: "sleep 60", state: "running", startedAt: T0 + 10, endedAt: null }]);
    s = bg(s, T0 + 70, { id: "b1", kind: "shell", state: "done" });
    expect(s.bg![0]).toMatchObject({ label: "sleep 60", state: "done", startedAt: T0 + 10, endedAt: T0 + 70 });
    s = bg(s, T0 + 80, { id: "b1", kind: "shell", state: "running" });
    expect(s.bg![0]!.state).toBe("done");
  });
  test("finished rows leave after 2 min; bad kind or state is ignored; capped", () => {
    let s = bg(base(), T0, { id: "x", kind: "monitor", label: "m", state: "killed" });
    s = bg(s, T0 + st.BG_KEEP_MS + 1, { id: "y", kind: "subagent", label: "s", state: "running" });
    expect(s.bg!.map((b) => b.id)).toEqual(["y"]);
    expect(bg(s, T0 + 1e6, { id: "z", kind: "nope", state: "running" }).bg).toEqual(s.bg);
    for (let i = 0; i < 20; i++) s = bg(s, T0 + 1e6 + i, { id: "r" + i, kind: "shell", label: "l", state: "running" });
    expect(s.bg!.length).toBe(st.BG_MAX);
  });
});

describe("writer", () => {
  test("fold(all events) == agent_status, and duplicates are ignored", () => {
    spawn();
    st.emit({ agent: "qa-1", type: "AgentConnected", data: { session: "s", pid: 7 }, source: "mod", ts: T0 + 1, dedup: "hello:s" });
    st.emit({ agent: "qa-1", type: "AgentConnected", data: { session: "s", pid: 7 }, source: "mod", ts: T0 + 2, dedup: "hello:s" }); // duplicate
    st.emit({ agent: "qa-1", type: "TurnStarted", data: { turn: "t" }, source: "mod", ts: T0 + 3, dedup: "turn:t:start" });
    st.emit({ agent: "qa-1", type: "TaskAdded", data: { text: "a" }, source: "mcp", ts: T0 + 4, dedup: "task:qa-1:op1" });
    st.emit({ agent: "qa-1", type: "TaskAdded", data: { text: "a" }, source: "mcp", ts: T0 + 5, dedup: "task:qa-1:op1" }); // retry
    const patches = st.flush();
    expect(patches).toHaveLength(1);
    const s = st.get("qa-1")!;
    expect(s.v).toBe(4); expect(s.tasks).toHaveLength(1); expect(s.lastEventAt).toBe(T0 + 4);
    const rebuilt = st.rebuild().get("qa-1")!;
    expect(rebuilt).toEqual(s);
    expect(st.events("qa-1")).toHaveLength(4);
  });
  test("out of order: a late ToolStarted after its ToolFinished is dropped; transient starts are not stored", () => {
    spawn();
    st.emit({ agent: "qa-1", type: "ToolFinished", data: { tool: "Read", tool_use_id: "u9", ok: true }, source: "mod", ts: T0 + 2, dedup: "post:u9" });
    st.emit({ agent: "qa-1", type: "ToolStarted", data: { tool: "Read", tool_use_id: "u9" }, source: "mod", ts: T0 + 1, transient: true });
    st.emit({ agent: "qa-1", type: "ToolStarted", data: { tool: "Grep", tool_use_id: "u10" }, source: "mod", ts: T0 + 3, transient: true });
    st.flush();
    const s = st.get("qa-1")!;
    expect(s.action?.tool).toBe("Grep"); expect(s.lastTool?.tool).toBe("Read");
    expect(st.events("qa-1").map((e) => e.type)).toEqual(["AgentSpawned", "ToolFinished"]);
  });
  test("events for an unknown agent are dropped; gone agents leave live()", () => {
    st.emit({ agent: "ghost", type: "TurnStarted", data: {}, source: "mod" });
    spawn("a"); spawn("b");
    st.emit({ agent: "b", type: "AgentGone", data: { reason: "killed" }, source: "service" });
    const seen: string[] = []; const off = st.onPatch((ps) => ps.forEach((p) => seen.push(`${p.id}:${p.removed}`)));
    st.flush(); off();
    expect(st.get("ghost")).toBeNull();
    expect(st.live().map((s) => s.id)).toEqual(["a"]);
    expect(st.all()).toHaveLength(2);
    expect(seen.sort()).toEqual(["a:false", "b:true"]);
    expect(st.lastSeq()).toBe(3);
  });
  test("the timer drains on its own", async () => {
    spawn();
    await Bun.sleep(st.DRAIN_MS + 30);
    expect(st.get("qa-1")?.life).toBe("starting");
  });
});

describe("progressPct", () => {
  const mk = (statuses: Array<"pending" | "in_progress" | "done">, progress: number | null, repTurn = 3, turns = 3) => ({
    tasks: statuses.map((status, i) => ({ id: i + 1, text: "t" + i, status })), turns,
    reported: progress == null ? null : { doing: null, progress, phase: null, blockedOn: null, at: T0, turn: repTurn },
  });
  test("1/8 done + 55% on the current task = 19%", () => {
    expect(st.progressPct(mk(["done", "in_progress", ...Array(6).fill("pending")], 55))).toBe(19);
  });
  test("no tasks = null, even with a self-reported %", () => { expect(st.progressPct(mk([], 55))).toBeNull(); });
  test("all done = 100", () => { expect(st.progressPct(mk(Array(8).fill("done"), 40))).toBe(100); });
  test("a stale report (2+ turns old) or several tasks in progress is ignored", () => {
    expect(st.progressPct(mk(["done", "in_progress", ...Array(6).fill("pending")], 55, 1, 3))).toBe(13);
    expect(st.progressPct(mk(["done", "in_progress", "in_progress", ...Array(5).fill("pending")], 55))).toBe(13);
  });
});

describe("stale reports", () => {
  const base = () => {
    let s = st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a", name: "a" }, source: "spawn" })!;
    s = st.reduce(s, { type: "AgentConnected", ts: T0 + 1, data: {}, source: "mod" })!;
    return st.reduce(s, { type: "TurnStarted", ts: T0 + 2, data: { turn: "t1" }, source: "mod" })!;
  };
  const ev = (s: ReturnType<typeof base>, type: string, ms: number, data: Record<string, unknown> = {}) => st.reduce(s, { type, ts: T0 + ms, data, source: "mod" })!;
  test("blocked clears on a successful tool call more than 60 s after the report, not before", () => {
    let s = ev(base(), "StatusReported", 1000, { doing: "waiting for the iPad", blockedOn: "iPad locked" });
    expect(s.state).toBe("blocked");
    s = ev(s, "ToolFinished", 1000 + 30_000, { tool: "Bash", ok: true }); expect(s.state).toBe("blocked"); // too soon
    s = ev(s, "ToolFinished", 1000 + 61_000, { tool: "Bash", ok: false }); expect(s.state).toBe("blocked"); // failed call does not clear
    s = ev(s, "ToolFinished", 1000 + 62_000, { tool: "Bash", ok: true }); expect(s.state).toBe("working"); expect(s.reported?.blockedOn).toBeNull();
  });
  test("a task start or done supersedes the report; doing falls back to the task, then the tool", () => {
    let s = ev(base(), "TaskAdded", 100, { id: 1, text: "Pedals v3" });
    s = ev(s, "StatusReported", 1000, { doing: "Pedals v2 built; waiting", blockedOn: "iPad locked" });
    expect(st.doing(s, T0 + 2000)).toBe("Pedals v2 built; waiting");
    s = ev(s, "TaskStarted", 5000, { id: 1 });
    expect(s.reported?.expired).toBe(true); expect(s.reported?.blockedOn).toBeNull(); expect(s.state).toBe("working");
    expect(st.doing(s, T0 + 6000)).toBe("Pedals v3 (task)");
  });
  test("more than 3 min of tool activity, or a message acted on, expires it; age alone hides it from doing", () => {
    let s = ev(base(), "StatusReported", 1000, { doing: "refactoring" });
    expect(st.doing(s, T0 + 1000 + 181_000)).not.toBe("refactoring"); // age
    expect(ev(s, "ToolStarted", 1000 + 181_000, { tool: "Edit" }).reported?.expired).toBe(true);
    let m = ev(s, "MessageReceived", 5000, { msg_id: 1, peer: "root", kind: "info" }); expect(m.reported?.expired).toBeFalsy(); // received, not yet acted on
    m = ev(m, "ToolStarted", 6000, { tool: "Read" }); expect(m.reported?.expired).toBe(true);
  });
  test("a new report replaces an expired one", () => {
    let s = ev(base(), "StatusReported", 1000, { doing: "old", blockedOn: "x" });
    s = ev(s, "TaskDone", 2000, { id: 9 }); expect(s.reported?.expired).toBe(true);
    s = ev(s, "StatusReported", 3000, { doing: "new" }); expect(s.reported?.expired).toBeUndefined(); expect(st.doing(s, T0 + 4000)).toBe("new");
  });
});
