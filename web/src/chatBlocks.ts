// UI blocks an agent can put in a chat reply (docs/CHAT-UI-BLOCKS.md). A reply is markdown; a fenced block with the language
// `ui` holds JSON for one block or a list of blocks. A fence that is not valid JSON, or names an unknown type, or misses a
// required field, stays in the markdown and shows as plain code: nothing an agent writes can break the chat.
// A fence with the language `ui-html` holds the agent's own HTML, CSS and script: the chat runs it in a sandboxed frame
// (web/src/chatSandbox.ts). An empty one, or one over HTML_MAX, stays as code.
// Pure: no DOM. Every string is cut to a limit and every list to a count, so a block cannot grow without bound.

import { parseJira, type JiraBlock } from "./chatJira";

export type Tone = "info" | "ok" | "warn" | "bad";
export type StepState = "done" | "active" | "todo" | "failed";
export type Block =
  | { type: "card"; title?: string; body?: string; tone: Tone }
  | { type: "stats"; items: { label: string; value: string; note?: string }[] }
  | { type: "table"; columns: string[]; rows: string[][]; align: ("left" | "right")[] }
  | { type: "checklist"; title?: string; items: { text: string; done: boolean }[] }
  | { type: "choices"; prompt?: string; options: { label: string; send: string }[] }
  | { type: "section"; title: string; body: string; open: boolean }
  | { type: "steps"; title?: string; items: { text: string; state: StepState; note?: string }[] }
  | { type: "image"; src: string; alt: string; caption?: string }
  | { type: "file"; path: string; lines?: string; note?: string; content?: string }
  | { type: "task"; kind: TaskKind; id: string; title: string; state: TaskState; owner?: string; progress?: string; sub?: string; note?: string }
  | { type: "draft"; kind: DraftKind; title: string; body: string; to?: string; actions: string[] }
  | JiraBlock
  | { type: "result"; kind: ResultKind; title: string; sub?: string; ref?: string; figures: { value: string; label: string }[]; path?: string; tags: string[]; checks: { text: string; state: CheckState }[]; foot?: string; by?: string; image?: string };
export type TaskKind = "step" | "job" | "ticket" | "message";
export type TaskState = "todo" | "active" | "done" | "blocked" | "wait";
export type ResultKind = "commit" | "shot" | "report" | "pr" | "done";
export type CheckState = "done" | "todo" | "skip" | "wait";
export type DraftKind = "message" | "commit" | "brief" | "post";
export type Segment = { kind: "md"; text: string } | { kind: "ui"; blocks: Block[] } | { kind: "html"; html: string };
/** The most source one `ui-html` fence may hold, in characters. */
export const HTML_MAX = 60_000;

export const BLOCK_TYPES = ["card", "stats", "table", "checklist", "choices", "section", "steps", "image", "file", "task", "draft", "result", "jira"] as const;
const MAX_ITEMS = 40, MAX_COLS = 8, MAX_ROWS = 60, SHORT = 200, LONG = 8000;
const TASK_KINDS: TaskKind[] = ["step", "job", "ticket", "message"], TASK_STATES: TaskState[] = ["todo", "active", "done", "blocked", "wait"], RESULT_KINDS: ResultKind[] = ["commit", "shot", "report", "pr", "done"], CHECK_STATES: CheckState[] = ["done", "todo", "skip", "wait"], DRAFT_KINDS: DraftKind[] = ["message", "commit", "brief", "post"];
const TONES: Tone[] = ["info", "ok", "warn", "bad"], STATES: StepState[] = ["done", "active", "todo", "failed"];
// A picture is a file on this machine (an absolute path to a png, jpg, gif or webp: the service shows it when the agent read
// it or named it here) or a web address (shown as a link: the chat loads no remote picture, since that would tell the
// far server the owner looked).
const IMG_URL = /^(?:https?:\/\/\S+|\/(?!\/)[^\n]*\.(?:png|jpe?g|gif|webp))$/i;
export const isLocalImage = (src: string) => src.startsWith("/");

// A file reference: a path with a known text or code extension, no spaces, no address scheme, an optional `:42` or `:40-58`.
// Shape only: the page cannot know the file exists; the focus view asks the service and says so when it is not there.
const FILE_EXT = "ts|tsx|js|jsx|mjs|cjs|vue|json|jsonl|md|mdx|txt|css|scss|html|yaml|yml|toml|sh|zsh|py|rs|go|swift|kt|java|rb|sql|ini|env|lock|csv|log|conf|plist|svg|png|jpe?g|gif|webp";
const PATH_REF = new RegExp(`^((?:[\\w.~@+-]+/)*[\\w.@+-]+\\.(?:${FILE_EXT}))(?::(\\d{1,6})(?:-(\\d{1,6}))?)?$`, "i");
/** `web/src/a.ts:40-58` as { path, lines }, or null when the text is not a file reference. */
export function parsePathRef(s: string): { path: string; lines?: string } | null {
  if (s.length > 300 || s.includes("://")) return null;
  const m = PATH_REF.exec(s.startsWith("/") ? s.slice(1) : s);
  if (!m) return null;
  return { path: (s.startsWith("/") ? "/" : "") + m[1]!, lines: m[2] ? (m[3] ? `${m[2]}-${m[3]}` : m[2]) : undefined };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
/** A string or number as trimmed text within `max`; anything else is null. */
const str = (v: unknown, max = SHORT): string | null => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return s ? (s.length > max ? s.slice(0, max) + "…" : s) : null;
};
const opt = (v: unknown, max = SHORT) => str(v, max) ?? undefined;
const list = (v: unknown, max = MAX_ITEMS): unknown[] | null => (Array.isArray(v) && v.length ? v.slice(0, max) : null);
/** Every item must be valid, or the block is not. */
function all<T>(v: unknown, f: (x: unknown) => T | null, max = MAX_ITEMS): T[] | null {
  const l = list(v, max); if (!l) return null;
  const out: T[] = [];
  for (const x of l) { const y = f(x); if (y === null) return null; out.push(y); }
  return out;
}

/** One block, checked and trimmed; null when it is not one of ours. */
export function parseBlock(v: unknown): Block | null {
  if (!rec(v)) return null;
  switch (v.type) {
    case "card": {
      const title = opt(v.title), body = opt(v.body, LONG);
      return title || body ? { type: "card", title, body, tone: TONES.includes(v.tone as Tone) ? (v.tone as Tone) : "info" } : null;
    }
    case "stats": {
      const items = all(v.items, (x) => { if (!rec(x)) return null; const label = str(x.label), value = str(x.value); return label && value ? { label, value, note: opt(x.note) } : null; }, 8);
      return items ? { type: "stats", items } : null;
    }
    case "table": {
      const columns = all(v.columns, (x) => str(x), MAX_COLS);
      if (!columns) return null;
      const rows = all(v.rows, (r) => (Array.isArray(r) ? columns.map((_, i) => str(r[i], 600) ?? "") : null), MAX_ROWS);
      if (!rows) return null;
      const a = Array.isArray(v.align) ? v.align : [];
      return { type: "table", columns, rows, align: columns.map((_, i) => (a[i] === "right" ? "right" : "left")) };
    }
    case "checklist": {
      const items = all(v.items, (x) => { const text = str(rec(x) ? x.text : x, 600); return text ? { text, done: rec(x) && x.done === true } : null; });
      return items ? { type: "checklist", title: opt(v.title), items } : null;
    }
    case "choices": {
      const options = all(v.options, (x) => { const label = str(rec(x) ? x.label : x); return label ? { label, send: (rec(x) ? str(x.send, 2000) : null) ?? label } : null; }, 8);
      return options ? { type: "choices", prompt: opt(v.prompt, 600), options } : null;
    }
    case "section": {
      const title = str(v.title), body = str(v.body, LONG);
      return title && body ? { type: "section", title, body, open: v.open === true } : null;
    }
    case "steps": {
      const items = all(v.items, (x) => { const text = str(rec(x) ? x.text : x, 600); return text ? { text, state: rec(x) && STATES.includes(x.state as StepState) ? (x.state as StepState) : "todo", note: rec(x) ? opt(x.note) : undefined } : null; });
      return items ? { type: "steps", title: opt(v.title), items } : null;
    }
    case "image": {
      const src = str(v.src, 2000);
      return src && IMG_URL.test(src) ? { type: "image", src, alt: str(v.alt, 600) ?? "", caption: opt(v.caption, 600) } : null;
    }
    case "file": {
      const ref = typeof v.path === "string" ? parsePathRef(v.path.trim()) : null;
      if (!ref) return null;
      const lines = typeof v.lines === "string" && /^\d{1,6}(-\d{1,6})?$/.test(v.lines.trim()) ? v.lines.trim() : ref.lines;
      return { type: "file", path: ref.path, lines, note: opt(v.note, 300), content: opt(v.content, LONG) };
    }
    case "task": {
      const id = str(v.id, 40), title = str(v.title);
      if (!id || !title) return null;
      const progress = typeof v.progress === "string" && /^\d{1,4}\/\d{1,4}$/.test(v.progress.trim()) ? v.progress.trim() : undefined;
      return { type: "task", id, title, kind: TASK_KINDS.includes(v.kind as TaskKind) ? (v.kind as TaskKind) : "step", state: TASK_STATES.includes(v.state as TaskState) ? (v.state as TaskState) : "todo", owner: opt(v.owner, 40), progress, sub: opt(v.sub, 60), note: opt(v.note, 80) };
    }
    case "draft": {
      const title = str(v.title), body = str(v.body, LONG);
      if (!title || !body) return null;
      const actions = (Array.isArray(v.actions) ? v.actions : []).map((a) => str(a, 24)).filter((a): a is string => !!a).slice(0, 2);
      return { type: "draft", title, body, kind: DRAFT_KINDS.includes(v.kind as DraftKind) ? (v.kind as DraftKind) : "message", to: opt(v.to, 40), actions };
    }
    case "jira": return parseJira(v);
    case "result": {
      const title = str(v.title);
      if (!title) return null;
      const kind = RESULT_KINDS.includes(v.kind as ResultKind) ? (v.kind as ResultKind) : "done";
      const figures = (Array.isArray(v.figures) ? v.figures : []).slice(0, 4).map((x) => { if (!rec(x)) return null; const value = str(x.value, 16), label = str(x.label, 30); return value && label ? { value, label } : null; }).filter((x): x is { value: string; label: string } => !!x);
      const checks = (Array.isArray(v.checks) ? v.checks : []).slice(0, 8).map((x) => { const text = str(rec(x) ? x.text : x, 200); return text ? { text, state: rec(x) && CHECK_STATES.includes(x.state as CheckState) ? (x.state as CheckState) : "done" } : null; }).filter((x): x is { text: string; state: CheckState } => !!x);
      const tags = (Array.isArray(v.tags) ? v.tags : []).slice(0, 4).map((x) => str(x, 30)).filter((x): x is string => !!x);
      const path = typeof v.path === "string" ? opt(v.path, 300) : undefined, image = typeof v.image === "string" && IMG_URL.test(v.image.trim()) ? v.image.trim() : undefined;
      return { type: "result", kind, title, sub: opt(v.sub, 120), ref: opt(v.ref, 24), figures, path, tags, checks, foot: opt(v.foot, 120), by: opt(v.by, 40), image };
    }
  }
  return null;
}

/** The blocks of one fence body, or null when any part of it is not valid (the fence then stays as code). */
export function parseFence(json: string): Block[] | null {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (Array.isArray(v)) return all(v, parseBlock, 12);
  const b = parseBlock(v);
  return b ? [b] : null;
}

const ALERT_HEAD = /^ {0,3}>\s*\[!(OK|WARN|BAD|NOTE|INFO)\]\s*$/i, QUOTE = /^ {0,3}>\s?(.*)$/, FENCE_LINE = /^ {0,3}(```|~~~)/;
const ALERT_TONE: Record<string, Tone> = { ok: "ok", warn: "warn", bad: "bad", note: "info", info: "info" };
/** Markers an agent writes as plain markdown: an alert (`> [!NOTE]` then quoted lines) becomes a card, a file path alone on a
 *  line, or a markdown picture `![alt](path)` alone on a line, becomes a file card. Nothing inside a code fence is touched. Returns the text as one md part when nothing matched. */
export function extractMarkers(text: string): Segment[] {
  if (!text.includes("[!") && !/\.[a-z]{1,5}/i.test(text)) return [{ kind: "md", text }];
  const lines = text.split("\n"), out: Segment[] = [];
  let md: string[] = [], fence = "", hit = false;
  const flush = () => { const t = md.join("\n").trim(); if (t) out.push({ kind: "md", text: t }); md = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, f = FENCE_LINE.exec(line);
    if (f) { fence = !fence ? f[1]! : f[1] === fence ? "" : fence; md.push(line); continue; }
    if (fence) { md.push(line); continue; }
    const a = ALERT_HEAD.exec(line);
    if (a) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) { const q = QUOTE.exec(lines[j]!); if (!q) break; body.push(q[1]!); }
      const b = parseBlock({ type: "card", tone: ALERT_TONE[a[1]!.toLowerCase()], body: body.join("\n").trim() });
      if (b) { flush(); out.push({ kind: "ui", blocks: [b] }); i = j - 1; hit = true; continue; }
    }
    const img = /^\s*!\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$/.exec(line), ip = img ? parsePathRef(img[1]!) : null;
    if (ip) { flush(); out.push({ kind: "ui", blocks: [{ type: "file", path: ip.path, lines: ip.lines }] }); hit = true; continue; }
    const ref = /^\s*`?([^`\s]+)`?\s*$/.exec(line), p = ref ? parsePathRef(ref[1]!) : null;
    if (p) { flush(); out.push({ kind: "ui", blocks: [{ type: "file", path: p.path, lines: p.lines }] }); hit = true; continue; }
    md.push(line);
  }
  if (!hit) return [{ kind: "md", text }];
  flush();
  return out;
}

const FENCE = /^```(ui|ui-html)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
/** Split a reply into markdown, ui and live-HTML parts, in order. A reply with no valid fence is one markdown part. */
export function splitBlocks(text: string): Segment[] {
  if (!text.includes("```ui")) return extractMarkers(text);
  const out: Segment[] = [];
  const push = (t: string) => { for (const s of extractMarkers(t)) out.push(s); };
  let at = 0, md = "";
  for (const m of text.matchAll(FENCE)) {
    const body = m[2]!;
    const seg: Segment | null = m[1] === "ui-html"
      ? (body.trim() && body.length <= HTML_MAX ? { kind: "html", html: body } : null)
      : ((b) => (b ? { kind: "ui", blocks: b } : null))(parseFence(body));
    if (!seg) continue; // stays in the markdown, as code
    md += text.slice(at, m.index);
    if (md.trim()) push(md.trim());
    md = ""; at = m.index + m[0].length;
    out.push(seg);
  }
  md += text.slice(at);
  if (md.trim() || !out.length) push(md.trim());
  return out;
}

/** The least of an agent row a task card needs to see where its step or job stands now (net.ts AgentRow fits). */
export interface LiveAgent { id: string; name: string; jobs?: { id: number; closedAt: number | null; outcome: string | null; steps: { n: number; status: string }[] }[] }
const STEP_NOW: Record<string, TaskState | undefined> = { pending: "todo", active: "active", done: "done" };
/** Where a task card's step or job stands now, from the live agent rows; null when the page cannot know (a ticket, a message,
 *  no owner, an agent or job it does not have). A card is stale when this differs from the state the reply was written with. */
export function liveTaskState(b: Extract<Block, { type: "task" }>, agents: LiveAgent[]): TaskState | null {
  if (!b.owner || (b.kind !== "step" && b.kind !== "job")) return null;
  const a = agents.find((x) => x.name === b.owner || x.id === b.owner);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(b.id.replace(/^job\s+/i, "").trim());
  if (!a?.jobs || !m) return null;
  const job = a.jobs.find((j) => j.id === Number(m[1]));
  if (!job) return null;
  if (b.kind === "job") return job.closedAt == null ? "active" : job.outcome === "done" ? "done" : job.outcome === "blocked" || job.outcome === "failed" ? "blocked" : null;
  if (!m[2]) return null;
  return STEP_NOW[job.steps.find((s) => s.n === Number(m[2]))?.status ?? ""] ?? null;
}
