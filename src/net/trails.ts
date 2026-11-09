// Agent trails: a small SQLite FTS5 index (own file var/data/trails.db, never the live Server OS DB) over
// (a) decision notes agents leave at task_done / report done (var/trails/*.md) and
// (b) Entire checkpoints (refs/entire/checkpoints/*, local only) plus Entire sessions that never got a commit.
// Only prompts, file paths, ids and agent-written notes are indexed: no transcripts, no tool outputs.
// Reindex is lazy and incremental (on search, at most every REINDEX_MS), so no cron or daemon is needed.
// Design: docs/research/trail-tools-vetting.md, root approval agentnet #115 ("go fts5"), auto-inject #116.
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ROOT } from "../core/config";

export interface TrailHit { id: string; kind: "note" | "commit" | "checkpoint" | "session" | "cass"; repo: string; date: string; agent: string; title: string; files: string[]; snippet: string; checkpoint: string; commit: string; score: number; matched: number }
export interface TrailConfig { repos: string[]; inject: boolean; off_agents: string[]; min_terms: number; min_ratio: number }
export interface Decision { chosen: string; rejected?: string; why?: string }
export interface NoteFields { goal?: string; decisions?: (Decision | string)[] | string; files?: string[] | string; gotchas?: string[] | string; result?: string }

const HOME = homedir();
const INDEX_VERSION = "5", REINDEX_MS = 60_000, PROMPT_MAX = 600, OUT_MAX = 1500, MAX_HITS = 3;
const STOP = new Set("the and for with that this from into your you are was were have has had not but all any can our out via per its it's then than them they what when where which who why how let get got also just only more most some such each very will would should could about after before over under onto off".split(" "));

export const trailsDir = () => join(ROOT, "trails");
const dbFile = () => join(ROOT, "data", "trails.db");
const configFile = () => join(ROOT, "config", "trails.json");
export const injectLog = () => join(ROOT, "logs", "trail-inject.jsonl");
const tilde = (p: string) => (p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

/** var/config/trails.json, read on each call (the A/B harness flips `inject` / `off_agents` without a restart). */
export function trailConfig(): TrailConfig {
  const d: TrailConfig = { repos: process.env.TRAILS_DEFAULT_REPO ? [process.env.TRAILS_DEFAULT_REPO] : [], inject: true, off_agents: [], min_terms: 2, min_ratio: 0.25 };
  try { const j = JSON.parse(readFileSync(configFile(), "utf8")) as Partial<TrailConfig>; Object.assign(d, j); } catch { /* defaults */ }
  d.repos = d.repos.map(tilde);
  if (process.env.AGENTNET_TRAIL_INJECT === "0") d.inject = false;
  return d;
}

let handle: Database | null = null, lastIndex = 0;
/** Tests point this at :memory:. */
export function useTrailDb(d: Database | null) { handle = d; lastIndex = 0; if (d) init(d); }
function tdb(): Database {
  if (handle) return handle;
  mkdirSync(join(ROOT, "data"), { recursive: true });
  handle = new Database(dbFile(), { create: true }); init(handle); return handle;
}
function init(d: Database) {
  d.run("PRAGMA journal_mode = WAL");
  d.run(`CREATE VIRTUAL TABLE IF NOT EXISTS trail_fts USING fts5(id UNINDEXED, kind UNINDEXED, repo UNINDEXED, date UNINDEXED, agent UNINDEXED,
    checkpoint UNINDEXED, commit_sha UNINDEXED, title, files, body, tokenize = 'porter unicode61')`);
  d.run("CREATE TABLE IF NOT EXISTS trail_src (id TEXT PRIMARY KEY, key TEXT NOT NULL)");
  // The index is derived data: when the way documents are built changes, bump INDEX_VERSION and it rebuilds from the sources.
  if ((d.query("SELECT key FROM trail_src WHERE id = '__version'").get() as { key: string } | null)?.key !== INDEX_VERSION) {
    d.run("DELETE FROM trail_fts"); d.run("DELETE FROM trail_src");
    d.run("INSERT INTO trail_src (id, key) VALUES ('__version', ?)", [INDEX_VERSION]);
  }
}
interface Doc { id: string; kind: TrailHit["kind"]; repo: string; date: string; agent: string; checkpoint: string; commit: string; title: string; files: string[]; body: string }
function upsert(d: Database, doc: Doc, key: string) {
  const prev = d.query("SELECT key FROM trail_src WHERE id = ?").get(doc.id) as { key: string } | null;
  if (prev?.key === key) return false;
  d.run("DELETE FROM trail_fts WHERE id = ?", [doc.id]);
  d.run("INSERT INTO trail_fts (id, kind, repo, date, agent, checkpoint, commit_sha, title, files, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [doc.id, doc.kind, doc.repo, doc.date, doc.agent, doc.checkpoint, doc.commit, doc.title, doc.files.join("\n"), doc.body]);
  d.run("INSERT INTO trail_src (id, key) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET key = excluded.key", [doc.id, key]);
  return true;
}
const known = (d: Database, id: string, key: string) => (d.query("SELECT key FROM trail_src WHERE id = ?").get(id) as { key: string } | null)?.key === key;

// ---------- decision notes ----------
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split("\n") : []).map((x) => (typeof x === "string" ? x : JSON.stringify(x)).replace(/^\s*-\s*/, "").trim()).filter(Boolean);
const decisionLine = (x: Decision | string) => typeof x === "string" ? x : [`chose ${x.chosen}`, x.rejected ? `over ${x.rejected}` : "", x.why ? `because ${x.why}` : ""].filter(Boolean).join(" ");
export const hasNoteFields = (b: Record<string, unknown>) => ["goal", "decisions", "files", "gotchas", "result"].some((k) => b[k] != null && b[k] !== "" && !(Array.isArray(b[k]) && !(b[k] as unknown[]).length));
const oneLine = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
/** Writes var/trails/<date>-<agent>-<slug>.md and indexes it at once. Returns the file path. */
export function writeNote(meta: { agent: string; task: string; repo: string | null }, f: NoteFields, now = new Date()) {
  mkdirSync(trailsDir(), { recursive: true });
  const date = now.toISOString().slice(0, 10), slug = meta.task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  let file = join(trailsDir(), `${date}-${meta.agent}-${slug}.md`);
  for (let i = 2; existsSync(file); i++) file = join(trailsDir(), `${date}-${meta.agent}-${slug}-${i}.md`);
  const decisions = (Array.isArray(f.decisions) ? f.decisions : list(f.decisions)).map(decisionLine).map((s) => oneLine(s, 400)).filter(Boolean);
  const sec = (h: string, items: string[]) => (items.length ? `\n## ${h}\n${items.map((x) => `- ${x}`).join("\n")}\n` : "");
  const md = `---\nagent: ${oneLine(meta.agent, 40)}\ntask: ${oneLine(meta.task, 200)}\nrepo: ${oneLine(meta.repo ?? "", 200)}\ndate: ${now.toISOString()}\n---\n`
    + (f.goal ? `\n## Goal\n${oneLine(f.goal, 600)}\n` : "") + sec("Decisions", decisions) + sec("Files", list(f.files).map((s) => oneLine(s, 200)))
    + sec("Gotchas", list(f.gotchas).map((s) => oneLine(s, 400))) + (f.result ? `\n## Result\n${oneLine(f.result, 600)}\n` : "");
  writeFileSync(file, md);
  try { indexNote(tdb(), file); } catch { /* the next search picks it up */ }
  return file;
}
export function parseNote(md: string) {
  const fm: Record<string, string> = {}, m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (m) for (const l of m[1]!.split("\n")) { const i = l.indexOf(":"); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  const body = m ? md.slice(m[0].length) : md;
  const files = (/## Files\n([\s\S]*?)(?:\n## |\s*$)/.exec(body)?.[1] ?? "").split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  return { fm, body, files };
}
function indexNote(d: Database, file: string) {
  const st = statSync(file), id = `note:${basename(file)}`, key = `${st.mtimeMs}:${st.size}`;
  if (known(d, id, key)) return;
  const { fm, body, files } = parseNote(readFileSync(file, "utf8"));
  upsert(d, { id, kind: "note", repo: fm.repo ?? "", date: (fm.date ?? "").slice(0, 10), agent: fm.agent ?? "", checkpoint: "", commit: "", title: fm.task ?? basename(file), files, body: body.replace(/^## /gm, "").trim() }, key);
}

// ---------- Entire ----------
/** Agentnet boilerplate that says nothing about the work: the boot line, the task-list rule, delivery lines, the mod note. */
const NOISE = [/^You are [a-z0-9-]+ on the agentnet\b/i, /^#\d+ \[[a-z]+\] /, /^agentnet: \d+ messages/, /PRIORITY RULE: task management/, /^Messages from other agents arrive/, /^\[(Voice|Chat)/];
/** The prompt without boilerplate lines (delivery lines keep their quoted subject, which names the work). */
export function cleanPrompt(p: string) {
  return p.split("\n").map((l) => { const m = /^#\d+ \[[a-z]+\] [a-z0-9@-]+: "(.*)"$/.exec(l.trim()); return m ? m[1]! : NOISE.some((r) => r.test(l.trim())) ? "" : l.replace(/^\s*You are [a-z0-9-]+(?: for [^.]+)?\.\s*Boss: [a-z0-9-]+\.\s*(?:Teammates?: [^.]*\.\s*)?(?:Job:\s*)?/i, ""); }).filter((l) => l.trim()).join("\n");
}
const git = (repo: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "ignore" }); return r.exitCode === 0 ? r.stdout.toString() : ""; };
const jsonOr = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
/** Who did a piece of work. `session`: Entire / Claude session id → agentnet agent. `commit`: the agent that ran `git commit`
 *  in this repo right at the commit time, else the one that edited most of its files in the 24 h before (agentnet event log).
 *  Entire alone is not enough: with two agents in one worktree it links a commit to whichever session is open. */
export interface Resolver { session(id: string): string; commit(repo: string, atMs: number, files: string[]): string }
export const noResolver: Resolver = { session: () => "", commit: () => "" };
const COMMITS_MAX = 3000;
const TRAILER = /^(Co-Authored-By|Entire-[A-Za-z]+|Signed-off-by):/i;
interface Cp { cp: string; sha: string; date: string; prompts: string[]; sessions: string[]; files: string[] }
function readCp(repo: string, ref: string, sha: string): Cp {
  const cp = ref.split("/").pop()!;
  const meta = jsonOr<{ files_touched?: string[]; sessions?: { metadata?: string; prompt?: string }[] }>(git(repo, "show", `${ref}:metadata.json`), {});
  const out: Cp = { cp, sha, date: "", prompts: [], sessions: [], files: meta.files_touched ?? [] };
  for (const s of meta.sessions ?? []) {
    const sm = jsonOr<{ session_id?: string; created_at?: string }>(s.metadata ? git(repo, "show", `${ref}:${s.metadata.replace(/^\//, "")}`) : "", {});
    if (sm.session_id) out.sessions.push(sm.session_id);
    out.date ||= (sm.created_at ?? "").slice(0, 10);
    if (s.prompt) { const p = cleanPrompt(git(repo, "show", `${ref}:${s.prompt.replace(/^\//, "")}`)).slice(0, PROMPT_MAX); if (p) out.prompts.push(p); }
  }
  return out;
}
function indexRepo(d: Database, repo: string, r: Resolver) {
  if (!existsSync(join(repo, ".git"))) return;
  const refs = new Map(git(repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/entire/checkpoints/").trim().split("\n").filter(Boolean)
    .map((l) => { const [sha, ref] = l.split(" "); return [ref!.split("/").pop()!, { sha: sha!, ref: ref! }] as const; }));
  const cps = new Map<string, Cp>(), cpOf = (id: string) => { const x = refs.get(id); if (!x) return null; if (!cps.has(id)) cps.set(id, readCp(repo, x.ref, x.sha)); return cps.get(id)!; };
  const sessionsWithCp = new Set<string>(), usedCp = new Set<string>();
  // 1. Git history: one doc per commit on any branch. Title = commit subject; body = message + the checkpoint prompt.
  const log = git(repo, "log", "--branches", "-n", String(COMMITS_MAX), "--name-only", "--format=%x1e%h%x1f%ct%x1f%s%x1f%b%x1f%(trailers:key=Entire-Checkpoint,valueonly,separator=%x2C)%x1f");
  for (const rec of log.split("\x1e").slice(1)) {
    const [h, ct, subject, rawBody, trailers, rest] = rec.split("\x1f") as [string, string, string, string, string, string];
    const cpIds = trailers.split(",").map((x) => x.trim()).filter((x) => refs.has(x));
    for (const id of cpIds) usedCp.add(id);
    const id = `commit:${h}`, key = `${h}:${cpIds.map((c) => refs.get(c)!.sha).join(",")}`;
    if (known(d, id, key)) { for (const s of (d.query("SELECT body FROM trail_fts WHERE id = ?").get(id) as { body: string } | null)?.body.matchAll(/session:(\S+)/g) ?? []) sessionsWithCp.add(s[1]!); continue; }
    const files = (rest ?? "").split("\n").map((x) => x.trim()).filter(Boolean), at = Number(ct) * 1000;
    const body = rawBody.split("\n").filter((l) => !TRAILER.test(l.trim())).join("\n").trim();
    const cp = cpIds.map(cpOf).filter((x): x is Cp => !!x);
    for (const c of cp) for (const s of c.sessions) sessionsWithCp.add(s);
    const agent = r.commit(repo, at, files) || cp.flatMap((c) => c.sessions).map((s) => r.session(s)).find(Boolean) || "";
    upsert(d, { id, kind: cp.length ? "checkpoint" : "commit", repo, date: new Date(at).toISOString().slice(0, 10), agent, checkpoint: cp[0]?.cp ?? "", commit: h,
      title: subject.slice(0, 160), files, body: `${body}\n${cp.flatMap((c) => c.prompts).join("\n")}\n${cp.flatMap((c) => c.sessions).map((s) => `session:${s}`).join(" ")}`.trim() }, key);
  }
  // 2. Checkpoints with no commit on a branch (amended away, or on a deleted branch): titled by their prompt.
  for (const [cpId, x] of refs) {
    if (usedCp.has(cpId)) { d.run("DELETE FROM trail_fts WHERE id = ?", [`cp:${cpId}`]); d.run("DELETE FROM trail_src WHERE id = ?", [`cp:${cpId}`]); continue; }
    const id = `cp:${cpId}`; if (known(d, id, x.sha)) continue;
    const c = cpOf(cpId)!; for (const s of c.sessions) sessionsWithCp.add(s);
    const title = (c.prompts[0] ?? "").split("\n").find((l) => l.trim())?.slice(0, 160) ?? `(no prompt) ${c.files.slice(0, 2).join(", ")}`;
    upsert(d, { id, kind: "checkpoint", repo, date: c.date, agent: c.sessions.map((s) => r.session(s)).find(Boolean) ?? "", checkpoint: cpId, commit: "", title, files: c.files, body: `${c.prompts.join("\n")}\n${c.sessions.map((s) => `session:${s}`).join(" ")}` }, x.sha);
  }
  // 3. Sessions that touched files but never reached a commit: files + first prompt only (read from the transcript's first user line).
  const sdir = join(repo, ".git", "entire-sessions");
  if (!existsSync(sdir)) return;
  for (const f of readdirSync(sdir).filter((x) => /^[0-9a-f-]{36}\.json$/.test(x))) {
    const st = statSync(join(sdir, f)), id = `session:${f.slice(0, 36)}`, key = `${st.mtimeMs}`;
    if (sessionsWithCp.has(f.slice(0, 36))) { d.run("DELETE FROM trail_fts WHERE id = ?", [id]); d.run("DELETE FROM trail_src WHERE id = ?", [id]); continue; }
    if (known(d, id, key)) continue;
    const s = jsonOr<{ session_id?: string; started_at?: string; files_touched?: string[]; transcript_path?: string }>(readFileSync(join(sdir, f), "utf8"), {});
    if (!s.files_touched?.length) continue;
    const prompt = firstPrompt(s.transcript_path);
    upsert(d, { id, kind: "session", repo, date: (s.started_at ?? "").slice(0, 10), agent: r.session(s.session_id ?? ""), checkpoint: "", commit: "", title: prompt.split("\n")[0]!.slice(0, 160) || "(session, no commit)", files: s.files_touched, body: prompt }, key);
  }
}
/** First real user prompt of a Claude Code JSONL transcript (boilerplate, hook and tag lines skipped), cut to PROMPT_MAX. Reads only the head. */
export function firstPrompt(path?: string): string {
  if (!path || !existsSync(path)) return "";
  try {
    const head = readFileSync(path, "utf8").slice(0, 200_000);
    for (const line of head.split("\n")) {
      const j = jsonOr<{ type?: string; message?: { content?: unknown } }>(line, {});
      if (j.type !== "user") continue;
      const c = j.message?.content, t = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x: { type?: string }) => x?.type === "text") as { text?: string } | undefined)?.text ?? "" : "";
      const c2 = t.trim().startsWith("<") ? "" : cleanPrompt(t);
      if (c2.trim()) return c2.slice(0, PROMPT_MAX);
    }
  } catch { /* unreadable */ }
  return "";
}

/** Incremental: notes by mtime, checkpoints by ref sha, sessions by mtime. `force` skips the REINDEX_MS gate. */
export function reindex(r: Resolver = noResolver, force = false) {
  const now = Date.now(); if (!force && now - lastIndex < REINDEX_MS) return; lastIndex = now;
  const d = tdb();
  d.transaction(() => {
    if (existsSync(trailsDir())) for (const f of readdirSync(trailsDir()).filter((x) => x.endsWith(".md"))) indexNote(d, join(trailsDir(), f));
    for (const repo of trailConfig().repos) indexRepo(d, repo, r);
  })();
}

// ---------- search ----------
export const terms = (q: string) => [...new Set((q.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? []).map((t) => t.replace(/[._-]+$/, "")).filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)))].slice(0, 16);
const exists = (repo: string, f: string) => existsSync(isAbsolute(f) ? f : resolve(repo || ".", f));
/** Top hits by BM25 (title x3, files x2, body x1). Files that no longer exist are dropped; a hit whose files are all gone is hidden. */
export function search(query: string, opts: { repo?: string; limit?: number; max?: number } = {}): TrailHit[] {
  const ts = terms(query); if (!ts.length) return [];
  const limit = Math.max(1, Math.min(opts.max ?? MAX_HITS, opts.limit ?? MAX_HITS));
  const repo = opts.repo ? resolve(tilde(opts.repo)) : "";
  const match = ts.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
  const rows = tdb().query(`SELECT id, kind, repo, date, agent, checkpoint, commit_sha, title, files, body,
      snippet(trail_fts, 9, '', '', '…', 20) AS snip, bm25(trail_fts, 0, 0, 0, 0, 0, 0, 0, 3.0, 2.0, 1.0) AS score
    FROM trail_fts WHERE trail_fts MATCH ? ${repo ? "AND (repo = ? OR repo = '')" : ""} ORDER BY score LIMIT 30`).all(...(repo ? [match, repo] : [match])) as Record<string, string | number>[];
  const out: TrailHit[] = [];
  for (const r of rows) {
    const all = String(r.files).split("\n").filter(Boolean), files = all.filter((f) => exists(String(r.repo), f));
    if (all.length && !files.length) continue;
    const hay = `${r.title}\n${r.files}\n${r.body}`.toLowerCase(), matched = ts.filter((t) => hay.includes(t)).length;
    out.push({ id: String(r.id), kind: r.kind as TrailHit["kind"], repo: String(r.repo), date: String(r.date), agent: String(r.agent), title: String(r.title), files, snippet: String(r.snip).replace(/session:\S+/g, "").replace(/\s+/g, " ").trim(), checkpoint: String(r.checkpoint), commit: String(r.commit_sha), score: Number(r.score), matched });
    if (out.length >= limit) break;
  }
  return out;
}
/** Compact text for the model: at most 3 hits, OUT_MAX chars (~400 tokens). */
export function format(hits: TrailHit[], label = "Past trails"): string {
  if (!hits.length) return "";
  const lines = [`${label} (may be stale, verify):`];
  hits.forEach((h, i) => {
    const files = h.files.slice(0, 4).map((f) => f.replace(`${h.repo}/`, "")).join(", ") + (h.files.length > 4 ? ` (+${h.files.length - 4})` : "");
    const ref = [h.checkpoint && `checkpoint ${h.checkpoint}`, h.commit && `commit ${h.commit}`].filter(Boolean).join(" ");
    lines.push(`[${i + 1}] ${h.date || "?"} ${h.agent || "?"} · ${h.kind}: ${h.title.replace(/\s+/g, " ").slice(0, 110)}`);
    if (files) lines.push(`  files: ${files}`);
    if (h.snippet && !h.title.includes(h.snippet.replace(/…/g, "").trim().slice(0, 40))) lines.push(`  > ${h.snippet.slice(0, 220)}`);
    if (ref) lines.push(`  ${ref}`);
  });
  let s = lines.join("\n");
  if (s.length > OUT_MAX) s = s.slice(0, OUT_MAX - 1) + "…";
  return s;
}

// ---------- auto-inject on new work ----------
/** One line per trail use in the shared log: an auto-inject (source spawn/task_add/task_msg) or an agent's own trail_search call (source trail_search, with ms). */
export function logTrail(row: { agent: string; source: string; query: string; terms?: number; hits: TrailHit[]; chars?: number; skipped?: string | null; ms?: number }) {
  try {
    mkdirSync(join(ROOT, "logs"), { recursive: true });
    const files = [...new Set(row.hits.flatMap((h) => h.files ?? []))].slice(0, 30);
    appendFileSync(injectLog(), JSON.stringify({ ts: new Date().toISOString(), agent: row.agent, source: row.source, query: row.query.slice(0, 300), terms: row.terms ?? null, hits: row.hits.map((h) => h.id), files, chars: row.chars ?? null, skipped: row.skipped ?? null, ms: row.ms ?? null }) + "\n");
  } catch { /* logging never blocks delivery */ }
}
export interface InjectResult { text: string; hits: TrailHit[]; skipped?: string }
/** Search the new-work text; return a block only when injection is on for this agent and the best hit clears the bar. Every call is logged. */
/** `more` fills up to 3 from a second source (cass) after the FTS5 hits; its hits must clear the same bar. */
export type More = (query: string, n: number, repo?: string) => Promise<TrailHit[]>;
/** `since` = the agent's spawn time: its own hits from this spawn are its current work, not a past trail. */
export async function inject(agent: string, source: "spawn" | "task_add" | "task_msg", text: string, repo?: string, resolver?: Resolver, more?: More, since = 0): Promise<InjectResult> {
  const cfg = trailConfig(), ts = terms(text);
  let res: InjectResult;
  if (!cfg.inject) res = { text: "", hits: [], skipped: "off" };
  else if (cfg.off_agents.includes(agent)) res = { text: "", hits: [], skipped: "control" };
  else {
    try { reindex(resolver); } catch { /* search the index as it is */ }
    const need = Math.max(cfg.min_terms, Math.ceil(ts.length * cfg.min_ratio));
    const day = since ? new Date(since).toISOString().slice(0, 10) : "", past = (h: TrailHit) => h.matched >= need && !(h.agent === agent && day && h.date >= day);
    const hits = search(text, { repo, limit: 10, max: 10 }).filter(past).slice(0, MAX_HITS);
    if (more && hits.length < MAX_HITS) { try { hits.push(...(await more(text, MAX_HITS - hits.length + 2, repo)).filter(past).slice(0, MAX_HITS - hits.length)); } catch { /* FTS5 hits alone */ } }
    res = hits.length ? { text: format(hits), hits } : { text: "", hits: [], skipped: "no hit above threshold" };
  }
  logTrail({ agent, source, query: text, terms: ts.length, hits: res.hits, chars: res.text.length, skipped: res.skipped });
  return res;
}
