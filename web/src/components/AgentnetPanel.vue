<script setup lang="ts">
// The agent detail panel (Agents page): floats over the map or cards, never resizes them. Desktop: a sheet on the
// right edge; phone: a bottom sheet (the view teleports it to <body> and adds the scrim). Layout after Vercel's
// deployment drawer and the GitHub Actions run sidebar (docs/research/agent-panel.md): header, a row of key numbers,
// "Now" as the loudest block, tasks as a checklist, messages as a thread, identity and hooks folded away.
// Every value comes from the agentnet snapshot row; a field the row does not have is left out, never invented.
import { computed, nextTick, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetChat from "./AgentnetChat.vue";
import AgentnetJobs from "./AgentnetJobs.vue";
import AgentnetControls from "./AgentnetControls.vue";
import AgentnetUsage from "./AgentnetUsage.vue";
import AgentnetScore from "./AgentnetScore.vue";
import { net, hooks, humanDoing, ctxView, windows, type AgentRow, type HookFire } from "../net";
import { api } from "../ui/api";

const props = defineProps<{ row: AgentRow | null; name: string; sheet: boolean }>();
const emit = defineEmits<{ close: []; open: []; closeWin: [] }>();

const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const ago = (t: number) => dur(net.now - t) + " ago";
const since = (t?: number) => (t ? dur(net.now - t) : null);
const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const r = computed(() => props.row);
const isRoot = computed(() => props.name === "root");
const gone = computed(() => !!r.value && (r.value.life === "gone" || r.value.life === "failed"));
// The chat footer is always drawn; when nothing can receive, the reason sits in the disabled input.
const blocked = computed(() => isRoot.value ? "This is root (you)" : !r.value ? "Not connected" : gone.value ? "Retired: read-only history" : r.value.life !== "live" || !r.value.connectedAt ? "Not connected" : null);
const dot = computed(() => {
  const x = r.value; if (!x) return "root";
  if (x.life === "starting") return "starting";
  if (x.life === "stopping" || gone.value) return "stopping";
  return x.state;
});
const DOT_LABEL: Record<string, string> = { root: "director", starting: "starting", stopping: "stopping", working: "working", idle: "idle", waiting: "waiting for input", blocked: "blocked" };
const model = computed(() => r.value?.model?.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "") ?? null);
const modelChip = computed(() => (model.value ? model.value + (r.value?.effort ? " · " + r.value.effort : "") : null));
const stateText = computed(() => (r.value ? (r.value.life === "live" ? r.value.state : r.value.life) : ""));
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
const tool = (t: { tool: string; target: string | null }) => humanDoing(t.tool + (t.target ? " · " + t.target : "")) ?? t.tool;

const idRows = computed(() => {
  const x = r.value; if (!x) return [];
  const rows: [string, string | null, string?][] = [
    ["Reports to", x.boss], ["Model", x.model ? x.model + (x.effort ? " · " + x.effort : "") : null], ["Persona", x.soul ?? null], ["Why these", x.audit ?? null],
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

// Segmented tabs: Overview | Chat. Background jobs are a fixed collapsible panel under them, visible on both. Switching slides the body a few px and fades (transform + opacity only).
const TABS = [{ id: "overview", label: "Overview" }, { id: "chat", label: "Chat" }] as const;
type Tab = (typeof TABS)[number]["id"];
const tab = ref<Tab>("overview");
/** The pane on screen. It follows tab only when the new pane enters, so the old pane keeps its own layout while it fades out (out-in). */
const shown = ref<Tab>("overview");
const tabIdx = computed(() => TABS.findIndex((t) => t.id === tab.value));
const slide = ref("fwd");
const setTab = (t: Tab) => { slide.value = TABS.findIndex((x) => x.id === t) > tabIdx.value ? "fwd" : "back"; tab.value = t; nextTick(() => { if (t === "overview" && el.value) { const b = el.value.querySelector<HTMLElement>(".bd"); if (b) b.scrollTop = 0; } }); };
function tabKey(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
  e.preventDefault(); const n = TABS[(tabIdx.value + d + TABS.length) % TABS.length].id; setTab(n);
  nextTick(() => el.value?.querySelector<HTMLElement>(`[data-tab="${n}"]`)?.focus());
}
watch(() => props.name, () => { tab.value = "overview"; shown.value = "overview"; });

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
defineExpose({ el });
</script>

<template>
  <aside ref="el" :class="['ap', 'side-panel', 'glass-strong', { sheet }]" :role="sheet ? 'dialog' : 'complementary'" :aria-modal="sheet || undefined" :aria-label="`${name} details`" tabindex="-1" @keydown="trap">
    <header class="hd" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <span v-if="sheet" class="grab" aria-hidden="true" />
      <div class="t1">
        <span :class="['ap-dot', 's-' + dot]" role="img" :aria-label="DOT_LABEL[dot] ?? dot" :title="DOT_LABEL[dot] ?? dot" />
        <h2 class="ap-nm" :title="name">{{ name }}</h2>
        <span v-if="modelChip" class="ap-chip" :title="r?.model ?? ''">{{ modelChip }}</span>
        <button type="button" class="x" data-close aria-label="Close panel" @click="emit('close')"><Icon name="x" :size="20" /></button>
      </div>
      <p v-if="r?.job || isRoot" class="job" :title="r?.job ?? ''">{{ r?.job ?? "Director of every agent · main session" }}</p>
      <div v-if="r" class="acts">
        <button type="button" class="btn sm ghost" :disabled="!windows.available || !!windows.busy || gone" @click="emit('open')"><Icon name="square-terminal" :size="15" /> Open window</button>
        <button type="button" class="btn sm ghost" :disabled="!windows.available || !!windows.busy" @click="emit('closeWin')"><Icon name="x" :size="15" /> Close window</button>
      </div>
      <AgentnetControls v-if="r && !isRoot && !gone" mode="actions" :name="name" :can-act="r.life === 'live'" @closed="emit('close')" />
      <div class="tabs" role="tablist" aria-label="Agent sections" @keydown="tabKey">
        <i class="ind" aria-hidden="true" :style="{ transform: `translateX(${tabIdx * 100}%)`, width: `calc(100% / ${TABS.length})` }" />
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" :id="`ap-tab-${t.id}`" :data-tab="t.id" :aria-selected="tab === t.id" :aria-controls="`ap-pn-${t.id}`" :tabindex="tab === t.id ? 0 : -1" :class="{ on: tab === t.id }" @click="setTab(t.id)">{{ t.label }}</button>
      </div>
    </header>

    <AgentnetJobs v-if="r" mode="jobs" :name="name" :tasks="tasks" />

    <div :class="['bd', { fill: shown === 'chat' }]">
     <Transition :name="'tab-' + slide" mode="out-in" @before-enter="shown = tab">
      <AgentnetChat v-if="tab === 'chat'" id="ap-pn-chat" key="chat" role="tabpanel" aria-labelledby="ap-tab-chat" :name="name" :blocked="blocked" />
      <div v-else id="ap-pn-overview" key="overview" class="ap-pn" role="tabpanel" aria-labelledby="ap-tab-overview">
      <p v-if="!r" class="none">No live reading for {{ name }} yet.</p>
      <template v-else>
        <AgentnetControls v-if="!isRoot && !gone" mode="schedules" :name="name" />
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

        <!-- Now: the loudest block, GitHub Actions style -->
        <section :class="['now', { working: dot === 'working', blocked: !!rep?.blockedOn }]" aria-label="Now">
          <div class="now-h"><span class="lbl">Now</span><span v-if="rep?.phase" class="ap-chip ap-ph">{{ rep.phase }}</span></div>
          <p v-if="rep?.blockedOn" class="blk"><Icon name="triangle-alert" :size="16" /><span>Blocked on {{ rep.blockedOn }}</span></p>
          <p v-if="r.doing" :class="['doing', { dim: fromReport && repOld }]">{{ humanDoing(r.doing) }}<span v-if="fromReport" class="rage">reported {{ ago(rep!.at) }}</span></p>
          <p v-else-if="!rep?.blockedOn" class="none">Nothing running.</p>
          <p v-if="r.action" class="tool"><Icon name="loader" :size="14" class="ap-spin" /><span class="mono">{{ tool(r.action) }}</span></p>
          <p v-if="allDone" class="sm">All {{ tasks.length }} tasks done</p>
          <div v-else-if="prog != null" class="pb">
            <div class="ap-bar" role="progressbar" :aria-label="`Tasks ${done} of ${tasks.length}`" :aria-valuenow="prog" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: prog + '%' }" /></div>
            <span class="ap-num">Tasks {{ done }}/{{ tasks.length }} · {{ prog }}%</span>
          </div>
          <p v-if="!allDone && prog != null && curPct != null" class="sm">current task ~{{ curPct }}%</p>
          <p v-else-if="prog == null" class="sm">No tasks yet</p>
          <dl class="ap-kv">
            <template v-if="r.turn"><dt>Turn</dt><dd>{{ since(r.turn.startedAt) }} · {{ r.turn.tools }} {{ r.turn.tools === 1 ? "tool" : "tools" }}<template v-if="r.turns"> · turn {{ r.turns }}</template></dd></template>
            <template v-else-if="r.turns"><dt>Turns</dt><dd>{{ r.turns }}</dd></template>
            <template v-if="r.lastTool"><dt>Last tool</dt><dd><span class="mono">{{ tool(r.lastTool) }}</span> · <span :class="r.lastTool.ok ? 'ok' : 'bad'">{{ r.lastTool.ok ? "ok" : "failed" }}</span>{{ r.lastTool.ms != null ? " · " + r.lastTool.ms + " ms" : "" }} · {{ ago(r.lastTool.at) }}</dd></template>
            <template v-if="rep"><dt>Reported</dt><dd>{{ ago(rep.at) }}</dd></template>
            <template v-if="r.lastMsg"><dt>Last message</dt><dd>{{ r.lastMsg.dir === "out" ? "to" : "from" }} {{ r.lastMsg.peer }} · {{ r.lastMsg.kind }} · {{ ago(r.lastMsg.at) }}</dd></template>
          </dl>
        </section>
      </template>

      <AgentnetJobs v-if="r" mode="tasks" :name="name" :tasks="tasks" />

      <AgentnetUsage v-if="r" compact :only="name" class="ap-usage" />

      <AgentnetScore v-if="r && !isRoot" :only="name" class="ap-score" />

      <section v-if="r && idRows.length" class="sec fold">
        <button type="button" class="fh" :aria-expanded="openId" aria-controls="ap-id" @click="openId = !openId">
          <span>Details</span><span class="ap-hint">{{ isRoot ? "session, pid" : "project, session, persona" }}</span><Icon name="chevron-down" :size="16" class="cv-i" />
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
      </div>
     </Transition>
    </div>
  </aside>
</template>

<style scoped>
/* Desktop: a sheet over the right edge of the map/cards area. The view decides where it sits; this file draws it. */
.hd{flex:none;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px 12px;border-bottom:1px solid var(--line)}
.t1{display:flex;align-items:center;gap:10px}
.ap-nm{flex:0 1 auto;margin:0;text-transform:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.2 var(--body);letter-spacing:-.01em}
.ap-chip{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11.5px/1.3 var(--mono)}
.x{flex:none;margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer;transition:background-color .2s var(--ease)}
.x:hover{background:var(--track)}
.x:focus{outline:none}
.x:focus-visible,.fh:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.job{margin:0;color:var(--muted);font-size:13.5px;line-height:1.4;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-left:-8px}
.acts .btn{display:inline-flex;align-items:center;gap:5px;min-height:36px;padding-inline:8px}
.ap-dot{flex:none;width:11px;height:11px;border-radius:50%;background:var(--off)}
.ap-dot.s-working{background:var(--on);animation:pulse 1.6s var(--ease) infinite}
.ap-dot.s-waiting{background:var(--warn)}
.ap-dot.s-blocked{background:var(--bad)}
.ap-dot.s-starting{background:transparent;border:2px dashed var(--muted)}
.ap-dot.s-root{background:var(--lock)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}

.bd{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px;display:grid;align-content:start;gap:16px}
.bd.fill{grid-template-rows:minmax(0,1fr);padding:0;overflow:hidden}
.none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.ap-num{font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere;word-break:break-word}
.lbl{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
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

.now{display:grid;gap:8px;padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--off);border-radius:14px;background:color-mix(in srgb,var(--ink) 5%,transparent)}
.now.working{border-left-color:var(--on);background:color-mix(in srgb,var(--on) 7%,transparent)}
.now.blocked{border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,transparent)}
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

.sec h3{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.sec h3 .ap-num{letter-spacing:0;color:var(--ink);opacity:.8}
/* folded sections: animated open/close via grid rows 0fr -> 1fr */
.fold{border-top:1px solid var(--line);padding-top:4px}
.fh{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;text-align:left;font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.fh .ap-hint{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:none;letter-spacing:0;font-weight:500;opacity:.75}
.cv-i{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.fh[aria-expanded="true"] .cv-i{transform:rotate(180deg)}
.fb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.fb.is-open{grid-template-rows:1fr;opacity:1}
.fb > div{overflow:hidden;display:grid;gap:8px;transition:padding .3s cubic-bezier(.2,.8,.2,1)}
.fb.is-open > div{padding-bottom:6px}
.hk{list-style:none;margin:0;padding:0;display:grid;gap:6px;font-size:12.5px}
.hk li{display:flex;align-items:center;gap:8px}
.hk i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--hook,#f2b04a)}
.hk li.idle,.hk li.off{opacity:.6}
.hk li.off i{background:var(--off)}
.hk i.bad{background:var(--bad)}
.hk b{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hk span{flex:none;color:var(--muted)}
.hk time{flex:none;color:var(--muted);font:500 11px var(--mono)}

.tabs{position:relative;display:grid;margin:0;overflow:visible;grid-template-columns:repeat(2,minmax(0,1fr));padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.tabs .ind{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / 2);border-radius:9px;background:color-mix(in srgb,var(--ink) 12%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.tabs button{position:relative;min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;transition:color .2s var(--ease)}
.tabs button.on{color:var(--ink)}
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
@media (prefers-reduced-motion:reduce){.tabs .ind{transition:none}.tab-fwd-enter-active,.tab-fwd-leave-active,.tab-back-enter-active,.tab-back-leave-active{transition:opacity .16s}.tab-fwd-enter-from,.tab-back-leave-to,.tab-fwd-leave-to,.tab-back-enter-from{transform:none}.ap-dot.s-working,.ap-spin{animation:none}.rf,.ap-bar i,.cv-i,.fb,.fb > div{transition:none}.ap.sheet{transition:none}}
</style>
