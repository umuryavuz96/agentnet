<script setup lang="ts">
// Usage as a bento: hero (plan use, mode, reset), two S tiles (5-hour rolling sum, top agent), then "Who used it".
// Data: the same usage feed the Agents panel uses, plus the mode and its thresholds from GET v1/panel/routing (read only).
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import AgentnetUsage from "../components/AgentnetUsage.vue";
import BentoCard from "../ui/BentoCard.vue";
import { api } from "../ui/api";
import { net, usage, useUsage, worked } from "../net";

const stop = useUsage();
onBeforeUnmount(stop);
const win = ref<"fiveHour" | "weekly">("weekly");
const WINS = [["fiveHour", "5 hours"], ["weekly", "Week"]] as const;

interface Mode { mode: string; thresholds: { careful: number; eco: number; reserve: number } }
const mode = ref<Mode | null>(null);
onMounted(async () => { try { mode.value = (await api<{ mode: Mode }>("v1/panel/routing")).mode; } catch { mode.value = null; } });

const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const dur = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const d = computed(() => usage.data);
const pct = computed(() => d.value?.windows.weekly.accountPct ?? null);
const reset = computed(() => { const t = d.value?.windows.weekly.resetsAt ? Date.parse(d.value.windows.weekly.resetsAt) : NaN; return Number.isFinite(t) ? dur(t - net.now) : null; });
const ticks = computed(() => (mode.value ? Object.entries(mode.value.thresholds) : []));
const title = computed(() => (pct.value == null ? "Plan usage" : `Week at ${Math.round(pct.value)}% of plan`));
const five = computed(() => (d.value?.agents ?? []).reduce((s, a) => s + worked(a.fiveHour), 0));
const top = computed(() => {
  const l = (d.value?.agents ?? []).map((a) => ({ n: a.agent, w: worked(a[win.value]) })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  const sum = l.reduce((s, x) => s + x.w, 0);
  return l.length ? { name: l[0].n, share: Math.round((l[0].w / sum) * 100) } : null;
});
</script>

<template>
  <section class="page">
    <header class="ph"><h1>Usage</h1></header>
    <div class="bento bento-2">
      <BentoCard size="H" :title="title">
        <div v-if="pct != null" class="uh">
          <div class="bv"><b class="num">{{ Math.round(pct) }}</b><small>%</small></div>
          <div class="um">
            <div class="ut" role="meter" aria-label="Weekly plan used" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="`${Math.round(pct)} percent of the weekly plan${mode ? ', mode ' + mode.mode + '; careful from ' + mode.thresholds.careful + ', eco from ' + mode.thresholds.eco + ', reserve from ' + mode.thresholds.reserve : ''}`">
              <i :class="{ hot: pct > 90 }" :style="{ width: Math.min(100, pct) + '%' }" />
              <span v-for="[k, t] in ticks" :key="k" class="uk" :style="{ left: t + '%' }"><em class="num">{{ k }}<br />{{ t }}</em></span>
            </div>
          </div>
        </div>
        <p v-else-if="usage.err && !d" class="bn">Usage not available ({{ usage.err }}).</p>
        <p v-else-if="!d" class="bn">Loading…</p>
        <p v-else class="bn">–  Plan share unknown: the plan reported no weekly percentage.</p>
        <template #foot>
          <span v-if="mode">Mode <b class="uw">{{ mode.mode }}</b></span><span v-if="reset"> · resets in {{ reset }}</span>
        </template>
      </BentoCard>
      <BentoCard size="S" title="5 hours rolling">
        <div v-if="d" class="bv"><b class="num">{{ tok(five) }}</b><small>tokens</small></div>
        <p v-else class="bn">–</p>
        <template #foot>No 5-hour limit on this plan</template>
      </BentoCard>
      <BentoCard size="S" :title="win === 'weekly' ? 'Top agent, week' : 'Top agent, 5 h'">
        <div v-if="top" class="bv"><b class="ut-n">{{ top.name }}</b></div>
        <p v-else class="bn">– No agent work in this window.</p>
        <template v-if="top" #foot>{{ top.share }}% of tracked work</template>
      </BentoCard>
      <BentoCard size="F" title="Who used it" tall>
        <template #control>
          <div class="au-seg" role="tablist" aria-label="Usage window">
            <button v-for="[id, label] in WINS" :key="id" type="button" role="tab" :aria-selected="win === id" :class="{ on: win === id }" @click="win = id">{{ label }}</button>
          </div>
        </template>
        <AgentnetUsage v-model:win="win" bare />
        <template #foot>Share of tracked agents' input + output tokens. Cache reads are not counted.</template>
      </BentoCard>
    </div>
  </section>
</template>

<style scoped>
.au-seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.au-seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.au-seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}
.au-seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.au-seg button{transition:none}}
.uh{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:20px}
.um{min-width:0;padding:0 4px 34px}
.ut{position:relative;height:10px;border-radius:5px;background:var(--track)}
.ut i{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--on);transform-origin:left;animation:ut-grow .45s cubic-bezier(.2,.8,.2,1) both;transition:width .45s cubic-bezier(.2,.8,.2,1)}
.ut i.hot{background:var(--bad)}
.uk{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--ink);opacity:.45}
.uk em{position:absolute;top:100%;left:0;transform:translateX(-50%);margin-top:5px;font-style:normal;font-size:11px;line-height:1.25;text-align:center;color:var(--muted)}
.uw{color:var(--ink);text-transform:capitalize}
.ut-n{font:700 28px/1.1 var(--body);overflow-wrap:anywhere}
@keyframes ut-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@media (prefers-reduced-motion:reduce){.ut i{animation:none;transition:none}}
@media (max-width:420px){.uh{grid-template-columns:minmax(0,1fr);gap:12px}}
</style>
