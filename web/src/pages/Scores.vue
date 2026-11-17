<script setup lang="ts">
// Scores, board page 06: average grade with bands, task discipline (10 days + today's five checks), grade next to cost per model,
// best agents / roles / personas and the ones that need a look. Fixed to the window; the lists scroll inside.
import { computed, onBeforeUnmount, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { DISCIPLINE_CHECKS as CHK, scores, useScores, type AgentScoreRow, type GroupScoreRow } from "../net";

const stop = useScores();
onBeforeUnmount(stop);
const d = computed(() => scores.data);
const band = (s: number) => (s >= 80 ? "great" : s >= 60 ? "good" : s >= 40 ? "fair" : "poor");
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (m: string | null) => (m ? m.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-/g, " ") : "–");

const byModel = computed(() => (d.value?.byModel ?? []).filter((m) => m.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));
const FALLBACK = "Grade next to cost: is the dearer model worth it?";
const fam = (k: string) => { const w = short(k).split(" ")[0]; return w.charAt(0).toUpperCase() + w.slice(1); };
const list = (n: string[]) => (n.length < 2 ? n.join("") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1]);
/** Built from the rows: the largest set of models with the same grade, and the dearest of them against the cheapest per task. */
const costNote = computed(() => {
  const by = new Map<number, typeof byModel.value>();
  for (const m of byModel.value) (by.get(Math.round(m.score!)) ?? by.set(Math.round(m.score!), []).get(Math.round(m.score!))!).push(m);
  const grp = [...by.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!grp || grp[1].length < 2) return FALLBACK;
  const paid = grp[1].filter((m) => m.costPerTask != null && m.costPerTask > 0).sort((a, b) => a.costPerTask! - b.costPerTask!);
  if (paid.length < 2) return FALLBACK;
  const lo = paid[0], hi = paid[paid.length - 1], r = hi.costPerTask! / lo.costPerTask!;
  const names = list(grp[1].map((m) => fam(m.key)));
  return r < 1.2 ? `${names} grade the same (${grp[0]}) and cost about the same per task.` : `${names} grade the same (${grp[0]}); a ${fam(hi.key)} task costs about ${r >= 9.5 ? Math.round(r) : r.toFixed(1).replace(/\.0$/, "")} times a ${fam(lo.key)} task.`;
});
const gsum = computed(() => byModel.value.reduce((t, m) => t + m.graded, 0));
const avg = computed(() => (gsum.value ? Math.round(byModel.value.reduce((t, m) => t + (m.score ?? 0) * m.graded, 0) / gsum.value) : null));
const tasks = computed(() => (d.value?.agents ?? []).reduce((t, a) => t + a.tasks, 0));
const graded = computed(() => (d.value?.agents ?? []).reduce((t, a) => t + a.graded, 0));
const scored = computed(() => (d.value?.agents ?? []).filter((a) => a.score != null));
const W_NAME: Record<string, string> = { quality: "quality", firstTimeRight: "first time right", efficiency: "efficiency", reliability: "reliability", rework: "no rework" };
const weights = computed(() => Object.entries(d.value?.weights ?? {}).map(([k, v]) => `${W_NAME[k] ?? k} ${v}`).join(", "));

const days = computed(() => (d.value?.discipline.days ?? []).slice(-10));
const today = computed(() => d.value?.discipline.today ?? days.value[days.value.length - 1] ?? null);
const worst = computed(() => {
  const t = today.value; if (!t) return null;
  const l = CHK.map(([k, n]) => [n, t.checks?.[k]] as const).filter(([, v]) => v != null).sort((a, b) => (a[1] as number) - (b[1] as number));
  return l.length && (l[0][1] as number) < 50 ? l[0] : null;
});
const dd = (s: string) => String(new Date(s + "T12:00").getDate());
const pc = (n: number | null | undefined) => (n == null ? "–" : Math.round(n) + "%");
// the score counts the steps of closed jobs since the job model; a server from before it sends no job count, and then nothing is said
const since = computed(() => { const f = d.value?.discipline.days[0]; return f && f.jobs != null ? new Date(f.day + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; });

type Kind = "agents" | "roles" | "souls";
const KINDS = [["agents", "Agents"], ["roles", "Roles"], ["souls", "Personas"]] as const;
const kind = ref<Kind>("agents");
const phoneTab = ref<"best" | "low">("best");
const best = computed(() => [...scored.value].sort((a, b) => b.score! - a.score! || b.graded - a.graded).slice(0, 20));
const low = computed(() => [...scored.value].sort((a, b) => a.score! - b.score! || a.graded - b.graded).slice(0, 10));
const groups = computed<GroupScoreRow[]>(() => ((kind.value === "roles" ? d.value?.byRole : d.value?.bySoul) ?? []).filter((g) => g.score != null).sort((a, b) => b.score! - a.score!));
const few = (n: number) => n <= 4;
const minNote = computed(() => { const f = low.value.find((a) => few(a.graded)); return f ? `Amber "graded" means 4 or fewer graded tasks: the score can still move a lot. ${f.agent} has ${f.graded} graded of ${f.tasks}.` : `An agent gets a score after ${d.value?.minGraded ?? 3} graded tasks.`; });
const err = computed(() => (scores.err && !d.value ? `Scores not available (${scores.err}).` : !d.value ? "Loading…" : ""));
</script>

<template>
  <section class="page fp sc">
    <header class="ph"><h1>Scores</h1><span v-if="avg != null" class="ph-s"><b class="num">{{ avg }}</b> average · <b class="num">{{ scored.length }}</b> agents</span></header>
    <p v-if="err" class="rule pad">{{ err }}</p>
    <div v-else class="grid">
      <section class="uc" aria-label="Grade">
        <h2><Icon name="gauge" :size="16" />Graded work is {{ avg != null ? band(avg) : "not scored yet" }}<span class="sp" /><small>{{ graded.toLocaleString("en-GB") }} of {{ tasks.toLocaleString("en-GB") }} tasks graded</small></h2>
        <template v-if="avg != null">
          <div class="big"><b class="num">{{ avg }}</b><small>average grade</small></div>
          <div class="mt" role="meter" aria-label="Average grade" :aria-valuenow="avg" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: avg + '%' }" /><span v-for="p in [40, 60, 80]" :key="p" class="tk" :style="{ left: p + '%' }" /></div>
          <div class="mk"><span v-for="[n, p] in [['fair', 40], ['good', 60], ['great', 80]]" :key="n" :style="{ left: p + '%' }">{{ n }} {{ p }}</span></div>
        </template>
        <p class="rule">Root grades finished tasks: {{ weights }}. An agent gets a score after <b>{{ d?.minGraded }}</b> graded tasks.</p>
      </section>

      <section class="uc" aria-label="Task discipline">
        <h2><Icon name="circle-check" :size="16" />Task discipline<span class="sp" /><small>last {{ days.length }} days</small></h2>
        <template v-if="today">
          <div class="dh"><div class="big"><b class="num">{{ today.score ?? "–" }}</b><small>today</small></div>
            <div class="days"><div v-for="(x, i) in days" :key="x.day" :class="{ today: i === days.length - 1 }" :title="`${x.day}: ${x.score ?? '–'}`"><i :style="{ height: Math.max(3, (x.score ?? 0) * 0.56) + 'px' }" />{{ dd(x.day) }}</div></div></div>
          <div class="chk"><div v-for="[k, n] in CHK" :key="k" :class="{ bad: (today.checks?.[k] ?? 100) < 50 }"><span>{{ n }}</span><span class="mtr"><i :style="{ width: (today.checks?.[k] ?? 0) + '%' }" /></span><b class="num">{{ pc(today.checks?.[k]) }}</b></div></div>
          <p class="rule"><template v-if="today.jobs != null">Today <b>{{ today.jobs }}</b> {{ today.jobs === 1 ? "job" : "jobs" }}, <b>{{ today.steps ?? 0 }}</b> {{ today.steps === 1 ? "step" : "steps" }}. </template>Share of steps in closed jobs that kept each habit.<template v-if="since"> New score from {{ since }}.</template><template v-if="worst">{{ " " }}<b class="badt">"{{ worst[0] }}" is {{ worst[1] }}% today.</b></template></p>
        </template>
        <p v-else class="rule">No discipline data yet.</p>
      </section>

      <section class="uc" aria-label="By model">
        <h2><Icon name="cpu" :size="16" />By model</h2>
        <table class="mtb"><thead><tr><th>Model</th><th>Grade</th><th>Graded</th><th>$ per task</th></tr></thead><tbody>
          <tr v-for="m in byModel" :key="m.key"><td><b>{{ short(m.key) }}</b></td><td class="num">{{ m.score }} <span class="bd" :class="band(m.score!)">{{ band(m.score!) }}</span></td><td class="num">{{ m.graded }}</td><td class="num">{{ m.costPerTask != null ? usd(m.costPerTask) : "–" }}</td></tr></tbody></table>
        <p class="rule">{{ costNote }}</p>
      </section>

      <div class="lists">
        <section class="uc list" :class="{ off: phoneTab === 'low' }" aria-label="Best scores">
          <h2><Icon name="trophy" :size="16" />Best scores<span class="sp" />
            <div class="seg dk" role="tablist" aria-label="List"><button v-for="[id, l] in KINDS" :key="id" type="button" role="tab" :aria-selected="kind === id" :class="{ on: kind === id }" @click="kind = id">{{ l }}</button></div>
            <div class="seg ph2" role="tablist" aria-label="List"><button type="button" role="tab" :aria-selected="phoneTab === 'best'" :class="{ on: phoneTab === 'best' }" @click="phoneTab = 'best'">Best</button><button type="button" role="tab" :aria-selected="phoneTab === 'low'" :class="{ on: phoneTab === 'low' }" @click="phoneTab = 'low'">Needs a look</button></div></h2>
          <div class="tb">
            <template v-if="kind === 'agents'">
              <div class="row hd"><span>#</span><span>Agent</span><span>Role</span><span>Model</span><span>Score</span><span class="r">Graded</span></div>
              <div v-for="(a, i) in best" :key="a.agent" class="row"><span class="n">{{ i + 1 }}</span><span class="nm">{{ a.agent }}</span><span class="ro">{{ a.role }}</span><span class="chip">{{ short(a.model) }}</span><span class="scb"><span class="mtr"><i :style="{ width: a.score + '%' }" /></span><b class="num">{{ a.score }}</b></span><span class="r num" :class="{ few: few(a.graded) }">{{ a.graded }}/{{ a.tasks }}</span></div>
            </template>
            <template v-else>
              <div class="row hd g"><span>#</span><span>{{ kind === "roles" ? "Role" : "Persona" }}</span><span /><span /><span>Score</span><span class="r">Graded</span></div>
              <div v-for="(g, i) in groups" :key="g.key" class="row g"><span class="n">{{ i + 1 }}</span><span class="nm">{{ g.key }}</span><span /><span /><span class="scb"><span class="mtr"><i :style="{ width: g.score + '%' }" /></span><b class="num">{{ g.score }}</b></span><span class="r num" :class="{ few: few(g.graded) }">{{ g.graded }}/{{ g.tasks }}</span></div>
              <p v-if="!groups.length" class="rule pad">Nothing scored here yet.</p>
            </template>
          <div class="pextra">
            <section v-if="today" class="uc"><h2><Icon name="circle-check" :size="16" />Task discipline<span class="sp" /><small>today {{ today.score ?? "–" }}</small></h2>
              <div class="chk"><div v-for="[k, n] in CHK" :key="k" :class="{ bad: (today.checks?.[k] ?? 100) < 50 }"><span>{{ n }}</span><span class="mtr"><i :style="{ width: (today.checks?.[k] ?? 0) + '%' }" /></span><b class="num">{{ pc(today.checks?.[k]) }}</b></div></div></section>
            <section class="uc"><h2><Icon name="cpu" :size="16" />By model</h2>
              <table class="mtb"><thead><tr><th>Model</th><th>Grade</th><th>$ per task</th></tr></thead><tbody><tr v-for="m in byModel" :key="m.key"><td><b>{{ short(m.key) }}</b></td><td class="num">{{ m.score }}</td><td class="num">{{ m.costPerTask != null ? usd(m.costPerTask) : "–" }}</td></tr></tbody></table></section>
          </div>
          </div>
        </section>
        <section class="uc list low" :class="{ on: phoneTab === 'low' }" aria-label="Needs a look">
          <h2><Icon name="triangle-alert" :size="16" />Needs a look<span class="sp" /><small>lowest {{ low.length }}</small></h2>
          <div class="tb"><div class="row hd"><span>Agent</span><span>Model</span><span>Score</span><span class="r">Graded</span></div>
            <div v-for="a in low" :key="a.agent" class="row"><span><span class="nm">{{ a.agent }}</span><br /><span class="ro sm">{{ a.role }}</span></span><span class="chip">{{ short(a.model) }}</span><span class="scb"><span class="mtr"><i :style="{ width: a.score + '%' }" /></span><b class="num">{{ a.score }}</b></span><span class="r num" :class="{ few: few(a.graded) }">{{ a.graded }}/{{ a.tasks }}</span></div></div>
          <div class="ft">{{ minNote }}</div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sc{flex:1;min-height:0;gap:12px}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1.3fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:16px}
.uc{display:grid;align-content:start;gap:10px;padding:18px 20px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.uc h2{display:flex;gap:8px;align-items:center;margin:0;font:600 14px/1.3 var(--body)}.uc h2 small{font-weight:400;color:var(--muted);font-size:13px}
.sp{flex:1}
.big{display:flex;align-items:baseline;gap:6px}.big b{font:600 44px/1 var(--mono)}.big small{font:400 15px/1 var(--body);color:var(--muted)}
.mt{position:relative;height:10px;border-radius:5px;background:var(--track)}.mt i{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--on);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.tk{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--ink);opacity:.45}
.mk{position:relative;height:20px;font-size:12px;color:var(--muted)}.mk>span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}
.rule{margin:0;color:var(--muted);font-size:13px;line-height:1.45}.rule b{color:var(--ink)}.rule .badt{color:var(--bad)}.pad{padding:16px 20px}
.dh{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:end}
.days{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:6px;align-items:end;height:72px}
.days div{display:grid;gap:4px;justify-items:center;height:100%;align-content:end;font-size:11px;color:var(--muted)}
.days i{display:block;width:100%;border-radius:4px 4px 2px 2px;background:var(--ink);opacity:.35;transition:height .3s cubic-bezier(.2,.8,.2,1)}.days div.today i{opacity:1}
.chk{display:grid;gap:6px;font-size:13px}.chk>div{display:grid;grid-template-columns:150px minmax(0,1fr) 40px;gap:10px;align-items:center}
.chk b{text-align:right}.chk .bad b{color:var(--bad)}
.mtr{height:8px;border-radius:4px;background:var(--track);overflow:hidden;display:block}.mtr i{display:block;height:100%;border-radius:4px;background:var(--chrome);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.chk .bad .mtr i{background:var(--bad)}
.mtb{width:100%;border-collapse:collapse;font-size:13px}.mtb td,.mtb th{padding:7px 0;border-top:1px solid var(--hair);text-align:right}
.mtb th{color:var(--muted);font-weight:400;font-size:12px;border:0}.mtb td:first-child,.mtb th:first-child{text-align:left}
.bd{font-size:12px;color:var(--muted)}.bd.great{color:var(--on)}.bd.fair{color:var(--pend)}.bd.poor{color:var(--bad)}
.lists{grid-column:1/4;display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;min-height:0}
.list{grid-template-rows:auto minmax(0,1fr);padding:0;overflow:hidden;gap:0}.list.low{grid-template-rows:auto minmax(0,1fr) auto}.list>h2{padding:16px 20px 10px}
.tb{overflow:auto;overscroll-behavior:contain;min-height:0}
.row{display:grid;grid-template-columns:26px minmax(140px,1.3fr) minmax(90px,1fr) 110px minmax(120px,1.2fr) 70px;gap:12px;align-items:center;padding:8px 20px;border-top:1px solid var(--hair);font-size:14px}
.low .row{grid-template-columns:minmax(130px,1.3fr) 110px minmax(100px,1fr) 82px}
.row.hd{color:var(--muted);font-size:12px;position:sticky;top:0;background:var(--panel);z-index:1}
.n{color:var(--muted);font:12px var(--mono)}.nm{font-weight:600;overflow-wrap:anywhere}.ro{color:var(--muted);overflow-wrap:anywhere}.sm{font-size:12px}
.chip{justify-self:start;padding:2px 8px;border-radius:6px;background:var(--soft);font:12px/1.4 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.scb{display:flex;gap:8px;align-items:center}.scb .mtr{flex:1}.r{text-align:right}.few{color:var(--pend)}
.ft{padding:10px 20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer}
.seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ph2,.pextra{display:none}
@media (max-width:1279px){.grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.grid>.uc:first-child{grid-column:1/3}.lists{grid-template-columns:minmax(0,1fr)}.row{grid-template-columns:24px minmax(100px,1.2fr) minmax(70px,1fr) 100px minmax(100px,1.2fr) 56px}}
@media (max-width:760px){
  .ph{display:none}
  .grid{display:flex;flex-direction:column;gap:12px}
  .grid>.uc:first-child{grid-column:auto;flex:none}.grid>.uc:nth-child(2),.grid>.uc:nth-child(3){display:none}
  .lists{display:grid;flex:1;min-height:0;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
  .list{grid-area:1/1}.dk{display:none}.ph2{display:inline-grid}
  .list.off,.list.low:not(.on){display:none}
  .row,.low .row{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 14px}
  .row.hd,.n,.ro:not(.sm),.row>.chip{display:none}
  .row>.scb{grid-column:1/3}.row>.r{grid-column:1/3;text-align:left;font-size:12px}
  .list>h2{flex-wrap:wrap}.list>h2 .sp{display:none}.list>h2 .seg{margin-left:auto}
  .row>.r::after{content:" graded"}.pextra{display:grid;gap:12px;padding:12px 14px}.pextra .uc{padding:14px}
  .big b{font-size:40px}
}
</style>
