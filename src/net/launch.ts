// Director launch state: what the page shows between "Start/Apply" and "the director said hello".
// Memory only. A claude that waits at a dialog (trust folder, approve MCP server, login) inside the hidden tmux session never
// says hello; without this the page waits forever with no reason. connected = a root hello that arrived after startedAt.
import { all } from "./store";
import { deathOf, hasSession as tmuxHas, realTmux, type Tmux } from "./windows";

export type LaunchState = "idle" | "starting" | "waiting" | "connected" | "failed";
export type LaunchStage = "session" | "claude" | "trust" | "hello";
export interface DialogOption { id: string; label: string; selected: boolean }
export interface Dialog { kind: "trust" | "mcp" | "mcp-multi"; title: string; options: DialogOption[]; /** mcp-multi: the servers on screen and whether the answer will enable them (adopt parked ones stay off) */ servers?: { name: string; checked: boolean; enable: boolean }[] }
export interface Launch { state: LaunchState; dialog?: Dialog | null; startedAt: number | null; deadlineAt: number | null; stage: LaunchStage | null; error?: string; sessionName: string | null; attach: string | null; pane?: string; /** the director process exited: its exit status (null = unknown) */ exitCode?: number | null; hint?: string }

export const LAUNCH_TIMEOUT_MS = 300_000, SESSION_GRACE_MS = 5_000;
let cur: { startedAt: number; deadlineAt: number; session: string; failed?: string } | null = null;

/** The director session was spawned (or the start was refused: pass failed). */
export function markLaunch(session: string, now = Date.now(), failed?: string): void {
  cur = { startedAt: now, deadlineAt: now + LAUNCH_TIMEOUT_MS, session, ...(failed ? { failed } : {}) };
}
export const clearLaunch = (): void => { cur = null; };

export interface PaneRead { stage: LaunchStage; error?: string; fatal?: boolean }
/** Read the last screen of the session. Answerable dialogs are stage "trust" (a person must act in the terminal); login and credit problems are fatal. */
export function readPane(text: string, session: string): PaneRead {
  const attach = `tmux attach -t ${session}`;
  if (/Not logged in|Please run \/login|Run \/login/i.test(text)) return { stage: "claude", fatal: true, error: "Claude Code is not logged in. Run claude once in a terminal and use /login, then start again." };
  if (/Credit balance is too low|Credit balance too low/i.test(text)) return { stage: "claude", fatal: true, error: "Claude Code says the credit balance is too low." };
  if (/Quick safety check|Do you trust the files|trust this folder/i.test(text)) return { stage: "trust", error: `Claude Code asks whether you trust this folder. Open the terminal and answer it: ${attach}` };
  if (/MCP servers? found in this project|Use this MCP server/i.test(text)) return { stage: "trust", error: `Claude Code asks you to approve an MCP server of this project. Open the terminal and answer it: ${attach}` };
  if (/custom API key|Detected a custom/i.test(text)) return { stage: "trust", error: `Claude Code asks about an API key in the environment. Open the terminal and answer it: ${attach}` };
  if (/Claude Code v\d|❯/.test(text)) return { stage: "hello" };
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

export interface AnswerDeps { capture: (s: string) => string; keys: (s: string, keys: string[]) => void; pause: () => void }
const realAnswer: AnswerDeps = { capture: (s) => capturePane(s), keys: (s, k) => { realTmux.run(["send-keys", "-t", `=${s}:`, ...k]); }, pause: () => Bun.sleepSync(200) };
/** Answer the dialog the pane shows right now with option `id`: move the cursor, check on screen that it sits on that option, then Enter. Never sends a key when the pane shows no known dialog or no such option. */
export function answerDialog(id: string, d: AnswerDeps = realAnswer): { ok: true; kind: Dialog["kind"] } | { ok: false; reason: string } {
  if (!cur) return { ok: false, reason: "no director start in progress" };
  const s = cur.session, shown = d.capture(s), first = parseDialog(shown);
  if (first?.kind === "mcp-multi") { const e = beforeAnswer("mcp-multi"); return e ? { ok: false, reason: e } : answerMulti(id, s, d); }
  if (!first) return { ok: false, reason: "The terminal shows no dialog this page can answer." };
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
  if (!cur) return { state: "idle", startedAt: null, deadlineAt: null, stage: null, sessionName: null, attach: null };
  const { startedAt, deadlineAt, session } = cur, attach = `tmux attach -t ${session}`;
  const base = { startedAt, deadlineAt, sessionName: session, attach };
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
  if (d.now() > deadlineAt) {
    const why = p.stage === "trust" ? p.error! : p.stage === "hello" ? `The director started but did not say hello within ${LAUNCH_TIMEOUT_MS / 1000} s. Check the terminal: ${attach}` : `Claude Code did not start within ${LAUNCH_TIMEOUT_MS / 1000} s. Check the terminal: ${attach}`;
    return { ...base, state: "failed", stage: p.stage, error: why, dialog: parseDialog(text), pane: tail(text) };
  }
  if (p.stage === "trust") return { ...base, state: "waiting", stage: "trust", error: p.error, dialog: parseDialog(text), pane: tail(text) };
  return { ...base, state: p.stage === "hello" ? "waiting" : "starting", stage: p.stage };
}
