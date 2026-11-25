<script setup lang="ts">
// Evals: the fixed exam per brain (docs/internal/SPEC-brain-evals.md). Read only. Per brain two charts over its arms in time order:
// pass rate and cost per passed task; the grey band on the cost chart is the A/A noise around the first arm.
import { computed, onMounted, ref } from "vue";
import { api } from "../ui/api";

interface Arm { version: string; lessons: string; arm: string; tasks: number; tries: number; passRate: number; reliability: number; costPerPassed: number | null; costTotal: number; medianWallMs: number }
interface Paired { tasks: number; needed: number; ready: boolean; base: Arm | null; lessons: Arm | null; savedPerJob: number | null }
interface BrainEval { name: string; smoke: boolean; arms: Arm[]; noiseBand: number | null; paired: Paired }
interface Exam { id: string; brain: string; kind: string; status: string; project: string; what: string; steps: string[]; checks: number; proof: boolean }
interface Cell { brain: string; task: string; arm: string; tries: number; pass: number; costMean: number }
interface SysBrain { brain: string; pairedTasks: number; needed: number; ready: boolean; baseUsd: number | null; lessonsUsd: number | null; jobs: number; savedUsd: number | null }
interface Summary { brains: BrainEval[]; exams?: Exam[]; grid?: Cell[]; system?: { brains: SysBrain[]; savedUsdEstimate: number | null; basis: string } }
const data = ref<Summary | null>(null), err = ref(""), loading = ref(true);
const brains = computed(() => data.value?.brains ?? []);
async function load() { try { data.value = await api<Summary>("v1/panel/evals"); err.value = ""; } catch (e) { err.value = (e as Error).message; } finally { loading.value = false; } }
onMounted(load);

const exams = computed(() => data.value?.exams ?? []);
const sys = computed(() => data.value?.system);
const signed = (v: number | null) => (v == null ? "–" : `${v < 0 ? "−" : "+"}${usd(Math.abs(v))}`);
const pairArms = (b: BrainEval) => (b.paired.ready ? [b.paired.base!, b.paired.lessons!] : []);
const gridArms = (b: string) => [...new Set((data.value?.grid ?? []).filter((c) => c.brain === b).map((c) => c.arm))].sort((a, z) => Number(/ base$/.test(z)) - Number(/ base$/.test(a)) || a.localeCompare(z));
const cell = (b: string, t: string, a: string) => (data.value?.grid ?? []).find((c) => c.brain === b && c.task === t && c.arm === a);
const examsOf = (b: string) => exams.value.filter((e) => e.brain === b && e.status === "ready");
const W = 360, H = 120, PX = 36, PY = 14, PR = 22;
const x = (i: number, n: number) => (n < 2 ? W / 2 : PX + (i * (W - PX - PR)) / (n - 1));
const y = (v: number, max: number) => H - PY - (v / max) * (H - 2 * PY);
/** Points for one series; null values are skipped. */
function pts(vals: (number | null)[], max: number) {
  return vals.map((v, i) => (v == null ? null : { x: x(i, vals.length), y: y(v, max) })).filter((p): p is { x: number; y: number } => !!p);
}
const line = (p: { x: number; y: number }[]) => p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
const costMax = (b: BrainEval) => Math.max(0.01, ...pairArms(b).map((a) => a.costPerPassed ?? 0)) * 1.25;
const usd = (v: number | null) => (v == null ? "–" : v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const label = (a: Arm) => `${a.version.replace(/^[^@]*@/, "")} ${a.arm.slice(0, 6)}${a.lessons !== "e3b0c442" ? " +L" : ""}`;
function band(b: BrainEval) {
  const f = pairArms(b)[0]?.costPerPassed; if (f == null || b.noiseBand == null) return null;
  const m = costMax(b), top = y(Math.min(m, f * (1 + b.noiseBand)), m), bottom = y(Math.max(0, f * (1 - b.noiseBand)), m);
  return { y: top, h: Math.max(2, bottom - top) };
}
</script>

<template>
  <section class="page fp ev">
    <header class="ph"><h1>Evals</h1><span v-if="brains.length" class="ph-s"><b class="num">{{ brains.length }}</b> {{ brains.length === 1 ? "brain" : "brains" }} examined</span></header>
    <p v-if="loading" class="msg">Loading evals…</p>
    <div v-else-if="err" class="msg" role="alert">Could not load the evals: {{ err }} <button type="button" class="lnk" @click="load">Retry</button></div>
    <div v-else-if="!brains.length" class="msg"><b>No exam run yet.</b><br />Run <code>bun scripts/evals/run.ts &lt;task&gt; --brain &lt;name&gt;</code> and the charts appear here.</div>
    <div v-else class="body">
    <article v-if="sys && sys.brains.length" class="card sysc" aria-label="Whole system">
      <h2>Whole system<em class="num">{{ sys.brains.length }} {{ sys.brains.length === 1 ? "brain" : "brains" }} with a real exam</em></h2>
      <div class="sysrow num">
        <div v-for="p in sys.brains" :key="p.brain"><span>{{ p.brain }}: USD per passed try, base vs lessons</span>
          <b v-if="p.ready">{{ usd(p.baseUsd) }} vs {{ usd(p.lessonsUsd) }}</b><b v-else class="wait">waiting for paired runs</b>
          <span v-if="p.ready">saved {{ signed(p.savedUsd) }} over {{ p.jobs }} real jobs</span><span v-else>{{ p.pairedTasks }} of {{ p.needed }} paired tasks</span></div>
        <div><span>Saved so far (estimate)</span><b>{{ sys.savedUsdEstimate == null ? "waiting for paired runs" : signed(sys.savedUsdEstimate) }}</b></div>
      </div>
      <p class="note">{{ sys.basis }}.</p>
    </article>
    <div class="grid" role="list" aria-label="Evals per brain">
      <article v-for="b in brains" :key="b.name" class="card" role="listitem">
        <h2>{{ b.name }}<em v-if="b.smoke" class="num">smoke only, no verdict</em><em v-else-if="!b.paired.ready" class="num">waiting for paired runs</em><em v-if="b.noiseBand != null" class="num">A/A noise ±{{ Math.round(b.noiseBand * 100) }}% cost</em></h2>
        <p v-if="b.smoke" class="note">Only hand-seeded smoke tasks ran for this brain. They are too easy to separate arms, so there are no charts.</p>
        <p v-else-if="!b.paired.ready" class="note">{{ b.paired.tasks }} of {{ b.paired.needed }} tasks have both a base and a lessons run. Charts appear from {{ b.paired.needed }} paired tasks.</p>
        <div v-else class="charts">
          <figure>
            <figcaption>Pass rate</figcaption>
            <svg :viewBox="`0 0 ${W} ${H + 18}`" role="img" :aria-label="`Pass rate of ${b.name} per arm`">
              <line :x1="PX" :x2="W - 8" :y1="H - PY" :y2="H - PY" class="ax" /><line :x1="PX" :x2="W - 8" :y1="PY" :y2="PY" class="ax" />
              <text :x="PX - 6" :y="PY + 4" class="tk" text-anchor="end">100%</text><text :x="PX - 6" :y="H - PY + 4" class="tk" text-anchor="end">0%</text>
              <polyline :points="line(pts(pairArms(b).map((a) => a.passRate), 1))" class="ln" />
              <g v-for="(a, i) in pairArms(b)" :key="i"><circle :cx="x(i, 2)" :cy="y(a.passRate, 1)" r="4" class="dot" /><text :x="x(i, 2)" :y="H + 12" class="tk" text-anchor="middle">{{ label(a) }}</text></g>
            </svg>
          </figure>
          <figure>
            <figcaption>Cost per passed task</figcaption>
            <svg :viewBox="`0 0 ${W} ${H + 18}`" role="img" :aria-label="`Cost per passed task of ${b.name} per arm`">
              <rect v-if="band(b)" :x="PX" :width="W - PX - 8" :y="band(b)!.y" :height="band(b)!.h" class="bd" />
              <line :x1="PX" :x2="W - 8" :y1="H - PY" :y2="H - PY" class="ax" />
              <text :x="PX - 6" :y="PY + 4" class="tk" text-anchor="end">{{ usd(costMax(b)) }}</text><text :x="PX - 6" :y="H - PY + 4" class="tk" text-anchor="end">$0</text>
              <polyline :points="line(pts(pairArms(b).map((a) => a.costPerPassed), costMax(b)))" class="ln" />
              <circle v-for="(p, i) in pts(pairArms(b).map((a) => a.costPerPassed), costMax(b))" :key="i" :cx="p.x" :cy="p.y" r="4" class="dot" />
              <text v-for="(a, i) in pairArms(b)" :key="'l' + i" :x="x(i, 2)" :y="H + 12" class="tk" text-anchor="middle">{{ label(a) }}</text>
            </svg>
          </figure>
        </div>
        <table v-if="b.paired.ready" class="tb num">
          <thead><tr><th>Arm</th><th>Tasks</th><th>Tries</th><th>Pass</th><th>All repeats</th><th>$ / passed</th><th>Median time</th></tr></thead>
          <tbody><tr v-for="(a, i) in pairArms(b)" :key="i"><td>{{ label(a) }}</td><td>{{ a.tasks }} paired</td><td>{{ a.tries }}</td><td>{{ pct(a.passRate) }}</td><td>{{ pct(a.reliability) }}</td><td>{{ usd(a.costPerPassed) }}</td><td>{{ (a.medianWallMs / 1000).toFixed(1) }} s</td></tr></tbody>
        </table>
      </article>
    </div>
    <article v-for="b in brains" :key="'x' + b.name" class="card">
      <h2>{{ b.name }} exam<em class="num">{{ examsOf(b.name).length }} frozen tasks</em><em v-if="b.smoke" class="num">smoke only</em></h2>
      <table class="tb num">
        <thead><tr><th>Exam</th><th>Kind</th><th>Project</th><th>Hidden checks</th><th v-for="a in gridArms(b.name)" :key="a">{{ a }}</th></tr></thead>
        <tbody>
          <template v-for="e in examsOf(b.name)" :key="e.id">
            <tr><td><details><summary>{{ e.id }}</summary><p class="what">{{ e.what }}</p><ol v-if="e.steps.length"><li v-for="(st, i) in e.steps" :key="i">{{ st }}</li></ol></details></td><td>{{ e.kind }}</td><td>{{ e.project }}</td><td>{{ e.checks }}{{ e.proof ? " + proof" : "" }}</td>
              <td v-for="a in gridArms(b.name)" :key="a">{{ cell(b.name, e.id, a) ? `${cell(b.name, e.id, a)!.pass}/${cell(b.name, e.id, a)!.tries} · ${usd(cell(b.name, e.id, a)!.costMean)}` : "–" }}</td></tr>
          </template>
        </tbody>
      </table>
    </article>
    </div>
  </section>
</template>

<style scoped>
.ev{flex:1;min-height:0;gap:12px}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.msg{margin:0;padding:48px 20px;color:var(--muted);text-align:center;font-size:14px;line-height:1.6}.msg b{color:var(--ink)}
.lnk{all:unset;cursor:pointer;text-decoration:underline;color:var(--ink)}
code{font:500 12px var(--mono);color:var(--ink)}
.body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;gap:14px;align-content:start;padding:2px 2px 24px}.wait{font-size:15px;color:var(--muted)}
.sysrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.sysrow div{display:grid;gap:2px}.sysrow span{font-size:12px;color:var(--muted)}.sysrow b{font:700 22px var(--body)}
.note{margin:0;font-size:12px;color:var(--muted)}.what{margin:6px 0;font-size:12.5px}summary{cursor:pointer;font-weight:600}details ol{margin:4px 0 6px 18px;padding:0;font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(560px,1fr));gap:14px;align-content:start;padding:2px}
.card{display:grid;gap:12px;align-content:start;padding:16px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.card h2{margin:0;font:700 16px/1.2 var(--body);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.card h2 em{font:600 11.5px var(--mono);font-style:normal;padding:1px 6px;border-radius:5px;background:var(--soft);color:var(--ink)}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
figure{margin:0;min-width:0}figcaption{font:600 12px var(--body);color:var(--muted);margin-bottom:4px}
svg{width:100%;height:auto;display:block}
.ax{stroke:var(--line);stroke-width:1}.ln{fill:none;stroke:var(--ink);stroke-width:2}.dot{fill:var(--ink)}.bd{fill:var(--soft)}
.tk{font:10px var(--mono);fill:var(--muted)}
.tb{width:100%;border-collapse:collapse;font-size:12.5px}.tb th{text-align:left;color:var(--muted);font-weight:600;padding:4px 6px}.tb td{padding:5px 6px;border-top:1px solid var(--line)}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr)}.charts{grid-template-columns:minmax(0,1fr)}}
</style>
