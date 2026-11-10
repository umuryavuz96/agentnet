import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const st = await import("./store");
const lv = await import("./liveness");
const wn = await import("./windows");

/** A fake tmux: sessions with their attached clients, and a log of every call. */
const fake = (sessions: Record<string, number>) => {
  const calls: string[][] = [];
  const t: import("./windows").Tmux = { run: (a) => { calls.push(a); const s = (x: string) => x.replace(/^=/, "");
    if (a[0] === "has-session") return { code: s(a[2]!) in sessions ? 0 : 1, out: "" };
    if (a[0] === "list-clients") return { code: 0, out: Object.entries(sessions).filter(([, n]) => n > 0).flatMap(([k, n]) => Array(n).fill(k)).join("\n") + "\n" };
    if (a[0] === "list-sessions") return { code: 0, out: Object.keys(sessions).join("\n") + "\n" };
    if (a[0] === "detach-client") { sessions[s(a[2]!)] = 0; return { code: 0, out: "" }; }
    if (a[0] === "kill-session") { delete sessions[s(a[2]!)]; return { code: 0, out: "" }; }
    return { code: 1, out: "" }; } };
  return { t, calls, sessions };
};
beforeEach(() => { useDatabase(new Database(":memory:")); st._reset(); lv._reset(); });

test("session names, exact targets, root maps to the root session", () => {
  expect(wn.sessionOf("web-dev-1")).toBe("agentnet-web-dev-1"); expect(wn.sessionOf("root")).toBe("agentnet-root");
  const f = fake({ "agentnet-a": 0 });
  expect(wn.hasSession("agentnet-a", f.t)).toBe(true); expect(wn.hasSession("agentnet-a-1", f.t)).toBe(false);
  expect(f.calls.every((c) => c[0] !== "has-session" || c[2]!.startsWith("="))).toBe(true);
  expect(wn.commandFile("agentnet-a")).toContain("tmux attach -t '=agentnet-a'"); expect(wn.commandFile("agentnet-a")).toContain("close (first window whose tty");
});
test("open: 404 without a session, one window per agent, raise when attached; close and close-all detach only", () => {
  const f = fake({ "agentnet-a1": 0, "agentnet-b1": 1, "main": 1, "other": 1 }), opened: string[][] = [];
  expect(wn.openWindow("nope", f.t, (a) => opened.push(a))).toMatchObject({ ok: false, status: 404 });
  expect(wn.openWindow("Bad Name", f.t, (a) => opened.push(a))).toMatchObject({ ok: false, status: 422 });
  expect(wn.openWindow("a1", f.t, (a) => opened.push(a))).toEqual({ ok: true, opened: true });
  expect(opened.at(-1)![0]).toBe("-a"); expect(opened.at(-1)![2]).toMatch(/open-a1\.command$/);
  expect(readFileSync(opened.at(-1)![2]!, "utf8")).toContain("'=agentnet-a1'");
  expect(wn.openWindow("b1", f.t, (a) => opened.push(a))).toEqual({ ok: true, opened: false }); // attached already: raise only
  expect(opened.at(-1)).toEqual(["-a", "Terminal"]);
  expect(wn.detach("agentnet-b1", f.t)).toBe(true); expect(f.sessions["agentnet-b1"]).toBe(0);
  expect(wn.agentSessions(f.t)).toEqual(["agentnet-a1", "agentnet-b1"]); // never main or other
});
test("open root without tmux: raise the hosting app, else a clear message", () => {
  const f = fake({}), opened: string[][] = [], o = (a: string[]) => opened.push(a);
  if (process.platform === "darwin") {
    expect(wn.openWindow("root", f.t, o, 42, () => "iTerm", () => true)).toEqual({ ok: true, opened: false, app: "iTerm" });
    expect(opened.at(-1)).toEqual(["-a", "iTerm"]);
  }
  expect(wn.openWindow("root", f.t, o, 42, () => null, () => true)).toEqual({ ok: false, status: 404, detail: wn.NOT_IN_TMUX, code: "NOT_IN_TMUX" }); // alive pid, no terminal app found
  expect(wn.openWindow("a1", f.t, o, 42, () => "iTerm")).toMatchObject({ ok: false, detail: "no tmux session agentnet-a1" }); // only root falls back
});
test("open root with no live director: NOT_RUNNING (no pid, a dead pid), never NOT_IN_TMUX or an app switch", () => {
  const f = fake({}), opened: string[][] = [], o = (a: string[]) => opened.push(a), app = () => "iTerm";
  const none = { ok: false as const, status: 404 as const, detail: wn.NOT_RUNNING, code: "NOT_RUNNING" as const };
  expect(wn.openWindow("root", f.t, o, null, app, () => true)).toEqual(none);
  expect(wn.openWindow("root", f.t, o, 42, app, () => false)).toEqual(none); // pid recorded but dead
  expect(wn.NOT_RUNNING).toBe("The director is not running. Start it with Start director.");
  expect(opened).toEqual([]);
});
test("appChain finds the host of IDE and terminal sessions (Cursor, VS Code, iTerm2, Ghostty, Warp, WezTerm), outer bundle first", () => {
  const chainOf = (rows: [string][]) => (p: number) => (rows[p - 10] ? { ppid: p + 1 === 10 + rows.length ? 1 : p + 1, comm: rows[p - 10]![0] } : null);
  const host = (...comms: string[]) => wn.appChain(10, chainOf(comms.map((c) => [c]))).app;
  expect(host("claude", "-zsh", "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)", "/Applications/Cursor.app/Contents/MacOS/Cursor")).toBe("Cursor");
  expect(host("claude", "/bin/zsh", "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)")).toBe("Visual Studio Code");
  expect(host("claude", "-zsh", "login", "/Applications/iTerm.app/Contents/MacOS/iTerm2")).toBe("iTerm");
  expect(host("claude", "-zsh", "/Applications/Ghostty.app/Contents/MacOS/ghostty")).toBe("Ghostty");
  expect(host("claude", "-zsh", "/Applications/Warp.app/Contents/MacOS/stable")).toBe("Warp");
  expect(host("claude", "-zsh", "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")).toBe("WezTerm");
  expect(host("claude", "-zsh", "wezterm-gui")).toBe("WezTerm"); // name cut short, no .app path
  expect(host("claude", "-zsh", "iTerm2")).toBe("iTerm");
});
test("appChain returns the chain it walked when it finds nothing (a tmux server, a daemon, a vanished parent)", () => {
  const rows: Record<number, { ppid: number; comm: string }> = { 9: { ppid: 8, comm: "claude" }, 8: { ppid: 7, comm: "-zsh" }, 7: { ppid: 1, comm: "tmux: server" } };
  expect(wn.appChain(9, (p) => rows[p] ?? null)).toEqual({ app: null, chain: ["9:claude", "8:-zsh", "7:tmux: server"] });
  expect(wn.appChain(9, (p) => (p === 9 ? rows[9]! : null))).toEqual({ app: null, chain: ["9:claude", "8:?"] });
});
test("appOfPid walks parents to the first .app", () => {
  const rows: Record<number, { ppid: number; comm: string }> = { 9: { ppid: 8, comm: "claude" }, 8: { ppid: 7, comm: "-zsh" }, 7: { ppid: 1, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" } };
  expect(wn.appOfPid(9, (p) => rows[p] ?? null)).toBe("Ghostty");
  expect(wn.appOfPid(8, () => null)).toBe(null);
});
test("the sweep sets window.open from tmux clients; the reaper kills only agentnet sessions of gone agents", async () => {
  for (const n of ["a1", "root"]) { st.emit({ agent: `${n}#1`, type: "AgentSpawned", data: { id: `${n}#1`, name: n }, source: "spawn" }); st.emit({ agent: `${n}#1`, type: "AgentConnected", data: { session: "s", pid: process.pid }, source: "mod" }); }
  st.flush();
  const f = fake({ "agentnet-a1": 1, "main": 0 });
  lv.sweep(Date.now(), () => true, f.t);
  expect(st.get("a1#1")?.window).toEqual({ open: true }); expect(st.get("root#1")?.window).toEqual({ open: false });
  f.sessions["agentnet-a1"] = 0; lv.sweep(Date.now(), () => true, f.t);
  expect(st.get("a1#1")?.window).toEqual({ open: false });
  expect(lv.sweep(Date.now(), () => true, f.t)).toBe(0); // no change, no event
  const off = wn.startSessionReaper(f.t, 0);
  st.emit({ agent: "a1#1", type: "AgentGone", data: { reason: "exit" }, source: "mod" }); st.emit({ agent: "root#1", type: "AgentGone", data: { reason: "exit" }, source: "mod" }); st.flush();
  await Bun.sleep(20); off?.();
  expect(Object.keys(f.sessions)).toEqual(["main"]);
});

// ---- Open window on root must always work (#1264/#1265): a real tmux on a scratch socket, never the live sessions ----
const scratch = (sock: string): import("./windows").Tmux => ({ run: (a) => { const p = Bun.spawnSync(["tmux", "-L", sock, ...a]); return { code: p.exitCode, out: new TextDecoder().decode(p.stdout) }; } });
const hasTmux = !!Bun.which("tmux");
(hasTmux ? describe : describe.skip)("root session on a scratch tmux", () => {
  const sock = `agentnet-test-${process.pid}`, t = scratch(sock), opened: string[][] = [];
  const o = (a: string[]) => opened.push(a);
  const mk = (name: string) => t.run(["new-session", "-d", "-s", name, "sleep", "300"]);
  const panePid = (name: string) => Number(t.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]).out.trim());
  beforeEach(() => { t.run(["kill-server"]); opened.length = 0; });
  test("the root session is found by its normal name", () => {
    mk("agentnet-root"); expect(wn.findRootSession(t, null)).toBe("agentnet-root");
    expect(wn.openWindow("root", t, o, null)).toEqual({ ok: true, opened: true });
    expect(readFileSync(opened.at(-1)![2]!, "utf8")).toContain("'=agentnet-root'");
    t.run(["kill-server"]);
  });
  test("a legacy agentnet-director session is renamed to agentnet-root (self-heal) and opened", () => {
    mk("agentnet-director");
    expect(wn.healRootSession(t)).toBe(true);
    expect(wn.hasSession("agentnet-root", t)).toBe(true); expect(wn.hasSession("agentnet-director", t)).toBe(false);
    t.run(["kill-server"]); mk("agentnet-director");
    expect(wn.openWindow("root", t, o, null)).toEqual({ ok: true, opened: true }); // heal happens before Open
    expect(wn.hasSession("agentnet-root", t)).toBe(true);
    t.run(["kill-server"]);
  });
  test("both sessions exist: nothing is renamed, the root one wins", () => {
    mk("agentnet-root"); mk("agentnet-director");
    expect(wn.healRootSession(t)).toBe(false); expect(wn.findRootSession(t, null)).toBe("agentnet-root"); t.run(["kill-server"]);
  });
  test("neither session: the pane whose process tree holds the director's pid is opened", () => {
    mk("mine"); mk("other");
    const pid = panePid("mine");
    expect(wn.findRootSession(t, pid)).toBe("mine");
    expect(wn.findRootSession(t, pid + 100000)).toBeNull();
    expect(wn.openWindow("root", t, o, pid, () => null, () => true)).toEqual({ ok: true, opened: true });
    expect(readFileSync(opened.at(-1)![2]!, "utf8")).toContain("'=mine'");
    expect(wn.openWindow("root", t, o, null)).toMatchObject({ ok: false, code: "NOT_RUNNING" });
    t.run(["kill-server"]);
  });
  test("a session name with a space is still matched", () => {
    t.run(["new-session", "-d", "-s", "my term", "sleep", "300"]);
    expect(wn.findRootSession(t, panePid("my term"))).toBe("my term"); t.run(["kill-server"]);
  });
});
