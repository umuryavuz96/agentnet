<script setup lang="ts">
// One line chart: a number per closed job, one point per day, one line per kind of work plus a thick "All work" line.
// Plain SVG, no chart library. The chart box has a fixed height, so switching a legend entry never resizes it.
// A point with fewer than 3 jobs is drawn hollow and says "few jobs" on hover. Days without jobs are not drawn (never as zero).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DailyLine } from "../net";

const props = defineProps<{ title: string; hint: string; lines: DailyLine[]; days: string[]; fmt: (v: number) => string; axis: (v: number) => string; word: string; unitWord: string }>();

const ALL = "All work", H = 220, PAD = { l: 52, r: 26, t: 12, b: 28 };
/** One colour per kind, the same in both charts. */
const COLOR: Record<string, string> = { design: "#b66bd9", "web UI": "#3d8bff", backend: "#e38b2c", game: "#2fa37a", "research & plan": "#d9b13b", mobile: "#e5586e", other: "#8d93a1", ops: "#35b3c4" };
const color = (k: string) => (k === ALL ? "var(--ink)" : COLOR[k] ?? "#8d93a1");

// Default: only the All work line; kinds are turned on from the legend. The choice is kept per chart in localStorage.
const LS = "agentnet.usageChart.shown." + props.title;
const readShown = (): Set<string> => { try { const v = localStorage.getItem(LS); return new Set(v ? JSON.parse(v) : [ALL]); } catch { return new Set([ALL]); } };
const on = ref(readShown());
const hidden = computed(() => new Set(props.lines.map((l) => l.kind).filter((k) => !on.value.has(k))));
const toggle = (k: string) => { const s = new Set(on.value); s.has(k) ? s.delete(k) : s.add(k); on.value = s; try { localStorage.setItem(LS, JSON.stringify([...s])); } catch {} };
const shown = computed(() => props.lines.filter((l) => !hidden.value.has(l.kind)));

const box = ref<HTMLElement | null>(null), W = ref(600);
let ro: ResizeObserver | undefined;
onMounted(() => { if (box.value) { W.value = Math.max(240, box.value.clientWidth); ro = new ResizeObserver(() => { if (box.value) W.value = Math.max(240, box.value.clientWidth); }); ro.observe(box.value); } });
onBeforeUnmount(() => ro?.disconnect());

/** Days before the first job of any line are cut, like the weeks in the table, so a young system is not a chart that is empty on the left. */
const from = computed(() => { const i = props.days.findIndex((_, di) => props.lines.some((l) => l.points[di]?.value != null)); return i < 0 ? 0 : Math.min(i, props.days.length - 2); });
const vis = computed(() => props.days.slice(from.value));
const top = computed(() => { const m = Math.max(0, ...shown.value.flatMap((l) => l.points.map((p) => p.value ?? 0))); return niceMax(m || 1); });
/** Top of the axis: four steps of a round size (1, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten). */
function niceMax(m: number) { const s = m / 4, e = 10 ** Math.floor(Math.log10(s)), f = s / e; return 4 * (([1, 2, 2.5, 3, 4, 5, 6, 8].find((q) => f <= q) ?? 10) * e); }
const ticks = computed(() => [0, 1, 2, 3, 4].map((i) => (top.value * i) / 4));
const iw = computed(() => W.value - PAD.l - PAD.r), ih = H - PAD.t - PAD.b;
const x = (i: number) => PAD.l + (vis.value.length < 2 ? iw.value / 2 : (i * iw.value) / (vis.value.length - 1));
const y = (v: number) => PAD.t + ih - (v / top.value) * ih;
const dayLabel = (d: string) => new Date(d + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const step = computed(() => Math.max(1, Math.ceil(vis.value.length / Math.max(2, Math.floor(iw.value / 64)))));

interface Pt { kind: string; day: string; v: number; n: number; few: boolean; cx: number; cy: number }
const drawn = computed(() => shown.value.map((l) => {
  const pts: Pt[] = [];
  l.points.slice(from.value).forEach((p, i) => { if (p.value != null) pts.push({ kind: l.kind, day: p.day, v: p.value, n: p.n, few: p.few, cx: x(i), cy: y(p.value) }); });
  return { kind: l.kind, all: l.kind === ALL, pts, d: pts.map((p, i) => `${i ? "L" : "M"}${p.cx.toFixed(1)} ${p.cy.toFixed(1)}`).join("") };
}));
// the thick line is drawn first, kinds above it
const order = computed(() => [...drawn.value].sort((a, b) => Number(b.all) - Number(a.all)));

const tip = ref<Pt | null>(null);
function move(e: PointerEvent) {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  let best: Pt | null = null, bd = 28 * 28;
  for (const l of drawn.value) for (const p of l.pts) { const d = (p.cx - px) ** 2 + (p.cy - py) ** 2; if (d < bd || (d === bd && best?.kind === ALL && p.kind !== ALL)) { bd = d; best = p; } }
  tip.value = best;
}
const tipStyle = computed(() => {
  const t = tip.value; if (!t) return {};
  const right = t.cx > W.value - 190;
  return { left: (right ? t.cx - 12 : t.cx + 12) + "px", top: Math.min(H - 62, Math.max(4, t.cy - 18)) + "px", transform: right ? "translateX(-100%)" : "none" };
});
const jobs = (n: number) => `${n} ${n === 1 ? props.unitWord.slice(0, -1) : props.unitWord}`;

/** The one plain line under the chart, from the first-7-day and last-7-day values of the All work line. Lower is better. */
const sentence = computed(() => {
  const l = props.lines.find((q) => q.kind === ALL);
  if (!l) return { text: `No ${props.unitWord} with this number in the last ${props.days.length} days.`, tone: "" };
  // Compare the first half of the days that have a value with the second half (job-weighted), so a young history still shows a direction.
  const ds = props.days.map((d, i) => ({ d, p: l.points[i] })).filter((q) => q.p?.value != null && q.p.n > 0);
  const one = props.unitWord.slice(0, -1);
  if (ds.length < 2) return { text: ds.length ? `${ALL}: ${props.fmt(ds[0].p.value!)} per ${one} on ${dayLabel(ds[0].d)}; one day so far, so no change to show.` : `${ALL}: no closed ${props.unitWord} with this number yet.`, tone: "" };
  const half = Math.floor(ds.length / 2), a = ds.slice(0, half), b = ds.slice(ds.length - half);
  const avg = (xs: typeof ds) => xs.reduce((s, q) => s + q.p.value! * q.p.n, 0) / xs.reduce((s, q) => s + q.p.n, 0);
  const span = (xs: typeof ds) => (xs.length === 1 ? dayLabel(xs[0].d) : `${dayLabel(xs[0].d)} to ${dayLabel(xs[xs.length - 1].d)}`);
  const first = avg(a), last = avg(b);
  const ch = Math.round(((last - first) / first) * 100), head = `${ALL}: ${props.fmt(first)} per ${one} on ${span(a)}, ${props.fmt(last)} on ${span(b)}`;
  if (ch === 0) return { text: `${head}, no change.`, tone: "" };
  return { text: `${head}, ${ch < 0 ? "down" : "up"} ${Math.abs(ch)}%.`, tone: ch < 0 ? "better" : "worse" };
});
</script>

<template>
  <section class="uc">
    <h3>{{ title }}</h3>
    <p class="hint">{{ hint }}</p>
    <div ref="box" class="plot" :style="{ height: H + 'px' }">
      <svg :width="W" :height="H" role="img" :aria-label="title + ' per day'" @pointermove="move" @pointerleave="tip = null">
        <g v-if="shown.length" class="grid"><template v-for="t in ticks" :key="t"><line :x1="PAD.l" :x2="W - PAD.r" :y1="y(t)" :y2="y(t)" /><text :x="PAD.l - 8" :y="y(t) + 4" text-anchor="end">{{ axis(t) }}</text></template></g>
        <g v-if="shown.length" class="days"><template v-for="(d, i) in vis" :key="d"><text v-if="i % step === 0 || i === vis.length - 1 && (vis.length - 1) % step === 0" :x="x(i)" :y="H - 8" text-anchor="middle">{{ dayLabel(d) }}</text></template></g>
        <g v-for="l in order" :key="l.kind">
          <path :d="l.d" fill="none" :stroke="color(l.kind)" :stroke-width="l.all ? 3.5 : 1.75" stroke-linejoin="round" stroke-linecap="round" :opacity="l.all ? 1 : 0.9" />
          <circle v-for="p in l.pts" :key="p.day" :cx="p.cx" :cy="p.cy" :r="l.all ? 4.5 : 3.5" :stroke="color(l.kind)" :stroke-width="l.all ? 2.5 : 1.75" :fill="p.few ? 'var(--bg, #0b0d12)' : color(l.kind)" :class="{ few: p.few }" />
        </g>
        <circle v-if="tip" :cx="tip.cx" :cy="tip.cy" r="8" fill="none" :stroke="color(tip.kind)" stroke-width="1.5" />
      </svg>
      <div v-if="tip" class="tip" :style="tipStyle" role="status">
        <b>{{ dayLabel(tip.day) }} · {{ tip.kind }}</b>
        <span>{{ fmt(tip.v) }} · {{ jobs(tip.n) }}</span>
        <em v-if="tip.few">few {{ unitWord }}</em>
      </div>
      <p v-if="!shown.length" class="empty">No line is on. Tap one below, for example All work.</p>
    </div>
    <div class="legend" role="group" :aria-label="title + ' lines'">
      <button v-for="l in lines" :key="l.kind" type="button" :aria-pressed="!hidden.has(l.kind)" :class="{ off: hidden.has(l.kind) }" @click="toggle(l.kind)">
        <i :style="{ background: color(l.kind), height: l.kind === ALL ? '5px' : '3px' }" />{{ l.kind }}
      </button>
    </div>
    <p class="sum" :class="sentence.tone">{{ sentence.text }}</p>
    <p class="key"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="1.75" /></svg> Hollow point = few {{ unitWord }} that day. Lower is better.</p>
  </section>
</template>

<style scoped>
.uc{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0;padding:12px 14px;border:1px solid var(--line);border-radius:12px;align-content:start}
h3{margin:0;font:700 15px/1.2 var(--body);color:var(--ink)}
.hint{margin:0;color:var(--muted);font-size:12px;line-height:1.4}
.plot{position:relative;min-width:0;overflow:hidden}.plot .empty{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:var(--muted)}
svg{display:block;touch-action:pan-y}
.grid line{stroke:var(--hair);stroke-width:1}.grid text,.days text{fill:var(--muted);font:11px var(--mono)}
.tip{position:absolute;display:grid;gap:1px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel,var(--track));box-shadow:0 4px 14px rgb(0 0 0/.3);font-size:12px;line-height:1.35;pointer-events:none;white-space:nowrap;z-index:2;color:var(--ink)}
.tip b{font-weight:600}.tip em{font-style:normal;color:var(--pend)}
.legend{display:flex;flex-wrap:wrap;gap:4px 6px;min-width:0}
.legend button{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer}
.legend button i{display:block;width:16px;border-radius:2px;flex:none}
.legend button.off{color:var(--muted);background:transparent;border-style:dashed}.legend button.off i{opacity:.3}
.legend button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.sum{margin:0;font-size:14px;line-height:1.45;color:var(--ink);padding:8px 10px;border-radius:8px;border-left:4px solid var(--line)}
.sum.better{border-left-color:#2f9e5b;background:color-mix(in srgb,#2f9e5b 16%,transparent)}
.sum.worse{border-left-color:#d64545;background:color-mix(in srgb,#d64545 16%,transparent)}
.key{margin:0;display:flex;align-items:center;gap:6px;color:var(--muted);font-size:11px}
@media (pointer:coarse){.legend button{min-height:44px}}
</style>
