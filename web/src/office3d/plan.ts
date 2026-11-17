// Floor plan for the miniature 3D office: rooms, desks, aisles and parked plots, from the live agentnet rows (no sample data).
// Pure: no DOM, no three.js. Units are the scene's units (a desk is 1.4 wide, a person 1.08 tall).
// One block = a strip of rooms side by side with a corridor in front of it. Wide offices wrap into more blocks, front to back.
export type PState = "working" | "idle" | "blocked";
export interface PSeat { x: number; z: number; row: number; up: boolean; alt: boolean }
export interface PAgent { name: string; model: string | null; state: PState; boss: string | null; doing: string; idleSince?: number; room: string; isLead: boolean; drawn: boolean; desk: PSeat }
export interface PTeam { id: string; name: string; lead: string | null; members: string[]; goal: string }
export interface PRoom {
  id: string; title: string; director: boolean; t?: PTeam; block: number;
  x0: number; x1: number; zb: number; z0: number; // left, right, back wall, front line (where the corridor starts)
  people: PAgent[]; live: number; hidden: number; aisles: number[]; lane: number; cooler: { x: number; z: number } | null; boardX: number;
  doorX: number; last: boolean; // the door is in the front partition, at the lane; last = the room at the right end of its block
}
export interface PPlot { id: string; name: string; members: number; x0: number; x1: number; z0: number; z1: number }
export interface PBlock { z0: number; zb: number; x1: number }
export interface PlanInput { agents: Omit<PAgent, "room" | "isLead" | "drawn" | "desk">[]; teams: PTeam[]; aspect: number }

export const COLW = 2.0, ROWD = 2.0, FRONT = -1.3, CORR = 1.2, LANE = 0.62, CLINE = 0.91, PLOTD = 1.3, MAXDRAW = 12, SIDE = 1.0;
// LANE: where people walk in the corridor, measured from the room's front line. CLINE: where couriers run, so the two never share a line.
// BACK: from the back row of desks to the back wall (chairs, the walkway behind them, then the board, screen and plant strip). STRIP: the walkway inside the front partition. DOORW: door gap.
export const BACK = 1.8, STRIP = 0.62, DOORW = 0.9;
export const clean = (s: string | null | undefined) => String(s || "").replace(/\s*\(task\)\s*$/, "");
// shirt colour by role: never the only signal (the label names the agent)
export const TINT: Record<string, number> = { director: 0x3a3a44, lead: 0xb8642e, dev: 0x2f7fa8, design: 0xa84e8e, craft: 0x6f9a44, other: 0x7a7a86 };
export const roleOf = (n: string) => n === "root" ? "director" : /lead|architect/.test(n) ? "lead" : /dev|backend|devops/.test(n) ? "dev" : /design|art|logo|lab/.test(n) ? "design" : /qa|critic|research|writer|social/.test(n) ? "craft" : "other";

/** Desks per row, back row first. Up to 6: two rows. 7 to 12: rows of three, the short row at the back. */
export function rowsFor(n: number): number[] {
  if (n <= 2) return [n];
  if (n <= 6) return [Math.floor(n / 2), Math.ceil(n / 2)];
  const r = Math.ceil(n / 3); return [n - 3 * (r - 1), ...Array(r - 1).fill(3)];
}

export function makePlan(inp: PlanInput) {
  const teams = inp.teams;
  const agents = inp.agents.map((a) => ({ ...a, room: "open", isLead: false, drawn: true, desk: { x: 0, z: 0, row: 0, up: false, alt: false } })) as PAgent[];
  const byName: Record<string, PAgent> = Object.fromEntries(agents.map((a) => [a.name, a]));
  for (const a of agents) a.isLead = a.name !== "root" && (agents.some((b) => b.boss === a.name && b.name !== a.name) || /^lead|^architect/.test(a.name) || teams.some((t) => t.lead === a.name));
  for (const a of agents) {
    if (a.name === "root") { a.room = "director"; continue; }
    const viaBoss = teams.find((t) => t.members.includes(a.name) && a.boss && t.members.includes(a.boss));
    a.room = (viaBoss || teams.find((t) => t.members.includes(a.name)) || { id: "open" }).id;
  }
  const inRoom = (id: string) => agents.filter((a) => a.room === id);
  const parked = teams.filter((t) => !inRoom(t.id).length);
  const ids = ["director", ...teams.filter((t) => inRoom(t.id).length).sort((x, y) => inRoom(y.id).length - inRoom(x.id).length).map((t) => t.id)];
  if (inRoom("open").length) ids.push("open");
  const rooms: PRoom[] = ids.map((id) => {
    const all = inRoom(id).sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name)), t = teams.find((tt) => tt.id === id), director = id === "director";
    const people = all.slice(0, MAXDRAW); for (const a of all.slice(MAXDRAW)) a.drawn = false;
    return { id, director, t, block: 0, title: director ? "Director" : id === "open" ? "Open desks" : (t?.name || id), x0: 0, x1: 0, zb: 0, z0: 0, people, live: all.length, hidden: all.length - people.length, aisles: [], lane: 0, cooler: null, boardX: 0, doorX: 0, last: false };
  });
  const rowsOf = (r: PRoom) => (r.director ? [1] : rowsFor(r.people.length));
  const widthOf = (r: PRoom) => (r.director ? 3.4 : 0.5 + COLW * Math.max(2, ...rowsOf(r)));
  const depthOf = (r: PRoom) => -(FRONT - ROWD * (Math.max(2, rowsOf(r).length) - 1) - BACK);
  const GAP = 0.12;
  // split the rooms, in order, into k blocks of about equal width
  function split(k: number): PRoom[][] {
    const total = rooms.reduce((s, r) => s + widthOf(r), 0), out: PRoom[][] = [[]]; let acc = 0;
    for (const r of rooms) { const cur = out[out.length - 1]; if (cur.length && out.length < k && acc + widthOf(r) / 2 > (total / k) * out.length) out.push([r]); else cur.push(r); acc += widthOf(r); }
    return out;
  }
  const plotRows = (W: number) => (parked.length ? Math.ceil(parked.length / Math.max(1, Math.floor(W / 3.2))) : 0);
  function measure(bl: PRoom[][]) {
    const W = Math.max(...bl.map((b) => b.reduce((s, r) => s + widthOf(r), 0) + GAP * (b.length - 1))) + (bl.length > 1 ? SIDE : 0);
    const D = bl.reduce((s, b) => s + Math.max(...b.map(depthOf)) + CORR, 0) + plotRows(W) * PLOTD;
    const sw = W * 0.825 + D * 0.565, sh = (W * 0.565 + D * 0.825) * 0.577 + 1.3; // screen size from the fixed three-quarter view
    return { W, D, half: Math.max(sh / 2, sw / 2 / Math.max(0.3, inp.aspect)) };
  }
  let blocksR = split(1), best = measure(blocksR).half;
  for (let k = 2; k <= Math.min(4, rooms.length); k++) { const b = split(k), h = measure(b).half; if (h < best * 0.97) { best = h; blocksR = b; } }
  const blocks: PBlock[] = []; let zCur = 0;
  blocksR.forEach((bl, bi) => {
    const depth = Math.max(...bl.map(depthOf)), z0 = zCur + depth, zb = zCur; let x = 0;
    for (const r of bl) {
      const w = widthOf(r), rows = rowsOf(r), C = Math.max(2, ...rows);
      Object.assign(r, { block: bi, x0: x, x1: x + w, zb, z0, lane: r.director ? x + w - 0.45 : x + 0.5, doorX: r.director ? x + w - 0.45 : x + 0.5, last: r === bl[bl.length - 1], boardX: x + w / 2 + 0.25 });
      const col = (i: number) => x + 1.5 + i * COLW;
      r.aisles = r.director ? [x + w - 0.45] : [r.lane, ...Array.from({ length: C - 1 }, (_, i) => col(i) + COLW / 2)];
      r.cooler = r.director ? null : { x: x + w - 0.75, z: z0 + 0.17 }; // the coffee point: in the corridor, against the outside of the front partition
      if (r.director) { const a = r.people[0]; if (a) a.desk = { x: x + 1.55, z: z0 - 2.0, row: 0, up: false, alt: false }; }
      else {
        let k = 0;
        rows.forEach((m, ri) => { // ri 0 = back row
          const row = rows.length - 1 - ri, zr = z0 + FRONT - ROWD * row, off = (C - m) / 2, list = r.people.slice(k, k + m); k += m;
          if (ri === 0 && list.length > 1) { const lead = list.shift()!; list.splice(Math.floor(m / 2), 0, lead); } // the lead sits in the middle of the back row
          list.forEach((a, i) => { a.desk = { x: col(i + off), z: zr, row, up: row > 0, alt: i % 2 === 1 }; });
        });
      }
      x += w + GAP;
    }
    blocks.push({ z0, zb, x1: x - GAP }); zCur = z0 + CORR;
  });
  const multi = blocks.length > 1, W = Math.max(...blocks.map((b) => b.x1)) + (multi ? SIDE : 0);
  // parked teams: plots in front of the last corridor, lights off
  const per = Math.max(1, Math.floor(W / 3.2)), plots: PPlot[] = [];
  parked.forEach((t, i) => { const row = Math.floor(i / per), n = Math.min(per, parked.length - row * per), w = W / n, c = i % per; plots.push({ id: t.id, name: t.name || t.id, members: t.members.length, x0: c * w + (c ? 0.1 : 0), x1: (c + 1) * w - (c < n - 1 ? 0.1 : 0), z0: zCur + row * PLOTD, z1: zCur + (row + 1) * PLOTD }); });
  const ZF = zCur + plotRows(W) * PLOTD;
  return { teams, agents, byName, rooms, blocks, plots, multi, W, ZF, sideX: W - SIDE / 2 };
}
export type Plan = ReturnType<typeof makePlan>;
