import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
await import("./director"); // load order: director first (windows <-> routes <-> director import cycle)
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const st = await import("./store");
const lv = await import("./liveness");

const T0 = 1_700_000_000_000;
const snap = (over: Partial<import("./store").Snapshot>) => ({ ...st.reduce(null, { type: "AgentSpawned", ts: T0, data: { id: "a#1", name: "a" }, source: "spawn" })!, ...over });
beforeEach(() => { useDatabase(new Database(":memory:")); st._reset(); lv._reset(); });

describe("decide", () => {
  test("starting: failed only after 30 s without hello", () => {
    expect(lv.decide(snap({}), { polling: false, lastPoll: null, pidAlive: null, recovering: false }, T0 + 29_000)).toBeNull();
    expect(lv.decide(snap({}), { polling: false, lastPoll: null, pidAlive: null, recovering: false }, T0 + 31_000)).toEqual({ type: "AgentFailed", reason: "no hello within 30 s" });
    expect(lv.decide(snap({}), { polling: false, lastPoll: null, pidAlive: null, recovering: true }, T0 + 31_000)).toBeNull(); // C: the restart grace comes first
  });
  test("live: an open poll or a live pid keeps it; a dead pid after 1 s of silence is gone", () => {
    const s = snap({ life: "live", connectedAt: T0, pid: 5 });
    expect(lv.decide(s, { polling: true, lastPoll: null, pidAlive: false, recovering: false }, T0 + 60_000)).toBeNull();
    expect(lv.decide(s, { polling: false, lastPoll: T0 + 59_500, pidAlive: false, recovering: false }, T0 + 60_000)).toBeNull(); // silent 0.5 s only
    expect(lv.decide(s, { polling: false, lastPoll: T0 + 50_000, pidAlive: true, recovering: false }, T0 + 60_000)).toBeNull(); // pid alive: still live, never unreachable
    expect(lv.decide(s, { polling: false, lastPoll: T0 + 50_000, pidAlive: false, recovering: false }, T0 + 60_000)).toEqual({ type: "AgentGone", reason: "killed" });
    expect(lv.decide(s, { polling: false, lastPoll: T0 + 50_000, pidAlive: false, recovering: true }, T0 + 60_000)).toBeNull(); // grace
  });
  test("root with no pid on record: gone after 90 s without a poll (not Idle for hours); a normal agent is not", () => {
    const o = { polling: false, lastPoll: T0, pidAlive: null, recovering: false };
    const root = snap({ id: "root", name: "root", life: "live", connectedAt: T0 });
    expect(lv.decide(root, o, T0 + 60_000)).toBeNull();
    expect(lv.decide(root, o, T0 + 100_000)).toEqual({ type: "AgentGone", reason: "no_poll" });
    expect(lv.decide(root, { ...o, polling: true }, T0 + 100_000)).toBeNull();
    expect(lv.decide(snap({ life: "live", connectedAt: T0 }), o, T0 + 100_000)).toBeNull();
  });
});
describe("root pid", () => {
  test("a hand-started director's hello records its pid, so rootPid() (what Open window uses) is not null", async () => {
    const { rootPid } = await import("./windows");
    st.emit({ agent: "root", type: "AgentSpawned", data: { id: "root", name: "root" }, source: "spawn", ts: T0 }); st.flush();
    expect(rootPid()).toBeNull();
    st.emit({ agent: "root", type: "AgentConnected", data: { session: "s1", pid: 4242 }, source: "mod", ts: T0 + 1 }); st.flush();
    expect(rootPid()).toBe(4242);
  });
});
describe("sweep", () => {
  test("kill: gone within one sweep; restart grace: nothing for 10 s, then during_restart for a dead pid", () => {
    st.emit({ agent: "a#1", type: "AgentSpawned", data: { id: "a#1", name: "a" }, source: "spawn", ts: T0 });
    st.emit({ agent: "a#1", type: "AgentConnected", data: { session: "s", pid: 5 }, source: "mod", ts: T0 });
    st.emit({ agent: "b#1", type: "AgentSpawned", data: { id: "b#1", name: "b" }, source: "spawn", ts: T0 });
    st.emit({ agent: "b#1", type: "AgentConnected", data: { session: "s2", pid: 6 }, source: "mod", ts: T0 });
    st.flush();
    lv.pollOpened("a#1"); lv.pollClosed("a#1", T0 + 1000); lv.pollOpened("b#1");
    expect(lv.sweep(T0 + 10_000, (pid) => pid !== 5, null)).toBe(1); // null: no tmux window check in this test
    expect(st.get("a#1")?.life).toBe("gone"); expect(st.get("a#1")?.goneReason).toBe("killed"); expect(st.get("b#1")?.life).toBe("live");
    // service restart: b's poll is gone, nothing for 10 s
    lv._reset(); lv.startLiveness(T0 + 20_000); lv._reset; // startLiveness sets listenedAt (and a timer the reset below clears)
    expect(lv.sweep(T0 + 25_000, () => false, null)).toBe(0);
    expect(lv.sweep(T0 + 31_000, () => false, null)).toBe(1);
    expect(st.get("b#1")?.goneReason).toBe("during_restart");
    lv._reset();
  });
});

describe("lost: tmux session gone", () => {
  const tmuxWith = (sessions: () => string[]) => ({ run: (a: string[]) => (a[0] === "list-sessions" ? { code: 0, out: sessions().join("\n") } : { code: 0, out: "" }) });
  const mk = (pid = 5) => {
    st.emit({ agent: "a#1", type: "AgentSpawned", data: { id: "a#1", name: "a" }, source: "spawn", ts: T0 });
    st.emit({ agent: "a#1", type: "AgentConnected", data: { session: "s", pid }, source: "mod", ts: T0 });
    st.flush();
  };
  test("seen in tmux, session vanishes, pid dead: lost after 3 sweeps; a live open poll or the same live pid keeps it", () => {
    mk(); let ss = ["agentnet-a"]; const t = tmuxWith(() => ss);
    lv.pollOpened("a#1"); lv.pollClosed("a#1", T0);
    expect(lv.sweep(T0 + 5000, () => true, t, () => T0 - 1000)).toBe(1); // first sweep only emits WindowChanged
    ss = [];
    lv.sweep(T0 + 6000, () => true, t, () => T0 - 1000); lv.sweep(T0 + 7000, () => true, t, () => T0 - 1000); lv.sweep(T0 + 8000, () => true, t, () => T0 - 1000);
    expect(st.get("a#1")?.life).toBe("live"); // same live process (started before hello): not lost
    lv.pollOpened("a#1");
    lv.sweep(T0 + 9000, () => false, t, () => null); lv.sweep(T0 + 10_000, () => false, t, () => null);
    expect(st.get("a#1")?.life).toBe("live"); // an open poll: it still talks to us
    lv.pollClosed("a#1", T0 + 10_500);
    lv.sweep(T0 + 11_000, () => false, t, () => null);
    expect(st.get("a#1")?.life).toBe("gone"); expect(st.get("a#1")?.goneReason).toBe("lost");
  });
  test("a reused pid (process started after the hello) does not keep a dead agent alive", () => {
    mk(); let ss = ["agentnet-a"]; const t = tmuxWith(() => ss);
    lv.pollOpened("a#1"); lv.pollClosed("a#1", T0);
    lv.sweep(T0 + 5000, () => true, t, () => T0 - 1000); ss = [];
    for (let i = 1; i <= 3; i++) lv.sweep(T0 + 5000 + i * 1000, () => true, t, () => T0 + 600_000);
    expect(st.get("a#1")?.goneReason).toBe("lost");
  });
  test("pid died and the session is gone too: reason lost (not killed); one that never ran in tmux stays killed", () => {
    mk(); let ss = ["agentnet-a"]; const t = tmuxWith(() => ss);
    lv.pollOpened("a#1"); lv.pollClosed("a#1", T0);
    lv.sweep(T0 + 5000, () => true, t, () => T0 - 1000); ss = [];
    lv.sweep(T0 + 7000, () => false, t, () => null);
    expect(st.get("a#1")?.goneReason).toBe("lost");
  });
  test("never seen in tmux (runs elsewhere): never lost; no tmux server answer is not a verdict", () => {
    mk(); const t = tmuxWith(() => []);
    for (let i = 1; i <= 5; i++) lv.sweep(T0 + 5000 + i * 1000, () => true, t, () => T0 + 600_000);
    expect(st.get("a#1")?.life).toBe("live");
  });
  test("unread messages of a lost agent are held for the respawn", () => {
    st.ensureSchema?.();
    db_insert();
    function db_insert() { const { db } = require("../core/db") as typeof import("../core/db"); db().run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT, body TEXT, kind TEXT, subject TEXT, reply_to INTEGER, created_at INTEGER, held_until INTEGER, state TEXT)"); db().run("INSERT INTO messages (from_agent,to_agent,body,kind,created_at,state) VALUES ('r','a#1','x','info',1,'queued'),('r','a#1','y','info',1,'read')"); }
    expect(lv.holdUnread("a#1", T0)).toBe(1);
    const { db } = require("../core/db") as typeof import("../core/db");
    expect((db().query("SELECT state, held_until FROM messages WHERE body='x'").get() as { state: string; held_until: number })).toEqual({ state: "held", held_until: T0 + 24 * 3600_000 });
    expect((db().query("SELECT state FROM messages WHERE body='y'").get() as { state: string }).state).toBe("read");
  });
});
