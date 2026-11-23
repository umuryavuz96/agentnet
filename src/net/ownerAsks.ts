// Owner goals ledger (docs/internal/SPEC-asks-ledger.md). The owner's messages (main bot and voice transcripts, read from files named in
// config/owner-sources.json) become goals; the plan steps of the jobs that work on a goal become its items; an item closes only with
// verified proof, a goal when all its items are closed. A one-minute tick links, syncs, pings root about unlinked goals and runs the stall
// ladder (agent 45 min, root 90, owner 135). Off unless AGENTNET_OWNER_ASKS=1 and the config file exists. The only model calls are the
// classify call per owner message and one coverage call per goal (claude -p --model haiku on the subscription, redacted, capped per day).
import { existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { dir } from "../core/config";
import { db, schema } from "../core/db";
import { logEvent } from "../core/logger";
import { redactText } from "./bgsum";
import { jobsOf, type Evidence, type Job } from "./jobs";
import { ADMIN, byName, enqueueMessage, resolveTo, type AgentRow } from "./routes";
import { ensureSchema as storeSchema, get } from "./store";

export const ownerAsksOn = () => process.env.AGENTNET_OWNER_ASKS === "1";
export const OWNER_DDL = [
  `CREATE TABLE IF NOT EXISTS owner_msgs (source TEXT NOT NULL, msg_id TEXT NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL, kind TEXT, goal_id INTEGER,
     tokens INTEGER, about TEXT, at INTEGER NOT NULL, PRIMARY KEY (source, msg_id))`,
  `CREATE TABLE IF NOT EXISTS owner_goals (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, msg_id TEXT NOT NULL, text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER, stuck_level INTEGER NOT NULL DEFAULT 0,
     level_at INTEGER, unlinked_pinged INTEGER NOT NULL DEFAULT 0, dup_of INTEGER, coverage TEXT, coverage_at INTEGER, note TEXT, drop_reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS owner_links (goal_id INTEGER NOT NULL, agent_id TEXT NOT NULL, agent TEXT NOT NULL, job_id INTEGER NOT NULL, how TEXT NOT NULL,
     at INTEGER NOT NULL, PRIMARY KEY (goal_id, agent_id, job_id))`,
  `CREATE TABLE IF NOT EXISTS owner_items (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL,
     agent_id TEXT, agent TEXT, job_id INTEGER, step_n INTEGER, status TEXT NOT NULL DEFAULT 'open', proof TEXT, mark TEXT, at INTEGER NOT NULL,
     done_at INTEGER, drop_reason TEXT)`,
  "CREATE INDEX IF NOT EXISTS owner_items_goal ON owner_items (goal_id, id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS owner_items_step ON owner_items (goal_id, agent_id, job_id, step_n) WHERE step_n IS NOT NULL",
];

let ddl = false;
/** The store tables plus ours, registered on first use only (importing must never add tables: store.ts note). */
export function ensureSchema() { storeSchema(); if (!ddl) { ddl = true; schema(...OWNER_DDL); } }

export const MIN = 60_000, UNLINKED_MS = 30 * MIN, STALL_MS = 45 * MIN, DEDUP_DAYS = 7, AUTO_HOURS = 48, TEXT_CAP = 2000, DEFAULT_CAP = 250_000;
export type GoalStatus = "open" | "doing" | "done" | "stuck" | "dropped";
export interface GoalRow { id: number; source: string; msg_id: string; text: string; status: GoalStatus; created_at: number; updated_at: number; done_at: number | null;
  stuck_level: number; level_at: number | null; unlinked_pinged: number; dup_of: number | null; coverage: string | null; coverage_at: number | null; note: string | null; drop_reason: string | null }
export interface ItemRow { id: number; goal_id: number; origin: "owner" | "brief"; text: string; agent_id: string | null; agent: string | null; job_id: number | null;
  step_n: number | null; status: "open" | "doing" | "done" | "dropped"; proof: string | null; mark: string | null; at: number; done_at: number | null; drop_reason: string | null }
export interface LinkRow { goal_id: number; agent_id: string; agent: string; job_id: number; how: string; at: number }

// ---------- words ----------
// Common English and Turkish words carry no topic: without this list "the", "and", "make sure" linked a job to the wrong goal (preview 2026-11-18).
const STOP = new Set("the and for with this that these those you your are can also make sure lets let see should will would not but our its his her from have has was were they them then than what when where how all any just like into about there here more much very some been being want need does did done now one two get got use using new okay yani bir şey ama için gibi daha çok olsun şimdi bunu şunu ben biz sen siz var yok evet tamam ile değil olarak kadar sonra önce böyle şöyle çünkü hani işte nasıl neden".split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)));
/** Word Jaccard over unicode words of 3+ letters (Turkish safe). */
/** A follow-up must name something of its goal: one content word shared with the goal or its owner items. */
export function sharesWord(text: string, goal: number): boolean {
  const g = goalById(goal); if (!g) return false;
  const stem = (t: string) => new Set([...words(t)].map((w) => w.slice(0, 5))); // chart/charts, oyun/oyunu
  const have = stem([g.text, ...itemsOf(goal).filter((x) => x.origin === "owner").map((x) => x.text)].join(" "));
  for (const w of stem(text)) if (have.has(w)) return true;
  return false;
}
export function overlap(a: string, b: string): number {
  const x = words(a), y = words(b); if (!x.size || !y.size) return 0;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
/** Share of the goal's words found in the other text: a brief is long, so Jaccard against it is tiny; this asks "does the brief cover him". */
export const coverOf = (goal: string, text: string) => { const g = words(goal), t = words(text); if (!g.size) return 0; let n = 0; for (const w of g) if (t.has(w)) n++; return n / g.size; };
const ACK_RE = /^(ok|okay|oke|yes|yep|no|nope|evet|hay[ıi]r|tamam|thanks|thank you|te[sş]ekk[uü]rler|sa[gğ]ol|go|go on|👍|❤️?|🙏)\W*$/iu;
/** No model call: short text, a plain ack, or an attachment with no words. */
export const isChat = (text: string) => { const t = text.trim(); return t.length < 12 || ACK_RE.test(t) || !/[\p{L}]{2,}/u.test(t); };

// ---------- config ----------
export interface SourceCfg { name: string; glob: string; format: "telegram-channel" | "voice-prefix" }
export interface OwnerCfg { owner_user_id: string | null; sources: SourceCfg[]; daily_token_cap: number }
export function ownerConfig(): OwnerCfg | null {
  let j: Record<string, unknown>; try { j = JSON.parse(readFileSync(join(dir("config"), "owner-sources.json"), "utf8")) as Record<string, unknown>; } catch { return null; }
  const sources = (Array.isArray(j.sources) ? j.sources : []).flatMap((s) => { const r = (s ?? {}) as Record<string, unknown>;
    return typeof r.name === "string" && typeof r.glob === "string" && (r.format === "telegram-channel" || r.format === "voice-prefix") ? [{ name: r.name, glob: r.glob.replace(/^~(?=\/)/, homedir()), format: r.format } as SourceCfg] : []; });
  const cap = Number(j.daily_token_cap);
  return { owner_user_id: typeof j.owner_user_id === "string" ? j.owner_user_id : null, sources, daily_token_cap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP };
}

// ---------- reading the transcripts ----------
export interface OwnerMsg { source: string; msgId: string; ts: number; text: string }
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const attr = (tag: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(tag)?.[1] ?? null;
/** One transcript line → the owner's messages in it. telegram-channel: `<channel source="…telegram…" …>` tags, either in a
 *  `queue-operation` enqueue row (a message that arrived while the session was busy) or in a user turn (it was idle). The same
 *  message can show in both; ingest dedupes by msg id. */
const textOf = (c: unknown): string | null => typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { type?: string; text?: string })?.type === "text" ? (b as { text: string }).text : "").join("\n") : null;
export function parseLine(line: string, src: SourceCfg, owner: string | null): OwnerMsg[] {
  if (src.format === "telegram-channel") {
    if (!line.includes("<channel") || !line.includes("telegram")) return [];
    let o: Record<string, unknown>; try { o = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
    const content = o.type === "queue-operation" && o.operation === "enqueue" ? textOf(o.content) : o.type === "user" ? textOf((o.message as { content?: unknown } | undefined)?.content) : null;
    if (!content) return [];
    const out: OwnerMsg[] = [];
    for (const m of content.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
      const tag = m[1]!, source = attr(tag, "source") ?? "";
      if (!/telegram/.test(source)) continue;
      const id = attr(tag, "message_id"), uid = attr(tag, "user_id"), ts = Date.parse(attr(tag, "ts") ?? "");
      if (!id || (owner && uid !== owner)) continue;
      out.push({ source: src.name, msgId: id, ts: Number.isFinite(ts) ? ts : Date.parse(String(o.timestamp)) || 0, text: unesc(m[2]!.trim()) });
    }
    return out;
  }
  if (!line.includes('"user"') || !/\[(Voice|Voice tr|Chat)\]/.test(line)) return [];
  let o: Record<string, unknown>; try { o = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
  const msg = o.message as { content?: unknown } | undefined;
  if (o.type !== "user" || typeof msg?.content !== "string" || typeof o.uuid !== "string") return [];
  const m = /^\[(Voice|Voice tr|Chat)\]\s*([\s\S]*)$/.exec(msg.content); if (!m) return [];
  return [{ source: src.name, msgId: o.uuid, ts: Date.parse(String(o.timestamp)) || 0, text: m[2]!.trim() }];
}
const START = "_start", FIRST = "_first";
/** When the ledger first scanned: goals from messages before it are backfill and never ping root as "without a job". */
export const firstScanAt = () => readOffsets()[FIRST] ?? 0;
const offsetsFile = () => join(dir("data"), "owner-scan.json");
const readOffsets = (): Record<string, number> => { try { return JSON.parse(readFileSync(offsetsFile(), "utf8")) as Record<string, number>; } catch { return {}; } };
/** New owner messages since the stored offsets (files changed within `sinceMs`). `since` drops messages older than that time. */
export function scanFiles(cfg: OwnerCfg, now = Date.now(), sinceMs = 24 * 3_600_000, since = 0): OwnerMsg[] {
  const off = readOffsets(), out: OwnerMsg[] = [];
  // the ledger starts on the day of its first scan: a long-lived session file is read from byte 0, so its older messages are cut by time
  if (off[START] == null) { const d = new Date(now); d.setHours(0, 0, 0, 0); off[START] = d.getTime(); off[FIRST] = now; }
  since = Math.max(since, off[START]!, now - sinceMs);
  for (const src of cfg.sources) {
    const slash = src.glob.lastIndexOf("/", src.glob.search(/[*?[]/)), base = slash > 0 ? src.glob.slice(0, slash) : ".", pat = src.glob.slice(slash + 1);
    if (!existsSync(base)) continue;
    for (const rel of new Glob(pat).scanSync({ cwd: base, onlyFiles: true })) {
      const f = join(base, rel); let st; try { st = statSync(f); } catch { continue; }
      if (now - st.mtimeMs > sinceMs) continue;
      const from = Math.min(off[f] ?? 0, st.size); if (from === st.size) continue;
      const fd = openSync(f, "r"), buf = Buffer.alloc(st.size - from); readSync(fd, buf, 0, buf.length, from); closeSync(fd);
      const text = buf.toString("utf8"), end = text.lastIndexOf("\n"); if (end < 0) continue; // a half-written last line waits for the next scan
      for (const l of text.slice(0, end).split("\n")) for (const m of parseLine(l, src, cfg.owner_user_id)) if (m.ts >= since) out.push(m);
      off[f] = from + Buffer.byteLength(text.slice(0, end + 1));
    }
  }
  mkdirSync(dir("data"), { recursive: true }); writeFileSync(offsetsFile(), JSON.stringify(off));
  return out;
}

// ---------- the model calls (classify, coverage) ----------
export interface Classified { kind: "goal" | "chat" | "praise" | "complaint"; list: string[]; about: string | null; followUp: number | null; tokens: number }
export type Model = (system: string, input: string) => Promise<{ text: string; tokens: number } | null>;
const CLASSIFY = `You read one message the owner of a home server sent to his assistant. Reply with JSON only:
{"kind":"goal|chat|praise|complaint","list":[],"about":null,"follow_up":null}
goal = he asks for work to be done, built or changed, also when he describes a problem and wants it solved ("there must be a system", "I want", "do X"), and also when he asks you to think a change through.
chat = only a question about facts or status, a greeting, an ack, or talk with no change wanted.
praise = he says he likes a specific finished piece of work.
complaint = he says a specific finished piece of work is wrong or broke again, and asks nothing new. A message that complains and also asks for a change is a goal.
list = ONLY when he wrote an explicit list of separate things to do: each item copied in his own words. Otherwise []. Never invent items.
about = a few words naming the work or agent his praise or complaint is about, else null. Keep his language.
follow_up = when the input lists his open goals and this message plainly adds to, narrows or corrects one of them: it names the same app, page or feature. That goal's number; else null. A new topic, a link, another app or anything unsure is null (a new goal).`;
const COVERAGE = `You compare what the owner asked with the to-do items written for it. Reply with JSON only: {"uncovered":["<short phrase from his words>"]}
List each concrete thing he asked for that no item covers. Ignore greetings, tone and context. [] when everything is covered.`;
/** claude -p on the subscription (bgsum.ts pattern): no tools, no settings, a scratch cwd, JSON out with usage. */
export const claudeModel: Model = async (system, input) => {
  const bin = process.env.AGENTNET_CLAUDE_BIN || "claude";
  try {
    const p = Bun.spawn([bin, "-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--system-prompt", system, "--output-format", "json"],
      { stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "ignore", cwd: tmpdir(), env: { ...process.env, AGENTNET_AGENT: "", AGENTNET_URL: "", AGENTNET_TOKEN_FILE: "" } });
    const t = setTimeout(() => p.kill(), 40_000);
    const out = await new Response(p.stdout).text(); clearTimeout(t); await p.exited;
    const o = JSON.parse(out) as { result?: string; usage?: Record<string, number> }; const u = o.usage ?? {};
    return { text: String(o.result ?? ""), tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) };
  } catch { return null; }
};
export const ownerDeps: { model: Model; notify: (kind: "done" | "stuck", goal: GoalRow, md: string) => void; send: (md: string) => boolean } = { model: claudeModel, notify: (k, g, md) => queueNotify(md), send: (md) => runNotify(md) };
const jsonOf = (s: string): Record<string, unknown> | null => { const m = /\{[\s\S]*\}/.exec(s); try { return m ? JSON.parse(m[0]) as Record<string, unknown> : null; } catch { return null; } };
export async function classify(text: string, open: GoalRow[] = []): Promise<Classified | null> {
  const ctx = open.length ? `His open goals:\n${open.map((g) => `${g.id}: ${clip(redactText(g.text), 100)}`).join("\n")}\n\nThe message:\n` : "";
  const r = await ownerDeps.model(CLASSIFY, ctx + redactText(text).slice(0, TEXT_CAP)); if (!r) return null;
  const j = jsonOf(r.text); if (!j || !["goal", "chat", "praise", "complaint"].includes(String(j.kind))) return null;
  const list = (Array.isArray(j.list) ? j.list : []).map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 12);
  const fu = Number(j.follow_up), followUp = open.some((g) => g.id === fu) ? fu : null;
  return { kind: j.kind as Classified["kind"], list, about: typeof j.about === "string" && j.about.trim() ? j.about.trim().slice(0, 120) : null, followUp, tokens: r.tokens };
}
/** Model tokens per day of the last `days` days (newest first): classify calls (owner messages) and coverage calls. */
export function usageByDay(days = 7, now = Date.now()) {
  ensureSchema(); const out: { day: string; classify: number; classify_calls: number; coverage: number; coverage_calls: number; total: number }[] = [];
  for (let i = 0; i < days; i++) {
    const a = new Date(now); a.setHours(0, 0, 0, 0); a.setDate(a.getDate() - i); const b = new Date(a); b.setDate(b.getDate() + 1);
    const q = (k: string) => db().query(`SELECT COALESCE(SUM(tokens), 0) AS n, COUNT(*) AS c FROM owner_msgs WHERE at >= ? AND at < ? AND kind ${k} AND tokens > 0`).get(a.getTime(), b.getTime()) as { n: number; c: number };
    const cl = q("<> 'coverage'"), cv = q("= 'coverage'");
    out.push({ day: `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, "0")}-${String(a.getDate()).padStart(2, "0")}`, classify: cl.n, classify_calls: cl.c, coverage: cv.n, coverage_calls: cv.c, total: cl.n + cv.n });
  }
  return { cap: ownerConfig()?.daily_token_cap ?? DEFAULT_CAP, days: out };
}
export const tokensToday = (now = Date.now()) => { ensureSchema(); const d = new Date(now); d.setHours(0, 0, 0, 0);
  return (db().query("SELECT COALESCE(SUM(tokens), 0) AS n FROM owner_msgs WHERE at >= ?").get(d.getTime()) as { n: number }).n; };

// ---------- rows ----------
export const goalById = (id: number) => (ensureSchema(), db().query("SELECT * FROM owner_goals WHERE id = ?").get(id) as GoalRow | null);
export const itemsOf = (goal: number) => db().query("SELECT * FROM owner_items WHERE goal_id = ? ORDER BY id").all(goal) as ItemRow[];
export const linksOf = (goal: number) => db().query("SELECT * FROM owner_links WHERE goal_id = ? ORDER BY at").all(goal) as LinkRow[];
const setGoal = (id: number, f: Partial<GoalRow>, now = Date.now()) => { const k = Object.keys(f); if (!k.length) return;
  db().run(`UPDATE owner_goals SET ${k.map((x) => `${x} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [...k.map((x) => (f as Record<string, unknown>)[x] as string | number | null), now, id]); };
const SERVICE = (): AgentRow => ({ ...ADMIN, id: "@agentnet", name: "agentnet" });
const toRoot = (body: string, subject: string) => { const r = resolveTo("root"); const s = r ? enqueueMessage(SERVICE(), r, body, "info", null, subject) : null; if (!s || s.state === "gone") enqueueMessage(SERVICE(), ADMIN, body, "info", null, subject); };
const toAgent = (name: string, body: string, subject: string) => { const r = byName(name); if (r) enqueueMessage(SERVICE(), r, body, "info", null, subject); };
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export interface LearnEvent { type: "rework" | "complaint" | "praise" | "mark"; goal: GoalRow | null; text: string; about: string | null; item?: ItemRow | null; mark?: string }
export const learnFns: ((e: LearnEvent) => void)[] = [];
export const learn = (e: LearnEvent) => { for (const f of learnFns) try { f(e); } catch (x) { logEvent("warn", "owner learn handler failed", { error: String(x) }); } };

/** Store one owner message and classify it (at most one model call). Returns the goal id it made or touched, if any. */
export async function ingest(m: OwnerMsg, cfg: Pick<OwnerCfg, "daily_token_cap">, now = Date.now()): Promise<number | null> {
  ensureSchema();
  if (db().query("SELECT 1 FROM owner_msgs WHERE source = ? AND msg_id = ?").get(m.source, m.msgId)) return null;
  const put = (kind: string, goal: number | null, tokens: number | null, about: string | null = null) =>
    db().run("INSERT OR IGNORE INTO owner_msgs (source, msg_id, ts, text, kind, goal_id, tokens, about, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [m.source, m.msgId, m.ts, m.text, kind, goal, tokens, about, now]);
  if (!m.text.trim() || isChat(m.text)) { // a short reply inside 30 min rides on the newest goal as a note
    const g = m.text.trim() ? db().query("SELECT * FROM owner_goals WHERE created_at >= ? AND status != 'dropped' ORDER BY id DESC LIMIT 1").get(m.ts - UNLINKED_MS) as GoalRow | null : null;
    if (g) setGoal(g.id, { note: clip(`${g.note ? `${g.note} · ` : ""}${m.text}`, 500) }, now);
    put("chat", g?.id ?? null, 0); return null;
  }
  if (tokensToday(now) >= cfg.daily_token_cap) { put("skip", null, 0, "over budget"); overBudget(now); return null; }
  // his open goals of the last 6 h (newest 5) go with the message, so an added detail lands on its goal instead of making a new one
  const at = m.ts || now, openNow = db().query("SELECT * FROM owner_goals WHERE status IN ('open', 'doing', 'stuck') AND dup_of IS NULL AND created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 5").all(at - 6 * 3_600_000, at) as GoalRow[];
  const c = await classify(m.text, openNow);
  if (!c) { put("skip", null, 0, "not classified"); logEvent("warn", "owner message not classified", { source: m.source, msg: m.msgId }); return null; }
  if (c.kind === "praise" || c.kind === "complaint") { put(c.kind, null, c.tokens, c.about); learn({ type: c.kind, goal: matchDone(`${c.about ?? ""} ${m.text}`, now), text: m.text, about: c.about }); return null; }
  if (c.kind === "chat") { put("chat", null, c.tokens); return null; }
  // a goal: a repeat of a recent one is a dup (a done one reopens: rework)
  const recent = db().query("SELECT * FROM owner_goals WHERE created_at >= ? AND dup_of IS NULL AND status != 'dropped' ORDER BY id DESC").all(now - DEDUP_DAYS * 86_400_000) as GoalRow[];
  const same = recent.find((g) => overlap(g.text, m.text) >= 0.6);
  if (!same && c.followUp && !sharesWord(m.text, c.followUp)) logEvent("info", "owner follow-up refused: no shared word", { msg: m.msgId, goal: c.followUp });
  if (!same && c.followUp && sharesWord(m.text, c.followUp)) { // an added detail: one owner item on that goal, which coverage and the gates then treat like the rest
    const g = goalById(c.followUp)!;
    db().run("INSERT INTO owner_items (goal_id, origin, text, status, at) VALUES (?, 'owner', ?, 'open', ?)", [g.id, clip(m.text, 200), now]);
    setGoal(g.id, { coverage_at: null, ...(g.status === "done" ? { status: "doing", done_at: null } : {}) }, now);
    put("goal", g.id, c.tokens); return g.id;
  }
  if (same) {
    const reopen = same.status === "done";
    setGoal(same.id, { note: clip(`${same.note ? `${same.note} · ` : ""}${reopen ? "asked again: " : "again: "}${m.text}`, 500), ...(reopen ? { status: "open", done_at: null, unlinked_pinged: 0, stuck_level: 0, level_at: now } : {}) }, now);
    put("goal", same.id, c.tokens);
    if (reopen) learn({ type: "rework", goal: goalById(same.id), text: m.text, about: null });
    return same.id;
  }
  const id = Number(db().run("INSERT INTO owner_goals (source, msg_id, text, status, created_at, updated_at, level_at) VALUES (?, ?, ?, 'open', ?, ?, ?)", [m.source, m.msgId, m.text, m.ts || now, now, now]).lastInsertRowid);
  for (const t of c.list) db().run("INSERT INTO owner_items (goal_id, origin, text, status, at) VALUES (?, 'owner', ?, 'open', ?)", [id, t, now]);
  put("goal", id, c.tokens);
  return id;
}
let budgetDay = "";
function overBudget(now: number) { const d = new Date(now).toDateString(); if (budgetDay === d) return; budgetDay = d; toRoot("Owner goals: today's model token cap is used up. New owner messages are stored unclassified until midnight.", "owner goals: token cap"); }
/** The newest done goal (48 h) whose words overlap the text: what a praise or complaint is about. */
function matchDone(text: string, now: number): GoalRow | null {
  const rows = db().query("SELECT * FROM owner_goals WHERE status = 'done' AND done_at >= ? ORDER BY done_at DESC").all(now - AUTO_HOURS * 3_600_000) as GoalRow[];
  return rows.find((g) => overlap(g.text, text) >= 0.3 || coverOf(text, g.text) >= 0.5) ?? null;
}

// ---------- linking jobs ----------
/** Which goal a new job is for: `Goal: G12` (or goal_id), else a message id the brief names, else the best word cover (marked auto). */
export function goalFor(brief: string, explicit: unknown, now = Date.now()): { id: number; how: string } | null {
  ensureSchema();
  const ex = Number(explicit) || Number(/^\s*(?:owner\s+)?goal:\s*G?(\d+)\b/im.exec(brief)?.[1] ?? NaN);
  if (ex && goalById(ex)) return { id: ex, how: "cited" };
  for (const m of brief.matchAll(/\bmsg(?:\.|\s+id)?\s*#?(\d{3,})\b/gi)) {
    const g = db().query("SELECT goal_id FROM owner_msgs WHERE msg_id = ? AND goal_id IS NOT NULL").get(m[1]!) as { goal_id: number } | null;
    if (g) return { id: g.goal_id, how: "msg-id" };
  }
  const open = db().query("SELECT * FROM owner_goals WHERE created_at >= ? AND status IN ('open', 'doing', 'stuck') AND dup_of IS NULL").all(now - AUTO_HOURS * 3_600_000) as GoalRow[];
  const scored = open.filter((g) => words(g.text).size >= 3).map((g) => ({ g, s: coverOf(g.text, brief) })).sort((a, b) => b.s - a.s); // a goal of one or two words matches anything
  if (scored[0] && scored[0].s >= 0.4 && scored[0].s - (scored[1]?.s ?? 0) >= 0.1 && brief.length >= 40) return { id: scored[0].g.id, how: "auto" };
  return null;
}
/** Record that this agent's job works on the goal. Items follow the job's plan on the next sync. */
export function link(goal: number, agentId: string, agent: string, job: number, how: string, now = Date.now()) {
  ensureSchema();
  db().run("INSERT OR IGNORE INTO owner_links (goal_id, agent_id, agent, job_id, how, at) VALUES (?, ?, ?, ?, ?, ?)", [goal, agentId, agent, job, how, now]);
  const g = goalById(goal); if (g && (g.status === "open" || g.status === "stuck")) setGoal(goal, { status: "doing", level_at: now, stuck_level: 0 }, now);
  syncGoal(goal, now);
}
/** startJob hook: link the job that was just opened. Returns a line for the job_open warnings. */
export function linkOpenedJob(agentId: string, brief: string, explicit: unknown, now = Date.now()): string | null {
  if (!ownerAsksOn()) return null;
  const s = get(agentId), job = s ? jobsOf(s).at(-1) : undefined; if (!s || !job) return null;
  const g = goalFor(brief, explicit, now);
  if (!g) return brief.trim() ? "no owner goal matched; add a line `Goal: G<n>` to the brief if this job is for one" : null;
  link(g.id, agentId, s.name, job.id, g.how, now);
  return `linked to owner goal G${g.id} (${g.how})`;
}
const PROVEN: Evidence["kind"][] = ["commit", "check", "shot", "file"];
export const proofOf = (ev: Evidence[]) => ev.find((e) => e.ok === true && PROVEN.includes(e.kind)) ?? null;
const jobOf = (agentId: string, job: number): Job | null => { const s = get(agentId); return s ? jobsOf(s).find((j) => j.id === job) ?? null : null; };
/** Items follow the linked jobs' plans: one item per step; a dropped step drops it; a step closed with verified proof closes it. */
export function syncGoal(goal: number, now = Date.now()) {
  const g = goalById(goal); if (!g || g.status === "dropped") return;
  const links = linksOf(goal); let openLink = false;
  for (const l of links) {
    const j = jobOf(l.agent_id, l.job_id); if (!j) continue;
    if (j.closedAt == null) openLink = true;
    for (const st of j.steps) {
      const have = db().query("SELECT * FROM owner_items WHERE goal_id = ? AND agent_id = ? AND job_id = ? AND step_n = ?").get(goal, l.agent_id, l.job_id, st.n) as ItemRow | null;
      const p = st.status === "done" ? proofOf(st.evidence) : null;
      const status = st.status === "dropped" ? "dropped" : p ? "done" : j.closedAt != null ? "open" : "doing";
      const proof = p ? `${p.kind}: ${p.value}` : null;
      if (!have) db().run("INSERT INTO owner_items (goal_id, origin, text, agent_id, agent, job_id, step_n, status, proof, at, done_at, drop_reason) VALUES (?, 'brief', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [goal, st.text, l.agent_id, l.agent, l.job_id, st.n, status, proof, now, p ? st.closedAt ?? now : null, st.status === "dropped" ? st.reason ?? "dropped" : null]);
      else if (have.mark !== "unwanted" && (have.status !== status || have.proof !== proof))
        db().run("UPDATE owner_items SET status = ?, proof = ?, done_at = ?, drop_reason = ? WHERE id = ?", [status, proof, p ? have.done_at ?? st.closedAt ?? now : null, st.status === "dropped" ? st.reason ?? "dropped" : null, have.id]);
    }
    // an owner item with no step yet takes the step whose words overlap it most (≥ 0.3)
    for (const it of itemsOf(goal).filter((x) => x.origin === "owner" && x.step_n == null)) {
      const best = j.steps.map((st) => ({ st, s: Math.max(overlap(it.text, st.text), coverOf(it.text, st.text) * 0.6) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.3) db().run("UPDATE owner_items SET agent_id = ?, agent = ?, job_id = ?, step_n = ? WHERE id = ?", [l.agent_id, l.agent, l.job_id, best.st.n, it.id]);
    }
  }
  // owner items follow the step they point at
  for (const it of itemsOf(goal).filter((x) => x.origin === "owner" && x.step_n != null && x.mark !== "unwanted")) {
    const st = it.agent_id && it.job_id != null ? jobOf(it.agent_id, it.job_id)?.steps.find((x) => x.n === it.step_n) : undefined; if (!st) continue;
    const p = st.status === "done" ? proofOf(st.evidence) : null, status = p ? "done" : st.status === "dropped" ? "dropped" : "doing";
    if (status !== it.status) db().run("UPDATE owner_items SET status = ?, proof = ?, done_at = ? WHERE id = ?", [status, p ? `${p.kind}: ${p.value}` : null, p ? now : null, it.id]);
  }
  const items = itemsOf(goal), live = items.filter((x) => x.status !== "dropped");
  if (links.length && items.some((x) => x.status === "done") && live.every((x) => x.status === "done")) {
    if (g.status !== "done") { setGoal(goal, { status: "done", done_at: now, stuck_level: 0 }, now); notifyDone(goalById(goal)!); }
  } else if (g.status === "done") setGoal(goal, { status: openLink ? "doing" : "open", done_at: null }, now);
  else if (!openLink && links.length && g.status === "doing") setGoal(goal, { status: "open", unlinked_pinged: 0, level_at: now }, now); // every linked job closed with items left: back to open
}
function notifyDone(g: GoalRow) {
  const items = itemsOf(g.id).filter((x) => x.status === "done");
  const md = [`✅ G${g.id} done (${items.length}/${itemsOf(g.id).filter((x) => x.status !== "dropped").length} items): ${clip(g.text, 100)}`, ...items.map((x) => `- ${clip(x.text, 80)}: ${x.proof}`)].join("\n");
  try { ownerDeps.notify("done", g, md); } catch (e) { logEvent("warn", "owner notify failed", { error: String(e) }); }
}

// ---------- the gates ----------
const linksOfJob = (agentId: string, job: number) => (ensureSchema(), db().query("SELECT * FROM owner_links WHERE agent_id = ? AND job_id = ?").all(agentId, job) as LinkRow[]);
/** After a step closes: the goals this job works on catch up now (a closed goal pushes at once, not on the next tick). */
export function syncLinked(agentId: string, job: number, now = Date.now()) { if (!ownerAsksOn()) return; try { for (const l of linksOfJob(agentId, job)) syncGoal(l.goal_id, now); } catch (e) { logEvent("warn", "owner goal sync failed", { error: String(e) }); } }
/** step_done: a step of a job linked to an owner goal needs a verified commit, check, shot or file line. Returns the refusal, or null. */
export function stepGate(agentId: string, job: number, step: number, checked: Evidence[]): string | null {
  if (!ownerAsksOn()) return null;
  const l = linksOfJob(agentId, job)[0]; if (!l || proofOf(checked)) return null;
  return `agentnet: step ${job}.${step} is part of the owner's goal G${l.goal_id}. Close it with proof that checks out: a commit, a check line, a shot or a file on disk (none: and unverified lines are not enough).`;
}
/** The done report: every item of this job needs its proof (covers steps closed before the job was linked). */
export function reportGate(agentId: string, job: number, now = Date.now()): string | null {
  if (!ownerAsksOn()) return null;
  const links = linksOfJob(agentId, job); if (!links.length) return null;
  for (const l of links) syncGoal(l.goal_id, now);
  const bad = links.flatMap((l) => (db().query("SELECT * FROM owner_items WHERE goal_id = ? AND agent_id = ? AND job_id = ? AND status NOT IN ('done', 'dropped')").all(l.goal_id, agentId, job) as ItemRow[]));
  if (!bad.length) return null;
  return `agentnet: you cannot report done while ${bad.length} item${bad.length > 1 ? "s" : ""} of the owner's goal ${[...new Set(bad.map((x) => `G${x.goal_id}`))].join(", ")} ha${bad.length > 1 ? "ve" : "s"} no proof (${bad.slice(0, 5).map((x) => `step ${x.step_n}: ${clip(x.text, 50)}`).join("; ")}). Steps closed with none: or unverified lines do not count. Ask your boss to drop an item that is not needed.`;
}

// ---------- root tools ----------
export type Err = { error: string; status: 404 | 409 | 422 };
export function rootLink(goal: number, agent: string, now = Date.now()): GoalRow | Err {
  const g = goalById(goal); if (!g) return { error: "no such goal", status: 404 };
  // a finished agent is archived: its newest run still holds the job root links (closed jobs count too)
  const a = byName(agent) ?? (db().query("SELECT * FROM agents WHERE name = ? ORDER BY gen DESC LIMIT 1").get(agent) as AgentRow | null), s = a ? get(a.id) : null, j = s ? jobsOf(s).at(-1) : undefined;
  if (!a || !j) return { error: `${agent} has no job`, status: 404 };
  db().run("DELETE FROM owner_links WHERE agent_id = ? AND job_id = ? AND goal_id != ? AND how = 'auto'", [a.id, j.id, goal]); // root's word replaces a wrong auto link
  db().run("DELETE FROM owner_items WHERE agent_id = ? AND job_id = ? AND goal_id != ? AND origin = 'brief' AND goal_id NOT IN (SELECT goal_id FROM owner_links WHERE agent_id = ? AND job_id = ?)", [a.id, j.id, goal, a.id, j.id]);
  link(goal, a.id, a.name, j.id, "root", now); return goalById(goal)!;
}
export function rootDrop(goal: number, reason: string, now = Date.now()): GoalRow | Err {
  const g = goalById(goal); if (!g) return { error: "no such goal", status: 404 };
  if (!reason.trim()) return { error: "a reason is required", status: 422 };
  setGoal(goal, { status: "dropped", drop_reason: clip(reason, 200) }, now); return goalById(goal)!;
}
export function rootItemLink(item: number, agent: string, step: number): ItemRow | Err {
  ensureSchema(); const it = db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow | null; if (!it) return { error: "no such item", status: 404 };
  const a = byName(agent), s = a ? get(a.id) : null, j = s ? jobsOf(s).at(-1) : undefined;
  if (!a || !j || !j.steps.some((x) => x.n === step)) return { error: `${agent} has no step ${step} in its job`, status: 404 };
  db().run("UPDATE owner_items SET agent_id = ?, agent = ?, job_id = ?, step_n = ? WHERE id = ?", [a.id, a.name, j.id, step, item]);
  syncGoal(it.goal_id); return db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow;
}
export function rootItemDone(item: number, ev: Evidence[], now = Date.now()): ItemRow | Err {
  ensureSchema(); const it = db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow | null; if (!it) return { error: "no such item", status: 404 };
  const p = proofOf(ev); if (!p) return { error: "proof needed: a commit, check, shot or file line that checks out", status: 422 };
  db().run("UPDATE owner_items SET status = 'done', proof = ?, done_at = ?, step_n = COALESCE(step_n, NULL) WHERE id = ?", [`${p.kind}: ${p.value}`, now, item]);
  const items = itemsOf(it.goal_id), g = goalById(it.goal_id)!;
  if (items.filter((x) => x.status !== "dropped").every((x) => x.status === "done") && g.status !== "done") { setGoal(g.id, { status: "done", done_at: now }, now); notifyDone(goalById(g.id)!); }
  return db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow;
}
export function goalsView(since = 0) {
  // since bounds the done goals only; open, doing and stuck are always listed
  ensureSchema();
  const gs = db().query("SELECT * FROM owner_goals WHERE dup_of IS NULL AND (status != 'done' OR done_at >= ?) ORDER BY id DESC LIMIT 300").all(since) as GoalRow[];
  // proof lines lose the home and projects prefix: "commit: ab12 /Users/x/projects/app" shows as "commit: ab12 app"
  const short = (p: string | null) => p && p.replace(/(?:\/Users|\/home)\/[^/\s]+\/(?:projects\/)?/g, "");
  return gs.map((g) => ({ ...g, coverage: g.coverage ? JSON.parse(g.coverage) as string[] : [], items: itemsOf(g.id).map((i) => ({ ...i, proof: short(i.proof) })), links: linksOf(g.id) }));
}

// ---------- push to the owner (config/owner-notify.json: {"command": [...], "digest_at": "21:30"}) ----------
export interface NotifyCfg { command: string[]; digest_at: string | null }
export function notifyConfig(): NotifyCfg | null {
  try { const j = JSON.parse(readFileSync(join(dir("config"), "owner-notify.json"), "utf8")) as Record<string, unknown>;
    const cmd = Array.isArray(j.command) ? j.command.map((x) => String(x).replace(/^~(?=\/)/, homedir())) : [];
    return cmd.length ? { command: cmd, digest_at: typeof j.digest_at === "string" && /^\d{2}:\d{2}$/.test(j.digest_at) ? j.digest_at : null } : null;
  } catch { return null; }
}
/** Run the owner's notify command with the Markdown on stdin (no shell, 20 s). True when it exited 0. */
export function runNotify(md: string): boolean {
  const c = notifyConfig(); if (!c) return false;
  try { const p = Bun.spawnSync(c.command, { stdin: new TextEncoder().encode(md), stdout: "ignore", stderr: "pipe", timeout: 20_000 }); if (p.exitCode !== 0) logEvent("warn", "owner notify command failed", { code: p.exitCode, err: new TextDecoder().decode(p.stderr).slice(0, 200) }); return p.exitCode === 0; }
  catch (e) { logEvent("warn", "owner notify command failed", { error: String(e) }); return false; }
}
const pending: { md: string; tries: number }[] = [];
/** Pushes wait for the next tick, so a burst (several goals closing in one minute) goes out as one message. */
export function queueNotify(md: string) { pending.push({ md, tries: 0 }); }
export function flushNotify(): number {
  if (!pending.length) return 0;
  const batch = pending.splice(0), md = batch.map((x) => x.md).join("\n\n");
  if (ownerDeps.send(md)) return batch.length;
  for (const x of batch) if (x.tries < 1) pending.push({ md: x.md, tries: x.tries + 1 }); // one retry on the next tick, never more
  return 0;
}
export const _resetNotify = () => { pending.length = 0; };
const digestFile = () => join(dir("data"), "owner-digest.json");
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** The evening digest: once a day at digest_at (server local time), only when a goal changed that day. Returns the text sent, or null. */
export function digestTick(now = Date.now(), at = notifyConfig()?.digest_at ?? null): string | null {
  if (!at) return null; ensureSchema();
  const d = new Date(now), [h, m] = at.split(":").map(Number) as [number, number];
  if (d.getHours() * 60 + d.getMinutes() < h * 60 + m) return null;
  const day = localDay(now); try { if ((JSON.parse(readFileSync(digestFile(), "utf8")) as { day?: string }).day === day) return null; } catch { /* first */ }
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const touched = (db().query("SELECT COUNT(*) AS n FROM owner_goals WHERE updated_at >= ? AND dup_of IS NULL").get(start.getTime()) as { n: number }).n;
  mkdirSync(dir("data"), { recursive: true }); writeFileSync(digestFile(), JSON.stringify({ day }));
  if (!touched) return null;
  const by = (st: string) => db().query("SELECT * FROM owner_goals WHERE status = ? AND dup_of IS NULL ORDER BY id").all(st) as GoalRow[];
  const doneToday = (db().query("SELECT * FROM owner_goals WHERE status = 'done' AND done_at >= ? ORDER BY done_at").all(start.getTime()) as GoalRow[]);
  const stuck = by("stuck"), doing = by("doing"), open = by("open");
  const line = (g: GoalRow) => { const it = itemsOf(g.id).filter((x) => x.status !== "dropped"); return `- G${g.id} ${clip(g.text, 70)} (${it.filter((x) => x.status === "done").length}/${it.length})`; };
  const md = [`Today: ${doneToday.length} done, ${doing.length} in work, ${stuck.length} stuck, ${open.length} without a job.`,
    ...(stuck.length ? ["", "Stuck:", ...stuck.map(line)] : []), ...(doing.length ? ["", "In work:", ...doing.map(line)] : []), ...(open.length ? ["", "No job yet:", ...open.map(line)] : [])].slice(0, 16).join("\n");
  ownerDeps.send(md); return md;
}

// ---------- the owner's own taps on the Asks page ----------
export function ownerMark(item: number, mark: string, now = Date.now()): ItemRow | Err {
  ensureSchema(); const it = db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow | null; if (!it) return { error: "no such item", status: 404 };
  if (mark !== "wrong" && mark !== "unwanted" && mark !== "clear") return { error: "mark is wrong, unwanted or clear", status: 422 };
  if (mark === "clear") db().run("UPDATE owner_items SET mark = NULL, status = CASE WHEN drop_reason = 'owner: not wanted' THEN 'doing' ELSE status END, drop_reason = CASE WHEN drop_reason = 'owner: not wanted' THEN NULL ELSE drop_reason END WHERE id = ?", [item]);
  else if (mark === "unwanted") db().run("UPDATE owner_items SET mark = 'unwanted', status = 'dropped', drop_reason = 'owner: not wanted' WHERE id = ?", [item]);
  else db().run("UPDATE owner_items SET mark = 'wrong' WHERE id = ?", [item]);
  const g = goalById(it.goal_id)!; setGoal(g.id, {}, now); syncGoal(g.id, now);
  if (mark !== "clear") { toRoot(`The owner marked item ${it.agent ? `${it.agent} step ${it.step_n}` : `#${it.id}`} of G${g.id} as ${mark === "wrong" ? "wrong" : "not wanted"}: ${clip(it.text, 120)}`, `G${g.id}: owner marked an item ${mark}`); learn({ type: "mark", goal: g, text: it.text, about: null, item: it, mark }); }
  return db().query("SELECT * FROM owner_items WHERE id = ?").get(item) as ItemRow;
}
export function ownerMissing(goal: number, text: string, now = Date.now()): ItemRow | Err {
  const g = goalById(goal); if (!g) return { error: "no such goal", status: 404 };
  const t = text.replace(/\s+/g, " ").trim().slice(0, 200); if (!t) return { error: "say what is missing", status: 422 };
  const id = Number(db().run("INSERT INTO owner_items (goal_id, origin, text, status, mark, at) VALUES (?, 'owner', ?, 'open', 'missing', ?)", [goal, t, now]).lastInsertRowid);
  setGoal(goal, g.status === "done" ? { status: linksOf(goal).length ? "doing" : "open", done_at: null } : {}, now);
  toRoot(`The owner says G${goal} misses: ${t}\nAdd a step or a job for it (owner_item_link when a step covers it).`, `G${goal}: owner says something is missing`);
  learn({ type: "mark", goal: g, text: t, about: null, item: null, mark: "missing" });
  return db().query("SELECT * FROM owner_items WHERE id = ?").get(id) as ItemRow;
}
export function ownerHeart(goal: number, now = Date.now()): GoalRow | Err {
  const g = goalById(goal); if (!g) return { error: "no such goal", status: 404 };
  setGoal(goal, { note: clip(`${g.note ? `${g.note} · ` : ""}♥ liked`, 500) }, now);
  learn({ type: "praise", goal: g, text: "liked on the Asks page", about: null });
  return goalById(goal)!;
}

// ---------- the tick ----------
const lastProgress = (g: GoalRow): number => {
  let t = g.level_at ?? g.updated_at;
  for (const l of linksOf(g.id)) { t = Math.max(t, l.at); for (const st of jobOf(l.agent_id, l.job_id)?.steps ?? []) if (st.closedAt != null) t = Math.max(t, st.closedAt); }
  return t;
};
const lastTool = (agentId: string) => { const s = get(agentId); const t = s?.lastTool; return t ? `${t.tool}${t.target ? ` ${clip(t.target, 60)}` : ""}` : "no tool yet"; };
/** Links, items, unlinked pings, the stall ladder and the coverage check. Async only for the coverage call. Pings are stored on the row. */
export async function ownerTick(now = Date.now()): Promise<void> {
  ensureSchema();
  const gs = db().query("SELECT * FROM owner_goals WHERE status IN ('open', 'doing', 'stuck') AND dup_of IS NULL").all() as GoalRow[];
  const unlinked: GoalRow[] = [], first = firstScanAt();
  for (const g0 of gs) {
    syncGoal(g0.id, now); const g = goalById(g0.id)!; if (g.status === "done" || g.status === "dropped") continue;
    const links = linksOf(g.id);
    if (!links.length) { if (!g.unlinked_pinged && now - g.created_at >= UNLINKED_MS && g.created_at >= first) { unlinked.push(g); setGoal(g.id, { unlinked_pinged: 1 }, now); } continue; }
    const live = links.filter((l) => jobOf(l.agent_id, l.job_id)?.closedAt == null);
    if (!live.length) continue;
    // blocked counts only when the agent stopped working after it said so: a hook refusal reported as blocked while tools keep running is not a stall
    const blocked = live.some((l) => { const s = get(l.agent_id), r = s?.reported; return r?.phase === "blocked" && !(s?.lastTool && s.lastTool.at > r.at); });
    const since = lastProgress(g), level = Math.max(Math.min(3, Math.floor((now - since) / STALL_MS)), blocked ? 2 : 0);
    if (level <= g.stuck_level) { if (level === 0 && g.stuck_level) setGoal(g.id, { stuck_level: 0, ...(g.status === "stuck" ? { status: "doing" } : {}) }, now); continue; }
    const mins = Math.round((now - since) / MIN), open = itemsOf(g.id).filter((x) => x.status === "doing" || x.status === "open");
    if (level >= 1 && g.stuck_level < 1) for (const name of new Set(open.map((x) => x.agent).filter(Boolean) as string[]))
      toAgent(name, `Owner goal G${g.id} has had no step closed for ${mins} min. Close a step with proof, or report blocked.`, `G${g.id}: no step for ${mins} min`);
    if (level >= 2 && g.stuck_level < 2)
      toRoot(`Owner goal G${g.id} is stalling (${mins} min${blocked ? ", an agent reported blocked" : ""}): ${clip(g.text, 140)}\n${live.map((l) => `- ${l.agent} job ${l.job_id}, last: ${lastTool(l.agent_id)}`).join("\n")}`, `G${g.id} stalling`);
    if (level >= 3 && g.stuck_level < 3) {
      setGoal(g.id, { status: "stuck" }, now);
      const md = [`⚠️ G${g.id} stuck ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}: ${clip(g.text, 100)}`, ...live.map((l) => `- ${l.agent}, last: ${lastTool(l.agent_id)}`)].join("\n");
      try { ownerDeps.notify("stuck", goalById(g.id)!, md); } catch (e) { logEvent("warn", "owner notify failed", { error: String(e) }); }
    }
    setGoal(g.id, { stuck_level: level }, now);
  }
  if (unlinked.length) toRoot(`${unlinked.length} owner goal${unlinked.length > 1 ? "s have" : " has"} had no job for 30 min. Spawn or job_open with a line \`Goal: G<n>\` in the brief, or drop it (owner_goal_drop).\n${unlinked.map((g) => `- G${g.id}: ${clip(g.text, 140)}`).join("\n")}`, `owner goals: ${unlinked.length} without a job`);
  await coverageTick(now);
  flushNotify(); digestTick(now);
}
/** One coverage call per goal once it has items from a job (again when a second job links within 2 h). */
export async function coverageTick(now = Date.now()) {
  const cap = ownerConfig()?.daily_token_cap ?? DEFAULT_CAP;
  const gs = db().query("SELECT * FROM owner_goals WHERE status IN ('doing', 'stuck') AND dup_of IS NULL").all() as GoalRow[];
  for (const g of gs) {
    // his words = the goal plus his own items (explicit list, follow-ups, "missing"); compared with the items root's briefs made
    const live = itemsOf(g.id).filter((x) => x.status !== "dropped" && x.mark !== "unwanted"), items = live.filter((x) => x.origin === "brief"), links = linksOf(g.id);
    if (!links.length || !items.length) continue;
    const words = [g.text, ...live.filter((x) => x.origin === "owner").map((x) => x.text)].join("\n");
    const newest = Math.max(...links.map((l) => l.at));
    if (g.coverage_at != null && (g.coverage_at >= newest || newest - links[0]!.at > 2 * 3_600_000)) continue;
    if (tokensToday(now) >= cap) { overBudget(now); return; }
    const r = await ownerDeps.model(COVERAGE, `Owner's words:\n${redactText(words).slice(0, TEXT_CAP)}\n\nItems:\n${items.map((x) => `- ${x.text}`).join("\n")}`);
    db().run("INSERT OR IGNORE INTO owner_msgs (source, msg_id, ts, text, kind, goal_id, tokens, at) VALUES ('coverage', ?, ?, '', 'coverage', ?, ?, ?)", [`G${g.id}@${now}`, now, g.id, r?.tokens ?? 0, now]);
    const j = r ? jsonOf(r.text) : null, unc = (Array.isArray(j?.uncovered) ? j!.uncovered as unknown[] : []).map((x) => clip(String(x), 120)).filter(Boolean).slice(0, 8);
    setGoal(g.id, { coverage: JSON.stringify(unc), coverage_at: now }, now);
    if (unc.length) toRoot(`Owner goal G${g.id}: no item covers ${unc.map((x) => `"${x}"`).join(", ")}. Add a step or a job, or tell the owner why not.`, `G${g.id}: not covered`);
  }
}
let scanning = false;
/** Read new owner messages and ingest them one by one (one model call at a time). */
export async function scanTick(now = Date.now()) {
  if (scanning) return; scanning = true;
  try { const cfg = ownerConfig(); if (!cfg) return; for (const m of scanFiles(cfg, now)) await ingest(m, cfg, now); } finally { scanning = false; }
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startOwnerTimer() {
  if (timer || !ownerAsksOn()) return;
  timer = setInterval(() => { void (async () => { try { await scanTick(); await ownerTick(); } catch (e) { logEvent("warn", "owner tick failed", { error: String(e) }); } })(); }, 60_000); timer.unref?.();
}
