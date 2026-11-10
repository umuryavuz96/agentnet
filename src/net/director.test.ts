import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { pickFolder, triageState, directorCommand, checkDir, startDirector, sq, SESSION, composeDirectorPrompt, writeDirectorPrompt, ensureDirectorHome, writeScanMarker, killScanSession, scanMarkerPath } = await import("./director");
const { directorRoutes } = await import("./director");
const { Hono } = await import("hono");
const { isPanelWrite, toLegacy } = await import("./mount");

const all = { bun: true, claude: true, tmux: true, python3: true };
describe("director setup", () => {
  test("sq quotes a quote", () => expect(sq("a'b")).toBe(`'a'\\''b'`));
  test("command joins as root and starts claude with the plugin", () => {
    const c = directorCommand("/tmp/my proj", { repo: "/r", port: 3096, host: "127.0.0.1" });
    expect(c).toBe(`cd '/tmp/my proj' && eval "$('/r/scripts/agentnet-join.sh' root Director '/tmp/my proj')" && claude --plugin-dir "$AGENTNET_MOD"`);
  });
  test("a non-default port is carried in AGENTNET_URL", () => {
    expect(directorCommand("/x", { repo: "/r", port: 4321, host: "127.0.0.1" })).toContain(`eval "$(AGENTNET_URL='http://127.0.0.1:4321/api/v1/agentnet' '/r/scripts/agentnet-join.sh' root`);
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
  test("AGENTNET_NO_DIRECTOR_START validates but never runs tmux", () => {
    const d = mkdtempSync(join(tmpdir(), "dir-")), calls: string[][] = [];
    process.env.AGENTNET_NO_DIRECTOR_START = "1";
    try {
      expect(startDirector(d, (c, a) => { calls.push([c, ...a]); return { status: 0 }; }, all, () => false)).toMatchObject({ ok: true, session: SESSION });
      expect(startDirector("nope", () => ({ status: 0 }), all, () => false).code).toBe("bad-dir");
    } finally { delete process.env.AGENTNET_NO_DIRECTOR_START; }
    expect(calls.length).toBe(0);
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

describe("moveDirector (a hand-started director goes into agentnet-root)", () => {
  const { moveDirector } = require("./director") as typeof import("./director");
  const ok = { ok: true } as import("./director").StartResult;
  test("stops the pid, waits, starts again in the folder it ran in", async () => {
    const calls: string[] = [];
    const r = await moveDirector({ pid: () => process.pid, cwd: () => "/work/x", stop: () => calls.push("stop"), gone: async () => true, start: (d) => (calls.push("start " + d), ok) });
    expect(r).toBe(ok); expect(calls).toEqual(["stop", "start /work/x"]);
  });
  test("not running: nothing is stopped or started", async () => {
    const calls: string[] = [];
    const r = await moveDirector({ pid: () => null, cwd: () => null, stop: () => calls.push("stop"), gone: async () => true, start: () => (calls.push("start"), ok) });
    expect(r.ok).toBe(false); expect(calls).toEqual([]);
  });
  test("it does not stop in time: no start", async () => {
    const calls: string[] = [];
    const r = await moveDirector({ pid: () => process.pid, cwd: () => "/w", stop: () => calls.push("stop"), gone: async () => false, start: () => (calls.push("start"), ok) });
    expect(r.ok).toBe(false); expect(calls).toEqual(["stop"]);
  });
});

describe("director modes", () => {
  const o = { repo: "/r", port: 3096, host: "127.0.0.1", promptFile: "/p/d.md" };
  test("adopt: workspace cwd, prompt file, no --add-dir", () => {
    const c = directorCommand("/w", { ...o, mode: "adopt" });
    expect(c).toBe(`cd '/w' && eval "$('/r/scripts/agentnet-join.sh' root Director '/w')" && claude --plugin-dir "$AGENTNET_MOD" --append-system-prompt-file '/p/d.md'`);
    expect(c).not.toContain("--add-dir");
  });
  test("clean: own home as cwd, workspace via --add-dir", () => {
    const c = directorCommand("/w", { ...o, mode: "clean", home: "/h/director" });
    expect(c.startsWith("cd '/h/director' && ")).toBe(true);
    expect(c).toContain("--append-system-prompt-file '/p/d.md'");
    expect(c.endsWith("--add-dir '/w'")).toBe(true);
  });
  test("scan: carries phase and roots env, named scan", () => {
    const c = directorCommand("/w", { ...o, mode: "scan", roots: ["/w", "/w/ios"] });
    expect(c).toContain("export AGENTNET_ADOPT_PHASE=scan AGENTNET_ADOPT_ROOTS='/w:/w/ios' && eval");
    expect(c.endsWith(" -n scan 'Begin the scan.'")).toBe(true);
    expect(c).toContain("--setting-sources user --strict-mcp-config"); // D6/D9: no project settings, hooks or MCP approval
    expect(c.indexOf("--setting-sources")).toBeLessThan(c.indexOf("'Begin the scan.'")); // D8: the prompt is the last argument
  });
  test("precedence block only in adopt, placeholders filled", () => {
    const a = composeDirectorPrompt({ mode: "adopt", workspace: "/w", repos: ["/w/ios"], souls: ["ios"] });
    expect(a).toContain("Workspace precedence");
    expect(a).toContain("Workspace: /w. Repos: /w/ios. Workspace souls you can spawn by role: ios.");
    expect(a).not.toContain("{{");
    expect(composeDirectorPrompt({ mode: "clean" })).not.toContain("Workspace precedence");
    const s = composeDirectorPrompt({ mode: "scan" });
    expect(s).toContain("adopt_report");
    expect(s).not.toContain("House rules");
  });
  test("prompt written 0600 under run/souls; scan has its own file; home keeps an edited CLAUDE.md", () => {
    const root = mkdtempSync(join(tmpdir(), "dirhome-"));
    const p = writeDirectorPrompt({ mode: "adopt", workspace: "/w" }, root);
    expect(p).toBe(join(root, "run", "souls", "agentnet-director.md"));
    expect(writeDirectorPrompt({ mode: "scan" }, root)).toContain("agentnet-director-scan.md");
    const h = ensureDirectorHome(root);
    writeFileSync(join(h, "CLAUDE.md"), "mine");
    ensureDirectorHome(root);
    expect(readFileSync(join(h, "CLAUDE.md"), "utf8")).toBe("mine");
  });
  test("startDirector with a mode writes the prompt and runs in the right cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "dirstart-")), w = mkdtempSync(join(tmpdir(), "ws-"));
    const calls: string[][] = [];
    const run = (_c: string, a: string[]) => { calls.push(a); return { status: 0 }; };
    expect(startDirector(w, run, all, () => false, { mode: "clean", root }).ok).toBe(true);
    expect(calls[0]![5]).toBe(join(root, "director"));
    expect(calls[0]![8]).toContain(`--add-dir '${w}'`);
    expect(existsSync(join(root, "run", "souls", "agentnet-director.md"))).toBe(true);
    calls.length = 0;
    startDirector(w, run, all, () => false, { mode: "adopt", root });
    expect(calls[0]![5]).toBe(w);
  });
  test("killScanSession kills only when the marker matches tmux session_created", () => {
    const root = mkdtempSync(join(tmpdir(), "scanm-"));
    const mk = (created: string, log: string[]) => ({ run: (a: string[]) => { log.push(a[0]!); return { code: 0, out: a[0] === "display-message" ? created : "" }; } });
    writeScanMarker("111", root);
    const l1: string[] = [];
    expect(killScanSession("s", mk("222", l1), root)).toBe(false);
    expect(l1).not.toContain("kill-session");
    expect(existsSync(scanMarkerPath(root))).toBe(false);
    writeScanMarker("111", root);
    const l2: string[] = [];
    expect(killScanSession("s", mk("111", l2), root)).toBe(true);
    expect(l2).toContain("kill-session");
    expect(killScanSession("s", mk("111", []), root)).toBe(false);
  });
});
