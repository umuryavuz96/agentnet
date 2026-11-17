// The 3D office floor: no object sits inside another, and no walk line runs through furniture. Checked on the same boxes the page draws.
import { expect, test } from "bun:test";
import { makePlan, type PState } from "../web/src/office3d/plan";
import { makeLayout, toABox, walkPoints, SLIDE, WALKW, WALKH, RUNH } from "../web/src/office3d/layout";
import { overlaps, pathHits } from "../web/src/office3d/audit";

/** an office of n people: the director, teams of mixed size, and one parked team */
function office(n: number) {
  const names = Array.from({ length: n - 1 }, (_, i) => "agent-" + (i + 1)), sizes = [2, 3, 12, 6, 9, 5, 11], teams = []; let k = 0;
  for (let t = 0; k < names.length; t++) { const m = names.slice(k, k + sizes[t % sizes.length]); k += m.length; teams.push({ id: "team-" + t, name: "Team " + t, lead: m[0], members: m, goal: "" }); }
  teams.push({ id: "parked", name: "Parked", lead: null, members: Array.from({ length: 14 }, (_, i) => "gone-" + i), goal: "" });
  const agents = [{ name: "root", model: null, state: "working" as PState, boss: null, doing: "" }, ...names.map((name) => ({ name, model: null, state: "working" as PState, boss: "root", doing: "" }))];
  return makeLayout(makePlan({ agents, teams, aspect: 1.6 }), { "team-0": ["pending", "in_progress", "pending"] });
}

for (const n of [6, 34, 49]) test(`${n} people: 0 overlaps, 0 walk lines through furniture`, () => {
  const L = office(n), boxes = L.boxes.map((b) => toABox(b));
  for (const d of L.doors) for (const b of L.boxes) if (b.ent === "leaf:" + d.id) boxes.push({ ...toABox(b, d.dir * SLIDE), obj: b.obj + ":open" }); // every door leaf is checked closed and slid open
  const r = overlaps(boxes), furn = boxes.filter((b) => b.kind !== "city" && b.kind !== "surface" && (b.kind !== "door" || b.obj.endsWith(":open"))) /* a walker meets the leaf slid open */, walks = walkPoints(L);
  const hits = walks.flatMap((g) => pathHits("walker " + g.w + " wide", g.pts, furn, [], g.w, g.w === WALKW ? WALKH : RUNH));
  console.log(`${n} people: ${r.objects} objects, ${r.boxes} boxes, ${r.pairs} pairs whose bounds cross, ${r.hits.length} overlaps; ${walks.reduce((s, g) => s + g.paths, 0)} walk lines, ${walks.reduce((s, g) => s + g.pts.length, 0)} points, ${hits.length} hits`);
  expect(Object.keys(L.desks).length).toBe(n);
  expect(r.hits).toEqual([]);
  expect(hits).toEqual([]);
});

test("the check sees a chair pushed into its desk, and a plant put on a walk line", () => {
  const L = office(6), name = Object.keys(L.desks)[1], d = L.desks[name];
  const boxes = L.boxes.map((b) => toABox(b)).map((b) => (b.obj === "chair:" + name ? { ...b, m: Object.assign([...(b.m as number[])], { 14: (b.m as number[])[14] + 0.5 }) } : b));
  expect(overlaps(boxes).hits.map((h) => [h.a, h.b])).toContainEqual(["chair:" + name, "desk:" + name]);
  const pot = { obj: "pot", m: [0.24, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.24, 0, d.room.lane, 0.1, d.rowZ, 1] };
  expect(walkPoints(L).flatMap((g) => pathHits("walker", g.pts, [pot], [], g.w)).length).toBeGreaterThan(0);
});
