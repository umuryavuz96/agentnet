// 5-field cron (minute hour day-of-month month day-of-week) in LOCAL time: parse and next run. No dependency.
// Supports *, lists (1,5), ranges (1-5), steps (*/15, 1-10/2), day-of-week 0-7 (0 and 7 = Sunday). Names (MON, JAN) are not supported.
// Like Vixie cron: when both day-of-month and day-of-week are restricted, a day matches if EITHER does.
export interface Cron { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(src: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let a = lo, b = hi;
    if (m[1] !== "*") {
      const r = m[1]!.split("-").map(Number);
      a = r[0]!; b = r[1] ?? (m[2] === undefined ? a : hi); // "5/10" means 5-hi step 10
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** Parse a 5-field cron expression; null when it is not valid. */
export function parseCron(expr: string): Cron | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const sets = f.map((x, i) => field(x, RANGES[i]!));
  if (sets.some((s) => !s)) return null;
  const [min, hour, dom, mon, dow] = sets as Set<number>[];
  if (dow!.has(7)) { dow!.add(0); dow!.delete(7); }
  return { min: min!, hour: hour!, dom: dom!, mon: mon!, dow: dow!, domAny: f[2]!.startsWith("*"), dowAny: f[4]!.startsWith("*") };
}

const dayOk = (c: Cron, d: Date) => {
  const a = c.dom.has(d.getDate()), b = c.dow.has(d.getDay());
  return c.domAny && c.dowAny ? true : c.domAny ? b : c.dowAny ? a : a || b;
};

/** The first run strictly after `from` (ms), local time; null for an invalid expression or one that never fires within 5 years. */
export function nextRun(expr: string, from = Date.now()): number | null {
  const c = parseCron(expr); if (!c) return null;
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  const limit = from + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d.getTime();
  }
  return null;
}
