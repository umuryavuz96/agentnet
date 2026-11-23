<script setup lang="ts">
// Lines (job 8c, docs/internal/one-folder/SPEC-step8b-picks.md): every agent line grouped by role, with status by icon and word,
// baseline, jobs and last reward. Opening a line puts its detail in a panel next to the list (it pushes the list, never covers it;
// on a phone a half sheet with no backdrop): versions with the upgrade text in full, the baseline chart, picks, and proposals.
// Proposals and their approve / reject buttons exist only for root (the detail says `root`). Data: GET v1/panel/lines (every 30 s)
// and v1/panel/lines/<line>; writes: POST v1/panel/lines/proposals/<id>/approve|reject.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import Skel from "../ui/Skel.vue";
import { api, toast } from "../ui/api";
import { route, toHash } from "../router";
import { agoMs, chartGeom, checkText, groupByRole, kb, nearest, pickShare, PSTATUS, r1, SCOPE, STATUS, VSTATUS, type LineDetail, type LineRow, type LinesList, type Proposal } from "../lines";

const list = ref<LinesList | null>(null);
const err = ref("");
const loading = ref(false);
const slow = ref(false);
let slowT: ReturnType<typeof setTimeout> | undefined;
async function load() {
  if (loading.value) return;
  loading.value = true; slowT = setTimeout(() => { slow.value = true; }, 15000);
  try { list.value = await api<LinesList>("v1/panel/lines"); err.value = ""; }
  catch (e) { err.value = (e as Error).message; }
  finally { loading.value = false; slow.value = false; clearTimeout(slowT); }
}
const off = computed(() => list.value?.on === false);
const groups = computed(() => groupByRole(list.value?.lines ?? []));
const counts = computed(() => { const l = list.value?.lines ?? []; return { all: l.length, live: l.filter((x) => x.status !== "retired").length, probation: l.filter((x) => x.status === "probation").length }; });

// ---------- selection (in the URL: #/lines?line=<name>) ----------
const sel = computed(() => route.value.page === "lines" ? route.value.query.line ?? "" : "");
function open(line: string) {
  const query = line ? { ...route.value.query, line } : (({ line: _l, ...q }) => q)(route.value.query);
  history.replaceState(null, "", toHash({ page: "lines", query }));
  route.value = { page: "lines", query };
}
const detail = ref<LineDetail | null>(null);
const dErr = ref("");
const dLoading = ref(false);
let dReq = 0;
async function loadDetail(quiet = false) {
  const name = sel.value; if (!name) { detail.value = null; return; }
  const n = ++dReq; if (!quiet) dLoading.value = true;
  try { const d = await api<LineDetail>(`v1/panel/lines/${encodeURIComponent(name)}`); if (n === dReq) { detail.value = d; dErr.value = ""; } }
  catch (e) { if (n === dReq) dErr.value = (e as Error).message; }
  finally { if (n === dReq) dLoading.value = false; }
}
const tab = ref<"versions" | "picks" | "proposals">("versions");
const head = ref<HTMLElement | null>(null);
watch(sel, (s, was) => {
  dErr.value = "";
  if (!s) { detail.value = null; return; }
  if (!was) { tab.value = "versions"; void nextTick(() => head.value?.focus({ preventScroll: true })); }
  void loadDetail();
});
const row = computed<LineRow | null>(() => list.value?.lines.find((l) => l.line === sel.value) ?? null);
const d = computed(() => (detail.value && detail.value.name === sel.value ? detail.value : null));
const versions = computed(() => [...(d.value?.versions ?? [])].reverse());
const pending = computed(() => (d.value?.proposals ?? []).filter((p) => p.status === "pending").length);
const share = computed(() => pickShare(d.value?.picks ?? [], sel.value));
const TABS = computed(() => [["versions", "Versions", d.value?.versions.length ?? 0], ["picks", "Picks", d.value?.picks.length ?? 0], ...(d.value?.root ? [["proposals", "Proposals", pending.value] as const] : [])] as const);
watch(() => d.value?.root, (r) => { if (r === false && tab.value === "proposals") tab.value = "versions"; });

// ---------- chart (one line: baseline; dots: each job's reward). Fixed 1-5 scale. ----------
const box = ref<HTMLElement | null>(null);
const cw = ref(360);
let ro: ResizeObserver | undefined;
watch(box, (el) => { ro?.disconnect(); if (el) { ro = new ResizeObserver(([e]) => { cw.value = Math.max(200, Math.round(e.contentRect.width)); }); ro.observe(el); } });
const series = computed(() => d.value?.baselineSeries ?? []);
const g = computed(() => chartGeom(series.value, cw.value, 150));
const hover = ref(-1);
function onMove(e: PointerEvent) { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); hover.value = nearest(g.value.xs, e.clientX - r.left); }
const hp = computed(() => (hover.value >= 0 ? series.value[hover.value] ?? null : null));
const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// ---------- proposals (root) ----------
const into = ref<Record<string, "line" | "base">>({});
const owner = ref<Record<string, boolean>>({});
const rejecting = ref<Record<string, boolean>>({});
const reason = ref<Record<string, string>>({});
const busy = ref("");
const pErr = ref<Record<string, string>>({});
async function decide(p: Proposal, op: "approve" | "reject") {
  if (busy.value) return;
  const body = op === "reject" ? { reason: (reason.value[p.id] ?? "").trim() } : p.kind === "skill" ? { into: into.value[p.id] ?? "line" } : p.ownerOnly ? { owner: !!owner.value[p.id] } : {};
  busy.value = p.id; pErr.value = { ...pErr.value, [p.id]: "" };
  try {
    await api(`v1/panel/lines/proposals/${encodeURIComponent(p.id)}/${op}`, { body });
    toast(op === "approve" ? `Approved ${p.name ?? "the rule"}` : `Rejected ${p.name ?? "the rule"}`);
    rejecting.value = { ...rejecting.value, [p.id]: false };
    await loadDetail(true);
  } catch (e) { pErr.value = { ...pErr.value, [p.id]: (e as Error).message }; }
  finally { busy.value = ""; }
}

// ---------- life ----------
const phone = ref(false);
const mq = matchMedia("(max-width:760px)");
const onMq = () => { phone.value = mq.matches; };
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && sel.value && !(e.target as HTMLElement)?.closest?.("input,textarea")) open(""); };
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  onMq(); mq.addEventListener("change", onMq); addEventListener("keydown", onKey);
  void load(); if (sel.value) void loadDetail();
  timer = setInterval(() => { void load(); if (sel.value) void loadDetail(true); }, 30_000);
});
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(slowT); ro?.disconnect(); mq.removeEventListener("change", onMq); removeEventListener("keydown", onKey); });
</script>

<template>
  <section class="page fp ln" :class="{ open: !!sel }">
    <header class="ph"><h1>Lines</h1>
      <span v-if="list && !off && counts.all" class="ph-s"><b class="num">{{ counts.live }}</b> live of <b class="num">{{ counts.all }}</b> lines · <b class="num">{{ groups.length }}</b> roles<template v-if="counts.probation"> · <b class="num">{{ counts.probation }}</b> on probation</template></span>
      <span class="sp" />
      <span v-if="loading && list" class="upd"><Icon name="loader" :size="15" class="spin" />Updating</span>
    </header>

    <div v-if="!list && !err" class="uc st" role="status"><Skel :lines="4" /><p class="rule">{{ slow ? "Loading the lines is taking longer than usual." : "Loading lines…" }}</p></div>
    <div v-else-if="!list && err" class="uc st" role="alert">
      <h2><Icon name="triangle-alert" :size="16" />Could not load the lines</h2>
      <p class="rule">The server said: {{ err }}. Nothing was changed.</p>
      <button type="button" class="btn" @click="load"><Icon name="rotate-ccw" :size="15" />Try again</button>
    </div>
    <div v-else-if="off" class="uc st">
      <h2><Icon name="circle-stop" :size="16" />Lines are off on this server</h2>
      <p class="rule">A line keeps one agent name's upgrades, rewards and picks from one generation to the next. Start the service with <code>AGENTNET_LINES=1</code> to turn lines on.</p>
    </div>
    <div v-else-if="list && !list.lines.length" class="uc st">
      <h2><Icon name="layers" :size="16" />No lines yet</h2>
      <p class="rule">A line starts the first time an agent is spawned with lines on. Its versions, rewards and picks show up here after its first graded job.</p>
    </div>

    <div v-else-if="list" class="wrap">
      <p v-if="err" class="rule warn" role="status">Could not update ({{ err }}). Showing the last list.</p>
      <div class="lst" :class="{ pad: phone && !!sel }">
        <section v-for="gr in groups" :key="gr.role" class="uc grp" :aria-label="`Role ${gr.role}`">
          <h2><Icon name="users" :size="16" />{{ gr.role }}<span class="sp" /><small>{{ gr.live }} live<template v-if="gr.best != null"> · best <b class="num">{{ r1(gr.best) }}</b></template></small></h2>
          <div class="hd" aria-hidden="true"><span>Line</span><span>Status</span><span class="r">Baseline</span><span class="r">Jobs</span><span class="r">Last</span><span class="pk">Last pick</span></div>
          <button v-for="l in gr.lines" :key="l.line" type="button" class="row" :class="{ on: sel === l.line, ret: l.status === 'retired' }" :aria-pressed="sel === l.line" @click="open(sel === l.line ? '' : l.line)">
            <span class="nm"><b>{{ l.line }}</b><small>v{{ l.current }}<template v-if="l.parent"> · from {{ l.parent }}</template></small></span>
            <span class="chip" :class="l.status"><Icon :name="STATUS[l.status].icon" :size="13" />{{ STATUS[l.status].label }}</span>
            <span class="r num" :aria-label="`baseline ${r1(l.baseline)}`">{{ r1(l.baseline) }}</span>
            <span class="r num">{{ l.jobs }}</span>
            <span class="r num">{{ r1(l.lastReward) }}</span>
            <span class="pk">{{ agoMs(l.lastPick) }}</span>
            <span class="mini">Baseline <b class="num">{{ r1(l.baseline) }}</b> · {{ l.jobs }} jobs · last <b class="num">{{ r1(l.lastReward) }}</b></span>
          </button>
        </section>
      </div>

      <Transition name="dp">
        <aside v-if="sel" class="side-panel dp" :class="{ sheet: phone }" :aria-label="`Line ${sel}`">
          <div v-if="phone" class="grab" aria-hidden="true" />
          <header class="dh">
            <div class="tt"><h2 ref="head" tabindex="-1">{{ sel }}</h2>
              <span v-if="row" class="chip" :class="row.status"><Icon :name="STATUS[row.status].icon" :size="13" />{{ STATUS[row.status].label }}</span></div>
            <button type="button" class="x" aria-label="Close the line" @click="open('')"><Icon name="x" :size="18" /></button>
          </header>

          <div v-if="!d && dErr" class="pb" role="alert"><p class="rule">Could not load {{ sel }}: {{ dErr }}.</p><button type="button" class="btn" @click="loadDetail()"><Icon name="rotate-ccw" :size="15" />Try again</button></div>
          <div v-else-if="!d" class="pb"><Skel :lines="6" /></div>
          <div v-else class="pbody" :class="{ dim: dLoading }">
            <dl class="facts">
              <div><dt>Baseline</dt><dd class="num">{{ r1(d.line.baseline) }}</dd></div>
              <div><dt>Version</dt><dd class="num">v{{ d.line.current }}</dd></div>
              <div><dt>Jobs</dt><dd class="num">{{ series.length }}</dd></div>
              <div><dt>Role</dt><dd>{{ d.line.role }}</dd></div>
              <div v-if="d.line.parent" class="wide"><dt>Forked from</dt><dd>{{ d.line.parent }}<template v-if="d.line.parentVersion"> v{{ d.line.parentVersion }}</template></dd></div>
            </dl>

            <section class="chart" aria-label="Baseline over time">
              <h3>Baseline over time<span class="sp" /><span class="key"><i class="kl" />Baseline<i class="kd" />Job reward</span></h3>
              <div ref="box" class="cbox">
                <p v-if="!series.length" class="rule">No graded jobs yet: the chart starts after the first one.</p>
                <template v-else>
                  <svg :width="g.w" :height="g.h" role="img" :aria-label="`Baseline of ${sel} over ${series.length} jobs, now ${r1(d.line.baseline)} of 5`" @pointermove="onMove" @pointerleave="hover = -1">
                    <g class="ax"><template v-for="t in g.ticks" :key="t"><line :x1="g.x0" :x2="g.x1" :y1="g.yOf(t)" :y2="g.yOf(t)" /><text :x="g.x0 - 8" :y="g.yOf(t) + 4" text-anchor="end">{{ t }}</text></template></g>
                    <text class="axl" :x="g.x0" :y="g.h - 4">gen {{ series[0].gen }} · {{ day(series[0].at) }}</text>
                    <text v-if="series.length > 1" class="axl" :x="g.x1" :y="g.h - 4" text-anchor="end">gen {{ series[series.length - 1].gen }} · {{ day(series[series.length - 1].at) }}</text>
                    <line v-if="hp" class="xh" :x1="g.xs[hover]" :x2="g.xs[hover]" :y1="g.y1" :y2="g.y0" />
                    <circle v-for="(p, i) in series" :key="'r' + i" class="dot" :cx="g.xs[i]" :cy="g.yOf(p.reward)" r="4" />
                    <path class="bl" :d="g.path" />
                    <circle v-if="hp && hp.baseline != null" class="hb" :cx="g.xs[hover]" :cy="g.yOf(hp.baseline)" r="5" />
                  </svg>
                  <div v-if="hp" class="tip" :style="{ left: Math.min(Math.max(g.xs[hover], 90), g.w - 90) + 'px', top: (Math.min(g.yOf(hp.reward), g.yOf(hp.baseline ?? hp.reward)) < g.h / 2 ? g.y0 - 46 : 0) + 'px' }" role="status">
                    <b>Gen {{ hp.gen }}</b> · {{ day(hp.at) }}<br />Reward <b class="num">{{ r1(hp.reward) }}</b> · baseline <b class="num">{{ r1(hp.baseline) }}</b>
                  </div>
                </template>
              </div>
              <table class="sr-only"><caption>Baseline per job</caption><thead><tr><th>Gen</th><th>Reward</th><th>Baseline</th></tr></thead>
                <tbody><tr v-for="p in series" :key="p.gen + '-' + p.job"><td>{{ p.gen }}</td><td>{{ r1(p.reward) }}</td><td>{{ r1(p.baseline) }}</td></tr></tbody></table>
            </section>

            <div class="seg" role="tablist" aria-label="Line detail">
              <button v-for="[id, l, n] in TABS" :key="id" type="button" role="tab" :aria-selected="tab === id" :class="{ on: tab === id }" @click="tab = id">{{ l }}<i v-if="n" class="num">{{ n }}</i></button>
            </div>

            <div v-show="tab === 'versions'" class="tl" role="tabpanel" aria-label="Versions">
              <p v-if="!versions.length" class="rule">No upgrades yet. Each generation proposes one; it shows here with its reward once the job is graded.</p>
              <article v-for="v in versions" :key="v.gen" class="ver" :class="v.status">
                <div class="vh"><b>v{{ v.version }}</b><span class="mut">gen {{ v.gen }} · {{ SCOPE[v.scope] ?? v.scope }}</span><span class="sp" />
                  <span class="chip" :class="'v-' + v.status"><Icon :name="VSTATUS[v.status].icon" :size="13" />{{ VSTATUS[v.status].label }}</span></div>
                <p class="txt">{{ v.text }}</p>
                <p class="mut sm">Check: {{ checkText(v.check) }}</p>
                <div class="vf"><span>Reward <b class="num">{{ r1(v.reward) }}</b></span><span>Baseline then <b class="num">{{ r1(v.baseline) }}</b></span><span v-if="v.adherence != null">{{ v.adherence ? "Followed" : "Not followed" }}</span></div>
                <p v-if="v.lesson" class="mut sm">Lesson: {{ v.lesson }}</p>
              </article>
            </div>

            <div v-show="tab === 'picks'" class="tl" role="tabpanel" aria-label="Picks">
              <p v-if="!d.picks.length" class="rule">Not picked yet. Picks start once lines of this role have 5 graded jobs each.</p>
              <template v-else>
                <p class="rule">Chosen in <b class="num">{{ share.chosen }}</b> of the last <b class="num">{{ share.total }}</b> picks it was in<template v-if="share.fallback"> (<b class="num">{{ share.fallback }}</b> fell back to the rubric)</template>.</p>
                <div v-for="p in d.picks" :key="p.id" class="pick" :class="{ me: p.chosen === sel }">
                  <span class="mut num">{{ agoMs(p.ts) }}</span>
                  <span><template v-if="p.fallback">Rubric fallback</template><template v-else>{{ p.chosen === sel ? "Chosen" : `${p.chosen} chosen` }}</template></span>
                  <span class="r num" :title="'This line\'s share of the draws'">{{ p.p == null ? "–" : Math.round(p.p * 100) + "%" }}</span>
                </div>
              </template>
            </div>

            <div v-if="d.root" v-show="tab === 'proposals'" class="tl" role="tabpanel" aria-label="Proposals">
              <p v-if="!d.proposals?.length" class="rule">No proposals from this line. An agent can propose a skill or a rule after a job with reward 4 or more.</p>
              <article v-for="p in d.proposals" :key="p.id" class="ver prop">
                <div class="vh"><b>{{ p.kind === "skill" ? p.name : p.target === "house" ? "House rule" : "Line rule" }}</b><span class="mut">{{ p.kind }} · gen {{ p.gen }} · {{ agoMs(p.created) }}</span><span class="sp" />
                  <span class="chip" :class="'p-' + p.status"><Icon :name="PSTATUS[p.status].icon" :size="13" />{{ PSTATUS[p.status].label }}</span></div>
                <p class="txt">{{ p.kind === "skill" ? p.summary : p.text }}</p>
                <ul v-if="p.files?.length" class="files"><li v-for="f in p.files" :key="f.path"><code>{{ f.path }}</code><span class="mut num">{{ kb(f.bytes) }}</span></li></ul>
                <p v-if="p.ownerOnly" class="mut sm"><Icon name="lock" :size="13" /> Owner only: forward it to the owner and approve only on their word.</p>
                <p v-if="p.status === 'rejected' && p.reason" class="mut sm">Reason: {{ p.reason }}</p>
                <p v-if="p.status === 'approved' && p.applied" class="mut sm">Applied to {{ p.applied }}</p>
                <div v-if="p.status === 'pending'" class="act">
                  <div v-if="p.kind === 'skill'" class="seg sm" role="radiogroup" aria-label="Approve into">
                    <button v-for="[k, l] in [['line', 'This line'], ['base', 'Every agent']] as const" :key="k" type="button" role="radio" :aria-checked="(into[p.id] ?? 'line') === k" :class="{ on: (into[p.id] ?? 'line') === k }" @click="into = { ...into, [p.id]: k }">{{ l }}</button>
                  </div>
                  <label v-if="p.ownerOnly" class="ck"><input v-model="owner[p.id]" type="checkbox" />The owner said yes</label>
                  <span class="btns">
                    <button type="button" class="btn" :disabled="!!busy" :aria-expanded="!!rejecting[p.id]" @click="rejecting = { ...rejecting, [p.id]: !rejecting[p.id] }">Reject</button>
                    <button type="button" class="btn pri" :disabled="!!busy || (p.ownerOnly && !owner[p.id])" @click="decide(p, 'approve')"><Icon v-if="busy === p.id" name="loader" :size="15" class="spin" />Approve</button>
                  </span>
                </div>
                <div class="rj" :class="{ shut: !(p.status === 'pending' && rejecting[p.id]) }">
                  <div><form class="rjf" @submit.prevent="decide(p, 'reject')">
                    <label :for="'rj-' + p.id">Why reject it? The agent's line sees this.</label>
                    <div class="rjr"><input :id="'rj-' + p.id" v-model="reason[p.id]" type="text" maxlength="200" autocomplete="off" /><button type="submit" class="btn" :disabled="!!busy || !(reason[p.id] ?? '').trim()">Confirm reject</button></div>
                  </form></div>
                </div>
                <p v-if="pErr[p.id]" class="rule warn" role="alert">{{ pErr[p.id] }}</p>
              </article>
            </div>
          </div>
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
@import "../ui/side-panel.css";
.ln{flex:1;min-height:0;gap:12px}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}.sp{flex:1}
.upd{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}
.spin{animation:rot 1s linear infinite}@keyframes rot{to{transform:rotate(360deg)}}
.uc{display:grid;align-content:start;gap:10px;padding:18px 20px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.uc h2{display:flex;gap:8px;align-items:center;margin:0;font:600 14px/1.3 var(--body)}.uc h2 small{font-weight:400;color:var(--muted);font-size:13px}.uc h2 small b{color:var(--ink);font-weight:600}
.st{max-width:none}.st code{font:12.5px var(--mono);color:var(--ink)}
.rule{margin:0;color:var(--muted);font-size:13px;line-height:1.45}.rule b{color:var(--ink)}.rule.warn{color:var(--warn)}
.btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink);font:600 13px var(--body);cursor:pointer;justify-self:start}
.btn:hover:not(:disabled){background:var(--track)}.btn:disabled{opacity:.5;cursor:default}.btn:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.btn.pri{background:var(--ink);color:var(--bg);border-color:var(--ink)}.btn.pri:hover:not(:disabled){background:var(--ink);opacity:.88}

/* list + panel: the panel takes a column and pushes the list (playbook §2) */
.wrap{flex:1;min-height:0;display:flex;gap:16px;position:relative}
.wrap>.warn{position:absolute;top:-22px;right:0}
.lst{flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,560px),1fr));align-content:start;grid-auto-rows:max-content;align-items:start;gap:16px}
.lst.pad{padding-bottom:calc(62dvh + 12px)}
.grp{padding:0;gap:0;overflow:hidden;container-type:inline-size}
.grp>h2{padding:14px 16px 8px}
.hd,.row{display:grid;grid-template-columns:minmax(0,1.6fr) 118px 70px 44px 50px minmax(76px,.8fr);gap:10px;align-items:center;padding:0 16px}
.hd{color:var(--muted);font-size:12px;padding-bottom:6px}
.row{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1.6fr) 118px 70px 44px 50px minmax(76px,.8fr);gap:10px;align-items:center;min-height:52px;padding:6px 16px;border-top:1px solid var(--hair);font-size:14px;cursor:pointer;transition:background-color .15s var(--ease)}
.row:hover{background:var(--soft)}.row.on{background:var(--track);box-shadow:inset 3px 0 0 var(--ink)}
.row:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.row.ret .nm b,.row.ret .num{color:var(--muted)}
.nm{display:grid;gap:2px}.nm b{font-weight:600;overflow-wrap:anywhere}.nm small{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.r{text-align:right}.pk{color:var(--muted);font-size:12.5px;text-align:right}
.mini{display:none;color:var(--muted);font-size:12.5px}.mini b{color:var(--ink);font-weight:600}
@container (max-width:400px){.hd{display:none}.row{grid-template-columns:minmax(0,1fr) auto;row-gap:4px}.row>.r,.row>.pk{display:none}.row>.mini{display:block;grid-column:1/-1}}
@container (min-width:401px) and (max-width:520px){.hd,.row{grid-template-columns:minmax(0,1fr) 112px 56px 44px}.hd>:nth-child(4),.hd>:nth-child(6),.row>:nth-child(4),.row>:nth-child(6){display:none}}
.chip{display:inline-flex;align-items:center;gap:5px;justify-self:start;padding:3px 9px 3px 7px;border-radius:999px;font:600 12px/1.2 var(--body);white-space:nowrap;border:1px solid var(--line);color:var(--ink);background:transparent}
.chip.active{border-color:color-mix(in srgb,var(--on) 55%,transparent)}.chip.active :deep(svg){color:var(--on)}
.chip.probation{border-style:dashed;border-color:var(--warn);background:var(--warn-bg)}.chip.probation :deep(svg){color:var(--warn)}
.chip.retired{color:var(--muted);background:var(--track);border-color:transparent}
.chip.v-kept :deep(svg),.chip.p-approved :deep(svg){color:var(--on)}.chip.v-reverted,.chip.p-rejected{color:var(--muted)}.chip.v-pending,.chip.p-pending{border-style:dashed}

/* detail panel: a column of the page at desktop (not floating over the list), a half sheet on phones */
.dp.side-panel{position:relative;top:auto;right:auto;bottom:auto;flex:none;width:clamp(400px,36%,680px);box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}
.dp.side-panel.sheet{position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));top:auto;width:auto;height:62dvh;z-index:48;border-bottom:1px solid var(--line);border-radius:18px 18px 0 0;box-shadow:0 -18px 40px rgba(0,0,0,.35);padding-bottom:0}
.grab{align-self:center;width:40px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--ink) 28%,transparent);margin:8px 0 0;flex:none}
.dh{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid var(--line);flex:none}
.tt{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:1}
.tt h2{margin:0;font:700 18px/1.2 var(--body);overflow-wrap:anywhere;outline:none}
.x{all:unset;box-sizing:border-box;display:grid;place-items:center;width:44px;height:44px;border-radius:10px;color:var(--muted);cursor:pointer;flex:none}.x:hover{color:var(--ink);background:var(--track)}.x:focus-visible{outline:2px solid var(--on)}
.pb{padding:16px;display:grid;gap:12px}
.pbody{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px;display:grid;align-content:start;gap:16px;transition:opacity .2s var(--ease)}.pbody.dim{opacity:.6}
.facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0}
.facts div{display:grid;gap:2px;padding:10px 12px;border-radius:10px;background:var(--soft)}.facts .wide{grid-column:1/-1}
.facts dt{font-size:12px;color:var(--muted)}.facts dd{margin:0;font-weight:600;font-size:15px;overflow-wrap:anywhere}
.chart{display:grid;gap:8px}
h3{display:flex;align-items:center;gap:8px;margin:0;font:600 13px/1.3 var(--body)}
.key{display:inline-flex;align-items:center;gap:6px;font:400 12px var(--body);color:var(--muted)}
.key .kl{width:14px;height:2px;background:var(--on);border-radius:1px}.key .kd{width:8px;height:8px;border-radius:50%;background:var(--muted);margin-left:8px}
.cbox{position:relative;min-height:150px}
.cbox svg{display:block;touch-action:pan-y}
.ax line{stroke:var(--hair);stroke-width:1}.ax text,.axl{fill:var(--muted);font:11px var(--mono)}
.bl{fill:none;stroke:var(--on);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.dot{fill:var(--muted);opacity:.55;stroke:var(--panel);stroke-width:2}
.hb{fill:var(--on);stroke:var(--panel);stroke-width:2}
.xh{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.tip{position:absolute;top:0;transform:translateX(-50%);padding:6px 10px;border-radius:8px;background:var(--ink);color:var(--bg);font-size:12px;line-height:1.4;pointer-events:none;white-space:nowrap}
.seg{display:inline-grid;grid-auto-flow:column;gap:2px;padding:2px;border:1px solid var(--line);border-radius:10px;background:var(--track);justify-self:start}
.seg button{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;transition:background-color .15s var(--ease),color .15s var(--ease)}
.seg button i{font:600 11px/1 var(--mono);font-style:normal;padding:2px 6px;border-radius:999px;background:var(--soft)}
.seg button.on{background:color-mix(in srgb,var(--ink) 13%,transparent);color:var(--ink)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.seg.sm button{min-height:32px;padding:0 10px;font-size:12px}
.tl{display:grid;gap:10px}
.ver{display:grid;gap:8px;padding:12px 14px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}
.ver.reverted{background:var(--soft)}
.vh{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.vh b{font-weight:700;overflow-wrap:anywhere}
.mut{color:var(--muted);font-size:12.5px}.sm{margin:0;font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}.sm :deep(svg){vertical-align:-2px}
.txt{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.vf{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted)}.vf b{color:var(--ink)}
.pick{display:grid;grid-template-columns:76px minmax(0,1fr) 52px;gap:10px;align-items:center;min-height:40px;padding:0 12px;border-radius:10px;font-size:13.5px}
.pick:nth-child(odd){background:var(--soft)}.pick.me span:nth-child(2){font-weight:600}
.files{list-style:none;margin:0;padding:0;display:grid;gap:4px}.files li{display:flex;justify-content:space-between;gap:10px;font-size:12.5px}.files code{font:12px var(--mono);overflow-wrap:anywhere}
.act{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.btns{display:inline-flex;gap:8px;margin-left:auto}
.ck{display:inline-flex;align-items:center;gap:8px;min-height:36px;font-size:13px}.ck input{width:18px;height:18px;accent-color:var(--ink)}
.rj{display:grid;grid-template-rows:1fr;transition:grid-template-rows .24s cubic-bezier(.2,.8,.2,1),opacity .2s var(--ease)}.rj.shut{grid-template-rows:0fr;opacity:0;visibility:hidden}
.rj>div{overflow:hidden;min-height:0}
.rjf{display:grid;gap:6px;padding-top:2px}.rjf label{font-size:12.5px;color:var(--muted)}
.rjr{display:flex;gap:8px}.rjr input{flex:1;min-height:36px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font:13px var(--body)}.rjr input:focus-visible{outline:2px solid var(--on);outline-offset:0}

/* open / close: transform and opacity only */
.dp-enter-active,.dp-leave-active{transition:transform .28s cubic-bezier(.2,.8,.2,1),opacity .2s var(--ease)}
.dp-enter-from,.dp-leave-to{transform:translateX(24px);opacity:0}
.sheet.dp-enter-from,.sheet.dp-leave-to{transform:translateY(100%);opacity:1}
@media (prefers-reduced-motion:reduce){.dp-enter-active,.dp-leave-active{transition:opacity .15s}.dp-enter-from,.dp-leave-to,.sheet.dp-enter-from,.sheet.dp-leave-to{transform:none;opacity:0}.spin{animation:none}.rj,.pbody{transition:none}}
@media (max-width:1279px){.dp.side-panel{width:clamp(360px,46%,560px)}}
@media (max-width:760px){
  .ph{display:none}
  .facts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .lst{grid-template-columns:minmax(0,1fr)}
  .pbody{padding:12px 16px}
}
</style>
