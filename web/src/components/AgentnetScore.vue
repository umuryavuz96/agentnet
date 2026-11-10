<script setup lang="ts">
// Agent scorecard (docs/agent-score.md). Two shapes of one component:
//  - with `only`: the compact Score block of the side panel (big number, five sub-score bars, cost per task, last 5 grades);
//  - without: the Scores section of the Agents page (sortable agent table + the by role / model / soul table for self-improvement).
// Every number comes from the server; "n/a" until the agent has the minimum number of graded tasks.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import BentoCard from "../ui/BentoCard.vue";
import { fetchAgentScore, scores, useScores, type AgentScore, type AgentScoreRow, type Discipline, type ScoreBase, type SubScores } from "../net";

const props = defineProps<{ only?: string }>();

const SUBS: [keyof SubScores, string, string][] = [
  ["quality", "Quality", "Mean root grade, 1-5 mapped to 0-100"],
  ["firstTimeRight", "First-time-right", "Rounds the owner needed before it was right: 0 = 100, 1 = 70, 2 = 45, 3 = 25, 4+ = 10"],
  ["efficiency", "Efficiency", "Cost per task against the role's median: cheaper is higher"],
  ["reliability", "Reliability", "Task list kept first, started and finished promptly, decision notes filled"],
  ["rework", "No rework", "Share of graded tasks root did not have to send back"],
];
const DCHECKS: [keyof Discipline["checks"], string][] = [["listedFirst", "Listed first"], ["started", "Started before done"], ["onTime", "Started on time"], ["notBatch", "Not batch-closed"], ["oneAtATime", "One at a time"]];
const usd = (n: number | null) => (n == null ? "–" : n < 0.1 ? "$" + n.toFixed(3) : "$" + n.toFixed(2));
const pt = (n: number | null) => (n == null ? "–" : String(Math.round(n)));
const rounds = (n: number | null) => (n == null ? "–" : (Math.round(n * 10) / 10).toString());
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? m + "m ago" : m < 2880 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
const band = (s: number | null) => (s == null ? "na" : s >= 80 ? "great" : s >= 60 ? "good" : s >= 40 ? "fair" : "poor");

// ---- panel block ----
const one = ref<AgentScore | null>(null), loaded = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
async function loadOne() { const n = props.only; if (!n) return; const s = await fetchAgentScore(n); if (n === props.only) { one.value = s; loaded.value = true; } }
watch(() => props.only, () => { one.value = null; loaded.value = false; clearInterval(timer); if (props.only) { void loadOne(); timer = setInterval(loadOne, 60_000); } }, { immediate: true });
const need = computed(() => (one.value ? Math.max(0, one.value.minGraded - one.value.graded) : 0));

// ---- page tables ----
let stop: (() => void) | null = null;
if (!props.only) stop = useScores();
onBeforeUnmount(() => { stop?.(); clearInterval(timer); });
type Key = "agent" | "role" | "score" | "discipline" | "quality" | "firstTimeRight" | "efficiency" | "reliability" | "rework" | "tasks" | "cost" | "rounds";
const sort = ref<{ k: Key; dir: 1 | -1 }>({ k: "score", dir: -1 });
const val = (r: ScoreBase & { agent?: string; role?: string }, k: Key): number | string | null =>
  k === "agent" ? r.agent ?? "" : k === "role" ? r.role ?? "" : k === "score" ? r.score : k === "discipline" ? (r as AgentScoreRow).discipline?.score ?? null : k === "tasks" ? r.tasks : k === "cost" ? r.costPerTask : k === "rounds" ? r.avgRounds : r.sub[k];
const rows = computed(() => {
  const { k, dir } = sort.value, list = [...(scores.data?.agents ?? [])];
  return list.sort((a, b) => { const x = val(a, k), y = val(b, k); if (x == null && y == null) return a.agent.localeCompare(b.agent); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number)) * dir || a.agent.localeCompare(b.agent); });
});
const setSort = (k: Key) => { sort.value = sort.value.k === k ? { k, dir: (sort.value.dir * -1) as 1 | -1 } : { k, dir: k === "agent" || k === "role" ? 1 : -1 }; };
const aria = (k: Key) => (sort.value.k === k ? (sort.value.dir === 1 ? "ascending" : "descending") : "none");
const COLS: [Key, string][] = [["score", "Score"], ["discipline", "Discipline"], ["quality", "Quality"], ["firstTimeRight", "First-time"], ["efficiency", "Effic."], ["reliability", "Reliab."], ["rework", "No rework"], ["tasks", "Tasks"], ["cost", "$/task"], ["rounds", "Rounds"]];
const cell = (r: ScoreBase, k: Key) => (k === "score" ? pt(r.score) : k === "discipline" ? pt((r as AgentScoreRow).discipline?.score ?? null) : k === "tasks" ? `${r.graded}/${r.tasks}` : k === "cost" ? usd(r.costPerTask) : k === "rounds" ? rounds(r.avgRounds) : pt(r.sub[k as keyof SubScores]));
const scored = computed(() => rows.value.filter((r) => r.score != null));
const fleet = computed(() => (scored.value.length ? Math.round(scored.value.reduce((t, r) => t + r.score!, 0) / scored.value.length) : null));
const lowest = computed(() => scored.value.reduce<AgentScoreRow | null>((m, r) => (m == null || r.score! < m.score! ? r : m), null));
const gradedSum = computed(() => rows.value.reduce((t, r) => t + r.graded, 0));
const taskSum = computed(() => rows.value.reduce((t, r) => t + r.tasks, 0));
const openNa = ref<Record<string, boolean>>({});
const split = (id: (typeof GROUPS)[number][0]) => { const l = scores.data?.[id] ?? []; return { scored: l.filter((r) => r.score != null), na: l.filter((r) => r.score == null) }; };
const nm = (k: string) => { const i = k.lastIndexOf("/"); return i < 0 ? { pre: "", name: k } : { pre: k.slice(0, i), name: k.slice(i + 1) }; };
const BANDS = [[40, "fair"], [60, "good"], [80, "great"]] as const;
const GROUPS = [["byRole", "Role"], ["byModel", "Model"], ["bySoul", "Soul"]] as const;
const grp = ref<(typeof GROUPS)[number][0]>("byRole");
</script>

<template>
  <!-- panel block -->
  <section v-if="only" class="sc" aria-label="Score">
    <div class="sc-h"><h3>Score</h3><span v-if="one" class="sc-hint">{{ one.graded }} graded of {{ one.tasks }} done</span></div>
    <p v-if="!loaded" class="sc-none">Loading…</p>
    <p v-else-if="!one || !one.tasks" class="sc-none">No finished task yet.</p>
    <template v-else>
      <div class="sc-top">
        <div :class="['sc-big', 'b-' + band(one.score)]" :title="one.score == null ? `n/a until ${one.minGraded} graded tasks` : `Score ${one.score} of 100`">
          <b class="sc-num">{{ one.score ?? "n/a" }}</b><span v-if="one.score != null" class="sc-band">{{ one.band }}</span>
        </div>
        <dl class="sc-kv">
          <dt>Cost / task</dt><dd class="sc-num">{{ usd(one.costPerTask) }}</dd>
          <dt>Avg grade</dt><dd class="sc-num">{{ one.avgGrade == null ? "–" : one.avgGrade.toFixed(1) + " / 5" }}</dd>
          <dt>Avg rounds</dt><dd class="sc-num" title="Back-and-forth rounds the owner needed before it was right">{{ rounds(one.avgRounds) }}</dd>
        </dl>
      </div>
      <p v-if="one.score == null" class="sc-none">{{ need }} more graded {{ need === 1 ? "task" : "tasks" }} for a score. Bars show what exists so far.</p>
      <ul class="sc-bars">
        <li v-for="[k, label, tip] in SUBS" :key="k" :title="tip">
          <span class="sc-l">{{ label }}</span>
          <span class="sc-bar" role="progressbar" :aria-label="label" :aria-valuenow="one.sub[k] == null ? undefined : Math.round(one.sub[k]!)" aria-valuemin="0" aria-valuemax="100"><i :class="'b-' + band(one.sub[k])" :style="{ width: (one.sub[k] ?? 0) + '%' }" /></span>
          <span class="sc-v sc-num">{{ pt(one.sub[k]) }}</span>
        </li>
      </ul>
      <div class="sc-disc" :title="`Task discipline ${one.discipline.score ?? 'n/a'} of 100: listed first, started before done, started on time, not batch-closed, one at a time`">
        <p class="sc-lh">Task discipline<span v-if="one.discipline.open"> · {{ one.discipline.open }} left open at despawn</span></p>
        <div class="sc-row"><span class="sc-bar" role="progressbar" aria-label="Task discipline" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="one.discipline.score ?? undefined"><i :class="'b-' + band(one.discipline.score)" :style="{ width: (one.discipline.score ?? 0) + '%' }" /></span><b class="sc-num sc-dn">{{ pt(one.discipline.score) }}</b></div>
        <ul class="sc-chk"><li v-for="[k, label] in DCHECKS" :key="k"><span>{{ label }}</span><b class="sc-num">{{ pt(one.discipline.checks[k]) }}%</b></li></ul>
      </div>
      <div v-if="one.last.length" class="sc-last">
        <p class="sc-lh">Last {{ one.last.length }} {{ one.last.length === 1 ? "grade" : "grades" }}<span v-if="one.lastAvgRounds != null"> · avg rounds {{ rounds(one.lastAvgRounds) }}</span></p>
        <ul>
          <li v-for="g in one.last" :key="g.id">
            <span :class="['sc-g', 'b-' + band(g.grade == null ? null : (g.grade - 1) * 25)]" :aria-label="`Grade ${g.grade} of 5`">{{ g.grade }}</span>
            <span v-if="g.penalty > 0" class="sc-tag bad" :title="`Root gave ${g.grade_raw}; ${g.penalty} points off for task discipline`">{{ g.grade_raw }}→{{ g.grade }}</span>
            <span class="sc-t" :title="g.text">{{ g.text }}</span>
            <span v-if="g.owner_rounds != null" class="sc-tag" :title="`${g.owner_rounds} back-and-forth rounds with the owner`">{{ g.owner_rounds }}r</span>
            <span v-if="g.rework" class="sc-tag bad">rework</span>
            <time v-if="g.graded_at">{{ ago(g.graded_at) }}</time>
            <span v-if="g.note" class="sc-note">{{ g.note }}</span>
          </li>
        </ul>
      </div>
      <p v-else class="sc-none">No grades yet. Root grades finished tasks.</p>
    </template>
  </section>

  <!-- page: bento. Hero = fleet score, two S tiles, by role/model/soul (three lists on desktop, tabs below), sortable agent table. -->
  <section v-else class="bento" aria-label="Agent scores">
    <template v-if="!scores.data">
      <BentoCard size="F" title="Scores"><p class="sc-none">{{ scores.err ? `Scores not available (${scores.err}).` : "Loading…" }}</p></BentoCard>
    </template>
    <template v-else>
      <BentoCard size="H" :title="fleet == null ? 'Fleet score' : `Fleet is ${band(fleet)}`">
        <div v-if="fleet != null" class="fl">
          <div class="bv"><b :class="['num', 'b-' + band(fleet)]">{{ fleet }}</b><small :class="'b-' + band(fleet)">{{ band(fleet) }}</small></div>
          <div class="fl-m"><span class="fl-bar" role="img" :aria-label="`Fleet score ${fleet} of 100, ${band(fleet)}`"><i :class="'b-' + band(fleet)" :style="{ width: fleet + '%' }" /></span>
            <span v-for="t in BANDS" :key="t[0]" class="fl-k" :style="{ left: t[0] + '%' }"><em class="num">{{ t[1] }}<br />{{ t[0] }}</em></span></div>
        </div>
        <p v-else class="sc-none">– Needs {{ scores.data.minGraded }} graded tasks on at least one agent.</p>
        <template #foot>Mean of {{ scored.length }} scored {{ scored.length === 1 ? "agent" : "agents" }} of {{ rows.length }}. Quality {{ scores.data.weights.quality }}, first-time-right {{ scores.data.weights.firstTimeRight }}, efficiency {{ scores.data.weights.efficiency }}, reliability {{ scores.data.weights.reliability }}, no rework {{ scores.data.weights.rework }}.</template>
      </BentoCard>
      <BentoCard size="S" title="Lowest score">
        <div v-if="lowest" class="bv"><b class="num">{{ lowest.score }}</b><small :class="'b-' + band(lowest.score)">{{ band(lowest.score) }}</small></div>
        <p v-else class="sc-none">–</p>
        <template #foot>{{ lowest ? lowest.agent : "No agent has a score yet" }}</template>
      </BentoCard>
      <BentoCard size="S" title="Graded tasks">
        <div class="bv"><b class="num">{{ gradedSum }}</b><small>of {{ taskSum }} done</small></div>
        <template #foot>Root grades finished tasks</template>
      </BentoCard>

      <BentoCard size="F" title="Task discipline" class="dc">
        <div v-if="scores.data.discipline.days.length" class="dc-top">
          <div class="bv"><b :class="['num', 'b-' + band(scores.data.discipline.today?.score ?? scores.data.discipline.all)]">{{ pt(scores.data.discipline.today?.score ?? scores.data.discipline.all) }}</b><small>{{ scores.data.discipline.today ? "today" : "all time" }}</small></div>
          <div class="dc-trend" role="img" :aria-label="`Discipline per day, last ${scores.data.discipline.days.length} days`">
            <span v-for="d in scores.data.discipline.days" :key="d.day" class="dc-d" :title="`${d.day}: ${d.score ?? 'n/a'} over ${d.tasks} tasks`"><i :class="'b-' + band(d.score)" :style="{ height: Math.max(4, d.score ?? 0) + '%' }" /></span>
          </div>
        </div>
        <p v-else class="sc-none">– No finished tasks yet.</p>
        <template #foot>Share of finished tasks that kept the five habits: listed first, started before done, started on time, not batch-closed, one at a time. All time: {{ pt(scores.data.discipline.all) }}.</template>
      </BentoCard>

      <BentoCard size="F" title="Breakdown" class="sg">
        <template #control>
          <div class="sp-seg" role="tablist" aria-label="Group by">
            <button v-for="[id, label] in GROUPS" :key="id" type="button" role="tab" :aria-selected="grp === id" :class="{ on: grp === id }" @click="grp = id">{{ label }}</button>
          </div>
        </template>
        <div class="sg-grid">
          <div v-for="[id, label] in GROUPS" :key="id" :class="['sg-col', { on: grp === id }]">
            <h3>{{ label }}</h3>
            <p v-if="!(scores.data[id] ?? []).length" class="sc-none">Nothing to group yet.</p>
            <template v-else>
              <ul class="sg-l">
                <li v-for="r in split(id).scored" :key="r.key">
                  <span class="sg-n" :title="r.key"><small v-if="nm(r.key).pre">{{ nm(r.key).pre }}/</small>{{ nm(r.key).name }}</span>
                  <span class="sg-v num">{{ Math.round(r.score!) }} <small>{{ band(r.score) }}</small></span>
                  <span class="sg-b" role="img" :aria-label="`${r.key}: score ${Math.round(r.score!)} of 100, ${band(r.score)}`"><i :class="'b-' + band(r.score)" :style="{ width: r.score + '%' }" /></span>
                </li>
              </ul>
              <div v-if="split(id).na.length" class="sg-na">
                <button type="button" class="sg-nh" :aria-expanded="!!openNa[id]" :aria-controls="'sg-na-' + id" @click="openNa[id] = !openNa[id]">
                  <span>n/a ({{ split(id).na.length }} not scored, need {{ scores.data.minGraded }} graded tasks)</span>
                  <Icon name="chevron-down" :size="16" class="sg-cv" />
                </button>
                <div :id="'sg-na-' + id" :class="['sg-nb', { 'is-open': openNa[id] }]" :inert="!openNa[id] || undefined">
                  <ul class="sg-l">
                    <li v-for="r in split(id).na" :key="r.key">
                      <span class="sg-n" :title="r.key"><small v-if="nm(r.key).pre">{{ nm(r.key).pre }}/</small>{{ nm(r.key).name }}</span>
                      <span class="sg-v num">–</span>
                      <span class="sg-b" role="img" :aria-label="`${r.key}: not scored`" />
                    </li>
                  </ul>
                </div>
              </div>
            </template>
          </div>
        </div>
        <template #foot>All bars share one 0-100 axis. n/a until {{ scores.data.minGraded }} graded tasks.</template>
      </BentoCard>

      <BentoCard size="F" title="Agents">
        <p v-if="!rows.length" class="sc-none">No finished tasks recorded yet.</p>
        <div v-else class="sp-fade"><div class="sp-wrap"><table class="sp-t">
          <thead><tr>
            <th scope="col" :aria-sort="aria('agent')" class="stick"><button type="button" @click="setSort('agent')">Agent <Icon v-if="sort.k === 'agent'" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
            <th scope="col" :aria-sort="aria('role')" class="hide-sm"><button type="button" @click="setSort('role')">Role <Icon v-if="sort.k === 'role'" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
            <th v-for="[k, label] in COLS" :key="k" scope="col" :aria-sort="aria(k)" class="num"><button type="button" @click="setSort(k)">{{ label }} <Icon v-if="sort.k === k" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
          </tr></thead>
          <tbody>
            <tr v-for="r in rows" :key="r.agent">
              <th scope="row" class="stick">{{ r.agent }}</th><td class="mut hide-sm">{{ r.role }}</td>
              <td v-for="[k] in COLS" :key="k" :class="['num', { scc: k === 'score' }]"><span v-if="k === 'score'" :class="['pill-s', 'b-' + band(r.score)]" :style="{ '--w': (r.score ?? 0) + '%' }">{{ cell(r, k) === '–' ? 'n/a' : cell(r, k) }}</span><template v-else>{{ cell(r, k) }}</template></td>
            </tr>
          </tbody>
        </table></div></div>
        <template v-if="rows.length > 12" #foot>Showing 12 of {{ rows.length }} agents. Scroll the table for the other {{ rows.length - 12 }}.</template>
      </BentoCard>
    </template>
  </section>
</template>

<style scoped>
.sc{display:grid;gap:10px;min-width:0}
.sc *{min-width:0}
.sc-h{display:flex;align-items:baseline;gap:10px;justify-content:space-between}
.sc h3{margin:0;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.sc-hint{color:var(--muted);font-size:12px}
.sc-none{margin:0;color:var(--muted);font-size:12.5px;line-height:1.4}
.sc-num{font-variant-numeric:tabular-nums}
.sc-top{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:center}
.sc-big{display:grid;place-items:center;align-content:center;gap:2px;width:92px;height:92px;border-radius:50%;border:4px solid var(--c);background:color-mix(in srgb,var(--c) 10%,transparent)}
.sc-big .sc-num{font:800 30px/1 var(--body);color:var(--c)}
.sc-big .sc-num:is(:only-child){font-size:20px;color:var(--muted)}
.sc-band{font:600 10.5px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.b-great{--c:var(--on)} .b-good{--c:color-mix(in srgb,var(--on) 45%,var(--ink))} .b-fair{--c:var(--warn)} .b-poor{--c:var(--bad)} .b-na{--c:var(--off)}
.sc-big.b-na{border-style:dashed}
.sc-kv{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;font-size:12.5px}
.sc-kv dt{color:var(--muted)} .sc-kv dd{margin:0;text-align:right;font-weight:600}
.sc-bars{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.sc-bars li{display:grid;grid-template-columns:104px minmax(0,1fr) 3ch;gap:8px;align-items:center;font-size:12.5px}
.sc-l{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-bar{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.sc-bar i{display:block;height:100%;border-radius:3px;background:var(--c);transition:width .4s var(--ease)}
.sc-v{text-align:right;font:600 12px/1 var(--mono)}
.sc-lh{margin:0 0 6px;color:var(--muted);font-size:12px}
.sc-last ul{list-style:none;margin:0;padding:0;display:grid;gap:7px}
.sc-disc{display:grid;gap:6px}
.sc-row{display:grid;grid-template-columns:minmax(0,1fr) 3ch;gap:8px;align-items:center}
.sc-dn{text-align:right;font:700 13px/1 var(--mono)}
.sc-chk{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 14px;font-size:12px;color:var(--muted)}
.sc-chk li{display:flex;justify-content:space-between;gap:6px}.sc-chk b{color:var(--ink);font-weight:600}
.dc-top{display:grid;grid-template-columns:auto minmax(0,1fr);gap:20px;align-items:end}
.dc-trend{display:flex;align-items:flex-end;gap:3px;height:64px;min-width:0}
.dc-d{flex:1 1 0;max-width:22px;height:100%;display:flex;align-items:flex-end;border-radius:3px;background:var(--track)}
.dc-d i{display:block;width:100%;border-radius:3px;background:var(--c)}
.sc-last li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12.5px;line-height:1.35}
.sc-g{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--c) 18%,transparent);color:var(--c);font:700 12px/1 var(--mono)}
.sc-t{flex:1 1 120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sc-tag{flex:none;padding:1px 6px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:600 10.5px/1.4 var(--mono)}
.sc-tag.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.sc-note{flex:1 0 100%;padding-left:30px;color:var(--muted);overflow-wrap:anywhere}
.sc-last time{flex:none;color:var(--muted);font:500 11px var(--mono)}

/* page tables */
.sp-fade{position:relative}
.sp-fade::after{content:"";position:absolute;top:0;right:0;bottom:0;width:28px;pointer-events:none;background:linear-gradient(90deg,transparent,var(--panel));border-radius:0 12px 12px 0}
.sp-wrap{--rh:41px;overflow:auto;max-height:calc(var(--rh) * 13)}
.sp-t{width:100%;border-collapse:collapse;font-size:13px}
.sp-t th,.sp-t td{height:var(--rh);vertical-align:middle;padding:0 12px;box-sizing:border-box;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}
.sp-t tbody tr:last-child > *{border-bottom:0}
.sp-t thead th{position:sticky;top:0;z-index:2;background:var(--panel);color:var(--muted);font:600 11.5px/1.2 var(--body);letter-spacing:.04em;text-transform:uppercase}
.sp-t thead button{display:inline-flex;align-items:center;gap:3px;min-height:32px;padding:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer}
.sp-t thead button:focus-visible{outline:2px solid var(--on);outline-offset:2px;border-radius:6px}
.sp-t .icon.asc{transform:rotate(180deg)}
.sp-t [aria-sort="ascending"],.sp-t [aria-sort="descending"]{color:var(--ink)}
.sp-t .num{text-align:right;font-variant-numeric:tabular-nums}
.sp-t tbody th{font-weight:600}
.sp-t .stick{position:sticky;left:0;z-index:1;background:var(--panel)}
.sp-t thead .stick{z-index:3}
.sp-t .mut{color:var(--muted)}
.pill-s{display:block;margin-left:auto;width:112px;line-height:22px;padding:0 10px;border-radius:6px;background:linear-gradient(90deg,color-mix(in srgb,var(--c) 30%,transparent) var(--w,0%),color-mix(in srgb,var(--c) 9%,transparent) var(--w,0%));color:var(--ink);font-weight:700;text-align:right}
.bv b.b-great,.bv b.b-good,.bv b.b-fair,.bv b.b-poor,.bv small.b-great,.bv small.b-good,.bv small.b-fair,.bv small.b-poor{color:var(--c)}
.fl{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:20px}
.fl-m{position:relative;padding-bottom:34px;min-width:0}
.fl-k{position:absolute;top:-3px;width:1px;height:16px;background:var(--ink);opacity:.45}
.fl-k em{position:absolute;top:100%;left:0;transform:translateX(-50%);margin-top:5px;font-style:normal;font-size:11px;line-height:1.25;text-align:center;color:var(--muted);opacity:2}
.fl-bar{display:block;height:10px;border-radius:5px;background:var(--track);overflow:hidden}
.fl-bar i{display:block;height:100%;border-radius:5px;background:var(--c);transform-origin:left;animation:sc-grow .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes sc-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.sg-grid{display:grid;gap:16px}
.sg-col{display:none}.sg-col.on{display:block}
.sg-col h3{margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.04em;text-transform:uppercase}
.sg-l{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.sg-n small{color:var(--muted);font:500 11px var(--body)}
.sg-v small{color:var(--muted);font:500 11px var(--body)}
.sg-l li{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n v" "b b";gap:3px 8px;align-items:center}
.sg-n{grid-area:n;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 13px/1.3 var(--body)}
.sg-v{grid-area:v;text-align:right;font:600 12px/1 var(--mono);white-space:nowrap}
.sg-na{margin-top:8px;border-top:1px solid var(--line)}
.sg-nh{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);font:600 12.5px var(--body);text-align:left;cursor:pointer}
.sg-nh:focus-visible{outline:2px solid var(--on);outline-offset:2px;border-radius:8px}
.sg-cv{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}.sg-nh[aria-expanded="true"] .sg-cv{transform:rotate(180deg)}
.sg-nb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.sg-nb.is-open{grid-template-rows:1fr;opacity:1}.sg-nb > ul{overflow:hidden;transition:padding .3s cubic-bezier(.2,.8,.2,1)}.sg-nb.is-open > ul{padding:4px 0 6px}
.sg-b{grid-area:b;height:8px;border-radius:4px;background:var(--track);overflow:hidden}
.sg-b i{display:block;height:100%;border-radius:4px;background:var(--c);transform-origin:left;animation:sc-grow .45s cubic-bezier(.2,.8,.2,1) both}
@media (min-width:1280px){.sg-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.sg-col{display:block}.sg :deep(.sp-seg){display:none}}
.sp-seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.sp-seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer}
.sp-seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}
.sp-seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
@media (max-width:767px){.sp-t .hide-sm{display:none}}
@media (prefers-reduced-motion:reduce){.sg-nb,.sg-cv,.sg-nb > ul{transition:none}.sc-bar i{transition:none}.fl-bar i,.sg-b i{animation:none}}
@media (max-width:420px){.sc-bars li{grid-template-columns:88px minmax(0,1fr) 3ch}.sc-big{width:80px;height:80px}.sc-big .sc-num{font-size:26px}}
</style>
