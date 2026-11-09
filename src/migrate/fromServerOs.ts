// Copy a Server OS var/ folder into an agentnet home. Read-only on the source (bun:sqlite {readonly:true} handles only).
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { useDatabase } from "../core/db";
import * as store from "../net/store";
import { bumpSeq, columns, copyRows, count, maxOf, seqOf } from "./copy";

export const TABLES = ["agents", "agent_events", "agent_status", "messages", "teams", "team_members", "team_tasks"] as const;
export const SEQ_TABLES = ["agent_events", "messages", "team_tasks"] as const;

export interface MigrateOptions {
  source: string;          // a Server OS var folder: holds data/server-os.db
  to: string;              // an agentnet home folder
  dryRun: boolean;         // true: `to` must be a fresh temp folder; nothing outside `to` is written
  members: string[];       // agent names to mark kind='member' (default ["root"])
  now?: number;
}
export interface Marks {
  at: number; source: string; sourceDb: string;
  maxSeq: number; maxMsgId: number; maxTeamTaskId: number; scoresMaxId: number;
  counts: Record<string, number>;   // per table in TABLES, plus "agent_scores" and "trails"
}
export interface MigrateReport {
  marks: Marks;
  counts: Record<string, { source: number; target: number }>;
  fold: { agents: number; differ: string[] };   // agent ids whose rebuilt fold differs from the copied agent_status
  copied: string[];                             // files and links copied, relative to `to`
  skipped: string[];                            // things not found in the source (not an error)
  ok: boolean;                                  // counts equal and fold.differ empty
}

/** Pure: reduce() over agent_events ORDER BY seq, like store.rebuild() but without the write-back. */
export function foldOf(d: Database): Map<string, unknown> {
  const out = new Map<string, store.Snapshot>();
  const rows = d.query("SELECT seq, agent_id, v, type, ts, source, data FROM agent_events ORDER BY seq").all() as { seq: number; agent_id: string; v: number; type: string; ts: number; source: store.Source; data: string }[];
  for (const r of rows) {
    const n = store.reduce(out.get(r.agent_id) ?? null, { type: r.type, ts: r.ts, data: JSON.parse(r.data), source: r.source });
    if (n) { n.seq = r.seq; n.v = r.v; out.set(r.agent_id, n); }
  }
  return out;
}

/** Compare each agent_status row of d with the fold of its events (the `window` key is a live probe, so it is ignored). */
export function verifyFold(d: Database): { agents: number; differ: string[] } {
  const want = foldOf(d) as Map<string, Record<string, unknown>>;
  const rows = d.query("SELECT agent_id, json FROM agent_status").all() as { agent_id: string; json: string }[];
  const differ: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.agent_id);
    const have = JSON.parse(r.json) as Record<string, unknown>;
    const w = want.get(r.agent_id);
    if (!w) { differ.push(r.agent_id); continue; }
    const a = { ...have }, b = { ...w };
    delete a.window; delete b.window;
    if (!Bun.deepEquals(a, b)) differ.push(r.agent_id);
  }
  for (const id of want.keys()) if (!seen.has(id)) differ.push(id);
  return { agents: rows.length, differ };
}

const mdFiles = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")) : []);

export function migrate(o: MigrateOptions): MigrateReport {
  const now = o.now ?? Date.now();
  const source = resolve(o.source), to = resolve(o.to);
  const srcDb = join(source, "data", "server-os.db");
  const dstDb = join(to, "data", "agentnet.db");
  // 4.1 preconditions
  if (source === to) throw new Error("source and target are the same folder"); // also in a dry run: it would write agentnet.db into the Server OS folder
  if (!existsSync(srcDb)) throw new Error(`no Server OS database at ${srcDb}`);
  if (existsSync(dstDb)) {
    const probe = new Database(dstDb, { readonly: true });
    try { if (count(probe, "agents") > 0) throw new Error(`target already holds agents: ${dstDb} (move it away first)`); } finally { probe.close(); }
  }

  const copied: string[] = [], skipped: string[] = [];
  // 1
  for (const d of ["config", "data", "logs", join("run", "agentnet"), "trails"]) mkdirSync(join(to, d), { recursive: true });
  // 2, 3
  // Opening a WAL database read-only can still create empty -wal/-shm sidecars (Linux does): remember which exist now and remove new ones at the end.
  const sidecars = () => (existsSync(join(source, "data")) ? readdirSync(join(source, "data")).filter((n) => /-(wal|shm)$/.test(n)) : []);
  const sidecarsBefore = new Set(sidecars());
  const src = new Database(srcDb, { readonly: true });
  const dst = new Database(dstDb, { create: true });
  useDatabase(dst); store._reset(); store.ensureSchema();
  const counts: Record<string, { source: number; target: number }> = {};
  let scoresMaxId = 0;
  try {
    // 4, 5
    dst.transaction(() => {
      for (const t of TABLES) copyRows(src, dst, t, "insert");
      for (const t of SEQ_TABLES) bumpSeq(dst, t, seqOf(src, t));
      const members = o.members.filter((m) => m);
      if (members.length) dst.run(`UPDATE agents SET kind = 'member' WHERE name IN (${members.map(() => "?").join(",")}) AND archived_at IS NULL`, members);
      const rows = dst.query("SELECT id, name FROM agents WHERE archived_at IS NULL AND token_hash IS NOT NULL").all() as { id: string; name: string }[];
      for (const r of rows) {
        const f = join(source, "run", "agentnet", `${r.name}.token`);
        if (existsSync(f)) dst.run("UPDATE agents SET token_file = ? WHERE id = ?", [f, r.id]);
      }
    })();

    // 6 scores
    const scoresSrc = join(source, "data", "agent-scores.db"), scoresDst = join(to, "data", "agent-scores.db");
    let scoresCount = { source: 0, target: 0 };
    if (existsSync(scoresSrc)) {
      const s = new Database(scoresSrc, { readonly: true });
      try { s.run("VACUUM INTO ?", [scoresDst]); scoresCount.source = count(s, "agent_scores"); } finally { s.close(); }
      const c = new Database(scoresDst);
      try {
        // The column was called umur_rounds in Server OS files; agentnet calls it owner_rounds.
        const cols = columns(c, "agent_scores");
        if (cols.includes("umur_rounds") && !cols.includes("owner_rounds")) c.run("ALTER TABLE agent_scores RENAME COLUMN umur_rounds TO owner_rounds");
        scoresMaxId = maxOf(c, "agent_scores", "id"); scoresCount.target = count(c, "agent_scores"); } finally { c.close(); }
      copied.push("data/agent-scores.db");
    } else skipped.push("data/agent-scores.db");

    // 7 trails index
    const trSrc = join(source, "data", "trails.db"), trDst = join(to, "data", "trails.db");
    if (existsSync(trSrc)) {
      const t = new Database(trSrc, { readonly: true });
      try { t.run("VACUUM INTO ?", [trDst]); copied.push("data/trails.db"); }
      catch { try { unlinkSync(trDst); } catch { /* no partial file */ } skipped.push("data/trails.db (index rebuilds on first search)"); }
      finally { t.close(); }
    } else skipped.push("data/trails.db");

    // 8 trail notes
    for (const f of mdFiles(join(source, "trails"))) {
      const from = join(source, "trails", f), dest = join(to, "trails", f), st = statSync(from);
      copyFileSync(from, dest); utimesSync(dest, st.atime, st.mtime);
    }
    if (mdFiles(join(source, "trails")).length) copied.push("trails/*.md"); else skipped.push("trails/*.md");

    // 9 config, 10 logs
    for (const [dir, f] of [["config", "model-routing.json"], ["config", "agent-score.json"], ["config", "trails.json"], ["logs", "trail-inject.jsonl"]] as const) {
      const from = join(source, dir, f);
      if (existsSync(from)) { copyFileSync(from, join(to, dir, f)); copied.push(`${dir}/${f}`); } else skipped.push(`${dir}/${f}`);
    }

    // 11 cass
    const cass = join(source, "data", "cass");
    let isLink = false, exists = false;
    try { const l = lstatSync(cass); exists = true; isLink = l.isSymbolicLink(); } catch { /* absent */ }
    if (isLink) { symlinkSync(readlinkSync(cass), join(to, "data", "cass")); copied.push("data/cass"); }
    else skipped.push(exists ? "data/cass (not a link, not copied)" : "data/cass");

    // 13 verify
    for (const t of TABLES) counts[t] = { source: count(src, t), target: count(dst, t) };
    counts.agent_scores = scoresCount;
    counts.trails = { source: mdFiles(join(source, "trails")).length, target: mdFiles(join(to, "trails")).length };
    const fold = verifyFold(dst);
    const ok = Object.values(counts).every((c) => c.source === c.target) && fold.differ.length === 0;

    // 14 marks
    const targetCounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(counts)) targetCounts[k] = v.target;
    const marks: Marks = {
      at: now, source, sourceDb: srcDb,
      maxSeq: maxOf(dst, "agent_events", "seq"), maxMsgId: maxOf(dst, "messages", "id"), maxTeamTaskId: maxOf(dst, "team_tasks", "id"),
      scoresMaxId, counts: targetCounts,
    };
    writeFileSync(join(to, "data", "migrated-from.json"), JSON.stringify(marks, null, 2) + "\n", { mode: 0o644 });
    return { marks, counts, fold, copied, skipped, ok };
  } finally {
    src.close();
    for (const n of sidecars()) if (!sidecarsBefore.has(n)) { try { unlinkSync(join(source, "data", n)); } catch { /* still in use: leave it */ } }
    // dst stays the active database (the CLI exits right after; tests reopen it)
  }
}
