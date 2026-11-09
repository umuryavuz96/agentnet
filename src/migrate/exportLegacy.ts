// Rollback (plan 5.4): copy what agentnet wrote after the cutover back into a Server OS var/ folder.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Marks } from "./fromServerOs";
import { bumpSeq, columns, copyRows, count, seqOf } from "./copy";

export interface ExportOptions { from: string; to: string; yes: boolean }   // from: agentnet home; to: Server OS var folder
export interface ExportReport { written: Record<string, number>; trails: string[]; dryRun: boolean }

const REPLACE = ["agents", "agent_status", "messages", "teams", "team_members", "team_tasks"] as const;

export function exportLegacy(o: ExportOptions): ExportReport {
  const marksFile = join(o.from, "data", "migrated-from.json");
  if (!existsSync(marksFile)) throw new Error(`no migration marks at ${marksFile}: nothing to roll back`);
  const marks = JSON.parse(readFileSync(marksFile, "utf8")) as Marks;
  const soDb = join(o.to, "data", "server-os.db");
  if (!existsSync(soDb)) throw new Error(`no Server OS database at ${soDb}`);
  const an = new Database(join(o.from, "data", "agentnet.db"), { readonly: true });
  const so = new Database(soDb, o.yes ? undefined : { readonly: true });
  const written: Record<string, number> = {};
  try {
    const eventsWhere = { sql: "WHERE seq > ?", params: [marks.maxSeq] };
    if (!o.yes) {
      // Dry run: count what would be written, touch nothing.
      written.agent_events = (an.query("SELECT COUNT(*) AS n FROM agent_events WHERE seq > ?").get(marks.maxSeq) as { n: number }).n;
      for (const t of REPLACE) written[t] = count(an, t);
    } else {
      so.transaction(() => {
        written.agent_events = copyRows(an, so, "agent_events", "ignore", eventsWhere);
        for (const t of REPLACE) written[t] = copyRows(an, so, t, "replace");
        for (const t of ["agent_events", "messages", "team_tasks"]) bumpSeq(so, t, seqOf(an, t));
      })();
    }
    // Scores (grades land after done_at): only when both files exist.
    const sa = join(o.from, "data", "agent-scores.db"), sb = join(o.to, "data", "agent-scores.db");
    if (existsSync(sa) && existsSync(sb)) {
      const a = new Database(sa, { readonly: true });
      const b = new Database(sb, o.yes ? undefined : { readonly: true });
      // Server OS files still call the column umur_rounds (agentnet renamed it to owner_rounds).
      const legacy: Record<string, string> = columns(b, "agent_scores").includes("umur_rounds") ? { owner_rounds: "umur_rounds" } : {};
      try { written.agent_scores = o.yes ? b.transaction(() => copyRows(a, b, "agent_scores", "replace", undefined, legacy))() : count(a, "agent_scores"); }
      finally { a.close(); b.close(); }
    }
  } finally { an.close(); so.close(); }

  // Trails: notes the Server OS folder does not have yet (keep mtimes).
  const trails: string[] = [];
  const tf = join(o.from, "trails"), tt = join(o.to, "trails");
  if (existsSync(tf)) {
    for (const f of readdirSync(tf).filter((n) => n.endsWith(".md"))) {
      if (existsSync(join(tt, f))) continue;
      trails.push(f);
      if (o.yes) { mkdirSync(tt, { recursive: true }); const st = statSync(join(tf, f)); copyFileSync(join(tf, f), join(tt, f)); utimesSync(join(tt, f), st.atime, st.mtime); }
    }
  }
  return { written, trails, dryRun: !o.yes };
}
