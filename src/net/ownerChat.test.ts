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
const { projectDir, sent } = await import("./feed");

const calls: string[][] = [], sessions = new Set<string>(["agentnet-oc-1"]);
let failPaste = false;
const tmux: import("./windows").Tmux = { run: (a) => {
  calls.push(a);
  if (a[0] === "has-session") return { code: sessions.has(a[2]!.replace(/^=/, "")) ? 0 : 1, out: "" };
  if (a[0] === "paste-buffer" && failPaste) return { code: 1, out: "" };
  return { code: 0, out: "" };
} };
const app = new Hono<Env>(); app.use("*", tracing); const api = new Hono<Env>(); oc.ownerChatRoutes(api, { tmux, sleep: async () => {}, tickMs: 20 }); app.route("/api/v1", api);
const post = (name: string, body: unknown) => app.request(`/api/v1/agentnet/agents/${name}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  useDatabase(new Database(":memory:")); st._reset(); calls.length = 0; failPaste = false; sessions.clear(); sessions.add("agentnet-oc-1");
  rt.createAgent({ name: "oc-1", boss: "root", job: "t", by: "test", project: "/work/oc-proj" });
});

describe("POST /prompt", () => {
  test("types with a bracketed paste, then Enter, into the exact session", async () => {
    const r = await post("oc-1", { text: "line one\nline two", nonce: "n-1" });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ sent: true, nonce: "n-1" });
    await oc.settled("oc-1");
    expect(calls.filter((c) => c[0] !== "has-session")).toEqual([
      ["set-buffer", "-b", expect.stringContaining("agentnet-prompt"), "--", "line one\nline two"],
      ["paste-buffer", "-p", "-d", "-b", expect.stringContaining("agentnet-prompt"), "-t", "=agentnet-oc-1:"],
      ["send-keys", "-t", "=agentnet-oc-1:", "Enter"],
    ]);
    expect(sent.pending("oc-1").map((e) => e.nonce)).toContain("n-1");
  });
  test("NO_TERMINAL (409) when the agent has no tmux session; nothing is typed", async () => {
    sessions.clear();
    const r = await post("oc-1", { text: "hi" });
    expect(r.status).toBe(409); const j = await r.json() as { code: string; detail: string };
    expect(j.code).toBe("NO_TERMINAL"); expect(j.detail).toContain("cannot type into");
    expect(calls.some((c) => c[0] === "paste-buffer")).toBe(false);
  });
  test("the director with no tmux session is NO_TERMINAL and offers Move director", async () => {
    const r = await post("root", { text: "hi" });
    expect(r.status).toBe(409); expect((await r.json() as { detail: string }).detail).toContain("Move director");
  });
  test("the director in agentnet-root gets the text", async () => {
    sessions.add(wn.rootSession());
    expect((await post("root", { text: "as the owner" })).status).toBe(200);
    expect(calls.find((c) => c[0] === "paste-buffer")).toContain(`=${wn.rootSession()}:`);
  });
  test("404 unknown agent, 422 empty / over 8 kB / bad name, 502 when tmux refuses", async () => {
    expect((await post("nobody", { text: "x" })).status).toBe(404);
    expect((await post("oc-1", { text: "   " })).status).toBe(422);
    expect((await post("oc-1", { text: "x".repeat(8193) })).status).toBe(422);
    expect((await post("BAD_NAME", { text: "x" })).status).toBe(422);
    failPaste = true; expect((await post("oc-1", { text: "x" })).status).toBe(502);
  });
  test("answers after the paste, before the Enter wait; two prompts never interleave; a refused Enter marks the send failed", async () => {
    const app2 = new Hono<Env>(); app2.use("*", tracing); const api2 = new Hono<Env>();
    let failEnter = false;
    const t2: import("./windows").Tmux = { run: (a) => { calls.push(a); return { code: a[0] === "send-keys" && failEnter ? 1 : 0, out: "" }; } };
    oc.ownerChatRoutes(api2, { tmux: t2, sleep: (ms) => Bun.sleep(ms), tickMs: 20 }); app2.route("/api/v1", api2);
    const p2 = (body: unknown) => app2.request("/api/v1/agentnet/agents/oc-1/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const t0 = performance.now();
    const r = await p2({ text: "first", nonce: "q-1" });
    const ms = performance.now() - t0;
    expect(r.status).toBe(200); expect(ms).toBeLessThan(oc.ENTER_WAIT / 2);
    expect(calls.some((c) => c[0] === "send-keys")).toBe(false); // Enter has not been pressed yet
    failEnter = true;
    await p2({ text: "second", nonce: "q-2" }); // waits for the first Enter, then pastes
    const order = calls.filter((c) => c[0] === "paste-buffer" || c[0] === "send-keys").map((c) => c[0]);
    expect(order).toEqual(["paste-buffer", "send-keys", "paste-buffer"]);
    await oc.settled("oc-1");
    expect(sent.pending("oc-1").find((e) => e.nonce === "q-2")).toMatchObject({ failed: true });
    console.log(`prompt route answered in ${ms.toFixed(1)} ms (fake tmux, real ${oc.ENTER_WAIT} ms Enter wait)`);
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

describe("POST /send-now", () => {
  const RULE = "─".repeat(40);
  const paneWith = (box: string) => `⏺ working on it\n${RULE} oc-1 ─\n❯ ${box}\n${RULE}\n  Sonnet`;
  let pane = paneWith("Press up to edit queued messages");
  const t3: import("./windows").Tmux = { run: (a) => {
    calls.push(a);
    if (a[0] === "has-session") return { code: sessions.has(a[2]!.replace(/^=/, "")) ? 0 : 1, out: "" };
    if (a[0] === "capture-pane") return { code: 0, out: pane };
    return { code: 0, out: "" };
  } };
  const app3 = new Hono<Env>(); app3.use("*", tracing); const api3 = new Hono<Env>(); oc.ownerChatRoutes(api3, { tmux: t3, sleep: async () => {}, tickMs: 20 }); app3.route("/api/v1", api3);
  const now = (name: string, body: unknown) => app3.request(`/api/v1/agentnet/agents/${name}/send-now`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const work = () => { const a = st.live().find((x) => x.name === "oc-1")!; st.emit({ agent: a.id, type: "AgentConnected", data: { session: "s", pid: 1 }, source: "mod", ts: Date.now() }); st.emit({ agent: a.id, type: "TurnStarted", data: { turn: "t1" }, source: "mod", ts: Date.now() }); st.flush(); };
  const keys = () => calls.filter((c) => c[0] === "send-keys").map((c) => c[3]);

  test("queued while working: one Escape and no retype (Claude Code submits the queue itself)", async () => {
    work(); pane = paneWith("Press up to edit queued messages");
    sent.add("oc-1", "what is 2+2", "sn-1");
    const r = await now("oc-1", { nonce: "sn-1" });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ interrupted: true, entered: false });
    expect(keys()).toEqual(["Escape"]);
    expect(calls.some((c) => c[0] === "paste-buffer" || c[0] === "set-buffer")).toBe(false);
  });
  test("the text left in the input box after the Escape gets one Enter", async () => {
    work(); pane = paneWith("what is 2+2");
    sent.add("oc-1", "what is 2+2", "sn-2");
    expect(await (await now("oc-1", { nonce: "sn-2" })).json()).toMatchObject({ interrupted: true, entered: true });
    expect(keys()).toEqual(["Escape", "Enter"]);
  });
  test("idle agent: no Escape; an empty box gets nothing", async () => {
    pane = paneWith("");
    sent.add("oc-1", "hello", "sn-3");
    expect(await (await now("oc-1", { nonce: "sn-3" })).json()).toMatchObject({ interrupted: false, entered: false });
    expect(keys()).toEqual([]);
  });
  test("409 TAKEN once the transcript has the message, so a late click never stops the turn that answers it", async () => {
    work(); sent.add("oc-1", "taken one", "sn-4"); sent.claim("oc-1", "taken one", Date.now());
    const r = await now("oc-1", { nonce: "sn-4" });
    expect(r.status).toBe(409); expect((await r.json() as { code: string }).code).toBe("TAKEN");
    expect(keys()).toEqual([]);
  });
  test("two clicks at once send one Escape (a second would open the rewind menu)", async () => {
    work(); pane = paneWith("Press up to edit queued messages");
    const slow = new Hono<Env>(); const sa = new Hono<Env>(); oc.ownerChatRoutes(sa, { tmux: t3, sleep: (ms) => Bun.sleep(ms), tickMs: 20 }); slow.route("/api/v1", sa);
    sent.add("oc-1", "twice", "sn-5");
    const go = () => slow.request("/api/v1/agentnet/agents/oc-1/send-now", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: "sn-5" }) });
    await Promise.all([go(), go()]);
    expect(keys()).toEqual(["Escape"]);
  });
  test("root 403, bad nonce 422, unknown agent 404", async () => {
    expect((await now("root", { nonce: "x" })).status).toBe(403);
    expect((await now("oc-1", {})).status).toBe(422);
    expect((await now("nobody", { nonce: "x" })).status).toBe(404);
  });
  test("inputHolds reads the box between the bottom rules", () => {
    expect(oc.inputHolds(paneWith("[Pasted text #1 +6 lines]"), "a\nb")).toBe(true);
    expect(oc.inputHolds(paneWith("Press up to edit queued messages"), "x")).toBe(false);
    expect(oc.inputHolds(paneWith("something else"), "what is 2+2")).toBe(false);
    expect(oc.inputHolds("no rules here\n❯ hi", "hi")).toBe(false);
  });
});

describe("owner chat via the plugin (default on, AGENTNET_OWNER_VIA_PLUGIN=0 = off)", () => {
  const op = () => import("./ownerPlugin");
  test("flag 0: tmux as before, even for a capable plugin", async () => {
    const o = await op(); o.ownerReset(); o.setOwnerCapable("oc-1", true); process.env.AGENTNET_OWNER_VIA_PLUGIN = "0";
    try {
      const r = await post("oc-1", { text: "hi", nonce: "t-1" }); await oc.settled("oc-1");
      expect(await r.json()).not.toHaveProperty("via"); expect(calls.some((c) => c[0] === "paste-buffer")).toBe(true); expect(o.ownerHas("oc-1")).toBe(false);
    } finally { delete process.env.AGENTNET_OWNER_VIA_PLUGIN; o.ownerReset(); }
  });
  test("flag unset + capable: the plugin path by default", async () => {
    const o = await op(); o.ownerReset(); o.setOwnerCapable("oc-1", true); delete process.env.AGENTNET_OWNER_VIA_PLUGIN;
    try {
      const r = await post("oc-1", { text: "by default", nonce: "d-1" });
      expect(await r.json()).toMatchObject({ via: "plugin" }); expect(calls.some((c) => c[0] === "paste-buffer")).toBe(false);
      expect(o.ownerTake("oc-1")).toMatchObject([{ nonce: "d-1", text: "by default" }]);
    } finally { o.ownerReset(); }
  });
  test("routes by state: idle goes to the plugin, mid-turn goes to tmux so it lands in the turn; via plugin still forces it", async () => {
    const o = await op(); o.ownerReset(); o.setOwnerCapable("oc-1", true); delete process.env.AGENTNET_OWNER_VIA_PLUGIN;
    const ev = (type: string) => { const a = st.live().find((x) => x.name === "oc-1")!; st.emit({ agent: a.id, type, data: { session: "s", pid: 1, turn: "t1" }, source: "mod", ts: Date.now() } as never); st.flush(); };
    try {
      ev("AgentConnected"); ev("TurnStarted");
      const busy = await post("oc-1", { text: "while you work", nonce: "b-1" }); await oc.settled("oc-1");
      expect((await busy.json() as { via?: string }).via).toBeUndefined();
      expect(calls.some((c) => c[0] === "paste-buffer")).toBe(true); expect(o.ownerHas("oc-1")).toBe(false);
      calls.length = 0;
      const forced = await post("oc-1", { text: "A/B", nonce: "b-2", via: "plugin" });
      expect(await forced.json()).toMatchObject({ via: "plugin" }); expect(o.ownerTake("oc-1")).toHaveLength(1);
      ev("TurnEnded");
      const idle = await post("oc-1", { text: "now idle", nonce: "b-3" });
      expect(await idle.json()).toMatchObject({ via: "plugin" }); expect(calls.some((c) => c[0] === "paste-buffer")).toBe(false);
      expect(o.ownerTake("oc-1")).toMatchObject([{ nonce: "b-3", text: "now idle" }]);
    } finally { o.ownerReset(); }
  });
  test("root stays on tmux even when it is capable", async () => {
    const o = await op(); o.ownerReset(); o.setOwnerCapable("root", true); delete process.env.AGENTNET_OWNER_VIA_PLUGIN;
    try { await post("root", { text: "to the director" }); expect(o.ownerHas("root")).toBe(false); }
    finally { o.ownerReset(); }
  });
  test("flag list + capable: queued for the plugin, nothing typed, page sees it as sending; via tmux overrides", async () => {
    const o = await op(); o.ownerReset(); o.setOwnerCapable("oc-1", true); process.env.AGENTNET_OWNER_VIA_PLUGIN = "oc-1";
    try {
      const r = await post("oc-1", { text: "hello there", nonce: "p-1" });
      expect(await r.json()).toMatchObject({ sent: true, nonce: "p-1", via: "plugin" });
      expect(calls.filter((c) => c[0] !== "has-session")).toEqual([]);
      expect(sent.pending("oc-1").map((e) => e.nonce)).toContain("p-1");
      expect(o.ownerTake("oc-1")).toMatchObject([{ nonce: "p-1", text: "hello there" }]);
      await post("oc-1", { text: "by tmux", via: "tmux" }); await oc.settled("oc-1");
      expect(calls.some((c) => c[0] === "paste-buffer")).toBe(true); expect(o.ownerHas("oc-1")).toBe(false);
    } finally { delete process.env.AGENTNET_OWNER_VIA_PLUGIN; o.ownerReset(); }
  });
  test("flag on, plugin never said it can: tmux", async () => {
    const o = await op(); o.ownerReset(); process.env.AGENTNET_OWNER_VIA_PLUGIN = "1";
    try { await post("oc-1", { text: "hi" }); await oc.settled("oc-1"); expect(calls.some((c) => c[0] === "paste-buffer")).toBe(true); }
    finally { delete process.env.AGENTNET_OWNER_VIA_PLUGIN; }
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
