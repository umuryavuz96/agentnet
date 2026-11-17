<script setup lang="ts">
// Trails, board page 07: used rate first, funnel, 14 days, how hits arrive, agents / latest hits / top searches side by side.
// The server answers from its cache at once (and recomputes in the background when the figures are older than 5 min); the page also keeps the last figures in localStorage, with their age and an
// "Updating" bar; new numbers replace them in place. Data: GET v1/panel/trails/stats, polled every 60 s while open, never overlapping.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, watchTopic } from "../net";
import { api } from "../ui/api";

interface Stats {
  days: { day: string; searches: number; injects: number }[];
  totals: { searches: number; injects: number; injected: number; injectRate: number | null; searchHitRate: number | null; used: number; checkable: number; usedRate: number | null };
  topQueries: { query: string; n: number }[];
  agents: { agent: string; searches: number; injects: number; injected: number; used: number; checkable: number }[];
  latest: { ts: string; agent: string; source: string; query: string; hits: string[]; used: boolean | null; ms: number | null }[];
}
const KEY = "agentnet.trails.stats";
const d = ref<Stats | null>(null);
const at = ref(0);
const err = ref("");
const loading = ref(false);
const slow = ref(false);
/** The server is recomputing (first run, or the figures are older than 5 min): shown as Updating until it pushes `trails-stats-ready`. */
const server = ref(false);
try { const c = JSON.parse(localStorage.getItem(KEY) || "null"); if (c?.d && c.at) { d.value = c.d; at.value = c.at; } } catch { /* no cache */ }

let slowT: ReturnType<typeof setTimeout> | null = null;
async function load() {
  if (loading.value) return;
  loading.value = true; slow.value = false;
  slowT = setTimeout(() => { slow.value = true; }, 15000);
  try {
    const r = await api<Stats & { computing?: boolean; at?: number; refreshing?: boolean }>("v1/panel/trails/stats?days=14");
    err.value = "";
    server.value = !!(r.computing || r.refreshing); // the server pushes `trails-stats-ready` on the stream when it is done
    if (!r.computing) {
      d.value = r; at.value = r.at ?? Date.now();
      try { localStorage.setItem(KEY, JSON.stringify({ d: d.value, at: at.value })); } catch { /* full */ }
    }
  } catch (e) { err.value = (e as Error).message; }
  finally { loading.value = false; slow.value = false; if (slowT) clearTimeout(slowT); }
}
watch(() => net.trailsReady, () => { void load(); });
onMounted(() => { void load(); watchTopic("trails", true); });
onBeforeUnmount(() => { watchTopic("trails", false); if (slowT) clearTimeout(slowT); });

const nf = (n: number) => n.toLocaleString("en-GB");
const pct = (x: number | null) => (x == null ? "–" : Math.round(x * 100) + "%");
const hm = (ts: number | string) => { const x = new Date(ts); return String(x.getHours()).padStart(2, "0") + ":" + String(x.getMinutes()).padStart(2, "0"); };
const T = computed(() => d.value?.totals ?? null);
const calls = computed(() => (T.value ? T.value.searches + T.value.injects : 0));
const sHit = computed(() => (T.value ? Math.round(T.value.searches * (T.value.searchHitRate ?? 0)) : 0));
const hits = computed(() => (T.value ? T.value.injected + sHit.value : 0));
const funnel = computed(() => (T.value ? ([["Calls", calls.value, false], ["With a hit", hits.value, true], ["Could be checked", T.value.checkable, true], ["Used", T.value.used, false]] as const) : []));
const mx = computed(() => Math.max(1, ...(d.value?.days ?? []).map((x) => x.searches + x.injects)));
const peakDay = computed(() => { const p = (d.value?.days ?? []).reduce((m, x) => (x.searches + x.injects > m.n ? { n: x.searches + x.injects, day: x.day } : m), { n: 0, day: "" }); return p.day ? new Date(p.day + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; });
const firstDay = computed(() => { const f = (d.value?.days ?? []).find((x) => x.searches + x.injects > 0); return f ? new Date(f.day + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; });
const dd = (s: string, i: number, n: number) => (i === n - 1 ? "Today" : String(new Date(s + "T12:00").getDate()));
/** Used share of the hits that could be checked (used / checkable, as in the top figure); null when none could be. The Hits column is another count (shown at new work / new work), so a row can read 0/6 hits and 100% used from one search. */
const rate = (a: { used: number; checkable: number }) => (a.checkable ? a.used / a.checkable : null);
const agents = computed(() => [...(d.value?.agents ?? [])].sort((a, b) => (rate(b) ?? -1) - (rate(a) ?? -1) || b.checkable - a.checkable));
/** The server cuts queries at 140 characters; say so. */
const cut = (q: string) => (q.length >= 140 ? q.trimEnd() + "…" : q);
const SRC: Record<string, string> = { task_add: "at a new task", task_msg: "at a new message", spawn: "at spawn", trail_search: "searched" };
const used = (h: { ts: string; used: boolean | null }): [string, string] => (h.used === true ? ["yes", "Used"] : h.used === false ? (Date.now() - Date.parse(h.ts) < 30 * 60e3 ? ["chk", "Checking"] : ["", "Not used"]) : ["", "Can't tell"]);
const empty = computed(() => d.value && !calls.value);
const tab = ref<"latest" | "agents" | "searches">("latest");
const TABS = [["latest", "Latest"], ["agents", "Agents"], ["searches", "Searches"]] as const;
const per = (n: number | undefined) => (n ? Math.round(n / 14) : 0);
</script>

<template>
  <section class="page fp tr">
    <header class="ph"><h1>Trails</h1>
      <span v-if="T" class="ph-s"><b class="num">{{ pct(T.usedRate) }}</b> of hits used · <b class="num">{{ nf(calls) }}</b> calls in 14 days</span>
      <span class="sp" />
      <span v-if="loading || server" class="upd"><Icon name="loader" :size="15" class="spin" />Updating<template v-if="at"> · figures from {{ hm(at) }}</template><template v-if="slow"> · taking longer than usual</template><span class="bar"><i /></span></span>
      <span v-else-if="at" class="upd"><Icon name="check" :size="15" />Updated {{ hm(at) }}</span>
    </header>
    <p v-if="!d" class="rule pad" role="status">{{ err ? `Trail stats not available (${err}). Retrying every minute.` : "Loading the first figures. This takes about 20 s." }}</p>
    <p v-else-if="err" class="rule warn" role="status">Could not update ({{ err }}). Showing figures from {{ hm(at) }}.</p>
    <p v-if="empty" class="rule pad">No trail searches or injections logged yet.</p>
    <div v-else-if="d && T" class="grid">
      <section class="uc" aria-label="Do trails help?">
        <h2><Icon name="history" :size="16" />Do trails help?<span class="sp" /><small>last 14 days</small></h2>
        <div class="big"><b class="num">{{ pct(T.usedRate) }}</b><small>of hits used</small></div>
        <div class="mt"><i :style="{ width: (T.usedRate ?? 0) * 100 + '%' }" /></div>
        <div class="fun"><div v-for="[l, v, mute] in funnel" :key="l"><span>{{ l }}</span><span class="mtr"><i :class="{ mute }" :style="{ width: (calls ? (v / calls) * 100 : 0) + '%' }" /></span><b class="num">{{ nf(v) }}</b></div></div>
        <p class="rule">Used means the agent opened a file from the hit, or named its commit or note, within 30 min. <b>{{ nf(T.checkable - T.used) }}</b> checked hits were not used.</p>
      </section>

      <section class="uc cd" aria-label="Calls per day">
        <h2><Icon name="chart-line" :size="16" />Calls per day<span class="sp" /><small v-if="peakDay">max {{ nf(mx) }} on {{ peakDay }}</small></h2>
        <div class="stk"><div v-for="(x, i) in d.days" :key="x.day" :class="{ today: i === d.days.length - 1 }" :title="`${x.day}: ${x.injects} shown at new work, ${x.searches} searches`"><i v-if="x.searches" class="s" :style="{ height: Math.max(2, (x.searches / mx) * 108) + 'px' }" /><i :style="{ height: Math.max(2, (x.injects / mx) * 108) + 'px' }" /><em>{{ dd(x.day, i, d.days.length) }}</em></div></div>
        <div class="key"><span><i />Shown at new work {{ nf(T.injects) }}</span><span><i class="s" />Agent searches {{ nf(T.searches) }}</span><span v-if="firstDay" class="rt">No data before {{ firstDay }}</span></div>
      </section>

      <section class="uc hw" aria-label="How hits arrive">
        <h2><Icon name="search" :size="16" />How hits arrive</h2>
        <div class="two"><div><div class="big sm"><b class="num">{{ pct(T.injectRate) }}</b></div><p class="rule">of <b>{{ nf(T.injects) }}</b> new tasks and spawns got a hit shown</p></div>
          <div><div class="big sm"><b class="num">{{ pct(T.searchHitRate) }}</b></div><p class="rule">of <b>{{ nf(T.searches) }}</b> agent searches found a hit</p></div></div>
        <p class="rule"><b>{{ d.agents.length }}</b> agents got at least one hit in 14 days. Searches are rare: about <b>{{ per(T.searches) }}</b> a day against <b>{{ per(T.injects) }}</b> shown.</p>
      </section>

      <div class="lists">
        <div class="phsw"><div class="seg" role="tablist" aria-label="List"><button v-for="[id, l] in TABS" :key="id" type="button" role="tab" :aria-selected="tab === id" :class="{ on: tab === id }" @click="tab = id">{{ l }}</button></div></div>
        <section class="uc list" :class="{ off: tab !== 'agents' }" aria-label="By agent">
          <h2><Icon name="users" :size="16" />By agent<span class="sp" /><small>best use first</small></h2>
          <div class="tb"><div class="row hd"><span>Agent</span><span class="r">Searches</span><span class="r">Hits</span><span>Used</span></div>
            <div v-for="a in agents" :key="a.agent" class="row"><span class="nm">{{ a.agent }}</span><span class="r num">{{ a.searches }}</span><span class="r num">{{ a.injected }}/{{ a.injects }}</span><span class="sc"><span class="mtr"><i :style="{ width: (rate(a) ?? 0) * 100 + '%' }" /></span><b class="num">{{ rate(a) != null ? Math.round(rate(a)! * 100) + "%" : "–" }}</b></span></div></div>
          <div class="ft">Hits = shown at new work / new work. Used = used / hits that could be checked.</div>
        </section>
        <section class="uc list" :class="{ off: tab !== 'latest' }" aria-label="Latest hits">
          <h2><Icon name="activity" :size="16" />Latest hits<span class="sp" /><small>live</small></h2>
          <div class="tb"><div v-for="h in d.latest" :key="h.ts + h.agent + h.query" class="hit"><time>{{ hm(h.ts) }}</time><span class="q">{{ cut(h.query) }}</span><span class="u" :class="used(h)[0]">{{ used(h)[1] }}</span><div class="sub"><b>{{ h.agent }}</b><span>{{ SRC[h.source] ?? h.source }}</span><span>{{ h.hits.length }} {{ h.hits.length === 1 ? "hit" : "hits" }}</span></div></div>
          <div class="pextra"><section class="uc"><h2><Icon name="chart-line" :size="16" />Calls per day<span class="sp" /><small>last 14 days</small></h2>
            <div class="stk"><div v-for="(x, i) in d.days" :key="x.day" :class="{ today: i === d.days.length - 1 }"><i v-if="x.searches" class="s" :style="{ height: Math.max(2, (x.searches / mx) * 108) + 'px' }" /><i :style="{ height: Math.max(2, (x.injects / mx) * 108) + 'px' }" /><em>{{ dd(x.day, i, d.days.length) }}</em></div></div></section>
            <section class="uc"><h2><Icon name="search" :size="16" />How hits arrive</h2><p class="rule"><b>{{ pct(T.injectRate) }}</b> of {{ nf(T.injects) }} new tasks and spawns got a hit shown; <b>{{ pct(T.searchHitRate) }}</b> of {{ nf(T.searches) }} searches found one.</p></section></div>
          </div>
          <div class="ft">"Checking" means the 30 min window is still open.</div>
        </section>
        <section class="uc list" :class="{ off: tab !== 'searches' }" aria-label="Top searches">
          <h2><Icon name="search" :size="16" />Top searches</h2>
          <div class="tb"><div v-for="q in d.topQueries" :key="q.query" class="qr"><span>{{ q.query }}</span><b class="num">{{ q.n }}</b></div></div>
          <div class="ft">Only {{ nf(T.searches) }} searches in 14 days, so most run once.</div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tr{flex:1;min-height:0;gap:12px}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}.sp{flex:1}
.upd{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}
.upd .bar{width:90px;height:6px;border-radius:3px;background:var(--track);overflow:hidden;position:relative}.upd .bar i{position:absolute;inset:0 auto 0 0;width:35%;border-radius:3px;background:var(--chrome);animation:slide 1.4s linear infinite}
.spin{animation:rot 1s linear infinite}
@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(290%)}}@keyframes rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin,.upd .bar i{animation:none}}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:16px}
.uc{display:grid;align-content:start;gap:10px;padding:18px 20px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.uc h2{display:flex;gap:8px;align-items:center;margin:0;font:600 14px/1.3 var(--body)}.uc h2 small{font-weight:400;color:var(--muted);font-size:13px}
.big{display:flex;align-items:baseline;gap:8px}.big b{font:600 44px/1 var(--mono)}.big small{font:400 15px/1 var(--body);color:var(--muted)}.big.sm b{font-size:30px}
.mt{height:10px;border-radius:5px;background:var(--track)}.mt i{display:block;height:100%;border-radius:5px;background:var(--on);transition:width .45s cubic-bezier(.2,.8,.2,1)}
.rule{margin:0;color:var(--muted);font-size:13px;line-height:1.45}.rule b{color:var(--ink)}.rule.warn{color:var(--warn)}.pad{padding:16px 20px}
.fun{display:grid;gap:7px;font-size:13px}.fun>div{display:grid;grid-template-columns:120px minmax(0,1fr) 56px;gap:10px;align-items:center}.fun b{text-align:right}
.mtr{height:8px;border-radius:4px;background:var(--track);overflow:hidden;display:block}.mtr i{display:block;height:100%;border-radius:4px;background:var(--chrome);transition:width .45s cubic-bezier(.2,.8,.2,1)}.mtr i.mute{background:var(--muted);opacity:.55}
.stk{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:6px;align-items:end;height:132px}
.stk>div{display:grid;gap:4px;justify-items:stretch;height:100%;align-content:end;font:500 11px/1 var(--mono);color:var(--muted);text-align:center}
.stk i{display:block;border-radius:2px;background:var(--muted);opacity:.45;transition:height .24s cubic-bezier(.2,.8,.2,1)}.stk i.s{background:var(--ink);opacity:1;border-radius:4px 4px 0 0}
.stk .today em{color:var(--ink);font-weight:700}.stk em{font-style:normal}
.key{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted)}.key span{display:inline-flex;gap:6px;align-items:center}.key i{width:10px;height:10px;border-radius:3px;background:var(--muted);opacity:.45}.key i.s{background:var(--ink);opacity:1}.key .rt{margin-left:auto}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.lists{grid-column:1/4;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr);gap:16px;min-height:0}
.phsw,.pextra{display:none}
.list{grid-template-rows:auto minmax(0,1fr);padding:0;overflow:hidden;gap:0}.list>h2{padding:16px 20px 10px}.list:has(.ft){grid-template-rows:auto minmax(0,1fr) auto}
.tb{overflow:auto;overscroll-behavior:contain;min-height:0}
.row{display:grid;grid-template-columns:minmax(120px,1.4fr) 70px 90px minmax(110px,1fr);gap:12px;align-items:center;padding:9px 20px;border-top:1px solid var(--hair);font-size:14px}
.row.hd{color:var(--muted);font-size:12px;position:sticky;top:0;background:var(--panel);z-index:1}.nm{font-weight:600;overflow-wrap:anywhere}.r{text-align:right}
.sc{display:flex;gap:8px;align-items:center}.sc .mtr{flex:1}
.hit{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:4px 12px;padding:10px 20px;border-top:1px solid var(--hair);font-size:13.5px}
.hit time{color:var(--muted);font:12px var(--mono);padding-top:2px}.hit .q{overflow-wrap:anywhere;line-height:1.4}
.hit .sub{grid-column:2/4;display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--muted);font-size:12px}.hit .sub b{color:var(--ink);font-weight:600}
.u{font-size:12px;font-weight:600;white-space:nowrap;color:var(--muted)}.u.yes{color:var(--on)}.u.chk{color:var(--pend)}
.qr{display:grid;grid-template-columns:minmax(0,1fr) 28px;gap:12px;padding:9px 20px;border-top:1px solid var(--hair);font-size:13.5px}.qr span{overflow-wrap:anywhere}.qr b{text-align:right}
.ft{padding:10px 20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track)}
.seg button{min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer}
.seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
@media (max-width:1279px){.grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.grid>.uc:first-child{grid-column:1/3}.cd{grid-column:1}.lists{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.lists>.list:first-of-type{grid-column:1/3}}
@media (max-width:760px){
  .ph{display:none}.upd{font-size:12px}
  .tr>.rule.pad{padding:8px 0}
  .grid{display:flex;flex-direction:column;gap:12px}
  .cd,.hw{display:none}
  .lists{display:grid;flex:1;min-height:0;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:8px}
  .phsw{display:block}.list{grid-column:1;grid-row:2}.list.off{display:none}
  .row{grid-template-columns:minmax(0,1fr) 60px 70px}.row>:nth-child(2),.row.hd>:nth-child(2){display:none}
  .big b{font-size:40px}.pextra{display:grid;gap:12px;padding:12px 14px}.pextra .uc{padding:14px}
}
</style>
