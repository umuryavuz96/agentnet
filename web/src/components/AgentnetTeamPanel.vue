<script setup lang="ts">
// Team side panel (Agents page): same shell as the agent panel (desktop sheet on the right, phone bottom sheet), three tabs:
// Overview (goal, key numbers, members with live state), Channel (the team's chat, posts as root), Tasks (the team board plus every member's
// own task list, filterable by member). Data: GET /agentnet-panel/teams/:id every 3 s while open; member state comes from the live stream.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, type TeamTask, type TeamMsg, type Team } from "../net";
import { api } from "../ui/api";

const props = defineProps<{ id: string; sheet: boolean }>();
const emit = defineEmits<{ close: []; select: [id: string] }>();

const team = ref<Team | null>(null), board = ref<TeamTask[]>([]), chan = ref<TeamMsg[]>([]), err = ref(""), loaded = ref(false);
async function load() {
  try { const r = await api<{ team: Team; tasks: TeamTask[]; channel: TeamMsg[] }>(`v1/panel/teams/${encodeURIComponent(props.id)}`); team.value = r.team; board.value = r.tasks; chan.value = r.channel; err.value = ""; }
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
const archived = computed(() => team.value?.state === "archived");

// ---- tabs ----
const TABS = [{ id: "overview", label: "Overview" }, { id: "channel", label: "Channel" }, { id: "tasks", label: "Tasks" }] as const;
type Tab = (typeof TABS)[number]["id"];
const tab = ref<Tab>("overview"), slide = ref("fwd"), el = ref<HTMLElement | null>(null);
/** The pane on screen: follows tab only when the new pane enters, so the old pane keeps its layout while it fades (out-in). */
const paneShown = ref<Tab>("overview");
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

// ---- tasks ----
const who = ref<string>("");   // member filter ("" = everyone)
const shown = computed(() => board.value.filter((t) => !who.value || t.owner === who.value));
const groups = computed(() => [["in_progress", "In progress"], ["pending", "To do"], ["done", "Done"]] as const).value;
const byStatus = (s: TeamTask["status"]) => shown.value.filter((t) => t.status === s);
const newText = ref(""), newOwner = ref("");
async function addTask() {
  const t = newText.value.trim(); if (!t || archived.value) return;
  try { await api(`v1/panel/teams/${encodeURIComponent(props.id)}/tasks`, { method: "POST", body: { text: t, owner: newOwner.value || undefined } }); newText.value = ""; await load(); } catch (e) { err.value = (e as Error).message; }
}
async function op(t: TeamTask, o: "start" | "done" | "claim") {
  try { await api(`v1/panel/teams/${encodeURIComponent(props.id)}/tasks/${t.id}/${o}`, { method: "POST", body: {} }); await load(); } catch (e) { err.value = (e as Error).message; }
}
const memberTasks = computed(() => members.value.filter((m) => (!who.value || m.name === who.value) && m.row?.tasks?.length).map((m) => ({ ...m, tasks: m.row!.tasks, done: m.row!.tasks.filter((t) => t.status === "done").length })));

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
  <aside ref="el" :class="['tp', 'side-panel', 'glass-strong', { sheet }]" :role="sheet ? 'dialog' : 'complementary'" :aria-modal="sheet || undefined" :aria-label="`${team?.name ?? id} team`" tabindex="-1" @keydown="trap">
    <header class="tp-hd" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <span v-if="sheet" class="tp-grab" aria-hidden="true" />
      <div class="tp-t1">
        <span :class="['tp-dot', working ? 's-working' : live ? 's-idle' : 's-off']" role="img" :aria-label="working ? 'working' : live ? 'idle' : 'no live members'" />
        <h2 class="tp-nm" :title="team?.name ?? id">{{ team?.name ?? id }}</h2>
        <span class="tp-chip">team</span>
        <button type="button" class="tp-x" data-close aria-label="Close panel" @click="emit('close')"><Icon name="x" :size="20" /></button>
      </div>
      <p v-if="team?.goal" class="tp-goal" :title="team.goal">{{ team.goal }}</p>
      <div class="tp-tabs" role="tablist" aria-label="Team sections" @keydown="tabKey">
        <i class="tp-ind" aria-hidden="true" :style="{ transform: `translateX(${tabIdx * 100}%)`, width: `calc(100% / ${TABS.length})` }" />
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" :data-tab="t.id" :aria-selected="tab === t.id" :tabindex="tab === t.id ? 0 : -1" :class="{ on: tab === t.id }" @click="setTab(t.id)">{{ t.label }}</button>
      </div>
    </header>

    <div :class="['tp-bd', { fill: paneShown === 'channel' }]">
      <p v-if="loaded && !team" class="tp-none">{{ err || "No such team." }}</p>
      <Transition v-else :name="'tp-' + slide" mode="out-in" @before-enter="paneShown = tab">
        <!-- Overview -->
        <div v-if="tab === 'overview'" key="overview" class="tp-pn" role="tabpanel">
          <div class="tp-hero">
            <div class="tp-tile"><span class="tp-lbl">Members</span><b class="tp-num">{{ members.length }}</b><span class="tp-sm">{{ live }} live</span></div>
            <div class="tp-tile"><span class="tp-lbl">Working</span><b :class="['tp-num', { on: working }]">{{ working }}</b><span class="tp-sm">of {{ live }} live</span></div>
            <div class="tp-tile"><span class="tp-lbl">Open tasks</span><b class="tp-num">{{ openTasks }}</b><span class="tp-sm">{{ board.length }} on the board</span></div>
            <div class="tp-tile"><span class="tp-lbl">State</span><b class="tp-num">{{ archived ? "Archived" : "Active" }}</b><span class="tp-sm">{{ team?.project?.split("/").filter(Boolean).pop() ?? "no project" }}</span></div>
          </div>
          <section aria-label="Members">
            <h3 class="tp-h">Members <span class="tp-num">{{ members.length }}</span></h3>
            <ul class="tp-mem">
              <li v-for="m in members" :key="m.name">
                <button type="button" class="tp-mr" :disabled="!m.row" @click="m.row && emit('select', m.row.id)">
                  <i :class="['tp-dot', 's-' + dotOf(m.row)]" aria-hidden="true" />
                  <span class="tp-mn">{{ m.name }}</span>
                  <span v-if="m.lead" class="tp-lead">LEAD</span>
                  <span class="tp-md">{{ m.row ? (m.row.doing ?? m.row.state) : "not running" }}</span>
                </button>
              </li>
            </ul>
          </section>
        </div>

        <!-- Channel -->
        <div v-else-if="tab === 'channel'" key="channel" class="tp-ch" role="tabpanel">
          <div class="tp-list" role="log" aria-live="polite" :aria-label="`${team?.name} channel`">
            <p v-if="!chan.length" class="tp-none">Nothing posted in this channel yet.</p>
            <article v-for="m in chan" :key="m.id" :class="['tp-b', mine(m) ? 'out' : 'in']">
              <p class="tp-bh"><span class="tp-kind">{{ m.kind }}</span><span class="tp-who">{{ m.from }}</span><time>{{ time(m.at) }}</time></p>
              <p v-if="m.subject && m.subject !== m.body" class="tp-bs">{{ m.subject }}</p>
              <p class="tp-bt">{{ m.body }}</p>
            </article>
          </div>
        </div>

        <!-- Tasks -->
        <div v-else key="tasks" class="tp-pn" role="tabpanel">
          <div v-if="members.length" class="tp-filter" role="group" aria-label="Filter by member">
            <button type="button" :class="{ on: !who }" @click="who = ''">Everyone</button>
            <button v-for="m in members" :key="m.name" type="button" :class="{ on: who === m.name }" @click="who = who === m.name ? '' : m.name">{{ m.name }}</button>
          </div>
          <section aria-label="Team board">
            <h3 class="tp-h">Team board <span class="tp-num">{{ board.filter((t) => t.status === "done").length }}/{{ board.length }}</span></h3>
            <p v-if="!board.length" class="tp-none">No team tasks yet.</p>
            <template v-for="[s, label] in groups" :key="s">
              <template v-if="byStatus(s).length">
                <p class="tp-gl">{{ label }} <span class="tp-num">{{ byStatus(s).length }}</span></p>
                <ul class="tp-tasks">
                  <li v-for="t in byStatus(s)" :key="t.id" :class="t.status">
                    <Icon :name="t.status === 'done' ? 'circle-check' : t.status === 'in_progress' ? 'loader' : 'square'" :size="16" :class="{ 'tp-spin': t.status === 'in_progress' }" />
                    <span class="tp-tt">{{ t.text }}</span>
                    <span v-if="t.owner" class="tp-own">{{ t.owner }}</span>
                    <span v-if="t.status !== 'done' && !archived" class="tp-ops">
                      <button v-if="t.status === 'pending'" type="button" @click="op(t, 'start')">Start</button>
                      <button type="button" @click="op(t, 'done')">Done</button>
                    </span>
                  </li>
                </ul>
              </template>
            </template>
            <form v-if="!archived" class="tp-add" @submit.prevent="addTask">
              <input v-model="newText" type="text" maxlength="300" placeholder="Add a team task" aria-label="New team task" />
              <select v-model="newOwner" aria-label="Owner"><option value="">No owner</option><option v-for="m in members" :key="m.name" :value="m.name">{{ m.name }}</option></select>
              <button type="submit" :disabled="!newText.trim()">Add</button>
            </form>
          </section>
          <section v-if="memberTasks.length" aria-label="Member tasks">
            <h3 class="tp-h">Member tasks</h3>
            <div v-for="m in memberTasks" :key="m.name" class="tp-mt">
              <p class="tp-gl">{{ m.name }} <span class="tp-num">{{ m.done }}/{{ m.tasks.length }}</span></p>
              <ul class="tp-tasks">
                <li v-for="t in m.tasks.filter((x) => x.status !== 'done').slice(0, 6)" :key="t.id" :class="t.status">
                  <Icon :name="t.status === 'in_progress' ? 'loader' : 'square'" :size="16" :class="{ 'tp-spin': t.status === 'in_progress' }" /><span class="tp-tt">{{ t.text }}</span>
                </li>
                <li v-if="m.tasks.every((x) => x.status === 'done')" class="done"><Icon name="circle-check" :size="16" /><span class="tp-tt">All done</span></li>
              </ul>
            </div>
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
        <textarea v-model="text" rows="2" :disabled="archived" :placeholder="archived ? 'Archived team: read-only history' : `Post to ${team?.name ?? 'the team'} as root`" :aria-label="`Post to ${team?.name ?? 'the team'}`" @keydown="onKey" />
        <button class="tp-send" type="submit" :disabled="archived || busy || !text.trim()" aria-label="Send message"><Icon :name="busy ? 'loader' : 'send'" :size="18" :class="{ 'tp-spin': busy }" /></button>
      </div>
      <p v-if="sendErr" class="tp-err" role="alert">{{ sendErr }}</p>
    </form>
  </aside>
</template>

<style scoped>
.tp-hd{flex:none;display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:14px 16px 12px;border-bottom:1px solid var(--line)}
.tp-t1{display:flex;align-items:center;gap:10px}
.tp-nm{flex:0 1 auto;margin:0;text-transform:none;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 18px/1.2 var(--body);letter-spacing:-.01em}
.tp-chip{flex:none;padding:3px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11.5px/1.3 var(--mono)}
.tp-x{flex:none;margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer;transition:background-color .2s var(--ease)}
.tp-x:hover{background:var(--track)}
.tp-x:focus{outline:none}
.tp-x:focus-visible,.tp-mr:focus-visible,.tp-filter button:focus-visible,.tp-ops button:focus-visible,.tp-add button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tp-goal{margin:0;color:var(--muted);font-size:13.5px;line-height:1.4;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tp-dot{flex:none;width:11px;height:11px;border-radius:50%;background:var(--off)}
.tp-dot.s-working{background:var(--on)}
.tp-dot.s-idle{background:var(--muted)}
.tp-dot.s-waiting{background:var(--warn)}
.tp-dot.s-blocked{background:var(--bad)}
.tp-dot.s-starting{background:transparent;border:2px dashed var(--muted)}
.tp-hd .tp-dot.s-working{animation:tppulse 1.6s var(--ease) infinite}
@keyframes tppulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.tp-tabs{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.tp-ind{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / 3);border-radius:9px;background:color-mix(in srgb,var(--ink) 12%,transparent);box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.tp-tabs button{position:relative;min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;transition:color .2s var(--ease)}
.tp-tabs button.on{color:var(--ink)}
.tp-tabs button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tp-bd{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px;display:grid;align-content:start;gap:16px}
.tp-bd.fill{grid-template-rows:minmax(0,1fr)}
.tp-pn{display:grid;gap:16px}
.tp-none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.tp-num{font-variant-numeric:tabular-nums}
.tp-lbl{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.tp-sm{color:var(--muted);font-size:12px;line-height:1.3}
.tp-hero{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.tp-tile{display:grid;align-content:start;gap:3px;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.tp-tile b{font:700 17px/1.2 var(--body)}
.tp-tile b.on{color:var(--on)}
.tp-h{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.tp-h .tp-num{letter-spacing:0;color:var(--ink);opacity:.8}
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
/* tasks */
.tp-filter{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin:0 -16px;padding:0 16px}
.tp-filter::-webkit-scrollbar{display:none}
.tp-filter button{flex:none;min-height:32px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.tp-filter button.on{background:color-mix(in srgb,var(--on) 14%,transparent);border-color:color-mix(in srgb,var(--on) 50%,var(--line));color:var(--ink)}
.tp-gl{display:flex;align-items:baseline;gap:6px;margin:10px 0 4px;color:var(--muted);font:600 11.5px/1.2 var(--body)}
.tp-tasks{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.tp-tasks li{display:flex;gap:9px;align-items:flex-start;padding:6px 0;font-size:13.5px;line-height:1.4}
.tp-tasks li > .icon{flex:none;margin-top:1px;color:var(--muted)}
.tp-tasks li.in_progress > .icon{color:var(--on)}
.tp-tasks li.done{color:var(--muted)}
.tp-tasks li.done .tp-tt{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 50%,transparent)}
.tp-tasks li.done > .icon{color:var(--on)}
.tp-tt{flex:1;overflow-wrap:anywhere}
.tp-own{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 8px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--muted);font:600 11px/1.5 var(--body)}
.tp-ops{flex:none;display:flex;gap:4px}
.tp-ops button,.tp-add button{min-height:28px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:600 11.5px/1 var(--body);cursor:pointer}
.tp-ops button:hover,.tp-add button:hover:not(:disabled){background:var(--track)}
.tp-add{display:flex;gap:6px;margin-top:10px}
.tp-add input,.tp-add select{min-height:36px;padding:0 10px;border:1px solid var(--line);border-radius:10px;background:var(--track);color:var(--ink);font:inherit;font-size:13px}
.tp-add input{flex:1}
.tp-add select{flex:0 1 110px}
.tp-add button{min-height:36px}
.tp-add button:disabled{opacity:.4;cursor:default}
.tp-spin{animation:tpspin 1.1s linear infinite}
@keyframes tpspin{to{transform:rotate(360deg)}}
.tp-tab-fwd-enter-active,.tp-tab-fwd-leave-active,.tp-tab-back-enter-active,.tp-tab-back-leave-active{transition:opacity .16s var(--ease),transform .2s cubic-bezier(.2,.8,.2,1)}
.tp-tab-fwd-enter-from,.tp-tab-back-leave-to{opacity:0;transform:translateX(10px)}
.tp-tab-fwd-leave-to,.tp-tab-back-enter-from{opacity:0;transform:translateX(-10px)}

.sheet .tp-hd{padding-top:8px;touch-action:none;cursor:grab}
.tp-grab{justify-self:center;width:40px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--ink) 28%,transparent)}
@media (prefers-reduced-motion:reduce){.tp-ind{transition:none}.tp-tab-fwd-enter-active,.tp-tab-fwd-leave-active,.tp-tab-back-enter-active,.tp-tab-back-leave-active{transition:opacity .16s}.tp-tab-fwd-enter-from,.tp-tab-back-leave-to,.tp-tab-fwd-leave-to,.tp-tab-back-enter-from{transform:none}.tp-hd .tp-dot.s-working,.tp-spin{animation:none}.tp.sheet{transition:none}}
</style>
