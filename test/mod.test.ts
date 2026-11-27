// Review findings M4 and M5: the mod's hello retry and session lifecycle, against a fake host.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tokenFile = join(mkdtempSync(join(tmpdir(), "sd-mod-")), "a.token"); writeFileSync(tokenFile, "tok");
type H = (...a: unknown[]) => Promise<unknown>;
let n = 0;
/** Load a fresh copy of the mod (its state is module-level) and a fake host. `route` answers each request. */
async function host(route: (path: string, calls: string[]) => { ok: boolean; status: number; text: string } | Promise<{ ok: boolean; status: number; text: string }>, claude = "2.1.318", engine: { submit?: (p: { text: string }) => Promise<unknown> } = {}) {
  const { register } = await import(`../plugin/hooks/register.ts?m=${++n}`);
  const logs: string[] = [], handlers: Record<string, H[]> = {}, calls: string[] = [], bodies: string[] = [], hellos: Record<string, unknown>[] = [], afters: (() => void)[] = [], tools: string[] = [];
  register((name: string, ...rest: unknown[]) => { (handlers[name] ??= []).push(rest.at(-1) as H); });
  const done: string[] = [], drops: string[] = []; // what the engine was asked, in order; the bodies of /owner-drop
  const $ = {
    env: { get: async (k: string) => (k === "AGENTNET_TOKEN_FILE" ? tokenFile : null) }, fs: { read: async () => "tok" },
    session: { id: async () => "sid", model: async () => "m", version: async () => ({ version: claude }), append: async () => {} },
    process: { run: async () => ({ stdout: "4242\n" }) }, prompt: { submit: async (p: { text: string }) => { done.push(`submit ${p.text}`); return engine.submit ? engine.submit(p) : {}; } },
    turn: { abort: async (a: { turnId: string }) => { done.push(`abort ${a.turnId}`); } }, ui: { status: () => {}, log: (t: string) => { logs.push(t); } }, tool: { register: async (t: { name: string }) => { tools.push(t.name); } },
    clock: { after: (_ms: number, f: () => void) => { afters.push(f); }, sleep: async () => {} },
    http: { fetch: async (url: string, init?: { body?: string }) => { const path = url.replace(/^.*\/agentnet/, "").split("?")[0]!; calls.push(path); if (path === "/bg" && init?.body) bodies.push(init.body); if (path === "/hello" && init?.body) hellos.push(JSON.parse(init.body)); if (path === "/owner-drop" && init?.body) drops.push(init.body); return route(path, calls); } },
  };
  const fire = (name: string, e: Record<string, unknown> = {}) => (name === "tool.call" ? handlers[name]!.at(-1)! : handlers[name]![0]!)($, e, async (x: unknown) => x); // tool.call: the general handler is registered last
  return { fire, calls, bodies, hellos, afters, tools, logs, done, drops, count: (p: string) => calls.filter((c) => c === p).length };
}
const ok = (o: unknown = {}) => ({ ok: true, status: 200, text: JSON.stringify(o) });
const settle = () => Bun.sleep(30);

describe("M4: a failed first hello is retried", () => {
  test("service down for two tries, then up: tools registered once, the poll loop starts", async () => {
    let helloTries = 0;
    const h = await host((p) => p === "/hello" ? (++helloTries < 3 ? { ok: false, status: 0, text: "" } : ok({ root: false })) : { ok: false, status: 401, text: "{}" });
    await h.fire("session.start"); await settle();
    expect(h.count("/hello")).toBe(3); expect(h.tools.length).toBeGreaterThan(0);
    h.afters.forEach((f) => f()); await settle();
    expect(h.count("/poll")).toBe(1);
    expect(new Set(h.tools).size).toBe(h.tools.length);
  });
});

describe("owner chat via the plugin", () => {
  test("hello says caps owner-chat on a Claude Code with asUser (2.1.286+), none on an older one", async () => {
    const now = await host(() => ok({ root: false }), "2.1.331");
    await now.fire("session.start"); await settle();
    expect(now.hellos[0]!.caps).toEqual(["owner-chat", "owner-abort"]);
    const floor = await host(() => ok({ root: false }), "2.1.286");
    await floor.fire("session.start"); await settle();
    expect(floor.hellos[0]!.caps).toEqual(["owner-chat"]); // too old for $.turn.abort
    for (const [v, caps] of [["2.1.324", ["owner-chat"]], ["2.1.325", ["owner-chat", "owner-abort"]]] as const) {
      const h = await host(() => ok({ root: false }), v);
      await h.fire("session.start"); await settle();
      expect(h.hellos[0]!.caps).toEqual([...caps]);
    }
    const old = await host(() => ok({ root: false }), "2.1.285");
    await old.fire("session.start"); await settle();
    expect(old.hellos[0]!.caps).toEqual([]);
  });
  test("a poll that works again after the service was down says hello again (a restart forgets the caps)", async () => {
    let polls = 0;
    const h = await host((p) => p === "/poll" ? (++polls === 1 ? { ok: false, status: 0, text: "" } : polls === 2 ? ok({ messages: [] }) : { ok: false, status: 401, text: "{}" }) : ok({ root: false }), "2.1.331");
    await h.fire("session.start"); await settle();
    expect(h.count("/hello")).toBe(1);
    h.afters.splice(0).forEach((f) => f()); await settle();
    expect(h.count("/poll")).toBe(3);
    expect(h.count("/hello")).toBe(2);
    expect(h.hellos[1]!.caps).toEqual(["owner-chat", "owner-abort"]);
  });
});

describe("owner Stop and Send now in the mod", () => {
  /** A session in turn `t1` whose polls answer `answers` one after the other, then end. */
  const run = async (answers: unknown[], engine: Parameters<typeof host>[2] = {}, busy = true) => {
    let polls = 0;
    const h = await host((p) => p === "/poll" ? (polls < answers.length ? ok(answers[polls++]) : { ok: false, status: 401, text: "{}" }) : ok({ root: false }), "2.1.331", engine);
    await h.fire("session.start"); await settle();
    if (busy) await h.fire("turn.start", { turnId: "t1", text: "work" });
    h.afters.splice(0).forEach((f) => f()); await settle();
    return h;
  };
  test("queued words go in first, then the running turn ends", async () => {
    const h = await run([{ messages: [], owner: [{ nonce: "n1", text: "one" }, { nonce: "n2", text: "two" }], abort: "t1" }]);
    expect(h.done).toEqual(["submit one", "submit two", "abort t1"]);
  });
  test("an empty turn id ends whatever runs; another turn's id ends nothing", async () => {
    expect((await run([{ messages: [], abort: "" }])).done).toEqual(["abort t1"]);
    expect((await run([{ messages: [], abort: "t0" }])).done).toEqual([]);
  });
  test("idle: nothing to end", async () => {
    expect((await run([{ messages: [], abort: "" }], {}, false)).done).toEqual([]);
  });
  test("a send Claude Code drops is reported; one it takes is not", async () => {
    const h = await run([{ messages: [], owner: [{ nonce: "n1", text: "lost" }, { nonce: "n2", text: "kept" }, { nonce: "n3", text: "refused" }] }],
      { submit: async (p) => { if (p.text === "refused") throw new Error("no"); return p.text === "lost" ? { drop: "the prompt was removed from the queue before it ran" } : {}; } });
    expect(h.drops.map((b) => JSON.parse(b).nonce).sort()).toEqual(["n1", "n3"]);
  });
});

describe("M5: session lifecycle", () => {
  test("only a final end reason says bye; a resume keeps the agent alive", async () => {
    const h = await host(() => ok({ messages: [] }));
    await h.fire("session.start"); h.afters.splice(0);
    await h.fire("session.end", { reason: "resume" });
    expect(h.count("/bye")).toBe(0);
    await h.fire("session.end", { reason: "prompt_input_exit" });
    expect(h.count("/bye")).toBe(1);
  });
  test("a new session.start after an end polls again", async () => {
    const h = await host((p) => p === "/poll" ? { ok: false, status: 401, text: "{}" } : ok({}));
    await h.fire("session.start"); h.afters.splice(0).forEach((f) => f()); await settle();
    expect(h.count("/poll")).toBe(1);                       // 401: the loop ended
    await h.fire("session.end", { reason: "prompt_input_exit" });
    await h.fire("session.start"); h.afters.splice(0).forEach((f) => f()); await settle();
    expect(h.count("/poll")).toBe(2);
  });
  test("two session.start in a row run one loop", async () => {
    const h = await host((p) => p === "/poll" ? new Promise(() => {}) : ok({}));
    await h.fire("session.start"); await h.fire("session.start");
    h.afters.splice(0).forEach((f) => f()); await settle();
    expect(h.count("/poll")).toBe(1);
  });
});

describe("owner check tools", () => {
  const tools = async (root: boolean) => {
    const h = await host((p) => p === "/hello" ? ok({ root }) : ok({ messages: [] }));
    await h.fire("session.start"); await settle();
    return h.tools;
  };
  test("ask_owner_check for every agent, list_checks for root only", async () => {
    const w = await tools(false), r = await tools(true);
    expect(w).toContain("ask_owner_check"); expect(w).not.toContain("list_checks");
    expect(r).toContain("ask_owner_check"); expect(r).toContain("list_checks");
  });
  test("the tool description tells agents to write a plain question and short answer buttons", async () => {
    const src = await Bun.file(join(import.meta.dir, "../plugin/hooks/register.ts")).text();
    const d = src.slice(src.indexOf('name: "ask_owner_check"'), src.indexOf('name: "set_status"'));
    expect(d).toContain("plain question to the owner"); expect(d).toContain("Do you see a Voice button"); expect(d).toContain("2-4 short answer buttons"); expect(d).toContain("tone");
  });
});

describe("C: Claude Code minimum version", () => {
  test("older than 2.1.293 logs one warning, even after a second hello; 2.1.293 and newer log nothing", async () => {
    const quiet = (p: string) => (p === "/poll" ? new Promise<never>(() => {}) : ok({ messages: [] }));
    const old = await host(quiet, "2.1.292");
    await old.fire("session.start"); await old.fire("session.end", { reason: "clear" }); old.afters.splice(0).forEach((f) => f()); await settle();
    expect(old.logs).toHaveLength(1); expect(old.logs[0]).toContain("2.1.293 or later (2.1.318+ recommended)");
    const edge = await host(quiet, "2.1.293 (Claude Code)");
    await edge.fire("session.start"); await settle(); expect(edge.logs).toHaveLength(0);
  });
  test("the numbers match src/core/claudeMin.ts", async () => {
    const { MIN_CLAUDE, RECOMMENDED_CLAUDE } = await import("../src/core/claudeMin");
    const src = await Bun.file(join(import.meta.dir, "../plugin/hooks/register.ts")).text();
    expect(src).toContain(`MIN_VERSION = "${MIN_CLAUDE}", RECOMMENDED_VERSION = "${RECOMMENDED_CLAUDE}"`);
  });
});

describe("B2: the work gate in the mod", () => {
  const gateHost = (allow: boolean | "down") => host((p) => p === "/gate" ? (allow === "down" ? { ok: false, status: 0, text: "" } : ok(allow ? { allow: true } : { allow: false, reason: "agentnet task gate: your task list is empty. Add your tasks first" })) : p === "/poll" ? new Promise<never>(() => {}) : ok({ messages: [] }));
  const call = (h: Awaited<ReturnType<typeof host>>, tool: string, extra: Record<string, unknown> = {}) => h.fire("tool.call", { tool, tool_use_id: "u", ...extra }) as Promise<{ deny?: string }>;
  test("work tools are denied with the service's reason; task tools, ToolSearch and the inbox are never asked", async () => {
    const h = await gateHost(false); await h.fire("session.start"); await settle();
    expect((await call(h, "Bash", { command: "ls" })).deny).toContain("Add your tasks first");
    await call(h, "ToolSearch"); await call(h, "mcp__agentnet__inbox"); await call(h, "mcp__agentnet__task_add"); await call(h, "mcp__agentnet__plan_set");
    expect((await call(h, "Read")).deny).toBeUndefined(); await call(h, "Grep"); await call(h, "Glob"); // reading is free: the agent reads its brief to write the plan
    expect(h.count("/gate")).toBe(1);
  });
  test("an allow is cached briefly, a task tool call clears the cache, a sub-agent call is not asked, a service that is down lets the call through", async () => {
    const h = await gateHost(true); await h.fire("session.start"); await settle();
    await call(h, "Bash"); await call(h, "Edit"); expect(h.count("/gate")).toBe(1);
    await h.fire("tool.call", { tool: "Read", tool_use_id: "s", agentId: "sub" }); expect(h.count("/gate")).toBe(1);
    const d = await gateHost("down"); await d.fire("session.start"); await settle();
    expect((await call(d, "Bash")).deny).toBeUndefined();
  });
});

describe("background shell rows", () => {
  test("a task-notification submitted as a prompt closes the shell row (it never arrives as session.receive)", async () => {
    const h = await host((p) => p === "/hello" ? ok({ root: false }) : p === "/gate" ? ok({ allow: true }) : ok());
    await h.fire("session.start"); await settle();
    await h.fire("tool.call", { tool: "Bash", tool_use_id: "u1", run_in_background: true, description: "Wait for the run", command: "sleep 9", result: { backgroundTaskId: "b785n6bzy" } }); await settle();
    expect(h.bodies.map((b) => JSON.parse(b).items[0].state)).toEqual(["running"]);
    await h.fire("prompt.submit", { text: "<task-notification>\n<task-id>b785n6bzy</task-id>\n<status>completed</status>\n</task-notification>", origin: { kind: "task-notification" }, wait: false }); await settle();
    expect(h.bodies.map((b) => JSON.parse(b).items[0]).map((i) => [i.id, i.state])).toEqual([["bg:b785n6bzy", "running"], ["bg:b785n6bzy", "done"]]);
    await h.fire("prompt.submit", { text: "<task-id>b785n6bzy</task-id>", origin: { kind: "composer" }, wait: false }); await settle();
    expect(h.bodies).toHaveLength(2); // a typed prompt never closes a row
  });
});

describe("a delivery that lands while the last turn is ending", () => {
  // Found live 2026-11-23: three new agents got their brief while their first turn was ending; it was appended to that turn,
  // the turn ended without another step, and the agents sat idle with the brief unread.
  const run = async (stepAfter: boolean) => {
    let polls = 0;
    const h = await host((p) => p === "/poll" ? (++polls === 1 ? ok({ messages: [{ id: 7 }], text: "#7 [task] root: \"Your brief\"" }) : new Promise(() => {})) : ok({ root: false }));
    await h.fire("session.start"); await settle();
    await h.fire("turn.start", { turnId: "t1", text: "boot" });
    h.afters.splice(0).forEach((f) => f()); await settle(); // the loop starts, the poll answers while the turn runs: appended
    if (stepAfter) await h.fire("tool.call", { tool: "mcp__agentnet__inbox" });
    await h.fire("turn.complete", { turnId: "t1", reason: "answer" });
    return { afters: h.afters };
  };
  test("no step after the append: a new turn is scheduled with the same text", async () => {
    const { afters } = await run(false);
    expect(afters.length).toBeGreaterThan(0);
  });
  test("a step after the append: nothing is scheduled again", async () => {
    const { afters } = await run(true);
    expect(afters.length).toBe(0);
  });
});

describe("per-session MCP switch in the mod", () => {
  /** A fake engine with two servers; the polls answer `answers`, then end. */
  const run = async (answers: unknown[], claude = "2.1.332", extra: { name: string; serverName: string }[] = [], joins: string[] = []) => {
    const { register } = await import(`../plugin/hooks/register.ts?m=${++n}`);
    const handlers: Record<string, H[]> = {}, posts: { path: string; body: Record<string, unknown> }[] = [], rows: string[] = [], state = new Map<string, unknown>(), afters: (() => void)[] = [];
    register((name: string, ...rest: unknown[]) => { (handlers[name] ??= []).push(rest.at(-1) as H); });
    let polls = 0, invalidated = 0;
    const $ = {
      env: { get: async (k: string) => (k === "AGENTNET_TOKEN_FILE" ? tokenFile : null) }, fs: { read: async () => "tok" },
      session: { id: async () => "sid", model: async () => "m", version: async () => ({ version: claude }), append: async (a: { message: { content: { text: string }[] } }) => { rows.push(a.message.content[0]!.text); },
        usage: async () => ({ context: { breakdown: { mcpTools: [{ name: "mcp__probe__ping", serverName: "probe" }, ...extra] } } }) },
      state: { get: async (r: { key: string }) => ({ value: state.get(r.key), version: 0 }), set: async (r: { key: string }, v: unknown) => { state.set(r.key, v); return { isSet: true, version: 1 }; } },
      mcp: { connect: async (s: string) => (s === "broken" ? { isConnected: false, reason: "failed" } : extra.some((x) => x.serverName === s && !joins.includes(s) && s !== "probe") ? { isConnected: false, reason: "unlisted" } : { isConnected: true, server: s }) },
      process: { run: async () => ({ stdout: "4242\n" }) }, prompt: { submit: async () => ({}) }, ui: { status: () => {}, log: () => {}, invalidate: () => { invalidated++; } }, tool: { register: async () => {} },
      clock: { after: (_ms: number, f: () => void) => { afters.push(f); }, sleep: async () => {} },
      http: { fetch: async (url: string, init?: { body?: string }) => { const path = url.replace(/^.*\/agentnet/, "").split("?")[0]!; if (init?.body) posts.push({ path, body: JSON.parse(init.body) });
        if (path === "/poll") return polls < answers.length ? ok(answers[polls++]) : { ok: false, status: 401, text: "{}" }; return ok({ root: false }); } },
    };
    const fire = (name: string, e: Record<string, unknown>, result: unknown = e) => handlers[name]![0]!($, e, async () => result);
    for (const server of ["probe", "broken", ...joins]) await fire("mcp.connect", { server });
    await fire("session.start", {}); await settle();
    afters.splice(0).forEach((f) => f()); await settle();
    const pool = { value: [{ name: "Bash", mcp: false }, { name: "mcp__probe__ping", mcp: true }, { name: "mcp__other__ping", mcp: true }] };
    const names = async () => ((await fire("tool.list", {}, pool)) as typeof pool).value.map((t) => t.name);
    return { posts, rows, state, names, invalidated: () => invalidated, report: () => posts.filter((p) => p.path === "/mcp").at(-1)?.body.servers };
  };
  test("an ask reports every server with its status; nothing is taken out of the tools", async () => {
    const h = await run([{ mcp: { set: [] } }]);
    expect(h.report()).toEqual([{ name: "broken", status: "failed", on: true }, { name: "probe", status: "connected", on: true, tools: 1 }]);
    expect(await h.names()).toEqual(["Bash", "mcp__probe__ping", "mcp__other__ping"]);
    expect(h.invalidated()).toBe(0);
  });
  test("tools count by their wire name: a server listed under another spelling still has its count", async () => {
    const h = await run([{ mcp: { set: [] } }], "2.1.332", [{ name: "mcp__claude_ai_Docs__read", serverName: "claude_ai_Docs" }], ["claude.ai Docs"]);
    expect(h.report()).toContainEqual({ name: "claude.ai Docs", status: "connected", on: true, tools: 1 });
    expect((h.report() as unknown[]).length).toBe(3);
  });
  test("off takes that server's tools out for the session; on brings them back and tells the model", async () => {
    const off = await run([{ mcp: { set: [{ server: "probe", on: false }, { server: "agentnet", on: false }] } }]);
    expect(await off.names()).toEqual(["Bash", "mcp__other__ping"]);
    expect(off.state.get("mcpOff")).toEqual(["probe"]); expect(off.invalidated()).toBe(1); expect(off.rows.filter((r) => r.includes("back on"))).toEqual([]);
    expect(off.report()).toContainEqual({ name: "probe", status: "connected", on: false, tools: 1 });
    const back = await run([{ mcp: { set: [{ server: "probe", on: false }] } }, { mcp: { set: [{ server: "probe", on: true }] } }]);
    expect(await back.names()).toContain("mcp__probe__ping");
    expect(back.rows.filter((r) => r.includes("probe back on"))).toHaveLength(1);
  });
  test("hello says caps mcp from the measured Claude Code on", async () => {
    expect((await run([], "2.1.332")).posts.find((p) => p.path === "/hello")!.body.caps).toContain("mcp");
    expect((await run([], "2.1.331")).posts.find((p) => p.path === "/hello")!.body.caps).not.toContain("mcp");
  });
});

test("the how-to note asks for a Jira key as a link to its ticket, with a made-up site", async () => {
  const src = await Bun.file(join(import.meta.dir, "../plugin/hooks/register.ts")).text();
  const note = src.split("\n").find((l) => l.startsWith("const NOTE = "))!;
  expect(note).toContain("write its key as a markdown link to it: `[ABC-123](https://example.atlassian.net/browse/ABC-123)`");
});
