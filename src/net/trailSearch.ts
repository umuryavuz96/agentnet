// One search for every caller (agent tool trail_search, auto-inject on new work, the panel Search tab):
// the FTS5 trail index first (decision notes + Entire), then cass session hits fill up to the limit.
// cass is a separate binary (v0.11.0, ~/.local/bin/cass, index in var/data/cass); see docs/research/trail-tools-vetting.md.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { db } from "../core/db";
import { ROOT } from "../core/config";
import { cleanPrompt, firstPrompt, format, inject, reindex, search, terms, type InjectResult, type Resolver, type TrailHit } from "./trails";

export const CASS_BIN = process.env.CASS_BIN ?? join(homedir(), ".local", "bin", "cass");
export const cassDataDir = () => join(ROOT, "data", "cass");
/** cass loads a .env from its cwd and parents (dotenvy): run it from a dir outside ~ so ~/.env never enters its process. */
const CASS_CWD = "/private/tmp/cass-cwd";
const CASS_TIMEOUT_MS = 2500, CACHE_MS = 120_000, CACHE_MAX = 50;
/** cass is a fresh process per query (~0.7 s, ~1.5 GB RSS): one at a time, and repeats within 2 minutes come from a cache. */
let lane: Promise<unknown> = Promise.resolve();
const cache = new Map<string, { at: number; hits: TrailHit[] }>();
export const cassReady = () => existsSync(CASS_BIN) && existsSync(cassDataDir());

/** Entire / Claude session id → agentnet agent name, from the AgentConnected events the mod posts at hello. */
export function agentOfSession(session: string): string {
  if (!/^[0-9a-f-]{36}$/.test(session)) return "";
  try {
    const r = db().query("SELECT a.name FROM agent_events e JOIN agents a ON a.id = e.agent_id WHERE e.type = 'AgentConnected' AND json_extract(e.data, '$.session') = ? ORDER BY e.seq DESC LIMIT 1").get(session) as { name: string } | null;
    return r?.name ?? "";
  } catch { return ""; }
}

/** Commit → agent from the agentnet event log, loaded once per reindex (and only when a new commit needs it).
 *  First choice: the agent with a Bash call running at the commit time (finish ts minus its duration, ±2 s); when several,
 *  the one whose command mentions "commit", then the one with most edits on the commit's files. The command text is clipped
 *  to 80 characters in the log, so a long `... && git commit` line is matched by time, not by text.
 *  Else: the agent that edited (Edit/Write) most of the commit's files in the 24 h before it. */
export function makeResolver(): Resolver {
  let ev: { name: string; ts: number; ms: number; tool: string; target: string }[] | null = null;
  const load = () => ev ??= (() => { try {
    return (db().query(`SELECT a.name AS name, e.ts AS ts, COALESCE(json_extract(e.data, '$.ms'), 0) AS ms, json_extract(e.data, '$.tool') AS tool, json_extract(e.data, '$.target') AS target
      FROM agent_events e JOIN agents a ON a.id = e.agent_id
      WHERE e.type = 'ToolFinished' AND e.ts > ? AND json_extract(e.data, '$.tool') IN ('Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')`).all(Date.now() - 60 * 86400_000) as { name: string; ts: number; ms: number; tool: string; target: string | null }[])
      .map((x) => ({ ...x, target: x.target ?? "" }));
  } catch { return []; } })();
  return {
    session: agentOfSession,
    commit(repo, at, files) {
      const e = load(); if (!e.length) return "";
      const abs = new Set(files.map((f) => join(repo, f))), votes = new Map<string, number>();
      for (const x of e) if (x.tool !== "Bash" && x.ts <= at + 2000 && x.ts >= at - 86400_000 && abs.has(x.target)) votes.set(x.name, (votes.get(x.name) ?? 0) + 1);
      // commit time has 1 s resolution: `at` may be up to 1 s before the real moment
      const running = e.filter((x) => x.tool === "Bash" && x.ts - x.ms - 2000 <= at && at <= x.ts + 2000);
      const names = [...new Set(running.map((x) => x.name))];
      if (names.length === 1) return names[0]!;
      if (names.length > 1) {
        const byText = [...new Set(running.filter((x) => /\bcommit\b/.test(x.target)).map((x) => x.name))];
        if (byText.length === 1) return byText[0]!;
        const pool = byText.length ? byText : names;
        return pool.sort((a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0))[0]!;
      }
      return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    },
  };
}

/** cass titles a session by its first message, which for agents is the mod's note: use the first real prompt instead (cached per file). */
const titles = new Map<string, string>();
const titleOf = (src: string, fallback: string) => {
  if (!titles.has(src)) { titles.set(src, firstPrompt(src).split("\n").find((l) => l.trim())?.slice(0, 160) ?? ""); if (titles.size > 2000) titles.delete(titles.keys().next().value!); }
  return titles.get(src) || cleanPrompt(fallback).split("\n")[0]!.slice(0, 160);
};
/** cass snippets are HTML-escaped with **bold** marks around matches. */
const plain = (t: string) => t.replace(/\*\*/g, "").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

interface CassHit { title?: string; snippet?: string; content?: string; score?: number; source_path?: string; workspace?: string; created_at?: number; line_number?: number }
/** cass lexical search; [] when the binary or index is missing, on timeout or on bad output. */
export async function cassSearch(query: string, n: number, repo?: string): Promise<TrailHit[]> {
  if (n <= 0 || !cassReady()) return [];
  const ts = terms(query); if (!ts.length) return [];
  const key = `${ts.join(" ")}|${n}|${repo ?? ""}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hits;
  const run = lane.then(() => cassRun(ts, n, repo)); lane = run.catch(() => []);
  const hits = await run;
  cache.set(key, { at: Date.now(), hits }); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return hits;
}
async function cassRun(ts: string[], n: number, repo?: string): Promise<TrailHit[]> {
  mkdirSync(CASS_CWD, { recursive: true });
  const args = [CASS_BIN, "search", ts.join(" OR "), "--json", "--limit", String(Math.max(20, n * 8)), "--mode", "lexical", "--no-daemon", "--no-maintenance",
    "--fields", "title,snippet,score,source_path,workspace,created_at,line_number", "--max-content-length", "300", "--data-dir", cassDataDir()];
  if (repo) args.push("--workspace", repo);
  const p = Bun.spawn(args, { cwd: CASS_CWD, stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir(), CASS_SKIP_UPDATE: "1", CODING_AGENT_SEARCH_NO_UPDATE_PROMPT: "1", NO_COLOR: "1" } });
  const timer = setTimeout(() => p.kill(), CASS_TIMEOUT_MS);
  try {
    const out = await new Response(p.stdout).text(); await p.exited;
    const hits = (JSON.parse(out) as { hits?: CassHit[] }).hits ?? [];
    const seen = new Set<string>(), res: TrailHit[] = [];
    for (const h of hits) {
      const src = h.source_path ?? ""; if (!src || seen.has(src)) continue; seen.add(src); // one hit per session
      const snippet = plain(h.snippet ?? "").slice(0, 300), title = titleOf(src, plain(h.title ?? "")) || snippet.slice(0, 120);
      const low = `${title} ${snippet}`.toLowerCase();
      res.push({ id: `cass:${basename(src)}:${h.line_number ?? 0}`, kind: "cass", repo: h.workspace ?? "", date: h.created_at ? new Date(h.created_at).toISOString().slice(0, 10) : "",
        agent: agentOfSession(basename(src, ".jsonl")), title, files: [], snippet,
        checkpoint: "", commit: "", score: -(h.score ?? 0), matched: ts.filter((t) => low.includes(t)).length });
      if (res.length >= n) break;
    }
    return res;
  } catch { return []; } finally { clearTimeout(timer); }
}

export interface SearchOpts { repo?: string; limit?: number; max?: number; cass?: boolean; fts?: boolean }
/** FTS5 hits first, then cass fills up to `limit` (capped at `max`, default 3). `text` is the compact model block. */
export async function trailSearch(query: string, o: SearchOpts = {}): Promise<{ hits: TrailHit[]; text: string }> {
  try { reindex(makeResolver()); } catch { /* search the index as it is */ }
  const limit = Math.max(1, Math.min(o.max ?? 3, o.limit ?? 3));
  const hits = o.fts === false ? [] : search(query, { repo: o.repo, limit, max: o.max });
  if (o.cass !== false && hits.length < limit) hits.push(...await cassSearch(query, limit - hits.length, o.repo));
  return { hits, text: format(hits) };
}
export const trailInject = (agent: string, source: "spawn" | "task_add" | "task_msg", text: string, repo?: string, since = 0): Promise<InjectResult> =>
  inject(agent, source, text, repo, makeResolver(), cassSearch, since);
