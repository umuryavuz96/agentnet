// Overlap check for the 3D office: no object may sit inside another. Pure: no DOM, no three.js.
// A box is a unit cube under a 4x4 matrix (column-major, as three.js stores it). Boxes of one object may overlap each other
// (a plant is a stack of leaves); boxes of two different objects may only touch.
export interface ABox { obj: string; kind?: string; m: ArrayLike<number> }
export interface Hit { a: string; b: string; depth: number }
export const EPS = 0.004; // 4 mm: resting on, or standing against, is touching

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
interface OBB { c: V; h: V[]; lo: V; hi: V } // centre, the three half-edge vectors, world bounds
function obb(m: ArrayLike<number>): OBB {
  const c: V = [m[12], m[13], m[14]], h: V[] = [[m[0] / 2, m[1] / 2, m[2] / 2], [m[4] / 2, m[5] / 2, m[6] / 2], [m[8] / 2, m[9] / 2, m[10] / 2]];
  const e = [0, 1, 2].map((i) => Math.abs(h[0][i]) + Math.abs(h[1][i]) + Math.abs(h[2][i]));
  return { c, h, lo: [c[0] - e[0], c[1] - e[1], c[2] - e[2]], hi: [c[0] + e[0], c[1] + e[1], c[2] + e[2]] };
}
/** How deep two boxes sit in each other (separating-axis test over 15 axes); 0 or less = apart or touching. */
export function depth(ma: ArrayLike<number>, mb: ArrayLike<number>): number { return sat(obb(ma), obb(mb)); }
function sat(A: OBB, B: OBB): number {
  const d: V = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]], axes: V[] = [...A.h, ...B.h];
  for (const x of A.h) for (const y of B.h) axes.push(cross(x, y));
  let min = Infinity;
  for (const ax of axes) {
    const len = Math.hypot(ax[0], ax[1], ax[2]); if (len < 1e-9) continue; // parallel edges: no new axis
    const n: V = [ax[0] / len, ax[1] / len, ax[2] / len];
    const r = (o: OBB) => Math.abs(dot(o.h[0], n)) + Math.abs(dot(o.h[1], n)) + Math.abs(dot(o.h[2], n));
    const o = r(A) + r(B) - Math.abs(dot(d, n)); if (o <= 0) return o; if (o < min) min = o;
  }
  return min;
}
/** Every pair of different objects that sit deeper than EPS in each other. `surface` objects (floor, rug) are stood on, so they are skipped. */
export function overlaps(boxes: ABox[], eps = EPS): { hits: Hit[]; objects: number; boxes: number; pairs: number } {
  const list = boxes.filter((b) => b.kind !== "surface").map((b) => ({ obj: b.obj, o: obb(b.m) })).sort((x, y) => x.o.lo[0] - y.o.lo[0]);
  const worst = new Map<string, Hit>(); let pairs = 0;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length && list[j].o.lo[0] < a.o.hi[0] - eps; j++) { // sorted by x: stop at the first box that starts past this one
      const b = list[j]; if (a.obj === b.obj) continue;
      if (b.o.lo[1] > a.o.hi[1] - eps || b.o.hi[1] < a.o.lo[1] + eps || b.o.lo[2] > a.o.hi[2] - eps || b.o.hi[2] < a.o.lo[2] + eps) continue;
      pairs++; const dp = sat(a.o, b.o); if (dp <= eps) continue;
      const key = a.obj < b.obj ? a.obj + " × " + b.obj : b.obj + " × " + a.obj, old = worst.get(key);
      if (!old || dp > old.depth) worst.set(key, { a: key.split(" × ")[0], b: key.split(" × ")[1], depth: +dp.toFixed(3) });
    }
  }
  return { hits: [...worst.values()].sort((x, y) => y.depth - x.depth), objects: new Set(boxes.map((b) => b.obj)).size, boxes: boxes.length, pairs };
}
/** A walker (w wide, h tall, standing on the floor) at each sample point of a path, against the furniture. `skip` = objects the walker may touch (its own chair). */
export function pathHits(name: string, pts: [number, number][], boxes: ABox[], skip: string[] = [], w = 0.36, h = 1.1, eps = EPS): Hit[] {
  const solid = boxes.filter((b) => b.kind !== "surface" && !skip.includes(b.obj)).map((b) => ({ obj: b.obj, o: obb(b.m) })), worst = new Map<string, Hit>();
  for (const [x, z] of pts) {
    const me = obb([w, 0, 0, 0, 0, h, 0, 0, 0, 0, w, 0, x, h / 2 + 0.02, z, 1]);
    for (const b of solid) {
      if (b.o.lo[0] > me.hi[0] || b.o.hi[0] < me.lo[0] || b.o.lo[2] > me.hi[2] || b.o.hi[2] < me.lo[2] || b.o.lo[1] > me.hi[1]) continue;
      const dp = sat(me, b.o); if (dp <= eps) continue; const old = worst.get(b.obj);
      if (!old || dp > old.depth) worst.set(b.obj, { a: name, b: b.obj, depth: +dp.toFixed(3) });
    }
  }
  return [...worst.values()];
}
