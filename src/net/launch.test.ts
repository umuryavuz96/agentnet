import { beforeEach, describe, expect, test } from "bun:test";
await import("./director"); // load order: director first (windows <-> director cycle)
const { clearLaunch, launchView, LAUNCH_TIMEOUT_MS, markLaunch, readPane } = await import("./launch");
import type { LaunchDeps } from "./launch";

const S = "agentnet-root", T0 = 1_000_000;
const deps = (o: Partial<LaunchDeps> & { at?: number } = {}): LaunchDeps => ({ now: () => T0 + (o.at ?? 0), hasSession: () => true, capture: () => "", helloAt: () => null, ...o });
const TRUST = "Accessing workspace:\n /w\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder";
const MCP = "New MCP server found in this project: lint\n  Use this MCP server\n ❯ Continue without using this MCP server";
const READY = "Claude Code v2.1.322\n❯ \n  auto mode on";

describe("director launch state", () => {
  beforeEach(() => { clearLaunch(); markLaunch(S, T0); });
  test("idle before any start", () => { clearLaunch(); expect(launchView(deps()).state).toBe("idle"); });
  test("trust dialog: waiting at stage trust with the reason", () => {
    const v = launchView(deps({ at: 8000, capture: () => TRUST }));
    expect(v).toMatchObject({ state: "waiting", stage: "trust", sessionName: S, startedAt: T0, deadlineAt: T0 + LAUNCH_TIMEOUT_MS });
    expect(v.error).toContain("trust this folder");
    expect(v.error).not.toContain("tmux attach");
  });
  test("MCP approval dialog is a trust-stage wait too", () => expect(launchView(deps({ at: 9000, capture: () => MCP }))).toMatchObject({ state: "waiting", stage: "trust" }));
  test("claude up, no hello yet: waiting at hello", () => expect(launchView(deps({ at: 9000, capture: () => READY }))).toMatchObject({ state: "waiting", stage: "hello" }));
  test("just started: starting", () => expect(launchView(deps({ at: 1000, capture: () => "" }))).toMatchObject({ state: "starting", stage: "claude" }));
  test("hello after startedAt: connected, even past the deadline", () => expect(launchView(deps({ at: LAUNCH_TIMEOUT_MS + 5, helloAt: () => T0 + 20_000 })).state).toBe("connected"));
  test("a root that was live before the flow does not count", () => expect(launchView(deps({ at: 3000, helloAt: () => T0 - 60_000, capture: () => TRUST })).state).toBe("waiting"));
  test("no hello by the deadline: failed with the reason of the stage", () => {
    const v = launchView(deps({ at: LAUNCH_TIMEOUT_MS + 1, capture: () => TRUST }));
    expect(v).toMatchObject({ state: "failed", stage: "trust" });
    expect(v.error).toContain("trust this folder");
    expect(launchView(deps({ at: LAUNCH_TIMEOUT_MS + 1, capture: () => READY })).error).toContain("did not say hello");
  });
  test("session gone: starting inside the grace, failed after", () => {
    expect(launchView(deps({ at: 2000, hasSession: () => false })).state).toBe("starting");
    expect(launchView(deps({ at: 9000, hasSession: () => false }))).toMatchObject({ state: "failed", stage: "session" });
  });
  test("not logged in and no credit fail at once", () => {
    expect(launchView(deps({ at: 9000, capture: () => "Not logged in · Run /login" }))).toMatchObject({ state: "failed" });
    expect(readPane("Credit balance is too low", S).fatal).toBe(true);
  });
  test("a refused start is failed with its reason", () => {
    markLaunch(S, T0, "A tmux session agentnet-root already exists.");
    expect(launchView(deps({ at: 100 }))).toMatchObject({ state: "failed", error: "A tmux session agentnet-root already exists." });
  });
});

describe("startDirector feeds the launch state", () => {
  test("ok start marks starting; a tmux failure and a running session mark failed", async () => {
    const { startDirector } = await import("./director");
    const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const d = mkdtempSync(join(tmpdir(), "launch-")), tools = { bun: true, claude: true, tmux: true, python3: true };
    clearLaunch();
    expect(startDirector(d, () => ({ status: 0 }), tools, () => false).ok).toBe(true);
    const v = launchView({ ...deps(), now: Date.now });
    expect(v.state).toBe("starting");
    startDirector(d, () => ({ status: 1, stderr: "boom" }), tools, () => false);
    expect(launchView({ ...deps(), now: Date.now })).toMatchObject({ state: "failed", error: "boom" });
    startDirector(d, () => ({ status: 0 }), tools, () => true);
    expect(launchView({ ...deps(), now: Date.now }).error).toContain("already running");
  });
});

describe("answering a dialog from the page", () => {
  const { parseDialog, answerDialog } = require("./launch") as typeof import("./launch");
  const pane = (opts: string[], at: number, head: string) => head + "\n" + opts.map((o, i) => (i === at ? " ❯ " : "   ") + o).join("\n") + "\n Enter to confirm";
  const TRUSTP = (at: number) => pane(["No, exit", "Yes, I trust this folder"].map((x) => x), at, "Quick safety check: Is this a project you created or one you trust?");
  const MCPP = (at: number) => pane(["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"], at, "New MCP server found in this project: lint");
  // a fake terminal: arrows move the cursor, Enter is recorded
  const term = (kind: "trust" | "mcp", at: number, stuck = false) => {
    const sent: string[][] = []; let cur = at;
    const n = kind === "trust" ? 2 : 3;
    return { sent, d: { capture: () => (kind === "trust" ? TRUSTP(cur) : MCPP(cur)), keys: (_s: string, k: string[]) => { sent.push(k); if (stuck) return; for (const x of k) { if (x === "Down") cur = Math.min(n - 1, cur + 1); if (x === "Up") cur = Math.max(0, cur - 1); } }, pause: () => {} } };
  };
  beforeEach(() => { clearLaunch(); markLaunch(S, T0); });
  test("parseDialog reads both dialogs with their options and cursor", () => {
    expect(parseDialog(TRUSTP(0))).toMatchObject({ kind: "trust", options: [{ id: "no", selected: true }, { id: "yes", selected: false }] });
    expect(parseDialog(MCPP(2))!.options.map((o) => o.id)).toEqual(["use", "all", "skip"]);
    expect(parseDialog(MCPP(2))!.title).toContain("lint");
  });
  test("trust: Down then Enter picks Yes", () => { const t = term("trust", 0); expect(answerDialog("yes", t.d)).toEqual({ ok: true, kind: "trust" }); expect(t.sent).toEqual([["Down"], ["Enter"]]); });
  test("trust: No when the cursor is already on it sends Enter only", () => { const t = term("trust", 0); expect(answerDialog("no", t.d).ok).toBe(true); expect(t.sent).toEqual([["Enter"]]); });
  test("mcp: cursor on the last option, choose Use: Up Up Enter", () => { const t = term("mcp", 2); expect(answerDialog("use", t.d).ok).toBe(true); expect(t.sent).toEqual([["Up", "Up"], ["Enter"]]); });
  test("no known dialog: no key is sent", () => {
    const sent: string[][] = [];
    for (const text of ["", READY, "Quick safety check but different options\n ❯ Maybe", "New MCP server found in this project: x\n ❯ Use this MCP server"]) {
      expect(answerDialog("yes", { capture: () => text, keys: (_s, k) => void sent.push(k), pause: () => {} }).ok).toBe(false);
    }
    expect(sent).toEqual([]);
  });
  test("an option the dialog does not have is refused without keys", () => { const t = term("trust", 0); expect(answerDialog("skip", t.d).ok).toBe(false); expect(t.sent).toEqual([]); });
  test("cursor that did not move: Enter is not sent", () => { const t = term("trust", 0, true); const r = answerDialog("yes", t.d); expect(r.ok).toBe(false); expect(t.sent).toEqual([["Down"]]); });
  test("the launch view carries the dialog for the page", () => {
    const v = launchView(deps({ at: 8000, capture: () => TRUSTP(0) }));
    expect(v.dialog?.kind).toBe("trust");
  });
});

describe("MCP multi-select dialog", () => {
  const { answerDialog, parseDialog, setParkedMcp } = require("./launch") as typeof import("./launch");
  // fake terminal of the real pane: rows + "Enable selected", Down/Up move, Space toggles the row under the cursor
  const term = (names: string[], checked: boolean[], stuck = false) => {
    const sent: string[][] = []; let cur = 0; const c = [...checked];
    const screen = () => `2 new MCP servers found in this project\n  Select any you wish to enable.\n` + names.map((n, i) => `  ${cur === i ? "❯" : " "} [${c[i] ? "✔" : " "}] ${n}`).join("\n") + `\n  ${cur === names.length ? "❯" : " "}    Enable selected\n Space to select · Esc to reject all`;
    return { sent, c, d: { capture: () => screen(), pause: () => {}, keys: (_s: string, k: string[]) => { sent.push(k); for (const x of k) { if (stuck) continue; if (x === "Down") cur = Math.min(names.length, cur + 1); else if (x === "Up") cur = Math.max(0, cur - 1); else if (x === "Space" && cur < names.length) c[cur] = !c[cur]; } } } };
  };
  beforeEach(() => { clearLaunch(); markLaunch(S, T0); setParkedMcp(() => []); });
  test("parseDialog lists the servers; parked ones are marked not to be enabled", () => {
    setParkedMcp(() => ["pigeon"]);
    const t = term(["pigeon", "lint"], [true, true]);
    expect(parseDialog(t.d.capture())).toMatchObject({ kind: "mcp-multi", options: [{ id: "approve" }], servers: [{ name: "pigeon", checked: true, enable: false }, { name: "lint", checked: true, enable: true }] });
  });
  test("all kept: Down to Enable selected, Enter, no toggle", () => {
    const t = term(["pigeon", "lint"], [true, true]);
    expect(answerDialog("approve", t.d)).toEqual({ ok: true, kind: "mcp-multi" });
    expect(t.sent.flat()).not.toContain("Space"); expect(t.sent.at(-1)).toEqual(["Enter"]); expect(t.c).toEqual([true, true]);
  });
  test("adopt switched pigeon off: it is unchecked, lint stays, then Enter", () => {
    setParkedMcp(() => ["pigeon"]);
    const t = term(["pigeon", "lint"], [true, true]);
    expect(answerDialog("approve", t.d).ok).toBe(true);
    expect(t.c).toEqual([false, true]); expect(t.sent.at(-1)).toEqual(["Enter"]);
  });
  test("a stuck cursor: nothing is confirmed", () => {
    setParkedMcp(() => ["pigeon"]);
    const t = term(["pigeon", "lint"], [true, true], true);
    expect(answerDialog("approve", t.d).ok).toBe(false); expect(t.sent.flat()).not.toContain("Enter");
  });
  test("another option id is refused without keys", () => { const t = term(["a"], [true]); expect(answerDialog("yes", t.d).ok).toBe(false); expect(t.sent).toEqual([]); });
});

describe("a director whose process exited", () => {
  test("failed at once with the output, exit code and a hint", async () => {
    const { hasSession, deathOf, clearDeath } = await import("./windows");
    const { deathHint } = await import("./launch");
    const out = "error: unknown option '--setting-sources'\n";
    const calls: string[][] = [];
    const t = { run: (a: string[]) => { calls.push(a);
      if (a[0] === "has-session") return { code: calls.some((c) => c[0] === "kill-session") ? 1 : 0, out: "" };
      if (a[0] === "display-message") return { code: 0, out: "1 2\n" };
      if (a[0] === "capture-pane") return { code: 0, out: "\x1b[31m" + out + "\x1b[0m" };
      return { code: 0, out: "" }; } };
    clearDeath(S); clearLaunch(); markLaunch(S, T0);
    expect(hasSession(S, t)).toBe(false); // dead pane = not running
    expect(calls.some((c) => c[0] === "kill-session")).toBe(true);
    expect(calls.find((c) => c[0] === "capture-pane")).toEqual(["capture-pane", "-p", "-S", "-40", "-t", `=${S}:`]);
    expect(deathOf(S)).toMatchObject({ exitCode: 2, output: "error: unknown option '--setting-sources'" });
    const v = launchView(deps({ at: 500, hasSession: () => false })); // inside the grace window: still failed
    expect(v).toMatchObject({ state: "failed", stage: "claude", exitCode: 2, pane: "error: unknown option '--setting-sources'" });
    expect(v.error).toContain("exit code 2");
    expect(v.hint).toContain("Update");
    clearDeath(S);
  });
  test("a live pane is untouched; output is capped at 3000 chars; hints", async () => {
    const { hasSession, reapDead, cleanOutput } = await import("./windows");
    const { deathHint } = await import("./launch");
    const calls: string[][] = [];
    const t = { run: (a: string[]) => { calls.push(a); return { code: 0, out: a[0] === "display-message" ? "0 \n" : "" }; } };
    expect(hasSession(S, t)).toBe(true); expect(reapDead(S, t)).toBeNull();
    expect(calls.some((c) => c[0] === "kill-session" || c[0] === "capture-pane")).toBe(false);
    expect(cleanOutput("x".repeat(5000)).length).toBe(3000);
    expect(cleanOutput("a\n\n\n\n\nb\nPane is dead (status 2, Tue)\n")).toBe("a\n\nb");
    expect(deathHint("Please login first")).toContain("signed in");
    expect(deathHint("segfault")).toBeUndefined();
  });
});
