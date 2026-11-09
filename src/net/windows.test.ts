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
