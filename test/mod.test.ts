// Review findings M4 and M5: the mod's hello retry and session lifecycle, against a fake host.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tokenFile = join(mkdtempSync(join(tmpdir(), "sd-mod-")), "a.token"); writeFileSync(tokenFile, "tok");
type H = (...a: unknown[]) => Promise<unknown>;
let n = 0;
/** Load a fresh copy of the mod (its state is module-level) and a fake host. `route` answers each request. */
async function host(route: (path: string, calls: string[]) => { ok: boolean; status: number; text: string } | Promise<{ ok: boolean; status: number; text: string }>, claude = "2.1.318") {
  const { register } = await import(`../plugin/hooks/register.ts?m=${++n}`);
  const logs: string[] = [], handlers: Record<string, H[]> = {}, calls: string[] = [], afters: (() => void)[] = [], tools: string[] = [];
  register((name: string, ...rest: unknown[]) => { (handlers[name] ??= []).push(rest.at(-1) as H); });
  const $ = {
    env: { get: async (k: string) => (k === "AGENTNET_TOKEN_FILE" ? tokenFile : null) }, fs: { read: async () => "tok" },
    session: { id: async () => "sid", model: async () => "m", version: async () => ({ version: claude }), append: async () => {} },
    process: { run: async () => ({ stdout: "4242\n" }) }, prompt: { submit: async () => {} }, ui: { status: () => {}, log: (t: string) => { logs.push(t); } }, tool: { register: async (t: { name: string }) => { tools.push(t.name); } },
    clock: { after: (_ms: number, f: () => void) => { afters.push(f); }, sleep: async () => {} },
    http: { fetch: async (url: string) => { const path = url.replace(/^.*\/agentnet/, "").split("?")[0]!; calls.push(path); return route(path, calls); } },
  };
  const fire = (name: string, e: Record<string, unknown> = {}) => (name === "tool.call" ? handlers[name]!.at(-1)! : handlers[name]![0]!)($, e, async (x: unknown) => x); // tool.call: the general handler is registered last
  return { fire, calls, afters, tools, logs, count: (p: string) => calls.filter((c) => c === p).length };
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
    await call(h, "ToolSearch"); await call(h, "mcp__agentnet__inbox"); await call(h, "mcp__agentnet__task_add");
    expect(h.count("/gate")).toBe(1);
  });
  test("an allow is cached briefly, a task tool call clears the cache, a sub-agent call is not asked, a service that is down lets the call through", async () => {
    const h = await gateHost(true); await h.fire("session.start"); await settle();
    await call(h, "Read"); await call(h, "Edit"); expect(h.count("/gate")).toBe(1);
    await h.fire("tool.call", { tool: "Read", tool_use_id: "s", agentId: "sub" }); expect(h.count("/gate")).toBe(1);
    const d = await gateHost("down"); await d.fire("session.start"); await settle();
    expect((await call(d, "Bash")).deny).toBeUndefined();
  });
});
