<script setup lang="ts">
// Agent scorecard (docs/agent-score.md). Two shapes of one component:
//  - with `only`: the compact Score block of the side panel (big number, five sub-score bars, cost per task, last 5 grades);
//  - without: the Scores section of the Agents page (sortable agent table + the by role / model / soul table for self-improvement).
// Every number comes from the server; "n/a" until the agent has the minimum number of graded tasks.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { fetchAgentScore, scores, useScores, type AgentScore, type ScoreBase, type SubScores } from "../net";

const props = defineProps<{ only?: string }>();

const SUBS: [keyof SubScores, string, string][] = [
  ["quality", "Quality", "Mean root grade, 1-5 mapped to 0-100"],
  ["firstTimeRight", "First-time-right", "Rounds the owner needed before it was right: 0 = 100, 1 = 70, 2 = 45, 3 = 25, 4+ = 10"],
  ["efficiency", "Efficiency", "Cost per task against the role's median: cheaper is higher"],
  ["reliability", "Reliability", "Task list kept first, started and finished promptly, decision notes filled"],
  ["rework", "No rework", "Share of graded tasks root did not have to send back"],
];
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
type Key = "agent" | "role" | "score" | "quality" | "firstTimeRight" | "efficiency" | "reliability" | "rework" | "tasks" | "cost" | "rounds";
const sort = ref<{ k: Key; dir: 1 | -1 }>({ k: "score", dir: -1 });
const val = (r: ScoreBase & { agent?: string; role?: string }, k: Key): number | string | null =>
  k === "agent" ? r.agent ?? "" : k === "role" ? r.role ?? "" : k === "score" ? r.score : k === "tasks" ? r.tasks : k === "cost" ? r.costPerTask : k === "rounds" ? r.avgRounds : r.sub[k];
const rows = computed(() => {
  const { k, dir } = sort.value, list = [...(scores.data?.agents ?? [])];
  return list.sort((a, b) => { const x = val(a, k), y = val(b, k); if (x == null && y == null) return a.agent.localeCompare(b.agent); if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number)) * dir || a.agent.localeCompare(b.agent); });
});
const setSort = (k: Key) => { sort.value = sort.value.k === k ? { k, dir: (sort.value.dir * -1) as 1 | -1 } : { k, dir: k === "agent" || k === "role" ? 1 : -1 }; };
const aria = (k: Key) => (sort.value.k === k ? (sort.value.dir === 1 ? "ascending" : "descending") : "none");
const COLS: [Key, string][] = [["score", "Score"], ["quality", "Quality"], ["firstTimeRight", "First-time"], ["efficiency", "Effic."], ["reliability", "Reliab."], ["rework", "No rework"], ["tasks", "Tasks"], ["cost", "$/task"], ["rounds", "Rounds"]];
const cell = (r: ScoreBase, k: Key) => (k === "score" ? pt(r.score) : k === "tasks" ? `${r.graded}/${r.tasks}` : k === "cost" ? usd(r.costPerTask) : k === "rounds" ? rounds(r.avgRounds) : pt(r.sub[k as keyof SubScores]));
const GROUPS = [["byRole", "Role"], ["byModel", "Model"], ["bySoul", "Soul"]] as const;
const grp = ref<(typeof GROUPS)[number][0]>("byRole");
const groupRows = computed(() => scores.data?.[grp.value] ?? []);
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
      <div v-if="one.last.length" class="sc-last">
        <p class="sc-lh">Last {{ one.last.length }} {{ one.last.length === 1 ? "grade" : "grades" }}<span v-if="one.lastAvgRounds != null"> · avg rounds {{ rounds(one.lastAvgRounds) }}</span></p>
        <ul>
          <li v-for="g in one.last" :key="g.id">
            <span :class="['sc-g', 'b-' + band(g.grade == null ? null : (g.grade - 1) * 25)]" :aria-label="`Grade ${g.grade} of 5`">{{ g.grade }}</span>
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

  <!-- page: sortable agents + role/model/soul -->
  <section v-else class="sp" aria-label="Agent scores">
    <p v-if="scores.err && !scores.data" class="sc-none">Scores not available ({{ scores.err }}).</p>
    <p v-else-if="!scores.data" class="sc-none">Loading…</p>
    <template v-else>
      <p class="sc-none">Score 0-100 from five parts: quality {{ scores.data.weights.quality }}, first-time-right {{ scores.data.weights.firstTimeRight }}, efficiency {{ scores.data.weights.efficiency }}, reliability {{ scores.data.weights.reliability }}, no rework {{ scores.data.weights.rework }}. n/a below {{ scores.data.minGraded }} graded tasks.</p>
      <h3>Agents</h3>
      <p v-if="!rows.length" class="sc-none">No finished tasks recorded yet.</p>
      <div v-else class="sp-wrap"><table class="sp-t">
        <thead><tr>
          <th scope="col" :aria-sort="aria('agent')" class="stick"><button type="button" @click="setSort('agent')">Agent <Icon v-if="sort.k === 'agent'" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
          <th scope="col" :aria-sort="aria('role')"><button type="button" @click="setSort('role')">Role <Icon v-if="sort.k === 'role'" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
          <th v-for="[k, label] in COLS" :key="k" scope="col" :aria-sort="aria(k)" class="num"><button type="button" @click="setSort(k)">{{ label }} <Icon v-if="sort.k === k" :class="{ asc: sort.dir === 1 }" name="chevron-down" :size="13" /></button></th>
        </tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.agent">
            <th scope="row" class="stick">{{ r.agent }}</th><td class="mut">{{ r.role }}</td>
            <td v-for="[k] in COLS" :key="k" :class="['num', { sc: k === 'score' }]"><span v-if="k === 'score'" :class="['pill-s', 'b-' + band(r.score)]">{{ cell(r, k) === '–' ? 'n/a' : cell(r, k) }}</span><template v-else>{{ cell(r, k) }}</template></td>
          </tr>
        </tbody>
      </table></div>

      <div class="sp-gh"><h3>By</h3>
        <div class="sp-seg" role="tablist" aria-label="Group by">
          <button v-for="[id, label] in GROUPS" :key="id" type="button" role="tab" :aria-selected="grp === id" :class="{ on: grp === id }" @click="grp = id">{{ label }}</button>
        </div>
      </div>
      <p v-if="!groupRows.length" class="sc-none">Nothing to group yet.</p>
      <div v-else class="sp-wrap"><table class="sp-t">
        <thead><tr><th scope="col" class="stick">{{ GROUPS.find((g) => g[0] === grp)![1] }}</th><th v-for="[k, label] in COLS" :key="k" scope="col" class="num">{{ label }}</th></tr></thead>
        <tbody>
          <tr v-for="r in groupRows" :key="r.key">
            <th scope="row" class="stick" :title="r.key">{{ r.key }}</th>
            <td v-for="[k] in COLS" :key="k" :class="['num', { sc: k === 'score' }]"><span v-if="k === 'score'" :class="['pill-s', 'b-' + band(r.score)]">{{ cell(r, k) === '–' ? 'n/a' : cell(r, k) }}</span><template v-else>{{ cell(r, k) }}</template></td>
          </tr>
        </tbody>
      </table></div>
    </template>
  </section>
</template>

<style scoped>
.sc,.sp{display:grid;gap:10px;min-width:0}
.sc *,.sp *{min-width:0}
.sc-h{display:flex;align-items:baseline;gap:10px;justify-content:space-between}
.sc h3,.sp h3{margin:0;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.sc-hint{color:var(--muted);font-size:12px}
.sc-none{margin:0;color:var(--muted);font-size:12.5px;line-height:1.4}
.sc-num{font-variant-numeric:tabular-nums}
.sc-top{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:center}
.sc-big{display:grid;place-items:center;align-content:center;gap:2px;width:92px;height:92px;border-radius:50%;border:4px solid var(--c);background:color-mix(in srgb,var(--c) 10%,transparent)}
.sc-big .sc-num{font:800 30px/1 var(--body);color:var(--c)}
.sc-big .sc-num:is(:only-child){font-size:20px;color:var(--muted)}
.sc-band{font:600 10.5px/1 var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--c)}
.b-great{--c:var(--on)} .b-good{--c:color-mix(in srgb,var(--on) 55%,var(--warn))} .b-fair{--c:var(--warn)} .b-poor{--c:var(--bad)} .b-na{--c:var(--off)}
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
.sc-last li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:12.5px;line-height:1.35}
.sc-g{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--c) 18%,transparent);color:var(--c);font:700 12px/1 var(--mono)}
.sc-t{flex:1 1 120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.sc-tag{flex:none;padding:1px 6px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font:600 10.5px/1.4 var(--mono)}
.sc-tag.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.sc-note{flex:1 0 100%;padding-left:30px;color:var(--muted);overflow-wrap:anywhere}
.sc-last time{flex:none;color:var(--muted);font:500 11px var(--mono)}

/* page tables */
.sp h3{margin-top:6px}
.sp-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 3%,transparent)}
.sp-t{width:100%;border-collapse:collapse;font-size:13px}
.sp-t th,.sp-t td{padding:9px 12px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}
.sp-t tbody tr:last-child > *{border-bottom:0}
.sp-t thead th{color:var(--muted);font:600 11.5px/1.2 var(--body);letter-spacing:.04em;text-transform:uppercase}
.sp-t thead button{display:inline-flex;align-items:center;gap:3px;min-height:32px;padding:0;border:0;background:transparent;color:inherit;font:inherit;letter-spacing:inherit;text-transform:inherit;cursor:pointer}
.sp-t thead button:focus-visible{outline:2px solid var(--on);outline-offset:2px;border-radius:6px}
.sp-t .icon.asc{transform:rotate(180deg)}
.sp-t [aria-sort="ascending"],.sp-t [aria-sort="descending"]{color:var(--ink)}
.sp-t .num{text-align:right;font-variant-numeric:tabular-nums}
.sp-t tbody th{font-weight:600}
.sp-t .stick{position:sticky;left:0;z-index:1;background:color-mix(in srgb,var(--bg,#101014) 88%,var(--ink))}
.sp-t .mut{color:var(--muted)}
.pill-s{display:inline-block;min-width:3.2ch;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--c) 16%,transparent);color:var(--c);font-weight:700;text-align:center}
.sp-gh{display:flex;align-items:center;gap:10px;margin-top:8px}
.sp-gh h3{margin:0}
.sp-seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.sp-seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer}
.sp-seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}
.sp-seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.sc-bar i{transition:none}}
@media (max-width:420px){.sc-bars li{grid-template-columns:88px minmax(0,1fr) 3ch}.sc-big{width:80px;height:80px}.sc-big .sc-num{font-size:26px}}
</style>
