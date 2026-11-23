// Lines panel (job 8c): the shapes the panel reads from GET v1/panel/lines and v1/panel/lines/<line>, and the pure helpers the page uses
// (grouping by role, status and version labels, the baseline chart geometry). Server side: src/net/linesView.ts.
import type { IconName } from "./ui/icons";

export type LineStatus = "active" | "probation" | "retired";
export interface LineRow { line: string; role: string; status: LineStatus; current: number; baseline: number | null; parent: string | null; jobs: number; lastReward: number | null; lastPick: number | null }
export interface LinesList { on?: boolean; lines: LineRow[] }
export interface VersionView { version: number; parentVersion: number; gen: number; status: "pending" | "kept" | "reverted"; text: string; scope: string; check: Record<string, unknown>; reward: number | null; adherence: boolean | null; baseline: number | null; lesson: string | null; created: number; settledAt: number | null }
export interface SeriesPoint { gen: number; job: number; at: number; reward: number; baseline: number | null }
export interface PickView { id: number; ts: number; chosen: string | null; prob: number | null; p: number | null; fallback: boolean; candidates: { line: string; n: number; mean: number | null; p?: number }[] }
export interface Proposal {
  id: string; line: string; gen: number; kind: "skill" | "rule"; status: "pending" | "approved" | "rejected"; created: number;
  name?: string; summary?: string; files?: { path: string; bytes: number }[]; text?: string; target?: "line" | "house"; ownerOnly?: boolean;
  decidedAt?: number; into?: "line" | "base"; reason?: string; applied?: string | null;
}
export interface LineDetail {
  name: string; root: boolean;
  line: { current: number; baseline: number | null; status: LineStatus; parent: string | null; role: string; created: number; parentVersion?: number; history?: { at: number; from: LineStatus; to: LineStatus; reason: string }[] };
  versions: VersionView[]; baselineSeries: SeriesPoint[]; picks: PickView[]; proposals?: Proposal[];
}

/** Status is told by an icon and a word, never by colour alone. */
export const STATUS: Record<LineStatus, { icon: IconName; label: string }> = {
  active: { icon: "circle-check", label: "Active" },
  probation: { icon: "triangle-alert", label: "Probation" },
  retired: { icon: "circle-stop", label: "Retired" },
};
export const VSTATUS: Record<VersionView["status"], { icon: IconName; label: string }> = {
  kept: { icon: "check", label: "Kept" },
  reverted: { icon: "rotate-ccw", label: "Reverted" },
  pending: { icon: "clock", label: "Running" },
};
export const PSTATUS: Record<Proposal["status"], { icon: IconName; label: string }> = {
  pending: { icon: "clock", label: "Waiting" },
  approved: { icon: "check", label: "Approved" },
  rejected: { icon: "circle-x", label: "Rejected" },
};

export interface RoleGroup { role: string; lines: LineRow[]; live: number; best: number | null }
/** Lines grouped by role (roles A-Z); in a group active and probation lines come first, retired last, each by name (numeric). */
export function groupByRole(rows: LineRow[]): RoleGroup[] {
  const by = new Map<string, LineRow[]>();
  for (const r of rows) (by.get(r.role) ?? by.set(r.role, []).get(r.role)!).push(r);
  const rank = (s: LineStatus) => (s === "retired" ? 1 : 0);
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([role, lines]) => {
    const sorted = [...lines].sort((a, b) => rank(a.status) - rank(b.status) || a.line.localeCompare(b.line, undefined, { numeric: true }));
    const live = sorted.filter((l) => l.status !== "retired");
    const bs = live.map((l) => l.baseline).filter((b): b is number => b != null);
    return { role, lines: sorted, live: live.length, best: bs.length ? Math.max(...bs) : null };
  });
}

/** A reward or baseline on the 0-5 scale: one decimal, "–" when missing. */
export const r1 = (x: number | null | undefined) => (x == null ? "–" : (Math.round(x * 10) / 10).toFixed(1));
/** Server times are ms since epoch; "3 h ago" style. */
export function agoMs(t: number | null | undefined, now = Date.now()): string {
  if (!t) return "never";
  const a = Math.max(0, (now - t) / 1000);
  if (a < 90) return "just now";
  if (a < 5400) return `${Math.round(a / 60)} min ago`;
  if (a < 129600) return `${Math.round(a / 3600)} h ago`;
  return `${Math.round(a / 86400)} d ago`;
}
/** The upgrade's check, as a person reads it. */
export function checkText(c: Record<string, unknown> | null | undefined): string {
  if (!c) return "";
  if (typeof c.tool === "string") return `${c.tool} call containing "${String(c.command_includes ?? "")}"${c.output_includes ? `, output has "${String(c.output_includes)}"` : ""}`;
  if (typeof c.file_glob === "string") return `a file matching ${c.file_glob}`;
  if (typeof c.commit_msg_includes === "string") return `a commit message with "${c.commit_msg_includes}"`;
  if (c.judgment) return "the agent's own word (judgment)";
  return JSON.stringify(c);
}
export const SCOPE: Record<string, string> = { every_step: "every step", before_report: "before the report" };

export interface ChartGeom { w: number; h: number; x0: number; x1: number; y0: number; y1: number; xs: number[]; yOf: (v: number) => number; path: string; ticks: number[] }
/** Geometry for the baseline chart: x by job order, y on the fixed 1-5 reward scale (never auto-scaled, so lines compare). */
export function chartGeom(series: SeriesPoint[], w: number, h: number, pad = { l: 28, r: 12, t: 10, b: 22 }): ChartGeom {
  const x0 = pad.l, x1 = w - pad.r, y0 = h - pad.b, y1 = pad.t, n = series.length;
  const xs = series.map((_, i) => (n <= 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1)));
  const yOf = (v: number) => y0 - ((Math.min(5, Math.max(1, v)) - 1) / 4) * (y0 - y1);
  let path = "";
  series.forEach((p, i) => { if (p.baseline != null) path += `${path ? "L" : "M"}${xs[i].toFixed(1)},${yOf(p.baseline).toFixed(1)}`; });
  return { w, h, x0, x1, y0, y1, xs, yOf, path, ticks: [1, 2, 3, 4, 5] };
}
/** Index of the point nearest to x (for the crosshair). */
export function nearest(xs: number[], x: number): number {
  let best = -1, d = Infinity;
  xs.forEach((v, i) => { const e = Math.abs(v - x); if (e < d) { d = e; best = i; } });
  return best;
}
/** How often this line was chosen in the picks it was a candidate in. */
export function pickShare(picks: PickView[], line: string): { chosen: number; total: number; fallback: number } {
  return { chosen: picks.filter((p) => p.chosen === line).length, total: picks.length, fallback: picks.filter((p) => p.fallback).length };
}
export const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);
