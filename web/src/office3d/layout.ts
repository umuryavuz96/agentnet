// Where every box of the 3D office stands, and every line people and couriers walk. Pure: no DOM, no three.js.
// The renderer draws these boxes as they are, and the overlap test reads the same list, so what is checked is what is shown.
import { type Plan, type PRoom, type PAgent, LANE, CLINE, STRIP, DOORW, CORR } from "./plan";
import type { ABox } from "./audit";

export const WALLH = 2.0, INWALL = 1.3, PARTH = 0.6; // outer glass wall, the solid wall between two blocks, low partitions
export const DESKT = 0.42, SEAT = 0.16, SITZ = 0.075; // desk top, chair seat top, how far in front of the chair's middle a person sits (knees clear the seat)
export const DOORH = 1.56, LEAFW = 0.82, SLIDE = 0.88; // door frame height (the tallest hair plus a walking bob is 1.45), sliding leaf width, how far the leaf slides
export const WALKW = 0.58, WALKH = 1.46, RUNW = 0.28, RUNH = 0.5; // the space a walking person takes (shoulders and swinging arms), and a courier
export const GROUND = -44; // the street, far below the floor
export const ACCENT = [0x3ecf8e, 0x6aa8ff, 0xf2b04a, 0xb48cff, 0x38c6d9, 0xff7a59], GOLD = 0xd9a441; // one accent per team room: door, partition cap, wall screen
const MUGS = [0xf4f4f4, 0xff7a59, 0x6aa8ff, 0x3ecf8e, 0xf2b04a], BOOKS = [0xf2b04a, 0x3ecf8e, 0x6aa8ff, 0xb48cff, 0x38c6d9, 0xe9e4da];
const NOTE: Record<string, number> = { pending: 0xf2b04a, in_progress: 0x3ecf8e }; // one note per open team task: amber = waiting, green = someone is on it

export type P2 = [number, number]; // x, z
/** One box. y is its bottom. col = a palette name or a fixed colour. tint = how far it fades into the sky (the city below). ent = the moving part it belongs to. */
export interface LBox { obj: string; kind?: string; pool?: "glass" | "city"; unlit?: boolean; col: string | number; tint?: number; ent?: string; ref?: string; w: number; h: number; d: number; x: number; y: number; z: number; rx?: number; ry?: number }
export interface LDesk { name: string; x: number; z: number; w: number; room: PRoom; row: number; up: boolean; side: number; seat: P2; chair: P2; hop: P2; rowZ: number; front: P2; aisle: number; tray: [number, number, number]; lamp: [number, number, number]; lit: boolean }
export interface LDoor { id: string; x: number; z: number; dir: number }
export interface Layout { boxes: LBox[]; desks: Record<string, LDesk>; doors: LDoor[]; ents: Record<string, P2>; sideX: number; plan: Plan }

export const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); h ^= h >>> 15; h = Math.imul(h, 2246822507); return (h ^ (h >>> 13)) >>> 0; }; // well mixed, so web-dev-1 and web-dev-2 do not look alike
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export function makeLayout(plan: Plan, notes: Record<string, string[]> = {}): Layout {
  const { rooms, blocks, plots, W, ZF, multi } = plan, zb0 = blocks[0].zb;
  const boxes: LBox[] = [], desks: Record<string, LDesk> = {}, doors: LDoor[] = [], ents: Record<string, P2> = {};
  let cur: { obj: string; kind?: string; ent?: string; pool?: "glass" | "city" } = { obj: "" };
  const B = (w: number, h: number, d: number, col: string | number, x: number, y: number, z: number, o: Partial<LBox> = {}) => { const b: LBox = { obj: cur.obj, kind: cur.kind, ent: cur.ent, pool: cur.pool, col, w, h, d, x, y, z, ...o }; boxes.push(b); return b; };
  const O = (obj: string, fn: () => void, kind?: string, ent?: string, pool?: "glass" | "city") => { const p = cur; cur = { obj, kind, ent, pool }; fn(); cur = p; };
  const plant = (id: string, x: number, z: number) => O(id, () => { B(0.24, 0.2, 0.24, "pot", x, 0, z); ([[0.36, 0.2, 0.2], [0.28, 0.42, 0.7], [0.18, 0.62, 1.3]] as number[][]).forEach(([s, y, r]) => B(s, s * 0.7, s, "plant", x, y, z, { ry: r })); });

  // a glass wall: sill, head rail, a post about every metre, panes between. along = "x" or "z"; c = the wall's low edge on the other axis
  function glassWall(id: string, along: "x" | "z", a0: number, a1: number, c: number) {
    const len = a1 - a0, n = Math.max(1, Math.round(len / 1.05)), step = len / n, mid = (a0 + a1) / 2, cc = c + 0.075;
    const bar = (l: number, h: number, t: number, col: string, a: number, y: number, o: Partial<LBox> = {}) => along === "x" ? B(l, h, t, col, a, y, cc, o) : B(t, h, l, col, cc, y, a, o);
    O(id, () => {
      bar(len, 0.12, 0.15, "mull", mid, -0.02); bar(len, 0.1, 0.15, "mull", mid, WALLH - 0.1);
      for (let i = 0; i <= n; i++) bar(0.07, WALLH - 0.2, 0.11, "mull", a0 + 0.035 + (len - 0.07) * (i / n), 0.1);
      for (let i = 0; i < n; i++) bar(step - 0.07, WALLH - 0.2, 0.02, "glass", a0 + step * (i + 0.5), 0.1, { pool: "glass" });
    });
  }

  O("slab", () => B(W + 0.4, 0.4, ZF - zb0 + 0.4, "slab", W / 2, -0.42, (zb0 + ZF) / 2), "surface");
  blocks.forEach((bl, bi) => {
    const D = bl.z0 - bl.zb, zm = (bl.z0 + bl.zb) / 2, lastB = bi === blocks.length - 1;
    O("corridor:" + bi, () => { B(W, 0.02, CORR, "corridor", W / 2, -0.02, bl.z0 + CORR / 2); if (multi) B(1.0, 0.02, D, "corridor", W - 0.5, -0.02, zm); }, "surface"); // the passage couriers take between the blocks
    if (bi === 0) glassWall("wall:back:0", "x", -0.15, bl.x1, bl.zb - 0.15);
    else O("wall:back:" + bi, () => { B(bl.x1 + 0.15, INWALL + 0.02, 0.15, "wall", bl.x1 / 2 - 0.075, -0.02, bl.zb - 0.075); B(bl.x1 + 0.15, 0.03, 0.15, "cap", bl.x1 / 2 - 0.075, INWALL, bl.zb - 0.075); });
    glassWall("wall:left:" + bi, "z", bl.zb, bl.z0 + CORR - (lastB ? 0 : 0.15), -0.15); // the outer wall runs on past the corridor
  });

  function desk(a: PAgent, r: PRoom) {
    const { x, z } = a.desk, big = r.director, w = big ? 1.7 : 1.4, h = hash(a.name), T = DESKT, lx = -w / 2 + 0.17, kit = big ? 2 : h % 3, side = Math.sign(r.lane - x) || -1, lampOn = big || !a.desk.alt;
    const b = (bw: number, bh: number, bd: number, col: string | number, dx: number, y: number, dz: number, o: Partial<LBox> = {}) => B(bw, bh, bd, col, x + dx, y, z + dz, o);
    O("desk:" + a.name, () => {
      b(w, 0.06, 0.72, "desk", 0, T - 0.06, 0); b(0.06, T - 0.06, 0.62, "deskLeg", -w / 2 + 0.06, 0, 0); b(0.06, T - 0.06, 0.62, "deskLeg", w / 2 - 0.06, 0, 0);
      const glow = "glow:" + a.name;
      if (kit === 0) { b(0.4, 0.02, 0.26, "tech", 0, T, -0.14); b(0.4, 0.27, 0.02, "tech", 0, T, 0.03, { rx: 0.2 }); b(0.12, 0.12, 0.012, 0, 0, T + 0.07, 0.046, { rx: 0.2, unlit: true, ref: glow }); } // laptop: the lit mark on its lid shows the state
      else {
        b(0.34, 0.015, 0.11, "tech", 0, T, -0.15); b(0.05, 0.02, 0.08, "tech", 0.27, T, -0.15); // keyboard, mouse
        if (kit === 1) { b(0.2, 0.015, 0.14, "tech", 0, T, 0.1); b(0.06, 0.1, 0.05, "tech", 0, T, 0.1); b(0.52, 0.3, 0.03, "tech", 0, T + 0.08, 0.1); b(0.12, 0.12, 0.012, 0, 0, T + 0.17, 0.121, { unlit: true, ref: glow }); }
        else { for (const s of [-1, 1]) { b(0.16, 0.015, 0.12, "tech", s * 0.2, T, 0.1); b(0.05, 0.1, 0.05, "tech", s * 0.2, T, 0.1); b(0.38, 0.26, 0.03, "tech", s * 0.2, T + 0.08, 0.1, { ry: -s * 0.22 }); }
          b(0.1, 0.1, 0.012, 0, 0.2 + 0.021 * Math.sin(-0.22), T + 0.16, 0.1 + 0.021 * Math.cos(0.22), { ry: -0.22, unlit: true, ref: glow }); }
      }
      b(0.32, 0.03, 0.24, "tray", w / 2 - 0.3, T, 0.2); b(0.07, 0.08, 0.07, MUGS[(h >>> 4) % 5], w / 2 - 0.62, T, 0.27);
      if (lampOn) { b(0.13, 0.02, 0.13, "tech", lx, T, 0.2); b(0.03, 0.3, 0.03, "tech", lx, T + 0.02, 0.2); b(0.19, 0.12, 0.19, "shade", lx, T + 0.3, 0.2, { unlit: true }); } // a lamp on every second desk
      const px = -0.28, pz = 0.27, pk = (h >>> 7) % 7; // one thing of their own, by name: books, a plant, a photo, a toy robot, a bottle, sticky notes, a cactus
      if (pk === 0) { b(0.18, 0.04, 0.12, BOOKS[(h >>> 9) % 6], px, T, pz, { ry: 0.2 }); b(0.16, 0.04, 0.11, BOOKS[(h >>> 12) % 6], px, T + 0.04, pz, { ry: -0.1 }); }
      else if (pk === 1) { b(0.09, 0.07, 0.09, "pot", px, T, pz); b(0.14, 0.12, 0.14, "plant", px, T + 0.07, pz, { ry: 0.5 }); }
      else if (pk === 2) { b(0.14, 0.11, 0.02, "frame", px, T, pz, { ry: 0.3 }); b(0.1, 0.07, 0.022, BOOKS[(h >>> 9) % 6], px, T + 0.02, pz, { ry: 0.3 }); }
      else if (pk === 3) { b(0.07, 0.07, 0.05, 0xe76f51, px, T, pz); b(0.09, 0.07, 0.07, 0xe9e4da, px, T + 0.07, pz); b(0.02, 0.03, 0.02, 0xe76f51, px, T + 0.14, pz); }
      else if (pk === 4) { b(0.055, 0.15, 0.055, 0x5fb0d8, px, T, pz); b(0.035, 0.03, 0.035, 0xf4f4f4, px, T + 0.15, pz); }
      else if (pk === 5) { for (let i = 0; i < 3; i++) b(0.08, 0.008, 0.08, BOOKS[(h + i * 2) % 5], px - 0.095 + i * 0.095, T, pz - 0.02 + (i % 2) * 0.03, { ry: (i - 1) * 0.15 }); }
      else { b(0.08, 0.06, 0.08, "pot", px, T, pz); b(0.05, 0.12, 0.05, "plant", px, T + 0.06, pz); b(0.04, 0.05, 0.04, "plant", px + 0.045, T + 0.1, pz); }
    });
    const ch = big ? "chairDir" : "chair", cz = z - 0.6; ents["chair:" + a.name] = [x, cz];
    O("chair:" + a.name, () => { B(0.34, 0.04, 0.07, "tech", x, 0, cz); B(0.07, 0.04, 0.34, "tech", x, 0, cz); B(0.07, SEAT - 0.1, 0.07, "tech", x, 0.04, cz); B(0.42, 0.06, 0.37, ch, x, SEAT - 0.06, cz - 0.025); /* the seat ends behind the shins */ B(0.42, 0.44, 0.06, ch, x, SEAT, cz - 0.21); }, "chair", "chair:" + a.name);
    const front: P2 = [x + w / 2 - 0.3, z + 0.64];
    desks[a.name] = { name: a.name, x, z, w, room: r, row: a.desk.row, up: a.desk.up, side, seat: [x, cz + SITZ], chair: [x, cz], hop: [x + side * 0.6, z - 0.66], rowZ: z - (r.people.some((p) => p.desk.row > a.desk.row) ? 1.24 : 1.14) /* the middle of the walkway behind the chair: between two rows, or between the back row and the wall furniture */, front,
      aisle: r.aisles.reduce((p, q) => (Math.abs(q - front[0]) < Math.abs(p - front[0]) ? q : p), r.aisles[0]), tray: [x + w / 2 - 0.3, T + 0.035, z + 0.2], lamp: [x + lx, 1.1, z + 0.25], lit: lampOn };
  }

  rooms.forEach((r, ri) => {
    const D = r.z0 - r.zb, zm = (r.z0 + r.zb) / 2, w = r.x1 - r.x0, cx = (r.x0 + r.x1) / 2, acc = r.director ? GOLD : ACCENT[(ri + 5) % 6], dir = r.director ? -1 : 1, zf = r.z0 - 0.05;
    O("floor:" + r.id, () => {
      B(w, 0.02, D, r.director ? "floorDir" : "floorTeam", cx, -0.02, zm); if (r.x0 > 0.01) B(0.12, 0.02, D, "corridor", r.x0 - 0.06, -0.02, zm);
      if (r.people.length) { const xs = r.people.map((a) => a.desk.x), zs = r.people.map((a) => a.desk.z), rx0 = Math.min(...xs) - 0.9, rx1 = Math.max(...xs) + 0.9, rz0 = Math.min(...zs) - 0.95, rz1 = Math.max(...zs) + 0.7; B(rx1 - rx0, 0.015, rz1 - rz0, r.director ? "rugDir" : "rug" + (ri % 2), (rx0 + rx1) / 2, 0, (rz0 + rz1) / 2); }
    }, "surface");
    if (r.x0 > 0.01) O("divider:" + r.id, () => { B(0.12, PARTH + 0.02, D, "part", r.x0 - 0.06, -0.02, zm); B(0.12, 0.03, D, "cap", r.x0 - 0.06, PARTH, zm); });
    if (r.last) O("end:" + r.id, () => { B(0.1, PARTH + 0.02, D - 0.1, "part", r.x1 + 0.05, -0.02, zm - 0.05); B(0.1, 0.03, D - 0.1, "cap", r.x1 + 0.05, PARTH, zm - 0.05); });
    // the front partition, with the doorway at the lane
    O("front:" + r.id, () => { for (const [a0, a1] of [[r.x0, r.doorX - DOORW / 2], [r.doorX + DOORW / 2, r.x1 + (r.last ? 0.1 : 0)]]) if (a1 - a0 > 0.01) { B(a1 - a0, PARTH + 0.02, 0.1, "part", (a0 + a1) / 2, -0.02, zf); B(a1 - a0, 0.03, 0.1, acc, (a0 + a1) / 2, PARTH, zf); } });
    O("door:" + r.id, () => {
      for (const s of [-1, 1]) B(0.08, DOORH, 0.1, "frame", r.doorX + s * (DOORW / 2 - 0.04), 0, zf);
      B(DOORW - 0.16, 0.08, 0.1, "frame", r.doorX, DOORH - 0.08, zf); B(LEAFW + SLIDE, 0.05, 0.05, "rail", r.doorX + (dir * SLIDE) / 2, DOORH - 0.06, r.z0 + 0.035); // the rail the leaf hangs on, on the corridor side
    });
    ents["leaf:" + r.id] = [r.doorX, r.z0]; doors.push({ id: r.id, x: r.doorX, z: r.z0, dir });
    O("leaf:" + r.id, () => { B(LEAFW, DOORH - 0.07, 0.04, acc, r.doorX, 0.005, r.z0 + 0.03); B(0.4, 0.5, 0.044, "window", r.doorX, 0.62, r.z0 + 0.03, { unlit: true }); B(0.04, 0.14, 0.02, "tech", r.doorX - dir * 0.3, 0.55, r.z0 + 0.06); }, "door", "leaf:" + r.id);
    for (const a of r.people) desk(a, r);
    if (r.director) { // the corner office: two glass walls, a low cabinet with books, two plants
      O("cabinet", () => {
        B(1.1, 0.5, 0.3, "shelf", r.x0 + 0.75, 0, r.zb + 0.2);
        for (let i = 0; i < 5; i++) B(0.13, 0.2 + ((i * 7) % 3) * 0.03, 0.06, BOOKS[(i * 2) % 6], r.x0 + 0.33 + i * 0.14, 0.5, r.zb + 0.2);
        B(0.12, 0.16, 0.12, GOLD, r.x0 + 1.15, 0.5, r.zb + 0.2);
      });
      plant("plant:dir:0", r.x0 + 1.9, r.zb + 0.3); plant("plant:dir:1", r.x0 + 0.35, r.z0 - 0.45);
    } else { // a team room: the task board on its stand, a wall screen, a plant; the coffee point stands in the corridor by the door wall
      const bx = r.boardX, bz = r.zb + 0.22, sx = r.x0 + 0.72, sz = r.zb + 0.2, c = r.cooler!, h = hash(r.id);
      O("board:" + r.id, () => {
        for (const s of [-1, 1]) { B(0.06, 1.36, 0.06, "tray", bx + s * 1.03, 0, bz); B(0.06, 0.04, 0.4, "tray", bx + s * 1.03, 0, bz, { kind: "surface" }); }
        B(2.0, 0.85, 0.04, "board", bx, 0.46, bz); B(2.0, 0.08, 0.05, acc, bx, 1.23, bz); B(2.0, 0.04, 0.08, "tray", bx, 0.42, bz + 0.02); // header strip in the team colour
        for (const cx of [-0.34, 0.34]) B(0.012, 0.72, 0.006, "tray", bx + cx, 0.48, bz + 0.023); // three columns: waiting, being worked on, the rest
        const open = notes[r.id] || [], note = (c: number, i: number, col: number) => B(0.2, 0.17, 0.012, col, bx - 0.68 + c * 0.68 + (i % 2 ? 0.12 : -0.12), 0.98 - Math.floor(i / 2) * 0.22, bz + 0.026);
        if (open.length) { let n0 = 0, n1 = 0; for (const st of open) { if (st === "in_progress") { if (n1 < 6) note(1, n1++, NOTE.in_progress); } else if (n0 < 6) note(0, n0++, NOTE.pending); } } // real: one note per open team task
        else for (let c = 0; c < 3; c++) for (let i = 0, n = 2 + ((h >>> (c * 3)) % 3); i < n; i++) note(c, i, BOOKS[(h >>> (c * 5 + i * 2)) % 5]); // no open task: a fixed pattern from the room's name, never random per frame
      });
      O("screen:" + r.id, () => {
        B(0.4, 0.04, 0.3, "tech", sx, 0, sz); B(0.06, 0.7, 0.06, "tech", sx, 0.04, sz); B(0.9, 0.52, 0.05, "screen", sx, 0.7, sz);
        for (let i = 0; i < 5; i++) B(0.1, 0.1 + (((h >>> (i * 3)) % 5) * 0.07), 0.012, i === 3 ? 0xf4f4f4 : acc, sx - 0.3 + i * 0.15, 0.76, sz + 0.031, { unlit: true });
      });
      plant("plant:" + r.id, r.x1 - 0.4, r.zb + 0.26);
      O("coffee:" + r.id, () => {
        B(1.1, 0.47, 0.3, "counter", c.x, 0, c.z); B(1.14, 0.03, 0.3, "desk", c.x, 0.47, c.z);
        B(0.28, 0.3, 0.24, "machine", c.x - 0.3, 0.5, c.z - 0.02); B(0.04, 0.04, 0.012, acc, c.x - 0.3, 0.7, c.z + 0.106, { unlit: true }); B(0.1, 0.02, 0.08, "tray", c.x - 0.3, 0.5, c.z + 0.1, { kind: "surface" });
        for (let i = 0; i < 3; i++) B(0.07, 0.08, 0.07, MUGS[(h + i) % 5], c.x + 0.1 + i * 0.12, 0.5, c.z + 0.02);
      });
      O("cooler:" + r.id, () => { B(0.3, 0.6, 0.3, "cooler", c.x - 0.76, 0, c.z); B(0.22, 0.28, 0.22, "water", c.x - 0.76, 0.6, c.z); });
    }
  });
  // parked teams: lights off, one moving box per member, stacked (the ground layer fills first)
  plots.forEach((t, ti) => {
    const cx = (t.x0 + t.x1) / 2, zm = (t.z0 + t.z1) / 2, big = t.members > 12, cols = Math.min(big ? 9 : 2, Math.max(2, Math.floor((t.x1 - t.x0 - 0.4) / 0.4))), rows = big ? 3 : 2, per = cols * rows;
    O("plot:" + t.id, () => B(t.x1 - t.x0, 0.02, t.z1 - t.z0, "plot", cx, -0.02, zm), "surface");
    for (let i = 0; i < t.members; i++) { const layer = Math.floor(i / per), j = i % per, c = j % cols, k = Math.floor(j / cols); O("carton:" + t.id + ":" + i, () => B(0.28, 0.22, 0.28, "carton", cx + (c - (cols - 1) / 2) * 0.4, layer * 0.22, zm - 0.05 + (k - (rows - 1) / 2) * 0.38, { ry: Math.sin(i * 12.9 + ti) * 0.22 })); }
  });
  city(plan, B, O);
  return { boxes, desks, doors, ents, sideX: plan.sideX, plan };
}

// The view from a high floor: our own tower going down below the slab, and the roofs of lower towers around it. The lower a box, the more it fades into the sky.
const HAZE: P2[] = [[-0.6, 0], [-5, 0.14], [-9, 0.31], [-14, 0.5], [-21, 0.7], [-30, 0.87], [-44, 0.98]]; // six haze layers, summed: how far a box at that height has gone into the sky colour
function city(plan: Plan, B: (w: number, h: number, d: number, col: string | number, x: number, y: number, z: number, o?: Partial<LBox>) => LBox, O: (obj: string, fn: () => void, kind?: string, ent?: string, pool?: "glass" | "city") => void) {
  const { W, ZF, blocks } = plan, zb0 = blocks[0].zb, cx = W / 2, cz = (zb0 + ZF) / 2, dz = ZF - zb0, R = rng(7), RW = rng(11); // RW: the windows draw from their own numbers, so changing them never moves a tower
  const haze = (y: number) => { if (y >= HAZE[0][0]) return 0; for (let i = 1; i < HAZE.length; i++) if (y >= HAZE[i][0]) { const [y0, a0] = HAZE[i - 1], [y1, a1] = HAZE[i]; return a0 + ((a1 - a0) * (y0 - y)) / (y0 - y1); } return 0.98; };
  const column = (w: number, d: number, col: string, x: number, z: number, top: number, air = 0) => { const cuts = [top, ...HAZE.map((q) => q[0]).filter((y) => y < top - 0.5)]; for (let i = 0; i + 1 < cuts.length; i++) B(w, cuts[i] - cuts[i + 1], d, col, x, cuts[i + 1], z, { tint: air + (1 - air) * haze((cuts[i] + cuts[i + 1]) / 2) }); }; // one box per haze layer: the lower, the more sky
  // one floor of windows on one face: a row of small panes, about one in three with its light on (warm, a few cool white). By day all read as glass; at night the dark ones show the tower, the lit ones the rooms
  const row = (onZ: boolean, mid: number, len: number, y: number, face: number, sz: number, h: number, tint: number) => { const n = Math.max(2, Math.floor(len / (sz * 1.7))), step = len / n;
    for (let q = 0; q < n; q++) { const lit = RW() < 0.34 && tint < 0.8, col = lit ? (RW() > 0.3 ? "cityWin" : "cityWinC") : "cityWin2", u = mid - len / 2 + (q + 0.5) * step, o = { unlit: lit, tint: lit ? tint * 0.7 : tint };
      if (onZ) B(sz, h, 0.02, col, u, y, face, o); else B(0.02, h, sz, col, face, y, u, o); } };
  O("tower", () => { // our own tower under the slab: a floor line every 1.9
    column(W + 0.2, dz + 0.2, "tower", cx, cz, -0.42);
    for (let k = 1; k < 22; k++) B(W + 0.44, 0.2, dz + 0.44, "band", cx, -0.42 - k * 1.9, cz, { tint: haze(-0.4 - k * 1.9) });
    for (let k = 1; k < 12; k++) { const y = -1.4 - k * 1.9, t = haze(y + 0.4); row(true, cx, W - 0.8, y, cz + dz / 2 + 0.11, 0.3, 0.5, t); row(false, cz, dz - 0.8, y, cx + W / 2 + 0.11, 0.3, 0.5, t); } // a row of windows under every floor line, on the two faces the camera sees
  }, "city", undefined, "city");
  const CELL = 6.4, cols = ["city0", "city1", "city2"];
  for (let i = -7; i <= 6; i++) for (let j = -8; j <= 5; j++) {
    const fx = 2.4 + R() * 2.4, fz = 2.4 + R() * 2.4, x = cx + i * CELL + (R() - 0.5) * 1.4, z = cz + j * CELL + (R() - 0.5) * 1.4, col = cols[Math.floor(R() * 3)];
    const ring = Math.max(0, Math.max(Math.abs(x - cx) - W / 2, Math.abs(z - cz) - dz / 2) - 4), back = x - cx + (z - cz) < 0, near = R() > 0.93 && !back; // back: behind the office as the camera sees it. A tall tower there would stand over the office in the picture, so the few tall neighbours are all in front
    const top = Math.max(-40, near ? -(3 + R() * 2) : -(6 + R() * 10 + ring * 0.8 + (R() > 0.75 ? 8 : 0) + (back ? 3 + 0.5 * Math.abs(x - cx + z - cz) : 0))); // the further behind, the lower: seen from above at an angle, a far roof would else show above our floor // most roofs are far below our floor; a few neighbours come to 3 to 5 under it
    if (x + fx / 2 > -2.6 && x - fx / 2 < W + 2.6 && z + fz / 2 > zb0 - 2.6 && z - fz / 2 < ZF + 2.6) continue; // our own tower stands here
    const AIR = 0.2 + 0.7 * Math.min(1, Math.max(0, -(0.565 * (x - cx) + 0.825 * (z - cz))) / 50);
    O("city:" + i + ":" + j, () => {
      const hz = (y: number) => AIR + (1 - AIR) * haze(y); // the air between the towers: a neighbour is never as crisp as our own floor. Towers far behind us show high in the picture, so they fade with distance too
      column(fx, fz, col, x, z, top, AIR); B(fx - 0.3, 0.1, fz - 0.3, "roof", x, top, z, { tint: hz(top) });
      if (!near && R() > 0.55) { const h = 1.5 + R() * 3, ux = x - fx * 0.1, uz = z - fz * 0.1; B(fx * 0.62, h, fz * 0.62, col, ux, top + 0.1, uz, { tint: hz(top) }); B(fx * 0.62 - 0.2, 0.1, fz * 0.62 - 0.2, "roof", ux, top + 0.1 + h, uz, { tint: hz(top) }); } // a set-back upper part
      else B(0.7, 0.35, 0.9, "roof", x + fx / 4 - 0.2, top + 0.1, z + fz / 4 - 0.2, { tint: hz(top) }); // roof plant
      for (let k = 0; k < 9; k++) { const y = top - 1.2 - k * 1.5; if (y < GROUND + 1) break; // window bands on the two sides that face the camera
        if (top > -20 && k < 7) { row(true, x, fx * 0.88, y, z + fz / 2 + 0.01, 0.3, 0.45, hz(y)); row(false, z, fz * 0.88, y, x + fx / 2 + 0.01, 0.3, 0.45, hz(y)); } // near towers: panes. Far ones: one plain strip per floor
        else { B(fx * 0.9, 0.6, 0.02, "cityWin2", x, y, z + fz / 2 + 0.01, { tint: hz(y) }); B(0.02, 0.6, fz * 0.9, "cityWin2", x + fx / 2 + 0.01, y, z, { tint: hz(y) }); } }
    }, "city", undefined, "city");
  }
}

// ---------- walk lines ----------
const dedupe = (pts: P2[]) => pts.filter((p, i) => !i || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.02);
/** Cut each corner a little, so a walker turns over a few steps and not on the spot. */
export function smooth(pts: P2[], r = 0.1): P2[] {
  const p = dedupe(pts), out: P2[] = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1], la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]), ra = Math.min(r, la / 2), rc = Math.min(r, lc / 2);
    out.push([b[0] + ((a[0] - b[0]) / la) * ra, b[1] + ((a[1] - b[1]) / la) * ra], [b[0] + ((c[0] - b[0]) / lc) * rc, b[1] + ((c[1] - b[1]) / lc) * rc]);
  }
  if (p.length > 1) out.push(p[p.length - 1]); return dedupe(out);
}
/** From beside the chair to the corridor: behind the row, along the lane, out through the door. */
export const pathOut = (d: LDesk): P2[] => smooth([d.hop, [d.hop[0], d.rowZ], [d.room.lane, d.rowZ], [d.room.doorX, d.room.z0 + LANE]]);
/** The coffee break: out through the door, along the corridor to the coffee point. */
export const breakPath = (d: LDesk): P2[] => smooth([d.hop, [d.hop[0], d.rowZ], [d.room.lane, d.rowZ], [d.room.doorX, d.room.z0 + LANE], [d.room.cooler!.x + 0.1, d.room.z0 + LANE + 0.06]]); // ends a step off the counter, so a turn with a mug in the hand clears it
/** Someone new: in from the end of the corridor, through the door, to the chair. */
export const joinPath = (d: LDesk, plan: Plan): P2[] => smooth([[plan.blocks[d.room.block].x1 - 0.35, d.room.z0 + LANE] as P2, [d.room.doorX, d.room.z0 + LANE] as P2, [d.room.lane, d.rowZ] as P2, [d.hop[0], d.rowZ] as P2, d.hop]);
/** A courier: desk front, the aisle if the desk is not in the front row, through the door and along the corridor if the rooms differ, the side passage if the blocks differ. */
export function route(A: LDesk, B: LDesk, sideX: number): P2[] {
  const strip = (d: LDesk) => d.room.z0 - STRIP;
  const out = (d: LDesk): P2[] => d.room.director ? [[d.room.lane, d.front[1]], [d.room.lane, strip(d)]] : d.row > 0 ? [[d.aisle, d.z + 0.72], [d.aisle, strip(d)]] : [[d.front[0], strip(d)]];
  if (A.room === B.room && A.row === B.row) return smooth([A.front, B.front]);
  if (A.room === B.room && A.row > 0 && B.row > 0 && A.aisle === B.aisle) return smooth([A.front, [A.aisle, A.z + 0.72], [B.aisle, B.z + 0.72], B.front]);
  const pts: P2[] = [A.front, ...out(A)];
  if (A.room !== B.room) {
    const za = A.room.z0 + CLINE, zb = B.room.z0 + CLINE;
    pts.push([A.room.doorX, strip(A)], [A.room.doorX, za]); if (A.room.block !== B.room.block) pts.push([sideX, za], [sideX, zb]); pts.push([B.room.doorX, zb], [B.room.doorX, strip(B)]);
  }
  pts.push(...out(B).reverse(), B.front); return smooth(pts);
}
/** Points every `step` along a line. */
export function sample(pts: P2[], step = 0.05): P2[] {
  const out: P2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); }
  return out;
}

// ---------- for the overlap check ----------
/** A layout box as the unit cube's matrix (column-major), the same way the renderer places it. dx = moved sideways (an open door leaf). */
export function toABox(b: LBox, dx = 0): ABox {
  const rx = b.rx || 0, ry = b.ry || 0, c = Math.cos(rx || ry), s = Math.sin(rx || ry), x = b.x + dx, y = b.y + b.h / 2, z = b.z;
  const m = rx ? [b.w, 0, 0, 0, 0, b.h * c, b.h * s, 0, 0, -b.d * s, b.d * c, 0, x, y, z, 1] : [b.w * c, 0, -b.w * s, 0, 0, b.h, 0, 0, b.d * s, 0, b.d * c, 0, x, y, z, 1];
  return { obj: b.obj, kind: b.kind, m };
}
/** Every walk line of the office: each person's way out, coffee break and way in, and a courier line between every two desks (w = how wide the walker is). */
export function allPaths(L: Layout): { name: string; pts: P2[]; w: number }[] {
  const ds = Object.values(L.desks), out: { name: string; pts: P2[]; w: number }[] = [];
  for (const d of ds) { out.push({ name: "out:" + d.name, pts: pathOut(d), w: WALKW }, { name: "in:" + d.name, pts: joinPath(d, L.plan), w: WALKW }); if (d.room.cooler) out.push({ name: "coffee:" + d.name, pts: breakPath(d), w: WALKW }); }
  for (const a of ds) for (const b of ds) if (a !== b) out.push({ name: "courier:" + a.name + ">" + b.name, pts: route(a, b, L.sideX), w: RUNW });
  return out;
}
/** The points to test walkers at: every walk line sampled, the same spot counted once per walker width. */
export function walkPoints(L: Layout): { w: number; pts: P2[]; paths: number }[] {
  const by = new Map<number, { seen: Set<string>; pts: P2[]; paths: number }>();
  for (const p of allPaths(L)) { let g = by.get(p.w); if (!g) by.set(p.w, (g = { seen: new Set(), pts: [], paths: 0 })); g.paths++; for (const q of sample(p.pts)) { const k = Math.round(q[0] * 100) + ":" + Math.round(q[1] * 100); if (!g.seen.has(k)) { g.seen.add(k); g.pts.push(q); } } }
  return [...by].map(([w, g]) => ({ w, pts: g.pts, paths: g.paths }));
}
