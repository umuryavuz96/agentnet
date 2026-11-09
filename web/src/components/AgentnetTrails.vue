<script setup lang="ts">
// "Trails" panel under Agents > Usage: is the trail RAG used? Calls per day, inject rate, search hit rate, used rate (a hit counts as used when the
// agent touches one of its files or names its commit/note within 30 min), top queries, per agent, and the latest hits with their used flag.
// Data: GET /agentnet-panel/trails/stats (panel auth), polled every 15 s while open.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../ui/api";

interface Stats {
  days: { day: string; searches: number; injects: number }[];
  totals: { searches: number; injects: number; injected: number; injectRate: number | null; searchHitRate: number | null; used: number; checkable: number; usedRate: number | null };
  topQueries: { query: string; n: number }[];
  agents: { agent: string; searches: number; injects: number; injected: number; used: number; checkable: number }[];
  latest: { ts: string; agent: string; source: string; query: string; hits: string[]; used: boolean | null; ms: number | null }[];
}
const d = ref<Stats | null>(null), err = ref("");
async function load() { try { d.value = await api<Stats>("v1/panel/trails/stats?days=14"); err.value = ""; } catch (e) { err.value = (e as Error).message; } }
let t: ReturnType<typeof setInterval> | null = null;
onMounted(() => { void load(); t = setInterval(() => { if (!document.hidden) void load(); }, 15000); });
onBeforeUnmount(() => { if (t) clearInterval(t); });

const pct = (x: number | null) => (x == null ? "–" : Math.round(x * 100) + "%");
const max = computed(() => Math.max(1, ...(d.value?.days ?? []).map((x) => x.searches + x.injects)));
const dayLabel = (s: string) => new Date(s + "T12:00:00").toLocaleDateString([], { weekday: "short" });
const time = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const SRC: Record<string, string> = { trail_search: "search", task_add: "inject · task", task_msg: "inject · msg", spawn: "inject · spawn" };
const empty = computed(() => d.value && !d.value.totals.searches && !d.value.totals.injects);
</script>

<template>
  <section class="trl" aria-label="Trails usage">
    <div class="trl-h"><h3>Trails <small>is the RAG used?</small></h3></div>
    <p v-if="err && !d" class="trl-none">Trail stats not available ({{ err }}).</p>
    <p v-else-if="!d" class="trl-none">Loading…</p>
    <p v-else-if="empty" class="trl-none">No trail searches or injections logged yet.</p>
    <template v-else-if="d">
      <div class="trl-tiles">
        <div class="trl-t"><span class="trl-l">Calls</span><b class="trl-n">{{ d.totals.searches + d.totals.injects }}</b><span class="trl-s">{{ d.totals.searches }} searches · {{ d.totals.injects }} injects</span></div>
        <div class="trl-t"><span class="trl-l">Inject rate</span><b class="trl-n">{{ pct(d.totals.injectRate) }}</b><span class="trl-s">{{ d.totals.injected }} of {{ d.totals.injects }} had a hit</span></div>
        <div class="trl-t"><span class="trl-l">Search hit rate</span><b class="trl-n">{{ pct(d.totals.searchHitRate) }}</b><span class="trl-s">of {{ d.totals.searches }} searches</span></div>
        <div class="trl-t"><span class="trl-l">Used rate</span><b class="trl-n">{{ pct(d.totals.usedRate) }}</b><span class="trl-s">{{ d.totals.used }} of {{ d.totals.checkable }} checkable hits</span></div>
      </div>

      <div class="trl-days" role="img" :aria-label="`Calls per day, last ${d.days.length} days`">
        <div v-for="x in d.days" :key="x.day" class="trl-d" :title="`${x.day}: ${x.searches} searches, ${x.injects} injects`">
          <span class="trl-col"><i class="inj" :style="{ height: (x.injects / max) * 100 + '%' }" /><i class="sea" :style="{ height: (x.searches / max) * 100 + '%' }" /></span>
          <span class="trl-dl">{{ dayLabel(x.day) }}</span>
        </div>
      </div>
      <p class="trl-key"><i class="inj" /> injected at new work <i class="sea" /> agent searches</p>

      <div class="trl-two">
        <section aria-label="Top queries">
          <h4>Top queries</h4>
          <p v-if="!d.topQueries.length" class="trl-none">No agent searches yet.</p>
          <ul v-else class="trl-q"><li v-for="q in d.topQueries" :key="q.query"><span class="trl-qt" :title="q.query">{{ q.query }}</span><b>{{ q.n }}</b></li></ul>
        </section>
        <section aria-label="Per agent">
          <h4>Per agent</h4>
          <ul class="trl-q"><li v-for="a in d.agents" :key="a.agent"><span class="trl-qt">{{ a.agent }}</span><span class="trl-am">{{ a.searches }}s · {{ a.injected }}/{{ a.injects }}i · used {{ a.checkable ? Math.round((a.used / a.checkable) * 100) + "%" : "–" }}</span></li></ul>
        </section>
      </div>

      <section aria-label="Latest hits">
        <h4>Latest hits</h4>
        <p v-if="!d.latest.length" class="trl-none">No hits yet.</p>
        <ul v-else class="trl-lt">
          <li v-for="(x, i) in d.latest" :key="x.ts + i">
            <span :class="['trl-u', x.used === true ? 'yes' : x.used === false ? 'no' : 'na']" :title="x.used === true ? 'The agent touched a hit file or commit within 30 min' : x.used === false ? 'No follow-up on any hit within 30 min' : 'Cannot tell (no file or commit to match)'">{{ x.used === true ? "used" : x.used === false ? "unused" : "n/a" }}</span>
            <span class="trl-lq" :title="x.query">{{ x.query }}</span>
            <span class="trl-lm">{{ x.agent }} · {{ SRC[x.source] ?? x.source }} · {{ x.hits.length }} {{ x.hits.length === 1 ? "hit" : "hits" }}{{ x.ms != null ? ` · ${x.ms} ms` : "" }} · {{ time(x.ts) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.trl{display:grid;gap:14px;min-width:0}
.trl *{min-width:0}
.trl-h h3{margin:0;color:var(--ink);font:700 16px/1.2 var(--body);text-transform:none}
.trl-h small{margin-left:6px;color:var(--muted);font:500 12.5px var(--body)}
.trl-none{margin:0;color:var(--muted);font-size:13px}
.trl-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.trl-t{display:grid;gap:3px;align-content:start;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.trl-l{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.trl-n{font:700 20px/1.2 var(--body);font-variant-numeric:tabular-nums}
.trl-s{color:var(--muted);font-size:12px;line-height:1.3}
.trl-days{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px;align-items:end;height:96px}
.trl-d{display:grid;grid-template-rows:1fr auto;gap:4px;height:100%}
.trl-col{position:relative;display:flex;flex-direction:column-reverse;justify-content:flex-start;border-radius:6px;background:var(--track);overflow:hidden}
.trl-col i{display:block;width:100%;min-height:0}
.trl-col .sea,.trl-key .sea{background:var(--on)}
.trl-col .inj,.trl-key .inj{background:color-mix(in srgb,var(--on) 38%,var(--panel))}
.trl-dl{text-align:center;color:var(--muted);font-size:11px}
.trl-key{display:flex;align-items:center;gap:6px;margin:0;color:var(--muted);font-size:12px}
.trl-key i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-left:8px}
.trl-key i:first-child{margin-left:0}
.trl-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
h4{margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.trl-q{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:13px}
.trl-q li{display:flex;gap:10px;align-items:baseline}
.trl-qt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trl-q b,.trl-am{flex:none;color:var(--muted);font:600 12px var(--mono);font-variant-numeric:tabular-nums}
.trl-lt{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.trl-lt li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;align-items:baseline;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 3%,transparent)}
.trl-u{grid-row:span 2;align-self:start;padding:2px 8px;border-radius:999px;font:700 11px/1.5 var(--body);border:1px solid var(--line);color:var(--muted)}
.trl-u.yes{color:var(--on);border-color:color-mix(in srgb,var(--on) 55%,transparent);background:color-mix(in srgb,var(--on) 12%,transparent)}
.trl-u.no{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.trl-lq{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.trl-lm{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:700px){.trl-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.trl-two{grid-template-columns:1fr}}
</style>
