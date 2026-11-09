import { describe, expect, test } from "bun:test";
import { initial, inline, LOST_MS, notes, PILL_KEEP_MS, pill, reduce, type Action, type JobResult, type Model, type Status, type Step, type UpdateEvent } from "./update";

const NOW = 1_800_000_000_000;
const status = (o: Partial<Status> = {}): Status => ({
  current: "0.3.0", latest: "0.4.0", available: true, checkedAt: NOW / 1000, published: "2026-11-09T00:00:00Z", notes: "## 0.4.0\n- x", releaseUrl: "https://github.com/o/r/releases/tag/v0.4.0",
  checkEnabled: true, web: { enabled: true, blocked: null }, mode: "launchd", auto: { enabled: false, hour: 4 }, job: null, ...o,
});
const run = (m: Model, ...as: Action[]) => as.reduce(reduce, m);
const ok = (id: Step["id"]): Step => ({ id, state: "ok", ms: 10 });
const running = (id: Step["id"]): Step => ({ id, state: "running" });
const ev = (e: Omit<UpdateEvent, "t"> & Record<string, unknown>): UpdateEvent => ({ t: NOW, ...e }) as UpdateEvent;
const ALL: Step["id"][] = ["preflight", "checkout", "install", "build", "swap", "restart", "health", "doctor"];
const result = (outcome: JobResult["outcome"], o: Partial<JobResult> = {}): JobResult => ({ id: "upd-1", from: "v0.3.0", to: "v0.4.0", outcome, steps: ALL.map(ok), ...o });
const started = () => run(initial(), { type: "status", status: status(), now: NOW }, { type: "ask" }, { type: "started", id: "upd-1" });
const restarting = () => run(started(),
  { type: "events", now: NOW, events: [ev({ type: "start", id: "upd-1", from: "v0.3.0", to: "v0.4.0", source: "web" }), ...(["preflight", "checkout", "install", "build", "swap"] as const).map((i) => ev({ type: "step", step: ok(i) })), ev({ type: "step", step: running("restart") })] },
  { type: "streamClosed", now: NOW });

describe("update state machine (T20)", () => {
  test("none: nothing newer", () => {
    const m = run(initial(), { type: "status", status: status({ available: false, latest: "0.3.0" }), now: NOW });
    expect(m.phase).toBe("none"); expect(pill(m, NOW)).toBeNull();
  });
  test("available, with the accent pill", () => {
    const m = run(initial(), { type: "status", status: status(), now: NOW });
    expect(m.phase).toBe("available"); expect(pill(m, NOW)).toEqual({ text: "Update v0.4.0", kind: "update" });
  });
  test("blocked: web update off, or a preflight refusal, still shows the release", () => {
    expect(run(initial(), { type: "status", status: status({ web: { enabled: true, blocked: { code: "dirty", hint: "Commit first" } } }), now: NOW }).phase).toBe("blocked");
    expect(run(initial(), { type: "status", status: status({ web: { enabled: false, blocked: { code: "web-disabled", hint: "off" } } }), now: NOW }).phase).toBe("blocked");
    expect(pill(run(initial(), { type: "status", status: status({ web: { enabled: true, blocked: { code: "dirty", hint: "x" } } }), now: NOW }), NOW)?.kind).toBe("update");
  });
  test("confirm: only from available; cancel goes back", () => {
    const a = run(initial(), { type: "status", status: status(), now: NOW });
    expect(reduce(a, { type: "ask" }).phase).toBe("confirm");
    expect(run(a, { type: "ask" }, { type: "cancel" }).phase).toBe("available");
    const b = run(initial(), { type: "status", status: status({ web: { enabled: true, blocked: { code: "dirty", hint: "x" } } }), now: NOW });
    expect(reduce(b, { type: "ask" }).phase).toBe("blocked");
    expect(reduce(initial(), { type: "cancel" }).phase).toBe("none");
  });
  test("a failed POST (409) returns to available with the message", () => {
    const m = run(initial(), { type: "status", status: status(), now: NOW }, { type: "ask" }, { type: "failed", message: "An update is already running." });
    expect(m.phase).toBe("available"); expect(m.error).toBe("An update is already running.");
  });
  test("running: 8 step rows, last log line, step times", () => {
    const m = run(started(), { type: "events", now: NOW, events: [ev({ type: "start", id: "upd-1", from: "v0.3.0", to: "v0.4.0", source: "web" }), ev({ type: "step", step: ok("preflight") }), ev({ type: "step", step: running("install") }), ev({ type: "log", line: "bun install" })] });
    expect(m.phase).toBe("running"); expect(m.steps).toHaveLength(8);
    expect(m.steps.map((s) => s.state)).toEqual(["ok", "pending", "running", "pending", "pending", "pending", "pending", "pending"]);
    expect(m.steps[0]!.ms).toBe(10); expect(m.log).toBe("bun install");
    expect(pill(m, NOW)).toEqual({ text: "Updating…", kind: "busy" });
  });
  test("the stream hello replays the whole log and a reload lands in running", () => {
    const m = run(initial(), { type: "status", now: NOW, status: status({ job: { id: "upd-1", running: true, from: "v0.3.0", to: "v0.4.0", startedAt: NOW } }) });
    expect(m.phase).toBe("running"); expect(m.reconnect).toBe(true);
  });
  test("a drop before the restart reconnects at once and stays running", () => {
    const m = run(started(), { type: "events", now: NOW, events: [ev({ type: "step", step: running("build") })] }, { type: "streamClosed", now: NOW });
    expect(m.phase).toBe("running"); expect(m.reconnect).toBe(true);
  });
  test("restarting: stream closed while restart ran", () => {
    const m = restarting();
    expect(m.phase).toBe("restarting"); expect(m.waitSince).toBe(NOW); expect(m.reconnect).toBe(false);
  });
  test("stream dropped right after swap=ok (restart event never arrived) still enters restarting", () => {
    const m = run(started(), { type: "events", now: NOW, events: [ev({ type: "step", step: ok("build") }), ev({ type: "step", step: ok("swap") })] }, { type: "streamClosed", now: NOW });
    expect(m.phase).toBe("restarting"); expect(m.waitSince).toBe(NOW); expect(m.reconnect).toBe(false);
    const before = run(started(), { type: "events", now: NOW, events: [ev({ type: "step", step: running("swap") })] }, { type: "streamClosed", now: NOW });
    expect(before.phase).toBe("running"); expect(before.reconnect).toBe(true);
  });
  test("restarting to done after health answers and the stream reconnects", () => {
    let m = run(restarting(), { type: "health", ok: false, now: NOW + 2000 });
    expect(m.phase).toBe("restarting"); expect(m.reconnect).toBe(false);
    m = reduce(m, { type: "health", ok: true, version: "0.4.0", now: NOW + 8000 });
    expect(m.phase).toBe("restarting"); expect(m.reconnect).toBe(true); expect(m.healthAt).toBe(NOW + 8000);
    m = reduce(m, { type: "events", now: NOW + 9000, events: [ev({ type: "start", id: "upd-1", from: "v0.3.0", to: "v0.4.0", source: "web" }), ev({ type: "done", result: result("updated", { changelog: "## 0.4.0\n- x" }) })] });
    expect(m.phase).toBe("done"); expect(m.result?.changelog).toContain("0.4.0"); expect(m.reconnect).toBe(false);
    expect(m.steps.every((s) => s.state === "ok")).toBe(true);
    expect(pill(m, NOW)).toEqual({ text: "Updated to v0.4.0", kind: "ok" });
  });
  test("lost after 90 s without health (fake clock), and it recovers if agentnet answers later", () => {
    const m = restarting();
    expect(reduce(m, { type: "tick", now: NOW + LOST_MS - 1 }).phase).toBe("restarting");
    const lost = reduce(m, { type: "tick", now: NOW + LOST_MS });
    expect(lost.phase).toBe("lost"); expect(pill(lost, NOW)?.kind).toBe("bad");
    const back = reduce(lost, { type: "health", ok: true, now: NOW + LOST_MS + 5000 });
    expect(back.phase).toBe("restarting"); expect(back.reconnect).toBe(true);
  });
  test("health answers but no done event within 90 s: lost too", () => {
    const m = run(restarting(), { type: "health", ok: true, now: NOW + 10_000 });
    expect(reduce(m, { type: "tick", now: NOW + 10_000 + LOST_MS - 1 }).phase).toBe("restarting");
    expect(reduce(m, { type: "tick", now: NOW + 10_000 + LOST_MS }).phase).toBe("lost");
  });
  test("done, rolled-back, rollback-failed and refused come from the done event", () => {
    const at = (r: JobResult) => run(started(), { type: "events", now: NOW, events: [ev({ type: "done", result: r })] });
    expect(at(result("updated")).phase).toBe("done");
    const rb = at(result("rolled-back", { reason: "build failed", steps: [ok("preflight"), ok("checkout"), ok("install"), { id: "build", state: "failed", detail: "boom" }] }));
    expect(rb.phase).toBe("rolled-back"); expect(rb.result?.reason).toBe("build failed"); expect(rb.steps[3]!.state).toBe("failed"); expect(rb.steps[7]!.state).toBe("pending");
    const rf = at(result("rollback-failed", { manual: ["git reset --hard abc"] }));
    expect(rf.phase).toBe("rollback-failed"); expect(rf.result?.manual).toEqual(["git reset --hard abc"]);
    const rf2 = at(result("refused", { reason: "dirty", hint: "Commit or stash your changes first." }));
    expect(rf2.phase).toBe("refused"); expect(rf2.result?.hint).toContain("stash");
    expect(pill(rf2, NOW)).toBeNull();
    expect(pill(rb, NOW)?.kind).toBe("bad");
  });
  test("a page opened within 10 min of a finished job shows it; later or dismissed shows nothing", () => {
    const job = { ...result("rolled-back", { reason: "x" }), endedAt: NOW / 1000 - 60 };
    const m = run(initial(), { type: "status", now: NOW, status: status({ job }) });
    expect(m.phase).toBe("rolled-back");
    expect(run(initial(), { type: "status", now: NOW + PILL_KEEP_MS, status: status({ job }) }).phase).toBe("available");
    // a newer release than the job's target wins over its result; the same release (rolled back) does not
    expect(run(initial(), { type: "status", now: NOW, status: status({ latest: "0.4.1", job: { ...result("updated"), endedAt: NOW / 1000 - 60 } }) }).phase).toBe("available");
    expect(run(initial(), { type: "status", now: NOW, status: status({ latest: "0.4.0", job }) }).phase).toBe("rolled-back");
    expect(run(initial(), { type: "status", now: NOW, status: status({ available: false, latest: "0.4.0", job: { ...result("updated"), endedAt: NOW / 1000 - 60 } }) }).phase).toBe("done");
    const d = run(m, { type: "dismiss" });
    expect(d.phase).toBe("available");
    expect(run(d, { type: "status", now: NOW, status: status({ job }) }).phase).toBe("available");
  });
  test("a live sheet ignores status polls", () => {
    const m = run(restarting(), { type: "status", now: NOW, status: status({ available: false }) });
    expect(m.phase).toBe("restarting");
  });
});

describe("release notes reader", () => {
  test("headings, bullets, bold, code, https links", () => {
    expect(notes("## 0.4.0\n\n- **Update** button\n- run `bin/agentnet update`\n\nSee [docs](https://example.com/a).")).toEqual([
      { kind: "h", level: 2, inline: [{ kind: "text", text: "0.4.0" }] },
      { kind: "li", inline: [{ kind: "b", text: "Update" }, { kind: "text", text: " button" }] },
      { kind: "li", inline: [{ kind: "text", text: "run " }, { kind: "code", text: "bin/agentnet update" }] },
      { kind: "p", inline: [{ kind: "text", text: "See " }, { kind: "a", text: "docs", href: "https://example.com/a" }, { kind: "text", text: "." }] },
    ]);
  });
  test("only https links become links; html stays literal text", () => {
    expect(inline("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
    expect(inline("[x](http://a.b)")).toEqual([{ kind: "text", text: "[x](http://a.b)" }]);
    expect(inline("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
  });
  test("*x* and _x_ are emphasis; snake_case and a lone * stay text", () => {
    expect(inline("press *Update now* or _later_")).toEqual([{ kind: "text", text: "press " }, { kind: "em", text: "Update now" }, { kind: "text", text: " or " }, { kind: "em", text: "later" }]);
    expect(inline("AGENTNET_WEB_UPDATE and 2 * 3")).toEqual([{ kind: "text", text: "AGENTNET_WEB_UPDATE and 2 * 3" }]);
    expect(inline("**bold** then *it*")).toEqual([{ kind: "b", text: "bold" }, { kind: "text", text: " then " }, { kind: "em", text: "it" }]);
  });
  test("empty notes give no blocks", () => { expect(notes("")).toEqual([]); });
});
