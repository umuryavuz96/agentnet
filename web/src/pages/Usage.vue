<script setup lang="ts">
// Usage, board page 05: week card (number, mode marks, mode in words), running now, model mix, one ranked list.
// Fixed to the window; only the list scrolls. Data: the usage poll (net.ts) plus the mode from GET v1/panel/routing. No new polling.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import StateMark from "../ui/StateMark.vue";
import Skel from "../ui/Skel.vue";
import { api } from "../ui/api";
import { net, usage, useUsage, worked, type UsageAgent } from "../net";

const stop = useUsage();
onBeforeUnmount(stop);
const win = ref<"fiveHour" | "weekly">("weekly");
const WINS = [["fiveHour", "5 hours"], ["weekly", "Week"]] as const;

interface Mode { mode: string; thresholds: { careful: number; eco: number; reserve: number } }
const mode = ref<Mode | null>(null);
onMounted(async () => { try { mode.value = (await api<{ mode: Mode }>("v1/panel/routing")).mode; } catch { mode.value = null; } });

const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2).replace(/0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d = computed(() => usage.data);
const pct = computed(() => d.value?.windows.weekly.accountPct ?? null);
const resetTxt = computed(() => {
  const r = d.value?.windows.weekly.resetsAt as unknown; const t = typeof r === "number" ? r : r ? Date.parse(String(r)) : NaN;
  if (!Number.isFinite(t)) return null;
  const x = new Date(Math.round(t / 60000) * 60000);
  return x.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + ", " + x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
});
const marks = computed(() => (mode.value ? (["careful", "eco", "reserve"] as const).map((m) => [m, mode.value!.thresholds[m]] as const) : []));
const RULE: Record<string, string> = {
  normal: "Routing picks models by task size, no limits.",
  careful: "Effort drops one level and Fable falls back to Opus unless asked for.",
  eco: "Builders run on Sonnet at most, light roles on Haiku, one job team of up to 3 agents.",
  reserve: "Heavy work stops; only chat and light checks run.",
};
const since = computed(() => (mode.value ? ({ normal: 0, ...mode.value.thresholds } as Record<string, number>)[mode.value.mode] : 0));
const next = computed(() => (pct.value != null ? marks.value.find(([, p]) => p > pct.value!) ?? null : null));
const near = computed(() => (next.value && pct.value != null && next.value[1] - pct.value <= 5 ? next.value : null));

const agents = computed(() => d.value?.agents ?? []);
const live = computed(() => agents.value.filter((a) => a.live && a.costNow != null));
const liveCost = computed(() => live.value.reduce((s, a) => s + (a.costNow ?? 0), 0));
const five = computed(() => agents.value.reduce((s, a) => s + worked(a.fiveHour), 0));
const fam = (m: string) => (/(opus|sonnet|haiku|fable)/i.exec(m)?.[1] ?? m).toLowerCase();
const mix = computed(() => {
  const f: Record<string, number> = {};
  for (const a of agents.value) for (const [m, t] of Object.entries(a.byModel ?? {})) f[fam(m)] = (f[fam(m)] ?? 0) + worked(t);
  const sum = Object.values(f).reduce((s, v) => s + v, 0) || 1;
  return Object.entries(f).sort((a, b) => b[1] - a[1]).map(([n, v]) => [n, Math.round((v / sum) * 100)] as const).filter(([, p]) => p > 0);
});
const rows = computed(() => {
  const l = agents.value.map((a) => ({ a, n: worked(a[win.value]) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
  const sum = l.reduce((s, x) => s + x.n, 0) || 1;
  return l.map((x) => ({ ...x, share: (x.n / sum) * 100 }));
});
const FOLD = 2;
const shown = computed(() => rows.value.filter((r) => r.share >= FOLD));
const small = computed(() => rows.value.filter((r) => r.share < FOLD));
const open = ref(false);
const smallShare = computed(() => small.value.reduce((s, r) => s + r.share, 0));
const topShare = computed(() => rows.value[0]?.share || 1);
const stOf = (a: UsageAgent) => (a.live ? net.agents[a.agent]?.state ?? "idle" : "notrunning");
const turns = (a: UsageAgent) => a[win.value].turns;
const modelTag = (a: UsageAgent) => (a.model ? a.model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-/g, " ") : "–");
</script>

<template>
  <section class="page fp ug">
    <header class="ph"><h1>Usage</h1><span v-if="pct != null" class="ph-s"><b class="num">{{ Math.round(pct) }}%</b> of the week<template v-if="mode"> · {{ mode.mode }}</template></span></header>
    <div class="grid">
      <section class="uc" aria-label="This week">
        <h2><Icon name="chart-line" :size="16" />This week<span class="sp" /><small v-if="resetTxt">resets {{ resetTxt }}</small></h2>
        <template v-if="pct != null">
          <div class="big"><b class="num">{{ Math.round(pct) }}</b><small>% of the plan used</small></div>
          <div class="mt" role="meter" aria-label="Weekly plan used" :aria-valuenow="Math.round(pct)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="`${Math.round(pct)} percent of the weekly plan${mode ? ', mode ' + mode.mode : ''}`">
            <i :class="{ hot: pct > 90 }" :style="{ width: Math.min(100, pct) + '%' }" />
            <span v-for="[m, p] in marks" :key="m" class="tk" :style="{ left: p + '%' }" />
          </div>
          <div class="mk"><span v-for="[m, p] in marks" :key="m" :class="{ on: m === mode?.mode }" :style="{ left: p + '%' }">{{ m }}<br /><span class="num">{{ p }}%</span></span></div>
          <p v-if="mode" class="rule"><b>{{ mode.mode[0].toUpperCase() + mode.mode.slice(1) }} mode</b><template v-if="since"> since {{ since }}%</template>. {{ RULE[mode.mode] }}<template v-if="mode.mode !== 'reserve'"> At {{ mode.thresholds.reserve }}% heavy work stops and only chat runs.</template></p>
          <p v-if="near" class="rule warn">{{ Math.round(near[1] - pct) }} points to {{ near[0] }} mode.</p>
        </template>
        <p v-else-if="usage.err && !d" class="rule">Usage not available ({{ usage.err }}). Showing nothing until it answers.</p>
        <Skel v-else-if="!d" :lines="3" />
        <p v-else class="rule">The plan reported no weekly percentage.</p>
      </section>

      <section class="uc now" aria-label="Running now">
        <h2><Icon name="activity" :size="16" />Running now</h2>
        <template v-if="d">
          <div class="big"><b class="num">{{ usd(liveCost) }}</b><small>so far</small></div>
          <p class="rule">Cost of the <b>{{ live.length }}</b> live agents since they started<template v-if="live.length">: {{ live.map((a) => a.agent + " " + usd(a.costNow ?? 0)).join(", ") }}</template>.</p>
          <p class="rule"><b class="num">{{ k(five) }}</b> output + input tokens in the last 5 hours.</p>
        </template>
        <p v-else class="rule">–</p>
      </section>

      <section class="uc mdl" aria-label="By model, week">
        <h2><Icon name="cpu" :size="16" />By model, week</h2>
        <template v-if="mix.length">
          <div class="mix"><i v-for="([n, p], i) in mix" :key="n" :style="{ width: p + '%', opacity: [1, .55, .25, .12][i] ?? .12 }" /></div>
          <div class="key"><div v-for="([n, p], i) in mix" :key="n"><i :style="{ opacity: [1, .55, .25, .12][i] ?? .12 }" />{{ n }}<span class="sp" /><span class="num">{{ p }}%</span></div></div>
          <p class="rule">Share of the week's tokens of the {{ rows.length }} agents listed.</p>
        </template>
        <p v-else class="rule">{{ d ? "No model data in this window." : "–" }}</p>
      </section>

      <section class="uc who" aria-label="Who used it">
        <h2><Icon name="users" :size="16" />Who used it<span class="sp" />
          <div class="seg" role="tablist" aria-label="Usage window"><button v-for="[id, label] in WINS" :key="id" type="button" role="tab" :aria-selected="win === id" :class="{ on: win === id }" @click="win = id">{{ label }}</button></div>
        </h2>
        <div class="tb">
          <p v-if="usage.err && !d" class="rule pad">Usage not available ({{ usage.err }}).</p>
          <Skel v-else-if="!d" :lines="4" class="pad" />
          <p v-else-if="!rows.length" class="rule pad">No agent work in this window.</p>
          <template v-else>
            <div class="row hd"><span>#</span><span>Agent</span><span>Model</span><span>Share of tracked tokens</span><span class="r">Tokens</span><span class="r">Turns</span><span class="r">Cost now</span></div>
            <div v-for="(r, i) in shown" :key="r.a.agent" class="row"><span class="n">{{ i + 1 }}</span>
              <span class="nm"><StateMark :state="stOf(r.a)" :title="r.a.live ? stOf(r.a) : 'ended'" />{{ r.a.agent }}</span>
              <span><span class="tag">{{ modelTag(r.a) }}</span></span>
              <span class="bar"><span class="mtr" role="img" :aria-label="`${r.a.agent}: ${Math.round(r.share)}% of tracked work`"><i :style="{ width: Math.max(2, (r.share / topShare) * 100) + '%' }" /></span><span class="num">{{ r.share.toFixed(r.share < 10 ? 1 : 0) }}%</span></span>
              <span class="r num">{{ k(r.n) }}</span><span class="r num">{{ turns(r.a) }}</span>
              <span class="r num">{{ r.a.live && r.a.costNow != null ? usd(r.a.costNow) : "" }}<span v-if="!r.a.live" class="mu">ended</span></span>
            </div>
            <template v-if="small.length">
              <button type="button" class="row oth" :aria-expanded="open" @click="open = !open"><span class="n"><Icon name="chevron-down" :size="13" :class="{ rot: open }" /></span><span class="nm">Everyone else ({{ small.length }})</span><span /><span class="num">{{ smallShare.toFixed(1) }}%</span><span /><span /><span /></button>
              <div v-if="open">
                <div v-for="r in small" :key="r.a.agent" class="row oth"><span class="n" /><span class="nm"><StateMark :state="stOf(r.a)" />{{ r.a.agent }}</span><span><span class="tag">{{ modelTag(r.a) }}</span></span><span class="bar"><span class="mtr"><i :style="{ width: Math.max(2, (r.share / topShare) * 100) + '%' }" /></span><span class="num">{{ r.share < 1 ? "<1" : r.share.toFixed(1) }}%</span></span><span class="r num">{{ k(r.n) }}</span><span class="r num">{{ turns(r.a) }}</span><span class="r mu">{{ r.a.live ? "" : "ended" }}</span></div>
              </div>
            </template>
          </template>
          <div class="pextra"><section class="uc now2"><h2><Icon name="activity" :size="16" />Running now</h2><div class="big"><b class="num">{{ usd(liveCost) }}</b><small>so far</small></div></section>
            <section v-if="mix.length" class="uc"><h2><Icon name="cpu" :size="16" />By model, week</h2><div class="key"><div v-for="([n, p]) in mix" :key="n">{{ n }}<span class="sp" /><span class="num">{{ p }}%</span></div></div></section></div>
        </div>
        <div class="ft">Share of tracked agents' input and output tokens; cache reads are not counted. Bars are scaled to the top agent. Cost now is the agent's own running cost, shown only while it runs.</div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.ug{flex:1;min-height:0;gap:12px}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:16px}
.uc{display:grid;align-content:start;gap:10px;padding:18px 20px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.uc h2{display:flex;gap:8px;align-items:center;margin:0;font:600 14px/1.3 var(--body)}
.uc h2 small{font-weight:400;color:var(--muted);font-size:13px}
.sp{flex:1}
.big{display:flex;align-items:baseline;gap:6px}.big b{font:600 44px/1 var(--mono)}.big small{font:400 15px/1 var(--body);color:var(--muted)}
.mt{position:relative;height:10px;border-radius:5px;background:var(--track)}
.mt i{position:absolute;inset:0 auto 0 0;border-radius:5px;background:var(--on);transition:width .45s cubic-bezier(.2,.8,.2,1)}.mt i.hot{background:var(--bad)}
.tk{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--ink);opacity:.45}
.mk{position:relative;height:32px;font-size:12px;color:var(--muted)}
.mk>span{position:absolute;top:0;transform:translateX(-50%);text-align:center;line-height:1.3;white-space:nowrap}.mk>span.on{color:var(--ink);font-weight:600}
.rule{margin:0;color:var(--muted);font-size:13px;line-height:1.45}.rule b{color:var(--ink)}.rule.warn{color:var(--warn)}.pad{padding:16px 20px}
.mix{display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px}.mix i{display:block;height:100%;background:var(--ink);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.key{display:grid;gap:6px;font-size:13px;text-transform:capitalize}.key div{display:flex;gap:8px;align-items:center}.key i{width:10px;height:10px;border-radius:3px;background:var(--ink)}
.who{grid-column:1/4;grid-template-rows:auto minmax(0,1fr) auto;gap:0;padding:0;overflow:hidden}
.who>h2{padding:16px 20px 12px}
.tb{overflow:auto;overscroll-behavior:contain;min-height:0}
.row{display:grid;grid-template-columns:28px minmax(140px,1.2fr) 120px minmax(160px,2fr) 84px 72px 84px;gap:14px;align-items:center;padding:9px 20px;border:0;border-top:1px solid var(--hair);font-size:14px;width:100%;text-align:left;background:none;color:var(--ink)}
.row.hd{color:var(--muted);font-size:12px;position:sticky;top:0;background:var(--panel);z-index:1}
.n{color:var(--muted);font:12px var(--mono);display:flex}.n :deep(.rot){transform:rotate(180deg)}
.nm{display:flex;gap:8px;align-items:center;font-weight:600;min-width:0;overflow-wrap:anywhere}
.st{width:8px;height:8px;border-radius:50%;flex:none;background:var(--off);opacity:.6}.st.on{background:var(--on);opacity:1}
.r{text-align:right}.mu{color:var(--muted);font-size:12px}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--soft);font:12px/1.4 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.bar{display:flex;gap:10px;align-items:center}.mtr{flex:1;height:8px;border-radius:4px;background:var(--track);overflow:hidden}.mtr i{display:block;height:100%;border-radius:4px;background:var(--chrome);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.row.oth{color:var(--muted)}button.row{cursor:pointer;font-family:inherit}button.row:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ft{padding:10px 20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer}
.seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.pextra{display:none}
@media (max-width:1279px){.grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.uc:first-child{grid-column:1/3}.now,.mdl{grid-column:auto}.who{grid-column:1/3}
  .row{grid-template-columns:24px minmax(110px,1.2fr) 96px minmax(100px,1.5fr) 64px 56px 72px;gap:10px}}
@media (max-width:760px){
  .ph{display:none}
  .grid{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:12px}
  .uc:first-child,.who{grid-column:auto}.now,.mdl{display:none}
  .big b{font-size:40px}
  .row{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:10px 14px}
  .row.hd,.n,.row>:nth-child(3),.row>:nth-child(n+6){display:none}
  .row .nm{grid-column:1;grid-row:1}.row>:nth-child(5){grid-column:2;grid-row:1}
  .row .bar{grid-column:1/3;grid-row:2}
  .row.oth{grid-template-columns:minmax(0,1fr) auto}.row.oth>span:empty{display:none}.row.oth .nm{grid-row:1}.row.oth>:nth-child(4){grid-column:2;grid-row:1}
  .pextra{display:grid;gap:12px;padding:12px 14px}
}
</style>
