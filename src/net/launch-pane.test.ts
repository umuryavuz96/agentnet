// Real Claude Code 2.1.322 screens (test/fixtures/panes, captured from a tmux pane) against the launch reader, the watcher and the trust pre-accept.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
await import("./director"); // load order: director first (windows <-> director cycle)
const { autoAnswer, answerDialog, clearLaunch, isReadyPrompt, launchView, markLaunch, readPane } = await import("./launch");
const { acceptTrust, claudeJsonPath } = await import("./claude-trust");
import type { AnswerDeps, LaunchDeps } from "./launch";

const fx = (n: string) => readFileSync(join(import.meta.dir, "../../test/fixtures/panes", n + ".txt"), "utf8");
const S = "agentnet-root", T0 = 1_000_000;
const deps = (o: Partial<LaunchDeps> & { at?: number } = {}): LaunchDeps => ({ now: () => T0 + (o.at ?? 0), hasSession: () => true, capture: () => "", helloAt: () => null, ...o });

describe("readPane on real screens", () => {
  test("theme picker is not hello: it is a screen agentnet answers itself", () => expect(readPane(fx("theme"), S)).toMatchObject({ stage: "claude", auto: "theme" }));
  test("login method picker and the sign-in url are fatal, not hello", () => {
    expect(readPane(fx("login-method"), S)).toMatchObject({ fatal: true, stage: "claude" });
    expect(readPane(fx("login-url"), S).fatal).toBe(true);
    expect(readPane(fx("login-method"), S).error).not.toContain("tmux");
  });
  test("trust question is stage trust", () => expect(readPane(fx("trust"), S)).toMatchObject({ stage: "trust" }));
  test("the idle input box is hello", () => { expect(readPane(fx("ready"), S).stage).toBe("hello"); expect(isReadyPrompt(fx("ready"))).toBe(true); });
  test("a question with the cursor mark is never ready", () => { for (const n of ["theme", "trust", "login-method"]) expect(isReadyPrompt(fx(n))).toBe(false); });
  test("a refused join is fatal and says why, in words", () => {
    const r = readPane(fx("not-joined"), S);
    expect(r.fatal).toBe(true);
    expect(r.error).toContain("Reset director");
    expect(r.error).not.toContain("tmux");
  });
  test("a wrapped join message is glued back", () => {
    const r = readPane("agentnet: not joined (spawn refused or no answer from http://127.0.0.1:3096/api/v1/agen\ntnet: root is live al\nready)\n\nWelcome", S);
    expect(r.error).toContain("Reset director");
  });
  test("a screen nobody knows is claude, not hello", () => expect(readPane("Some new notice\n  Press any key", S)).toMatchObject({ stage: "claude" }));
  test("press Enter screens are answered by agentnet", () => expect(readPane("Security notes\n\n Press Enter to continue…", S).auto).toBe("continue"));
});

describe("launchView on real screens", () => {
  beforeEach(() => { clearLaunch(); markLaunch(S, T0); });
  afterEach(() => clearLaunch());
  test("theme picker: still starting, questions not ticked", () => expect(launchView(deps({ at: 3000, capture: () => fx("theme") }))).toMatchObject({ state: "starting", stage: "claude" }));
  test("login screen: failed at once, no terminal command", () => {
    const v = launchView(deps({ at: 3000, capture: () => fx("login-method") }));
    expect(v.state).toBe("failed"); expect(v.error).not.toMatch(/tmux|attach/);
  });
  test("join refused: failed at once with the reason", () => {
    const v = launchView(deps({ at: 3000, capture: () => fx("not-joined") }));
    expect(v).toMatchObject({ state: "failed" }); expect(v.error).toContain("Reset director");
  });
  test("an unknown screen shows its text with key buttons after a few seconds, not before", () => {
    const text = "Claude Code v2.1.322\n\n New thing: do you want to enable X?\n   Maybe later\n";
    expect(launchView(deps({ at: 2000, capture: () => text })).dialog ?? null).toBeNull();
    const v = launchView(deps({ at: 8000, capture: () => text }));
    expect(v).toMatchObject({ state: "waiting", stage: "claude", dialog: { kind: "pane" } });
    expect(v.pane).toContain("do you want to enable X");
    expect(v.dialog!.options.map((o) => o.id)).toEqual(["enter", "down-enter", "esc"]);
  });
  test("deadline error never tells the owner to attach", () => {
    for (const n of ["trust", "ready"]) expect(launchView(deps({ at: 400_000, capture: () => fx(n) })).error).not.toMatch(/attach|Ctrl-b/);
  });
});

describe("the watcher", () => {
  const term = (screens: () => string) => { const sent: string[][] = []; const d: AnswerDeps = { capture: () => screens(), keys: (_s, k) => { sent.push(k); }, pause: () => {} }; return { sent, d }; };
  beforeEach(() => { clearLaunch(); });
  afterEach(() => clearLaunch());
  test("theme picker gets Enter", () => {
    markLaunch(S, T0); const t = term(() => fx("theme"));
    expect(autoAnswer(t.d)).toBe("theme"); expect(t.sent).toEqual([["Enter"]]);
  });
  test("trust question for the folder agentnet picked is answered Yes", () => {
    const dir = mkdtempSync(join(tmpdir(), "trust-")); markLaunch(S, T0, undefined, [dir]);
    let at = 0; const sent: string[][] = [];
    const screen = () => fx("trust").replace("/home/x/proj", dir).replace(at ? "❯ No, exit\n   Yes, I trust this folder" : "never", "   No, exit\n ❯ Yes, I trust this folder").replace(!at ? "never" : "never", "");
    const d: AnswerDeps = { capture: screen, keys: (_s, k) => { sent.push(k); if (k[0] === "Down") at = 1; }, pause: () => {} };
    expect(autoAnswer(d)).toBe("trust");
    expect(sent).toEqual([["Down"], ["Enter"]]);
  });
  test("trust question for any other folder is left alone", () => {
    markLaunch(S, T0, undefined, ["/home/x/other"]); const t = term(() => fx("trust"));
    expect(autoAnswer(t.d)).toBeNull(); expect(t.sent).toEqual([]);
  });
  test("the idle prompt and a login screen get no keys", () => {
    markLaunch(S, T0); for (const n of ["ready", "login-method"]) { const t = term(() => fx(n)); expect(autoAnswer(t.d)).toBeNull(); expect(t.sent).toEqual([]); }
  });
  test("it stops after 20 answers", () => {
    markLaunch(S, T0); const t = term(() => fx("theme")); for (let i = 0; i < 25; i++) autoAnswer(t.d);
    expect(t.sent.length).toBe(20);
  });
});

describe("answering an unknown screen", () => {
  const SCREEN = "Claude Code v2.1.322\n\n New thing: enable X?\n   Maybe later\n";
  beforeEach(() => { clearLaunch(); markLaunch(S, T0); });
  afterEach(() => clearLaunch());
  const term = (text: string) => { const sent: string[][] = []; return { sent, d: { capture: () => text, keys: (_s: string, k: string[]) => { sent.push(k); }, pause: () => {} } as AnswerDeps }; };
  test("Enter, Down+Enter and Esc are sent as chosen", () => {
    for (const [id, keys] of [["enter", ["Enter"]], ["down-enter", ["Down", "Enter"]], ["esc", ["Escape"]]] as const) {
      const t = term(SCREEN); expect(answerDialog(id, t.d)).toEqual({ ok: true, kind: "pane" }); expect(t.sent).toEqual([[...keys]]);
    }
  });
  test("never on the idle prompt, an empty pane or an unknown key", () => {
    for (const [text, id] of [[fx("ready"), "enter"], ["", "enter"], [SCREEN, "rm"]] as const) { const t = term(text); expect(answerDialog(id, t.d).ok).toBe(false); expect(t.sent).toEqual([]); }
  });
});

describe("pre-accepting trust in Claude Code's config", () => {
  let dir: string, file: string, bak: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cj-")); file = join(dir, ".claude.json"); bak = join(dir, "bak"); });
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  test("merges one flag, keeps every other key, backs the old file up", () => {
    const old = { numStartups: 7, theme: "dark", projects: { "/w/a": { hasTrustDialogAccepted: true, allowedTools: ["x"] }, "/w/b": { lastCost: 1 } } };
    writeFileSync(file, JSON.stringify(old, null, 2) + "\n", { mode: 0o600 });
    const r = acceptTrust(["/w/b", "/w/c"], { file, backupDir: bak, now: 5 });
    expect(r.changed.sort()).toEqual(["/w/b", "/w/c"]);
    const j = read();
    expect(j.numStartups).toBe(7); expect(j.projects["/w/a"]).toEqual(old.projects["/w/a"]);
    expect(j.projects["/w/b"]).toEqual({ lastCost: 1, hasTrustDialogAccepted: true });
    expect(j.projects["/w/c"]).toEqual({ hasTrustDialogAccepted: true });
    expect(JSON.parse(readFileSync(join(bak, "claude.json.5.bak"), "utf8"))).toEqual(old);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  test("already trusted: no write, no backup", () => {
    writeFileSync(file, JSON.stringify({ projects: { "/w/a": { hasTrustDialogAccepted: true } } }));
    const before = readFileSync(file, "utf8");
    expect(acceptTrust(["/w/a"], { file, backupDir: bak }).changed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before); expect(() => readdirSync(bak)).toThrow();
  });
  test("a missing or broken file is left alone", () => {
    expect(acceptTrust(["/w/a"], { file, backupDir: bak })).toEqual({ changed: [] });
    writeFileSync(file, "{ not json");
    const r = acceptTrust(["/w/a"], { file, backupDir: bak });
    expect(r.changed).toEqual([]); expect(r.error).toBeTruthy(); expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
  test("config path follows CLAUDE_CONFIG_DIR", () => {
    expect(claudeJsonPath({ CLAUDE_CONFIG_DIR: "/c" }, "/h")).toBe("/c/.claude.json");
    expect(claudeJsonPath({}, "/h")).toBe("/h/.claude.json");
  });
});
