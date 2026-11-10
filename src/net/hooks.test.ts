import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Env } from "../core/http";
import { LAN, LOOP } from "../../test/helpers";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-hooks-"));

let d = "";
// The catalogue is data, not code: a test catalogue that names the hooks of `base` and the logs the other tests write.
const CATALOG = [
  { match: "skill-dispatch\\.js", name: "Skill router", about: "Adds a hint for the skills that fit the prompt." },
  { match: "triage\\.py", name: "Prompt triage", about: "Classifies each prompt.", log: "triage.jsonl", script: "triage.py" },
  { match: "agent-pretrust\\.py", name: "Agent pre-trust", about: "Trusts a sub-agent folder.", log: "agent-pretrust.jsonl", script: "agent-pretrust.py" },
  { match: "task-guard\\.py", name: "Task list guard", about: "Reminds an agent about its task list.", log: "task-guard.jsonl", script: "task-guard.py" },
  { match: "auto-ack\\.py", name: "Auto acknowledge", about: "Acknowledges a request.", log: "auto-ack.jsonl", script: "auto-ack.py" },
];
const base = { env: { SECRET: "x" }, model: "opus", hooks: {
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "node ~/.claude/hooks/skill-dispatch.js", timeout: 5 }, { type: "command", command: "/x/triage.py", timeout: 6 }] }],
  PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "/x/agent-pretrust.py", timeout: 10 }] }],
} };
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "hooks-"));
  process.env.CLAUDE_SETTINGS_FILE = join(d, "settings.json"); process.env.AGENTNET_HOOKS_DATA = join(d, "data"); process.env.AGENTNET_HOOK_LOGS = join(d, "logs");
  writeFileSync(process.env.CLAUDE_SETTINGS_FILE, JSON.stringify(base, null, 2));
  process.env.AGENTNET_HOOK_CATALOG = join(d, "hook-catalog.json");
  writeFileSync(process.env.AGENTNET_HOOK_CATALOG, JSON.stringify(CATALOG));
});
afterEach(() => { delete process.env.AGENTNET_HOOK_CATALOG; rmSync(d, { recursive: true, force: true }); });

test("list gives names, ids, timeouts", async () => {
  const { listHooks } = await import("./hooks");
  const l = listHooks();
  expect(l.length).toBe(3);
  expect(l.find((h) => h.name === "Prompt triage")?.timeout).toBe(6);
  expect(l.find((h) => h.event === "PreToolUse")?.matcher).toBe("Agent");
});
test("off then on restores the exact file, other keys untouched, backup made", async () => {
  const { listHooks, setHookEnabled, backups } = await import("./hooks");
  const before = readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8");
  const id = listHooks().find((h) => h.name === "Prompt triage")!.id;
  const off = setHookEnabled(id, false);
  expect(off.find((h) => h.id === id)?.enabled).toBe(false);
  const mid = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8"));
  expect(mid.env.SECRET).toBe("x");
  expect(mid.hooks.UserPromptSubmit[0].hooks.length).toBe(1);
  expect(backups().length).toBe(1);
  setHookEnabled(id, true);
  expect(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).toBe(before);
});
test("last hook of an event leaves no empty event; rollback restores", async () => {
  const { listHooks, setHookEnabled, rollback } = await import("./hooks");
  const id = listHooks().find((h) => h.event === "PreToolUse")!.id;
  setHookEnabled(id, false);
  expect(JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).hooks.PreToolUse).toBeUndefined();
  rollback();
  expect(JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS_FILE!, "utf8")).hooks.PreToolUse.length).toBe(1);
  expect(listHooks().filter((h) => !h.enabled).length).toBe(0);
});
test("unknown id throws and leaves no temp files", async () => {
  const { setHookEnabled } = await import("./hooks");
  expect(() => setHookEnabled("nope", false)).toThrow();
  expect(readdirSync(d).filter((n) => n.includes("tmp")).length).toBe(0);
});
test("log stats count failures and latency", async () => {
  const { logStats } = await import("./hooks");
  mkdtempSync; process.env.AGENTNET_HOOK_LOGS = d;
  writeFileSync(join(d, "t.jsonl"), [{ ts: "2026-11-02T10:00:00", ms: 100 }, { ts: "2026-11-02T10:01:00", ms: 300, err: "boom" }].map((x) => JSON.stringify(x)).join("\n"));
  const s = logStats("t.jsonl");
  expect(s.runs).toBe(2); expect(s.failures).toBe(1); expect(s.avgMs).toBe(200);
});

test("a line appended to a hook log fires an event; no timer", async () => {
  const { onHookFire, hookNodes } = await import("./hooks");
  mkdirSync(process.env.AGENTNET_HOOK_LOGS!, { recursive: true });
  writeFileSync(join(process.env.AGENTNET_HOOK_LOGS!, "triage.jsonl"), JSON.stringify({ ts: "2026-11-02T10:00:00", ms: 5 }) + "\n"); // old line: not replayed
  const got: { script: string; ok: boolean; ms: number | null }[] = [];
  const off = onHookFire((f) => got.push(f));
  await new Promise((r) => setTimeout(r, 100));
  appendFileSync(join(process.env.AGENTNET_HOOK_LOGS!, "triage.jsonl"), JSON.stringify({ ts: "2026-11-02T10:05:00", ms: 120, err: "x" }) + "\n");
  for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
  off();
  expect(got).toEqual([expect.objectContaining({ script: "triage.py", ok: false, ms: 120 })]);
  expect(hookNodes().some((n) => n.script === "triage.py")).toBe(true);
});

test("dry-run lines never fire; skip lines fire as skipped with their reason", async () => {
  const { onHookFire } = await import("./hooks");
  mkdirSync(process.env.AGENTNET_HOOK_LOGS!, { recursive: true });
  const f = join(process.env.AGENTNET_HOOK_LOGS!, "auto-ack.jsonl");
  writeFileSync(f, "");
  const got: { skipped?: boolean; reason?: string; ms: number | null }[] = [];
  const off = onHookFire((x) => got.push(x));
  await new Promise((r) => setTimeout(r, 100));
  appendFileSync(f, JSON.stringify({ ts: "2026-11-02T10:05:00", ack: "x", dry: true }) + "\n" + JSON.stringify({ ts: "2026-11-02T10:06:00", skip: true, reason: "greeting", dry: true }) + "\n"
    + JSON.stringify({ ts: "2026-11-02T10:07:00", skip: true, reason: "greeting", latency_ms: 9 }) + "\n" + JSON.stringify({ ts: "2026-11-02T10:08:00", ack: "Checking", latency_ms: 8 }) + "\n");
  for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  off();
  expect(got.length).toBe(2);
  expect(got[0]).toEqual(expect.objectContaining({ skipped: true, reason: "greeting", ms: 9 }));
  expect(got[1].skipped).toBeUndefined();
});

test("recentFires filters by agent and strips the agentnet/ prefix", async () => {
  const { recentFires } = await import("./hooks");
  mkdirSync(process.env.AGENTNET_HOOK_LOGS!, { recursive: true });
  const L = process.env.AGENTNET_HOOK_LOGS!;
  writeFileSync(join(L, "task-guard.jsonl"), JSON.stringify({ ts: "2026-11-07T10:00:00", agent: "agentnet/backend-1", reason: "empty", ms: 20 }) + "\n");
  writeFileSync(join(L, "triage.jsonl"), [{ ts: "2026-11-07T10:01:00", agent: "web-dev-1", ms: 5 }, { ts: "2026-11-07T10:02:00", ms: 6 }, { ts: "2026-11-07T10:03:00", agent: "backend-1", ms: 7, dry: true }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  expect(recentFires("backend-1").map((f) => f.script)).toEqual(["task-guard.py"]);
  expect(recentFires("backend-1")[0].agent).toBe("backend-1");
  expect(recentFires().map((f) => f.agent)).toEqual([null, "web-dev-1", "backend-1"]);
  expect(recentFires(undefined, 1).length).toBe(1);
});

async function app() {
  const { hooksRoutes } = await import("./hooks");
  const api = new Hono<Env>(); hooksRoutes(api); const a = new Hono<Env>(); a.route("/api/v1", api); return a;
}
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("enable then rollback through the routes: file after rollback equals the file before, backup exists", async () => {
  const a = await app(), file = process.env.CLAUDE_SETTINGS_FILE!;
  const before = readFileSync(file, "utf8");
  const list = await (await a.request("/api/v1/agent-hooks", {}, LOOP)).json() as { hooks: { id: string; name: string }[] };
  const id = list.hooks.find((h) => h.name === "Prompt triage")!.id;
  expect((await a.request(`/api/v1/agent-hooks/${id}/enabled`, post({ enabled: false }), LOOP)).status).toBe(200);
  expect(readFileSync(file, "utf8")).not.toBe(before);
  expect(readdirSync(d).some((n) => n.includes(".bak-agentnet-"))).toBe(true);
  const rb = await a.request("/api/v1/agent-hooks/rollback", post({}), LOOP);
  expect(rb.status).toBe(200);
  expect(readFileSync(file, "utf8")).toBe(before);
});
test("hook writes need root: forwarded or non-loopback callers get 403, loopback gets through", async () => {
  const a = await app(), fwd = { "X-Forwarded-For": "10.0.0.5" };
  expect((await a.request("/api/v1/agent-hooks/rollback", post({}, fwd), LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/rollback", post({}), LAN)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/abc/enabled", post({ enabled: true }, fwd), LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/abc/enabled", post({ enabled: "yes" }), LOOP)).status).toBe(400);
  expect((await a.request("/api/v1/agent-hooks/rollback", post({}), LOOP)).status).toBe(400); // loopback passes the guard; there is no backup yet
  expect((await a.request("/api/v1/agent-hooks/nodes", {}, LAN)).status).toBe(200); // reads stay open
});

test("fires route is root only: forwarded or LAN peers get 403, loopback root gets 200", async () => {
  const a = await app();
  expect((await a.request("/api/v1/agent-hooks/fires", { headers: { "X-Forwarded-For": "10.0.0.5" } }, LOOP)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/fires", {}, LAN)).status).toBe(403);
  expect((await a.request("/api/v1/agent-hooks/fires", {}, LOOP)).status).toBe(200);
});

test("catalogue: missing or broken file gives generic names; bad entries are skipped; the file is re-read when it changes", async () => {
  const { listHooks, catalog } = await import("./hooks");
  const f = process.env.AGENTNET_HOOK_CATALOG!;
  expect(listHooks().map((h) => h.name)).toContain("Prompt triage");
  writeFileSync(f, JSON.stringify([{ match: "(", name: "bad regex", about: "x" }, { name: "no match", about: "x" }, { match: "triage", name: "Triage", about: "ok" }]));
  await new Promise((r) => setTimeout(r, 20)); // mtime must move
  expect(catalog().map((c) => c.name)).toEqual(["Triage"]);
  writeFileSync(f, "{ not json");
  await new Promise((r) => setTimeout(r, 20));
  expect(catalog()).toEqual([]);
  rmSync(f);
  const names = listHooks().map((h) => h.name);
  expect(names).toEqual(["skill-dispatch.js", "triage.py", "agent-pretrust.py"]);
  expect(listHooks().every((h) => h.log === null && h.about.length > 0)).toBe(true);
});

test("fresh install (no catalogue): a shipped template hook still gets its log, stats and fires", async () => {
  process.env.AGENTNET_HOOK_CATALOG = join(d, "none.json"); // missing file = empty catalogue
  const { installHook, listHooks, recentFires, templateList } = await import("./hooks");
  const t = templateList().find((x) => x.id === "agentnet-triage")!;
  installHook({ templateId: t.id });
  mkdirSync(process.env.AGENTNET_HOOK_LOGS!, { recursive: true });
  writeFileSync(join(process.env.AGENTNET_HOOK_LOGS!, "triage.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ms: 120, agent: "root", p: "hi", route: "inline" }) + "\n");
  const h = listHooks().find((x) => x.command === t.command)!;
  expect(h).toMatchObject({ script: "agentnet-triage", log: "triage.jsonl", runs: 1, enabled: true });
  expect(recentFires("root")).toMatchObject([{ script: "agentnet-triage", name: t.name, agent: "root", ok: true }]);
});

test("scriptOf: quoted, spaced and trailing-arg commands", async () => {
  const { scriptOf } = await import("./hooks");
  expect(scriptOf("node '/Users/x/.claude/hooks/native-hook-fast.js'")).toBe("/Users/x/.claude/hooks/native-hook-fast.js");
  expect(scriptOf('bash "$HOME/.claude/hooks/caveman-shrink-guard.sh"')).toBe("$HOME/.claude/hooks/caveman-shrink-guard.sh");
  expect(scriptOf('node "/Users/a b/hooks/x.js"')).toBe("/Users/a b/hooks/x.js");
  expect(scriptOf("node x.js --fast")).toBe("x.js");
  expect(scriptOf("python3 /a/b.py")).toBe("/a/b.py");
  expect(scriptOf("/opt/homebrew/bin/python3 -u /a/b.py arg/1")).toBe("/a/b.py");
});
