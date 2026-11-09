import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENTNET_HOME ??= mkdtempSync(join(tmpdir(), "sd-agentnet-"));
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
