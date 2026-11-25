// The live terminal feed of one agent, read from Claude Code's own transcript (~/.claude/projects/<slug of cwd>/<session>.jsonl),
// and the owner's typed prompts. Ported (not imported) from server-dash modules/bots/transcript.ts + dashsent.ts + botRoutes.ts.
// The parser follows the file by byte offset and hands out only the items that changed. Reads only; every text is redacted.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactText as redactSecrets } from "./bgsum";

// The secret filter also takes a long path or URL for a token (its last rule matches 28+ mixed characters, "/" included), which
// broke every image a reply pointed at. A path or http(s) URL that ends in an image name and holds no login ("@") and no query
// ("?") is put back as written; everything else stays filtered.
const IMG_REF = /(?:https?:\/\/|\/)[^\s"'`<>()\[\]@?]+\.(?:png|jpe?g|gif|webp)\b/gi;
export function redactText(text: string): string {
  const kept: string[] = [];
  const out = redactSecrets(text.replace(IMG_REF, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; }));
  return kept.length ? out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? "") : out;
}
const IMG_FILE = /\.(png|jpe?g|gif|webp)$/i;
import { configDirOf } from "./agent-config";

export interface FeedItem {
  id: string; ts: number;
  /** owner = typed by the owner (terminal or the page), assistant = the agent's text, thinking = one thinking block (text only when the transcript kept it), step = one tool call, delivery = an agentnet message was handed over, event = compaction / interrupt */
  kind: "owner" | "assistant" | "thinking" | "step" | "delivery" | "event";
  text?: string; nonce?: string; /** the page sent it and the transcript has not shown it yet */ sending?: boolean; /** the terminal did not take it */ failed?: boolean;
  title?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string; /** a short form of what the call was given (the command, the old and new text, the pattern), for the page's In box */ inp?: string; /** what kind of tool a step ran */ tool?: ToolKind; /** a step that read an image file: its path, so the page can show it (chatImages.ts serves it) */ img?: string; /** agentnet message id of a delivery */ msg?: number;
  /** a step that wrote a file (Write, Edit, MultiEdit, NotebookEdit): the path and what went in, for the page's step panel */ file?: StepFile;
}
/** What a writing call put in a file: the whole `content` of a Write, or the old and new text of each edit. Both clipped, both redacted. */
export interface StepFile { path: string; content?: string; edits?: { old: string; new: string }[] }

export const FEED_MAX = 200, TEXT_MAX = 20_000, OUT_MAX = 2_000, TAIL_BYTES = 2_000_000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
export const IN_MAX = 1_500;
/** What the call was given, short: the command, the old and new text of an edit, the pattern of a search, the path of a read. "" when it had nothing worth showing. */
export function inputText(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const half = Math.floor(IN_MAX / 2);
  let t = "";
  if (name === "Bash") t = str("command");
  else if (name === "Edit" || name === "MultiEdit") t = [str("old_string") && `old ${clip(str("old_string"), half)}`, str("new_string") && `new ${clip(str("new_string"), half)}`].filter(Boolean).join("\n");
  else if (name === "Write") t = `${str("file_path")}\n${clip(str("content"), half)}`.trim();
  else if (name === "Read") t = str("file_path");
  else if (name === "Grep" || name === "Glob") t = [str("pattern"), str("path") && `in ${str("path")}`].filter(Boolean).join(" ");
  else if (name === "WebFetch" || name === "WebSearch") t = str("url") || str("query");
  else if (Object.keys(input).length) { try { t = JSON.stringify(input, null, 1); } catch { t = ""; } }
  return clip(t.trim(), IN_MAX);
}
/** Room for a written file in the step panel: a Write's content up to WRITE_MAX, an edit's old and new text up to EDIT_MAX in all. */
export const WRITE_MAX = 6_000, EDIT_MAX = 4_000;
export function stepFile(name: string, input: Record<string, unknown>): StepFile | null {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const path = str(input.file_path) || str(input.notebook_path);
  if (!path) return null;
  if (name === "Write") return { path, content: redactText(clip(str(input.content), WRITE_MAX)) };
  const raw = name === "Edit" ? [{ old: str(input.old_string), new: str(input.new_string) }]
    : name === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]).map((e) => ({ old: str(e?.old_string), new: str(e?.new_string) }))
    : name === "NotebookEdit" ? [{ old: "", new: str(input.new_source) }] : null;
  if (!raw) return null;
  let room = EDIT_MAX;
  const edits: { old: string; new: string }[] = [];
  for (const e of raw) {
    if (room <= 0) break;
    const o = clip(e.old, room); room -= o.length;
    const n = clip(e.new, Math.max(0, room)); room -= n.length;
    edits.push({ old: redactText(o), new: redactText(n) });
  }
  return { path, edits };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const INTERRUPT_RE = /^\s*\[Request interrupted/;
const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;

/** Claude Code stores a long paste as `<pasted_content id="x">\n…\n</pasted_content id="x">`: the text inside is what was typed. */
const unpaste = (s: string) => s.replace(/<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g, "$2");

// ---------- DashSent: a prompt typed on the page, claimed by the transcript line it becomes ----------
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const TTL = 30 * 60_000, SKEW = 5_000, CLAIMED_MAX = 2_000;
export class Sent {
  private list = new Map<string, { text: string; nonce: string | null; at: number; failed?: boolean }[]>();
  add(agent: string, text: string, nonce: string | null, now = Date.now()) {
    const l = (this.list.get(agent) ?? []).filter((e) => now - e.at < TTL);
    l.push({ text: norm(text), nonce, at: now }); this.list.set(agent, l.slice(-50));
  }
  /** Transcript lines that already claimed a send (agent + line id -> nonce): every later reader of the same line (a reconnected
   *  stream, a second device, the history route) gets the same nonce, so the page never shows the send and the line as two bubbles. */
  private claimed = new Map<string, string | null>();
  /** The oldest unclaimed send with this text made before the line was written. With the line's id, a line claims once and
   *  then answers the same nonce to every parser that reads it again. */
  claim(agent: string, text: string, ts: number, id?: string): { nonce: string | null } | null {
    const k = id ? `${agent}\n${id}` : "";
    if (k && this.claimed.has(k)) return { nonce: this.claimed.get(k)! };
    const l = this.list.get(agent); if (!l) return null;
    const t = norm(text), i = l.findIndex((e) => e.text === t && ts + SKEW >= e.at && ts - e.at < TTL);
    if (i < 0) return null;
    const nonce = l.splice(i, 1)[0]!.nonce;
    if (k) { this.claimed.set(k, nonce); if (this.claimed.size > CLAIMED_MAX) this.claimed.delete(this.claimed.keys().next().value!); }
    return { nonce };
  }
  /** The nonce a line already claimed, without claiming anything (the history route reads lines the stream owns). */
  seen(agent: string, id: string): { nonce: string | null } | null { const k = `${agent}\n${id}`; return this.claimed.has(k) ? { nonce: this.claimed.get(k)! } : null; }
  /** The terminal refused this send after the page was answered: the page shows a retry. */
  fail(agent: string, nonce: string | null) { const e = nonce ? this.list.get(agent)?.find((x) => x.nonce === nonce) : undefined; if (e) e.failed = true; }
  /** A retry of the same nonce replaces the failed entry. */
  drop(agent: string, nonce: string | null) { const l = this.list.get(agent); if (l && nonce) this.list.set(agent, l.filter((e) => e.nonce !== nonce)); }
  /** Sends not yet claimed: the page shows them as "sending". */
  pending(agent: string, now = Date.now()) { return (this.list.get(agent) ?? []).filter((e) => now - e.at < TTL); }
}
export const sent = new Sent();

// ---------- one tool call in plain words ----------
export type ToolKind = "read" | "image" | "search" | "web" | "agent" | "edit" | "command" | "browser" | "other";
/** The kind of work a tool call is: the page colours the step's tile by it (the state shows on the rail node instead). */
export function toolKind(name: string, input: Record<string, unknown>): ToolKind {
  if (name === "Read") return typeof input.file_path === "string" && IMG_FILE.test(input.file_path) ? "image" : "read";
  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return "edit";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Agent" || name === "Task") return "agent";
  if (name === "Bash") return "command";
  if (/^mcp__(claude-in-chrome|playwright|.*browser.*)__/i.test(name)) return "browser";
  return "other";
}
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export function stepTitle(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Bash": {
      const c = s("command");
      if (/\b(bun|npm|pnpm|yarn) (run )?(test|check)\b|\b(vitest|pytest|jest)\b|\bbun test\b/.test(c)) return "Running tests";
      if (/\b(build|vite build|web:build)\b/.test(c)) return "Building";
      if (/\bgit (commit|add|diff|status|log)\b/.test(c)) return "Using git";
      return clip(s("description"), 80) || "Running a command";
    }
    case "Read": return `Reading ${base(s("file_path"))}`;
    case "Edit": case "MultiEdit": return `Editing ${base(s("file_path"))}`;
    case "Write": return `Writing ${base(s("file_path"))}`;
    case "Grep": case "Glob": return "Searching the code";
    case "WebFetch": return "Reading a web page";
    case "WebSearch": return "Searching the web";
    case "Agent": case "Task": return `Sub-agent · ${clip(s("description"), 50) || "task"}`;
    case "Skill": return `Skill · ${s("skill")}`;
    case "ToolSearch": return "Loading tools";
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": return "Updating the task list";
  }
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  const server = m[1]!.replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "");
  return `${server === "claude-in-chrome" ? "Chrome" : server} · ${m[2]!.replace(/_mcp$/, "")}`;
}

const contentText = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n") : "";

export class FeedParser {
  items: FeedItem[] = [];
  private index = new Map<string, number>();
  private offset = 0; private rest = ""; private skipPartial = false; private seq = 0;
  private rev = new Map<string, number>();
  private stepAt = new Map<string, number>();
  constructor(public path: string, private agent: string, private claim: (agent: string, text: string, ts: number, id?: string) => { nonce: string | null } | null = (a, t, ts, id) => sent.claim(a, t, ts, id), tail = TAIL_BYTES, private max = FEED_MAX) {
    if (tail > 0) { try { const size = statSync(path).size; if (size > tail) { this.offset = size - tail; this.skipPartial = true; } } catch { /* missing: from 0 */ } }
    this.start = this.offset;
  }
  /** The byte the parser started reading at: 0 = it holds the whole transcript. */
  start = 0;
  get cursor() { return this.seq; }
  /** Read what was appended since last time. */
  update() {
    let size = 0; try { size = statSync(this.path).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.rest = ""; this.skipPartial = false; this.items = []; this.index.clear(); }
    if (size === this.offset) return;
    const fd = openSync(this.path, "r"), buf = Buffer.alloc(size - this.offset);
    try { readSync(fd, buf, 0, buf.length, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const lines = (this.rest + buf.toString("utf8")).split("\n");
    this.rest = lines.pop() ?? "";
    if (this.skipPartial) { lines.shift(); this.skipPartial = false; }
    for (const l of lines) if (l.trim()) this.line(l);
    if (this.items.length > this.max * 2) { this.items = this.items.slice(-this.max); this.index = new Map(this.items.map((it, i) => [it.id, i])); }
  }
  /** Ids changed after `cursor`, for one reader (each SSE client keeps its own cursor). */
  changedSince(cursor: number): { items: FeedItem[]; cursor: number } {
    const ids = [...this.rev].filter(([, n]) => n > cursor).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    return { items: ids.map((id) => this.get(id)).filter((x): x is FeedItem => !!x), cursor: this.seq };
  }
  recent(n = FEED_MAX) { return this.items.slice(-n); }
  get(id: string) { const i = this.index.get(id); return i === undefined ? undefined : this.items[i]; }
  private put(it: FeedItem) {
    const i = this.index.get(it.id);
    if (i === undefined) { this.index.set(it.id, this.items.length); this.items.push(it); } else this.items[i] = it;
    this.rev.set(it.id, ++this.seq);
  }

  private line(l: string) {
    let o: Record<string, any>; try { o = JSON.parse(l); } catch { return; }
    if (o.isSidechain) return;
    const ts = Date.parse(String(o.timestamp ?? "")) || 0, type = String(o.type), uuid = String(o.uuid ?? `${ts}-${this.items.length}`);
    if (type === "system" && o.subtype === "compact_boundary") { this.put({ id: uuid, kind: "event", ts, text: "Compacted" }); return; }
    if (o.isCompactSummary) return;
    if (type === "attachment") { // a prompt that arrived mid-turn
      const a = o.attachment ?? {};
      if (a.type === "queued_command" && typeof a.prompt === "string") this.userText(a.prompt, uuid, ts, o.origin);
      return;
    }
    if (type !== "user" && type !== "assistant") return;
    const content = o.message?.content;
    if (type === "assistant") { this.assistant(content, uuid, ts); return; }
    if (o.isMeta) { if (this.isInterrupt(content)) this.interrupt(uuid, ts); return; } // other meta lines are Claude Code's own context
    if (Array.isArray(content)) {
      let text = "", n = 0;
      for (const b of content as Record<string, any>[]) {
        if (b.type === "tool_result") this.result(b, ts);
        else if (b.type === "text") { const t = String(b.text ?? ""); if (INTERRUPT_RE.test(t)) this.interrupt(`${uuid}:i${n++}`, ts); else text += t; }
      }
      if (text.trim()) this.userText(text, uuid, ts, o.origin);
    } else if (typeof content === "string") this.userText(content, uuid, ts, o.origin);
  }

  private isInterrupt(c: unknown) { return typeof c === "string" ? INTERRUPT_RE.test(c) : Array.isArray(c) && c.some((b) => b && b.type === "text" && INTERRUPT_RE.test(String(b.text ?? ""))); }
  private interrupt(id: string, ts: number) {
    for (const it of this.items) if (it.kind === "step" && it.status === "running") this.put({ ...it, status: "error", out: "Interrupted" });
    this.put({ id, kind: "event", ts, text: "Interrupted" });
  }

  private assistant(content: unknown, uuid: string, ts: number) {
    if (!Array.isArray(content)) return;
    (content as Record<string, any>[]).forEach((b, k) => {
      if (b.type === "text") {
        const text = String(b.text ?? "").trim();
        if (text && text !== "No response requested.") this.put({ id: `${uuid}:${k}`, kind: "assistant", ts, text: redactText(clip(text, TEXT_MAX)) });
      } else if (b.type === "thinking") { // newer transcripts keep only a signature: the row then says the agent thought, with no text
        const text = String(b.thinking ?? "").trim();
        this.put({ id: `${uuid}:${k}`, kind: "thinking", ts, ...(text ? { text: redactText(clip(text, TEXT_MAX)) } : {}) });
      } else if (b.type === "tool_use") {
        const id = String(b.id);
        const file = b.name === "Read" && typeof b.input?.file_path === "string" && IMG_FILE.test(b.input.file_path) ? (b.input.file_path as string) : null;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const inp = inputText(String(b.name), input), wrote = stepFile(String(b.name), input);
        this.put({ id, kind: "step", ts, title: redactText(stepTitle(String(b.name), input)), status: "running", tool: toolKind(String(b.name), input), ...(inp ? { inp: redactText(inp) } : {}), ...(file ? { img: file } : {}), ...(wrote ? { file: wrote } : {}) });
        this.stepAt.set(id, ts);
      }
    });
  }

  private result(b: Record<string, any>, ts: number) {
    const id = String(b.tool_use_id ?? ""), step = this.get(id);
    if (!step) return;
    this.put({ ...step, status: b.is_error ? "error" : "ok", ms: Math.max(0, ts - (this.stepAt.get(id) ?? ts)), out: redactText(clip(strip(contentText(b.content)).trim(), OUT_MAX)) });
  }

  private userText(raw: string, uuid: string, ts: number, origin?: { kind?: string; name?: string; asUser?: boolean }) {
    const s = unpaste(raw).trim();
    if (!s || s.startsWith("<system-reminder>") || s.startsWith("<local-command-caveat>") || s.includes("<task-notification>")) return;
    const cmd = tag(s, "command-name");
    if (cmd) { this.put({ id: uuid, kind: "event", ts, text: redactText(`Ran ${cmd} ${tag(s, "command-args") ?? ""}`.trim()) }); return; }
    if (tag(s, "local-command-stdout") !== null) return;
    if (INTERRUPT_RE.test(s)) { this.interrupt(uuid, ts); return; }
    const m = /^The agentnet plugin sent a message:\s*\n#(\d+)/.exec(s);
    const ownerViaPlugin = !m && origin?.kind === "plugin" && origin.name === "agentnet" && origin.asUser === true; // owner chat handed over by the plugin (ownerPlugin.ts)
    if (m || (origin?.kind === "plugin" && origin.name === "agentnet" && !ownerViaPlugin)) {
      if (m) this.put({ id: uuid, kind: "delivery", ts, msg: Number(m[1]) });
      return; // the boot prompt of a plugin-started turn is not the owner either
    }
    if (origin?.kind && origin.kind !== "human" && !ownerViaPlugin) return; // channel / hook / other plugin prompts
    const mine = this.claim(this.agent, s, ts, uuid);
    this.put({ id: uuid, kind: "owner", ts, text: redactText(clip(s, TEXT_MAX)), ...(mine?.nonce ? { nonce: mine.nonce } : {}) });
  }
}

// ---------- which file is the agent's transcript ----------
export const claudeHome = () => process.env.AGENTNET_CLAUDE_HOME ?? join(homedir(), ".claude");
/** The transcript folder of a working dir; with an agent, inside that agent's own config dir when it runs on one (agent-config.ts). */
export const projectDir = (cwd: string, agent?: string | null) => join(agent ? configDirOf(agent) : claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
function newest(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: string | null = null, bt = 0;
  for (const f of readdirSync(dir)) { if (!f.endsWith(".jsonl")) continue; const t = statSync(join(dir, f)).mtimeMs; if (t > bt) { bt = t; best = join(dir, f); } }
  return best;
}
/** Status-row session -> its jsonl; else ~/.claude/sessions/<pid>.json -> session + cwd; else the newest jsonl of the project folder. */
export function transcriptFor(a: { session: string | null; project: string | null; pid: number | null; name?: string }, o: { strict?: boolean } = {}): string | null {
  const ok = (p: string) => (existsSync(p) ? p : null), who = a.name ?? null;
  if (a.session && a.project) { const p = ok(join(projectDir(a.project, who), `${a.session}.jsonl`)); if (p) return p; }
  if (a.pid) {
    try {
      const j = JSON.parse(readFileSync(join(who ? configDirOf(who) : claudeHome(), "sessions", `${a.pid}.json`), "utf8")) as { sessionId?: string; cwd?: string };
      if (j.sessionId && j.cwd) { const p = ok(join(projectDir(j.cwd, who), `${j.sessionId}.jsonl`)); if (p) return p; }
    } catch { /* no pid file */ }
  }
  return a.project && !o.strict ? newest(projectDir(a.project, who)) : null; // strict (proof checks): only the session's own file
}
