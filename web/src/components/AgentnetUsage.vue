<script setup lang="ts">
// "Who used it": per-agent token use for the rolling 5-hour window and the weekly window, as ranked bars.
// The bar is the agent's share of all tracked agents' work (input + output tokens). This plan has no 5-hour limit, so that
// window shows a rolling sum only; the weekly window shows the account percentage the plan reports.
import { computed, onBeforeUnmount, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { net, usage, useUsage, worked, type UsageAgent } from "../net";

const props = defineProps<{ compact?: boolean; only?: string; bare?: boolean }>();
const stop = useUsage();
onBeforeUnmount(stop);
/** The window is a model so a bento page can put the switch in its card header; alone it keeps its own state. */
const win = defineModel<"fiveHour" | "weekly">("win", { default: "weekly" });
const WINS = [["fiveHour", "5 hours"], ["weekly", "Week"]] as const;

const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const dur = (ms: number) => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const d = computed(() => usage.data);
const rows = computed(() => {
  const list = (d.value?.agents ?? []).map((a) => ({ a, n: worked(a[win.value]) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
  const total = list.reduce((s, x) => s + x.n, 0) || 1;
  return list.map((x) => ({ ...x, share: (x.n / total) * 100 }));
});
const shown = computed(() => (props.only ? rows.value.filter((r) => r.a.agent === props.only) : rows.value.filter((r) => r.share >= FOLD)));
/** Rows under 2% (old test agents) fold into one "Other" row that opens on tap. Not applied to a single-agent view. */
const FOLD = 2;
const small = computed(() => (props.only ? [] : rows.value.filter((r) => r.share < FOLD)));
const smallSum = computed(() => small.value.reduce((s, r) => s + r.n, 0));
const smallShare = computed(() => small.value.reduce((s, r) => s + r.share, 0));
const openOther = ref(false);
const winInfo = computed(() => d.value?.windows[win.value] ?? null);
const head = computed(() => {
  const w = winInfo.value; if (!w) return "";
  if (win.value === "weekly") { const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN; return `${w.accountPct != null ? Math.round(w.accountPct) + "% of the plan used" : "plan share unknown"}${Number.isFinite(t) ? " · resets in " + dur(t - net.now) : ""}`; }
  return "No 5-hour limit on this plan · rolling sum";
});
const turns = (a: UsageAgent) => a[win.value].turns;
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
</script>

<template>
  <section :class="['au', { compact }]" aria-label="Usage by agent">
    <div v-if="!bare" class="au-h">
      <h3>Who used it</h3>
      <div class="au-seg" role="tablist" aria-label="Usage window">
        <button v-for="[id, label] in WINS" :key="id" type="button" role="tab" :aria-selected="win === id" :class="{ on: win === id }" @click="win = id">{{ label }}</button>
      </div>
    </div>
    <p v-if="!bare" class="au-sub">{{ head }}</p>
    <p v-if="usage.err && !d" class="au-none">Usage not available ({{ usage.err }}).</p>
    <p v-else-if="!d" class="au-none">Loading…</p>
    <p v-else-if="!shown.length && !small.length" class="au-none">{{ only ? "No work from " + only + " in this window." : "No agent work in this window." }}</p>
    <ul v-else class="au-l">
      <li v-for="r in shown" :key="r.a.agent" :class="{ off: !r.a.live }">
        <span class="au-n" :title="r.a.agent + (r.a.live ? '' : ' (gone)')">{{ r.a.agent }}</span>
        <span class="au-v au-num">{{ tok(r.n) }}</span>
        <span class="au-bar" role="img" :aria-label="`${r.a.agent}: ${r.n.toLocaleString('en-US')} tokens, ${Math.round(r.share)}% of tracked work`" :title="`${r.n.toLocaleString('en-US')} tokens · ${r.share.toFixed(1)}%`"><i :style="{ width: Math.max(2, r.share) + '%' }" /></span>
        <span class="au-p au-num">{{ Math.round(r.share) }}%</span>
        <span v-if="!compact" class="au-m au-num"><template v-if="r.a.live"><i class="au-dot" aria-hidden="true" />working · </template>{{ turns(r.a) }} {{ turns(r.a) === 1 ? "turn" : "turns" }}<template v-if="r.a.costNow != null && r.a.live"> · {{ usd(r.a.costNow) }} now</template></span>
      </li>
    </ul>
    <div v-if="small.length" class="au-o">
      <button type="button" class="au-oh" :aria-expanded="openOther" aria-controls="au-other" @click="openOther = !openOther">
        <span class="au-n">Other ({{ small.length }} {{ small.length === 1 ? "agent" : "agents" }})</span>
        <span class="au-v au-num">{{ tok(smallSum) }}</span>
        <span class="au-p au-num">{{ Math.round(smallShare) }}%</span>
        <Icon name="chevron-down" :size="16" class="au-cv" />
      </button>
      <div id="au-other" class="au-ob" :class="{ 'is-open': openOther }" :inert="!openOther || undefined">
        <ul class="au-l">
          <li v-for="r in small" :key="r.a.agent" :class="{ off: !r.a.live }">
            <span class="au-n" :title="r.a.agent + (r.a.live ? '' : ' (gone)')">{{ r.a.agent }}</span>
            <span class="au-v au-num">{{ tok(r.n) }}</span>
            <span class="au-bar" role="img" :aria-label="`${r.a.agent}: ${r.n.toLocaleString('en-US')} tokens, ${r.share.toFixed(1)}% of tracked work`" :title="`${r.n.toLocaleString('en-US')} tokens · ${r.share.toFixed(1)}%`"><i :style="{ width: Math.max(2, r.share) + '%' }" /></span>
            <span class="au-p au-num">{{ r.share < 1 ? "<1" : Math.round(r.share) }}%</span>
          </li>
        </ul>
      </div>
    </div>
    <p v-if="d && !compact && !bare" class="au-foot">Share of tracked agents' input + output tokens. Cache reads are not counted.</p>
  </section>
</template>

<style scoped>
.au{display:grid;gap:10px;min-width:0}
.au *{min-width:0}
.au-h{display:flex;align-items:center;gap:10px;justify-content:space-between}
.au-h h3{margin:0;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.au-seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.au-seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.au-seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}
.au-seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.au-sub{margin:-4px 0 0;color:var(--muted);font-size:12.5px;line-height:1.35}
.au-none,.au-foot{margin:0;color:var(--muted);font-size:12.5px;line-height:1.4}
.au-num{font-variant-numeric:tabular-nums}
.au-l{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.au-l li{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"n v" "b p" "m m";gap:4px 10px;align-items:center}
.au-n{grid-area:n;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font:600 13.5px/1.3 var(--body)}
.au-v{grid-area:v;font:600 13px/1.3 var(--mono);text-align:right}
.au-bar{grid-area:b;height:8px;border-radius:4px;background:var(--track);overflow:hidden}
.au-bar i{display:block;height:100%;border-radius:4px;background:var(--chrome);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.au:not(.compact) .au-bar i{transform-origin:left;animation:au-grow .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes au-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.au-p{grid-area:p;min-width:3ch;text-align:right;color:var(--muted);font:500 12px/1 var(--mono)}
.au-m{grid-area:m;color:var(--muted);font-size:11.5px}
.au-o{border-top:1px solid var(--line);padding-top:2px}
.au-oh{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:10px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--ink);cursor:pointer;text-align:left}
.au-oh .au-n,.au-oh .au-v,.au-oh .au-p{grid-area:auto}
.au-oh .au-n{font-weight:600;color:var(--muted)}
.au-oh:focus-visible{outline:2px solid var(--on);outline-offset:2px;border-radius:8px}
.au-cv{color:var(--muted);transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.au-oh[aria-expanded="true"] .au-cv{transform:rotate(180deg)}
.au-ob{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.au-ob.is-open{grid-template-rows:1fr;opacity:1}
.au-ob > ul{overflow:hidden;transition:padding .3s cubic-bezier(.2,.8,.2,1)}
.au-ob.is-open > ul{padding:4px 0 6px}
.au-dot{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--on);vertical-align:1px}
.off .au-bar i{background:var(--off)}
@media (min-width:768px){.au:not(.compact) .au-l li{grid-template-columns:auto minmax(0,1fr) auto auto;grid-template-areas:"n m v v" "b b b p"}.au:not(.compact) .au-n{max-width:22ch}.au:not(.compact) .au-m{text-align:left}}
@media (min-width:1280px){.au:not(.compact) .au-l{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 40px}}
.compact .au-l li{grid-template-areas:"n v" "b p"}
@media (prefers-reduced-motion:reduce){.au-cv,.au-ob,.au-ob > ul,.au-bar i,.au-seg button{transition:none;animation:none}}
</style>
