<script setup lang="ts">
// 2D map, "Fiber tree" (board page 02): agent cards nested under their boss inside one region per team, neutral fibers from the
// director to every region and from each lead to its reports, a message as light running up to the nearest shared boss and
// down. Ported from docs/redesign/proto/fiber-2d.js onto live data (net.agents, teams, net.messages). Fit to view: try stage
// widths, keep the largest scale that fits with a 24 px margin (0.7 to 1.6); rerun on resize and when agents change.
// Look (2026-11-23): a team is a line in its own colour, an agent is a card on it (AgentCard.vue). The line docks at the height
// of the card's monogram; it steps back while the agent is idle and carries one soft pulse every few seconds while it works. A
// message is one beam of light in its kind's colour that runs the lines from sender to receiver. GSAP runs the camera glide and the team-name intro;
// card and fiber motion stay on the Web Animations code below (one system per property).
import gsap from "gsap";
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import { net, teams, layoutKey, teamsKey, placing, ctxView, type AgentRow } from "../net";
import { crewState, modelShort, type CrewState } from "../crewTree";
import { agoWords } from "../trail";
import AgentCard from "./AgentCard.vue";
import Icon from "../ui/Icon.vue";
import TrailPeek from "./TrailPeek.vue";

const props = defineProps<{ selected: string | null; cover?: number; hadRoot?: boolean; last?: { dir: string | null; at: number } | null }>();
const emit = defineEmits<{ select: [id: string]; details: [id: string]; resume: []; fresh: [] }>();

const strip = (n: string) => n.replace(/#\d+$/, "");
const live = computed(() => Object.values(net.agents).filter((a) => a.life === "live" && !placing.has(a.name)));
const byName = computed(() => new Map(live.value.map((a) => [strip(a.name), a])));
const ROOT = "root";
interface Person { id: string; name: string; row: AgentRow; state: CrewState; lead: boolean; boss: string | null; team: string }
const people = computed<Person[]>(() => {
  const rows = live.value, names = new Set(rows.map((a) => strip(a.name)));
  const tl = teams.list.filter((t) => t.state === "active");
  const bossOf = (a: AgentRow) => { const b = a.boss ? strip(a.boss) : null; return b && b !== strip(a.name) && names.has(b) ? b : null; };
  const kids = new Set(rows.map((a) => bossOf(a)).filter(Boolean) as string[]);
  return rows.map((a) => {
    const n = strip(a.name), b = bossOf(a), mine = tl.filter((t) => t.members.map(strip).includes(n));
    const t = n === ROOT ? null : mine.find((x) => b && x.members.map(strip).includes(b)) ?? mine[0] ?? null;
    // a team's lead is the one its record names; a team with no lead named has none (its members are peers).
    // Outside any team, a lead is whoever has reports.
    const lead = n !== ROOT && (t ? !!t.lead && strip(t.lead) === n : kids.has(n));
    return { id: a.id, name: n, row: a, state: crewState(a), lead, boss: b, team: n === ROOT ? "director" : t?.id ?? "open" };
  });
});
const root = computed(() => people.value.find((p) => p.name === ROOT) ?? null);
interface Region { id: string; title: string; goal: string; list: Person[] }
const regions = computed<Region[]>(() => {
  const tl = teams.list.filter((t) => t.state === "active");
  const rs: Region[] = tl.map((t) => ({ id: t.id, title: t.name && !t.name.includes("/") ? t.name : t.id, goal: t.goal ?? "", list: people.value.filter((p) => p.team === t.id) })).filter((r) => r.list.length);
  rs.sort((a, b) => b.list.length - a.list.length);
  const open = people.value.filter((p) => p.team === "open");
  if (open.length) rs.push({ id: "open", title: "No team", goal: "Agents that are not in a team.", list: open });
  return rs;
});
const openTasks = (p: Person) => (p.row.tasks ?? []).some((t) => t.status !== "done");
const isQuiet = (p: Person) => p.state === "idle" && p.id !== props.selected && !p.lead && !openTasks(p);
interface Tn { p: Person; kids: Tn[] }
interface Branch { cards: Tn[]; quiet: Person[] }
function branch(list: Person[], boss: string | null, all: Person[]): Branch {
  const here = list.filter((p) => (boss ? p.boss === boss : !p.boss || !list.some((b) => b.name === p.boss)));
  const fold = all.length > 3 ? here.filter(isQuiet) : [];
  return { cards: here.filter((p) => !fold.includes(p)).map((p) => ({ p, kids: [] as Tn[] })), quiet: fold };
}
const build = (list: Person[], boss: string | null, all: Person[]): Branch => {
  const b = branch(list, boss, all);
  for (const c of b.cards) { const k = build(list, c.p.name, all); c.kids = k.cards; if (k.quiet.length) quietOf.set(c.p.name, k.quiet); }
  return b;
};
const quietOf = new Map<string, Person[]>();
const trees = computed(() => { quietOf.clear(); return regions.value.map((r) => { const b = build(r.list, null, r.list); return { r, cards: b.cards, quiet: b.quiet, qmap: new Map(quietOf) }; }); });


// ---------- messages ----------
const KIND: Record<string, [string, string]> = { task: ["#f2b04a", "T"], report: ["#3ecf8e", "R"], question: ["#6aa8ff", "?"], answer: ["#b48cff", "A"], info: ["#38c6d9", "i"] };
const kindOf = (k: string) => KIND[k] ?? KIND.info;
const recent = computed(() => [...net.messages].sort((a, b) => b.at - a.at).slice(0, 3));
interface Flight { from: string; to: string; kind: string; id: number | null }
type MsgIn = { id: number | null; from: string; to: string; kind: string };
const flight = ref<Flight | null>(null);
const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastMsg: number | null = net.messages.reduce<number | null>((mx, m) => (m.id != null && (mx == null || m.id > mx) ? m.id : mx), null);
let raf = 0;
// one beam at a time: a message that arrives while one is flying waits for it to land (the newest two are kept)
const waiting: MsgIn[] = [];
function startFlight(m: MsgIn) {
  if (flight.value) { waiting.push(m); if (waiting.length > 2) waiting.shift(); return; }
  const to = byName.value.get(strip(m.to))?.id, col = kindOf(m.kind)[0];
  if (reduce) { glow(to, col, 200); return; } // reduced motion: no travel, the receiver's glow fades in and out
  flight.value = { from: strip(m.from), to: strip(m.to), kind: m.kind, id: m.id }; fs = { t0: 0, D: 0, landed: false, miss: 0 };
  cancelAnimationFrame(raf); raf = requestAnimationFrame(beamFrame);
}
function endFlight() { flight.value = null; const n = waiting.shift(); if (n) startFlight(n); }
watch(() => net.messages.length, () => {
  const fresh = net.messages.filter((m) => m.id != null && (lastMsg == null || m.id > lastMsg)); if (!fresh.length) return;
  lastMsg = Math.max(...fresh.map((m) => m.id!));
  for (const m of fresh.filter((x) => Date.now() - x.at < 10_000).slice(-3)) startFlight(m);
});

// ---------- layout: fit to view, fibers ----------
const host = ref<HTMLElement | null>(null), st = ref<HTMLElement | null>(null);
const W = ref(900), H = ref(600), phone = computed(() => W.value < 760);
// ---------- camera: pan / zoom the stage and the fibers as one transform ----------
const view = ref({ x: 0, y: 0, k: 1 }), fib = ref<SVGSVGElement | null>(null);
let userView = false;
function applyView() {
  const v = view.value, t = phone.value && v.k === 1 ? "none" : `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  if (st.value) st.value.style.transform = t;
  // the plan grid moves with the camera (paint only): position and cell size follow the view
  const h = host.value, on = t !== "none";
  if (h) { h.style.setProperty("--gx", (on ? v.x : 0) + "px"); h.style.setProperty("--gy", (on ? v.y : 0) + "px"); h.style.setProperty("--g1", 28 * (on ? v.k : 1) + "px"); h.style.setProperty("--g5", 140 * (on ? v.k : 1) + "px"); }
}
/** Camera glide (GSAP, transform only): Fit and bringing a picked card into view travel there; a touch of the map stops it. */
let camTween: gsap.core.Tween | null = null, glide = false;
const stopCam = () => { camTween?.kill(); camTween = null; };
const gctx = gsap.context(() => {});
const KMIN = 0.4, KMAX = 2;
function zoomAt(f: number, cx: number, cy: number) {
  const v = view.value, k = Math.max(KMIN, Math.min(KMAX, v.k * f)), r = k / v.k;
  userView = true;
  if (phone.value) { // phone: the page scrolls natively; scale from the top left and keep the point under the fingers still
    const h = host.value!, px = h.scrollLeft + cx, py = h.scrollTop + cy; view.value = { k, x: 0, y: 0 }; applyView(); h.scrollLeft = px * r - cx; h.scrollTop = py * r - cy; return;
  }
  view.value = { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r }; applyView();
}
const ptrs = new Map<number, { x: number; y: number }>();
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null, pinch: { d: number; k: number } | null = null, panned = false;
const local = (e: { clientX: number; clientY: number }) => { const r = host.value!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const onDown = (e: PointerEvent) => {
  stopCam();
  ptrs.set(e.pointerId, local(e));
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.value.k }; drag = null; panned = true; }
  else if (ptrs.size === 1 && !phone.value) drag = { x: e.clientX, y: e.clientY, vx: view.value.x, vy: view.value.y, moved: false };
};
const onMove = (e: PointerEvent) => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, local(e));
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    zoomAt(Math.max(KMIN, Math.min(KMAX, pinch.k * d / pinch.d)) / view.value.k, (a.x + b.x) / 2, (a.y + b.y) / 2); return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  // capture only once a real drag starts, so a plain tap still reaches the card
  if (!drag.moved) (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  drag.moved = true; panned = true; userView = true; view.value = { ...view.value, x: drag.vx + dx, y: drag.vy + dy }; applyView();
};
const onUp = (e: PointerEvent) => {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0) { panned = panned || !!drag?.moved; drag = null; setTimeout(() => { panned = false; }, 60); }
};
/** Trackpad like Figma/Maps: two-finger scroll pans, pinch (sent as ctrl+wheel) zooms at the cursor. */
const onWheel = (e: WheelEvent) => {
  if (phone.value) return;
  e.preventDefault(); stopCam();
  const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H.value : 1, dx = e.deltaX * m, dy = e.deltaY * m;
  if (e.ctrlKey || e.metaKey) { const p = local(e); zoomAt(Math.exp(-dy * 0.01), p.x, p.y); return; }
  userView = true; view.value = { ...view.value, x: view.value.x - dx, y: view.value.y - dy }; applyView();
};
const swallow = (e: MouseEvent) => { if (panned) { e.stopPropagation(); e.preventDefault(); } };
const refit = () => { userView = false; needFit = true; glide = true; if (phone.value) { host.value!.scrollLeft = 0; } void layout(); };
const onDbl = (e: MouseEvent) => { if (!(e.target as Element).closest(".fcard, .fquiet, .fit")) refit(); };
const paths = ref<{ key: string; d: string; sel: boolean; hot: boolean; th: number | null; q: boolean; len: number }[]>([]);
/** Fibers and ports that just left: drawn once more at their last place while they fade out. */
const ghosts = ref<{ key: string; d: string; x: number; y: number }[]>([]);
let ghostN = 0;
type Pt = [number, number];
const link = new Map<string, { up: string; pts: Pt[]; rg: string }>();
const chainOf = (n: string) => { const c = [n]; while (link.has(c[0])) c.unshift(link.get(c[0])!.up); return c; };
/** Where a line enters a card: the height of the middle of its dot mark. A line leaves a card (or a team node) from a ring on its
 *  bottom edge, SPINE px in from the left, and runs down past the cards under it. */
const DOCK = 28, SPINE = 20;
function dPath(pts: Pt[], rad = 14) {
  let s = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const r1 = Math.min(rad, Math.hypot(x1 - x0, y1 - y0) / 2, Math.hypot(x2 - x1, y2 - y1) / 2);
    s += ` L${x1 - Math.sign(x1 - x0) * r1},${y1 - Math.sign(y1 - y0) * r1} Q${x1},${y1} ${x1 + Math.sign(x2 - x1) * r1},${y1 + Math.sign(y2 - y1) * r1}`;
  }
  const z = pts[pts.length - 1]; return s + ` L${z[0]},${z[1]}`;
}
const cardEl = (id: string) => st.value?.querySelector<HTMLElement>(`.fcard[data-id="${CSS.escape(id)}"]`) ?? null;
let seq = 0, needFit = true;
/** Layout box of an element in stage coordinates from offsets: ignores the FLIP transforms that may be running. */
function lbox(el: HTMLElement) { const s = st.value!; let x = 0, y = 0, e: HTMLElement | null = el; while (e && e !== s) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent as HTMLElement | null; } return { l: x, t: y, r: x + el.offsetWidth, b: y + el.offsetHeight }; }
async function layout() {
  const me = ++seq; await nextTick(); const h = host.value, s = st.value; if (!h || !s || me !== seq) return;
  W.value = h.clientWidth; H.value = h.clientHeight;
  stopCam(); const from = { ...view.value };
  const M = 24, TOP = 44, BOT = 52, aw = W.value - 2 * M, ah = H.value - TOP - BOT - 2 * M, hr = () => h.getBoundingClientRect();
  const oldW = s.offsetWidth;
  s.style.transform = "none"; s.style.left = "0px"; s.style.top = "0px"; s.style.width = "";
  let fit = { x: 0, y: 0, k: 1 }, best_h = 0;
  const rsEls = () => [...s.querySelectorAll<HTMLElement>(".frg:not(.fm-gone), .fdir > .fcard")];
  if (!phone.value) {
    const measure = (): [number, number] => { const rs = rsEls().map(lbox); if (!rs.length) return [1, 1]; return [Math.max(...rs.map((r) => r.r)) - Math.min(...rs.map((r) => r.l)) + 4, Math.max(...rs.map((r) => r.b)) + 4]; };
    let best: { sw: number; w: number; h: number; k: number; fill: number } | null = null;
    for (let sw = 640; sw <= 4200; sw += 80) {
      s.style.width = sw + "px"; const [w, hh] = measure(), kk = Math.min(aw / w, ah / hh, 1.6), fill = Math.min(1, (w * kk) / aw) * Math.min(1, (hh * kk) / ah);
      if (!best || kk > best.k + 0.01 || (Math.abs(kk - best.k) <= 0.01 && fill > best.fill)) best = { sw, w, h: hh, k: kk, fill };
    }
    const k = Math.max(0.7, best!.k); s.style.width = best!.sw + "px"; s.style.width = measure()[0] + "px";
    fit = { k, x: M + Math.max(0, (aw - best!.w * k) / 2), y: TOP + M + Math.max(0, (ah - best!.h * k) / 2) }; // TOP: the page's controls float over the map's top edge
    best_h = best!.h;
  } else s.style.width = W.value + "px";
  // fit on open, resize and Fit; a live change keeps the camera where it is (the stage stays centred on the same point), unless
  // the user has not moved the camera and the map no longer fits: a card grew or an agent joined, so the lowest card would
  // slide under the Recent strip (verifier-4, 1440x900)
  const spill = !phone.value && !userView && (view.value.y + best_h * view.value.k > H.value - BOT - M + 1 || view.value.k > fit.k + 0.01);
  if ((needFit || spill) && !userView) { if (spill && !needFit) glide = true; view.value = fit; }
  else if (!phone.value && oldW) view.value = { ...view.value, x: view.value.x + ((oldW - s.offsetWidth) / 2) * view.value.k };
  if (rsEls().length) needFit = false;
  applyView();
  // pan the picked card into view (phone: near the top, above the half sheet; desktop only while the user has not moved the camera)
  const sc = props.selected ? cardEl(props.selected) : null;
  if (sc) {
    const m = hr(), r = sc.getBoundingClientRect();
    if (phone.value) h.scrollTop += r.top - m.top - 40;
    // the side panel floats over the right of the map (the map keeps its size): keep the picked card in the part it leaves free
    else if (!userView && (r.left < m.left + M || r.right > m.right - (props.cover ?? 0) - M || r.top < m.top + TOP + M || r.bottom > m.bottom - BOT)) {
      view.value = { ...view.value, x: view.value.x + (m.left + (W.value - (props.cover ?? 0)) / 2 - (r.left + r.width / 2)), y: view.value.y + (m.top + (H.value - BOT) / 2 - (r.top + r.height / 2)) }; applyView(); glide = true;
    }
  }
  const to = { ...view.value };
  if (glide && booted && !reduce && !phone.value && (Math.abs(to.x - from.x) > 1 || Math.abs(to.y - from.y) > 1 || Math.abs(to.k - from.k) > 0.005)) {
    const cam = { ...from }; view.value = from; applyView();
    camTween = gsap.to(cam, { ...to, duration: 0.55, ease: "power3.out", onUpdate: () => { view.value = { ...cam }; applyView(); }, onComplete: () => { camTween = null; fibers(); } });
  }
  glide = false;
  fibers(); flip(); drawNew(); watchBoxes();
}
/** Fibers in stage coordinates from the cards as drawn (FLIP transforms included), so they follow moving cards every frame.
 *  Every fiber starts and ends on a port: a dot on the edge it belongs to (director bottom, region top, card left, parent bottom). */
function fibers() {
  const s = st.value, h = host.value; if (!s || !h) return;
  const o = s.getBoundingClientRect(), kk = phone.value ? 1 : view.value.k, box = (el: Element) => { const r = el.getBoundingClientRect(); return { l: (r.left - o.left) / kk, t: (r.top - o.top) / kk, r: (r.right - o.left) / kk, b: (r.bottom - o.top) / kk }; };
  link.clear(); const extra: { key: string; pts: Pt[]; rg: string }[] = [];
  const rootEl = cardEl(ROOT_ID()), rc = rootEl ? box(rootEl) : null;
  const rbox = regions.value.map((r) => { const el = s.querySelector<HTMLElement>(`.frg[data-r="${CSS.escape(r.id)}"]`); if (!el) return null; const b = box(el), [ox, oy] = running(el); return { r, el, b: { l: b.l + ox, t: b.t + oy, r: b.r + ox, b: b.b + oy }, row: el.offsetTop }; }).filter((x): x is NonNullable<typeof x> => !!x);
  // rows of regions (same layout top), so a wrapped row's fiber drops through a gap that is clear in every row above it
  const rowTops = [...new Set(rbox.map((x) => x.row))].sort((a, b) => a - b), rowOf = (t: number) => rowTops.indexOf(t);
  const viaFor = (cx: number, ri: number) => {
    const up = rbox.filter((x) => rowOf(x.row) < ri), clear = (gx: number) => up.every((x) => gx < x.b.l - 6 || gx > x.b.r + 6);
    const cand = [...up.map((x) => x.b.r + 11), Math.min(...up.map((x) => x.b.l)) - 16, Math.max(...up.map((x) => x.b.r)) + 16].filter(clear);
    return cand.reduce((a, g) => (Math.abs(g - cx) < Math.abs(a - cx) ? g : a), cand[0]);
  };
  const clean = (pts: Pt[]) => pts.filter((p0, j) => !j || p0[0] !== pts[j - 1][0] || p0[1] !== pts[j - 1][1]);
  for (const { r, el, b, row } of rbox) {
    const hb0 = box(el.querySelector(".frg-h")!), hb = { l: hb0.l + (b.l - box(el).l), t: hb0.t + (b.t - box(el).t), r: hb0.r + (b.l - box(el).l), b: hb0.b + (b.t - box(el).t) }, dx = (hb.l + hb.r) / 2, sx = hb.l + SPINE; // the trunk enters the team node at its top centre
    if (rc && phone.value) { const tx = rc.l - 14; link.set("rg:" + r.id, { up: ROOT_ID(), rg: r.id, pts: clean([[rc.l, rc.t + DOCK], [tx, rc.t + DOCK], [tx, hb.t - 12], [dx, hb.t - 12], [dx, hb.t]]) }); }
    else if (rc) {
      const cx = (rc.l + rc.r) / 2, bus = rc.b + 20, ri = rowOf(row), gx = ri > 0 ? viaFor(dx, ri) : null;
      link.set("rg:" + r.id, { up: ROOT_ID(), rg: r.id, pts: clean(gx == null ? [[cx, rc.b], [cx, bus], [dx, bus], [dx, hb.t]] : [[cx, rc.b], [cx, bus], [gx, bus], [gx, hb.t - 13], [dx, hb.t - 13], [dx, hb.t]]) });
    }
    el.querySelectorAll<HTMLElement>(".fcard, .fquiet").forEach((c) => {
      const id = c.dataset.id, cb = box(c), nested = c.parentElement!.classList.contains("fkids");
      let x: number, up: string;
      // one continuous line: a top card hangs off the region's entry dot down the gutter; a report hangs off its lead's own dot,
      // stepping 14 px out into the gap left of the lead and down, so every dot carries a line in and a line out (leaf cards only in)
      const y = cb.t + (c.classList.contains("fquiet") ? 16 : DOCK);
      let pts: Pt[];
      if (nested) { const be = c.parentElement!.previousElementSibling as HTMLElement, pb = box(be); x = pb.l + SPINE; up = be.dataset.id!; pts = [[x, pb.b], [x, y], [cb.l, y]]; }
      else { x = sx; up = "rg:" + r.id; pts = [[x, hb.b], [x, y], [cb.l, y]]; }
      if (id) link.set(id, { up, rg: r.id, pts }); else extra.push({ key: "q" + extra.length + r.id, pts, rg: r.id });
    });
  }
  const next = { links: [...link.entries()].map(([key, l]) => ({ key, pts: l.pts.map((q): Pt => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10]), rg: l.rg })), extra }, sig = JSON.stringify(next);
  // only a real change re-renders the fibers (fibers() also runs after every render, so an equal result must not trigger one)
  if (sig !== geoSig) { geoSig = sig; fiberGeo.value = next; }
}
let geoSig = "";
const fiberGeo = ref<{ links: { key: string; pts: Pt[]; rg: string }[]; extra: { key: string; pts: Pt[]; rg: string }[] }>({ links: [], extra: [] });

// ---------- hover: a peek next to the card and its chain lit (desktop with a mouse only) ----------
const fine = typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;
const hover = ref<{ id: string; x: number; y: number; on: boolean; ox?: string } | null>(null), pop = ref<HTMLElement | null>(null);
let hoverT = 0, leaveT = 0;
// One clock for hover: nothing changes until `hover.on` flips, and every part (card, lines, ports, neighbours, peek) reads that
// one flag in the same render, with the same duration and easing (--hv-d, --hv-e). In waits HV_IN so a pass-over does nothing;
// out waits HV_OUT so the pointer can reach the peek.
const HV_IN = 70, HV_OUT = 120;
const hotId = computed(() => (hover.value?.on ? hover.value.id : null));
const shown = ref<{ id: string; x: number; y: number; ox?: string } | null>(null);
watch(hover, (v) => { if (v) shown.value = v; }, { flush: "sync" });
function onHover(id: string, on: boolean, el: HTMLElement) {
  if (!fine || phone.value) return;
  clearTimeout(leaveT); clearTimeout(hoverT);
  if (!on) { leaveT = window.setTimeout(() => { hover.value = null; }, HV_OUT); return; }
  if (hotId.value === id) return;
  hoverT = window.setTimeout(() => void place(id, el), HV_IN);
}
// a team's field lights with a hovered card inside it, or with its own header, on the same clock
const rgHov = ref<string | null>(null); let rgT = 0;
const onRgHover = (id: string, on: boolean) => { if (!fine || phone.value) return; clearTimeout(rgT); rgT = window.setTimeout(() => { rgHov.value = on ? id : null; }, on ? HV_IN : HV_OUT); };
const hotRg = computed(() => { const id = hotId.value; return (id && people.value.find((p) => p.id === id)?.team) || rgHov.value; });
const popIn = () => clearTimeout(leaveT);
const popOut = () => { leaveT = window.setTimeout(() => { hover.value = null; }, HV_OUT); };
async function place(id: string, el: HTMLElement) {
  if (drag?.moved || !el.isConnected) return;
  const was = hover.value; hover.value = { id, x: was?.x ?? 0, y: was?.y ?? 0, on: false, ox: was?.ox }; await nextTick(); const pe = pop.value, h = host.value; if (!pe || !h) return;
  const m = h.getBoundingClientRect(), r = el.getBoundingClientRect(), pw = pe.offsetWidth, ph = pe.offsetHeight, right = W.value - (props.cover ?? 0) - 8;
  // right of the card first (its fibers enter on the left), then left of it; kept inside the part of the map the panel leaves free
  let x = r.right - m.left + 12, ox = "left"; if (x + pw > right) { x = r.left - m.left - 12 - pw; ox = "right"; } x = Math.max(8, Math.min(x, right - pw));
  const y = Math.max(8, Math.min(r.top - m.top, H.value - 52 - ph - 8));
  hover.value = { id, x, y, on: true, ox }; // it grows from the corner next to its card
}
const peek = computed(() => {
  const id = shown.value?.id; if (!id) return null; const p = people.value.find((x) => x.id === id); if (!p) return null;
  const r = p.row, c = ctxView(r), tasks = r.tasks ?? [], cur = tasks.find((t) => t.status === "in_progress"), done = tasks.filter((t) => t.status === "done").length, now = net.now || Date.now();
  const team = regions.value.find((x) => x.list.some((q) => q.id === id));
  const rows: [string, string][] = [];
  if (r.model) rows.push(["Model", [modelShort(r.model), r.effort].filter(Boolean).join(" · ")]);
  if (c) rows.push(["Context", `${Math.round(c.pct)}%`]);
  if (r.cost != null) rows.push(["Cost so far", `$${r.cost.toFixed(2)}`]);
  if (tasks.length) rows.push(["Task", `${done}/${tasks.length}${cur ? ` · ${cur.text}` : ""}`]);
  if (r.lastMsg) rows.push(["Last message", `${r.lastMsg.dir === "in" ? "from" : "to"} ${strip(r.lastMsg.peer)}, ${agoWords(now - r.lastMsg.at)}`]);
  if (p.boss) rows.push(["Boss", p.boss]);
  if (team) rows.push(["Team", team.title]);
  const since = r.spawnedAt ?? r.lifeSince; if (since) rows.push(["Up for", agoWords(now - since).replace(" ago", "").replace("now", "under 2 min")]);
  return { name: p.name, row: r, rows };
});
watch(() => props.selected, () => { hover.value = null; });

/** The picked chain (agent: up to the director; team: its region) and the hovered chain (up to the director and every report under it). */
const selKeys = computed(() => {
  const sel = props.selected, g = fiberGeo.value; if (!sel) return new Set<string>();
  if (sel.startsWith("team:")) { const t = sel.slice(5); return new Set([...g.links, ...g.extra].filter((l) => l.rg === t).map((l) => l.key)); }
  return new Set(chainOf(sel));
});
const hotKeys = computed(() => {
  const id = hotId.value, g = fiberGeo.value; if (!id) return new Set<string>();
  const out = new Set(chainOf(id)); for (const l of g.links) if (chainOf(l.key).includes(id)) out.add(l.key);
  return out;
});
/** Lines that carry work: the line into each working agent and the trunk into its team. The rest of an agent's lines step back while it is idle. */
const workIds = computed(() => new Set(people.value.filter((p) => p.state === "working").flatMap((p) => [p.id, "rg:" + p.team])));
const idleIds = computed(() => new Set(people.value.filter((p) => p.state === "idle").map((p) => p.id)));
/** The work pulse: one streak per line every PULSE ms, the trunk first, then each level under it, each line a little after the
 *  one above. Every line takes its delay from the page clock when it first shows, so all pulses stay on one clock. */
const PULSE = 3200, pulseAt = new Map<string, number>();
const pulses = computed(() => {
  let i = 0;
  return paths.value.filter((p) => workIds.value.has(p.key)).map((p) => {
    const trunk = p.key.startsWith("rg:"); let at = pulseAt.get(p.key);
    if (at == null) { at = (trunk ? 0 : (chainOf(p.key).length - 2) * 1300) + (trunk ? 0 : i * 250) - (performance.now() % PULSE) - PULSE * 2; pulseAt.set(p.key, at); }
    if (!trunk) i++;
    return { key: p.key, d: p.d, len: p.len, at };
  });
});
const pathLen = (pts: Pt[]) => { let n = 0; for (let j = 1; j < pts.length; j++) n += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]); return Math.round(n); };
interface Port { k: string; x: number; y: number; sel: boolean; hot: boolean; st: string; th: number | null }
const ports = ref<Port[]>([]);
/** A fiber inside a team takes the team's colour; the trunks from the director and the "No team" group stay neutral. */
const lineHue = (key: string, rg: string) => (key.startsWith("rg:") || rg === "open" ? null : hueOf.value.get(rg) ?? null);
watch([fiberGeo, selKeys, hotKeys, () => people.value.map((p) => p.id + p.state).join("|")], () => {
  const g = fiberGeo.value, sk = selKeys.value, hk = hotKeys.value;
  const was = paths.value;
  // the order never changes (moving a path in the DOM would cut its transition): the hovered and the picked chain are overlays
  // above every line, shown by opacity, so a shared trunk shows their colour
  paths.value = [...g.links, ...g.extra].map((l) => ({ key: l.key, d: dPath(l.pts), sel: sk.has(l.key), hot: hk.has(l.key), th: lineHue(l.key, l.rg), q: idleIds.value.has(l.key) || !link.has(l.key), len: pathLen(l.pts) }));
  if (booted) {
    const now = new Set(paths.value.map((p) => p.key)), out = was.filter((p) => !now.has(p.key));
    if (out.length) {
      const gs = out.map((p) => { const e = /(-?[\d.]+),(-?[\d.]+)$/.exec(p.d); return { key: "g" + ghostN++ + p.key, d: p.d, x: e ? +e[1] : 0, y: e ? +e[2] : 0 }; }), ks = new Set(gs.map((x) => x.key));
      ghosts.value = [...ghosts.value, ...gs]; window.setTimeout(() => { ghosts.value = ghosts.value.filter((x) => !ks.has(x.key)); }, OUT + 40);
    }
  }
  // ports: one dot per fiber end, shared ends drawn once; a port is picked or lit when any fiber through it is
  // a port is named after the card or region it sits on (the fiber's own end, or the start it shares with its siblings),
  // so it keeps its element while fibers come and go around it
  const pm = new Map<string, Port>(), names = new Set<string>(), stOf = new Map(people.value.map((p) => [p.id, p.state as string]));
  for (const l of [...g.links, ...g.extra]) [l.pts[0], l.pts[l.pts.length - 1]].forEach((q, end) => {
    const key = Math.round(q[0]) + ":" + Math.round(q[1]); let cur = pm.get(key);
    if (!cur) { let k = end ? "b:" + l.key : "a:" + (link.get(l.key)?.up ?? l.key); while (names.has(k)) k += "'"; names.add(k); cur = { k, x: q[0], y: q[1], sel: false, hot: false, st: "", th: l.rg === "open" ? null : hueOf.value.get(l.rg) ?? null }; pm.set(key, cur); }
    cur.sel ||= sk.has(l.key); cur.hot ||= hk.has(l.key);
    // the end of a fiber on a card is that agent's state lamp (a quiet fold's end is an unlit lamp)
    if (end) cur.st = stOf.get(l.key) ?? (l.key.startsWith("rg:") ? cur.st : cur.st || "idle");
  });
  ports.value = [...pm.values()];
});

// ---------- motion, ported from the map board (23-map-network): on load the fibers draw out from the director level by level
// (e-draw, 420 ms) and each region and card fades in after its fiber (nd-in, 260 ms, opacity only). A live change uses the same
// two moves: a new agent's fiber draws, then its card fades in; one that leaves fades out with its fiber; the rest glide to
// their new places (FLIP, transform only) with the fibers attached every frame. Reduced motion: fades only, no delays. ----------
interface Pos { x: number; y: number; w: number; el: HTMLElement; par: string | null }
let prevPos = new Map<string, Pos>(), followUntil = 0, followRaf = 0, booted = false, bootAt = 0, seenF = new Set<string>(), seenP = new Set<string>();
const EASE = "cubic-bezier(.2,.8,.2,1)", ND = 260, DRAW = 420, STEP = 260, OUT = 220, MOVE = 320;
// the board's delays: a card fades in at 80 + depth x 260 ms, its fiber starts 200 ms before it; a region's fiber at 0, the region at 260
const depthOf = (el: HTMLElement) => { if (el.closest(".fdir")) return 0; let d = 1; for (let e = el.parentElement; e && e !== st.value; e = e.parentElement) if (e.classList.contains("fkids")) d++; return d; };
const nodeAt = (key: string, el: HTMLElement) => (key.startsWith("r:") ? STEP : 80 + depthOf(el) * STEP);
const fiberAt = (key: string) => (key.startsWith("rg:") ? 0 : Math.max(1, chainOf(key).length - 2) * STEP - 120);
/** A region never gets a transform or an opacity of its own: that would make it one layer, and the fibers could not sit between
 *  its background and its cards. Its background (::before) and its header move and fade instead; its cards move by themselves. */
const hdr = (el: Element) => (el.classList.contains("frg") ? el.querySelector<HTMLElement>(".frg-h") : null);
const anim = (el: Element, kf: Keyframe[], opt: KeyframeAnimationOptions) => { const h = hdr(el); return h ? [h.animate(kf, opt), el.animate(kf, { ...opt, pseudoElement: "::before" })] : [el.animate(kf, opt)]; };
const fade = (el: Element, delay: number) => anim(el, [{ opacity: 0 }, { opacity: 1 }], reduce ? { duration: 300, easing: "ease", fill: "backwards" } : { duration: ND, delay: Math.max(0, delay), easing: EASE, fill: "backwards" });
/** The map waits (hidden) for the team list, so the load motion plays once on the settled layout; at most half a second. */
const ready = ref(false); let readyT = 0;
watch([() => live.value.length > 0, () => teams.list.length], ([has, tn]) => {
  if (ready.value || !has) return;
  if (tn) ready.value = true; else readyT ||= window.setTimeout(() => { ready.value = true; }, 500);
}, { immediate: true });
function posMap() {
  const s = st.value!, cw = s.offsetWidth / 2, m = new Map<string, Pos>();
  const add = (key: string, el: HTMLElement, par: string | null) => { const b = lbox(el); m.set(key, { x: b.l - cw, y: b.t, w: el.offsetWidth, el, par }); };
  s.querySelectorAll<HTMLElement>(".frg:not(.fm-gone)").forEach((e) => add("r:" + e.dataset.r, e, null));
  s.querySelectorAll<HTMLElement>(".fcard:not(.fm-gone), .fquiet:not(.fm-gone)").forEach((e) => { const rg = e.closest<HTMLElement>(".frg"); add("c:" + (e.dataset.id ?? e.dataset.q), e, rg ? "r:" + rg.dataset.r : null); });
  return m;
}
/** Where a running FLIP has the element right now, so a new change starts from what is on screen (interruptible). */
const flips = new WeakMap<HTMLElement, Animation[]>();
const running = (el: HTMLElement): Pt => { if (!flips.get(el)?.some((x) => x.playState === "running")) return [0, 0]; const m = new DOMMatrixReadOnly(getComputedStyle(hdr(el) ?? el).transform); return [m.m41, m.m42]; };
function follow() { followUntil = performance.now() + MOVE + 40; if (followRaf) return; const tick = () => { fibers(); if (performance.now() < followUntil) followRaf = requestAnimationFrame(tick); else { followRaf = 0; fibers(); } }; followRaf = requestAnimationFrame(tick); }
function flip() {
  const s = st.value; if (!s || !ready.value) return;
  const cur = posMap(); if (!cur.size) return;
  const boot = !booted; let moved = false;
  if (boot) { booted = true; bootAt = performance.now(); }
  // new regions and cards fade in after their fiber; in a live change the first new fiber starts at once
  const fresh = [...cur].filter(([key]) => !prevPos.has(key));
  const base = boot ? 0 : Math.min(...fresh.map(([key, c]) => (c.par && !prevPos.has(c.par) ? Infinity : key.startsWith("r:") ? 0 : nodeAt(key, c.el) - 200)));
  for (const [key, c] of fresh) fade(c.el, nodeAt(key, c.el) - base);
  // team signage comes in word by word after its line (GSAP; the words are aria-hidden copies, the name itself is never split)
  if (!reduce) gctx.add(() => {
    for (const [key, c] of fresh) { if (!key.startsWith("r:")) continue; const ws = c.el.querySelectorAll(".fw"); if (ws.length) gsap.from(ws, { yPercent: 70, opacity: 0, duration: 0.5, ease: "power3.out", stagger: 0.05, delay: Math.max(0, nodeAt(key, c.el) - base) / 1000, clearProps: "transform,opacity" }); }
    if (boot && host.value) gsap.from(host.value.querySelectorAll(".fit, .fstrip"), { opacity: 0, duration: 0.4, delay: 0.7, ease: "power1.out", clearProps: "opacity" });
  });
  if (!boot) {
    for (const [key, c] of cur) {
      const p = prevPos.get(key); if (!p) continue;
      const mx = p.x - c.x, my = p.y - c.y;
      if (Math.abs(mx) < 0.5 && Math.abs(my) < 0.5) continue;
      const [rx, ry] = running(c.el); moved = true;
      flips.get(c.el)?.forEach((x) => x.cancel());
      flips.set(c.el, anim(c.el, reduce ? [{ opacity: 0.4 }, { opacity: 1 }] : [{ transform: `translate(${mx + rx}px,${my + ry}px)` }, { transform: "none" }], { duration: reduce ? 200 : MOVE, easing: EASE }));
    }
    for (const [key, p] of prevPos) {
      if (cur.has(key) || p.el.isConnected || (p.par && !cur.has(p.par) && prevPos.has(p.par))) continue;
      moved = true; const g = p.el; g.classList.add("fm-gone");
      Object.assign(g.style, { position: "absolute", left: p.x + s.offsetWidth / 2 + "px", top: p.y + "px", width: p.w + "px", margin: "0", pointerEvents: "none" });
      s.appendChild(g); g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: OUT, easing: EASE, fill: "forwards" }).onfinish = () => g.remove();
    }
  }
  prevPos = cur;
  if (moved || fresh.length) follow();
}
/** New fibers draw from their start to their card (stroke-dashoffset on a path of length 1); new ports fade in with the card. */
function drawNew() {
  const f = fib.value; if (!f || !booted) return;
  const els = [...f.querySelectorAll<SVGPathElement>(".fb[data-k]")], pels = [...f.querySelectorAll<SVGCircleElement>(".fport[data-k]")];
  const freshF = els.filter((e) => !seenF.has(e.dataset.k!)), freshP = pels.filter((e) => !seenP.has(e.dataset.k!));
  seenF = new Set(els.map((e) => e.dataset.k!)); seenP = new Set(pels.map((e) => e.dataset.k!));
  if (!freshF.length && !freshP.length) return;
  const since = performance.now() - bootAt, boot = since < 400, at = (k: string) => (link.has(k) ? fiberAt(k) : STEP - 120);
  const base = boot ? since : Math.min(...freshF.map((e) => at(e.dataset.k!)), ...(freshF.length ? [] : [0]));
  for (const e of freshF) {
    const delay = Math.max(0, at(e.dataset.k!) - base);
    if (reduce) fade(e, 0);
    else e.animate([{ strokeDasharray: "1 1.2", strokeDashoffset: 1.05 }, { strokeDasharray: "1 1.2", strokeDashoffset: 0 }], { duration: DRAW, delay, easing: EASE, fill: "backwards" });
  }
  for (const e of freshP) { const k = e.dataset.k!; fade(e, (k.startsWith("b:") ? at(k.slice(2)) + 200 : 0) - base); }
}
/** One layout pass per change: when cards or regions come, go or change place the fit runs in the same frame as the render,
 *  so everything glides once (a later refit would move it all a second time). */
let structSig = "";
onUpdated(() => {
  const s = st.value; if (!s) return;
  const sig = [...s.querySelectorAll<HTMLElement>(".frg:not(.fm-gone), .fcard:not(.fm-gone), .fquiet:not(.fm-gone)")].map((e) => e.dataset.r ?? e.dataset.id ?? e.dataset.q).join("|");
  if (sig !== structSig) { structSig = sig; clearTimeout(timer); void layout().then(fitStrip); } else { flip(); fibers(); drawNew(); }
});
// a card can change height from inside (its trail line, a wrapped doing line) without this component re-rendering:
// watch every card and region box, and glide the rest of the map to the new places
// a card under the Recent strip (or past the map's bottom) while the camera is the untouched fit
const spills = () => { const h = host.value, sp = stripEl.value; if (!h || phone.value) return false; const lim = (sp?.getBoundingClientRect().top ?? h.getBoundingClientRect().bottom) - 4; return [...h.querySelectorAll<HTMLElement>(".fcard")].some((c) => c.getBoundingClientRect().bottom > lim); };
let cro: ResizeObserver | null = null, croRaf = 0;
const watchBoxes = () => {
  if (typeof ResizeObserver === "undefined" || !st.value) return;
  cro ??= new ResizeObserver(() => { if (croRaf) return; croRaf = requestAnimationFrame(() => { croRaf = 0; flip(); fibers(); if (!userView && spills()) soon(); }); });
  cro.disconnect(); st.value.querySelectorAll(".fcard, .fquiet, .frg").forEach((e) => cro!.observe(e));
};
const ROOT_ID = () => root.value?.id ?? "root";
/** One calm hue per team, stable across reloads (hash of the id); greens, ambers and reds stay free for state. */
// five line colours (cyan, blue, indigo, violet, magenta), all clear of the state colours. Each team keeps the hue its id hashes to unless an earlier
// region took it or it sits next to the previous region's hue on the wheel; then the next free hue in turn.
const HUES = [195, 225, 260, 295, 330];
const hashId = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const hueOf = computed(() => {
  const m = new Map<string, number>(), used = new Set<number>(); let prev = -9;
  for (const r of regions.value) {
    if (r.id === "open") continue;
    const n = HUES.length, start = hashId(r.id) % n, near = (i: number) => prev >= 0 && (Math.abs(i - prev) <= 1 || Math.abs(i - prev) === n - 1);
    let i = start;
    for (let j = 0; j < n; j++) { const c = (start + j) % n; if (!used.has(c) && !near(c)) { i = c; break; } if (j === n - 1) { const f = [...Array(n).keys()].map((k) => (start + k) % n).find((k) => !used.has(k)); i = f ?? start; } }
    used.add(i); prev = i; m.set(r.id, HUES[i]);
  }
  return m;
});
const teamHue = (id: string) => hueOf.value.get(id) ?? 0;

// ---------- the message light ----------
const route = computed<Pt[] | null>(() => {
  const f = flight.value; void paths.value; if (!f) return null;
  const a = byName.value.get(f.from), b = byName.value.get(f.to); if (!a || !b) return null;
  const ca = chainOf(a.id), cb = chainOf(b.id); let i = 0; while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
  if (!ca.every((n, j) => j === 0 || link.has(n)) && ca.length < 2 && a.name !== ROOT) return null;
  const pts: Pt[] = [];
  for (let j = ca.length - 1; j >= i; j--) { const l = link.get(ca[j]); if (l) pts.push(...[...l.pts].reverse()); }
  for (let j = i; j < cb.length; j++) { const l = link.get(cb[j]); if (l) pts.push(...l.pts); }
  const c = pts.filter((p, j) => !j || p[0] !== pts[j - 1][0] || p[1] !== pts[j - 1][1]);
  return c.length > 1 ? c : null;
});
const beamD = computed(() => (route.value ? dPath(route.value) : null));
const beamCol = computed(() => (flight.value ? kindOf(flight.value.kind)[0] : "#38c6d9"));
// The message beam is drawn outside Vue: each frame sets a dash on two paths and the ends of their gradient.
// Nothing is laid out and the component does not re-render while it flies.
const tailA = ref<SVGPathElement | null>(null), tailB = ref<SVGPathElement | null>(null), gradEl = ref<SVGLinearGradientElement | null>(null);
let fs = { t0: 0, D: 0, landed: false, miss: 0 };
// the beam's tail follows LAG ms behind its tip, so the beam is as long as it is fast: it grows out of the sender, is longest
// mid-way (MAXLEN at most) and closes up into the receiver
const LAG = 170, MAXLEN = 170;
// ease-in-out cubic, the curve of cubic-bezier(.65,0,.35,1): the same one the work pulse uses
const inOut = (u: number) => { const v = Math.min(1, Math.max(0, u)); return v < 0.5 ? 4 * v ** 3 : 1 - (-2 * v + 2) ** 3 / 2; };
/** A card's ring glows in the message colour: in over `inMs`, a short hold, then a slow fade (opacity of the ring only). */
function glow(id: string | undefined, col: string, inMs: number, peak = 1, hold = 250, out = 800) {
  const el = id ? cardEl(id) : null; if (!el) return;
  el.style.setProperty("--gk", col); el.dataset.glow = "";
  const T = inMs + hold + out, an = el.animate([{ opacity: peak, offset: inMs / T, easing: "linear" }, { opacity: peak, offset: (inMs + hold) / T, easing: "ease-out" }], { duration: T, easing: "ease-out", pseudoElement: "::after" });
  an.id = "glow"; an.onfinish = () => { if (!el.getAnimations({ subtree: true }).some((x) => x.id === "glow" && x.playState === "running")) delete el.dataset.glow; };
}
function beamFrame(t: number) {
  const f = flight.value, a = tailA.value, b = tailB.value, gr = gradEl.value; if (!f) return;
  const L = a && beamD.value ? a.getTotalLength() : 0;
  // no route (an end is not on the map) or not rendered yet: give it a few frames, then drop it
  if (!a || !b || !gr || !L) { if (++fs.miss > 6) endFlight(); else raf = requestAnimationFrame(beamFrame); return; }
  if (!fs.t0) { fs.t0 = t; fs.D = Math.max(600, Math.min(1400, 420 + L * 0.9)); glow(byName.value.get(f.from)?.id, beamCol.value, 100, 0.9, 40, 360); } // the sender blinks as the beam leaves
  const e = t - fs.t0, pos = L * inOut(e / fs.D), from = Math.max(L * inOut((e - LAG) / fs.D), pos - MAXLEN), len = pos - from;
  const h = a.getPointAtLength(pos), q = a.getPointAtLength(from), da = `${len} ${L + 20}`, off = String(-from), show = len > 0.5 ? "" : "0";
  for (const x of [a, b]) { x.setAttribute("stroke-dasharray", da); x.setAttribute("stroke-dashoffset", off); x.style.opacity = show; }
  gr.setAttribute("x1", String(q.x)); gr.setAttribute("y1", String(q.y)); gr.setAttribute("x2", String(h.x)); gr.setAttribute("y2", String(h.y));
  if (e >= fs.D && !fs.landed) { fs.landed = true; glow(byName.value.get(f.to)?.id, beamCol.value, 150); }
  if (e > fs.D + LAG + 20) { endFlight(); return; }
  raf = requestAnimationFrame(beamFrame);
}
// ---------- recent strip: whole items only ----------
const stripEl = ref<HTMLElement | null>(null), stripN = ref(3);
async function fitStrip() { stripN.value = phone.value ? 1 : 3; await nextTick(); const el = stripEl.value; if (!el) return; const sr = el.getBoundingClientRect(); const items = [...el.querySelectorAll<HTMLElement>(".m")]; let n = items.length; while (n > 1 && items[n - 1].getBoundingClientRect().right > sr.right - 10) n--; if (n < items.length) stripN.value = n; }
const stripItems = computed(() => recent.value.slice(0, stripN.value));
const sheetOpen = computed(() => phone.value && !!props.selected);

let ro: ResizeObserver | null = null, timer = 0;
const resized = () => { needFit = true; soon(); };
const soon = () => { clearTimeout(timer); timer = window.setTimeout(() => { void layout().then(fitStrip); }, 120); };
watch([layoutKey, teamsKey, () => props.selected, () => props.cover, () => trees.value.map((t) => t.cards.length + ":" + t.quiet.length).join(","), () => live.value.map((a) => strip(a.name) + crewState(a)).join("|")], soon);
watch(() => recent.value[0]?.id, () => void fitStrip());
// safety net: a box can shift by a pixel or two with no resize or render we hear about (a neighbour's reflow);
// re-measure once a second, which costs nothing when the geometry is unchanged (fibers() compares a signature)
let settle = 0;
onMounted(() => { settle = window.setInterval(() => { if (!followRaf && !document.hidden) fibers(); }, 1000); });
onBeforeUnmount(() => clearInterval(settle));
onMounted(() => { void layout().then(fitStrip); void document.fonts?.ready.then(() => { flip(); fibers(); }); ro = new ResizeObserver(resized); host.value && ro.observe(host.value); });
onBeforeUnmount(() => { stopCam(); gctx.revert(); ro?.disconnect(); clearTimeout(timer); clearTimeout(readyT); clearTimeout(hoverT); clearTimeout(leaveT); clearTimeout(rgT); cancelAnimationFrame(raf); cancelAnimationFrame(followRaf); cancelAnimationFrame(croRaf); cro?.disconnect(); });
const pick = (id: string) => { if (!panned) emit("select", id); };
/** A team region is selectable on its header and background; cards inside keep their own click. */
const pickTeam = (id: string, e?: MouseEvent) => { if (panned || id === "open" || (e && (e.target as Element).closest(".fcard, .fquiet"))) return; emit("select", "team:" + id); };
const ago = (t: number) => { const s = Math.max(0, Math.round(((net.now || Date.now()) - t) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; };
void ago;
</script>

<template>
  <section ref="host" :class="['fm', 'fm-fiber', { ph: phone, pre: !ready }]" aria-label="2D map: agents by team" :style="{ '--cover': (cover ?? 0) + 'px' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel" @click.capture="swallow" @dblclick="onDbl">
    <div ref="st" class="fst">
      <svg ref="fib" class="ffib" width="1" height="1" aria-hidden="true">
        <path v-for="p in paths" :key="p.key" :data-k="p.key" pathLength="1" :class="['fb', { tm: p.th != null, q: p.q }]" :style="p.th != null ? { '--th': p.th } : undefined" :d="p.d" />
        <path v-for="p in paths" :key="'h' + p.key" :class="['fbo', 'hot', { on: p.hot }]" :d="p.d" />
        <path v-for="p in paths" :key="'s' + p.key" :class="['fbo', 'sel', { on: p.sel }]" :d="p.d" />
        <circle v-for="q in ports" :key="q.k" :data-k="q.k" :class="['fport', { tm: q.th != null, ent: q.k.startsWith('b:') }]" :style="q.th != null ? { '--th': q.th } : undefined" :cx="q.x" :cy="q.y" r="2.5" />
        <template v-for="q in ports" :key="'o' + q.k"><circle :class="['fpo', 'hot', { on: q.hot, ent: q.k.startsWith('b:') }]" :cx="q.x" :cy="q.y" r="2.5" /><circle :class="['fpo', 'sel', { on: q.sel, ent: q.k.startsWith('b:') }]" :cx="q.x" :cy="q.y" r="2.5" /></template>
        <template v-for="p in pulses" :key="'fl' + p.key"><path class="ffl t" :d="p.d" :style="{ '--L': p.len + 'px', animationDelay: p.at + 'ms' }" /><path class="ffl" :d="p.d" :style="{ '--L': p.len + 'px', animationDelay: p.at + 'ms' }" /></template>
        <template v-for="g in ghosts" :key="g.key"><path class="fb gone" :d="g.d" /><circle class="fport gone" :cx="g.x" :cy="g.y" r="2.5" /></template>
        <g v-if="beamD" class="beam" :style="{ '--k': beamCol }">
          <defs><linearGradient id="fm-beam" ref="gradEl" gradientUnits="userSpaceOnUse"><stop offset="0" class="b0" /><stop offset=".55" class="b1" /><stop offset="1" class="b2" /></linearGradient></defs>
          <path ref="tailB" class="bt soft" :d="beamD" stroke="url(#fm-beam)" stroke-dasharray="0 9999" style="opacity:0" />
          <path ref="tailA" class="bt" :d="beamD" stroke="url(#fm-beam)" stroke-dasharray="0 9999" style="opacity:0" />
        </g>
      </svg>
      <!-- the director: running, or (while other agents run without it) not running with Resume / Start fresh -->
      <div v-if="root || live.length" class="fdir">
        <AgentCard :id="ROOT_ID()" name="root" :row="root?.row ?? null" dir :had-root="hadRoot" :last="last" :sel="selected === ROOT_ID()" :hot="hotId === ROOT_ID()" :near="hotKeys.has(ROOT_ID()) && hotId !== ROOT_ID()"
          @pick="pick(ROOT_ID())" @details="emit('details', ROOT_ID())" @hover="(on, el) => root && onHover(root.id, on, el)" @resume="emit('resume')" @fresh="emit('fresh')" />
      </div>
      <div class="frgs">
        <section v-for="t in trees" :key="t.r.id" :class="['frg', { open: t.r.id === 'open', sel: selected === 'team:' + t.r.id, lit: hotRg === t.r.id }]" :data-r="t.r.id" :style="{ '--th': teamHue(t.r.id) }" @click="pickTeam(t.r.id, $event)">
          <button type="button" class="frg-h" :disabled="t.r.id === 'open'" :aria-pressed="selected === 'team:' + t.r.id ? 'true' : 'false'" :aria-label="t.r.id === 'open' ? undefined : `Team ${t.r.title}: open team`" @click.stop="pickTeam(t.r.id)" @pointerenter="(e) => e.pointerType === 'mouse' && onRgHover(t.r.id, true)" @pointerleave="(e) => e.pointerType === 'mouse' && onRgHover(t.r.id, false)"><Icon name="users" :size="15" class="fti" /><b class="ftn"><span class="sr-only">{{ t.r.title }}</span><span v-for="(w, i) in t.r.title.split(' ')" :key="i" class="fw" aria-hidden="true">{{ w }}</span></b><span class="fcnt"><template v-if="t.r.list.filter((p) => p.state === 'working').length"><em>{{ t.r.list.filter((p) => p.state === "working").length }} working</em></template>{{ t.r.list.length }} {{ t.r.list.length === 1 ? "agent" : "agents" }}</span><span v-if="t.r.goal" class="fgoal" :title="t.r.goal">{{ t.r.goal }}</span></button>
          <div class="ftree">
            <template v-for="c in t.cards" :key="c.p.id">
              <AgentCard :id="c.p.id" :name="c.p.name" :row="c.p.row" :lead="c.p.lead" :sel="selected === c.p.id" :hot="hotId === c.p.id" :near="hotKeys.has(c.p.id) && hotId !== c.p.id" @pick="pick(c.p.id)" @details="emit('details', c.p.id)" @hover="(on, el) => onHover(c.p.id, on, el)" />
              <div v-if="c.kids.length || t.qmap.get(c.p.name)" class="fkids">
                <template v-for="k in c.kids" :key="k.p.id">
                  <AgentCard :id="k.p.id" :name="k.p.name" :row="k.p.row" :lead="k.p.lead" :sel="selected === k.p.id" :hot="hotId === k.p.id" :near="hotKeys.has(k.p.id) && hotId !== k.p.id" @pick="pick(k.p.id)" @details="emit('details', k.p.id)" @hover="(on, el) => onHover(k.p.id, on, el)" />
                </template>
                <div v-if="t.qmap.get(c.p.name)" class="fquiet" :data-q="'q:' + c.p.name"><div class="fqh"><span>{{ t.qmap.get(c.p.name)!.length }} quiet</span></div><div v-for="q in t.qmap.get(c.p.name)" :key="q.id" class="fqr"><i class="fdot" /><button type="button" @click="pick(q.id)">{{ q.name }}</button><span>{{ q.row.tasks?.length ? "All done" : "No task list" }}</span></div></div>
              </div>
            </template>
            <div v-if="t.quiet.length" class="fquiet" :data-q="'q:' + t.r.id"><div class="fqh"><span>{{ t.quiet.length }} quiet</span></div><div v-for="q in t.quiet" :key="q.id" class="fqr"><i class="fdot" /><button type="button" @click="pick(q.id)">{{ q.name }}</button><span>{{ q.row.tasks?.length ? "All done" : "No task list" }}</span></div></div>
          </div>
        </section>
      </div>
    </div>
    <!-- the peek stays mounted with its last content and only its `on` class flips, so it leaves on the same frame as the rest -->
    <div v-if="shown && peek" ref="pop" :class="['fpop', { on: hover?.on }]" :style="{ left: shown.x + 'px', top: shown.y + 'px', '--ox': shown.ox }" role="tooltip" :aria-hidden="hover?.on ? undefined : 'true'" @pointerenter="popIn" @pointerleave="popOut">
      <TrailPeek :row="peek.row" />
      <dl><template v-for="r in peek.rows" :key="r[0]"><dt>{{ r[0] }}</dt><dd>{{ r[1] }}</dd></template></dl>
    </div>
    <button v-if="!phone || view.k !== 1" type="button" class="fit" aria-label="Fit map to view" @click="refit">Fit</button>
    <div v-show="!sheetOpen" ref="stripEl" class="fstrip"><b>Recent</b><span v-for="(m, i) in stripItems" :key="m.id ?? i" :class="['m', { fly: i === 0 && !!flight }]"><i class="g" :style="{ background: kindOf(m.kind)[0] }" :title="m.kind" />{{ strip(m.from) }} → {{ strip(m.to) }}<template v-if="!phone"> · {{ m.subject ?? m.body }}</template></span><span v-if="!recent.length" class="m">No messages yet</span></div>
  </section>
</template>

<style scoped>
/* A calm tree. Layers: plain canvas < thin lines, rings and the message beam < team nodes and cards. */
.fm{--cv:#161618;--cd:#1e1e21;--cdl:rgba(255,255,255,.1);--ts:60%;--tl:62%;--fiber:color-mix(in srgb,var(--ink) 26%,var(--cv));--hv-d:.22s;--hv-e:cubic-bezier(.2,.8,.2,1);position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;border:1px solid var(--line);border-radius:16px;background:var(--cv)}
/* stacking inside the stage, bottom to top: team fields, lines + rings + message beam (z 1), then team nodes, cards and quiet folds (z 2) */
.ffib{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:1}
.frg-h,.fcard,.fquiet{position:relative;z-index:2}
/* thin lines with soft corners; a team's lines take a pale step of its colour. Focus is an overlay that fades in, never a recolour. */
.fb{fill:none;stroke:var(--fiber);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:opacity .3s ease}
.fb.q{opacity:.45}
.fb.tm,.fport.tm{--tc:color-mix(in srgb,hsl(var(--th) var(--ts) var(--tl)) 62%,var(--cv))}
.fb.tm{stroke:var(--tc)}
.fbo{fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:0;transition:opacity var(--hv-d) var(--hv-e)}
.fbo.hot{stroke:color-mix(in srgb,var(--ink) 75%,var(--cv))}.fbo.sel{stroke:var(--sel);stroke-width:2.5}
.fbo.on{opacity:1}
.fport{fill:var(--fiber)}
.fpo{opacity:0;transition:opacity var(--hv-d) var(--hv-e)}
.fpo.hot{fill:color-mix(in srgb,var(--ink) 75%,var(--cv))}.fpo.sel{fill:var(--sel)}
.fpo.on{opacity:1}
.fport.tm{fill:var(--tc)}
.fport.ent,.fpo.ent{visibility:hidden} /* a dot only where a line leaves a card; the end runs into the card's edge */
/* the work pulse: one short streak (a bright head on a soft tail) leaves the boss, runs the line with a strong ease-in-out and
   fades into the card; then the line rests. Two animations, so the easing covers the whole run and the fade stays linear. */
.ffl{--n:14px;fill:none;stroke:color-mix(in srgb,var(--on) 82%,#fff);stroke-width:2.5;stroke-linecap:round;stroke-dasharray:var(--n) 99999px;stroke-dashoffset:var(--n);opacity:0;animation:fm-run 3.2s cubic-bezier(.65,0,.35,1) infinite,fm-show 3.2s linear infinite}
.ffl.t{--n:46px;stroke-opacity:.4}
@keyframes fm-run{0%{stroke-dashoffset:var(--n)}41%,100%{stroke-dashoffset:calc(var(--n) - var(--L) - 48px)}}
@keyframes fm-show{0%{opacity:0}4%,33%{opacity:1}40%,100%{opacity:0}}
.fb.gone,.fport.gone{animation:fm-out .22s cubic-bezier(.2,.8,.2,1) forwards}
@keyframes fm-out{to{opacity:0}}
.pre .fst,.pre .ffib{opacity:0}
/* a message: one beam in its kind's colour, bright at the tip and fading to nothing at the tail, over a soft wider copy of itself */
.beam{--tip:color-mix(in srgb,var(--k) 35%,#fff)}
.bt{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.bt.soft{stroke-width:7;stroke-opacity:.22}
.beam .b0{stop-color:var(--k);stop-opacity:0}.beam .b1{stop-color:var(--k);stop-opacity:.75}.beam .b2{stop-color:var(--tip);stop-opacity:1}
.fst{position:absolute;left:0;top:0;transform-origin:0 0;padding:0;box-sizing:border-box}
.fdir{display:flex;justify-content:center;margin-bottom:40px}
.frgs{display:flex;flex-wrap:wrap;justify-content:center;gap:28px 20px;align-items:flex-start}
/* a team is a node in the tree: its agents hang under it. A faint field in its colour shows on hover and when picked. */
.frg{--tc:hsl(var(--th,0) var(--ts) var(--tl));position:relative;border-radius:22px;padding:10px;min-width:0;cursor:pointer}
.frg::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:color-mix(in srgb,var(--tc) 7%,transparent);opacity:0;transition:opacity var(--hv-d) var(--hv-e)}
.frg.lit::before{opacity:1}
.frg.sel::before{opacity:1;box-shadow:inset 0 0 0 1.5px var(--sel)}
.frg.open{--tc:var(--fiber);cursor:default}
.frg.open::before{display:none}
.frg-h{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:3px 8px;margin:0 0 12px;width:300px;box-sizing:border-box;padding:9px 14px 10px;border:0;border-radius:16px;background:color-mix(in srgb,var(--tc) 12%,var(--cd));box-shadow:0 0 0 .75px color-mix(in srgb,var(--tc) 22%,var(--cdl)),var(--nd);color:var(--ink);font:inherit;text-align:left;cursor:pointer}
.frg-h:disabled{cursor:default}
.frg-h:focus-visible{outline:2px solid var(--sel);outline-offset:3px}
.fti{color:var(--tc)}
.ftn{min-width:0;font-weight:600;font-size:14px;line-height:18px;overflow-wrap:anywhere}
.fw{display:inline-block;max-width:100%;margin-right:.26em;will-change:transform}
.fw:last-child{margin-right:0}
.fcnt{font-size:12px;line-height:18px;color:var(--muted);white-space:nowrap}
.fcnt em{font-style:normal;color:var(--on);margin-right:8px}
.fgoal{grid-column:1/-1;margin:0;color:var(--muted);font-size:12px;line-height:16px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.ftree{display:flex;flex-direction:column;gap:12px;padding-left:36px}
.fkids{display:flex;flex-direction:column;gap:12px;padding-left:36px}
.fst .fcard{width:300px}
.fdot{width:6px;height:6px;border-radius:50%;background:var(--off);flex:none}
.fquiet{width:300px;box-sizing:border-box;border-radius:16px;padding:9px 12px;background:color-mix(in srgb,var(--cd) 55%,var(--cv));box-shadow:0 0 0 .75px var(--cdl);display:flex;flex-direction:column;gap:5px;font-size:12.5px;cursor:default}
.fqh{font-weight:550;font-size:12px;line-height:1;color:var(--muted)}
.fqr{display:flex;align-items:center;gap:8px}.fqr span:last-child{margin-left:auto;color:var(--muted)}
.fqr button{border:0;background:none;color:var(--ink);font:inherit;cursor:pointer;padding:0;text-align:left}
.fqr button:focus-visible{outline:2px solid var(--sel);outline-offset:2px;border-radius:4px}
.fpop{position:absolute;z-index:5;width:360px;box-sizing:border-box;padding:12px 14px;border-radius:16px;background:var(--cd);box-shadow:0 0 0 .75px var(--cdl),0 12px 32px -8px rgba(0,0,0,.35);font-size:12.5px;opacity:0;transform:translateY(4px) scale(.98);transform-origin:var(--ox,left) top;transition:opacity var(--hv-d) var(--hv-e),transform var(--hv-d) var(--hv-e);pointer-events:none}
.fpop.on{opacity:1;transform:none;pointer-events:auto}
.fpn{display:block;font-weight:650;font-size:14px;margin-bottom:8px;overflow-wrap:anywhere}
.fpop dl{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:10px 0 0;padding-top:10px;border-top:1px solid var(--line)}
.fpop dt{color:var(--muted)}.fpop dd{margin:0;overflow-wrap:anywhere}
.g{width:7px;height:7px;border-radius:2px;flex:none}
/* recent messages: a strip as wide as its items, bottom left */
.fstrip{position:absolute;left:12px;max-width:calc(100% - 24px - var(--cover,0px));bottom:12px;z-index:3;display:flex;gap:18px;align-items:center;height:34px;padding:0 14px;border-radius:10px;background:var(--cd);box-shadow:0 0 0 .75px var(--cdl),var(--nd);font-size:12px;overflow:hidden;white-space:nowrap}
.fstrip b{font:600 12px/1 var(--body);color:var(--muted)}
.fstrip .m{display:flex;align-items:center;gap:6px;flex:none;color:var(--muted)}
.fstrip .m:first-of-type{color:var(--ink)}
.fstrip .m.fly{color:var(--ink);font-weight:600}
.ph .fst{position:relative;flex:none;padding:14px 12px 20px 26px}
.ph .fstrip{position:sticky;left:auto;right:auto;max-width:none;margin:auto 12px 12px;bottom:12px}
.ph .frgs{flex-direction:column;flex-wrap:nowrap;gap:20px}
.ph .frg,.ph .fdir{width:calc(100% - 38px);box-sizing:border-box}
.ph .frg-h{width:100%}
.ph .frg{padding:10px 10px 12px}
.ph .fcard,.ph .fquiet,.ph .fdir .fcard{width:100%}
.ph .fkids{padding-left:22px}
.ph.fm{overflow:auto;touch-action:pan-x pan-y;display:flex;flex-direction:column}
.fit{position:absolute;right:calc(12px + var(--cover,0px));top:12px;z-index:4;height:32px;padding:0 14px;border:0;border-radius:9px;background:var(--cd);box-shadow:0 0 0 .75px var(--cdl),var(--nd);color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:box-shadow var(--hv-d) var(--hv-e)}
.fit:hover{box-shadow:0 0 0 .75px var(--muted),var(--nd)}
.fit:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.fpop{transform:none}.ffl{display:none}}
</style>
<style>
/* Light steps for the 2D map; unscoped because a scoped rule cannot key off the root theme attribute. */
:root[data-theme="light"] .fm-fiber{--cv:#fafafa;--cd:#ffffff;--cdl:rgba(0,0,0,.08);--ts:70%;--tl:56%;--nd:0 1px 1px -1px rgba(0,0,0,.1),0 1px 3px rgba(0,0,0,.06);--fiber:color-mix(in srgb,var(--ink) 22%,var(--cv))}
.fm-fiber{--nd:0 1px 2px rgba(0,0,0,.35)}
:root[data-theme="light"] .fm-fiber .beam{--tip:color-mix(in srgb,var(--k) 80%,#000)}
</style>
