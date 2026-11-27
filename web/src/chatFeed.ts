// The Chat tab timeline: agentnet messages and the agent's terminal feed merged by time into display rows.
// Messages = the agentnet thread only; Terminal = the terminal feed only (owner prompts, agent text, thinking, tool calls); All = both.
// Thinking blocks and tool calls between two bubbles fold into one "work" row: one line when shut, the full run when open.
import type { Msg } from "./net";

export interface FeedItem {
  id: string; ts: number; kind: "owner" | "assistant" | "thinking" | "step" | "delivery" | "event";
  text?: string; nonce?: string; sending?: boolean; failed?: boolean; /** why a send failed, set by the page */ error?: string;
  title?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string; msg?: number; /** what the call was given, short */ inp?: string;
  /** on a step that read an image file: the file's path, for a preview */ img?: string;
  /** on a step that wrote a file (Write, Edit, MultiEdit): the path and what went in (src/net/feed.ts stepFile) */ file?: { path: string; content?: string; edits?: { old: string; new: string }[] };
  /** what kind of tool a step ran: colours its tile */ tool?: "read" | "image" | "search" | "web" | "agent" | "edit" | "command" | "browser" | "other" | "agentnet";
}
export type Filter = "all" | "messages" | "terminal";
export const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "messages", label: "Messages" }, { id: "terminal", label: "Terminal" }];

/** sending = on its way to the server, sent = queued for the agent, shown = the transcript has it, failed = not sent or dropped. */
export type SendState = "sending" | "sent" | "shown" | "failed";
export type Row =
  | { key: string; at: number; type: "msg"; m: Msg }
  | { key: string; at: number; type: "owner"; text: string; state: SendState; nonce?: string; error?: string }
  | { key: string; at: number; type: "assistant"; text: string }
  | { key: string; at: number; type: "work"; items: FeedItem[]; steps: number; thoughts: number; failed: number; running: boolean; ms: number }
  | { key: string; at: number; type: "note"; text: string; body?: string };

/** Keep the newest copy of every id, then drop a pending bubble whose nonce the transcript already shows. */
export function feedItems(items: Map<string, FeedItem>, pending: FeedItem[]): FeedItem[] {
  const all = [...items.values()];
  const seen = new Set(all.filter((i) => i.nonce).map((i) => i.nonce));
  // A transcript line can come without its nonce (read by a parser that did not claim it: an older service, a reconnect).
  // It still is the send: an owner line with the same text written from SEND_SKEW before the send on takes the send's place.
  // Each line stands for one send only, so the same text sent twice keeps the second bubble until its own line comes.
  const bare = all.filter((i) => i.kind === "owner" && !i.nonce);
  const used = new Set<FeedItem>();
  const landed = (p: FeedItem) => {
    const t = flat(p.text ?? "");
    const hit = bare.find((i) => !used.has(i) && i.ts >= p.ts - SEND_SKEW && flat(i.text ?? "") === t);
    if (hit) used.add(hit);
    return !!hit;
  };
  return [...all, ...pending.filter((p) => p.nonce && !seen.has(p.nonce) && !landed(p))];
}
const SEND_SKEW = 5_000;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** The page's own copy of a send wins over the server's for the same nonce, except that a send the server says Claude Code
 *  dropped turns failed (a retry on its way does not). A send the server lists is already queued there. */
export function pendingSends(local: FeedItem[], server: FeedItem[], hidden: ReadonlySet<string>): FeedItem[] {
  const lost = new Set(server.filter((p) => p.failed).map((p) => p.nonce)), s = new Set<string>();
  return [...local.map((l) => (!l.sending && lost.has(l.nonce) ? { ...l, failed: true } : l)), ...server.map((p) => ({ ...p, sending: false }))]
    .filter((p) => p.nonce && !hidden.has(p.nonce) && !s.has(p.nonce) && s.add(p.nonce));
}
/** The sends that wait for the running turn to end: one Send now button stands for all of them. `held` wait for a plugin instead. */
export const waitingSends = (rows: Row[], held: ReadonlySet<string>): string[] =>
  rows.flatMap((r) => (r.type === "owner" && r.state === "sent" && r.nonce && !held.has(r.nonce) ? [r.nonce] : []));

/** One key for an owner prompt from the first keystroke to the transcript line, so its bubble is never rebuilt. */
export const ownerKey = (i: FeedItem) => (i.nonce ? `o:n:${i.nonce}` : `o:${i.id}`);
const sendState = (i: FeedItem): SendState => (i.failed ? "failed" : i.sending ? "sending" : i.id.startsWith("sending:") ? "sent" : "shown");

export function buildRows(msgs: Msg[], items: FeedItem[], filter: Filter): Row[] {
  const raw: { at: number; o: number; row: Row | FeedItem }[] = [];
  let o = 0;
  if (filter !== "terminal") for (const m of msgs) raw.push({ at: m.at, o: o++, row: { key: `m:${m.id ?? "x"}:${m.at}`, at: m.at, type: "msg", m } });
  if (filter !== "messages") for (const i of items) raw.push({ at: i.ts, o: o++, row: i });
  raw.sort((a, b) => a.at - b.at || a.o - b.o);
  const out: Row[] = [];
  let run: FeedItem[] = [];
  const flush = () => {
    if (!run.length) return;
    const steps = run.filter((s) => s.kind === "step");
    const last = run[run.length - 1]!;
    out.push({ key: `w:${run[0]!.id}`, at: run[0]!.ts, type: "work", items: run, steps: steps.length, thoughts: run.length - steps.length,
      failed: steps.filter((s) => s.status === "error").length, running: steps.some((s) => s.status === "running"), ms: Math.max(0, last.ts + (last.ms ?? 0) - run[0]!.ts) });
    run = [];
  };
  for (const { row } of raw) {
    if ("type" in row) { flush(); out.push(row); continue; }
    const i = row;
    if (i.kind === "step" || i.kind === "thinking") { run.push(i); continue; }
    flush();
    const sys = i.kind === "owner" ? harnessNote(i.text ?? "") : null;
    if (sys) out.push({ key: `e:${i.id}`, at: i.ts, type: "note", text: sys, body: i.text });
    else if (i.kind === "owner") out.push({ key: ownerKey(i), at: i.ts, type: "owner", text: i.text ?? "", state: sendState(i), nonce: i.nonce, error: i.error });
    else if (i.kind === "assistant") out.push({ key: `a:${i.id}`, at: i.ts, type: "assistant", text: i.text ?? "" });
    else if (i.kind === "delivery") out.push({ key: `d:${i.id}`, at: i.ts, type: "note", text: `message #${i.msg} delivered` });
    else out.push({ key: `e:${i.id}`, at: i.ts, type: "note", text: i.text ?? "" });
  }
  flush();
  return out;
}

/** Text the harness types into the session is not the owner speaking: a subagent's report handed back, or the summary a
 *  compacted session starts from. It shows as a note on the agent's side with the text behind it, never as a "You" bubble. */
export function harnessNote(text: string): string | null {
  const t = text.trimStart();
  if (/^<agent-message\b/.test(t)) return "A subagent reported back";
  if (t.startsWith("This session is being continued from a previous conversation")) return "Summary of the earlier conversation";
  return null;
}

const secs = (ms: number) => (ms < 1000 ? "" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
/** The one line a folded work row shows: what is running now, or what was done and how long it took. */
export function workLine(w: Extract<Row, { type: "work" }>): string {
  if (w.running) return [...w.items].reverse().find((s) => s.status === "running")?.title ?? "Working";
  const parts: string[] = [];
  if (w.thoughts) parts.push("Thought");
  if (w.steps) parts.push(`${w.thoughts ? "ran" : "Ran"} ${w.steps} ${w.steps === 1 ? "step" : "steps"}`);
  const t = secs(w.ms);
  return parts.join(", ") + (t ? ` in ${t}` : "");
}

/** A run breaks after this gap, so an old header never covers a new thought. */
export const RUN_MS = 5 * 60_000;
/** Who a bubble row speaks as; null for rows that are not bubbles (work, notes). */
export function speaker(r: Row): string | null {
  return r.type === "msg" ? `m:${r.m.from}>${r.m.to}` : r.type === "owner" ? "you" : r.type === "assistant" ? "agent" : null;
}
/** Runs of bubbles from one speaker: `first` carries the header, `last` closes the run. A run ends on another speaker,
 *  any row between (work, note), a new day (`day` gives the day key) or a gap over RUN_MS. */
export function runs(rows: Row[], day: (t: number) => string): { first: boolean; last: boolean }[] {
  const joins = (a: Row | undefined, b: Row | undefined) => !!a && !!b && speaker(a) !== null && speaker(a) === speaker(b) && b.at - a.at <= RUN_MS && day(a.at) === day(b.at);
  return rows.map((r, i) => (speaker(r) === null ? { first: false, last: false } : { first: !joins(rows[i - 1], r), last: !joins(r, rows[i + 1]) }));
}

/** The owner's earlier prompts, newest first, without repeats: what ArrowUp in an empty box walks through. */
export function promptHistory(rows: Row[], max = 50): string[] {
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < max; i--) { const r = rows[i]!; if (r.type === "owner" && r.text && !out.includes(r.text)) out.push(r.text); }
  return out;
}

// ---------- round 2: what the rails and the folded run draw ----------
/** One mark per thought or step of a run, in order: the folded run shows them as a strip. The newest `max` are kept. */
export type Tick = "think" | "ok" | "bad" | "run";
export function ticks(items: FeedItem[], max = 28): Tick[] {
  const t = items.map((i): Tick => (i.kind === "thinking" ? "think" : i.status === "error" ? "bad" : i.status === "running" ? "run" : "ok"));
  return t.length > max ? t.slice(-max) : t;
}

/** The short mark of an agent, as on the map: initials of its words and its number ("designer-4" = D4, "web-dev-1" = WD1, "root" = R). */
export function monogram(name: string): string {
  const num = name.match(/(\d+)\D*$/)?.[1] ?? "";
  const words = name.replace(/\d+/g, " ").split(/[^a-zA-Z]+/).filter(Boolean);
  const letters = words.map((w) => w[0]!.toUpperCase()).join("").slice(0, 2);
  return (letters || name.slice(0, 1).toUpperCase() || "?") + num.slice(0, 2);
}

/** The colour of an agentnet message kind, the same as on the Activity page. */
export const KIND_COLOR: Record<string, string> = { task: "var(--warn)", report: "var(--on)", question: "#6aa8ff", answer: "#b48cff", info: "#38c6d9" };

/** One owner prompt and what came back: the outline of the large view. */
export interface Turn { k: string; at: number; text: string; reply: string; blocks: number; ticks: Tick[]; running: boolean; failed: number }
const firstLine = (md: string) => {
  for (const l of md.replace(/```[\s\S]*?(```|$)/g, "").split("\n")) { const s = l.replace(/^[#>\-*\d.\s]+/, "").replace(/[*_`]/g, "").trim(); if (s) return s.length > 80 ? s.slice(0, 80) + "…" : s; }
  return "";
};
export function turns(rows: Row[]): Turn[] {
  const out: Turn[] = [];
  let cur: Turn | null = null, work: FeedItem[] = [];
  const close = () => { if (cur) cur.ticks = ticks(work, 14); work = []; };
  for (const r of rows) {
    if (r.type === "owner") { close(); cur = { k: r.key, at: r.at, text: r.text.length > 160 ? r.text.slice(0, 160) + "…" : r.text, reply: "", blocks: 0, ticks: [], running: false, failed: 0 }; out.push(cur); }
    else if (!cur) continue;
    else if (r.type === "work") { work.push(...r.items); cur.running = r.running; cur.failed += r.failed; }
    else if (r.type === "assistant") { cur.running = false; cur.reply = firstLine(r.text) || cur.reply; cur.blocks += (r.text.match(/^```ui(-html)?\b/gm) ?? []).length; }
  }
  close();
  return out;
}

/** Where a row sits on the agent's rail. The agent's side of a turn (its words, its work, notes) reads as one line from top
 *  to bottom; the owner's bubbles and agentnet messages break it. `head` opens a stretch, `end` closes it. */
export interface RailPos { on: boolean; head: boolean; end: boolean }
const onRail = (r: Row | undefined) => !!r && (r.type === "assistant" || r.type === "work" || r.type === "note");
export function rail(rows: Row[]): RailPos[] {
  return rows.map((r, i) => ({ on: onRail(r), head: onRail(r) && !onRail(rows[i - 1]), end: onRail(r) && !onRail(rows[i + 1]) }));
}
/** What a finished run did, in words: "8 steps, 3 thoughts in 1 min 26 s". */
export function workSum(w: Extract<Row, { type: "work" }>): string {
  const n = (c: number, one: string) => `${c} ${c === 1 ? one : one + "s"}`;
  const parts = [w.steps ? n(w.steps, "step") : "", w.thoughts ? n(w.thoughts, "thought") : ""].filter(Boolean);
  const t = secs(w.ms);
  return parts.join(", ") + (t ? ` in ${t}` : "");
}
/** The last step of a run, to say where it ended. */
export function lastStep(w: Extract<Row, { type: "work" }>): string {
  for (let i = w.items.length - 1; i >= 0; i--) if (w.items[i]!.kind === "step") return w.items[i]!.title ?? "";
  return "";
}

const IMG_LINE = /^\[image: (\/[^\]\n]+\.(?:png|jpe?g|gif|webp))\]$/i;
/** A prompt with pasted pictures carries one line per picture, `[image: /absolute/path.png]`, which is what the agent reads.
 *  The bubble shows the pictures instead of those lines. */
export function splitImages(text: string): { text: string; images: string[] } {
  const images: string[] = [], keep: string[] = [];
  for (const l of text.split("\n")) { const m = IMG_LINE.exec(l.trim()); if (m) images.push(m[1]!); else keep.push(l); }
  return images.length ? { text: keep.join("\n").trim(), images } : { text, images };
}
/** Why a pasted or dropped picture cannot be sent, or "" when it can. Nothing is dropped without a word: the chip shows this. */
export function picProblem(type: string, size: number, count: number, max = 6, bytes = 10 * 1024 * 1024): string {
  if (count >= max) return `Only ${max} pictures per message`;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return "Only PNG, JPEG, GIF or WebP";
  return size > bytes ? "Over 10 MB" : "";
}
/** The text that goes to the agent: what the owner typed, then a line per picture. */
export const withImages = (text: string, paths: string[]): string => [text, ...paths.map((p) => `[image: ${p}]`)].filter(Boolean).join("\n");

/** One plan step as the trail draws it: its state and the time window in which its calls ran. */
export interface PlanBit { n: number; /** the job, for the "1.2" label */ job?: number; text: string; status: "pending" | "active" | "done" | "dropped"; at?: number; end?: number; proofs: string[] }
export interface CallGroup { step: PlanBit | null; items: FeedItem[] }
/** The calls of a run under the plan step that was open when they ran. Calls outside every step (before the plan, or an
 *  agent with no plan) sit in one group with no step, first. A run with no plan is one group. */
export function groupCalls(items: FeedItem[], plan: PlanBit[]): CallGroup[] {
  const first: CallGroup = { step: null, items: [] }, by = new Map<number, CallGroup>();
  const timed = plan.filter((s) => s.at != null);
  for (const it of items) {
    const s = [...timed].reverse().find((p) => it.ts >= p.at! && (p.end == null || it.ts <= p.end));
    if (!s) { first.items.push(it); continue; }
    let g = by.get(s.n); if (!g) by.set(s.n, g = { step: s, items: [] });
    g.items.push(it);
  }
  return [first, ...[...by.values()].sort((a, b) => a.step!.n - b.step!.n)].filter((g) => g.items.length);
}
/** One square per call for the folded line: done, failed, or running. Thoughts are not calls. */
export function squares(items: FeedItem[]): ("ok" | "bad" | "run")[] {
  return items.filter((i) => i.kind === "step").map((i) => (i.status === "error" ? "bad" : i.status === "running" ? "run" : "ok"));
}

/** The rail of an open run on a plan (canvas Trail, open): the calls outside every step first (drawn as "Before the plan"),
 *  then each plan step with calls in this run, then, when the run ends on the open step, the plan's pending steps after it,
 *  so the rail shows where the work goes next. When the run's last step just finished and the plan's next step is the
 *  open one (no call in it yet), that step and the pending ones after it follow too: the finished step keeps its line
 *  down and the next node is there to grow (canvas Motion "a step finishes").
 *  null when no call of the run falls in a plan step: a plain list of rows. */
export function railSteps(items: FeedItem[], plan: PlanBit[], tail = true): CallGroup[] | null {
  const g = groupCalls(items, plan);
  if (!g.some((x) => x.step)) return null;
  if (!tail) return g;
  const last = g[g.length - 1]!.step;
  const after = last ? plan.filter((s) => s.n > last.n && s.status !== "dropped").sort((a, b) => a.n - b.n) : [];
  const next = last?.status === "active" ? after.filter((s) => s.status === "pending")
    : last?.status === "done" && after[0]?.status === "active" ? after.filter((s) => s.status !== "done") : [];
  return [...g, ...next.map((s) => ({ step: s, items: [] }))];
}
/** How the work runs of one plan step join into one trail when text lands between them: `cont` = the run starts in the
 *  step the run before it ended in, so it draws no second step header, only the rail going on; `tail` = no later run goes
 *  on in the step this run ends in, so this run draws the plan's next nodes. Keyed by the work row's key. */
export function railLinks(rows: Row[], plan: PlanBit[]): Map<string, { cont: boolean; tail: boolean }> {
  const ends = rows.flatMap((r) => {
    if (r.type !== "work") return [];
    const g = groupCalls(r.items.filter((i) => i.kind !== "thinking" || !!i.text), plan);
    return [{ key: r.key, first: g[0]?.step?.n ?? null, last: g.at(-1)?.step?.n ?? null }];
  });
  return new Map(ends.map((e, i) => [e.key, {
    cont: e.first != null && ends[i - 1]?.last === e.first,
    tail: !(e.last != null && ends[i + 1]?.first === e.last),
  }]));
}
/** "Done, 1 failed": the word a folded run ends on (canvas Reply). */
export const doneWord = (failed: number) => (failed ? `Done, ${failed} failed` : "Done");
