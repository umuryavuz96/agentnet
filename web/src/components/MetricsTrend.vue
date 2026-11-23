<script setup lang="ts">
// Is the system getting better? A plain table: one row per kind of work, one column per week (newest right, 8 at most), one measure at a time.
// Each cell shows the value and the job count; from the second week a cell is green when lower than the week before, red when higher.
// Fewer than 3 jobs behind a cell is said in words ("few jobs"). Data: src/net/metrics.ts.
import { computed, onBeforeUnmount, ref } from "vue";
import { metrics, setMetricsUnit, useMetrics, type MetricPoint } from "../net";
import UsageChart from "./UsageChart.vue";

const stop = useMetrics();
onBeforeUnmount(stop);
const d = computed(() => metrics.data);
type Key = "wall" | "cost" | "rework" | "rounds" | "caught";
const M: Record<Key, { label: string; hint: string; val: (p: MetricPoint) => number | null; n: (p: MetricPoint) => number; fmt: (v: number) => string }> = {
  wall: { label: "Time", hint: "Time: how many minutes a typical job takes from open to close", val: (p) => p.wallMin, n: (p) => p.nWall, fmt: (v) => (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")) + " min" },
  cost: { label: "Cost", hint: "Cost: what one job costs in dollars", val: (p) => p.costUsd, n: (p) => p.nCost, fmt: (v) => "$" + v.toFixed(2) },
  rework: { label: "Rework", hint: "Rework: share of jobs that root sent back to be redone", val: (p) => p.reworkRate, n: (p) => p.n, fmt: (v) => Math.round(v * 100) + "%" },
  rounds: { label: "Owner rounds", hint: "Owner rounds: how many times the owner came back after a job was done, per job", val: (p) => p.rounds, n: (p) => p.nRounds, fmt: (v) => v.toFixed(2).replace(/0$/, "") },
  caught: { label: "Owner caught it", hint: "Owner caught it: share of jobs where the owner came back with a problem", val: (p) => p.caughtRate, n: (p) => p.nCaught, fmt: (v) => Math.round(v * 100) + "%" },
};
const key = ref<Key>("caught");
const m = computed(() => M[key.value]);
const DAY = 86400000;
/** "16-22 Nov", or "30 Nov-6 Dec" when the week crosses a month. Weeks start on a Monday. */
function range(s: string) {
  const a = new Date(s + "T12:00"), b = new Date(a.getTime() + 6 * DAY), mo = (x: Date) => x.toLocaleDateString("en-GB", { month: "short" });
  return mo(a) === mo(b) ? `${a.getDate()}-${b.getDate()} ${mo(b)}` : `${a.getDate()} ${mo(a)}-${b.getDate()} ${mo(b)}`;
}
/** Weeks before the first job of any kind are cut, so a young system is not a table that is empty on the left. */
const from = computed(() => { const ks = d.value?.kinds ?? [], len = d.value?.weeks.length ?? 0, first = Math.min(len, ...ks.map((k) => k.points.findIndex((p) => p.n > 0)).filter((i) => i >= 0)); return Math.max(0, Math.min(first, len - 1)); });
const weeks = computed(() => (d.value?.weeks ?? []).slice(from.value, from.value + 8).slice(-8));
interface Cell { text: string; n: number; few: boolean; tone: "" | "better" | "worse" }
const rows = computed(() => (d.value?.kinds ?? []).map((k) => {
  const ps = k.points.slice(from.value).slice(-8);
  let prev: number | null = null;
  const cells: Cell[] = ps.map((p) => {
    const v = m.value.val(p), n = m.value.n(p);
    const tone = v != null && prev != null && v !== prev ? (v < prev ? "better" : "worse") : "";
    if (v != null) prev = v;
    return { text: v == null ? "" : m.value.fmt(v), n, few: v != null && n < 3, tone };
  });
  return { kind: k.kind, n: k.n, cells };
}));
const unitWord = computed(() => (metrics.unit === "job" ? "jobs" : "tasks"));
const sparse = computed(() => (d.value?.fill ?? []).filter((f) => f.sparse));
const err = computed(() => (metrics.err && !d.value ? `Trends not available (${metrics.err}).` : !d.value ? "Loading…" : ""));
const tokFmt = (v: number) => (v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v))) + " tokens";
const tokAxis = (v: number) => (v >= 1e6 ? +(v / 1e6).toFixed(2) + "M" : v >= 1e3 ? +(v / 1e3).toFixed(1) + "k" : String(v));
const usdAxis = (v: number) => "$" + +v.toFixed(2);
const KEYS = Object.keys(M) as Key[];
</script>

<template>
  <div class="mt-wrap">
    <div v-if="d?.daily" class="charts">
      <UsageChart title="Usage per job" :hint="`Tokens a typical closed ${unitWord.slice(0, -1)} uses, per day.`" :lines="d.daily.tokens" :days="d.daily.days" :fmt="tokFmt" :axis="tokAxis" word="usage" :unit-word="unitWord" />
      <UsageChart title="Cost per job" :hint="`Dollars a typical closed ${unitWord.slice(0, -1)} costs, per day.`" :lines="d.daily.cost" :days="d.daily.days" :fmt="M.cost.fmt" :axis="usdAxis" word="cost" :unit-word="unitWord" />
    </div>
    <div class="bar">
      <div class="seg" role="tablist" aria-label="Measure"><button v-for="k in KEYS" :key="k" type="button" role="tab" :aria-selected="key === k" :class="{ on: key === k }" @click="key = k">{{ M[k].label }}</button></div>
      <div class="seg" role="tablist" aria-label="Unit"><button type="button" role="tab" :aria-selected="metrics.unit === 'job'" :class="{ on: metrics.unit === 'job' }" @click="setMetricsUnit('job')">Jobs</button><button type="button" role="tab" :aria-selected="metrics.unit === 'task'" :class="{ on: metrics.unit === 'task' }" @click="setMetricsUnit('task')">Old tasks</button></div>
    </div>
    <p v-if="err" class="note">{{ err }}</p>
    <template v-else>
      <p class="note sent">{{ m.hint }}. Lower is better. Green = better than the week before, red = worse.<template v-if="sparse.length">{{ " " }}<b class="warn">Some numbers rest on very few {{ unitWord }}, so trust them less.</b></template></p>
      <p v-if="rows.length && weeks.length === 1" class="note">Only this week so far; the change shows from next week.</p>
      <p v-if="!rows.length" class="note">No closed {{ unitWord }} in the last {{ d?.weeks.length }} weeks.</p>
      <div v-else class="tw">
        <table class="t">
          <thead><tr><th scope="col">Kind of work</th><th v-for="w in weeks" :key="w" scope="col">{{ range(w) }}</th></tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.kind">
              <th scope="row"><b>{{ r.kind }}</b></th>
              <td v-for="(c, i) in r.cells" :key="weeks[i]" :class="c.tone">
                <template v-if="c.text"><b class="num">{{ c.text }}</b><small>{{ c.n }} {{ c.n === 1 ? unitWord.slice(0, -1) : unitWord }}<template v-if="c.few"> · few {{ unitWord }}</template></small><span v-if="c.tone" class="sr">{{ c.tone }} than the week before</span></template>
                <span v-else class="none">no data</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mt-wrap{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0;padding:12px 20px 16px;align-content:start}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;min-width:0}
.bar{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;min-width:0}
.seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track);max-width:100%;overflow-x:auto}
.seg button{min-height:44px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer;white-space:nowrap}
.seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.note{margin:0;color:var(--muted);font-size:12px;line-height:1.45}.warn{color:var(--pend)}.sent{font-size:14px;color:var(--ink)}
.tw{overflow-x:auto;min-width:0}
.t{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;min-width:560px}
.t th,.t td{padding:8px 10px;text-align:center;vertical-align:middle;border-top:1px solid var(--hair);font-weight:400}
.t thead th{border-top:0;font:600 12px var(--body);color:var(--muted)}
.t th[scope=row],.t thead th:first-child{text-align:left;width:150px}
.t th[scope=row] b,.t td b{display:block;font-size:14px}.t td b{font:600 15px var(--mono)}
.t small{display:block;color:var(--muted);font-size:11px;line-height:1.3}
.t td.better{background:color-mix(in srgb,#2f9e5b 22%,transparent)}
.t td.worse{background:color-mix(in srgb,#d64545 22%,transparent)}
.none{color:var(--muted);font-size:11px;opacity:.6}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:1100px){.charts{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){.mt-wrap{padding:10px 14px 14px}.seg{display:flex;flex-wrap:wrap;overflow:visible}.seg button{flex:1 1 auto}.t th[scope=row],.t thead th:first-child{width:110px}}
</style>
