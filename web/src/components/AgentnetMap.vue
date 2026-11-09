<script setup lang="ts">
// Org-chart map of the live agents (replaces the retired agmsg Agent network chart). The director (root) sits on top;
// each of its direct reports opens a soft box labelled with its job, with that agent's own reports indented under it
// (boss field = edges). The dot and the second line are the card's own state and `doing`, read straight from the reactive
// rows, so a status patch re-renders text only; the layout is recomputed on a boss/job change or a resize.
import { computed, onMounted, onUnmounted, ref, shallowRef, watch, nextTick } from "vue";
import Icon from "../ui/Icon.vue";
import { net, hooks, layoutKey, humanDoing, ctxView, bgVisible, bgShown, BG_KEEP_MS, jobFocus, checkUi, teams, teamsKey, placing, type AgentRow, type BgRow, type Check, type Msg } from "../net";
import { api } from "../ui/api";
import { cardLine } from "../cardline";

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
const CH = 76, ROW = 100, HEAD = 78, PAD = 20, IND = 26, GAP = 40, KMIN = 0.7, KMAX = 1.5;
const row = (id: string): AgentRow | null => net.agents[id] ?? null;
const rootRow = computed(() => Object.values(net.agents).find((a) => a.name === ROOT) ?? null);
const nameOf = (id: string) => (id === ROOT ? ROOT : row(id)?.name ?? id);
/** Card status line: wraps on words up to SUB_MAX lines; the model prefix shares line 1. Card height grows SUB_LH per extra line. */
const NODE_LH = 16, CARD_MAX = 5;
/** Model chip in the card's top row, left of the context %: its width and the space the right-hand badges take. */
const chipW = (id: string) => (id !== ROOT && modelOf(id) ? modelOf(id)!.length * 6.6 + 16 : 0);
const rightOff = (id: string) => (ctxOf(id) !== null ? 50 : 14) + (chipW(id) ? chipW(id) + 6 : 0);
const subOf = (id: string, w: number): string[] => {
  const n = Math.max(10, Math.floor((w - 52) / (13 * 0.56)));
  const lines = wrap(line2(id), n, CARD_MAX);
  return lines.length ? lines : [""];
};
/** Card height hysteresis: a card grows at once, but shrinks only after its text has stayed shorter for SHRINK_MS, so a fast
 *  stream of status lines (root's tool calls) does not bounce the box between sizes. */
const SHRINK_MS = 3000, held = new Map<string, { n: number; since: number }>();
const lineCount = (id: string, w: number) => {
  const cur = subOf(id, w).length, now = net.now || Date.now(), h = held.get(id);
  if (!h || cur > h.n) { held.set(id, { n: cur, since: 0 }); return cur; }
  if (cur === h.n) { h.since = 0; return cur; }
  if (!h.since) h.since = now;
  if (now - h.since >= SHRINK_MS) { held.set(id, { n: cur, since: 0 }); return cur; }
  return h.n;
};
/** A card without a progress bar (no tasks, or all done) is 14 px shorter: no empty strip where the bar was. */
const noBar = (id: string) => (prog(id) === null ? 14 : 0);
const extraH = (id: string, w: number) => { const l = lineCount(id, w); return (l - 1) * NODE_LH + (l > 1 ? 4 : 0); };
const cardW = (id: string) => Math.max(236, bgNeedW(id), nameOf(id).length * 9 + 140 + (isLead(id) ? 56 : 0) + (extraTeams(id) > 0 ? 38 : 0) + (chipW(id) ? chipW(id) + 6 : 0));

/** boss tree among the rows on the map: boss "root", no boss, an unknown boss or a loop all hang under the director. */
/** Active teams with at least one live member: agent id -> team (first team wins). Their members leave the boss tree and sit in the team's region. */
function teamGroups() {
  const out: { team: (typeof teams.list)[number]; ids: string[]; elsewhere: string[] }[] = [], used = new Set<string>(), byName = new Map(Object.values(net.agents).filter((a) => a.name !== ROOT && !placing.has(a.name)).map((a) => [a.name, a.id]));
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
  const list = Object.values(net.agents).filter((a) => a.name !== ROOT && !skip.has(a.id) && !placing.has(a.name));
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
// Background work the agent runs itself (subagents, shells, monitors), posted by the plugin hooks: shown as pills above the job pills.
const BG_SHOW = 4, BGK: Record<string, string> = { subagent: "Subagent", shell: "Shell", monitor: "Monitor" };
const bgBy = computed(() => {
  const m = new Map<string, BgRow[]>(), now = net.now || Date.now();
  for (const a of Object.values(net.agents)) {
    const rows = bgVisible(a.bg, now);
    if (rows.length) m.set(a.name === ROOT ? ROOT : a.id, rows.slice(-BG_SHOW));
  }
  return m;
});
// A background chip reads "Shell · <sentence>" in full: wrapped to at most 2 lines at the chip width, the chip grows by one text line when it needs the second, and the elapsed time stays at the right.
const CW = 5.7, LH = 13, BG_W = 360, TIME_W = 5 * CW + 10;
/** Chip text in at most 2 lines: line 1 leaves room for the elapsed time, line 2 has the full width. Ellipsis only when 2 lines are not enough. */
const CK_W = 400;
const chipLines = (text: string, wNode: number, timeW = TIME_W, cap = BG_W) => {
  const W = Math.min((wNode - 36) / pillS.value, cap), n1 = Math.max(8, Math.floor((W - 25 - timeW) / CW)), n2 = Math.max(8, Math.floor((W - 25) / CW));
  const words = text.split(/\s+/), out: string[] = [""];
  for (const w of words) {
    const i = out.length - 1, cap = i ? n2 : n1;
    if (!out[i]) out[i] = w; else if (out[i].length + 1 + w.length <= cap) out[i] += " " + w; else if (!i) out.push(w); else { out[i] = out[i].slice(0, Math.max(1, cap - 1)).replace(/[\s·,]+$/, "") + "…"; break; }
  }
  return out.map((l, i) => (l.length > (i ? n2 : n1) && l.at(-1) !== "…" ? l.slice(0, (i ? n2 : n1) - 1) + "…" : l));
};
const bgLines = (b: BgRow, wNode: number) => chipLines(`${BGK[b.kind] ?? b.kind} · ${b.label}`, wNode);

// ---------- owner checks: an amber chip under the asker's box ("Waiting for you · question"); an agent that is gone hangs it under root, dashed ----------
const checksBy = computed(() => {
  const m = new Map<string, Check[]>(), byName = new Map(Object.values(net.agents).map((a) => [a.name, a]));
  for (const k of Object.values(net.checks).sort((a, b) => a.id - b.id)) {
    const a = byName.get(k.agent), id = !a || a.name === ROOT ? ROOT : a.id;
    (m.get(id) ?? m.set(id, []).get(id)!).push(k);
  }
  return m;
});
const checkText = (k: Check) => (k.state === "pending" ? `Waiting for you · ${k.question}` : `${k.answer} · ${k.question}`);
const checkLines = (k: Check, wNode: number) => chipLines(checkText(k), wNode, 0, CK_W);
const checkExtra = (id: string, wNode: number) => (checksBy.value.get(id) ?? []).reduce((a, k) => a + (checkLines(k, wNode).length - 1) * LH, 0);
const bgExtra = (id: string, wNode: number) => (bgBy.value.get(id) ?? []).reduce((a, b) => a + (bgLines(b, wNode).length - 1) * LH, 0) + checkExtra(id, wNode);
/** The card width a long chip sentence wants (two lines at the chip font), capped: short sentences keep the normal card. */
const BG_CARD_MAX = 360;
const ckNeedW = (id: string) => Math.max(0, ...(checksBy.value.get(id) ?? []).map((k) => Math.ceil(36 + pillS.value * (Math.ceil(checkText(k).length * 0.58) * CW + 32))));
const bgNeedW = (id: string) => { const ck = Math.min(CK_W + 40, ckNeedW(id)); return Math.max(ck, bgNeedW0(id)); };
const bgNeedW0 = (id: string) => { const rows = bgBy.value.get(id) ?? [], cks = checksBy.value.get(id) ?? []; if (!rows.length && !cks.length) return 0; const len = Math.min(70, Math.max(0, ...rows.map((b) => (BGK[b.kind] ?? b.kind).length + 3 + b.label.length)));  return Math.min(BG_CARD_MAX, Math.ceil(36 + pillS.value * (((len + 12) * CW + 50 + TIME_W) / 2))); };
const rootW = computed(() => Math.max(256, bgNeedW(ROOT)));
const linesOf = (id: string) => { const nb = (bgBy.value.get(id)?.length ?? 0) + (checksBy.value.get(id)?.length ?? 0), g = jobsBy.value.get(id); if (!g) return nb; const dn = expandedDone.value.has(id) ? Math.min(3, g.done.length) : 0; return nb + g.run.length + dn + (g.more || g.done.length || g.retired ? 1 : 0); };
const exOf = (id: string, w = rootW.value) => (linesOf(id) ? (linesOf(id) * (PH + 5) + bgExtra(id, w)) * pillS.value + 12 : 0);
const jobSig = computed(() => [...new Set([...jobsBy.value.keys(), ...bgBy.value.keys(), ...checksBy.value.keys()])].sort().map((k) => k + ":" + linesOf(k) + ":" + bgNeedW(k) + ":" + bgExtra(k, nodes.value.get(k)?.w ?? rootW.value)).join(","));
const jdur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h"; };
interface It { key: string; kind: "pill" | "chip" | "tag" | "bg" | "check"; cs?: string; ghost?: boolean; bg?: BgRow; op?: number; x: number; y: number; w: number; h?: number; lines?: string[]; time?: string; j?: BJ; text: string; tip: string; act?: () => void }
const short = (t: string, n = 18) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const jobRows = computed(() => {
  const out = new Map<string, { items: It[]; y: number; x0: number }>();
  const ids = new Set([...jobsBy.value.keys(), ...bgBy.value.keys(), ...checksBy.value.keys()]), none: JG = { run: [], more: 0, done: [], retired: false };
  for (const id of ids) {
    const g = jobsBy.value.get(id) ?? none;
    const n = id === ROOT ? dirNode.value : nodes.value.get(id); if (!n) continue;
    const exp = expandedDone.value.has(id), pills = [...g.run, ...(exp ? g.done.slice(0, 3) : [])];
    const S = pillS.value, x0 = (-n.w / 2 + 26) / S, W0 = (n.w - 36) / S, items: It[] = []; let y = 0;
    const nowT = net.now || Date.now();
    for (const k of checksBy.value.get(id) ?? []) {
      const lines = checkLines(k, n.w), ghost = id === ROOT && k.agent !== ROOT, who = `${k.agent}${ghost || !row(id) ? " (closed)" : ""}`;
      items.push({ key: "ck:" + k.id, kind: "check", cs: k.state === "pending" ? "pending" : k.answerTone ?? "neutral", ghost, x: x0, y, w: Math.min(W0, CK_W), h: PH + (lines.length - 1) * LH, lines, time: "", text: lines.join(" "),
        tip: k.state === "pending" ? `Waiting for you: ${k.question} · asked by ${who}. Tap to answer.` : `You answered "${k.answer}": ${k.question}`, act: k.state === "pending" ? () => { checkUi.list = false; checkUi.id = k.id; } : undefined });
      y += PH + (lines.length - 1) * LH + 5;
    }
    for (const b of bgBy.value.get(id) ?? []) {
      const live = b.state === "running", stale = bgShown(b, nowT) === "stale", el = jdur((live ? nowT : b.endedAt ?? nowT) - b.startedAt), age = live ? 0 : nowT - (b.endedAt ?? nowT);
      const lines = bgLines(b, n.w), h = PH + (lines.length - 1) * LH, time = stale ? "stale" : el, tail = `${b.state} · ${el}`;
      items.push({ key: "bg:" + b.id, kind: "bg", bg: b, x: x0, y, w: Math.min(W0, BG_W), h, lines, time, op: stale || age > BG_KEEP_MS - 20_000 ? 0.45 : 1, text: `${lines.join(" ")} · ${time}`, tip: `${BGK[b.kind] ?? b.kind}: ${b.label}${b.cmd && b.cmd !== b.label ? `\n${b.cmd}` : ""}\n${tail}` }); y += h + 5;
    }
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
  const nm = new Map<string, N>(), cl: C[] = [];
  const seen = new Set<string>();
  const parentOf = new Map<string, string>();
  const also = new Map(tg.map((g) => [g.team.id, g.elsewhere.length]));
  // Inside a team the lead sits on top and every member hangs under its boss (the lead when its boss is outside the cluster),
  // indented, with an elbow line from boss to report: the team's own hierarchy.
  const grp: { lead: string; rows: { id: string; depth: number }[]; team?: (typeof tg)[number]["team"] }[] = tg.map((g) => {
    const inC = new Set(g.ids), lead = g.team.lead ? g.ids.find((id) => nameOf(id) === g.team.lead) : undefined;
    if (!lead) return { lead: g.ids[0], rows: g.ids.map((id) => ({ id, depth: 0 })), team: g.team };
    const byN = new Map(g.ids.map((id) => [nameOf(id), id])), kidsOf = new Map<string, string[]>();
    for (const id of g.ids) { if (id === lead) continue; const b = byN.get(row(id)?.boss ?? ""); const par = b && inC.has(b) && b !== id ? b : lead; kidsOf.set(par, [...(kidsOf.get(par) ?? []), id]); }
    const rows: { id: string; depth: number }[] = [], done = new Set<string>();
    const walk = (id: string, d: number) => { if (done.has(id)) return; done.add(id); rows.push({ id, depth: Math.min(d, 3) }); for (const k of kidsOf.get(id) ?? []) { parentOf.set(k, id); walk(k, d + 1); } };
    walk(lead, 0); for (const id of g.ids) if (!done.has(id)) { parentOf.set(id, lead); walk(id, 1); }
    return { lead, rows, team: g.team };
  });
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
    const c: C = { id: "c:" + lead, label, team: team?.id, goal: team?.goal ?? null, also: also.get(team?.id ?? ""), ids: rows.map((r) => r.id), x: 0, y: 0, w: Math.max(PAD * 2 + depth * IND + w0, Math.min(label.length, 40) * 7 + 60, team ? 250 : 0), h: 0 };
    c.h = HEAD + rows.reduce((a, r) => a + ROW + exOf(r.id, c.w - PAD * 2 - r.depth * IND) + extraH(r.id, c.w - PAD * 2 - r.depth * IND) - noBar(r.id), 0) - (ROW - CH) + PAD;
    const hh = headOf(c); c.h += hh - HEAD;
    let yy = hh;
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; const w = c.w - PAD * 2 - r.depth * IND; const h = CH + extraH(r.id, w) - noBar(r.id); nm.set(r.id, { id: r.id, w, h, x: PAD + r.depth * IND + w / 2, y: yy + h / 2 }); yy += ROW + exOf(r.id, w) + h - CH; }
    cl.push(c);
  }
  const rw = rootW.value, dh = 64 + extraH(ROOT, rw); /* root card has no progress bar: no empty strip under the status line */ const d: N = { id: ROOT, w: rw, h: dh, x: 0, y: dh / 2 };
  const topY = d.h + 64 + exOf(ROOT, rw);
  if (!portrait()) {
    const maxW = Math.max(520, (W.value - 40) / KMIN);
    const rws: C[][] = [[]]; let rw = 0;
    for (const c of cl) { if (rws[rws.length - 1].length && rw + GAP + c.w > maxW) { rws.push([]); rw = 0; } rws[rws.length - 1].push(c); rw += (rws[rws.length - 1].length > 1 ? GAP : 0) + c.w; }
    const widths = rws.map((r0) => r0.reduce((a, c) => a + c.w, 0) + (r0.length - 1) * GAP);
    const outer = Math.max(0, ...widths) / 2 + 30;
    let y = topY;
    /** A wrapped row's link drops through the nearest gap that is clear in every row above it (outer gutter only as a fallback). */
    const clear = (gx: number, upto: number) => rws.slice(0, upto).every((r0) => r0.every((c) => gx < c.x - 4 || gx > c.x + c.w + 4));
    const viaFor = (cx: number, ri: number) => {
      const gaps = rws.slice(0, ri).flatMap((r0) => r0.slice(1).map((c) => c.x - GAP / 2)).filter((gx) => clear(gx, ri));
      return gaps.length ? gaps.reduce((a, b) => (Math.abs(b - cx) < Math.abs(a - cx) ? b : a)) : cx < 0 ? -outer : outer;
    };
    rws.forEach((r0, ri) => {
      let x = -widths[ri] / 2;
      for (const c of r0) { c.x = x; c.y = y; c.via = ri ? viaFor(c.x + c.w / 2, ri) : undefined; x += c.w + GAP; }
      y += Math.max(0, ...r0.map((c) => c.h)) + 52;
    });
  } else {
    const trunk = 20; let y = topY;
    d.x = d.w / 2;
    for (const c of cl) { c.x = trunk + 22; c.y = y; y += c.h + 22; }
  }
  for (const c of cl) for (const id of c.ids) { const n = nm.get(id)!; n.x += c.x; n.y += c.y; }
  geo.parentOf = parentOf; geo.port = portrait(); geo.exRoot = exOf(ROOT);
  animateTo({ nm, cl, d });
}
/** Layout geometry the links are drawn from; kept so a frame of the tween can redraw them. */
const geo = { parentOf: new Map<string, string>(), port: false, exRoot: 0 };
interface Geo { nm: Map<string, N>; cl: C[]; d: N }
const linksOf = ({ nm, cl, d }: Geo): L[] => {
  const lk: L[] = [];
  if (!geo.port) { const bus = d.h + 22 + geo.exRoot; for (const c of cl) lk.push({ to: c.ids[0], d: c.via === undefined ? `M0,${d.h} V${bus} H${c.x + c.w / 2} V${c.y}` : `M0,${d.h} V${bus} H${c.via} V${c.y - 26} H${c.x + c.w / 2} V${c.y}` }); }
  else for (const c of cl) lk.push({ to: c.ids[0], d: `M20,${d.h} V${c.y + 26} H${c.x}` });
  // One trunk per parent down to its last child, plus a short stub per child: no overlapping segments, so translucent strokes
  // never stack into a gradient.
  const kidsBy = new Map<string, string[]>(); for (const [k, p] of geo.parentOf) kidsBy.set(p, [...(kidsBy.get(p) ?? []), k]);
  for (const [p, ks] of kidsBy) {
    const a = nm.get(p); if (!a) continue; const x = a.x - a.w / 2 + 14, bs = ks.map((k) => nm.get(k)).filter((b): b is N => !!b); if (!bs.length) continue;
    lk.push({ to: "trunk:" + p, d: `M${x},${a.y + a.h / 2} V${Math.max(...bs.map((b) => b.y))}` });
    for (const b of bs) lk.push({ to: b.id, d: `M${x},${b.y} H${b.x - b.w / 2}` });
  }
  return lk;
};
const paint = (g: Geo) => { nodes.value = g.nm; boxes.value = g.cl; links.value = linksOf(g); dirNode.value = g.d; };
/** Load and refresh land in place: layout and camera only animate once the first passes (fonts, pill scale, measure) are done. */
let settled = false;
/** While the window is being resized, layout and camera snap (no tween): tweening from a half-done frame left boxes overlapping. */
let resizingUntil = 0;
const resizing = () => performance.now() < resizingUntil;
onMounted(() => setTimeout(() => { settled = true; }, 1500));
/** The final layout (fit and the selection reads it); a layout change tweens every box, card and link to it in 320 ms. */
let target: Geo | null = null, geoRaf = 0;
const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
const mixN = (a: N | undefined, b: N, e: number): N => (a ? { ...b, x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) } : b);
function animateTo(t: Geo) {
  const from: Geo = { nm: nodes.value, cl: boxes.value, d: dirNode.value }, first = !target;
  target = t; cancelAnimationFrame(geoRaf);
  if (first || reduce || !settled || resizing()) { paint(t); return; }
  const fc = new Map(from.cl.map((c) => [c.id, c])), t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / 320), e = 1 - (1 - p) ** 3;
    if (p >= 1) { paint(t); return; }
    const nm = new Map([...t.nm].map(([id, n]) => [id, mixN(from.nm.get(id), n, e)] as [string, N]));
    const cl = t.cl.map((c) => { const a = fc.get(c.id); return a ? { ...c, x: lerp(a.x, c.x, e), y: lerp(a.y, c.y, e), w: lerp(a.w, c.w, e), h: lerp(a.h, c.h, e), via: c.via !== undefined && a.via !== undefined ? lerp(a.via, c.via, e) : c.via } : c; });
    paint({ nm, cl, d: mixN(from.d, t.d, e) });
    geoRaf = requestAnimationFrame(step);
  };
  geoRaf = requestAnimationFrame(step);
}

/** Fit glides the camera with the same 320 ms ease as the layout, so content and zoom move together. */
let viewRaf = 0;
function glideView(nv: { x: number; y: number; k: number }) {
  cancelAnimationFrame(viewRaf);
  const a = view.value; if (reduce || !target || !settled || resizing() || (Math.abs(a.k - nv.k) < 1e-3 && Math.abs(a.x - nv.x) < 0.5 && Math.abs(a.y - nv.y) < 0.5)) { view.value = nv; return; }
  const t0 = performance.now();
  const step = (now: number) => { const p = Math.min(1, (now - t0) / 320), e = 1 - (1 - p) ** 3; view.value = { k: lerp(a.k, nv.k, e), x: lerp(a.x, nv.x, e), y: lerp(a.y, nv.y, e) }; if (p < 1) viewRaf = requestAnimationFrame(step); };
  viewRaf = requestAnimationFrame(step);
}
/** True once the user pans or zooms: live updates (status, tasks, new agents) then keep their camera and only the
 *  Fit button or a double click re-fits. User report 2026-11-09: every status update reset the zoom and pan. */
let userView = false;
function fit(auto = false) {
  const keep = auto && userView;
  const d = target?.d ?? dirNode.value;
  let x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, y0 = 0, y1 = d.h;
  for (const c of target?.cl ?? boxes.value) { x0 = Math.min(x0, c.x, c.via ?? Infinity); x1 = Math.max(x1, c.x + c.w, c.via ?? -Infinity); y1 = Math.max(y1, c.y + c.h); }
  const cw = x1 - x0 + 40, ch = y1 - y0 + 40;
  // Everything in view; the floor KMIN keeps text readable. A desktop canvas also zooms IN (up to KMAX) so a small tree fills the area, centred.
  const k = Math.max(KMIN, portrait() ? Math.min(1, W.value / cw) : Math.min(KMAX, W.value / cw, H.value / ch));
  const nv = { k, x: portrait() ? 12 - x0 * k : W.value / 2 - ((x0 + x1) / 2) * k, y: portrait() ? 20 : Math.max(16, (H.value - (y1 - y0) * k) / 2) };
  if (!keep) glideView(nv);
  contentH.value = portrait() ? Math.ceil(ch * (keep ? view.value.k : k) + 8) + reserve() : 0;
  // Ground truth: the drawn content's real bottom edge, so a wrong estimate never leaves an empty canvas under the last node.
  if (portrait()) nextTick(() => { const b = gEl.value?.getBBox?.(); if (b && b.height > 0) contentH.value = Math.ceil((b.y + b.height) * view.value.k + view.value.y + 16) + reserve(); });
}
const relayout = (again = 0) => { layout(); nextTick(() => { fit(true); const k = view.value.k, want = narrow() || k >= 0.95 ? 1 : k >= 0.8 ? 1.2 : 1.45; if (want !== pillS.value && jobsBy.value.size && again < 2) { pillS.value = want; relayout(again + 1); } }); };
watch(layoutKey, () => relayout());
watch(teamsKey, () => relayout());
watch(jobSig, () => relayout());

let ro: ResizeObserver | null = null;
onMounted(() => {
  const measure = () => { if (!box.value) return; const r = box.value.getBoundingClientRect(), h = r.height - (r.width < 560 ? 88 : hooks.nodes.length || unplaced.value.length ? 48 : 0); if (Math.abs(r.width - W.value) > 1 || Math.abs(h - H.value) > 1) { resizingUntil = performance.now() + 400; W.value = r.width; H.value = h; relayout(); } };
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
  drag.moved = true; userView = true; cancelAnimationFrame(viewRaf); view.value = { ...view.value, x: drag.vx + dx, y: drag.vy + dy };
};
const onUp = () => { panned = !!drag?.moved; drag = null; setTimeout(() => { panned = false; }, 0); };
function zoomAt(f: number, cx = W.value / 2, cy = H.value / 2) {
  userView = true; cancelAnimationFrame(viewRaf);
  const v = view.value, k = Math.max(0.3, Math.min(2.5, v.k * f)), r = k / v.k;
  view.value = { k, x: cx - (cx - v.x) * r, y: cy - (cy - v.y) * r };
}
/** Trackpad like Figma/Maps: two-finger scroll pans, pinch (sent as ctrl+wheel) zooms at the cursor. */
const onWheel = (e: WheelEvent) => {
  const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H.value : 1, dx = e.deltaX * m, dy = e.deltaY * m;
  if (e.ctrlKey || e.metaKey) { const r = box.value!.getBoundingClientRect(); zoomAt(Math.exp(-dy * 0.01), e.clientX - r.left, e.clientY - r.top); return; }
  userView = true; cancelAnimationFrame(viewRaf); view.value = { ...view.value, x: view.value.x - dx, y: view.value.y - dy };
};
const refit = () => { userView = false; fit(); };
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
/** A turn that just started carries the raw incoming message as "doing": the card shows the current job instead (in-progress task),
 *  else a short "Handling a Telegram message" / "Reading a report from X". Tool activity is not a prompt and passes through. */
const promptLine = (doing: string | null | undefined, task: string | undefined): string | null => {
  if (!doing) return null;
  const h = humanDoing(doing) ?? "";
  const an = /^(\w+) from ([^:]+):/.exec(h);
  if (/^The agentnet plugin sent a message/.test(doing) && an) return task ?? `Reading ${an[1].toLowerCase()} from ${an[2].trim()}`;
  const ch = /^\s*<channel\b[^>]*?source="(?:plugin:)?([A-Za-z0-9_-]+)/.exec(doing)?.[1] ?? /^(Telegram|Chat|Voice|Discord|Slack): /.exec(doing)?.[1];
  if (ch) return task ?? `Handling a ${ch.charAt(0).toUpperCase()}${ch.slice(1)} message`;
  if (/^You are [\w-]+ on the agentnet\b/.test(doing)) return task ?? "Reading its brief";
  return null;
};
const line2 = (id: string) => {
  const r = id === ROOT ? rootRow.value : row(id);
  if (!r) return id === ROOT ? "Tap to start" : "";
  const fresh = cardLine(r, net.now || Date.now(), Object.values(net.checks));
  if (fresh) return fresh;
  return id === ROOT && r.state === "idle" && !r.doing ? "Director · idle" : promptLine(r.doing, undefined) ?? humanDoing(r.doing) ?? LABEL[dotOf(id)];
};
/** Cut a string to roughly `px` pixels at `fs` px (no text measuring in SVG: ~0.56 em per character). */
const fitText = (s: string, px: number, fs = 13) => { const n = Math.max(4, Math.floor(px / (fs * 0.56))); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
/** Structure: the group title is WHAT the group is for (team name, else the agent's job); the card below says what it is doing now.
 *  Never the in-progress task here: that is the card's status line, and showing it twice mixed the two levels up. */
const labelOf = (c: C) => { if (c.team) return c.label; const r = row(c.ids[0]); return r?.job ?? c.label; };
/** The lead of an active team wears a LEAD tag on its node. */
const activeTeams = () => teams.list.filter((t) => t.state === "active");
/** Teams an agent is in besides the one whose cluster draws it, with its role there. */
const otherTeams = (id: string) => { const home = placedIn.value.get(id), n = nameOf(id); return activeTeams().filter((t) => t.id !== home && t.members.includes(n)); };
const extraTeams = (id: string) => otherTeams(id).length;
const extraTip = (id: string) => otherTeams(id).map((t) => (t.lead === nameOf(id) ? `Also lead of ${t.name}` : `Also in ${t.name}`)).join(" · ");
/** LEAD only for the team whose cluster the node sits in. */
const isLead = (id: string) => { const t = activeTeams().find((x) => x.id === placedIn.value.get(id)); return !!t && t.lead === nameOf(id); };
/** Active teams with no cluster on the map because every live member sits in an earlier team: reachable as chips in the hook strip. Teams with no live member are not shown. */
const unplaced = computed(() => { const live = new Set(Object.values(net.agents).map((a) => a.name)); return activeTeams().filter((t) => !placedTeams.value.has(t.id) && t.members.some((m) => live.has(m))); });
const pickTeam = (c: C) => { if (c.team && !panned) emit("select", "team:" + c.team); };
/** Cluster sub blocks at 13 px: the team's purpose (target icon) and what the team is doing now (activity icon). Each wraps on
 *  words up to SUB_MAX lines (no text measuring in SVG: ~0.56 em per character). No member counts: the icon stack shows them. */
const SUB_LH = 17, SUB_GAP = 9, SUB_MAX = 3, SUB_IND = 20, HEAD_BARE = 46;
const wrap = (t: string, n: number, max = SUB_MAX): string[] => {
  const out: string[] = []; let cur = "";
  for (const w0 of t.trim().split(/\s+/)) {
    for (let w = w0; w; ) { const piece = w.length > n ? w.slice(0, n) : w; w = w.slice(piece.length); if (!cur) cur = piece; else if (cur.length + 1 + piece.length <= n) cur += " " + piece; else { out.push(cur); cur = piece; } }
  }
  if (cur) out.push(cur);
  if (out.length > max) { out.length = max; const l = out[max - 1]; out[max - 1] = (l.length >= n ? l.slice(0, n - 1) : l) + "…"; }
  return out;
};
const subBlocks = (c: C): { kind: "goal" | "now"; lines: string[]; y: number }[] => {
  if (!c.team) return [];
  const n = Math.max(12, Math.floor((c.w - 40 - SUB_IND) / (13 * 0.56)));
  const raw: { kind: "goal" | "now"; text: string }[] = [];
  if (c.goal) raw.push({ kind: "goal", text: c.goal });
  const now = nowOf(c); if (now) raw.push({ kind: "now", text: now });
  let y = 50 + titleExtra(c); return raw.map((b) => { const lines = wrap(b.text, n), out = { kind: b.kind, lines, y }; y += lines.length * SUB_LH + SUB_GAP; return out; });
};
/** Group title wraps on words (15 px, up to 3 lines) beside the icon stack; extra lines push the sub blocks and rows down. */
const TITLE_LH = 19;
const titleLines = (c: C) => wrap(labelOf(c), Math.max(8, Math.floor((c.w - 40 - stackW(c)) / (15 * 0.56))), 2);
const titleExtra = (c: C) => (titleLines(c).length - 1) * TITLE_LH;
/** Header height: the title row plus every wrapped sub line; rows start below it. */
const headOf = (c: C) => { const b = subBlocks(c); if (!b.length) return HEAD_BARE + titleExtra(c); const last = b[b.length - 1]; return Math.max(HEAD, last.y + (last.lines.length - 1) * SUB_LH + 26); };
/** Current work of a cluster: the lead's in-progress task, else a working member's in-progress task, else its reported doing line. */
const nowOf = (c: C): string | null => {
  const t = c.team ? activeTeams().find((x) => x.id === c.team) : null;
  const order = [...c.ids].sort((a, b) => Number(nameOf(b) === t?.lead) - Number(nameOf(a) === t?.lead) || Number(isWorking(b)) - Number(isWorking(a)));
  for (const id of order) { const r = row(id); const task = r?.tasks?.find((k) => k.status === "in_progress")?.text; if (task) return task; }
  for (const id of order) { const r = row(id); if (r && isWorking(id) && r.doing) return promptLine(r.doing, undefined) ?? humanDoing(r.doing); }
  return null;
};
/** Member icon stack next to the title: up to 5 overlapping icons, working members first and green; more than 5 adds "+N". */
const ICON_R = 9, ICON_STEP = 13, ICON_MAX = 5;
/** Room the icon stack takes after the title. */
const stackW = (c: C) => Math.min(c.ids.length, ICON_MAX) * ICON_STEP + ICON_R * 2 - ICON_STEP + 12 + (c.ids.length > ICON_MAX ? 30 : 0);
const stackOf = (c: C) => {
  const ids = [...c.ids].sort((a, b) => Number(isWorking(b)) - Number(isWorking(a)));
  const shown = ids.slice(0, ICON_MAX), more = ids.length - shown.length;
  const tw = (titleLines(c)[0] ?? "").length * 15 * 0.56;
  const x0 = c.x + 20 + tw + 10 + ICON_R;
  return { x0, items: shown.map((id, i) => ({ id, x: x0 + i * ICON_STEP, on: isWorking(id), tip: nameOf(id) + (isWorking(id) ? " · working" : "") })), more, moreX: x0 + (shown.length - 1) * ICON_STEP + ICON_R + 6, tip: ids.map((id) => nameOf(id)).join(", ") };
};
const isWorking = (id: string) => { const r = row(id); return !!r && r.state === "working" && r.life === "live"; }; // a gone or stopping agent is not working, whatever its last state
const working = (c: C) => c.ids.some(isWorking);
const linkLive = (l: L) => (l.to.startsWith("trunk:") ? [...geo.parentOf].some(([k, p]) => p === l.to.slice(6) && isWorking(k)) : isWorking(l.to));
/** Context used, shown at the right end of a node's name line ("42%"); null until the agent reports a reading. */
const ctxOf = (id: string) => { const r = id === ROOT ? rootRow.value : row(id); const v = ctxView(r); return v ? Math.round(v.pct) : null; };
/** Short model name on the node: "claude-sonnet-5-5" -> "sonnet". */
const modelOf = (id: string): string | null => { const m = (id === ROOT ? rootRow.value : row(id))?.model; if (!m) return null; const v = /(haiku|sonnet|opus|fable)[-_ ]?(\d+)(?:[-.](\d+))?/i.exec(m); if (v) return `${v[1].toLowerCase()} ${v[2]}${v[3] ? "." + v[3] : ""}`; const k = /(haiku|sonnet|opus|fable)/i.exec(m); return k ? k[1].toLowerCase() : m; };
const useTip = (id: string) => { const r = id === ROOT ? rootRow.value : row(id); if (!r) return ""; const p: string[] = []; const cv = ctxView(r); if (cv) p.push(`context ${Math.round(cv.pct)}% of ${Math.round(cv.window / 1000)}k`); if (r.cost != null) p.push(`$${r.cost.toFixed(2)}`); if (r.weekly) p.push(`weekly ${Math.round(r.weekly.pct)}%`); const g = r.goal ? ` · goal: ${r.goal}` : ""; return (p.length ? " · " + p.join(" · ") : "") + g; };
/** Hooks lane: a hook that just fired glows for 1.4 s (skipped runs stay quiet). */
const glow = ref(new Set<string>());
watch(() => hooks.fires[0], (f) => { if (!f || f.skipped) return; glow.value = new Set(glow.value).add(f.script); setTimeout(() => { const g = new Set(glow.value); g.delete(f.script); glow.value = g; }, 1400); });
const prog = (id: string) => {
  const r = id === ROOT ? rootRow.value : row(id); if (!r) return null;
  // A finished list (100%, nothing in progress) shows no bar: a full bar on an idle card read as work still running.
  if (r.tasks?.length && r.tasks.every((t) => t.status === "done")) return null;
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
  const n = new Set(hotNodes.value), l = new Set(hotLinks.value); links = [...links, ...links.map((x) => geo.parentOf.get(x)).filter((p): p is string => !!p).map((p) => "trunk:" + p)];
  ids.forEach((x) => n.add(x)); links.forEach((x) => l.add(x)); hotNodes.value = n; hotLinks.value = l;
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
/** Strip text: the message body itself (the subject is cut at 60 characters server side), clamped by CSS, full when opened. */
const stripText = (m: Msg) => `${m.from} → ${m.to}: ${(m.body || m.subject || "").replace(/\s+/g, " ").slice(0, 700)}`;
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
const nodeW = (n: N) => target?.nm.get(n.id)?.w ?? n.w;
const allNodes = computed(() => [...nodes.value.values()]);
/** A status line that wraps to a new line count changes card heights: lay out again (tweened). */
const wrapSig = computed(() => boxes.value.map((c) => c.id + ':' + titleLines(c).length + ':' + subBlocks(c).map((b) => b.lines.length).join('.')).join(',') + '|' + [ROOT, ...Object.keys(net.agents)].map((id) => id + ':' + noBar(id) + ':' + lineCount(id, id === ROOT ? rootW.value : (target?.nm.get(id)?.w ?? nodes.value.get(id)?.w ?? cardW(id)))).join(','));
watch(wrapSig, () => relayout());
</script>

<template>
  <div ref="box" class="amap" :class="{ narrow: narrow() }" :style="[boxStyle, { '--rv': reserve() + 'px' }]" role="group" :aria-label="`Org chart of ${count} agents`">
    <svg class="amap-svg" :viewBox="`0 0 ${W} ${H}`" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel" @dblclick="refit">
      <g ref="gEl" :transform="`translate(${view.x} ${view.y}) scale(${view.k})`">
        <g v-for="c in boxes" :key="c.id" class="cl" :class="{ live: working(c), team: !!c.team }" :role="c.team ? 'button' : undefined" :tabindex="c.team ? 0 : undefined" :aria-label="c.team ? `Team ${c.label}` : undefined"
           @click="pickTeam(c)" @keydown.enter="pickTeam(c)">
          <rect :x="c.x" :y="c.y" :width="c.w" :height="c.h" rx="14" />
          <text class="cl-t" :x="c.x + 20" :y="c.y + 26"><tspan v-for="(ln, i) in titleLines(c)" :key="i" :x="c.x + 20" :dy="i ? TITLE_LH : 0">{{ ln }}</tspan></text>
          <g class="stk"><title>{{ stackOf(c).tip }}</title>
            <g v-for="it in stackOf(c).items.slice().reverse()" :key="it.id" :class="['av', { on: it.on }]" :transform="`translate(${it.x} ${c.y + 21})`">
              <circle :r="ICON_R" /><circle class="hd" cy="-2.6" r="2.9" /><path class="bd" d="M-5,6.2 a5,4.6 0 0 1 10,0 z" />
            </g>
            <text v-if="stackOf(c).more > 0" class="more-n" :x="stackOf(c).moreX" :y="c.y + 25.5">+{{ stackOf(c).more }}</text>
          </g>
          <g v-for="b in subBlocks(c)" :key="b.kind" :class="['sb', b.kind, { on: b.kind === 'now' && working(c) }]"><title>{{ b.kind === "goal" ? "Team purpose" : "Working on now" }}</title>
            <g class="sb-i" :transform="`translate(${c.x + 20} ${c.y + b.y - 10.5}) scale(0.54)`">
              <template v-if="b.kind === 'goal'"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></template>
              <polyline v-else points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </g>
            <text class="cl-s" :x="c.x + 20 + SUB_IND" :y="c.y + b.y"><tspan v-for="(ln, i) in b.lines" :key="i" :x="c.x + 20 + SUB_IND" :dy="i ? SUB_LH : 0">{{ ln }}</tspan></text>
          </g>
        </g>
        <path v-for="l in links" :key="l.to" :d="l.d" :data-to="l.to" class="ln" :class="{ live: linkLive(l), hot: hotLinks.has(l.to) }" />
        <g class="nd" :class="['s-' + dotOf(ROOT), 'root', { sel: selected === ROOT, hot: hotNodes.has(ROOT), setup: !rootRow }]" :transform="`translate(${dirNode.x} ${dirNode.y})`" tabindex="0" role="button"
           :aria-label="rootRow ? `${ROOT}, director` : `Set up your director`" @click="pick(ROOT)" @keydown.enter="pick(ROOT)" @keydown.space.prevent="pick(ROOT)">
          <rect class="card" :x="-dirNode.w / 2" :y="-dirNode.h / 2" :width="dirNode.w" :height="dirNode.h" rx="12" />
          <circle class="dot" :cx="-dirNode.w / 2 + 18" :cy="-dirNode.h / 2 + 24" r="5" />
          <text class="nm" :x="-dirNode.w / 2 + 34" :y="-dirNode.h / 2 + 29">{{ rootRow ? ROOT + " (director)" : "Set up your director" }}</text>
          <text v-if="ctxOf(ROOT) !== null" class="ctx" :class="{ hi: ctxOf(ROOT)! >= 80 }" :x="dirNode.w / 2 - 14" :y="-dirNode.h / 2 + 29" text-anchor="end">{{ ctxOf(ROOT) }}%</text>
          <text class="sub" :x="-dirNode.w / 2 + 34" :y="-dirNode.h / 2 + 51"><tspan v-for="(ln, i) in subOf(ROOT, rootW)" :key="i" :x="-dirNode.w / 2 + 34" :dy="i ? NODE_LH : 0">{{ ln }}</tspan></text>
          <g v-if="jobRows.get(ROOT)" class="bjr" :transform="`translate(0 ${jobRows.get(ROOT)!.y}) scale(${pillS})`">
            <path class="bjl" :d="`M${jobRows.get(ROOT)!.x0 - 12},-4 V${jobRows.get(ROOT)!.items.length ? jobRows.get(ROOT)!.items[0].y + PH / 2 : 8} H${jobRows.get(ROOT)!.x0}`" />
            <g v-for="it in jobRows.get(ROOT)!.items" :key="it.key" :class="['bjp', it.kind, it.cs, it.j?.status ?? it.bg?.state, { ghost: it.ghost }]" :style="it.op !== undefined && it.op < 1 ? { opacity: it.op } : undefined" :transform="`translate(${it.x} ${it.y})`" role="button" tabindex="0" :aria-label="it.tip" @click.stop="it.j ? tapJob(it.j, ROOT) : it.act?.()" @keydown.enter.stop="it.j ? tapJob(it.j, ROOT) : it.act?.()">
              <title>{{ it.tip }}</title>
              <rect :width="it.w" :height="it.h ?? PH" rx="10" />
              <template v-if="it.lines"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4"><tspan v-for="(ln, i) in it.lines" :key="i" x="17" :dy="i ? LH : 0">{{ ln }}</tspan></text><text class="bjt bjm" :x="it.w - 8" :y="PH / 2 + 4" text-anchor="end">{{ it.time }}</text></template>
              <template v-else-if="it.j || it.bg"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4">{{ it.text }}</text></template>
              <text v-else class="bjt" :x="it.w / 2" :y="PH / 2 + 4" text-anchor="middle">{{ it.text }}</text>
            </g>
          </g>
        </g>
        <g v-for="n in allNodes" :key="n.id" class="nd" :class="['s-' + dotOf(n.id), { sel: selected === n.id, hot: hotNodes.has(n.id) }]" :transform="`translate(${n.x} ${n.y})`" tabindex="0" role="button"
           :aria-label="`${nameOf(n.id)}, ${LABEL[dotOf(n.id)]}`" @click="pick(n.id)" @keydown.enter="pick(n.id)" @keydown.space.prevent="pick(n.id)">
          <title>{{ nameOf(n.id) }}: {{ line2(n.id) }}{{ useTip(n.id) }}</title>
          <rect class="card" :x="-n.w / 2" :y="-n.h / 2" :width="n.w" :height="n.h" rx="10" />
          <circle class="dot" :cx="-n.w / 2 + 18" :cy="-n.h / 2 + 21" r="5" />
          <text class="nm" :x="-n.w / 2 + 34" :y="-n.h / 2 + 26">{{ fitText(nameOf(n.id), n.w - 52 - (ctxOf(n.id) !== null ? 44 : 0) - (chipW(n.id) ? chipW(n.id) + 6 : 0) - (isLead(n.id) ? 56 : 0) - (extraTeams(n.id) > 0 ? 38 : 0), 15) }}</text>
          <g v-if="chipW(n.id)" class="mchip" :transform="`translate(${n.w / 2 - (ctxOf(n.id) !== null ? 50 : 14) - chipW(n.id)} ${-n.h / 2 + 11})`"><title>Model: {{ row(n.id)?.model }}{{ row(n.id)?.effort ? " · " + row(n.id)?.effort : "" }}</title><rect :width="chipW(n.id)" height="17" rx="4" /><text :x="chipW(n.id) / 2" y="12.3" text-anchor="middle">{{ modelOf(n.id) }}</text></g>
          <g v-if="isLead(n.id)" class="lead" :transform="`translate(0 ${-n.h / 2 + 38})`"><rect :x="n.w / 2 - rightOff(n.id) - 48" y="-27" width="48" height="17" rx="8.5" /><text :x="n.w / 2 - rightOff(n.id) - 24" y="-14.5" text-anchor="middle">LEAD</text></g>
          <g v-if="extraTeams(n.id) > 0" class="lead more" :transform="`translate(${(isLead(n.id) ? n.w / 2 - rightOff(n.id) - 48 : n.w / 2 - rightOff(n.id)) - 6 - 30} ${-n.h / 2 + 38})`"><title>{{ extraTip(n.id) }}</title><rect y="-27" width="30" height="17" rx="8.5" /><text x="15" y="-14.5" text-anchor="middle">+{{ extraTeams(n.id) }}</text></g>
          <text v-if="ctxOf(n.id) !== null" class="ctx" :class="{ hi: ctxOf(n.id)! >= 80 }" :x="n.w / 2 - 14" :y="-n.h / 2 + 26" text-anchor="end">{{ ctxOf(n.id) }}%</text>
          <text class="sub" :x="-n.w / 2 + 34" :y="-n.h / 2 + 46"><tspan v-for="(ln, i) in subOf(n.id, nodeW(n))" :key="i" :x="-n.w / 2 + 34" :dy="i ? NODE_LH : 0">{{ ln }}</tspan></text>
          <template v-if="prog(n.id) !== null"><rect class="pbg" :x="-n.w / 2 + 34" :y="n.h / 2 - 20" :width="n.w - 62" height="6" rx="3" /><rect class="pfg" :x="-n.w / 2 + 34" :y="n.h / 2 - 20" :width="(n.w - 62) * prog(n.id)!" height="6" rx="3" /></template>
          <g v-if="jobRows.get(n.id)" class="bjr" :transform="`translate(0 ${jobRows.get(n.id)!.y}) scale(${pillS})`">
            <path class="bjl" :d="`M${jobRows.get(n.id)!.x0 - 12},-4 V${jobRows.get(n.id)!.items.length ? jobRows.get(n.id)!.items[0].y + PH / 2 : 8} H${jobRows.get(n.id)!.x0}`" />
            <g v-for="it in jobRows.get(n.id)!.items" :key="it.key" :class="['bjp', it.kind, it.cs, it.j?.status ?? it.bg?.state, { ghost: it.ghost }]" :style="it.op !== undefined && it.op < 1 ? { opacity: it.op } : undefined" :transform="`translate(${it.x} ${it.y})`" role="button" tabindex="0" :aria-label="it.tip" @click.stop="it.j ? tapJob(it.j, n.id) : it.act?.()" @keydown.enter.stop="it.j ? tapJob(it.j, n.id) : it.act?.()">
              <title>{{ it.tip }}</title>
              <rect :width="it.w" :height="it.h ?? PH" rx="8.5" />
              <template v-if="it.lines"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4"><tspan v-for="(ln, i) in it.lines" :key="i" x="17" :dy="i ? LH : 0">{{ ln }}</tspan></text><text class="bjt bjm" :x="it.w - 8" :y="PH / 2 + 4" text-anchor="end">{{ it.time }}</text></template>
              <template v-else-if="it.j || it.bg"><circle class="bjd" cx="9" :cy="PH / 2" r="3.2" /><text class="bjt" x="17" :y="PH / 2 + 4">{{ it.text }}</text></template>
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
      <li v-for="m in recent" :key="m.id ?? m.at" :title="tipOf(m)" :class="{ open: stripOpen === m.id }" ><button type="button" class="ms" :aria-expanded="stripOpen === m.id" @click="stripOpen = stripOpen === m.id ? null : m.id"><i :style="{ background: KIND_COL[m.kind] ?? KIND_COL.info }">{{ KIND_GLYPH[m.kind] ?? "i" }}</i><span>{{ stripText(m) }}</span></button></li>
    </ul>
    <ul v-if="hooks.nodes.length || unplaced.length" class="hkl" aria-label="Teams without a cluster, and hooks (server-wide)">
      <li v-for="t in unplaced" :key="'t' + t.id" class="tchip" role="button" tabindex="0" :title="`Open team ${t.name}: ${t.members.join(', ')}`" @click="emit('select', 'team:' + t.id)" @keydown.enter="emit('select', 'team:' + t.id)"><b>{{ t.name }}</b> team</li>
      <li v-for="h in hooks.nodes" :key="h.script" :class="{ off: !h.enabled, glow: glow.has(h.script) }" :title="`${h.name} · ${h.events.join(', ')}${h.enabled ? '' : ' (off)'}${h.live ? '' : ' · keeps no log, so it cannot light up live'}`"><i />{{ h.name }}</li>
    </ul>
    <div class="zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom in" @click="zoomAt(1.25)"><Icon name="plus" :size="16" /></button>
      <button type="button" aria-label="Zoom out" @click="zoomAt(1 / 1.25)"><Icon name="minus" :size="16" /></button>
      <button type="button" aria-label="Fit to screen" @click="refit"><Icon name="maximize" :size="16" /></button>
    </div>
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
.bjp.bg .bjt{fill:var(--ink)}
.bjp .bjm,.bjp.bg .bjm{font:500 11.5px var(--mono);fill:var(--muted)}
.bjp .bjd{fill:var(--off)}
.bjp.running .bjd{fill:var(--on);animation:jpulse 1.6s ease-in-out infinite}
.bjp.done .bjd{fill:var(--on)} .bjp.failed .bjd{fill:var(--bad)}
.bjp.check{cursor:pointer}
.bjp.check rect{fill:color-mix(in srgb,var(--pend) 14%,var(--panel));stroke:var(--pend);stroke-width:1.4;transition:fill .35s var(--ease),stroke .35s var(--ease)}
.bjp.check.ghost rect{stroke-dasharray:4 3}
.bjp.check .bjt{fill:var(--ink)}
.bjp.check .bjd{fill:var(--pend);animation:jpulse 1.6s ease-in-out infinite}
.bjp.check.good rect{fill:color-mix(in srgb,var(--on) 18%,var(--panel));stroke:var(--on)} .bjp.check.good .bjd{fill:var(--on);animation:none}
.bjp.check.bad rect{fill:color-mix(in srgb,var(--bad) 16%,var(--panel));stroke:var(--bad)} .bjp.check.bad .bjd{fill:var(--bad);animation:none}
.bjp.check.neutral rect{fill:color-mix(in srgb,var(--ink) 8%,var(--panel));stroke:var(--muted)} .bjp.check.neutral .bjd{fill:var(--muted);animation:none}
.bjp.check:not(.pending){cursor:default}
.bjp.stale .bjd{fill:var(--off)} .bjp.killed .bjd{fill:var(--off)} .bjp.bg{transition:opacity .6s}
@keyframes jpulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.bjp.running .bjd,.bjp.check .bjd{animation:none}.bjp.check rect{transition:none}}
.pk{pointer-events:none}
.pk text{font:700 10px var(--body);fill:#0d0d0f}
.pk circle{filter:drop-shadow(0 0 5px rgba(255,255,255,.35))}
.mstrip{position:absolute;left:12px;top:12px;z-index:2;list-style:none;margin:0;padding:0;display:grid;gap:4px;max-width:min(460px,calc(100% - 100px));pointer-events:none}
.mstrip li{pointer-events:auto;display:flex;align-items:flex-start;gap:6px;padding:4px 10px 4px 4px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--muted);font:500 11.5px/1.3 var(--body);cursor:default;overflow:hidden;animation:mst .3s cubic-bezier(.2,.8,.2,1)}
.mstrip .ms{all:unset;box-sizing:border-box;display:flex;align-items:flex-start;gap:6px;min-width:0;cursor:pointer}.mstrip .ms:focus-visible{outline:2px solid var(--on);outline-offset:3px;border-radius:999px}
/* Two lines by default (whole sentence readable), tap opens the full message. */
.mstrip li span{overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;padding-top:1px}
.mstrip li.open span{-webkit-line-clamp:unset;display:block}
.mstrip i{flex:none;display:grid;place-items:center;width:16px;height:16px;border-radius:50%;color:#0d0d0f;font:700 10px/1 var(--body);font-style:normal}
@keyframes mst{from{opacity:0;transform:translateY(-4px)}}
@media (prefers-reduced-motion:reduce){.mstrip li{animation:none}}
.amap{--hook:#f2b04a;--sel:#4c7dff;position:relative;flex:1;min-width:0;min-height:0;border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}
.amap-svg{position:absolute;inset:0 0 var(--rv,0) 0;width:100%;height:calc(100% - var(--rv,0px));touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.amap-svg:active{cursor:grabbing}
.cl rect{fill:color-mix(in srgb,var(--ink) 3%,transparent);stroke:color-mix(in srgb,var(--ink) 16%,transparent);transition:stroke .2s var(--ease),fill .2s var(--ease)}
.cl.live rect{stroke:color-mix(in srgb,var(--on) 45%,transparent);fill:color-mix(in srgb,var(--on) 4%,transparent)}
.stk{pointer-events:auto}
.stk .av > circle:first-child{fill:color-mix(in srgb,var(--ink) 38%,var(--panel));stroke:var(--panel);stroke-width:2}
.stk .av.on > circle:first-child{fill:var(--on)}
.stk .av .hd,.stk .av .bd{fill:var(--panel)}
.stk .more-n{fill:var(--muted);font:600 12px var(--body)}
.cl-t{fill:var(--ink);font:600 15px var(--body);pointer-events:none}
.cl-s{fill:var(--muted);font:400 13px var(--body);pointer-events:none;font-variant-numeric:tabular-nums}
.sb.now .cl-s{fill:var(--ink)}
.sb-i{fill:none;stroke:var(--muted);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.sb.on .sb-i{stroke:var(--on)}
.ln{fill:none;stroke:color-mix(in srgb,var(--ink) 38%,transparent);stroke-width:1.6;stroke-linejoin:round;transition:stroke .3s var(--ease),stroke-width .3s var(--ease)}
.ln.live{stroke:color-mix(in srgb,var(--on) 75%,transparent)}
.nd{cursor:pointer;outline:none}
.card{fill:var(--panel-2);stroke:var(--line);stroke-width:1.25;transition:stroke .2s var(--ease),fill .2s var(--ease)}
.nd:hover .card,.nd.sel .card{stroke:color-mix(in srgb,var(--ink) 60%,transparent)}
.nd.sel .card{stroke:var(--sel);stroke-width:2;fill:color-mix(in srgb,var(--sel) 9%,var(--panel-2))}
.nd:focus-visible .card{stroke:var(--on);stroke-width:2}
.nd.root .card{fill:color-mix(in srgb,var(--lock) 10%,var(--panel-2))}
.nd.setup .card{stroke:color-mix(in srgb,var(--on) 60%,var(--line));stroke-dasharray:6 5;fill:color-mix(in srgb,var(--on) 7%,var(--panel-2))}
.nd.setup .dot{fill:transparent;stroke:var(--on);stroke-width:2}
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
@media (prefers-reduced-motion:reduce){.s-working .dot{animation:none}.cl rect,.ln,.card,.pfg,.hkl li{transition:none}}
.mchip rect{fill:color-mix(in srgb,var(--ink) 7%,transparent);stroke:color-mix(in srgb,var(--ink) 22%,transparent);stroke-width:1}
.mchip text{fill:var(--ink);font:600 10.5px var(--mono,ui-monospace,monospace);letter-spacing:.02em;pointer-events:none}
</style>
