// Shared row-copy helpers for the migration tools. No I/O policy: the caller opens handles and wraps writes in a transaction.
import type { Database } from "bun:sqlite";

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

/** Column names of table t in d (PRAGMA table_info), [] when the table does not exist. */
export function columns(d: Database, t: string): string[] {
  return (d.query(`PRAGMA table_info(${q(t)})`).all() as { name: string }[]).map((r) => r.name);
}

/** Copy every row of table t from src to dst for the columns both have. mode "insert" fails on conflict; "replace" = INSERT OR REPLACE;
 *  "ignore" = INSERT OR IGNORE. where: optional SQL tail for the SELECT (e.g. "WHERE seq > ?") with its params. Returns rows written. */
export function copyRows(src: Database, dst: Database, t: string, mode: "insert" | "replace" | "ignore", where?: { sql: string; params: (number | string)[] }, rename: Record<string, string> = {}): number {
  // rename: source column -> target column (a column that was renamed between the two schemas, e.g. umur_rounds -> owner_rounds)
  const have = new Set(columns(dst, t));
  const cols = columns(src, t).filter((c) => have.has(rename[c] ?? c));
  if (!cols.length) return 0;
  const list = cols.map(q).join(",");
  const verb = mode === "insert" ? "INSERT" : mode === "replace" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  const ins = dst.query(`${verb} INTO ${q(t)} (${cols.map((c) => q(rename[c] ?? c)).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  const rows = src.query(`SELECT ${list} FROM ${q(t)} ${where?.sql ?? ""} ORDER BY rowid`).all(...(where?.params ?? [])) as Record<string, never>[];
  let n = 0;
  for (const r of rows) { ins.run(...cols.map((c) => r[c] as never)); n++; }
  return n;
}

/** sqlite_sequence value for t in d, 0 when absent. */
export function seqOf(d: Database, t: string): number {
  try { return Number((d.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(t) as { seq: number } | null)?.seq ?? 0); } catch { return 0; }
}

/** Set sqlite_sequence for t in d to n when n is larger than the current value (insert the row when missing). */
export function bumpSeq(d: Database, t: string, n: number): void {
  const row = d.query("SELECT seq FROM sqlite_sequence WHERE name = ?").get(t) as { seq: number } | null;
  if (!row) d.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [t, n]);
  else if (n > row.seq) d.run("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [n, t]);
}

/** MAX(col) of t in d, 0 for an empty or missing table. */
export function maxOf(d: Database, t: string, col: string): number {
  try { return Number((d.query(`SELECT MAX(${q(col)}) AS m FROM ${q(t)}`).get() as { m: number | null }).m ?? 0); } catch { return 0; }
}

export const count = (d: Database, t: string): number => {
  try { return Number((d.query(`SELECT COUNT(*) AS n FROM ${q(t)}`).get() as { n: number }).n); } catch { return 0; }
};
