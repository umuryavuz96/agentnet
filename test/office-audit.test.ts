// The 3D office overlap check: touching is fine, sitting inside another object is a hit.
import { expect, test } from "bun:test";
import { depth, overlaps, pathHits, type ABox } from "../web/src/office3d/audit";

/** an upright box: size w,h,d, centre x,y,z, turned ry around the vertical */
const box = (obj: string, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, kind?: string): ABox => {
  const c = Math.cos(ry), s = Math.sin(ry);
  return { obj, kind, m: [w * c, 0, -w * s, 0, 0, h, 0, 0, d * s, 0, d * c, 0, x, y, z, 1] };
};

test("boxes that touch are not a hit; boxes inside each other are", () => {
  const desk = box("desk", 1.4, 0.06, 0.72, 0, 0.47, 0), cup = box("cup", 0.07, 0.08, 0.07, 0.3, 0.54, 0.2), sunk = box("cup2", 0.07, 0.08, 0.07, -0.3, 0.5, 0.2);
  expect(depth(desk.m, cup.m)).toBeLessThanOrEqual(0.001);
  expect(depth(desk.m, sunk.m)).toBeCloseTo(0.04, 3);
  const r = overlaps([desk, cup, sunk]);
  expect(r.hits).toEqual([{ a: "cup2", b: "desk", depth: 0.04 }]);
  expect(r.objects).toBe(3);
});

test("a turned box is tested as turned, not by its bounds", () => {
  const a = box("a", 1, 1, 1, 0, 0.5, 0), b = box("b", 1, 1, 1, 1.3, 0.5, 0, Math.PI / 4); // b's corner reaches x = 0.593, so it sits 0.093 inside a
  expect(depth(a.m, b.m)).toBeCloseTo(0.5 + Math.SQRT1_2 - 1.3, 3);
  const far = box("c", 1, 1, 1, 1.25, 0.5, 1.25, Math.PI / 4); // bounds overlap a's, the boxes do not
  expect(depth(a.m, far.m)).toBeLessThanOrEqual(0);
  expect(overlaps([a, far]).hits).toEqual([]);
});

test("boxes of one object may overlap; floors and rugs are stood on", () => {
  const leaves = [box("plant", 0.36, 0.25, 0.36, 0, 0.3, 0), box("plant", 0.28, 0.2, 0.28, 0, 0.45, 0)];
  const rug = box("rug", 3, 0.015, 2, 0, 0.0075, 0, 0, "surface"), leg = box("desk", 0.06, 0.44, 0.62, 0.5, 0.22, 0);
  expect(overlaps([...leaves, rug, leg]).hits).toEqual([]);
});

test("a walk path through a desk is reported, one beside it is not", () => {
  const desk = [box("desk:a", 1.4, 0.5, 0.72, 0, 0.25, 0)], chair = box("chair:a", 0.42, 0.6, 0.42, 0, 0.3, -0.55);
  const line = (z: number): [number, number][] => Array.from({ length: 41 }, (_, i) => [-2 + i * 0.1, z]);
  expect(pathHits("walk", line(0), [...desk, chair]).map((h) => h.b)).toEqual(["desk:a"]);
  expect(pathHits("walk", line(0.6), [...desk, chair])).toEqual([]);
  expect(pathHits("walk", line(-0.55), [...desk, chair], ["chair:a"])).toEqual([]);
});
