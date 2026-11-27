import { beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oc-"));
process.env.AGENTNET_HOME ??= dir;
process.env.AGENTNET_CLAUDE_HOME = join(dir, "claude");
delete process.env.TMUX;
const { Database } = await import("bun:sqlite");
const { Hono } = await import("hono");
const { useDatabase } = await import("../core/db");
const { tracing } = await import("../core/http");
type Env = import("../core/http").Env;
const st = await import("./store");
const rt = await import("./routes");
const oc = await import("./ownerChat");
const wn = await import("./windows");
const op = await import("./ownerPlugin");
const lv = await import("./liveness");
const { projectDir, sent } = await import("./feed");

const calls: string[][] = [], sessions = new Set<string>(["agentnet-oc-1"]);
const tmux: import("./windows").Tmux = { run: (a) => {
  calls.push(a);
  if (a[0] === "has-session") return { code: sessions.has(a[2]!.replace(/^=/, "")) ? 0 : 1, out: "" };
  return { code: 0, out: "" };
} };
const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); oc.ownerChatRoutes(api, { tmux, sleep: async () => {}, tickMs: 20 }); app.route("/api/v1", api);
const post = (name: string, body: unknown) => app.request(`/api/v1/agentnet/agents/${name}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  useDatabase(new Database(":memory:")); st._reset(); calls.length = 0; op.ownerReset(); sessions.clear(); sessions.add("agentnet-oc-1");
  rt.createAgent({ name: "oc-1", boss: "root", job: "t", by: "test", project: "/work/oc-proj" });
});

describe("POST /prompt: the agentnet plugin is the only way in", () => {
  const ev = (name: string, type: string) => { const a = st.live().find((x) => x.name === name)!; st.emit({ agent: a.id, type, data: { session: "s", pid: 1, turn: "t1" }, source: "mod", ts: Date.now() } as never); st.flush(); };
  const queued = () => ({ sent: true, via: "plugin" });
  /** Nothing at all asked of tmux: no paste, no keys, not even a session lookup. */
  const noTmux = () => expect(calls).toEqual([]);

  test("idle agent in tmux: queued for its plugin, nothing typed, the page sees it as sending", async () => {
    op.setOwnerCapable("oc-1", true); ev("oc-1", "AgentConnected");
    const r = await post("oc-1", { text: "line one\r\nline two", nonce: "n-1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agent: "oc-1", nonce: "n-1", ...queued() });
    noTmux();
    expect(sent.pending("oc-1").map((e) => e.nonce)).toContain("n-1");
    expect(op.ownerTake("oc-1")).toMatchObject([{ nonce: "n-1", text: "line one\nline two" }]);
  });
  test("mid-turn: queued for the plugin too, never typed into the running turn", async () => {
    op.setOwnerCapable("oc-1", true); ev("oc-1", "AgentConnected"); ev("oc-1", "TurnStarted");
    const r = await post("oc-1", { text: "while you work", nonce: "b-1", via: "tmux" }); // an old page's `via` changes nothing
    expect(await r.json()).toEqual({ agent: "oc-1", nonce: "b-1", ...queued() });
    noTmux();
    expect(op.ownerTake("oc-1")).toMatchObject([{ nonce: "b-1", text: "while you work" }]);
  });
  test("the director, with an agentnet-root session or without one: through its plugin", async () => {
    op.setOwnerCapable("root", true);
    for (const inTmux of [false, true]) {
      if (inTmux) sessions.add(wn.rootSession());
      const r = await post("root", { text: `status ${inTmux}`, nonce: `r-${inTmux}` });
      expect(r.status).toBe(200); expect(await r.json()).toEqual({ agent: "root", nonce: `r-${inTmux}`, ...queued() });
      expect(op.ownerTake("root").map((i) => i.text)).toEqual([`status ${inTmux}`]);
    }
    noTmux();
  });
  test("plugin not connected: 200 with a `waiting` sentence, held until a plugin that can take it connects", async () => {
    const r = await post("oc-1", { text: "are you there", nonce: "w-1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agent: "oc-1", nonce: "w-1", ...queued(), waiting: oc.NO_PLUGIN });
    noTmux();
    expect(op.ownerTake("oc-1")).toEqual([]); // an old plugin's poll must not swallow it
    expect(sent.pending("oc-1").map((e) => e.nonce)).toContain("w-1");
    op.setOwnerCapable("oc-1", true);
    expect(op.ownerTake("oc-1")).toMatchObject([{ nonce: "w-1", text: "are you there" }]);
  });
  test("a director that has gone is waiting, even though its plugin once connected", async () => {
    rt.createAgent({ name: "root", boss: "root", job: "d", by: "test", project: "/work/oc-proj" });
    op.setOwnerCapable("root", true); ev("root", "AgentConnected"); ev("root", "AgentGone");
    expect(await (await post("root", { text: "wake up", nonce: "g-1" })).json()).toMatchObject({ waiting: oc.NO_PLUGIN });
  });
  test("a retry of a nonce that still waits replaces it: the agent gets it once", async () => {
    await post("oc-1", { text: "once only", nonce: "re-1" });
    await post("oc-1", { text: "once only", nonce: "re-1" });
    op.setOwnerCapable("oc-1", true);
    expect(op.ownerTake("oc-1").map((i) => i.text)).toEqual(["once only"]);
    expect(sent.pending("oc-1").filter((e) => e.nonce === "re-1")).toHaveLength(1);
  });
  test("404 unknown agent, 422 empty / over 8 kB / bad name; none of them queues", async () => {
    expect((await post("nobody", { text: "x" })).status).toBe(404);
    expect((await post("oc-1", { text: "   " })).status).toBe(422);
    expect((await post("oc-1", { text: "x".repeat(8193) })).status).toBe(422);
    expect((await post("BAD_NAME", { text: "x" })).status).toBe(422);
    op.setOwnerCapable("oc-1", true); expect(op.ownerHas("oc-1")).toBe(false); noTmux();
  });
});

describe("GET /feed", () => {
  test("reset with the transcript items, then only the new ones; pending shows a send until the transcript has it", async () => {
    const cwd = "/work/oc-proj", pd = projectDir(cwd); mkdirSync(pd, { recursive: true });
    const f = join(pd, "sess-1.jsonl");
    writeFileSync(f, JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "text", text: "hello owner" }] } }) + "\n");
    const a = st.live().find((x) => x.name === "oc-1")!;
    st.emit({ agent: a.id, type: "AgentConnected", data: { session: "sess-1", pid: 1 }, source: "mod", ts: Date.now() }); st.flush();
    expect(st.live().find((x) => x.name === "oc-1")).toMatchObject({ session: "sess-1", project: cwd });
    sent.add("oc-1", "next", "nz");
    const res = await app.request("/api/v1/agentnet/agents/oc-1/feed");
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
    const until = async (re: RegExp) => { const end = Date.now() + 3000; while (!re.test(buf) && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return re.test(buf); };
    expect(await until(/event: reset[\s\S]*hello owner/)).toBe(true);
    expect(buf).toContain('"sending":true');
    appendFileSync(f, JSON.stringify({ type: "user", uuid: "u9", timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { content: "next" } }) + "\n");
    expect(await until(/event: items[\s\S]*"nonce":"nz"/)).toBe(true);
    await reader.cancel();
  });
  test("a new transcript line goes out when the file changes, not on the next tick", async () => {
    const cwd = "/work/oc-proj", pd = projectDir(cwd); mkdirSync(pd, { recursive: true });
    const f = join(pd, "sess-w.jsonl");
    writeFileSync(f, JSON.stringify({ type: "assistant", uuid: "w1", timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "text", text: "first line" }] } }) + "\n");
    const a = st.live().find((x) => x.name === "oc-1")!;
    st.emit({ agent: a.id, type: "AgentConnected", data: { session: "sess-w", pid: 1 }, source: "mod", ts: Date.now() }); st.flush();
    const appW = new Hono<Env>(); const apiW = new Hono<Env>(); oc.ownerChatRoutes(apiW, { tmux, sleep: async () => {}, tickMs: 60_000 }); appW.route("/api/v1", apiW);
    const res = await appW.request("/api/v1/agentnet/agents/oc-1/feed");
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
    const until = async (re: RegExp, ms: number) => {
      const end = Date.now() + ms;
      while (!re.test(buf) && Date.now() < end) {
        const r = await Promise.race([reader.read(), Bun.sleep(end - Date.now()).then(() => null)]);
        if (!r || r.done) break; buf += dec.decode(r.value);
      }
      return re.test(buf);
    };
    expect(await until(/event: reset[\s\S]*first line/, 3000)).toBe(true);
    const t0 = performance.now();
    appendFileSync(f, JSON.stringify({ type: "assistant", uuid: "w2", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "second line" }] } }) + "\n");
    expect(await until(/event: items[\s\S]*second line/, 500)).toBe(true);
    console.log(`new transcript line reached the stream in ${(performance.now() - t0).toFixed(1)} ms (tick 60 s)`);
    await reader.cancel();
  });
});

describe("POST /send-now: the plugin ends the turn, nothing is pressed", () => {
  const now = (name: string, body: unknown) => app.request(`/api/v1/agentnet/agents/${name}/send-now`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ev = (type: string, name = "oc-1") => { const a = st.live().find((x) => x.name === name)!; st.emit({ agent: a.id, type, data: { session: "s", pid: 1, turn: "t1" }, source: "mod", ts: Date.now() } as never); st.flush(); return a.id; };
  /** A connected plugin that can end a turn, on an agent in a turn. */
  const working = () => { op.setOwnerCapable("oc-1", true); op.setOwnerAbortable("oc-1", true); ev("AgentConnected"); lv.pollOpened(ev("TurnStarted")); };

  test("working: one cut for the running turn, no tmux at all", async () => {
    working(); sent.add("oc-1", "what is 2+2", "sn-1");
    const r = await now("oc-1", { nonce: "sn-1" });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ agent: "oc-1", nonce: "sn-1", interrupted: true });
    expect(op.ownerTakeCut("oc-1")).toBe("t1");
    expect(calls).toEqual([]);
  });
  test("two clicks end one turn", async () => {
    working(); sent.add("oc-1", "twice", "sn-2");
    await now("oc-1", { nonce: "sn-2" }); op.ownerTakeCut("oc-1");
    expect(await (await now("oc-1", { nonce: "sn-2" })).json()).toMatchObject({ interrupted: false, already: true });
    expect(op.ownerTakeCut("oc-1")).toBeNull();
  });
  test("idle agent: nothing to end", async () => {
    op.setOwnerCapable("oc-1", true); op.setOwnerAbortable("oc-1", true); lv.pollOpened(ev("AgentConnected"));
    sent.add("oc-1", "hello", "sn-3");
    expect(await (await now("oc-1", { nonce: "sn-3" })).json()).toEqual({ agent: "oc-1", nonce: "sn-3", interrupted: false });
    expect(op.ownerTakeCut("oc-1")).toBeNull();
  });
  test("a plugin that cannot end a turn: 409 NO_ABORT and no Escape, which would drop the message", async () => {
    op.setOwnerCapable("oc-1", true); ev("AgentConnected"); lv.pollOpened(ev("TurnStarted"));
    sent.add("oc-1", "old", "sn-4");
    const r = await now("oc-1", { nonce: "sn-4" });
    expect(r.status).toBe(409); expect(await r.json()).toMatchObject({ code: "NO_ABORT", detail: oc.NO_ABORT });
    expect(calls).toEqual([]);
    expect(sent.pending("oc-1").find((e) => e.nonce === "sn-4")!.failed).toBeUndefined();
  });
  test("the director too: its plugin ends the turn, nothing reaches its terminal", async () => {
    op.setOwnerCapable("root", true); op.setOwnerAbortable("root", true); lv.pollOpened(rt.ADMIN.id);
    sent.add("root", "to the director", "sn-5");
    expect(await (await now("root", { nonce: "sn-5" })).json()).toMatchObject({ interrupted: true });
    expect(op.ownerTakeCut("root")).toBe(""); // no card: whatever turn runs
    expect(calls).toEqual([]);
  });
  test("409 TAKEN once the transcript has the message or Claude Code dropped it", async () => {
    working(); sent.add("oc-1", "taken one", "sn-6"); sent.claim("oc-1", "taken one", Date.now());
    sent.add("oc-1", "dropped one", "sn-7"); sent.fail("oc-1", "sn-7");
    for (const nonce of ["sn-6", "sn-7"]) { const r = await now("oc-1", { nonce }); expect(r.status).toBe(409); expect((await r.json() as { code: string }).code).toBe("TAKEN"); }
    expect(op.ownerTakeCut("oc-1")).toBeNull();
  });
  test("bad nonce 422, unknown agent 404", async () => {
    expect((await now("oc-1", {})).status).toBe(422);
    expect((await now("nobody", { nonce: "x" })).status).toBe(404);
  });
});

describe("a dropped send", () => {
  test("shows in the feed as failed, not as sending", async () => {
    sent.add("oc-1", "dropped by a stop", "dr-1"); sent.fail("oc-1", "dr-1");
    const res = await app.request("/api/v1/agentnet/agents/oc-1/feed");
    const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = "";
    const end = Date.now() + 3000;
    while (!/event: reset[^\n]*\n[^\n]*dr-1/.test(buf) && Date.now() < end) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
    await reader.cancel();
    const data = JSON.parse(buf.split("event: reset")[1]!.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as { pending: Record<string, unknown>[] };
    const item = data.pending.find((i) => i.nonce === "dr-1")!;
    expect(item.failed).toBe(true); expect(item.sending).toBeUndefined();
  });
});

describe("history page reads a window of the transcript, never the whole file", () => {
  const f = join(dir, "hist-win.jsonl");
  // 400 replies of about 1 kB each: a 40 kB window holds about 40 of them
  writeFileSync(f, Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: "assistant", uuid: `h${i}`, timestamp: "2026-11-10T10:00:00Z", message: { content: [{ type: "text", text: `reply ${i} ${"x".repeat(1000)}` }] } }) + "\n").join(""));
  test("first page, next page, end", () => {
    const cache = new Map();
    const p1 = oc.historyPage(cache, f, "a", "h390:0", 10, 40_000);
    expect(p1.items.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, k) => `h${380 + k}:0`));
    expect(p1.more).toBe(true);
    const p2 = oc.historyPage(cache, f, "a", "h20:0", 10, 40_000); // far back: the window widens until it reaches it
    expect(p2.items.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, k) => `h${10 + k}:0`));
    const end = oc.historyPage(cache, f, "a", "h5:0", 10, 40_000);
    expect(end.items.map((i) => i.id)).toEqual(["h0:0", "h1:0", "h2:0", "h3:0", "h4:0"]);
    expect(end.more).toBe(false);
    expect(oc.historyPage(cache, f, "a", "nope", 10, 40_000)).toEqual({ items: [], more: false });
  });
  test("a page near the end parses only the window", () => {
    const cache = new Map<string, { p: { start: number }; at: number }>();
    oc.historyPage(cache as never, f, "a", "h395:0", 10, 40_000);
    expect([...cache.values()][0]!.p.start).toBeGreaterThan(300_000);
  });
});
