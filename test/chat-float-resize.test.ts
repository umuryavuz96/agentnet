import { expect, test } from "bun:test";
import { CURSOR, DIRS, MIN_H, MIN_W, resizeBox, type Box } from "../web/src/ui/chatDock";

// a float in a 1900 x 1040 page area, widest 1330 (70 % of 1900)
const A = { w: 1900, h: 1040 }, MW = 1330;
const b: Box = { x: 600, y: 200, w: 520, h: 600 };
const edges = (o: Box) => ({ l: o.x, t: o.y, r: o.x + o.w, btm: o.y + o.h });
const rz = (d: (typeof DIRS)[number], dx: number, dy: number, from = b) => resizeBox(from, d, dx, dy, A.w, A.h, MW);

test("each of the 8 directions moves only its own edges; the opposite ones stay put", () => {
  const e0 = edges(b);
  const cases: [(typeof DIRS)[number], Partial<ReturnType<typeof edges>>][] = [
    ["n", { t: e0.t - 80 }], ["s", { btm: e0.btm + 80 }], ["e", { r: e0.r + 80 }], ["w", { l: e0.l - 80 }],
    ["ne", { t: e0.t - 80, r: e0.r + 80 }], ["nw", { t: e0.t - 80, l: e0.l - 80 }],
    ["se", { btm: e0.btm + 80, r: e0.r + 80 }], ["sw", { btm: e0.btm + 80, l: e0.l - 80 }],
  ];
  for (const [d, moved] of cases) {
    const dx = d.includes("w") ? -80 : d.includes("e") ? 80 : 33, dy = d.includes("n") ? -80 : d.includes("s") ? 80 : 33;
    expect({ d, ...edges(rz(d, dx, dy)) }).toEqual({ d, ...e0, ...moved });
  }
  expect(DIRS).toHaveLength(8);
});

test("system cursors per direction", () => {
  expect(CURSOR).toEqual({ n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" });
});

test("min size: shrinking stops at MIN_W x MIN_H and the opposite edge still holds", () => {
  const e0 = edges(b);
  expect(rz("w", 900, 0)).toEqual({ x: e0.r - MIN_W, y: b.y, w: MIN_W, h: b.h });
  expect(rz("e", -900, 0)).toEqual({ x: b.x, y: b.y, w: MIN_W, h: b.h });
  expect(rz("n", 0, 900)).toEqual({ x: b.x, y: e0.btm - MIN_H, w: b.w, h: MIN_H });
  expect(rz("s", 0, -900)).toEqual({ x: b.x, y: b.y, w: b.w, h: MIN_H });
  expect(rz("se", -900, -900)).toEqual({ x: b.x, y: b.y, w: MIN_W, h: MIN_H });
  expect(rz("nw", 900, 900)).toEqual({ x: e0.r - MIN_W, y: e0.btm - MIN_H, w: MIN_W, h: MIN_H });
});

test("viewport clamp: no edge leaves the page area and the width stays under the max", () => {
  expect(rz("nw", -5000, -5000)).toEqual({ x: 0, y: 0, w: b.x + b.w, h: b.y + b.h });
  expect(rz("s", 0, 5000)).toEqual({ ...b, h: A.h - b.y });
  expect(rz("e", 5000, 0)).toEqual({ ...b, w: A.w - b.x }); // the page edge comes first here
  const left = { x: 100, y: 100, w: 520, h: 500 };
  expect(rz("e", 5000, 0, left)).toEqual({ ...left, w: MW }); // the max width comes first here
  const nearRight = { x: 1300, y: 100, w: 520, h: 500 };
  expect(rz("e", 5000, 0, nearRight)).toEqual({ ...nearRight, w: A.w - 1300 });
  const wide = { x: 400, y: 100, w: 1200, h: 500 };
  expect(rz("w", -5000, 0, wide)).toEqual({ x: 1600 - MW, y: 100, w: MW, h: 500 });
});
