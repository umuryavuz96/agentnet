<script setup lang="ts">
// Team side panel (Agents page): same shell as the agent panel (desktop sheet on the right, phone bottom sheet), three tabs:
// People (crew as indented rows), Channel (the team's chat, posts as root), Plans (one row per member: the step it is on,
// its plan line, its open asks; a tap opens that agent on its Trail tab). The shared team board is retired: a team that
// still has board tasks shows them folded and read only. Data: GET /agentnet-panel/teams/:id every 3 s while open; member state comes from the live stream.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetCrewRows from "./AgentnetCrewRows.vue";
import TrailLine from "./TrailLine.vue";
import { net, humanDoing, type TeamTask, type TeamMsg, type Team } from "../net";
import { brk } from "../crewTree";
import { endedText, openAsks, planLine } from "../plan";
import { short, trailView } from "../trailView";
import { api } from "../ui/api";

const props = defineProps<{ id: string; sheet: boolean }>();
const emit = defineEmits<{ close: []; select: [id: string, tab?: "trail"] }>();

const bosses = ref<Record<string, string | null>>({}), team = ref<Team | null>(null), board = ref<TeamTask[]>([]), chan = ref<TeamMsg[]>([]), err = ref(""), loaded = ref(false);
async function load() {
  try { const r = await api<{ team: Team; tasks: TeamTask[]; channel: TeamMsg[]; bosses?: Record<string, string | null> }>(`v1/panel/teams/${encodeURIComponent(props.id)}`); team.value = r.team; board.value = r.tasks; chan.value = r.channel; bosses.value = r.bosses ?? {}; bosses.value = r.bosses ?? {}; err.value = ""; }
  catch (e) { err.value = (e as Error).message; } finally { loaded.value = true; }
}
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => { void load(); timer = setInterval(() => { if (!document.hidden) void load(); }, 3000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
watch(() => props.id, () => { team.value = null; board.value = []; chan.value = []; loaded.value = false; void load(); });

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const rowOf = (name: string) => Object.values(net.agents).find((a) => a.name === name && a.life !== "gone") ?? null;
const members = computed(() => (team.value?.members ?? []).map((n) => ({ name: n, row: rowOf(n), lead: team.value?.lead === n })).sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name)));
const dotOf = (r: ReturnType<typeof rowOf>) => (!r ? "off" : r.life === "starting" ? "starting" : r.life !== "live" ? "off" : r.state);
const live = computed(() => members.value.filter((m) => m.row?.life === "live").length);
const working = computed(() => members.value.filter((m) => m.row?.life === "live" && m.row.state === "working").length);
const openTasks = computed(() => board.value.filter((t) => t.status !== "done").length);
const title = computed(() => { const n = team.value?.name; return n && !n.includes("/") ? n : props.id; });
const archived = computed(() => team.value?.state === "archived");

// ---- tabs ----
const TABS = [{ id: "people", label: "People" }, { id: "channel", label: "Channel" }, { id: "plans", label: "Plans" }] as const;
type Tab = (typeof TABS)[number]["id"];
const tab = ref<Tab>("people"), slide = ref("fwd"), el = ref<HTMLElement | null>(null);
/** The pane on screen: follows tab only when the new pane enters, so the old pane keeps its layout while it fades (out-in). */
const paneShown = ref<Tab>("people");
const tabIdx = computed(() => TABS.findIndex((t) => t.id === tab.value));
const setTab = (t: Tab) => { slide.value = TABS.findIndex((x) => x.id === t) > tabIdx.value ? "fwd" : "back"; tab.value = t; nextTick(() => { const b = el.value?.querySelector<HTMLElement>(".tp-bd"); if (b) b.scrollTop = t === "channel" ? b.scrollHeight : 0; }); };
function tabKey(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return;
  e.preventDefault(); const n = TABS[(tabIdx.value + d + TABS.length) % TABS.length].id; setTab(n); nextTick(() => el.value?.querySelector<HTMLElement>(`[data-tab="${n}"]`)?.focus());
}

// ---- channel ----
const kinds = ["info", "task", "question"] as const;
const kind = ref<(typeof kinds)[number]>("info"), text = ref(""), busy = ref(false), sendErr = ref("");
async function send() {
  const body = text.value.trim(); if (!body || busy.value || archived.value) return;
  busy.value = true; sendErr.value = "";
  try { await api(`v1/panel/teams/${encodeURIComponent(props.id)}/messages`, { method: "POST", body: { body, kind: kind.value } }); text.value = ""; await load(); nextTick(() => { const b = el.value?.querySelector<HTMLElement>(".tp-bd"); if (b) b.scrollTop = b.scrollHeight; }); }
  catch (e) { sendErr.value = (e as Error).message; } finally { busy.value = false; }
}
const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } };
const mine = (m: TeamMsg) => m.from === "root";

// ---- plans: what every member is on ----
const WORD: Record<string, string> = { working: "Working", idle: "Idle", waiting: "Waiting", blocked: "Blocked", starting: "Starting", off: "Not running" };
const plans = computed(() => members.value.map((m) => {
  const r = m.row, v = r ? trailView(r) : null, l = r ? planLine(r) : null, asks = r ? openAsks(r) : [];
  const line = !r ? { no: "", text: "Not running" } : l && "no" in l ? l : { no: "", text: l ? endedText(l, short(net.now - l.ended.closedAt!)) : humanDoing(r.doing) ?? (v?.n ? v.word : "") };
  return { ...m, dot: dotOf(r), has: !!v?.n, line, asks: asks.length, oldest: asks.length ? Math.min(...asks.map((k) => k.at)) : 0, hasJobs: !!r?.jobs, jobId: r?.jobs?.at(-1)?.id ?? 0, jobs: r?.jobs?.length ?? 0 };
}));
const openBoard = ref(false);

// ---- phone: drag the sheet down by its header to close it ----
let drag: { y: number; dy: number; id: number } | null = null;
const onDown = (e: PointerEvent) => { if (!props.sheet || (e.target as Element).closest("button")) return; drag = { y: e.clientY, dy: 0, id: e.pointerId }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); };
const onMove = (e: PointerEvent) => { if (!drag || !el.value) return; drag.dy = Math.max(0, e.clientY - drag.y); el.value.style.transition = "none"; el.value.style.transform = `translateY(${drag.dy}px)`; };
const onUp = () => { if (!drag || !el.value) return; const close = drag.dy > 90; drag = null; el.value.style.transition = ""; el.value.style.transform = ""; if (close) emit("close"); };
function trap(e: KeyboardEvent) {
  if (!props.sheet || e.key !== "Tab" || !el.value) return;
  const f = [...el.value.querySelectorAll<HTMLElement>("button:not([disabled]),textarea:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
defineExpose({ el });
</script>

<template>
  <aside ref="el" :class="['tp', 'side-panel', 'glass-strong', { sheet }]" :role="sheet ? 'dialog' : 'complementary'" :aria-modal="sheet || undefined" :aria-label="`${title} team`" tabindex="-1" @keydown="trap">
    <header class="tp-hd" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <span v-if="sheet" class="tp-grab" aria-hidden="true" />
      <div class="tp-t1">
        <span :class="['tp-dot', working ? 's-working' : live ? 's-idle' : 's-off']" role="img" :aria-label="working ? 'working' : live ? 'idle' : 'no live members'" />
        <h2 class="tp-nm" :title="title">{{ title }}</h2>
        <span class="tp-chip">team</span>
        <button type="button" class="tp-x" data-close aria-label="Close panel" @click="emit('close')"><Icon name="x" :size="20" /></button>
      </div>
      <p v-if="team" class="tp-facts"><b class="tp-num">{{ live }}</b> live of <b class="tp-num">{{ members.length }}</b> · <b class="tp-num">{{ working }}</b> working · lead <b>{{ team.lead ?? "none" }}</b><template v-if="team.project"> · {{ team.project.split("/").filter(Boolean).pop() }}</template></p>
      <p v-if="team?.goal" class="tp-goal" :title="team.goal">{{ team.goal }}</p>
      <div class="tp-tabs" role="tablist" aria-label="Team sections" @keydown="tabKey">
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" :data-tab="t.id" :aria-selected="tab === t.id" :tabindex="tab === t.id ? 0 : -1" :class="{ on: tab === t.id }" @click="setTab(t.id)">{{ t.label }}</button>
      </div>
    </header>

    <div :class="['tp-bd', { fill: paneShown === 'channel' }]">
      <p v-if="loaded && !team" class="tp-none">{{ err || "No such team." }}</p>
      <Transition v-else :name="'tp-' + slide" mode="out-in" @before-enter="paneShown = tab">
        <!-- Tree -->
        <div v-if="tab === 'people'" key="people" class="tp-pn" role="tabpanel">
          <AgentnetCrewRows :name="title" :members="team?.members ?? []" :lead="team?.lead ?? null" :archived="archived" :bosses="bosses" @select="emit('select', $event)" />
        </div>

        <!-- Channel -->
        <div v-else-if="tab === 'channel'" key="channel" class="tp-ch" role="tabpanel">
          <div class="tp-list" role="log" aria-live="polite" :aria-label="`${title} channel`">
            <p v-if="!chan.length" class="tp-none">Nothing posted in this channel yet.</p>
            <article v-for="m in chan" :key="m.id" :class="['tp-b', mine(m) ? 'out' : 'in']">
              <p class="tp-bh"><span class="tp-kind">{{ m.kind }}</span><span class="tp-who">{{ m.from }}</span><time>{{ time(m.at) }}</time></p>
              <p v-if="m.subject && m.subject !== m.body" class="tp-bs">{{ m.subject }}</p>
              <p class="tp-bt">{{ m.body }}</p>
              <p class="tp-rb">Read by {{ members.filter((x) => x.name !== m.from).map((x) => x.name).join(", ") || "no one yet" }}</p>
            </article>
          </div>
        </div>

        <!-- Plans -->
        <div v-else key="plans" class="tp-pn" role="tabpanel">
          <div v-if="!plans.some((m) => m.has)" class="tp-empty"><b>No plans yet</b><p>A member's plan shows here once its brief is read in. The crew is on the People tab.</p></div>
          <ul v-else class="tp-pl" aria-label="Member plans">
            <li v-for="m in plans" :key="m.name" :class="{ sub: !m.lead && !!team?.lead }">
              <button type="button" class="tp-pr" :disabled="!m.row" :title="m.row ? `Opens ${m.name}, Trail tab` : undefined" @click="m.row && emit('select', m.row.id, 'trail')">
                <span class="tp-pt"><i :class="['tp-dot', 's-' + m.dot]" aria-hidden="true" /><b class="tp-pnm">{{ brk(m.name) }}</b><span v-if="m.lead" class="tp-pchip">Lead</span><span :class="['tp-pw', 's-' + m.dot]">{{ WORD[m.dot] ?? m.dot }}</span></span>
                <span v-if="m.line.text" :class="['tp-pd', { mut: !m.line.no }]"><span v-if="m.line.no" class="tp-no tp-num">{{ m.line.no }}</span>{{ m.line.text }}</span>
                <TrailLine v-if="m.row" :row="m.row" />
                <span v-if="m.hasJobs" class="tp-pm"><span v-if="m.asks"><b class="tp-num">{{ m.asks }}</b> open {{ m.asks === 1 ? "ask" : "asks" }} · oldest {{ short(net.now - m.oldest) }}</span><span v-else>No open asks</span><span v-if="m.jobs > 1" class="tp-num">job {{ m.jobId }} of {{ m.jobs }}</span></span>
              </button>
            </li>
          </ul>
          <section v-if="board.length" class="tp-fold">
            <button type="button" class="tp-fh" :aria-expanded="openBoard" aria-controls="tp-board" @click="openBoard = !openBoard"><span>Team board (retired)</span><span class="tp-hint tp-num">{{ board.length }} {{ board.length === 1 ? "task" : "tasks" }}, read only</span><Icon name="chevron-down" :size="16" class="tp-cv" /></button>
            <div id="tp-board" class="tp-fb" :class="{ 'is-open': openBoard }" :inert="!openBoard || undefined"><div>
              <ul class="tp-tasks">
                <li v-for="t in board" :key="t.id" :class="t.status">
                  <Icon :name="t.status === 'done' ? 'circle-check' : t.status === 'in_progress' ? 'circle' : 'square'" :size="16" /><span class="tp-tt">{{ t.text }}</span><span v-if="t.owner" class="tp-own">{{ t.owner }}</span>
                </li>
              </ul>
            </div></div>
          </section>
          <p v-if="err" class="tp-err" role="alert">{{ err }}</p>
        </div>
      </Transition>
    </div>

    <!-- the channel footer is always drawn; an archived team shows why it is off -->
    <form v-if="tab === 'channel'" class="tp-box" :class="{ off: archived }" @submit.prevent="send">
      <div class="tp-kinds" role="radiogroup" aria-label="Message kind">
        <button v-for="k in kinds" :key="k" type="button" role="radio" :aria-checked="kind === k" :class="{ on: kind === k }" :disabled="archived" @click="kind = k">{{ k }}</button>
      </div>
      <div class="tp-row">
        <textarea v-model="text" rows="2" :disabled="archived" :placeholder="archived ? 'Archived team: read-only history' : `Post to ${title} as root`" :aria-label="`Post to ${title}`" @keydown="onKey" />
        <button class="tp-send" type="submit" :disabled="archived || busy || !text.trim()" aria-label="Send message"><Icon :name="busy ? 'loader' : 'send'" :size="18" :class="{ 'tp-spin': busy }" /></button>
      </div>
      <p v-if="sendErr" class="tp-err" role="alert">{{ sendErr }}</p>
    </form>
  </aside>
</template>

<style scoped>
.tp:not(.sheet){width:min(440px,calc(100% - 24px))}
.tp-hd{flex:none;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px 0}
.tp-t1{display:flex;align-items:center;gap:10px}
.tp-nm{flex:0 1 auto;margin:0;text-transform:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.2 var(--body);letter-spacing:-.01em}
.tp-chip{flex:none;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11.5px/1.3 var(--mono)}
.tp-x{flex:none;margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer;transition:background-color .2s var(--ease)}
.tp-x:hover{background:var(--track)}
.tp-x:focus{outline:none}
.tp-x:focus-visible,.tp-mr:focus-visible,.tp-pr:focus-visible,.tp-fh:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tp-goal{margin:0;color:var(--muted);font-size:13.5px;line-height:1.4;overflow-wrap:anywhere}
.tp-dot{flex:none;width:11px;height:11px;border-radius:50%;background:var(--off)}
.tp-dot.s-working{background:var(--on)}
.tp-dot.s-idle{background:var(--muted)}
.tp-dot.s-waiting{background:var(--warn)}
.tp-dot.s-blocked{background:var(--bad)}
.tp-dot.s-starting{background:transparent;border:2px dashed var(--muted)}
.tp-hd .tp-dot.s-working{animation:tppulse 1.6s var(--ease) infinite}
@keyframes tppulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.tp-tabs{position:relative;display:flex;gap:2px;margin:0 -16px;padding:0 12px;border-bottom:1px solid var(--line)}
.tp-tabs button{position:relative;display:inline-flex;align-items:center;height:40px;padding:0 10px;border:0;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;box-shadow:inset 0 -2px 0 transparent;transition:color .2s var(--ease)}
.tp-tabs button.on{color:var(--ink);box-shadow:inset 0 -2px 0 var(--ink)}
.tp-tabs button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tp-bd{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px;display:grid;align-content:start;gap:16px}
.tp-bd.fill{grid-template-rows:minmax(0,1fr)}
.tp-pn{display:grid;gap:16px}
.tp-facts{margin:0;color:var(--muted);font-size:13px;line-height:1.4;overflow-wrap:anywhere}.tp-facts b{color:var(--ink);font-weight:600}
.tp-rb{margin:0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.tp-empty{display:grid;gap:6px;padding:16px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}.tp-empty b{font-size:15px}.tp-empty p{margin:0;color:var(--muted);font-size:13px}
.tp-none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.tp-num{font-variant-numeric:tabular-nums}
.tp-lbl{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.tp-sm{color:var(--muted);font-size:12px;line-height:1.3}
.tp-hero{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.tp-tile{display:grid;align-content:start;gap:3px;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.tp-tile b{font:700 17px/1.2 var(--body)}
.tp-tile b.on{color:var(--on)}
.tp-mem{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.tp-mr{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 3%,transparent);color:var(--ink);cursor:pointer;text-align:left;font:600 13.5px/1.3 var(--body);transition:background-color .2s var(--ease)}
.tp-mr:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 7%,transparent)}
.tp-mr:disabled{cursor:default;opacity:.6}
.tp-mn{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-lead{flex:none;padding:1px 6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--on) 55%,transparent);background:color-mix(in srgb,var(--on) 18%,transparent);color:var(--on);font:700 9.5px/1.5 var(--body);letter-spacing:.05em}
.tp-md{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-weight:500;font-size:12.5px;text-align:right}
/* channel */
.tp-ch{display:grid;grid-template-columns:minmax(0,1fr);min-height:100%}
.tp-list{display:grid;gap:8px;align-content:start;padding-bottom:8px}
.tp-b{display:grid;gap:3px;max-width:88%;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.tp-b.out{justify-self:end;border-color:color-mix(in srgb,var(--on) 40%,var(--line));background:color-mix(in srgb,var(--on) 10%,transparent);border-bottom-right-radius:5px}
.tp-b.in{justify-self:start;border-bottom-left-radius:5px}
.tp-bh{display:flex;align-items:center;gap:7px;margin:0;font-size:11.5px;line-height:1.3;color:var(--muted)}
.tp-kind{flex:none;padding:1px 6px;border-radius:6px;background:var(--track);font:600 10.5px/1.5 var(--mono)}
.tp-who{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tp-bh time{flex:none;font:500 11px/1 var(--mono)}
.tp-bs{margin:0;font:650 13px/1.35 var(--body);overflow-wrap:anywhere}
.tp-bt{margin:0;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:12;-webkit-box-orient:vertical;overflow:hidden}
.tp-box{flex:none;display:grid;gap:8px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel)}
.tp-kinds{display:flex;gap:4px}
.tp-kinds button{flex:1;min-height:32px;padding:0 6px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--muted);font:600 11.5px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease),border-color .2s var(--ease)}
.tp-kinds button.on{background:color-mix(in srgb,var(--on) 14%,transparent);border-color:color-mix(in srgb,var(--on) 50%,var(--line));color:var(--ink)}
.tp-box.off .tp-kinds button,.tp-box.off textarea{opacity:.5;cursor:not-allowed}
.tp-row{display:flex;gap:8px;align-items:flex-end}
.tp-row textarea{flex:1;resize:none;max-height:120px;padding:9px 11px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:inherit;font-size:14px;line-height:1.4}
.tp-row textarea:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tp-send{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:var(--on);color:#06210f;cursor:pointer;transition:opacity .2s var(--ease),transform .2s var(--ease)}
.tp-send:disabled{opacity:.35;cursor:default}
.tp-err{margin:0;color:var(--bad);font-size:12.5px}
/* plans: one row per member (the People row's box), reports indented under the lead */
.tp-pl{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.tp-pl li.sub{margin-left:16px;position:relative}
.tp-pl li.sub::before{content:"";position:absolute;left:-9px;top:0;bottom:50%;width:8px;border-left:1.5px solid color-mix(in srgb,var(--ink) 28%,transparent);border-bottom:1.5px solid color-mix(in srgb,var(--ink) 28%,transparent);border-radius:0 0 0 6px}
.tp-pr{display:grid;gap:6px;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 3%,transparent);color:var(--ink);text-align:left;font:inherit;cursor:pointer;transition:background-color .2s var(--ease)}
.tp-pr:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 7%,transparent)}
.tp-pr:disabled{cursor:default;opacity:.6}
.tp-pt{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tp-pt .tp-dot{width:9px;height:9px}
.tp-pnm{font:650 14px/1.3 var(--body);overflow-wrap:anywhere}
.tp-pchip{padding:1px 7px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--muted);color:var(--muted);font:600 11px/1.5 var(--body)}
.tp-pw{margin-left:auto;font:600 12px/1.3 var(--body);color:var(--muted)}
.tp-pw.s-working{color:var(--on)}.tp-pw.s-blocked{color:var(--bad)}.tp-pw.s-waiting{color:var(--warn)}
.tp-pd{font-size:13px;line-height:1.4;overflow-wrap:anywhere}
.tp-pd.mut{color:var(--muted)}
.tp-no{margin-right:6px;font:500 11px/1.4 var(--mono);color:var(--muted)}
.tp-pm{display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--muted);font-size:12px;line-height:1.4}
.tp-pm b{color:var(--ink);font-weight:600}
/* the retired team board: folded, read only (grid rows 0fr -> 1fr) */
.tp-fold{border-top:1px solid var(--line);padding-top:4px}
.tp-fh{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;text-align:left;font:600 13px/1.2 var(--body)}
.tp-hint{flex:1;font-weight:500;opacity:.8}
.tp-cv{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.tp-fh[aria-expanded="true"] .tp-cv{transform:rotate(180deg)}
.tp-fb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.tp-fb.is-open{grid-template-rows:1fr;opacity:1}
.tp-fb > div{overflow:hidden;visibility:hidden;transition:visibility 0s .3s}
.tp-fb.is-open > div{visibility:visible;transition-delay:0s}
.tp-tasks{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.tp-tasks li{display:flex;gap:9px;align-items:flex-start;padding:6px 0;font-size:13.5px;line-height:1.4}
.tp-tasks li > .icon{flex:none;margin-top:1px;color:var(--muted)}
.tp-tasks li.done{color:var(--muted)}
.tp-tasks li.done .tp-tt{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 50%,transparent)}
.tp-tasks li.done > .icon{color:var(--on)}
.tp-tt{flex:1;overflow-wrap:anywhere}
.tp-own{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11px/1.5 var(--body)}
.tp-spin{animation:tpspin 1.1s linear infinite}
@keyframes tpspin{to{transform:rotate(360deg)}}
.tp-tab-fwd-enter-active,.tp-tab-fwd-leave-active,.tp-tab-back-enter-active,.tp-tab-back-leave-active{transition:opacity .16s var(--ease),transform .2s cubic-bezier(.2,.8,.2,1)}
.tp-tab-fwd-enter-from,.tp-tab-back-leave-to{opacity:0;transform:translateX(10px)}
.tp-tab-fwd-leave-to,.tp-tab-back-enter-from{opacity:0;transform:translateX(-10px)}

.sheet .tp-hd{padding-top:8px;touch-action:none;cursor:grab}
.tp-grab{justify-self:center;width:40px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--ink) 28%,transparent)}
@media (prefers-reduced-motion:reduce){.tp-tab-fwd-enter-active,.tp-tab-fwd-leave-active,.tp-tab-back-enter-active,.tp-tab-back-leave-active{transition:opacity .16s}.tp-tab-fwd-enter-from,.tp-tab-back-leave-to,.tp-tab-fwd-leave-to,.tp-tab-back-enter-from{transform:none}.tp-hd .tp-dot.s-working,.tp-spin{animation:none}.tp.sheet,.tp-fb,.tp-cv{transition:none}}
</style>
