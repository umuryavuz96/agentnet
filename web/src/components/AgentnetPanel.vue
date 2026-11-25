<script setup lang="ts">
// The agent detail panel (Agents page): floats over the map or cards, never resizes them. Desktop: a sheet on the
// right edge; phone: a bottom sheet (the view teleports it to <body> and adds the scrim). Layout after Vercel's
// deployment drawer and the GitHub Actions run sidebar (docs/research/agent-panel.md): header, a row of key numbers,
// "Now" as the loudest block, tasks as a checklist, messages as a thread, identity and hooks folded away.
// Every value comes from the agentnet snapshot row; a field the row does not have is left out, never invented.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AgentTrail from "./AgentTrail.vue";
import { brk } from "../crewTree";
import TrailLine from "./TrailLine.vue";
import Icon from "../ui/Icon.vue";
import AgentnetJobs from "./AgentnetJobs.vue";
import AgentnetControls from "./AgentnetControls.vue";
import AgentnetUsage from "./AgentnetUsage.vue";
import AgentnetScore from "./AgentnetScore.vue";
import { phrase } from "../trail";
import { short, trailView } from "../trailView";
import { earlierJobs, openAsks, planCount, type PlanCount } from "../plan";
import { net, hooks, teams, humanDoing, ctxView, windows, type AgentRow, type HookFire, type Job } from "../net";
import { api, toast } from "../ui/api";

const props = defineProps<{ row: AgentRow | null; name: string; sheet: boolean; startTab?: "trail" }>();
const emit = defineEmits<{ close: []; open: []; closeWin: []; chat: [] }>();

const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const ago = (t: number) => dur(net.now - t) + " ago";
const since = (t?: number) => (t ? dur(net.now - t) : null);
const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const r = computed(() => props.row);
// Trail tab head (map board 10-agent-trail panel): state word, how long in it, model; step count; context ring.
const ST: Record<string, string> = { working: "Working", idle: "Idle", waiting: "Waiting", blocked: "Blocked" };
const thGone = computed(() => !!r.value && (r.value.life === "gone" || r.value.life === "failed"));
const thState = computed(() => (thGone.value ? "closed" : r.value?.state ?? "idle"));
const thFor = computed(() => (!r.value ? "" : thGone.value ? `closed ${short(net.now - r.value.lifeSince)} ago` : `for ${short(net.now - r.value.stateSince)}`));
const thDone = computed(() => (r.value?.tasks ?? []).filter((t) => t.status === "done").length);
// ---- the job plan (plan.ts): the count is brief steps over the fixed total, added steps are a figure of their own ----
const tv = computed(() => (r.value ? trailView(r.value) : null));
const plan = computed<PlanCount | null>(() => tv.value?.plan ?? null);
const job = computed<Job | null>(() => tv.value?.job ?? null);
const asks = computed(() => (r.value ? openAsks(r.value) : []));
const oldestAsk = computed(() => (asks.value.length ? Math.min(...asks.value.map((k) => k.at)) : 0));
/** Jobs before the current one, newest first. Each opens to its steps, read only: the same rail, fed a still row. */
const earlier = computed(() => { const x = r.value; return !x ? [] : earlierJobs(x).map((j) => ({ j, c: planCount(j), row: { ...x, jobs: [j], asks: [], tasks: [], life: "live" as const, state: "idle" as const, action: null, lastTool: null, bg: [] } })); });
const openEarlier = ref(false), openJob = ref(0), seenJobs = ref(new Set<number>());
const toggleJob = (id: number) => { seenJobs.value.add(id); openJob.value = openJob.value === id ? 0 : id; };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const TH_C = 2 * Math.PI * 18;
const isRoot = computed(() => props.name === "root");
const gone = computed(() => !!r.value && (r.value.life === "gone" || r.value.life === "failed"));
const dot = computed(() => {
  const x = r.value; if (!x) return "root";
  if (x.life === "starting") return "starting";
  if (x.name === "root" && gone.value) return "notrunning";
  if (x.life === "stopping" || gone.value) return "stopping";
  return x.state;
});
const DOT_LABEL: Record<string, string> = { root: "director", starting: "starting", stopping: "stopping", working: "working", idle: "idle", notrunning: "not running", waiting: "waiting for input", blocked: "blocked" };
const model = computed(() => r.value?.model?.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "") ?? null);
const modelChip = computed(() => (model.value ? model.value + (r.value?.effort ? " · " + r.value.effort : "") : null));
const stateText = computed(() => (r.value?.name === "root" && gone.value ? "Not running" : r.value ? (r.value.life === "live" ? r.value.state : r.value.life) : ""));
const stateFor = computed(() => (r.value ? since(r.value.life === "live" ? r.value.stateSince : r.value.lifeSince) : null));
const ctx = computed(() => ctxView(r.value));
const ctxPct = computed(() => (ctx.value ? Math.min(100, Math.round(ctx.value.pct)) : 0));
const RING = 2 * Math.PI * 15;
const resets = computed(() => { const t = r.value?.weekly?.resetsAt ? Date.parse(r.value.weekly.resetsAt) : NaN; return Number.isFinite(t) ? dur(t - net.now) : null; });
const rep = computed(() => r.value?.reported ?? null);
// The bar is task-derived (server progressPct); the agent's own % only shows as "current task ~n%" while one task is in progress.
// The doing line comes from the agent's own report while it is fresh on the server; show its age and dim it past 3 min.
const fromReport = computed(() => !!rep.value?.doing && r.value?.doing === rep.value.doing);
const repOld = computed(() => !!rep.value && net.now - rep.value.at > 180_000);
const prog = computed(() => (typeof r.value?.progressPct === "number" ? r.value.progressPct : null));
/** Every task done and nothing in progress: a full bar read as "still running", so it becomes a plain line. */
const allDone = computed(() => tasks.value.length > 0 && tasks.value.every((t) => t.status === "done"));
const curPct = computed(() => (rep.value?.progress != null && tasks.value.filter((t) => t.status === "in_progress").length === 1 ? Math.round(rep.value.progress) : null));
const tasks = computed(() => r.value?.tasks ?? []);
const done = computed(() => tasks.value.filter((t) => t.status === "done").length);
// Lifecycle hint only (never auto-closes): every task done and idle for over 10 minutes.
const goalReview = computed(() => !!r.value?.goal && r.value.life === "live" && r.value.state === "idle" && allDone.value && net.now - r.value.stateSince > 600_000);

const idRows = computed(() => {
  const x = r.value; if (!x) return [];
  const rows: [string, string | null, string?][] = [
    ["Reports to", x.boss], ["Model", x.model ? x.model + (x.effort ? " · " + x.effort : "") : null], ["Brain", x.soul ?? null], ["Why these", x.audit ?? null],
    ["Project", x.project?.split("/").filter(Boolean).pop() ?? null, x.project ?? undefined], ["Up since", x.spawnedAt ? `${new Date(x.spawnedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} (${since(x.spawnedAt)})` : null],
    ["Session", x.session ? x.session.slice(0, 8) : null, x.session ?? undefined], ["PID", x.pid ? String(x.pid) : null],
  ];
  return rows.filter((y): y is [string, string, string?] => !!y[1]);
});
// Hooks for THIS agent: the last fires the service logged under its name (GET /agent-hooks/fires?agent=), topped up live from the shared hook stream.
const agentFires = ref<HookFire[]>([]);
async function loadFires() {
  const n = props.name; if (!n) return;
  try { const j = await api<{ fires?: HookFire[] }>(`v1/panel/hooks/fires?agent=${encodeURIComponent(n)}&limit=30`); if (n === props.name) agentFires.value = j.fires ?? []; } catch { /* keeps the last list */ }
}
watch(() => props.name, () => { agentFires.value = []; void loadFires(); }, { immediate: true });
watch(() => hooks.fires[0], (f) => { if (f && f.agent === props.name && !agentFires.value.some((x) => x.at === f.at && x.script === f.script)) agentFires.value = [f, ...agentFires.value].slice(0, 30); });
const failed = computed(() => agentFires.value.filter((f) => !f.ok && !f.skipped).length);

const openId = ref(false), openHooks = ref(false);
const teamName = computed(() => { const t = teams.list.find((x) => x.members.includes(props.name)); return t ? (t.name || t.id) : null; });
const projectName = computed(() => r.value?.project?.split("/").filter(Boolean).pop() ?? null);

// ---- action bar (board page 03): Message, Open window, Interrupt, More; Stop asks inside the pane ----
const menuOpen = ref(false), stopAsk = ref(false), acting = ref("");
const canAct = computed(() => !!r.value && r.value.life === "live" && !isRoot.value);
const openTasks = computed(() => (plan.value && tv.value ? tv.value.steps.filter((t) => t.status === "pending" || t.status === "in_progress").length : tasks.value.length - done.value));
async function post(what: "stop" | "despawn", ok: string) {
  if (acting.value) return; acting.value = what;
  try { await api(`v1/panel/agents/${encodeURIComponent(props.name)}/${what}`, { method: "POST" }); toast(ok); if (what === "despawn") { stopAsk.value = false; emit("close"); } }
  catch (e) { toast(`${what === "stop" ? "Interrupt" : "Stop"} failed: ${(e as Error).message}`); }
  finally { acting.value = ""; }
}
const interrupt = () => post("stop", `Interrupted ${props.name}`);
const stopAgent = () => post("despawn", `Stopped ${props.name}`);
/** The chat is its own view now (owner 8362): Message and an ask open it. */
const goMsg = () => { menuOpen.value = false; emit("chat"); };

// Segmented tabs: Now | Trail | Usage (the chat left the panel, owner 8362). Background jobs are a fixed collapsible panel under them, visible on both. Switching slides the body a few px and fades (transform + opacity only).
const TABS = [{ id: "now", label: "Now" }, { id: "trail", label: "Trail" }, { id: "usage", label: "Usage" }] as const;
type Tab = (typeof TABS)[number]["id"];
const tab = ref<Tab>(props.startTab ?? "now"); // the team panel's Plans tab opens an agent on its Trail
const tabIdx = computed(() => TABS.findIndex((t) => t.id === tab.value));
const slide = ref("fwd");
const setTab = (t: Tab) => { slide.value = TABS.findIndex((x) => x.id === t) > tabIdx.value ? "fwd" : "back"; tab.value = t; nextTick(() => { if (el.value) { const b = el.value.querySelector<HTMLElement>(".bd"); if (b) b.scrollTop = 0; } }); };
function tabKey(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
  e.preventDefault(); const n = TABS[(tabIdx.value + d + TABS.length) % TABS.length].id; setTab(n);
  nextTick(() => el.value?.querySelector<HTMLElement>(`[data-tab="${n}"]`)?.focus());
}
watch(() => props.name, () => { tab.value = "now"; menuOpen.value = false; stopAsk.value = false; openEarlier.value = false; openJob.value = 0; seenJobs.value.clear(); });

// ---- phone: drag the sheet down by its header to close it ----
const el = ref<HTMLElement | null>(null);
let drag: { y: number; dy: number; id: number } | null = null;
const onDown = (e: PointerEvent) => { if (!props.sheet || (e.target as Element).closest("button")) return; drag = { y: e.clientY, dy: 0, id: e.pointerId }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); };
const onMove = (e: PointerEvent) => { if (!drag || !el.value) return; drag.dy = Math.max(0, e.clientY - drag.y); el.value.style.transition = "none"; el.value.style.transform = `translateY(${drag.dy}px)`; };
const onUp = () => {
  if (!drag || !el.value) return;
  const close = drag.dy > 90; drag = null;
  el.value.style.transition = ""; el.value.style.transform = "";
  if (close) emit("close");
};
/** Phone sheet is modal: Tab stays inside it. */
function trap(e: KeyboardEvent) {
  if (!props.sheet || e.key !== "Tab" || !el.value) return;
  const f = [...el.value.querySelectorAll<HTMLElement>("button:not([disabled]),[href],[tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
// The header floats over the body: its measured height becomes --hd-h so the first row clears it at rest.
let hdRo: ResizeObserver | null = null;
onMounted(() => {
  const a = el.value, h = a?.querySelector<HTMLElement>(":scope > .hd");
  if (!a || !h || typeof ResizeObserver === "undefined") return;
  hdRo = new ResizeObserver(() => a.style.setProperty("--hd-h", h.offsetHeight + "px"));
  hdRo.observe(h);
});
onBeforeUnmount(() => hdRo?.disconnect());
defineExpose({ el });
</script>

<template>
  <aside ref="el" :class="['ap', 'side-panel', 'glass-strong', { sheet }]" :role="sheet ? 'dialog' : 'complementary'" :aria-modal="sheet || undefined" :aria-label="`${name} details`" tabindex="-1" @keydown="trap">
    <header class="hd" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <span v-if="sheet" class="grab" aria-hidden="true" />
      <div class="t1">
        <div class="tt"><i :class="['hdot', 'h-' + dot]" role="img" :aria-label="dot" />
        <h2 class="ap-nm" :title="name">{{ brk(name) }}</h2>
        <span v-if="modelChip" class="ap-chip" :title="r?.model ?? ''">{{ modelChip }}</span>
        <span v-if="teamName" class="ap-chip tm">{{ teamName }}</span></div>
        <button type="button" class="x" data-close aria-label="Close panel" @click="emit('close')"><Icon name="x" :size="20" /></button>
      </div>
      <div class="fold-r hdf"><div class="fold-in">
      <p v-if="r?.goal || r?.job || isRoot" class="goal-t">{{ r?.goal ?? r?.job ?? "Director of every agent · main session" }}</p>
      <TrailLine v-if="r && !isRoot" class="hdtl" :row="r" />
      <p v-if="r?.boss" class="boss">Reports to <a :href="'#/agents?agent=' + encodeURIComponent(r.boss)">{{ r.boss }}</a><template v-if="projectName"> · {{ projectName }}</template></p>
      </div></div>
      <div class="tabs" role="tablist" aria-label="Agent sections" @keydown="tabKey">
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" :id="`ap-tab-${t.id}`" :data-tab="t.id" :aria-selected="tab === t.id" :aria-controls="`ap-pn-${t.id}`" :tabindex="tab === t.id ? 0 : -1" :class="{ on: tab === t.id }" @click="setTab(t.id)">{{ t.label }}<span v-if="t.id === 'trail' && tv?.count" class="tc ap-num">{{ tv.count }}</span></button>
      </div>
    </header>

    <div class="bd">
     <Transition :name="'tab-' + slide" mode="out-in">
      <div :id="`ap-pn-${tab}`" :key="tab" class="ap-pn" role="tabpanel" :aria-labelledby="`ap-tab-${tab}`">
      <p v-if="!r" class="none">No live reading for {{ name }} yet.</p>
      <template v-else-if="tab === 'now'">
        <!-- Now: the loudest block, GitHub Actions style -->
        <section :class="['now', { working: dot === 'working', blocked: !!rep?.blockedOn }]" aria-label="Now">
          <p v-if="rep?.blockedOn" class="blk"><Icon name="triangle-alert" :size="16" /><span>Blocked on {{ rep.blockedOn }}</span></p>
          <p v-if="r.doing" :class="['doing', { dim: fromReport && repOld }]">{{ humanDoing(r.doing) }}<span v-if="fromReport" class="rage">reported {{ ago(rep!.at) }}</span></p>
          <p v-else-if="!rep?.blockedOn" class="none">Nothing running.</p>
          <p v-if="r.action" class="tool"><Icon name="loader" :size="14" class="ap-spin" /><span>{{ phrase(r.action) }}</span></p>
          <div class="n3">
            <div v-if="plan"><span class="lbl">Plan</span><b class="ap-num">{{ tv!.count }}<span v-if="plan.added" :class="['plus', { grew: plan.grew }]">+{{ plan.added }}</span></b></div>
            <div v-else><span class="lbl">Tasks</span><b class="ap-num">{{ prog != null ? prog + "%" : "none" }}</b></div>
            <div><span class="lbl">Context</span><b class="ap-num">{{ ctx ? ctxPct + "%" : "none" }}</b></div>
            <div><span class="lbl">Cost so far</span><b class="ap-num">{{ r.cost != null ? "$" + r.cost.toFixed(2) : "none" }}</b></div>
          </div>
        </section>
        <section v-if="tv?.n" class="sec" aria-label="Trail peek">
          <h3>Trail</h3>
          <AgentTrail :row="r" peek />
        </section>
        <button v-if="asks.length" type="button" class="ask-1" title="Opens the Trail tab" @click="setTab('trail')"><b>{{ asks.length }} open {{ asks.length === 1 ? "ask" : "asks" }}</b><span>oldest {{ short(net.now - oldestAsk) }}</span><Icon name="chevron-down" :size="16" /></button>
        <section v-if="r.lastMsg" class="sec" aria-label="Last message">
          <h3>Last message</h3>
          <p class="lm">{{ r.lastMsg.dir === "out" ? "to" : "from" }} {{ r.lastMsg.peer }} · {{ r.lastMsg.kind }} · {{ ago(r.lastMsg.at) }}<template v-if="r.lastTool"><br /><span>{{ phrase(r.lastTool) }}</span> · {{ ago(r.lastTool.at) }}</template></p>
        </section>
        <AgentnetJobs mode="jobs" :name="name" :tasks="tasks" />
        <AgentnetControls v-if="!isRoot && !gone" mode="schedules" :name="name" />
      </template>
      <section v-else-if="tab === 'trail'" class="sec" aria-label="Trail">
        <div class="th">
          <div class="th-st"><span :class="['th-w', 's-' + thState]">{{ thGone ? "Closed" : ST[thState] }}</span><span class="th-sm">{{ thFor }}<span v-if="r.model" class="th-chip">{{ r.model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2") }}</span></span></div>
          <div class="th-big"><span class="th-row"><b class="ap-num">{{ tv?.count || "–" }}</b><span v-if="plan?.added" :class="['plus', { grew: plan.grew }]" :title="`${plan.added} ${plan.added === 1 ? 'step' : 'steps'} added after the plan was set`">+{{ plan.added }}</span></span><span class="th-lbl">{{ plan ? "brief steps" : "steps" }}</span></div>
          <div :class="['th-ring', { hi: ctxPct >= 80 }]" role="img" :aria-label="`Context used ${ctx ? ctxPct : 0} percent`"><svg viewBox="0 0 44 44"><circle class="rt" cx="22" cy="22" r="18" /><circle v-if="ctx" class="rf" cx="22" cy="22" r="18" :stroke-dasharray="TH_C.toFixed(1)" :stroke-dashoffset="(TH_C * (1 - ctxPct / 100)).toFixed(1)" /></svg><span>{{ ctx ? ctxPct + "%" : "–" }}</span></div>
        </div>
        <h3 v-if="plan && job" class="trh"><span class="tl">Job {{ job.id }} · plan</span><span v-if="plan.grew" class="grew-c" title="The plan grew by more than half of the brief's steps">Scope grew</span><span class="sp" /><span class="ap-num">{{ job.closedAt != null ? "closed " + time(job.closedAt) : `opened ${time(job.openedAt)} by ${job.openedBy}` }}</span></h3>
        <h3 v-else-if="tasks.length" class="trh"><span class="tl">Trail</span><span class="sp" /><span class="ap-num">{{ thDone }} of {{ tasks.length }} done</span></h3>
        <AgentTrail :row="r" @msg="goMsg" />
        <section v-if="asks.length" class="asks-b" aria-label="Open asks">
          <p class="asks-h"><span class="tl">Open asks</span><span class="ap-num">{{ asks.length }}</span></p>
          <p class="asks-hint">An ask closes when {{ name }} replies to that message.</p>
          <ul class="asks"><li v-for="k in asks" :key="k.id"><button type="button" class="ask" :title="`Opens the messages (message ${k.id})`" @click="goMsg"><span class="id">#{{ k.id }}</span><span class="sj">{{ k.subject }}</span><span class="mt">{{ k.from }} · {{ short(net.now - k.at) }}</span></button></li></ul>
        </section>
        <section v-if="earlier.length" class="fold ej">
          <button type="button" class="fh" :aria-expanded="openEarlier" aria-controls="ap-ej" @click="openEarlier = !openEarlier"><span>Earlier jobs</span><span class="ap-hint ap-num">{{ earlier.length }}</span><Icon name="chevron-down" :size="16" class="cv-i" /></button>
          <div id="ap-ej" class="fb" :class="{ 'is-open': openEarlier }" :inert="!openEarlier || undefined"><div>
            <div v-for="e in earlier" :key="e.j.id" class="job">
              <button type="button" class="job-h" :aria-expanded="openJob === e.j.id" :aria-controls="`ap-ej-${e.j.id}`" @click="toggleJob(e.j.id)">
                <span class="jn">Job {{ e.j.id }}</span><span class="jg">{{ e.j.goal ?? e.j.brief ?? "No goal written" }}</span>
                <span class="job-m"><span :class="['out', { bad: e.j.outcome !== 'done' }]">{{ cap(e.j.outcome ?? "open") }}</span><span v-if="!e.j.legacy">{{ e.c.done }}/{{ e.c.plan }}<template v-if="e.c.added"> +{{ e.c.added }}</template></span><span v-else>{{ e.j.steps.filter((x) => x.status === "done").length }}/{{ e.j.steps.length }}</span><span>{{ e.j.grade != null ? "grade " + e.j.grade : "not graded" }}</span><span v-if="e.j.closedAt != null">closed {{ time(e.j.closedAt) }}</span></span>
              </button>
              <div :id="`ap-ej-${e.j.id}`" class="fb" :class="{ 'is-open': openJob === e.j.id }" :inert="openJob !== e.j.id || undefined"><div><AgentTrail v-if="seenJobs.has(e.j.id)" :row="e.row" @msg="goMsg" /></div></div>
            </div>
          </div></div>
        </section>
      </section>
      <template v-else-if="tab === 'usage'">
        <!-- key numbers, Vercel-style: one glance before any detail -->
        <div class="ap-hero">
          <div class="ap-tile">
            <span class="lbl">State</span>
            <b :class="['ap-st', 's-' + dot]">{{ stateText }}</b>
            <span v-if="stateFor" class="sm">for {{ stateFor }}</span>
            <span v-if="r.life === 'gone' && r.goneReason" class="sm">{{ r.goneReason }}</span>
          </div>
          <div class="ap-tile ctx" :title="ctx ? `${tok(ctx.tokens)} of ${tok(ctx.window)} tokens` : 'No context reading yet'">
            <svg viewBox="0 0 36 36" class="ring" role="progressbar" aria-label="Context used" :aria-valuenow="ctxPct" aria-valuemin="0" aria-valuemax="100">
              <circle cx="18" cy="18" r="15" class="rt" />
              <circle v-if="ctx" cx="18" cy="18" r="15" :class="['rf', { hi: ctxPct >= 80 }]" :stroke-dasharray="RING" :stroke-dashoffset="RING * (1 - ctxPct / 100)" />
            </svg>
            <div class="cv">
              <span class="lbl">Context</span>
              <b class="ap-num">{{ ctx ? ctxPct + "%" : "–" }}</b>
              <span v-if="ctx" class="sm ap-num">{{ tok(ctx.tokens) }} / {{ tok(ctx.window) }}</span>
            </div>
          </div>
          <div v-if="r.cost != null" class="ap-tile">
            <span class="lbl">Cost</span>
            <b class="ap-num">${{ r.cost.toFixed(2) }}</b>
          </div>
          <div v-if="r.weekly" class="ap-tile">
            <span class="lbl">Weekly</span>
            <b class="ap-num">{{ Math.round(r.weekly.pct) }}%</b>
            <span v-if="resets" class="sm">resets in {{ resets }}</span>
          </div>
        </div>

        <AgentnetUsage compact :only="name" class="ap-usage" />
        <AgentnetScore v-if="!isRoot" :only="name" class="ap-score" />
      <section v-if="r && idRows.length" class="sec fold">
        <button type="button" class="fh" :aria-expanded="openId" aria-controls="ap-id" @click="openId = !openId">
          <span>Details</span><span class="ap-hint">{{ isRoot ? "session, pid" : "project, session, brain" }}</span><Icon name="chevron-down" :size="16" class="cv-i" />
        </button>
        <div id="ap-id" class="fb" :class="{ 'is-open': openId }" :inert="!openId || undefined">
          <div><dl class="ap-kv"><template v-for="[k, v, full] in idRows" :key="k"><dt>{{ k }}</dt><dd :title="full ?? v" class="mono">{{ v }}</dd></template></dl></div>
        </div>
      </section>

      <section class="sec fold">
        <button type="button" class="fh" :aria-expanded="openHooks" aria-controls="ap-hk" @click="openHooks = !openHooks">
          <span>Hooks</span><span class="ap-hint ap-num">{{ agentFires.length ? `${agentFires.length} ${agentFires.length === 1 ? "fire" : "fires"}${failed ? " · " + failed + " failed" : ""}` : "none yet" }}</span><Icon name="chevron-down" :size="16" class="cv-i" />
        </button>
        <div id="ap-hk" class="fb" :class="{ 'is-open': openHooks }" :inert="!openHooks || undefined">
          <div>
            <ul v-if="agentFires.length" class="hk">
              <li v-for="(f, i) in agentFires" :key="f.script + f.at + i" :class="{ off: f.skipped }"><i :class="{ bad: !f.ok && !f.skipped }" /><b :title="f.reason ?? f.name">{{ f.name }}</b><span v-if="f.skipped">skipped</span><span v-else-if="!f.ok" class="bad">failed</span><span v-else-if="f.ms != null" class="ap-num">{{ f.ms }} ms</span><time>{{ ago(f.at) }}</time></li>
            </ul>
            <p v-else class="none">No hook has fired for {{ name }} yet.</p>
          </div>
        </div>
      </section>
      </template>
      </div>
     </Transition>
    </div>

    <footer v-if="r" class="bar">
      <div v-if="stopAsk" class="confirm" role="alertdialog" :aria-label="`Stop ${name}?`" @keydown.esc.stop="stopAsk = false">
        <p><b>Stop {{ name }}?</b> Its turn ends now and its window closes. <template v-if="openTasks && plan && job">Job {{ job.id }} closes as dropped and its {{ openTasks }} open {{ openTasks === 1 ? "step is" : "steps are" }} marked unfinished.</template><template v-else-if="openTasks">Its {{ openTasks }} open {{ openTasks === 1 ? "task stays" : "tasks stay" }} on the list for whoever picks {{ openTasks === 1 ? "it" : "them" }} up.</template> Its boss gets a message.</p>
        <div class="row"><button type="button" class="btn sm solid-danger" :disabled="!!acting" @click="stopAgent"><Icon name="square" :size="15" /> Stop agent</button><button type="button" class="btn sm ghost" :disabled="!!acting" @click="stopAsk = false">Cancel</button></div>
      </div>
      <div v-else class="row">
        <button type="button" class="btn sm pri" @click="goMsg"><Icon name="send" :size="15" /> Message</button>
        <button type="button" class="btn sm" :disabled="!windows.available || !!windows.busy || gone" @click="emit('open')"><Icon name="app-window" :size="15" /> Open window</button>
        <span class="sp" />
        <button v-if="canAct" type="button" class="btn sm ghost" :disabled="!!acting" title="End the current turn; the agent stays alive" @click="interrupt"><Icon name="circle-stop" :size="15" /> Interrupt</button>
        <button type="button" class="btn sm ghost ico" aria-label="More actions" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><Icon name="ellipsis" :size="18" /></button>
      </div>
      <div v-if="menuOpen && !stopAsk" class="menu" role="menu">
        <button type="button" role="menuitem" :disabled="!windows.available || !!windows.busy" @click="menuOpen = false; emit('closeWin')"><Icon name="x" :size="16" /> Close window</button>
        <a v-if="teamName" role="menuitem" :href="'#/agents?team=' + encodeURIComponent(teams.list.find((x) => x.members.includes(name))?.id ?? '')" @click="menuOpen = false"><Icon name="users" :size="16" /> Open team</a>
        <hr v-if="canAct" />
        <button v-if="canAct" type="button" role="menuitem" class="bad" @click="menuOpen = false; stopAsk = true"><Icon name="square" :size="16" /> Stop agent</button>
      </div>
    </footer>
  </aside>
</template>

<style scoped>
.hdot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--off)}
.h-working{background:var(--on)}.h-idle{background:var(--muted)}.h-waiting{background:var(--warn)}.h-blocked{background:var(--bad)}.h-starting{background:transparent;border:2px dashed var(--muted)}
/* Desktop: a sheet over the right edge of the map/cards area. The view decides where it sits; this file draws it. */
.hd{position:absolute;top:0;left:0;right:0;z-index:6;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px 12px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 72%,transparent);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);box-shadow:0 6px 14px -10px rgba(0,0,0,.45)}
.t1{display:flex;align-items:flex-start;gap:8px}.tt{flex:1;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px}.t1 .x{flex:none;margin-left:0}
.ap-nm{flex:0 1 auto;min-width:0;margin:0;text-transform:none;color:var(--ink);overflow-wrap:anywhere;font:700 18px/1.2 var(--body);letter-spacing:-.01em}
.ap-chip{flex:none;max-width:100%;overflow-wrap:anywhere;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11.5px/1.3 var(--mono)}
.x{flex:none;margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer;transition:background-color .2s var(--ease)}
.x:hover{background:var(--track)}
.x:focus{outline:none}
.x:focus-visible,.fh:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.boss{margin:0;color:var(--muted);font-size:13px}.boss a{color:var(--ink);font-weight:600;text-decoration:none}.boss a:hover{text-decoration:underline}
.ap-chip.tm{font-family:var(--body)}
.tc{font-weight:500;opacity:.75}
.bar{flex:none;position:relative;padding:12px 16px;border-top:1px solid var(--line);background:var(--panel-2)}
.bar .row{display:flex;align-items:center;gap:8px}.bar .sp{flex:1}
.bar .btn{white-space:nowrap;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding-inline:12px}
.bar .btn.pri{background:var(--ink);color:var(--bg);border-color:var(--ink)}.bar .btn.ico{padding-inline:8px}
.bar .btn.solid-danger{color:#fff;background:var(--bad);border-color:var(--bad)}
.confirm{display:grid;gap:10px}.confirm p{margin:0;font-size:14px;line-height:1.45}
.menu{position:absolute;right:16px;bottom:calc(100% - 4px);width:240px;display:grid;padding:6px;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),0 18px 40px -16px rgb(0 0 0/.55);z-index:3}
.menu > *{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;min-height:40px;padding:0 10px;border-radius:8px;font:500 14px var(--body);color:var(--ink);cursor:pointer}
.menu > *:hover,.menu > *:focus-visible{background:var(--track)}.menu .bad{color:var(--bad)}.menu hr{all:unset;display:block;border-top:1px solid var(--line);margin:4px 6px;min-height:0;padding:0}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-left:-8px}
.acts .btn{display:inline-flex;align-items:center;gap:5px;min-height:36px;padding-inline:8px}
.ap-dot{flex:none;width:11px;height:11px;border-radius:50%;background:var(--off)}
.ap-dot.s-working{background:var(--on);animation:pulse 1.6s var(--ease) infinite}
.ap-dot.s-waiting{background:var(--warn)}
.ap-dot.s-blocked{background:var(--bad)}
.ap-dot.s-starting{background:transparent;border:2px dashed var(--muted)}
.ap-dot.s-root{background:var(--lock)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}

.bd{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:calc(16px + var(--hd-h,0px)) 16px 16px;display:grid;align-content:start;gap:16px}
.none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.ap-num{font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;word-break:break-word}
.lbl{color:var(--muted);font:600 12px/1.2 var(--body)}
.sm{color:var(--muted);font-size:12px;line-height:1.3}

.ap-hero{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.ap-tile{display:grid;align-content:start;gap:3px;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.ap-tile b{font:700 17px/1.2 var(--body);overflow-wrap:anywhere}
.ap-st::first-letter{text-transform:uppercase}
.ap-st.s-working{color:var(--on)} .ap-st.s-waiting{color:var(--warn)} .ap-st.s-blocked{color:var(--bad)}
.ap-tile.ctx{grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px}
.cv{display:grid;gap:3px}
.ring{width:38px;height:38px;transform:rotate(-90deg)}
.rt,.rf{fill:none;stroke-width:4}
.rt{stroke:var(--track)}
.rf{stroke:var(--on);stroke-linecap:round;transition:stroke-dashoffset .5s var(--ease)}
.rf.hi{stroke:var(--warn)}

.n3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.n3 > div{display:grid;gap:2px}.n3 b{font:700 18px/1.2 var(--body)}
.nx{list-style:none;margin:0;padding:0;display:grid;gap:6px}.nx li{display:flex;gap:8px;align-items:flex-start;font-size:13.5px;line-height:1.35}.nx li span{overflow-wrap:anywhere}
.lm{margin:0;font-size:13px;line-height:1.5;color:var(--muted)}
.now{display:grid;gap:8px;padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--off);border-radius:14px;background:color-mix(in srgb,var(--ink) 5%,transparent)}
.now.working{border-left-color:var(--on);background:color-mix(in srgb,var(--on) 7%,transparent)}
.now.blocked{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent)}
.goal{display:grid;gap:6px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.goal-t{margin:0;font:500 14px/1.4 var(--body);overflow-wrap:anywhere}
.goal-hint{margin-left:auto;font-family:var(--body);color:var(--warn)}
.now-h{display:flex;align-items:center;gap:8px}
.now-h .ap-ph{margin-left:auto;font-family:var(--body);max-width:60%}
.blk{display:flex;gap:7px;align-items:flex-start;margin:0;padding:8px 10px;border-radius:10px;background:var(--warn-bg);color:var(--warn);font:600 13.5px/1.35 var(--body);overflow-wrap:anywhere}
.blk .icon{flex:none;margin-top:1px}
.doing{margin:0;font:600 15.5px/1.35 var(--body);overflow-wrap:anywhere;transition:opacity .2s var(--ease)}
.doing.dim{opacity:.6}
.rage{display:block;margin-top:2px;color:var(--muted);font:500 12px/1.3 var(--body)}
.tool{display:flex;gap:7px;align-items:flex-start;margin:0;color:var(--ink)}
.tool .icon{flex:none;margin-top:2px;color:var(--on)}
.pb{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;font-size:12.5px}
.ap-bar{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.ap-bar i{display:block;height:100%;border-radius:3px;background:var(--on);transition:width .4s var(--ease)}
.ap-bar.thin{height:4px;margin:-2px 0 8px}
.ap-kv{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 12px;font-size:12.5px;line-height:1.4}
.ap-kv dt{color:var(--muted);white-space:nowrap}
.ap-kv dd{margin:0;overflow-wrap:anywhere}
.ok{color:var(--on)} .bad{color:var(--bad)}

.sec h3{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;color:var(--muted);font:600 13px/1.2 var(--body)}
.th{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:14px;align-items:center;padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid color-mix(in srgb,var(--ink) 6%,transparent)}
.th-st{display:flex;flex-direction:column;gap:4px;min-width:0}
.th-w{font:600 11px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.th-w.s-working{color:var(--on)}.th-w.s-waiting{color:var(--pend)}.th-w.s-blocked{color:var(--bad)}
.th-sm{color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.th-chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;margin-left:4px;border-radius:999px;font:600 11px/1 var(--mono);letter-spacing:.02em;color:var(--muted);background:color-mix(in srgb,var(--ink) 6%,transparent);white-space:nowrap}
.th-big{display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.th-big b{font:600 22px/1 var(--mono);color:var(--ink);opacity:1}
.th-row{display:flex;align-items:baseline;gap:6px}
/* steps added after the plan was set: muted, amber once the plan grew by more than half */
.plus{font:600 12px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.plus.grew{color:var(--pend)}
.n3 b .plus{margin-left:5px}
.grew-c{display:inline-flex;align-items:center;min-height:20px;padding:0 7px;border-radius:999px;font:600 11px/1 var(--body);white-space:nowrap;color:var(--pend);background:color-mix(in srgb,var(--pend) 12%,transparent)}
/* open asks: what a boss asked by message and got no reply to yet */
.asks-b{display:grid;gap:8px;margin-top:16px}
.asks-h{display:flex;align-items:baseline;gap:8px;margin:0}
.asks-h .tl{font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.asks-h .ap-num{font:600 12px/1 var(--mono);color:var(--ink)}
.asks-hint{margin:-4px 0 0;color:var(--muted);font-size:12px;line-height:1.35}
.asks{list-style:none;margin:0;padding:0;display:grid;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
.asks li+li{border-top:1px solid var(--line)}
.ask{display:grid;grid-template-columns:auto minmax(0,1fr) auto;column-gap:10px;align-items:baseline;width:100%;min-height:44px;padding:10px 12px;border:0;background:transparent;color:var(--ink);text-align:left;cursor:pointer;font:400 13px/1.4 var(--body)}
.ask:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.ask:focus-visible,.ask-1:focus-visible,.job-h:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ask .id,.ask .mt{font:500 11px/1.5 var(--mono);color:var(--muted)}
.ask .sj{overflow-wrap:anywhere}
.ask .mt{white-space:nowrap}
.ask-1{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:12px;background:transparent;box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);text-align:left;cursor:pointer;font:400 13px/1.3 var(--body)}
.ask-1 b{font-weight:600}.ask-1 span{color:var(--muted)}.ask-1 .icon{margin-left:auto;color:var(--muted);transform:rotate(-90deg)}
/* earlier jobs: one row per job, a row opens to its steps */
.ej{margin-top:16px}
.job{display:grid;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}
.job-h{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:10px;row-gap:4px;align-items:baseline;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:12px;background:transparent;color:var(--ink);text-align:left;cursor:pointer;font:400 13px/1.4 var(--body)}
.job-h .jn{font:600 11px/1.5 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.job-h .jg{overflow-wrap:anywhere}
.job-m{grid-column:2;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font:500 12px/1.4 var(--mono);color:var(--muted)}
.job-m .out{font-family:var(--body);font-weight:600;color:var(--ink)}
.job-m .out.bad{color:var(--bad)}
.job>.fb>div{padding-inline:12px}
.job>.fb.is-open>div{padding-bottom:12px}
.th-lbl{font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.th-ring{position:relative;width:44px;height:44px}
.th-ring svg{width:44px;height:44px;transform:rotate(-90deg)}
.th-ring circle{fill:none;stroke-width:3.5}
.th-ring .rt{stroke:color-mix(in srgb,var(--fiber) 35%,transparent)}
.th-ring .rf{stroke:var(--lit);stroke-linecap:round}
.th-ring.hi .rf{stroke:var(--pend)}
.th-ring span{position:absolute;inset:0;display:grid;place-items:center;font:600 11px/1 var(--mono);color:var(--ink)}
.trh{margin-bottom:12px}.trh .sp{flex:1}.trh .tl{font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase}.trh .ap-num{font:500 12px/1 var(--mono);color:var(--muted);opacity:1}
.sec h3 .ap-num{letter-spacing:0;color:var(--ink);opacity:.8}
/* folded sections: animated open/close via grid rows 0fr -> 1fr */
.fold{border-top:1px solid var(--line);padding-top:4px}
.fh{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;text-align:left;font:600 13px/1.2 var(--body)}
.fh .ap-hint{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none;letter-spacing:0;font-weight:500;opacity:.75}
.cv-i{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.fh[aria-expanded="true"] .cv-i{transform:rotate(180deg)}
.fb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.fb.is-open{grid-template-rows:1fr;opacity:1}
.fb > div{overflow:hidden;display:grid;gap:8px;visibility:hidden;transition:padding .3s cubic-bezier(.2,.8,.2,1),visibility 0s .3s}
.fb.is-open > div{visibility:visible;transition-delay:0s}
.fb.is-open > div{padding-bottom:6px}
.hk{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:12.5px}
.hk li{display:flex;align-items:center;gap:8px}
.hk i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--off)} /* ok = muted grey, failed = red; amber stays for waiting */
.hk li.idle,.hk li.off{opacity:.6}
.hk li.off i{background:var(--off)}
.hk i.bad{background:var(--bad)}
.hk b{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hk span{flex:none;color:var(--muted)}
.hk time{flex:none;color:var(--muted);font:500 11px var(--mono)}

.fold-r{flex:none;display:grid;grid-template-rows:1fr;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease),margin .3s cubic-bezier(.2,.8,.2,1)}
.fold-in{min-height:0;overflow:hidden;display:grid;gap:8px}
.hdf{margin-inline:-8px}.hdf .fold-in{padding-inline:8px}
.tabs{position:relative;display:flex;gap:2px;margin:0 -16px;padding:0 12px;border-bottom:1px solid var(--line)}
.tabs button{position:relative;display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 10px;border:0;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;transition:color .2s var(--ease)}
.tabs button{box-shadow:inset 0 -2px 0 transparent}.tabs button.on{color:var(--ink);box-shadow:inset 0 -2px 0 var(--ink)}
.tabs button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ap-pn{display:grid;gap:16px;min-width:0}
.tab-fwd-enter-active,.tab-fwd-leave-active,.tab-back-enter-active,.tab-back-leave-active{transition:opacity .16s var(--ease),transform .2s cubic-bezier(.2,.8,.2,1)}
.tab-fwd-enter-from,.tab-back-leave-to{opacity:0;transform:translateX(10px)}
.tab-fwd-leave-to,.tab-back-enter-from{opacity:0;transform:translateX(-10px)}
.ap-spin{animation:spin 1.1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Phone: bottom sheet (teleported to <body> by the view) */

.sheet .hd{padding-top:8px;touch-action:none;cursor:grab}
.grab{justify-self:center;width:40px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--ink) 28%,transparent)}
@media (prefers-reduced-motion:reduce){.tab-fwd-enter-active,.tab-fwd-leave-active,.tab-back-enter-active,.tab-back-leave-active{transition:opacity .16s}.tab-fwd-enter-from,.tab-back-leave-to,.tab-fwd-leave-to,.tab-back-enter-from{transform:none}.ap-dot.s-working,.ap-spin{animation:none}.rf,.ap-bar i,.cv-i,.fb,.fb > div{transition:none}.ap.sheet,.fold-r{transition:none}}
</style>
