<script setup lang="ts">
// Trails page (bento):  is the trail RAG used? Calls per day, inject rate, search hit rate, used rate (a hit counts as used when the
// agent touches one of its files or names its commit/note within 30 min), top queries, per agent, and the latest hits with their used flag.
// Data: GET /agentnet-panel/trails/stats (panel auth), polled every 15 s while open.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../ui/api";
import BentoCard from "../ui/BentoCard.vue";

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
const dayLabel = (s: string) => new Date(s + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric" });
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const since = computed(() => { const f = (d.value?.days ?? []).find((x) => x.searches + x.injects > 0); return f ? new Date(f.day + "T12:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : ""; });
const peak = computed(() => (d.value?.days ?? []).reduce((m, x) => Math.max(m, x.searches + x.injects), 0));
/** A hit younger than 30 min cannot be judged yet. */
const state = (x: { ts: string; used: boolean | null }) => (x.used === false && Date.now() - new Date(x.ts).getTime() < 30 * 60000 ? "pending" : x.used === true ? "used" : x.used === false ? "unused" : "n/a");
const time = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const SRC: Record<string, string> = { trail_search: "search", task_add: "inject · task", task_msg: "inject · msg", spawn: "inject · spawn" };
const CLS: Record<string, string> = { used: "yes", unused: "no", pending: "na", "n/a": "na" };
const TIP: Record<string, string> = { used: "The agent touched a hit file or commit within 30 min", unused: "No follow-up on any hit within 30 min", pending: "Younger than 30 min, not decided yet", "n/a": "Cannot tell (no file or commit to match)" };
const empty = computed(() => d.value && !d.value.totals.searches && !d.value.totals.injects);
</script>

<template>
  <section class="bento bento-2" aria-label="Trails usage">
    <BentoCard v-if="!d" size="F" title="Trails"><p class="trl-none">{{ err ? `Trail stats not available (${err}).` : "Loading…" }}</p></BentoCard>
    <template v-else>
      <BentoCard size="S" title="Calls">
        <div class="bv"><b class="num">{{ d.totals.searches + d.totals.injects }}</b></div>
        <template #foot>{{ d.totals.searches }} searches · {{ d.totals.injects }} injects</template>
      </BentoCard>
      <BentoCard size="S" title="Inject rate">
        <div class="bv"><b class="num">{{ pct(d.totals.injectRate) }}</b></div>
        <template #foot>{{ d.totals.injects ? `${d.totals.injected} of ${d.totals.injects} had a hit` : "No injections logged yet" }}</template>
      </BentoCard>
      <BentoCard size="S" title="Search hit rate">
        <div class="bv"><b class="num">{{ pct(d.totals.searchHitRate) }}</b></div>
        <template #foot>{{ d.totals.searches ? `of ${d.totals.searches} searches` : "No agent searches yet" }}</template>
      </BentoCard>
      <BentoCard size="S" title="Agents using trails">
        <div class="bv"><b class="num">{{ d.agents.length }}</b></div>
        <template #foot>In the last {{ d.days.length }} days</template>
      </BentoCard>

      <BentoCard size="W" :title="`Calls per day, last ${d.days.length} days`">
        <p v-if="empty" class="trl-none">– No trail searches or injections logged yet.</p>
        <div v-else class="trl-days" role="img" :aria-label="`Calls per day, last ${d.days.length} days: ${d.days.map((x) => `${dayLabel(x.day)} ${x.searches + x.injects}`).join(', ')}`">
          <div v-for="x in d.days" :key="x.day" class="trl-d" :class="{ now: x.day === today }" role="img" :aria-label="`${dayLabel(x.day)}${x.day === today ? ', today' : ''}: ${x.searches} searches, ${x.injects} injects`" :title="`${x.day}: ${x.searches} searches, ${x.injects} injects`">
            <span class="trl-n num">{{ x.searches + x.injects === peak ? peak : "" }}</span>
            <span class="trl-col"><i class="inj" :style="{ height: (x.injects / max) * 100 + '%' }" /><i class="sea" :style="{ height: (x.searches / max) * 100 + '%' }" /></span>
            <span class="trl-dl">{{ x.day === today ? "Today" : dayLabel(x.day) }}</span>
          </div>
        </div>
        <template #foot><span class="trl-key"><span class="num">max {{ peak }}</span><i class="inj" /> injected at new work <i class="sea" /> agent searches</span><span v-if="since" class="trl-since">Data since {{ since }}</span></template>
      </BentoCard>
      <BentoCard size="M" title="Used rate">
        <div class="bv"><b class="num">{{ pct(d.totals.usedRate) }}</b><small>of hits used</small></div>
        <span v-if="d.totals.usedRate != null" class="trl-m" role="img" :aria-label="`${pct(d.totals.usedRate)} of checkable hits were used`"><i :style="{ width: d.totals.usedRate * 100 + '%' }" /></span>
        <p v-else class="trl-none">– Needs hits with a file or commit to match.</p>
        <ul v-if="d.totals.checkable" class="trl-uc"><li><span>Used</span><b class="num">{{ d.totals.used }}</b></li><li><span>Not used</span><b class="num">{{ d.totals.checkable - d.totals.used }}</b></li></ul>
        <template #foot>{{ d.totals.used }} of {{ d.totals.checkable }} checkable hits. Used = the agent touched a hit file or named its commit or note within 30 min.</template>
      </BentoCard>

      <BentoCard size="L" title="Top queries" class="trl-top">
        <p v-if="!d.topQueries.length" class="trl-none">– No agent searches yet.</p>
        <ul v-else class="trl-q" tabindex="0"><li v-for="q in d.topQueries" :key="q.query"><span class="trl-qt" :title="q.query">{{ q.query }}</span><b>{{ q.n }}</b></li></ul>
      </BentoCard>
      <BentoCard size="L" title="Per agent">
        <p v-if="!d.agents.length" class="trl-none">– No agent has used trails yet.</p>
        <div v-else class="trl-tw" tabindex="0" role="group" aria-label="Per agent table"><table class="trl-t"><thead><tr><th>Agent</th><th>Searches</th><th>Injected</th><th>Used</th></tr></thead>
          <tbody><tr v-for="a in d.agents" :key="a.agent"><td class="trl-qt" :title="a.agent">{{ a.agent }}</td><td class="num">{{ a.searches }}</td><td class="num">{{ a.injected }}/{{ a.injects }}</td><td class="num">{{ a.checkable ? Math.round((a.used / a.checkable) * 100) + "%" : "–" }}</td></tr></tbody></table></div>
      </BentoCard>

      <BentoCard size="F" title="Latest hits" tall>
        <p v-if="!d.latest.length" class="trl-none">– No hits yet.</p>
        <ul v-else class="trl-lt" tabindex="0">
          <li v-for="(x, i) in d.latest" :key="x.ts + i">
            <span :class="['trl-u', CLS[state(x)]]" :title="TIP[state(x)]">{{ state(x) }}</span>
            <span class="trl-lq" :title="x.query">{{ x.query }}</span>
            <span class="trl-lm">{{ x.agent }} · {{ SRC[x.source] ?? x.source }} · {{ x.hits.length }} {{ x.hits.length === 1 ? "hit" : "hits" }}{{ x.ms != null ? ` · ${x.ms} ms` : "" }} · {{ time(x.ts) }}</span>
          </li>
        </ul>
        <template v-if="d.latest.length > 8" #foot>Newest 8 shown, scroll for {{ d.latest.length - 8 }} more</template>
      </BentoCard>
    </template>
  </section>
</template>

<style scoped>
.trl-top{align-self:start}
.trl-none{margin:0;color:var(--muted);font-size:13px}
.trl-days{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px;align-items:end;height:160px}
.trl-d{display:grid;grid-template-rows:auto 1fr auto;gap:4px;height:100%}
.trl-col{position:relative;display:flex;flex-direction:column-reverse;justify-content:flex-start;gap:2px;border-radius:6px;background:var(--track);overflow:hidden}
.trl-col i{display:block;width:100%;min-height:0;transform-origin:bottom;animation:trl-grow .45s cubic-bezier(.2,.8,.2,1) both}
.trl-col .sea,.trl-key .sea{background:var(--ink)}
.trl-col .inj,.trl-key .inj{background:color-mix(in srgb,var(--ink) 40%,var(--panel))}
.trl-n{min-height:14px;text-align:center;font:700 11px var(--mono)}
.trl-d.now .trl-dl{color:var(--ink);font-weight:700}
.trl-since{margin-left:auto;color:var(--muted)}
.trl-uc{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:4px;font-size:13px}
.trl-uc li{display:flex;justify-content:space-between}
.trl-tw{max-height:304px;overflow:auto}
.trl-t th{position:sticky;top:0;background:var(--panel)}
.trl-t{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
.trl-t th{text-align:right;color:var(--muted);font:600 11px var(--body);padding:0 0 6px}
.trl-t th:first-child,.trl-t td:first-child{text-align:left;width:40%}
.trl-t td{text-align:right;padding:6px 0;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.trl-t td.trl-qt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trl-dl{text-align:center;color:var(--muted);font-size:11px}
.trl-key{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.trl-key i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-left:8px}
.trl-key i:first-child{margin-left:0}
.trl-m{display:block;height:10px;border-radius:5px;background:var(--track);overflow:hidden;margin-top:10px}
.trl-m i{display:block;height:100%;border-radius:5px;background:var(--on);transform-origin:left;animation:trl-growx .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes trl-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes trl-growx{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.trl-q{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:13px;max-height:304px;overflow:auto;align-content:start}
.trl-q li{display:flex;gap:10px;align-items:baseline;min-width:0}
.trl-qt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trl-q b,.trl-am{flex:none;color:var(--muted);font:600 12px var(--mono);font-variant-numeric:tabular-nums}
.trl-lt{list-style:none;margin:0;padding:0;display:grid;gap:8px;max-height:520px;overflow:auto;align-content:start}
.trl-lt li{height:62px;box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;align-items:baseline;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.trl-u{grid-row:span 2;align-self:start;padding:2px 8px;border-radius:999px;font:700 11px/1.5 var(--body);border:1px solid var(--line);color:var(--muted)}
.trl-u.yes{color:color-mix(in srgb,var(--on) 45%,var(--ink));border-color:color-mix(in srgb,var(--on) 55%,transparent);background:color-mix(in srgb,var(--on) 12%,transparent)}
.trl-u.no{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.trl-lq{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.trl-lm{min-width:0;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (prefers-reduced-motion:reduce){.trl-col i,.trl-m i{animation:none}}
</style>
