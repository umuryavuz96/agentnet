// Paging for the tool answers an agent reads (docs/api.md "Paging"). Pure helpers: newest first, an opaque cursor, a marked cut for long text.
// A tool answer must never flood an agent's context: the plugin asks with compact=1 and gets a page plus `total` and `next_cursor`.

export interface Page<T> { rows: T[]; total: number; next_cursor: string | null }

/** A whole number from a query string, clamped to [min, max]; `def` when it is absent or not a number. */
export function intParam(v: string | undefined, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  return v == null || v === "" || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n));
}

/** Zero-padded so that string order is number order (cursors compare as strings). */
export const numKey = (n: number) => String(Math.max(0, Math.floor(n))).padStart(15, "0");

/**
 * `items` sorted by `key` descending (newest first); `cursor` is the key of the last row of the previous page.
 * `total` counts every item (before the cursor), so a client sees how much is left; `next_cursor` is null on the last page.
 */
export function pageOf<T>(items: T[], key: (t: T) => string, limit: number, cursor?: string): Page<T> {
  const sorted = [...items].sort((a, b) => { const x = key(a), y = key(b); return x < y ? 1 : x > y ? -1 : 0; });
  const rest = cursor ? sorted.filter((t) => key(t) < cursor) : sorted;
  const rows = rest.slice(0, limit);
  return { rows, total: sorted.length, next_cursor: rest.length > limit && rows.length ? key(rows[rows.length - 1]!) : null };
}

/** `text` cut to `n` characters, with the cut length marked so that the reader knows it is not the whole text. */
export const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…[+${text.length - n} chars]` : text);

/** The first line of `text`, cut to `n`. */
export const oneLine = (text: string | null | undefined, n: number): string | null => (text ? clip(text.replace(/\s+/g, " ").trim(), n) : null);

/** Every string in an object tree cut to `n` characters (numbers, booleans and null stay). */
export function clipDeep<T>(v: T, n: number): T {
  if (typeof v === "string") return clip(v, n) as T;
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, n)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipDeep(x, n)])) as T;
  return v;
}
