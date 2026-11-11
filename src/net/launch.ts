// Director launch state: what the page shows between "Start/Apply" and "the director said hello".
// Memory only. A claude that waits at a dialog (trust folder, approve MCP server, login) inside the hidden tmux session never
// says hello; without this the page waits forever with no reason. connected = a root hello that arrived after startedAt.
import { realpathSync } from "node:fs";
import { all } from "./store";
import { deathOf, hasSession as tmuxHas, realTmux, type Tmux } from "./windows";

export type LaunchState = "idle" | "starting" | "waiting" | "connected" | "failed";
export type LaunchStage = "session" | "claude" | "trust" | "hello";
export interface DialogOption { id: string; label: string; selected: boolean }
export interface Dialog { kind: "trust" | "mcp" | "mcp-multi" | "pane"; title: string; options: DialogOption[]; /** mcp-multi: the servers on screen and whether the answer will enable them (adopt parked ones stay off) */ servers?: { name: string; checked: boolean; enable: boolean }[] }
export interface Launch { state: LaunchState; dialog?: Dialog | null; startedAt: number | null; deadlineAt: number | null; stage: LaunchStage | null; error?: string; sessionName: string | null; pane?: string; /** the director process exited: its exit status (null = unknown) */ exitCode?: number | null; hint?: string }

export const LAUNCH_TIMEOUT_MS = 300_000, SESSION_GRACE_MS = 5_000, UNKNOWN_AFTER_MS = 6_000;
let cur: { startedAt: number; deadlineAt: number; session: string; failed?: string; trusted: string[]; auto: number } | null = null;
let watcher: ReturnType<typeof setInterval> | undefined;

/** The director session was spawned (or the start was refused: pass failed). `trusted` = folders agentnet itself chose for this start: the watcher may answer their trust question. */
export function markLaunch(session: string, now = Date.now(), failed?: string, trusted: string[] = []): void {
  cur = { startedAt: now, deadlineAt: now + LAUNCH_TIMEOUT_MS, session, trusted, auto: 0, ...(failed ? { failed } : {}) };
  clearInterval(watcher);
  if (failed || process.env.NODE_ENV === "test") return;
  // Server side, so a closed browser tab never leaves Claude Code waiting at a question agentnet can answer by itself.
  watcher = setInterval(() => { if (!cur || Date.now() > cur.deadlineAt + 5_000 || cur.failed) return clearInterval(watcher); try { autoAnswer(); } catch { /* next tick */ } }, 1_000);
  watcher.unref?.();
}
export const clearLaunch = (): void => { cur = null; clearInterval(watcher); };

export interface PaneRead { stage: LaunchStage; error?: string; fatal?: boolean; /** a screen agentnet answers by itself (Enter) */ auto?: "theme" | "continue" }
/** The join script prints "agentnet: not joined (reason)" into the pane; a narrow pane wraps it, so the lines are glued back. */
const notJoined = (text: string): string | null => {
  const i = text.indexOf("agentnet: not joined"); if (i < 0) return null;
  const chunk = text.slice(i).split(/\n\s*\n/)[0]!.replace(/\s*\n\s*/g, "");
  return /\(([\s\S]*)\)/.exec(chunk)?.[1] ?? "";
};
/** Why the join script refused, in words the owner can act on. */
export function joinProblem(reason: string): string {
  if (/root is live already/i.test(reason)) return "An earlier director is still registered, so this one could not join. Use Reset director, then start again.";
  if (/no response|connection refused|timeout/i.test(reason)) return "The director could not reach agentnet to join it. Check that agentnet is running, then Retry.";
  return `The director could not join agentnet (${reason.trim().slice(0, 160)}).`;
}
/** A real, idle Claude Code input box: the banner, a "❯" prompt line, and no question (numbered options, cursor on a choice, "Enter to confirm") on screen. */
const FOOTER = /Enter to confirm|Esc to cancel|Enter to continue|Press Enter|to navigate|Select login method|Choose the text style|Paste code here/i;
export const isReadyPrompt = (text: string): boolean => /Claude Code v\d/.test(text) && /^\s*❯(\s|$)/m.test(text) && !/^\s*❯\s+(\d+\.|✔|No,|Yes,)/m.test(text) && !FOOTER.test(text);

/** Read the last screen of the session. "hello" only for a real idle prompt. Known questions are stage "trust". Login, credit and join problems are fatal. */
export function readPane(text: string, _session?: string): PaneRead {
  if (/Not logged in|Please run \/login|Run \/login|Select login method|Paste code here|Browser didn't open/i.test(text)) return { stage: "claude", fatal: true, error: "Claude Code is not signed in. Sign in once (open Claude Code from your terminal and use /login), then Retry." };
  if (/Credit balance is too low|Credit balance too low/i.test(text)) return { stage: "claude", fatal: true, error: "Claude Code says the credit balance is too low." };
  const nj = notJoined(text);
  if (nj !== null) return { stage: "claude", fatal: true, error: joinProblem(nj) };
  if (/Quick safety check|Do you trust the files|trust this folder/i.test(text)) return { stage: "trust", error: "Claude Code asks whether you trust this folder." };
  if (/MCP servers? found in this project|Use this MCP server/i.test(text)) return { stage: "trust", error: "Claude Code asks you to approve an MCP server of this project." };
  if (/custom API key|Detected a custom/i.test(text)) return { stage: "trust", error: "Claude Code asks about an API key in the environment." };
  if (/Choose the text style/i.test(text)) return { stage: "claude", auto: "theme" };
  if (/Press Enter to continue|Enter to continue/i.test(text) && !/^\s*❯\s+\d+\./m.test(text)) return { stage: "claude", auto: "continue" };
  if (isReadyPrompt(text)) return { stage: "hello" };
  return { stage: "claude" };
}

/** The two Claude Code dialogs the page can answer. Option labels must match the exact text; anything else is not a dialog we know and is never answered. */
const DIALOGS: { kind: Dialog["kind"]; match: RegExp; title: string; options: { id: string; label: string }[] }[] = [
  { kind: "trust", match: /Quick safety check/, title: "Claude Code asks whether you trust this folder.", options: [{ id: "yes", label: "Yes, I trust this folder" }, { id: "no", label: "No, exit" }] },
  { kind: "mcp", match: /New MCP server found in this project/, title: "Claude Code asks you to approve an MCP server of this project.", options: [{ id: "use", label: "Use this MCP server" }, { id: "all", label: "Use this and all future MCP servers in this project" }, { id: "skip", label: "Continue without using this MCP server" }] },
];
/** The dialog on screen, with its options in screen order and which one has the cursor. null when the pane shows none of the known ones. */
export function parseDialog(text: string): Dialog | null {
  const mm = readMulti(text); if (mm) return multiDialog(mm);
  const lines = text.split("\n");
  for (const d of DIALOGS) {
    if (!d.match.test(text)) continue;
    const found: (DialogOption & { at: number })[] = [];
    for (const o of d.options) {
      const at = lines.findIndex((l) => l.replace(/^[\s❯]+/, "").trimEnd() === o.label);
      if (at < 0) return null;
      found.push({ id: o.id, label: o.label, selected: /^\s*❯/.test(lines[at]!), at });
    }
    found.sort((a, b) => a.at - b.at);
    if (found.filter((o) => o.selected).length !== 1) return null;
    const title = d.kind === "mcp" ? `${d.title} (${(/New MCP server found in this project: (.+)/.exec(text)?.[1] ?? "").trim().slice(0, 60)})` : d.title;
    return { kind: d.kind, title, options: found.map(({ id, label, selected }) => ({ id, label, selected })) };
  }
  return null;
}
/** Server names adopt switched off (park-mcp ops of the current plan). Set by adopt.ts; those stay unchecked in the multi-select dialog. */
let parkedMcp: () => string[] = () => [];
export const setParkedMcp = (f: () => string[]): void => { parkedMcp = f; };

const ROW = /^\s*(❯)?\s*\[([✔✓x ])\]\s+(\S.*?)\s*$/;
interface Multi { rows: { name: string; checked: boolean }[]; cursor: number }
/** "N new MCP servers found": rows "[✔] name" then the "Enable selected" line. cursor 0..rows.length (the last is Enable selected). null when the screen is not exactly that. */
function readMulti(text: string): Multi | null {
  if (!/\d+ new MCP servers? found in this project/.test(text)) return null;
  const lines = text.split("\n"), rows: Multi["rows"] = []; let cursor = -1;
  for (const l of lines) {
    const m = ROW.exec(l);
    if (m) { if (m[1]) cursor = rows.length; rows.push({ name: m[3]!, checked: m[2] !== " " }); }
    else if (/^\s*(❯)?\s*Enable selected\s*$/.test(l)) { if (l.includes("❯")) cursor = rows.length; if (!rows.length) return null; return cursor < 0 ? null : { rows, cursor }; }
  }
  return null;
}
const multiDialog = (m: Multi): Dialog => {
  const off = new Set(parkedMcp());
  return { kind: "mcp-multi", title: `Claude Code asks you to approve ${m.rows.length} MCP servers of this project.`, options: [{ id: "approve", label: "Enable the servers adopt kept", selected: false }], servers: m.rows.map((r) => ({ name: r.name, checked: r.checked, enable: !off.has(r.name) })) };
};

/** Run before any key is sent for a dialog kind; a returned text blocks the answer (adopt backs up the file Claude Code will write). */
let beforeAnswer: (kind: Dialog["kind"]) => string | null = () => null;
export const setBeforeAnswer = (f: (kind: Dialog["kind"]) => string | null): void => { beforeAnswer = f; };

/** Keys the owner can send to a screen agentnet does not know. Each button on the page says what it does. */
export const PANE_KEYS: Record<string, string[]> = { enter: ["Enter"], "down-enter": ["Down", "Enter"], esc: ["Escape"] };
const paneDialog = (): Dialog => ({ kind: "pane", title: "Claude Code shows a screen agentnet does not know. Read it below and choose a key.", options: [{ id: "enter", label: "Press Enter", selected: false }, { id: "down-enter", label: "Move down one, then Enter", selected: false }, { id: "esc", label: "Press Esc", selected: false }] });

export interface AnswerDeps { capture: (s: string) => string; keys: (s: string, keys: string[]) => void; pause: () => void }
const realAnswer: AnswerDeps = { capture: (s) => capturePane(s), keys: (s, k) => { realTmux.run(["send-keys", "-t", `=${s}:`, ...k]); }, pause: () => Bun.sleepSync(200) };
/** Answer the dialog the pane shows right now with option `id`: move the cursor, check on screen that it sits on that option, then Enter. Never sends a key when the pane shows no known dialog or no such option. */
export function answerDialog(id: string, d: AnswerDeps = realAnswer): { ok: true; kind: Dialog["kind"] } | { ok: false; reason: string } {
  if (!cur) return { ok: false, reason: "no director start in progress" };
  const s = cur.session, shown = d.capture(s), first = parseDialog(shown);
  if (first?.kind === "mcp-multi") { const e = beforeAnswer("mcp-multi"); return e ? { ok: false, reason: e } : answerMulti(id, s, d); }
  if (!first) {
    const keys = PANE_KEYS[id];
    if (!keys || !shown.trim() || isReadyPrompt(shown)) return { ok: false, reason: "The terminal shows no dialog this page can answer." };
    d.keys(s, keys); // an unknown screen: the owner read it on the page and chose this key
    return { ok: true, kind: "pane" };
  }
  const from = first.options.findIndex((o) => o.selected), to = first.options.findIndex((o) => o.id === id);
  if (to < 0) return { ok: false, reason: `That choice is not in the dialog (${first.kind}).` };
  { const e = beforeAnswer(first.kind); if (e) return { ok: false, reason: e }; }
  if (to !== from) { d.keys(s, Array(Math.abs(to - from)).fill(to > from ? "Down" : "Up")); d.pause(); }
  const now = parseDialog(d.capture(s));
  if (!now || now.kind !== first.kind || now.options.findIndex((o) => o.selected) !== to) return { ok: false, reason: "The cursor did not move to that choice. Nothing was confirmed." };
  d.keys(s, ["Enter"]);
  return { ok: true, kind: first.kind };
}

function answerMulti(id: string, s: string, d: AnswerDeps): { ok: true; kind: Dialog["kind"] } | { ok: false; reason: string } {
  if (id !== "approve") return { ok: false, reason: "That choice is not in the dialog (mcp-multi)." };
  const off = new Set(parkedMcp());
  const at = (): Multi | null => readMulti(d.capture(s));
  let m = at(); if (!m) return { ok: false, reason: "The terminal no longer shows the MCP dialog." };
  const move = (to: number): boolean => {
    const cur_ = at(); if (!cur_) return false;
    const delta = to - cur_.cursor; if (!delta) return true;
    d.keys(s, Array(Math.abs(delta)).fill(delta > 0 ? "Down" : "Up")); d.pause();
    return at()?.cursor === to;
  };
  for (let i = 0; i < m.rows.length; i++) {
    const want = !off.has(m.rows[i]!.name);
    if (m.rows[i]!.checked === want) continue;
    if (!move(i)) return { ok: false, reason: "The cursor did not move to the server. Nothing was confirmed." };
    d.keys(s, ["Space"]); d.pause();
    m = at(); if (!m || m.rows[i]!.checked !== want) return { ok: false, reason: "The server did not toggle. Nothing was confirmed." };
  }
  if (!move(m.rows.length)) return { ok: false, reason: "The cursor did not reach Enable selected. Nothing was confirmed." };
  m = at(); if (!m || m.rows.some((r) => r.checked === off.has(r.name))) return { ok: false, reason: "The choices on screen do not match. Nothing was confirmed." };
  d.keys(s, ["Enter"]);
  return { ok: true, kind: "mcp-multi" };
}

/** The folder a trust question is about (the pane wraps long paths, so whitespace inside it is dropped). */
function trustFolder(text: string): string | null {
  const m = /Accessing workspace:\s*([\s\S]*?)\s*Quick safety check/.exec(text);
  return m ? m[1]!.replace(/\s+/g, "") : null;
}
const real_ = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
/** One watcher step: answer what is safe to answer without a person. Returns what it did. Theme and "press Enter" screens take Enter (the default is already chosen);
 *  the trust question is answered Yes only for a folder agentnet itself picked for this start. Everything else is left for the page. */
export function autoAnswer(d: AnswerDeps = realAnswer): "theme" | "continue" | "trust" | null {
  if (!cur) return null;
  const text = d.capture(cur.session), p = readPane(text);
  if (p.auto) { if (cur.auto >= 20) return null; cur.auto++; d.keys(cur.session, ["Enter"]); return p.auto; }
  if (/Quick safety check/.test(text)) {
    const f = trustFolder(text);
    if (f && cur.trusted.some((t) => real_(t) === real_(f)) && cur.auto < 20) { cur.auto++; return answerDialog("yes", d).ok ? "trust" : null; }
  }
  return null;
}

export interface LaunchDeps { now: () => number; hasSession: (s: string) => boolean; capture: (s: string) => string; helloAt: () => number | null }
const capturePane = (s: string, t: Tmux = realTmux): string => { const r = t.run(["capture-pane", "-p", "-t", `=${s}:`]); return r.code === 0 ? r.out : ""; };
/** Latest connectedAt of a live root agent. */
const rootHelloAt = (): number | null => { const r = all().filter((a) => a.name === "root" && a.life === "live").map((a) => a.connectedAt ?? 0); return r.length ? Math.max(...r) : null; };
const real: LaunchDeps = { now: Date.now, hasSession: (s) => tmuxHas(s), capture: (s) => capturePane(s), helloAt: rootHelloAt };

/** What to do about the output of a director that died. */
export function deathHint(out: string): string | undefined {
  if (/unknown option|unrecognized option|unknown argument/i.test(out)) return "This Claude Code is too old for the options agentnet uses. Update it (npm i -g @anthropic-ai/claude-code, or claude update), then Retry.";
  if (/log ?in|auth|not signed in|api key/i.test(out)) return "Claude Code is not signed in. Run claude once in a terminal, sign in, then Retry.";
  return undefined;
}

const tail = (t: string) => t.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-12).join("\n").slice(-1200);

export function launchView(d: LaunchDeps = real): Launch {
  if (!cur) return { state: "idle", startedAt: null, deadlineAt: null, stage: null, sessionName: null };
  const { startedAt, deadlineAt, session } = cur;
  const base = { startedAt, deadlineAt, sessionName: session };
  const hello = d.helloAt();
  if (hello !== null && hello >= startedAt) return { ...base, state: "connected", stage: "hello" }; // a root that was live before the flow does not count
  if (cur.failed) return { ...base, state: "failed", stage: "session", error: cur.failed };
  const age = d.now() - startedAt;
  if (!d.hasSession(session)) {
    const dead = deathOf(session); // set when the pane had exited (director.ts keeps it with remain-on-exit)
    if (dead) return { ...base, state: "failed", stage: "claude", error: `Claude Code exited${dead.exitCode === null ? "" : ` with exit code ${dead.exitCode}`} before the director connected.`, pane: dead.output, exitCode: dead.exitCode, ...(deathHint(dead.output) ? { hint: deathHint(dead.output) } : {}) };
    return age < SESSION_GRACE_MS ? { ...base, state: "starting", stage: "session" } : { ...base, state: "failed", stage: "session", error: "The director's terminal session ended before it connected. Start it again." };
  }
  const text = d.capture(session), p = readPane(text, session);
  if (p.fatal) return { ...base, state: "failed", stage: p.stage, error: p.error, pane: tail(text) };
  const unknown = p.stage === "claude" && !p.auto && text.trim() && age > UNKNOWN_AFTER_MS; // not blank, not a known screen, and it has stayed: show it
  const dialog = parseDialog(text) ?? (unknown ? paneDialog() : null);
  if (d.now() > deadlineAt) {
    const why = p.stage === "trust" ? p.error! : p.stage === "hello" ? `The director started but did not say hello within ${LAUNCH_TIMEOUT_MS / 1000} s. The screen is shown below.` : `Claude Code did not start within ${LAUNCH_TIMEOUT_MS / 1000} s. The screen is shown below.`;
    return { ...base, state: "failed", stage: p.stage, error: why, dialog, pane: tail(text) };
  }
  if (p.stage === "trust" || unknown) return { ...base, state: "waiting", stage: p.stage === "trust" ? "trust" : "claude", error: p.error, dialog, pane: tail(text) };
  return { ...base, state: p.stage === "hello" ? "waiting" : "starting", stage: p.stage };
}
