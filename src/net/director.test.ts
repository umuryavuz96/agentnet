import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { pickFolder, triageState, directorCommand, checkDir, startDirector, sq, SESSION } = await import("./director");
const { directorRoutes } = await import("./director");
const { Hono } = await import("hono");
const { isPanelWrite, toLegacy } = await import("./mount");

const all = { bun: true, claude: true, tmux: true, python3: true };
describe("director setup", () => {
  test("sq quotes a quote", () => expect(sq("a'b")).toBe(`'a'\\''b'`));
  test("command joins as root and starts claude with the plugin", () => {
    const c = directorCommand("/tmp/my proj", "/r", 3096, "127.0.0.1");
    expect(c).toBe(`cd '/tmp/my proj' && eval "$('/r/scripts/agentnet-join.sh' root Director '/tmp/my proj')" && claude --plugin-dir "$AGENTNET_MOD"`);
  });
  test("a non-default port is carried in AGENTNET_URL", () => {
    expect(directorCommand("/x", "/r", 4321, "127.0.0.1")).toContain(`eval "$(AGENTNET_URL='http://127.0.0.1:4321/api/v1/agentnet' '/r/scripts/agentnet-join.sh' root`);
  });
  test("checkDir: relative, missing, file, ok", () => {
    const d = mkdtempSync(join(tmpdir(), "dir-"));
    expect(checkDir("rel/path")).toEqual({ error: "Use a full path, like /Users/you/project." });
    expect("error" in checkDir(join(d, "nope"))).toBe(true);
    expect("error" in checkDir(import.meta.path)).toBe(true);
    expect(checkDir(d)).toEqual({ dir: d });
    expect("error" in checkDir("  ")).toBe(true);
  });
  test("start: missing tmux or claude explains; running session is refused; ok runs tmux once", () => {
    const d = mkdtempSync(join(tmpdir(), "dir-"));
    const calls: string[][] = [];
    const run = (c: string, a: string[]) => { calls.push([c, ...a]); return { status: 0 }; };
    expect(startDirector(d, run, { ...all, tmux: false }, () => false).code).toBe("no-tmux");
    expect(startDirector(d, run, { ...all, claude: false }, () => false).code).toBe("no-claude");
    expect(startDirector("nope", run, all, () => false).code).toBe("bad-dir");
    expect(startDirector(d, run, all, () => true).code).toBe("running");
    expect(calls.length).toBe(0);
    const r = startDirector(d, run, all, () => false);
    expect(r).toMatchObject({ ok: true, session: SESSION });
    expect(calls[0].slice(0, 6)).toEqual(["tmux", "new-session", "-d", "-s", SESSION, "-c"]);
    expect(startDirector(d, () => ({ status: 1, stderr: "boom" }), all, () => false)).toMatchObject({ code: "failed", detail: "boom" });
  });
  test("route mapping and panel-write gate", () => {
    expect(toLegacy("/v1/panel/director")).toBe("/api/v1/agent-director");
    expect(toLegacy("/v1/panel/director/start")).toBe("/api/v1/agent-director/start");
    expect(isPanelWrite("POST", "/api/v1/agent-director/start")).toBe(true);
    expect(isPanelWrite("GET", "/api/v1/agent-director")).toBe(false);
  });
  test("triageState: template, house hook, switched off, no hook", () => {
    const now = Date.parse("2026-11-09T12:00:00");
    const tpl = 'python3 "/x/hooks/triage.py"';
    const H = (command: string, enabled = true, event = "UserPromptSubmit") => ({ event, command, enabled });
    expect(triageState([], tpl, [], now)).toBe("off");
    expect(triageState([H("python3 /a/other.py")], tpl, [], now)).toBe("off");
    expect(triageState([H(tpl)], tpl, [], now)).toBe("ok");
    expect(triageState([H("python3 /Users/me/.claude/hooks/triage.py")], tpl, [], now)).toBe("ok"); // house hook
    expect(triageState([H("python3 /Users/me/.claude/hooks/triaged.py")], tpl, [], now)).toBe("off"); // not a word match
    expect(triageState([H("python3 /h/triage.py", true, "PreToolUse")], tpl, [], now)).toBe("off"); // wrong event
    expect(triageState([H(tpl, false)], tpl, [], now)).toBe("switched-off");
  });
  test("triageState: nologin only when the last 5 records of 24 h are all not_logged_in/no_claude skips", () => {
    const now = Date.parse("2026-11-09T12:00:00");
    const hooks = [{ event: "UserPromptSubmit", command: "python3 /h/triage.py", enabled: true }];
    const nk = (ts: string) => ({ ts, skip: true, reason: "not_logged_in" });
    const ok = (ts: string) => ({ ts, kind: "chat" });
    expect(triageState(hooks, null, [], now)).toBe("ok"); // no records, no tip
    expect(triageState(hooks, null, [nk("2026-11-09T11:00:00"), nk("2026-11-09T11:01:00")], now)).toBe("nologin");
    expect(triageState(hooks, null, [ok("2026-11-09T10:00:00"), nk("2026-11-09T11:00:00")], now)).toBe("ok"); // a real run in the last 5
    const six = [ok("2026-11-09T09:00:00"), ...[1, 2, 3, 4, 5].map((i) => nk(`2026-11-09T11:0${i}:00`))];
    expect(triageState(hooks, null, six, now)).toBe("nologin"); // only the last 5 count
    expect(triageState(hooks, null, [nk("2026-11-07T11:00:00")], now)).toBe("ok"); // older than 24 h
  });
  test("GET carries the triage state and no key flag", async () => {
    const app = new Hono(); directorRoutes(app as never);
    const j = await (await app.request("/agent-director")).json() as Record<string, unknown>;
    expect(typeof j.triage).toBe("string");
    expect("apiKey" in j).toBe(false);
  });
});

test("pickFolder: path, cancel, no dialog, failure", async () => {
  const mk = (status: number | null, out = "", err = "") => async () => ({ status, out, err });
  expect(await pickFolder(mk(0, "/Users/x/proj/\n"), "darwin")).toEqual({ ok: true, dir: "/Users/x/proj" });
  expect(await pickFolder(mk(0, "/\n"), "darwin")).toEqual({ ok: true, dir: "/" });
  expect(await pickFolder(mk(1, "", "execution error: User canceled. (-128)"), "darwin")).toMatchObject({ ok: false, code: "cancelled" });
  expect(await pickFolder(mk(1, "", "not allowed to send keystrokes (-1743)"), "darwin")).toMatchObject({ code: "unsupported" });
  expect(await pickFolder(mk(1, "", "boom"), "darwin")).toMatchObject({ code: "failed" });
  expect(await pickFolder(mk(0), "linux", () => false)).toMatchObject({ code: "unsupported" });
  let used: string[] = []; await pickFolder(async (c) => { used = c; return { status: 1, out: "", err: "" }; }, "linux", () => true);
  expect(used).toEqual(["zenity", "--file-selection", "--directory"]);
  expect(await pickFolder(mk(1), "linux", () => true)).toMatchObject({ code: "cancelled" });
  expect(await pickFolder(async () => { throw new Error("x"); }, "darwin")).toMatchObject({ code: "unsupported" });
});
test("pick-folder is a loopback-root panel write and rewritten", () => {
  expect(toLegacy("/v1/panel/director/pick-folder")).toBe("/api/v1/agent-director/pick-folder");
  expect(isPanelWrite("POST", "/api/v1/agent-director/pick-folder")).toBe(true);
});
