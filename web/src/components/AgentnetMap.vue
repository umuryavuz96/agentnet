<script setup lang="ts">
// Org-chart map of the live agents (replaces the retired agmsg Agent network chart). The director (root) sits on top;
// each of its direct reports opens a soft box labelled with its job, with that agent's own reports indented under it
// (boss field = edges). The dot and the second line are the card's own state and `doing`, read straight from the reactive
// rows, so a status patch re-renders text only; the layout is recomputed on a boss/job change or a resize.
import { computed, onMounted, onUnmounted, ref, shallowRef, watch, nextTick } from "vue";
import Icon from "../ui/Icon.vue";
import { net, hooks, layoutKey, humanDoing, jobFocus, teams, teamsKey, type AgentRow, type Msg } from "../net";
import { api } from "../ui/api";

const props = defineProps<{ selected: string | null; cover?: number }>();
const emit = defineEmits<{ select: [id: string] }>();

const ROOT = "root";
interface N { id: string; x: number; y: number; w: number; h: number }
interface C { id: string; label: string; team?: string; goal?: string | null; also?: number; ids: string[]; x: number; y: number; w: number; h: number; via?: number }
interface L { d: string; to: string }

const box = ref<HTMLElement | null>(null);
const gEl = ref<SVGGElement | null>(null);
const W = ref(800), H = ref(520);
const view = ref({ x: 0, y: 0, k: 1 });
const nodes = shallowRef(new Map<string, N>());
/** agent id -> the team whose cluster draws it; team ids with a cluster. LEAD is judged against that team only. */
const placedIn = shallowRef(new Map<string, string>()), placedTeams = shallowRef(new Set<string>());
const boxes = shallowRef<C[]>([]);
const links = shallowRef<L[]>([]);
const dirNode = shallowRef<N>({ id: ROOT, x: 0, y: 29, w: 212, h: 58 });
const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** On a phone the zoom buttons get their own strip above the canvas, so they never sit on a node. */
const narrow = () => W.value < 560;
/** Phone: controls row (52) + hook pill row (36) above the canvas. Desktop: the hook pill row gets its own strip under the canvas. Clusters never sit under either. */
const reserve = () => (narrow() ? 88 : hooks.nodes.length || unplaced.value.length ? 48 : 0);
const CH = 76, ROW = 100, HEAD = 78, PAD = 20, IND = 26, GAP = 40, KMIN = 0.7;
const row = (id: string): AgentRow | null => net.agents[id] ?? null;
const rootRow = computed(() => Object.values(net.agents).find((a) => a.name === ROOT) ?? null);
const nameOf = (id: string) => (id === ROOT ? ROOT : row(id)?.name ?? id);
const cardW = (id: string) => Math.max(236, nameOf(id).length * 9 + 140 + (isLead(id) ? 56 : 0) + (extraTeams(id) > 0 ? 38 : 0));

/** boss tree among the rows on the map: boss "root", no boss, an unknown boss or a loop all hang under the director. */
/** Active teams with at least one live member: agent id -> team (first team wins). Their members leave the boss tree and sit in the team's region. */
function teamGroups() {
  const out: { team: (typeof teams.list)[number]; ids: string[]; elsewhere: string[] }[] = [], used = new Set<string>(), byName = new Map(Object.values(net.agents).filter((a) => a.name !== ROOT).map((a) => [a.name, a.id]));
  for (const t of teams.list) {
    if (t.state !== "active") continue;
    const names = [...(t.lead ? [t.lead] : []), ...t.members.filter((m) => m !== t.lead).sort()], ids: string[] = [];
    const elsewhere: string[] = [];
    for (const n of names) { const id = byName.get(n); if (!id) continue; if (used.has(id)) elsewhere.push(n); else { used.add(id); ids.push(id); } }
    if (ids.length) out.push({ team: t, ids, elsewhere });
  }
  return out;
}
function tree(skip: Set<string> = new Set()) {
  const list = Object.values(net.agents).filter((a) => a.name !== ROOT && !skip.has(a.id));
  const byName = new Map(list.map((a) => [a.name, a.id]));
  const kids = new Map<string, string[]>(); const top: string[] = [];
  for (const a of list) {
    const p = a.boss && a.boss !== ROOT && a.boss !== a.name ? byName.get(a.boss) : undefined;
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(a.id); else top.push(a.id);
  }
  const sort = (ids: string[]) => ids.sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
  sort(top); for (const v of kids.values()) sort(v);
  return { top, kids };
}

// ---------- background jobs hang under the node of whoever started them (dashed connector, compact pill row) ----------
interface BJ { id: string; owner: string | null; desc: string; status: "running" | "done" | "failed" | "stopped"; started: number; runtimeMs: number }
const bjobs = ref<BJ[]>([]);
let jt: ReturnType<typeof setInterval> | null = null, jbusy = false;
async function loadJobs() { if (jbusy || document.hidden) return; jbusy = true; try { bjobs.value = await api<BJ[]>("v1/panel/bgjobs"); } catch { /* keeps the last list */ } finally { jbusy = false; } }
onMounted(() => { void loadJobs(); jt = setInterval(loadJobs, 4000); });
onUnmounted(() => { if (jt) clearInterval(jt); });
const expandedDone = ref(new Set<string>());
// Job pills are drawn at S x their size so the text stays >= 11 px at the default fit (desktop fits near 0.7); a phone fits at 1.
// pillS follows the fitted zoom (fit() sets it in steps, at most two relayouts per change): 1 at a zoom near 1, up to 1.45 on a crowded desktop fit.
const pillS = ref(typeof innerWidth === "number" && innerWidth < 560 ? 1 : 1.2);
const FRESH = 30 * 60_000, MAXRUN = 3, PH = 20;
interface JG { run: BJ[]; more: number; done: BJ[]; retired: boolean }
/** node id -> its job group; an owner that is gone or unknown hangs the job under root (tagged retired). Finished jobs older than 30 min are hidden. */
const jobsBy = computed(() => {
  const m = new Map<string, JG>(), now = net.now || Date.now();
  for (const j of bjobs.value) {
    const live = j.status === "running";
    if (!live && now - (j.started + j.runtimeMs) > FRESH) continue;
    const oid = j.owner ? idOf(j.owner) : ROOT, id = oid ?? ROOT;
    const g = m.get(id) ?? m.set(id, { run: [], more: 0, done: [], retired: false }).get(id)!;
    if (!oid && j.owner) g.retired = true;
    (live ? g.run : g.done).push(j);
  }
  for (const g of m.values()) { g.run.sort((a, b) => b.started - a.started); g.more = Math.max(0, g.run.length - MAXRUN); g.run = g.run.slice(0, MAXRUN); g.done.sort((a, b) => b.started - a.started); }
  return m;
});
/** Lines under a node: one per shown job, plus one for the chips / retired tag. */
const linesOf = (id: string) => { const g = jobsBy.value.get(id); if (!g) return 0; const dn = expandedDone.value.has(id) ? Math.min(3, g.done.length) : 0; return g.run.length + dn + (g.more || g.done.length || g.retired ? 1 : 0); };
const exOf = (id: string) => (linesOf(id) ? linesOf(id) * (PH + 5) * pillS.value + 12 : 0);
const jobSig = computed(() => [...jobsBy.value.keys()].sort().map((k) => k + ":" + linesOf(k)).join(","));
const jdur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h"; };
interface It { key: string; kind: "pill" | "chip" | "tag"; x: number; y: number; w: number; j?: BJ; text: string; tip: string; act?: () => void }
const short = (t: string, n = 18) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const jobRows = computed(() => {
  const out = new Map<string, { items: It[]; y: number; x0: number }>();
  for (const [id, g] of jobsBy.value) {
    const n = id === ROOT ? dirNode.value : nodes.value.get(id); if (!n) continue;
    const exp = expandedDone.value.has(id), pills = [...g.run, ...(exp ? g.done.slice(0, 3) : [])];
    const S = pillS.value, x0 = (-n.w / 2 + 26) / S, W0 = (n.w - 36) / S, items: It[] = []; let y = 0;
    for (const j of pills) {
      const live = j.status === "running", el = jdur(live ? (net.now || Date.now()) - j.started : j.runtimeMs);
      items.push({ key: j.id, kind: "pill", x: x0, y, w: Math.min(W0, 190), j, text: `${short(j.desc)} · ${el}`, tip: `${j.desc} · ${j.status} · ${el}${g.retired ? " · retired owner" : ""}` }); y += PH + 5;
    }
    let x = x0; const chip = (key: string, text: string, tip: string, kind: "chip" | "tag", act?: () => void) => { const w = text.length * 6.2 + 16; items.push({ key, kind, x, y, w, text, tip, act }); x += w + 5; };
    if (g.more) chip("more", `${MAXRUN} + ${g.more}`, `${g.run.length + g.more} running`, "chip");
    if (g.done.length) chip("done", exp ? "hide" : `+${g.done.length} done`, exp ? "Hide finished jobs" : `${g.done.length} finished in the last 30 min`, "chip", () => { const e = new Set(expandedDone.value); exp ? e.delete(id) : e.add(id); expandedDone.value = e; });
    if (g.retired) chip("tag", "retired owner", "These jobs belong to an agent that is gone", "tag");
    out.set(id, { items, y: n.h / 2 + 8, x0 });
  }
  return out;
});
const tapJob = (j: BJ, ownerId: string) => { jobFocus.id = j.id; jobFocus.at = Date.now(); jobFocus.n++; emit("select", ownerId); };

const portrait = () => W.value < H.value * 0.95 || W.value < 560;
function layout() {
  const tg = teamGroups(), { top, kids } = tree(new Set(tg.flatMap((g) => g.ids)));
  placedIn.value = new Map(tg.flatMap((g) => g.ids.map((id) => [id, g.team.id] as [string, string]))); placedTeams.value = new Set(tg.map((g) => g.team.id));
  const nm = new Map<string, N>(), cl: C[] = [], lk: L[] = [];
  const seen = new Set<string>();
  const parentOf = new Map<string, string>();
  const also = new Map(tg.map((g) => [g.team.id, g.elsewhere.length]));
  const grp: { lead: string; rows: { id: string; depth: number }[]; team?: (typeof tg)[number]["team"] }[] = tg.map((g) => ({ lead: g.ids[0], rows: g.ids.map((id) => ({ id, depth: 0 })), team: g.team }));
  for (const g of grp) for (const r of g.rows) seen.add(r.id);
  for (const lead of top) {
    if (seen.has(lead)) continue;
    const rows: { id: string; depth: number }[] = [];
    const walk = (id: string, d: number) => { if (seen.has(id)) return; seen.add(id); rows.push({ id, depth: d }); for (const k of kids.get(id) ?? []) { parentOf.set(k, id); walk(k, d + 1); } };
    walk(lead, 0);
    grp.push({ lead, rows });
  }
  for (const { lead, rows, team } of grp) {
    const w0 = Math.max(...rows.map((r) => cardW(r.id))), depth = Math.max(...rows.map((r) => r.depth));
    const label = team ? team.name : row(lead)?.job ?? nameOf(lead);
    const c: C = { id: "c:" + lead, label, team: team?.id, goal: team?.goal ?? null, also: also.get(team?.id ?? ""), ids: rows.map((r) => r.id), x: 0, y: 0, w: Math.max(PAD * 2 + depth * IND + w0, Math.min(label.length, 40) * 7 + 60, team ? 250 : 0), h: HEAD + rows.length * ROW + rows.reduce((a, r) => a + exOf(r.id), 0) - (ROW - CH) + PAD };
    let yy = HEAD;
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; const w = c.w - PAD * 2 - r.depth * IND; nm.set(r.id, { id: r.id, w, h: CH, x: PAD + r.depth * IND + w / 2, y: yy + CH / 2 }); yy += ROW + exOf(r.id); }
    cl.push(c);
  }
  const d: N = { id: ROOT, w: 256, h: 72, x: 0, y: 36 };
  const topY = d.h + 64 + exOf(ROOT);
  if (!portrait()) {
    const maxW = Math.max(520, (W.value - 40) / KMIN);
    const rws: C[][] = [[]]; let rw = 0;
    for (const c of cl) { if (rws[rws.length - 1].length && rw + GAP + c.w > maxW) { rws.push([]); rw = 0; } rws[rws.length - 1].push(c); rw += (rws[rws.length - 1].length > 1 ? GAP : 0) + c.w; }
    const widths = rws.map((r0) => r0.reduce((a, c) => a + c.w, 0) + (r0.length - 1) * GAP);
    const outer = Math.max(0, ...widths) / 2 + 30;
    let y = topY;
    rws.forEach((r0, ri) => {
      let x = -widths[ri] / 2;
      for (const c of r0) { c.x = x; c.y = y; c.via = ri ? (c.x + c.w / 2 < 0 ? -outer : outer) : undefined; x += c.w + GAP; }
      y += Math.max(0, ...r0.map((c) => c.h)) + 52;
    });
    const bus = d.h + 22 + exOf(ROOT);
    for (const c of cl) lk.push({ to: c.ids[0], d: c.via === undefined ? `M0,${d.h} V${bus} H${c.x + c.w / 2} V${c.y}` : `M0,${d.h} V${bus} H${c.via} V${c.y - 26} H${c.x + c.w / 2} V${c.y}` });
  } else {
    const trunk = 20; let y = topY;
    d.x = d.w / 2;
    for (const c of cl) { c.x = trunk + 22; c.y = y; y += c.h + 22; lk.push({ to: c.ids[0], d: `M${trunk},${d.h} V${c.y + 26} H${c.x}` }); }
  }
  for (const c of cl) for (const id of c.ids) { const n = nm.get(id)!; n.x += c.x; n.y += c.y; }
  for (const [k, p] of parentOf) { const a = nm.get(p), b = nm.get(k); if (a && b) lk.push({ to: k, d: `M${a.x - a.w / 2 + 14},${a.y + a.h / 2} V${b.y} H${b.x - b.w / 2}` }); }
  nodes.value = nm; boxes.value = cl; links.value = lk; dirNode.value = d;
}

function fit() {
  const d = dirNode.value;
  let x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, y0 = 0, y1 = d.h;
  for (const c of boxes.value) { x0 = Math.min(x0, c.x, c.via ?? Infinity); x1 = Math.max(x1, c.x + c.w, c.via ?? -Infinity); y1 = Math.max(y1, c.y + c.h); }
  const cw = x1 - x0 + 40, ch = y1 - y0 + 40;
  const k = Math.max(KMIN, Math.min(1, W.value / cw, portrait() ? 1 : H.value / ch)); // everything in view; the floor KMIN keeps text readable
  view.value = { k, x: W.value / 2 - ((x0 + x1) / 2) * k, y: 20 };
  contentH.value = portrait() ? Math.ceil(ch * k + 8) + reserve() : 0;
  if (portrait()) view.value.x = 12 - x0 * k;
  // Ground truth: the drawn content's real bottom edge, so a wrong estimate never leaves an empty canvas under the last node.
  if (portrait()) nextTick(() => { const b = gEl.value?.getBBox?.(); if (b && b.height > 0) contentH.value = Math.ceil((b.y + b.height) * view.value.k + view.value.y + 16) + reserve(); });
}
const relayout = (again = 0) => { layout(); nextTick(() => { fit(); const k = view.value.k, want = narrow() || k >= 0.95 ? 1 : k >= 0.8 ? 1.2 : 1.45; if (want !== pillS.value && jobsBy.value.size && again < 2) { pillS.value = want; relayout(again + 1); } }); };
watch(layoutKey, () => relayout());
watch(teamsKey, () => relayout());
watch(jobSig, () => relayout());

let ro: ResizeObserver | null = null;
onMounted(() => {
  const measure = () => { if (!box.value) return; const r = box.value.getBoundingClientRect(), h = r.height - (r.width < 560 ? 88 : hooks.nodes.length || unplaced.value.length ? 48 : 0); if (Math.abs(r.width - W.value) > 1 || Math.abs(h - H.value) > 1) { W.value = r.width; H.value = h; relayout(); } };
  measure(); layout(); fit();
  ro = new ResizeObserver(measure); if (box.value) ro.observe(box.value);
});
onUnmounted(() => ro?.disconnect());

// ---------- pan / zoom ----------
let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
let panned = false;
const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY, vx: view.value.x, vy: view.value.y, moved: false }; };
const onMove = (e: PointerEvent) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  // Capture only once a real drag starts: capturing on pointerdown retargets the click to the svg, so taps on a node never selected it.
  if (!drag.moved) (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  drag.moved = true; view.value = { ...view.value, x: drag.vx + dx, y: drag.vy + dy };
};
const onUp = () => { panned = !!drag?.moved; drag = null; setTimeout(() => { panned = false; }, 0); };
function zoomAt(f: number, cx = W.value / 2, cy = H.value / 2) {
  const v = view.value, k = Math.max(0.3, Math.min(2.5, v.k * f)), r = k / v.k;
  view.value = { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
}
/** Trackpad like Figma/Maps: two-finger scroll pans, pinch (sent as ctrl+wheel) zooms at the cursor. */
const onWheel = (e: WheelEvent) => {
  const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H.value : 1, dx = e.deltaX * m, dy = e.deltaY * m;
  if (e.ctrlKey || e.metaKey) { const r = box.value!.getBoundingClientRect(); zoomAt(Math.exp(-dy * 0.01), e.clientX - r.left, e.clientY - r.top); return; }
  view.value = { ...view.value, x: view.value.x - dx, y: view.value.y - dy };
};
const pick = (id: string) => { if (!panned) emit("select", id); };
/** The detail panel floats over the right edge: when it would cover the picked node, slide the map left (300 ms). */
let tween = 0;
function panX(x: number) {
  cancelAnimationFrame(tween);
  if (reduce) { view.value = { ...view.value, x }; return; }
  const x0 = view.value.x, t0 = performance.now();
  const step = (t: number) => { const p = Math.min(1, (t - t0) / 300), e = 1 - (1 - p) ** 3; view.value = { ...view.value, x: x0 + (x - x0) * e }; if (p < 1) tween = requestAnimationFrame(step); };
  tween = requestAnimationFrame(step);
}
watch(() => [props.selected, props.cover ?? 0] as const, ([id, cover]) => nextTick(() => {
  if (!id || !cover) return;
  const n = id === ROOT ? dirNode.value : nodes.value.get(id); if (!n) return;
  const k = view.value.k, left = (n.x - n.w / 2) * k + view.value.x, right = (n.x + n.w / 2) * k + view.value.x, free = W.value - cover - 16;
  if (right > free) panX(view.value.x - Math.min(right - free, Math.max(0, left - 16)));
}));
onUnmounted(() => cancelAnimationFrame(tween));

// ---------- what a card shows ----------
const dotOf = (id: string) => {
  const r = id === ROOT ? rootRow.value : row(id);
  if (!r) return id === ROOT ? "root" : "stopping";
  if (r.life === "starting") return "starting";
  if (r.life === "stopping" || r.life === "gone" || r.life === "failed") return "stopping";
  return r.state;
};
const LABEL: Record<string, string> = { root: "director", starting: "starting", stopping: "stopping", working: "working", idle: "idle", waiting: "waiting for input", blocked: "blocked" };
const line2 = (id: string) => {
  const r = id === ROOT ? rootRow.value : row(id);
  if (!r) return id === ROOT ? "Director · main session" : "";
  const t = r.reported?.blockedOn ? "Blocked: " + r.reported.blockedOn : humanDoing(r.doing) ?? LABEL[dotOf(id)];
  return id === ROOT && r.state === "idle" && !r.doing ? "Director · idle" : t;
};
/** Cut a string to roughly `px` pixels at `fs` px (no text measuring in SVG: ~0.56 em per character). */
const fitText = (s: string, px: number, fs = 13) => { const n = Math.max(4, Math.floor(px / (fs * 0.56))); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
/** The group title follows the lead's current in-progress task, else its job (spawn job goes stale). */
const labelOf = (c: C) => { if (c.team) return c.label; const r = row(c.ids[0]); return r?.tasks?.find((t) => t.status === "in_progress")?.text ?? r?.job ?? c.label; };
/** The lead of an active team wears a LEAD tag on its node. */
const activeTeams = () => teams.list.filter((t) => t.state === "active");
/** Teams an agent is in besides the one whose cluster draws it, with its role there. */
const otherTeams = (id: string) => { const home = placedIn.value.get(id), n = nameOf(id); return activeTeams().filter((t) => t.id !== home && t.members.includes(n)); };
const extraTeams = (id: string) => otherTeams(id).length;
const extraTip = (id: string) => otherTeams(id).map((t) => (t.lead === nameOf(id) ? `Also lead of ${t.name}` : `Also in ${t.name}`)).join(" · ");
/** LEAD only for the team whose cluster the node sits in. */
const isLead = (id: string) => { const t = activeTeams().find((x) => x.id === placedIn.value.get(id)); return !!t && t.lead === nameOf(id); };
/** Active teams with no cluster on the map (every member sits in an earlier team): reachable as chips in the hook strip. */
const unplaced = computed(() => activeTeams().filter((t) => !placedTeams.value.has(t.id)));
const pickTeam = (c: C) => { if (c.team && !panned) emit("select", "team:" + c.team); };
/** Team/cluster sub line at 13 px, wrapped to two lines at most (word wrap by character budget, no text measuring in SVG). */
const subLines = (c: C): string[] => {
  const t = c.team ? `${stat(c)}${c.also ? ` (+${c.also} in another team)` : ""}${c.goal ? " · " + c.goal : ""}` : stat(c), n = Math.max(12, Math.floor((c.w - 40) / (13 * 0.56)));
  if (t.length <= n) return [t];
  const cut = t.lastIndexOf(" ", n); const a = t.slice(0, cut > 8 ? cut : n), rest = t.slice(a.length).trim();
  return [a, rest.length > n ? rest.slice(0, n - 1) + "…" : rest];
};
const isWorking = (id: string) => { const r = row(id); return !!r && r.state === "working" && r.life === "live"; }; // a gone or stopping agent is not working, whatever its last state
const stat = (c: C) => { const w = c.ids.filter(isWorking).length; return `${c.ids.length} ${c.ids.length === 1 ? "agent" : "agents"}${w ? ` · ${w} working` : ""}`; };
const working = (c: C) => c.ids.some(isWorking);
const linkLive = (l: L) => isWorking(l.to);
/** Context used, shown at the right end of a node's name line ("42%"); null until the agent reports a reading. */
const ctxOf = (id: string) => { const r = id === ROOT ? rootRow.value : row(id); return r?.context ? Math.round(r.context.pct) : null; };
const useTip = (id: string) => { const r = id === ROOT ? rootRow.value : row(id); if (!r) return ""; const p: string[] = []; if (r.context) p.push(`context ${Math.round(r.context.pct)}%`); if (r.cost != null) p.push(`$${r.cost.toFixed(2)}`); if (r.weekly) p.push(`weekly ${Math.round(r.weekly.pct)}%`); return p.length ? " · " + p.join(" · ") : ""; };
/** Hooks lane: a hook that just fired glows for 1.4 s (skipped runs stay quiet). */
const glow = ref(new Set<string>());
watch(() => hooks.fires[0], (f) => { if (!f || f.skipped) return; glow.value = new Set(glow.value).add(f.script); setTimeout(() => { const g = new Set(glow.value); g.delete(f.script); glow.value = g; }, 1400); });
const prog = (id: string) => {
  const r = id === ROOT ? rootRow.value : row(id); if (!r) return null;
  return typeof r.progressPct === "number" ? r.progressPct / 100 : null;
};

// ---------- a message is a packet: a dot with the kind's glyph travels sender -> receiver (~900 ms, eased) ----------
// Parent/child pairs ride the boss line; everyone else (peers, cross-team) gets a direct curved arc. Every message since the last seen id is
// queued (150 ms stagger, at most 8 in flight). Names may carry a "#gen" suffix or belong to a retired agent: those are skipped, not drawn.
const hotNodes = ref(new Set<string>()), hotLinks = ref(new Set<string>());
const stripSuffix = (n: string) => n.replace(/#\d+$/, "");
const idOf = (name: string) => { const n = stripSuffix(name); return n === ROOT ? ROOT : Object.values(net.agents).find((a) => stripSuffix(a.name) === n && a.life !== "gone")?.id ?? null; };
const KIND_COL: Record<string, string> = { task: "#f2b04a", report: "#3ecf8e", question: "#6aa8ff", answer: "#b48cff", info: "#9aa0a6" };
const KIND_GLYPH: Record<string, string> = { task: "T", report: "R", question: "?", answer: "A", info: "i" };
interface Pk { key: number; x: number; y: number; kind: string; tip: string }
const packets = shallowRef<Pk[]>([]);
const centre = (id: string) => (id === ROOT ? { x: dirNode.value.x, y: dirNode.value.y } : nodes.value.get(id) ?? null);
const heat = (ids: string[], ms: number, links: string[] = []) => {
  const n = new Set(hotNodes.value), l = new Set(hotLinks.value); ids.forEach((x) => n.add(x)); links.forEach((x) => l.add(x)); hotNodes.value = n; hotLinks.value = l;
  setTimeout(() => { const n2 = new Set(hotNodes.value), l2 = new Set(hotLinks.value); ids.forEach((x) => n2.delete(x)); links.forEach((x) => l2.delete(x)); hotNodes.value = n2; hotLinks.value = l2; }, ms);
};
/** Position function t(0..1) for a packet going a -> b, or null when a node is not on the map yet. */
function route(a: string, b: string): { at: (t: number) => { x: number; y: number }; via?: string } | null {
  const A = centre(a), B = centre(b); if (!A || !B) return null;
  const child = row(b)?.boss && idOf(row(b)!.boss!) === a ? b : row(a)?.boss && idOf(row(a)!.boss!) === b ? a : (b !== ROOT && (row(b)?.boss === ROOT || !row(b)?.boss) && a === ROOT) ? b : (a !== ROOT && b === ROOT && (row(a)?.boss === ROOT || !row(a)?.boss)) ? a : null;
  const el = child ? gEl.value?.querySelector<SVGPathElement>(`path.ln[data-to="${CSS.escape(child)}"]`) : null;
  if (el && el.getTotalLength() > 1) { const len = el.getTotalLength(), rev = child === a; return { via: child!, at: (t) => { const p = el.getPointAtLength((rev ? 1 - t : t) * len); return { x: p.x, y: p.y }; } }; }
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, bow = Math.min(90, d * 0.28) * (a < b ? 1 : -1), cx = (A.x + B.x) / 2 - (dy / d) * bow, cy = (A.y + B.y) / 2 + (dx / d) * bow;
  return { at: (t) => ({ x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * cx + t * t * B.x, y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * cy + t * t * B.y }) };
}
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const DUR = 900, STAGGER = 150, MAX_FLY = 8;
interface Fly { key: number; kind: string; tip: string; t0: number; to: string; r: NonNullable<ReturnType<typeof route>> }
let flying: Fly[] = [], queue: Msg[] = [], lastStart = 0, raf = 0, seq = 0;
function frame(now: number) {
  raf = 0;
  while (queue.length && flying.length < MAX_FLY && now - lastStart >= STAGGER) {
    const m = queue.shift()!, a = idOf(m.from), b = idOf(m.to); const r = a && b ? route(a, b) : null; if (!r || !b) continue;
    lastStart = now; flying.push({ key: seq++, kind: m.kind, tip: tipOf(m), t0: now, to: b, r }); heat([a!], 500);
  }
  const out: Pk[] = [];
  flying = flying.filter((f) => { const t = (now - f.t0) / DUR; if (t >= 1) { heat([f.to], 1100, f.r.via ? [f.r.via] : []); return false; } const p = f.r.at(ease(Math.max(0, t))); out.push({ key: f.key, x: p.x, y: p.y, kind: f.kind, tip: f.tip }); return true; });
  packets.value = out;
  if (flying.length || queue.length) raf = requestAnimationFrame(frame);
}
const tipOf = (m: Msg) => `${m.from} → ${m.to}: ${m.subject || m.body.replace(/\s+/g, " ").slice(0, 80)}`;
let lastMsg: number | null = net.messages.reduce<number | null>((mx, m) => (m.id != null && (mx == null || m.id > mx) ? m.id : mx), null);
watch(() => net.messages.length, () => {
  const fresh = net.messages.filter((m) => m.id != null && (lastMsg == null || m.id > lastMsg)); if (!fresh.length) return;
  lastMsg = Math.max(...fresh.map((m) => m.id!));
  for (const m of fresh) {
    if (Date.now() - m.at > 10_000) continue; // a backlog arriving after a reconnect is history, not traffic
    const a = idOf(m.from), b = idOf(m.to); if (!a || !b) continue; // retired or unknown agent, or a team: skip gracefully
    if (reduce) heat([a, b], 1400); else queue.push(m);
  }
  if (queue.length && !raf) raf = requestAnimationFrame(frame);
});
onUnmounted(() => { if (raf) cancelAnimationFrame(raf); });
/** Recent traffic strip (also the only motion-free view): the last few messages, hover or tap for "from → to: subject". */
const recent = computed(() => (narrow() || reduce ? (narrow() ? [] : net.messages.slice(-3)) : net.messages.filter((m) => (net.now || Date.now()) - m.at < 60_000).slice(-3)).slice().reverse());
const stripOpen = ref<number | null>(null);
const count = computed(() => Object.keys(net.agents).length);
/** Content height at the fitted zoom: the box shrinks to it (min 240 px) on a phone, so a small tree never leaves an empty canvas; the desktop canvas fills the page. */
const contentH = ref(0);
const boxStyle = computed(() => (contentH.value ? { flex: "1 1 0", alignSelf: "flex-start", height: `${Math.max(240, contentH.value)}px`, maxHeight: "100%" } : undefined));
const allNodes = computed(() => [...nodes.value.values()]);
</script>

<template>
  <div ref="box" class="amap" :class="{ narrow: narrow() }" :style="[boxStyle, { '--rv': reserve() + 'px' }]" role="group" :aria-label="`Org chart of ${count} agents`">
    <svg class="amap-svg" :viewBox="`0 0 ${W} ${H}`" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel" @dblclick="fit">
      <g ref="gEl" :transform="`translate(${view.x} ${view.y}) scale(${view.k})`">
        <g v-for="c in boxes" :key="c.id" class="cl" :class="{ live: working(c), team: !!c.team }" :role="c.team ? 'button' : undefined" :tabindex="c.team ? 0 : undefined" :aria-label="c.team ? `Team ${c.label}` : undefined"
           @click="pickTeam(c)" @keydown.enter="pickTeam(c)">
          <rect :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="14" />
          <text class="cl-t" :x="c.x + 20" :y="c.y + 26">{{ fitText(labelOf(c), c.w - 40, 15) }}</text>
          <text class="cl-s" :x="c.x + 20" :y="c.y + 46"><tspan v-for="(ln, i) in subLines(c)" :key="i" :x="c.x + 20" :dy="i ? 16 : 0">{{ ln }}</tspan></text>
        </g>
        <path v-for="l in links" :key="l.to" :d="l.d" :data-to="l.to" class="ln" :class="{ live: linkLive(l), hot: hotLinks.has(l.to) }" />
        <g class="nd" :class="['s-' + dotOf(ROOT), 'root', { sel: selected === ROOT, hot: hotNodes.has(ROOT) }]" :transform="`translate(${dirNode.x} ${dirNode.y})`" tabindex="0" role="button"
           :aria-label="`${ROOT}, director`" @click="pick(ROOT)" @keydown.enter="pick(ROOT)" @keydown.space.prevent="pick(ROOT)">
          <rect class="card" :x="-dirNode.w / 2" :y="-dirNode.h / 2" :width="dirNode.w" :height="dirNode.h" rx="12" />
          <circle class="dot" :cx="-dirNode.w / 2 + 18" cy="-12" r="5" />
          <text class="nm" :x="-dirNode.w / 2 + 34" y="-7">{{ ROOT }} (director)</text>
          <text v-if="ctxOf(ROOT) !== null" class="ctx" :class="{ hi: ctxOf(ROOT)! >= 80 }" :x="dirNode.w / 2 - 14" y="-7" text-anchor="end">{{ ctxOf(ROOT) }}%</text>
          <text class="sub" :x="-dirNode.w / 2 + 34" y="15">{{ fitText(line2(ROOT), dirNode.w - 52, 13) }}</text>
          <g v-if="jobRows.get(ROOT)" class="bjr" :transform="`translate(0 ${jobRows.get(ROOT)!.y}) scale(${pillS})`">
            <path class="bjl" :d="`M${jobRows.get(ROOT)!.x0 - 12},-4 V${jobRows.get(ROOT)!.items.length ? jobRows.get(ROOT)!.items[0].y + PH / 2 : 8} H${jobRows.get(ROOT)!.x0}`" />
            <g v-for="it in jobRows.get(ROOT)!.items" :key="it.key" :class="['bjp', it.kind, it.j?.status]" :transform="`translate(${it.x} ${it.y})`" role="button" tabindex="0" :aria-label="it.tip" @click.stop="it.j ? tapJob(it.j, ROOT) : it.act?.()" @keydown.enter.stop="it.j ? tapJob(it.j, ROOT) : it.act?.()">
              <title>{{ it.tip }}</title>
              <rect :width="it.w" :height="PH" rx="10" />
              <template v-if="it.j"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4">{{ it.text }}</text></template>
              <text v-else class="bjt" :x="it.w / 2" :y="PH / 2 + 4" text-anchor="middle">{{ it.text }}</text>
            </g>
          </g>
        </g>
        <g v-for="n in allNodes" :key="n.id" class="nd" :class="['s-' + dotOf(n.id), { sel: selected === n.id, hot: hotNodes.has(n.id) }]" :transform="`translate(${n.x} ${n.y})`" tabindex="0" role="button"
           :aria-label="`${nameOf(n.id)}, ${LABEL[dotOf(n.id)]}`" @click="pick(n.id)" @keydown.enter="pick(n.id)" @keydown.space.prevent="pick(n.id)">
          <title>{{ nameOf(n.id) }}: {{ line2(n.id) }}{{ useTip(n.id) }}</title>
          <rect class="card" :x="-n.w / 2" :y="-n.h / 2" :width="n.w" :height="n.h" rx="10" />
          <circle class="dot" :cx="-n.w / 2 + 18" cy="-17" r="5" />
          <text class="nm" :x="-n.w / 2 + 34" y="-12">{{ fitText(nameOf(n.id), n.w - 52 - (ctxOf(n.id) !== null ? 44 : 0) - (isLead(n.id) ? 56 : 0) - (extraTeams(n.id) > 0 ? 38 : 0), 15) }}</text>
          <g v-if="isLead(n.id)" class="lead"><rect :x="n.w / 2 - (ctxOf(n.id) !== null ? 98 : 62)" y="-27" width="48" height="17" rx="8.5" /><text :x="n.w / 2 - (ctxOf(n.id) !== null ? 74 : 38)" y="-14.5" text-anchor="middle">LEAD</text></g>
          <g v-if="extraTeams(n.id) > 0" class="lead more" :transform="`translate(${(isLead(n.id) ? n.w / 2 - (ctxOf(n.id) !== null ? 98 : 62) : n.w / 2 - (ctxOf(n.id) !== null ? 50 : 14)) - 6 - 30} 0)`"><title>{{ extraTip(n.id) }}</title><rect y="-27" width="30" height="17" rx="8.5" /><text x="15" y="-14.5" text-anchor="middle">+{{ extraTeams(n.id) }}</text></g>
          <text v-if="ctxOf(n.id) !== null" class="ctx" :class="{ hi: ctxOf(n.id)! >= 80 }" :x="n.w / 2 - 14" y="-12" text-anchor="end">{{ ctxOf(n.id) }}%</text>
          <text class="sub" :x="-n.w / 2 + 34" y="8">{{ fitText(line2(n.id), n.w - 52, 13) }}</text>
          <template v-if="prog(n.id) !== null"><rect class="pbg" :x="-n.w / 2 + 34" y="18" :width="n.w - 62" height="6" rx="3" /><rect class="pfg" :x="-n.w / 2 + 34" y="18" :width="(n.w - 62) * prog(n.id)!" height="6" rx="3" /></template>
          <g v-if="jobRows.get(n.id)" class="bjr" :transform="`translate(0 ${jobRows.get(n.id)!.y}) scale(${pillS})`">
            <path class="bjl" :d="`M${jobRows.get(n.id)!.x0 - 12},-4 V${jobRows.get(n.id)!.items.length ? jobRows.get(n.id)!.items[0].y + PH / 2 : 8} H${jobRows.get(n.id)!.x0}`" />
            <g v-for="it in jobRows.get(n.id)!.items" :key="it.key" :class="['bjp', it.kind, it.j?.status]" :transform="`translate(${it.x} ${it.y})`" role="button" tabindex="0" :aria-label="it.tip" @click.stop="it.j ? tapJob(it.j, n.id) : it.act?.()" @keydown.enter.stop="it.j ? tapJob(it.j, n.id) : it.act?.()">
              <title>{{ it.tip }}</title>
              <rect :width="it.w" :height="PH" rx="8.5" />
              <template v-if="it.j"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4">{{ it.text }}</text></template>
              <text v-else class="bjt" :x="it.w / 2" :y="PH / 2 + 4" text-anchor="middle">{{ it.text }}</text>
            </g>
          </g>
        </g>
        <g v-for="p in packets" :key="p.key" class="pk" :transform="`translate(${p.x} ${p.y})`">
          <title>{{ p.tip }}</title>
          <circle r="8" :fill="KIND_COL[p.kind] ?? KIND_COL.info" /><text y="3" text-anchor="middle">{{ KIND_GLYPH[p.kind] ?? "i" }}</text>
        </g>
      </g>
    </svg>
    <ul v-if="recent.length" class="mstrip" aria-label="Recent messages">
      <li v-for="m in recent" :key="m.id ?? m.at" :title="tipOf(m)" :class="{ open: stripOpen === m.id }" @click="stripOpen = stripOpen === m.id ? null : m.id"><i :style="{ background: KIND_COL[m.kind] ?? KIND_COL.info }">{{ KIND_GLYPH[m.kind] ?? "i" }}</i><span>{{ tipOf(m) }}</span></li>
    </ul>
    <ul v-if="hooks.nodes.length || unplaced.length" class="hkl" aria-label="Teams without a cluster, and hooks (server-wide)">
      <li v-for="t in unplaced" :key="'t' + t.id" class="tchip" role="button" tabindex="0" :title="`Open team ${t.name}: ${t.members.join(', ')}`" @click="emit('select', 'team:' + t.id)" @keydown.enter="emit('select', 'team:' + t.id)"><b>{{ t.name }}</b> team</li>
      <li v-for="h in hooks.nodes" :key="h.script" :class="{ off: !h.enabled, glow: glow.has(h.script) }" :title="`${h.name} · ${h.events.join(', ')}${h.enabled ? '' : ' (off)'}${h.live ? '' : ' · keeps no log, so it cannot light up live'}`"><i />{{ h.name }}</li>
    </ul>
    <div class="zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom in" @click="zoomAt(1.25)"><Icon name="plus" :size="16" /></button>
      <button type="button" aria-label="Zoom out" @click="zoomAt(1 / 1.25)"><Icon name="minus" :size="16" /></button>
      <button type="button" aria-label="Fit to screen" @click="fit"><Icon name="maximize" :size="16" /></button>
    </div>
    <p v-if="net.connected && !count" class="none">No live agents yet. Agents spawned with <code>spawn-agent.sh</code> show here within seconds.</p>
  </div>
</template>

<style scoped>
.cl.team{cursor:pointer;outline:none}
.cl.team > rect{stroke:color-mix(in srgb,var(--on) 38%,var(--line))}
.cl.team:hover > rect,.cl.team:focus-visible > rect{stroke:var(--on)}
.lead rect{fill:color-mix(in srgb,var(--on) 22%,transparent);stroke:color-mix(in srgb,var(--on) 55%,transparent);stroke-width:1}
.lead.more rect{fill:color-mix(in srgb,var(--ink) 8%,transparent);stroke:var(--line)}
.lead.more text{fill:var(--muted)}
.lead text{font:700 11px var(--body);fill:var(--on);letter-spacing:.05em}
.bjl{fill:none;stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;opacity:.55}
.bjp{cursor:pointer;outline:none}
.bjp rect{fill:var(--panel);stroke:var(--line);stroke-width:1}
.bjp.tag rect{fill:none;stroke:color-mix(in srgb,var(--warn) 55%,transparent)}
.bjp.tag{cursor:default}
.bjp.tag .bjt{fill:var(--warn)}
.bjp.chip rect{fill:color-mix(in srgb,var(--ink) 8%,var(--panel))}
.bjp:hover rect,.bjp:focus-visible rect{stroke:var(--on)}
.bjp .bjt{font:600 12px var(--body);fill:var(--muted)}
.bjp.chip .bjt{fill:var(--ink)}
.bjp .bjd{fill:var(--off)}
.bjp.running .bjd{fill:var(--on);animation:jpulse 1.6s ease-in-out infinite}
.bjp.done .bjd{fill:var(--on)} .bjp.failed .bjd{fill:var(--bad)}
@keyframes jpulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.bjp.running .bjd{animation:none}}
.pk{pointer-events:none}
.pk text{font:700 10px var(--body);fill:#0d0d0f}
.pk circle{filter:drop-shadow(0 0 5px rgba(255,255,255,.35))}
.mstrip{position:absolute;left:12px;top:12px;z-index:2;list-style:none;margin:0;padding:0;display:grid;gap:4px;max-width:min(360px,calc(100% - 100px));pointer-events:none}
.mstrip li{pointer-events:auto;display:flex;align-items:center;gap:6px;padding:3px 9px 3px 4px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--muted);font:500 11.5px/1.3 var(--body);cursor:default;overflow:hidden;animation:mst .3s cubic-bezier(.2,.8,.2,1)}
.mstrip li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mstrip li.open span{white-space:normal}
.mstrip i{flex:none;display:grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#0d0d0f;font:700 10px/1 var(--body);font-style:normal}
@keyframes mst{from{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion:reduce){.mstrip li{animation:none}}
.amap{--hook:#f2b04a;position:relative;flex:1;min-width:0;min-height:0;border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
.amap-svg{position:absolute;inset:0 0 var(--rv,0) 0;width:100%;height:calc(100% - var(--rv,0px));touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.amap-svg:active{cursor:grabbing}
.cl rect{fill:color-mix(in srgb,var(--ink) 3%,transparent);stroke:color-mix(in srgb,var(--ink) 16%,transparent);transition:stroke .2s var(--ease),fill .2s var(--ease)}
.cl.live rect{stroke:color-mix(in srgb,var(--on) 45%,transparent);fill:color-mix(in srgb,var(--on) 4%,transparent)}
.cl-t{fill:var(--ink);font:600 15px var(--body);pointer-events:none}
.cl-s{fill:var(--muted);font:400 13px var(--body);pointer-events:none;font-variant-numeric:tabular-nums}
.ln{fill:none;stroke:color-mix(in srgb,var(--ink) 38%,transparent);stroke-width:1.6;stroke-linejoin:round;transition:stroke .3s var(--ease),stroke-width .3s var(--ease)}
.ln.live{stroke:color-mix(in srgb,var(--on) 75%,transparent)}
.nd{cursor:pointer;outline:none}
.card{fill:var(--panel-2);stroke:var(--line);stroke-width:1.25;transition:stroke .2s var(--ease),fill .2s var(--ease)}
.nd:hover .card,.nd.sel .card{stroke:color-mix(in srgb,var(--ink) 60%,transparent)}
.nd.sel .card{stroke:var(--on);fill:color-mix(in srgb,var(--on) 7%,var(--panel-2))}
.nd:focus-visible .card{stroke:var(--on);stroke-width:2}
.nd.root .card{fill:color-mix(in srgb,var(--lock) 10%,var(--panel-2))}
.nm{fill:var(--ink);font:650 15px var(--body);pointer-events:none}
.sub{fill:var(--muted);font:500 13px var(--body);pointer-events:none}
.ctx{fill:var(--muted);font:600 12px var(--mono);pointer-events:none}
.ctx.hi{fill:var(--warn)}
.hkl{position:absolute;left:10px;bottom:10px;right:70px;margin:0;padding:0;list-style:none;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.hkl li{flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:var(--panel-2);color:var(--muted);font:500 12px/1.3 var(--body);white-space:nowrap;transition:border-color .2s var(--ease),color .2s var(--ease)}
.hkl li.tchip{cursor:pointer;color:var(--ink);border-color:color-mix(in srgb,var(--on) 45%,var(--line))}
.hkl li.tchip b{font-weight:600}
.hkl li.tchip:hover,.hkl li.tchip:focus-visible{border-color:var(--on);outline:none}
.hkl i{width:7px;height:7px;border-radius:50%;background:var(--hook)}
.hkl li.off{opacity:.55}.hkl li.off i{background:var(--off)}
.hkl li.glow{border-color:var(--hook);color:var(--ink)}
@media (max-width:559px){.amap.narrow .hkl{top:56px;bottom:auto;left:8px;right:8px}}
.pbg{fill:var(--track)}
.pfg{fill:var(--on);transition:width .4s var(--ease)}
.ln.hot{stroke:var(--on);stroke-width:2.6}
.nd.hot .card{stroke:var(--on);fill:color-mix(in srgb,var(--on) 12%,var(--panel-2))}
.dot{fill:var(--off)}
.s-working .dot{fill:var(--on);animation:pulse 1.6s var(--ease) infinite}
.s-waiting .dot{fill:var(--warn)}
.s-blocked .dot{fill:var(--bad)}
.s-blocked .sub{fill:var(--warn)}
.s-starting .dot{fill:transparent;stroke:var(--muted);stroke-width:1.6;stroke-dasharray:2.5 2}
.s-starting .card{stroke-dasharray:5 4}
.s-stopping{opacity:.55}
.s-root .dot{fill:var(--lock)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.zoom{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;gap:6px}
.zoom button{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2);color:var(--ink);cursor:pointer}
@media (max-width:559px){.amap.narrow .amap-svg{top:88px;height:calc(100% - 88px)}.amap.narrow .zoom{top:4px;right:6px;bottom:auto;flex-direction:row}}
.zoom button:hover{background:var(--track)}
.zoom button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.none{position:absolute;inset:auto 0 40% 0;margin:0;text-align:center;color:var(--muted)}
@media (prefers-reduced-motion:reduce){.s-working .dot{animation:none}.cl rect,.ln,.card,.pfg,.hkl li{transition:none}}
</style>
