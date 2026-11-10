// The live terminal feed of one agent, read from Claude Code's own transcript (~/.claude/projects/<slug of cwd>/<session>.jsonl),
// and the owner's typed prompts. Ported (not imported) from server-dash modules/bots/transcript.ts + dashsent.ts + botRoutes.ts.
// The parser follows the file by byte offset and hands out only the items that changed. Reads only; every text is redacted.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactText } from "./bgsum";

export interface FeedItem {
  id: string; ts: number;
  /** owner = typed by the owner (terminal or the page), assistant = the agent's text, step = one tool call, delivery = an agentnet message was handed over, event = compaction / interrupt */
  kind: "owner" | "assistant" | "step" | "delivery" | "event";
  text?: string; nonce?: string; /** the page sent it and the transcript has not shown it yet */ sending?: boolean;
  title?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string; /** agentnet message id of a delivery */ msg?: number;
}

export const FEED_MAX = 200, TEXT_MAX = 20_000, OUT_MAX = 2_000, TAIL_BYTES = 2_000_000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const INTERRUPT_RE = /^\s*\[Request interrupted/;
const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;

// ---------- DashSent: a prompt typed on the page, claimed by the transcript line it becomes ----------
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const TTL = 30 * 60_000, SKEW = 5_000;
export class Sent {
  private list = new Map<string, { text: string; nonce: string | null; at: number }[]>();
  add(agent: string, text: string, nonce: string | null, now = Date.now()) {
    const l = (this.list.get(agent) ?? []).filter((e) => now - e.at < TTL);
    l.push({ text: norm(text), nonce, at: now }); this.list.set(agent, l.slice(-50));
  }
  /** The oldest unclaimed send with this text made before the line was written. */
  claim(agent: string, text: string, ts: number): { nonce: string | null } | null {
    const l = this.list.get(agent); if (!l) return null;
    const t = norm(text), i = l.findIndex((e) => e.text === t && ts + SKEW >= e.at && ts - e.at < TTL);
    if (i < 0) return null;
    return { nonce: l.splice(i, 1)[0]!.nonce };
  }
  /** Sends not yet claimed: the page shows them as "sending". */
  pending(agent: string, now = Date.now()) { return (this.list.get(agent) ?? []).filter((e) => now - e.at < TTL); }
}
export const sent = new Sent();

// ---------- one tool call in plain words ----------
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
  constructor(public path: string, private agent: string, private claim: (agent: string, text: string, ts: number) => { nonce: string | null } | null = (a, t, ts) => sent.claim(a, t, ts), tail = TAIL_BYTES) {
    if (tail > 0) { try { const size = statSync(path).size; if (size > tail) { this.offset = size - tail; this.skipPartial = true; } } catch { /* missing: from 0 */ } }
  }
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
    if (this.items.length > FEED_MAX * 2) { this.items = this.items.slice(-FEED_MAX); this.index = new Map(this.items.map((it, i) => [it.id, i])); }
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
      } else if (b.type === "tool_use") {
        const id = String(b.id);
        this.put({ id, kind: "step", ts, title: redactText(stepTitle(String(b.name), (b.input ?? {}) as Record<string, unknown>)), status: "running" });
        this.stepAt.set(id, ts);
      }
    });
  }

  private result(b: Record<string, any>, ts: number) {
    const id = String(b.tool_use_id ?? ""), step = this.get(id);
    if (!step) return;
    this.put({ ...step, status: b.is_error ? "error" : "ok", ms: Math.max(0, ts - (this.stepAt.get(id) ?? ts)), out: redactText(clip(strip(contentText(b.content)).trim(), OUT_MAX)) });
  }

  private userText(raw: string, uuid: string, ts: number, origin?: { kind?: string; name?: string }) {
    const s = raw.trim();
    if (!s || s.startsWith("<system-reminder>") || s.startsWith("<local-command-caveat>") || s.includes("<task-notification>")) return;
    const cmd = tag(s, "command-name");
    if (cmd) { this.put({ id: uuid, kind: "event", ts, text: redactText(`Ran ${cmd} ${tag(s, "command-args") ?? ""}`.trim()) }); return; }
    if (tag(s, "local-command-stdout") !== null) return;
    if (INTERRUPT_RE.test(s)) { this.interrupt(uuid, ts); return; }
    const m = /^The agentnet plugin sent a message:\s*\n#(\d+)/.exec(s);
    if (m || (origin?.kind === "plugin" && origin.name === "agentnet")) {
      if (m) this.put({ id: uuid, kind: "delivery", ts, msg: Number(m[1]) });
      return; // the boot prompt of a plugin-started turn is not the owner either
    }
    if (origin?.kind && origin.kind !== "human") return; // channel / hook / other plugin prompts
    const mine = this.claim(this.agent, s, ts);
    this.put({ id: uuid, kind: "owner", ts, text: redactText(clip(s, TEXT_MAX)), ...(mine?.nonce ? { nonce: mine.nonce } : {}) });
  }
}

// ---------- which file is the agent's transcript ----------
export const claudeHome = () => process.env.AGENTNET_CLAUDE_HOME ?? join(homedir(), ".claude");
export const projectDir = (cwd: string) => join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
function newest(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: string | null = null, bt = 0;
  for (const f of readdirSync(dir)) { if (!f.endsWith(".jsonl")) continue; const t = statSync(join(dir, f)).mtimeMs; if (t > bt) { bt = t; best = join(dir, f); } }
  return best;
}
/** Status-row session -> its jsonl; else ~/.claude/sessions/<pid>.json -> session + cwd; else the newest jsonl of the project folder. */
export function transcriptFor(a: { session: string | null; project: string | null; pid: number | null }): string | null {
  const ok = (p: string) => (existsSync(p) ? p : null);
  if (a.session && a.project) { const p = ok(join(projectDir(a.project), `${a.session}.jsonl`)); if (p) return p; }
  if (a.pid) {
    try {
      const j = JSON.parse(readFileSync(join(claudeHome(), "sessions", `${a.pid}.json`), "utf8")) as { sessionId?: string; cwd?: string };
      if (j.sessionId && j.cwd) { const p = ok(join(projectDir(j.cwd), `${j.sessionId}.jsonl`)); if (p) return p; }
    } catch { /* no pid file */ }
  }
  return a.project ? newest(projectDir(a.project)) : null;
}
