// Step 7 §2: the boot sweep kills tmux sessions of retired agents. A fake tmux only: no real tmux server is touched.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "an-sweep-"));
delete process.env.AGENTNET_SWEEP; // CI sets AGENTNET_SWEEP=0 for the whole run; these tests are about the sweep itself
const { Database } = await import("bun:sqlite");
const { db, useDatabase } = await import("../src/core/db");
useDatabase(new Database(":memory:"));
const st = await import("../src/net/store");
const rt = await import("../src/net/routes");
const sw = await import("../src/net/sweep");
const fin = await import("../src/net/finish");
type Tmux = import("../src/net/windows").Tmux;

/** A tmux with fixed sessions; kill-session removes one and is recorded. */
const fakeTmux = (sessions: string[]) => {
  const live = new Set(sessions), kills: string[] = [];
  const t: Tmux = { run: (args) => {
    if (args[0] === "list-sessions") return { code: 0, out: [...live].join("\n") + "\n" };
    if (args[0] === "kill-session") { const s = String(args[2]).replace(/^=/, ""); kills.push(s); return { code: live.delete(s) ? 0 : 1, out: "" }; }
    return { code: 1, out: "" };
  } };
  return { t, kills };
};
const noKill = () => {};
const retire = (name: string, at: number) => rt.retireAgent(rt.byName(name)!, "despawn", at, noKill);

beforeAll(() => { st._reset(); rt.createAgent({ name: "root", job: "t", by: "test", standing: true }); });

test("sweep: boot kills agentnet session of a retired agent, never bot-* or live ones", () => {
  const now = Date.now();
  for (const n of ["old-1", "fresh-1", "live-1", "again-1"]) rt.createAgent({ name: n, boss: "root", job: "t", goal: "g", by: "test" });
  retire("old-1", now - 60_000);
  retire("fresh-1", now - 2_000); // inside the 10 s window: finish.ts's own timer still has it
  retire("again-1", now - 60_000); rt.createAgent({ name: "again-1", boss: "root", job: "t", goal: "g", by: "test" }); // a new live gen owns the name
  const { t, kills } = fakeTmux(["agentnet-old-1", "agentnet-fresh-1", "agentnet-live-1", "agentnet-again-1", "agentnet-root", "agentnet-nobody", "bot-main", "work"]);
  expect(sw.bootSweep(t, now)).toEqual(["agentnet-old-1"]);
  expect(kills).toEqual(["agentnet-old-1"]);
});

test("sweep: pending kill survives a restart", () => {
  const now = Date.now();
  const a = rt.createAgent({ name: "pend-1", boss: "root", job: "t", goal: "g", by: "test" });
  const row = rt.byName("pend-1")!;
  // finish's cleanup writes the pending kill, then the server dies before its in-memory timer fires
  const later: (() => void)[] = [];
  fin.cleanup(row, { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => false, later: (fn) => { later.push(fn); }, killSession: () => {} }, 1);
  const pending = () => (db().query("SELECT pending_kill_at FROM agents WHERE id = ?").get(a.id) as { pending_kill_at: number | null }).pending_kill_at;
  expect(pending()).toBeGreaterThan(0);
  retire("pend-1", now);
  later.length = 0; // the restart drops the timer; the server comes back 30 s later
  const { t, kills } = fakeTmux(["agentnet-pend-1"]);
  expect(sw.bootSweep(t, now + 30_000)).toEqual(["agentnet-pend-1"]);
  expect(kills).toEqual(["agentnet-pend-1"]);
  expect(pending()).toBeNull();
});

test("sweep: the timer path clears the pending kill", () => {
  const a = rt.createAgent({ name: "timer-1", boss: "root", job: "t", goal: "g", by: "test" });
  const killed: string[] = [];
  fin.cleanup(rt.byName("timer-1")!, { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => false, later: (fn) => fn(), killSession: (s) => { killed.push(s); } }, 1);
  expect(killed).toEqual(["agentnet-timer-1"]);
  expect((db().query("SELECT pending_kill_at FROM agents WHERE id = ?").get(a.id) as { pending_kill_at: number | null }).pending_kill_at).toBeNull();
});

test("sweep: restart inside the grace window still kills after the remaining time", () => {
  const now = Date.now();
  const a = rt.createAgent({ name: "quick-1", boss: "root", job: "t", goal: "g", by: "test" });
  fin.cleanup(rt.byName("quick-1")!, { table: () => [], panePids: () => [], portPids: () => [], signal: () => {}, alive: () => false, later: () => {}, killSession: () => {} }, 1);
  retire("quick-1", now - 3_000); // the server restarts 3 s after the retire: finish.ts's timer is gone
  const timers: { fn: () => void; ms: number }[] = [];
  let clock = now;
  const { t, kills } = fakeTmux(["agentnet-quick-1"]);
  expect(sw.bootSweep(t, now, (fn, ms) => { timers.push({ fn, ms }); }, () => clock)).toEqual([]);
  expect(kills).toEqual([]);
  expect(timers.length).toBe(1);
  expect(timers[0]!.ms).toBeGreaterThan(0); expect(timers[0]!.ms).toBeLessThanOrEqual(7_001);
  clock = now + timers[0]!.ms; timers[0]!.fn();
  expect(kills).toEqual(["agentnet-quick-1"]);
  expect((db().query("SELECT pending_kill_at FROM agents WHERE id = ?").get(a.id) as { pending_kill_at: number | null }).pending_kill_at).toBeNull();
});

test("sweep: a timer that fires after a respawn of the name kills nothing", () => {
  const now = Date.now();
  rt.createAgent({ name: "back-1", boss: "root", job: "t", goal: "g", by: "test" });
  retire("back-1", now - 1_000);
  const timers: (() => void)[] = [];
  const { t, kills } = fakeTmux(["agentnet-back-1"]);
  sw.bootSweep(t, now, (fn) => { timers.push(fn); }, () => now + 20_000);
  rt.createAgent({ name: "back-1", boss: "root", job: "t", goal: "g", by: "test" }); // respawned before the timer fires
  timers[0]!();
  expect(kills).toEqual([]);
});
