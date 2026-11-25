// Where the agent chat sits when it is not the full view (owner 8377): docked on the right of the Agents page, or floating
// wherever it was dragged. One record per browser (localStorage, may be blocked: then the defaults hold for this visit).
export const MIN_W = 380, MIN_H = 320, DEFAULT_W = 520, GAP = 12;
const KEY = "agentnet.chatDock";

export type Dock = { w: number; float: { x: number; y: number; h: number } | null };

export function readDock(): Dock {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Dock> | null;
    const w = typeof d?.w === "number" && d.w >= MIN_W ? d.w : DEFAULT_W;
    const f = d?.float;
    return { w, float: f && [f.x, f.y, f.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? { x: f.x, y: f.y, h: f.h } : null };
  } catch { return { w: DEFAULT_W, float: null }; }
}
export function writeDock(d: Dock) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* not remembered */ } }

/** Widest the panel may be: 70 % of the window and never past the page area. */
export const maxW = (areaW: number) => Math.max(MIN_W, Math.min(Math.round(innerWidth * 0.7), areaW - 2 * GAP));
export const clampW = (w: number, areaW: number) => Math.round(Math.min(maxW(areaW), Math.max(MIN_W, w)));
/** A floating panel stays wholly inside the page area. */
export function clampFloat(f: { x: number; y: number; h: number }, w: number, areaW: number, areaH: number) {
  const h = Math.round(Math.min(areaH, Math.max(MIN_H, f.h)));
  return { x: Math.round(Math.min(Math.max(0, areaW - w), Math.max(0, f.x))), y: Math.round(Math.min(Math.max(0, areaH - h), Math.max(0, f.y))), h };
}

// ---- a floating chat resizes from every edge and corner, like a window (owner 8488) ----
export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const DIRS: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
export const CURSOR: Record<Dir, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
export type Box = { x: number; y: number; w: number; h: number };
/** The box after dragging edge or corner `dir` by (dx, dy) from `b`: the dragged edges move, the opposite ones stay put.
 *  Width runs MIN_W..mw, height MIN_H..the page area, and no edge leaves the page area (0..areaW, 0..areaH). */
export function resizeBox(b: Box, dir: Dir, dx: number, dy: number, areaW: number, areaH: number, mw = maxW(areaW)): Box {
  let { x, y, w, h } = b;
  const right = b.x + b.w, bottom = b.y + b.h;
  const lim = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, v));
  if (dir.includes("e")) w = lim(right + dx, b.x + MIN_W, Math.min(areaW, b.x + mw)) - b.x;
  if (dir.includes("w")) { x = lim(b.x + dx, Math.max(0, right - mw), right - MIN_W); w = right - x; }
  if (dir.includes("s")) h = lim(bottom + dy, b.y + MIN_H, areaH) - b.y;
  if (dir.includes("n")) { y = lim(b.y + dy, 0, bottom - MIN_H); h = bottom - y; }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// ---- motion for a change of kind (dock, float, full): the Motion board's view timing, 260 ms in, 180 ms out ----
// Owner 8436: one chat that moves and grows, like a window being resized; no scale, no frozen copy, no crossfade.
export const EASE = "cubic-bezier(.23,1,.32,1)";
export const MS_IN = 260, MS_OUT = 180;
export type R = { left: number; top: number; width: number; height: number };
/** The box's own paint that differs per kind (radius, shadow ring), read from the computed style at each end. */
export type Skin = { borderRadius: string; boxShadow: string };
/** Keyframes that move the real box from rect f to rect l (px in its containing block). left/top/width/height win over
 *  each kind's own right/bottom/inset (right and bottom go auto), so the content lays out at every frame's size. */
export function moveFrames(f: R, l: R, fs?: Skin, ls?: Skin): Keyframe[] {
  const k = (r: R, s?: Skin): Keyframe => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", right: "auto", bottom: "auto", ...(s ?? {}) });
  return [k(f, fs), k(l, ls)];
}
/** Same rect within half a pixel: nothing to move. */
export const sameRect = (a: R, b: R) => Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
/** The floating chat's own spot, a little smaller around its centre: where it grows from (and shrinks to) when the card
 *  that opened it is not on screen (the 3D office, a link, the card scrolled away). */
export const inset = (r: R, k = 0.92): R => { const w = r.width * k, h = r.height * k; return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h }; };
/** The floating chat stays fully opaque for the whole move (owner 8436: "cant you just move it? The same chat?"): the
 *  same solid box grows out of its card and shrinks back. Only the first RAMP_MS of an open (so the first tiny frame is
 *  not a hard pop) and the last RAMP_MS of a close ramp the opacity. It starts from whatever opacity is on screen now,
 *  so a press mid-run turns round without a jump. */
export const RAMP_MS = 30;
export const fadeFrames = (from: number, dir: "in" | "out", ms: number): Keyframe[] => {
  const k = Math.min(1, RAMP_MS / ms);
  return dir === "in" ? [{ opacity: from }, { opacity: 1, offset: k }, { opacity: 1 }] : [{ opacity: from }, { opacity: from, offset: 1 - k }, { opacity: 0 }];
};
