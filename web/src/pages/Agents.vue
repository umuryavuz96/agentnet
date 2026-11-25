<script setup lang="ts">
// Live Agents page: reads only /api/v1/agentnet/stream (hello + merge patches + gone + msg + ping).
// Cards are grouped by boss, the grouping is recomputed only when the id:boss:job set changes, a gone card fades out
// in 200 ms, and a click opens the side panel with the agent's tasks and message threads. AgmsgView stays as it was.
import { computed, defineAsyncComponent, nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentCard from "../components/AgentCard.vue";
import AgentnetFiberMap from "../components/AgentnetFiberMap.vue";
import MapState from "../components/MapState.vue";
const Office3D = defineAsyncComponent(() => import("../components/Office3D.vue")); // three.js loads only when 3D is shown
import AgentnetPanel from "../components/AgentnetPanel.vue";
import AgentChatView from "../components/AgentChatView.vue";
import AgentnetTeamPanel from "../components/AgentnetTeamPanel.vue";
import AgentnetTeamForm from "../components/AgentnetTeamForm.vue";
import AgentnetDirectorSetup from "../components/AgentnetDirectorSetup.vue";
import CheckSheet from "../components/CheckSheet.vue";
import TriageTip from "../components/TriageTip.vue";
import HookAddSheet from "./HookAddSheet.vue";
import { net, placing, useAgentnet, useAgentHooks, useTeams, staleSince, layoutKey, pendingChecks, checkUi, windows, windowCall } from "../net";
import { api, toast } from "../ui/api";
import { route, toHash } from "../router";

const SPAWN_CMD = 'bin/agentnet spawn hello-1 --job "say hello" --goal "hello task done and reported" --boot-prompt "Add one task, mark it done, report to your boss."';
const copied = ref(false);
async function copyCmd() { try { await navigator.clipboard.writeText(SPAWN_CMD); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { toast("Copy failed"); } }

const stop = useAgentnet(), stopTeams = useTeams();
// Map (org chart) or Cards; the choice is remembered per browser (storage can be blocked: then it is just Map).
const mode = ref<"map" | "cards">((() => { try { return localStorage.getItem("anv-mode") === "cards" ? "cards" : "map"; } catch { return "map"; } })());
watch(mode, (m) => { try { localStorage.setItem("anv-mode", m); } catch { /* not remembered */ } });

// 2D or 3D map, remembered per device. First visit: desktop 3D, phone 2D unless the device is fast; Reduce Motion or Save-Data start in 2D.
const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
const dimDefault = (): "2d" | "3d" => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || nav.connection?.saveData) return "2d";
  const phoneish = matchMedia("(max-width:760px)").matches;
  return phoneish && !((nav.hardwareConcurrency ?? 4) >= 8 && (nav.deviceMemory ?? 4) >= 4) ? "2d" : "3d";
};
const dim = ref<"2d" | "3d">((() => { const q = route.value.query.view; if (q === "2d" || q === "3d") return q; try { const v = localStorage.getItem("anv-dim"); return v === "2d" || v === "3d" ? v : dimDefault(); } catch { return dimDefault(); } })());
// the hash carries the choice too (#/agents?view=3d): a shared link opens the same view
const setDim = (d: "2d" | "3d") => { dim.value = d; failed3d.value = null; history.replaceState(null, "", toHash({ page: route.value.page, query: { ...route.value.query, view: d } })); route.value = { page: route.value.page, query: { ...route.value.query, view: d } }; try { localStorage.setItem("anv-dim", d); } catch { /* not remembered */ } };
watch(() => route.value.query.view, (v) => { if (v === "2d" || v === "3d") dim.value = v; });
const failed3d = ref<string | null>(null);
const fail3d = (why: string) => { failed3d.value = why; dim.value = "2d"; }; // not remembered: a later load tries 3D again

const ROOT = "root";
/** Groups by boss, recomputed only on a layoutKey change (status patches never move a card). */
const groups = shallowRef<{ boss: string; ids: string[] }[]>([]);
watch(() => layoutKey.value + "|" + [...placing].join(","), () => { // placing too: agents held back while the team list loads must appear when it clears
  const by = new Map<string, string[]>();
  for (const a of Object.values(net.agents)) { if (a.name === ROOT || placing.has(a.name)) continue; /* root has its own Director card; a new agent waits for its team (net.ts placing) */ const b = a.boss ?? ROOT; (by.get(b) ?? by.set(b, []).get(b)!).push(a.id); }
  const name = (id: string) => net.agents[id]?.name ?? id;
  groups.value = [...by.entries()].map(([boss, ids]) => ({ boss, ids: ids.sort((x, y) => name(x).localeCompare(name(y))) }))
    .sort((x, y) => (x.boss === ROOT ? -1 : y.boss === ROOT ? 1 : x.boss.localeCompare(y.boss)));
}, { immediate: true });
const rootRow = computed(() => Object.values(net.agents).find((a) => a.name === ROOT) ?? null);
const count = computed(() => Object.keys(net.agents).length);

// ---- side panel: kept open while its agent is in the map (also across a reconnect hello), closed otherwise ----
const sel = ref<string | null>(null);
const selRow = computed(() => (sel.value === ROOT ? rootRow.value : sel.value ? net.agents[sel.value] ?? null : null));
const selName = computed(() => (sel.value === ROOT ? ROOT : selRow.value?.name ?? ""));
watch(() => sel.value && sel.value !== ROOT && !sel.value.startsWith("team:") && !net.agents[sel.value], (missing) => { if (missing) sel.value = null; });
// Deep links: #/agents?agent=<name> opens that agent's panel (waits for the stream's hello if needed); ?team=<id> opens the team panel.
let applied = ""; // each link applies once, so closing the panel is not undone by the next stream update
function deepLink() {
  const q = route.value.query, key = q.team ? "t:" + q.team : q.agent ? "a:" + q.agent : "";
  if (!key || key === applied) return;
  if (q.team) { sel.value = "team:" + q.team; applied = key; return; }
  const name = q.agent, row = name === ROOT ? rootRow.value : Object.values(net.agents).find((a) => a.name === name);
  if (!row) return;
  sel.value = name === ROOT ? ROOT : row.id; applied = key;
}
deepLink();
watch(count, deepLink);
watch(() => route.value, () => { applied = ""; deepLink(); });
const setup = ref(/[?&]setup=1/.test(location.hash)), triageSheet = ref(false), tipN = ref(0);
const triageAdded = (_r: unknown, name: string) => { toast(`${name} added`); tipN.value++; };
/** The tab the agent panel opens on when it is opened from a team's Plans tab; any other way in starts on Now. */
const startTab = ref<"trail" | undefined>();
watch(sel, (_n, was) => { if (!was?.startsWith("team:")) startTab.value = undefined; });
// ---- the chat (owner 8362): a card opens the agent's chat over the page; its small Details button opens the side panel ----
// The chat lives in the hash (#/agents?chat=<name>&mode=panel|full), so a reload keeps it and Back closes it. It opens as a
// side panel (owner 8377); the header chip expands it to the full view and back.
const chatName = computed(() => route.value.query.chat || null);
const chatMode = computed<"panel" | "full">(() => (route.value.query.mode === "full" ? "full" : "panel"));
const chatCover = ref(0);
function setChatMode(m: "panel" | "full") {
  if (!chatName.value || m === chatMode.value) return;
  const r = { page: route.value.page, query: { ...route.value.query, mode: m } };
  history.replaceState(null, "", toHash(r)); route.value = r;
}
// The chat on screen: the route's, held a little longer while a floating chat shrinks back into its card (fly("out")).
// The same agent asked again mid-close turns the box round from where it is (no second copy).
const shownChat = ref<string | null>(chatName.value);
const chatView = ref<InstanceType<typeof AgentChatView> | null>(null);
let chatClosing = false;
watch(chatName, async (n) => {
  if (n) { const back = chatClosing && n === shownChat.value; chatClosing = false; shownChat.value = n; if (back) void chatView.value?.fly("in"); return; }
  const v = chatView.value; if (!v || !shownChat.value) { shownChat.value = null; return; }
  chatClosing = true;
  await v.fly("out");
  if (chatClosing && !chatName.value) { chatClosing = false; shownChat.value = null; }
});
const chatRow = computed(() => { const n = shownChat.value; return !n ? null : n === ROOT ? rootRow.value : Object.values(net.agents).find((a) => a.name === n) ?? null; });
let chatPushed = false, chatReturn: HTMLElement | null = null;
watch(chatName, (n) => { if (!n) { chatPushed = false; const t = chatReturn; chatReturn = null; if (t?.isConnected) nextTick(() => t.focus({ preventScroll: true })); } });
function openChat(id: string) {
  if (id.startsWith("team:") || (id === ROOT && !rootRow.value)) return pick(id); // a team opens its panel; no director yet opens the set-up
  const name = id === ROOT ? ROOT : net.agents[id]?.name; if (!name) return;
  sel.value = null; chatReturn = document.activeElement as HTMLElement | null;
  const query: Record<string, string> = { ...route.value.query, chat: name, mode: chatName.value ? chatMode.value : "panel" }; delete query.agent; delete query.team;
  const r = { page: route.value.page, query };
  if (chatName.value) history.replaceState(null, "", toHash(r)); else { history.pushState(null, "", toHash(r)); chatPushed = true; }
  route.value = r;
}
function closeChat() {
  if (!chatName.value) return;
  if (chatPushed) { chatPushed = false; history.back(); return; } // hashchange brings the route back
  const query = { ...route.value.query }; delete query.chat; delete query.mode;
  const r = { page: route.value.page, query }; history.replaceState(null, "", toHash(r)); route.value = r;
}
/** The card's Details button: the side panel (Now, Trail, Usage), never the chat. */
function details(id: string) { const n = id === ROOT ? ROOT : id; closeChat(); sel.value = n; }
const chatDetails = () => { const row = chatRow.value; if (row) details(row.name === ROOT ? ROOT : row.id); };
const pick = (id: string) => { if (id === ROOT && !rootRow.value) { if (hadRoot.value) void startRoot(true); else setup.value = true; return; } sel.value = sel.value === id ? null : id; };
// Hook stream only while something draws hooks (the map lane, or the open panel's Hooks section): Chrome allows
// 6 HTTP/1.1 connections per host, and this page already holds the main SSE plus the shared agentnet stream.
let stopHooks: (() => void) | null = null;
watch(() => mode.value === "map" || !!sel.value, (need) => {
  if (need && !stopHooks) stopHooks = useAgentHooks();
  else if (!need && stopHooks) { stopHooks(); stopHooks = null; }
}, { immediate: true });
onUnmounted(() => { stop(); stopTeams(); stopHooks?.(); });
// Phone: the panel becomes a bottom sheet on <body> (the page transition transforms this view, which would trap a fixed sheet).
const mq = matchMedia("(max-width:760px)");
const phone = ref(mq.matches);
const onMq = () => { phone.value = mq.matches; };
mq.addEventListener("change", onMq);
onUnmounted(() => mq.removeEventListener("change", onMq));

// The panel floats over the map/cards (never reflows them). Focus moves into it on open and back to the node or card
// that opened it on close; Esc, the X, the scrim (phone) or a tap outside (desktop) closes it.
const panel = ref<{ el: HTMLElement | null } | null>(null);
let returnTo: HTMLElement | null = null;
watch(sel, (id, prev) => {
  if (id && !prev) { returnTo = document.activeElement as HTMLElement | null; nextTick(() => panel.value?.el?.focus({ preventScroll: true })); }
  if (!id && prev) { const t = returnTo; returnTo = null; if (t?.isConnected) t.focus({ preventScroll: true }); }
  document.documentElement.style.overflow = id && phone.value && !half.value ? "hidden" : "";
});
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && sel.value) { e.preventDefault(); sel.value = null; } };
// Desktop outside tap: a real tap (not a map pan) outside the panel that is not on another node or card closes it.
let down: { x: number; y: number } | null = null;
const onPDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
const onPUp = (e: PointerEvent) => {
  const d = down; down = null;
  if (!sel.value || phone.value || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
  const t = e.target as Element | null;
  if (!t?.isConnected || panel.value?.el?.contains(t) || t.closest(".nd, .anc, .toast, [role='dialog']")) return;
  sel.value = null;
};
addEventListener("keydown", onKey); addEventListener("pointerdown", onPDown, true); addEventListener("pointerup", onPUp, true);
onUnmounted(() => { removeEventListener("keydown", onKey); removeEventListener("pointerdown", onPDown, true); removeEventListener("pointerup", onPUp, true); document.documentElement.style.overflow = ""; });
/** Map pixels the open panel covers on the right, so the map can slide the picked node out from under it. */
/** Phone + 3D: the sheet is half height with no backdrop, and the office keeps the picked room in view above it (board page 02, v4-phf). */
const half = computed(() => !!sel.value && phone.value && mode.value === "map" && dim.value === "3d");
watch(half, (h) => { document.documentElement.toggleAttribute("data-half", h); }, { immediate: true });
onUnmounted(() => document.documentElement.removeAttribute("data-half"));
const cover = computed(() => (phone.value ? 0 : sel.value ? 452 : chatName.value ? chatCover.value : 0)); // panel width plus its gap, same as the Cards view push; the chat reports its own (its full view keeps the panel's, so the page behind holds still)
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---- Terminal windows (M8) ----
async function win(path: string, what: string) {
  const r = await windowCall(path);
  if (r.code === "NOT_RUNNING" && path.startsWith("/agents/root/")) return startRoot(); // the director is not running: Start director, then open it
  if (r.code === "NOT_IN_TMUX") { moveAsk.value = true; return; } // runs outside tmux and no terminal app found: offer to move it into an agentnet window
  toast(r.ok ? what : r.detail ?? "Failed");
}
const moveAsk = ref(false), moving = ref(false), hadRoot = ref(false), lastRun = ref<{ session: string | null; dir: string | null; at: number } | null>(null);
// A director that ran before and is gone shows "Not running" + Start director; a first run shows the setup card.
const loadHad = async () => { try { const d = await api<{ hadRoot?: boolean; last?: typeof lastRun.value }>("v1/panel/director"); hadRoot.value = d.hadRoot === true; lastRun.value = d.last ?? null; } catch { /* keep */ } };
watch(() => !!rootRow.value, () => void loadHad(), { immediate: true });
/** Not running card: start the director where it last ran (tmux session agentnet-root), then open its window.
 *  resume = continue the last conversation (Resume director); false = a new conversation in the same folder (Start fresh). */
async function startRoot(resume = true) {
  try {
    const r = await api<{ resumed?: boolean }>("v1/panel/director/start", { method: "POST", body: { restart: true, resume } });
    toast(!resume ? "Started a new conversation" : r.resumed ? "Resumed the last conversation" : "Started a new conversation (the old one was not found)"); await win("/agents/root/open", "Opening the director in Terminal on the server Mac");
  } catch (e) { setup.value = true; toast((e as Error).message || "Could not start the director"); } // no tmux or claude: the setup sheet explains and gives the command
}
async function moveRoot() {
  moving.value = true;
  try { await api("v1/panel/director/move", { method: "POST" }); moveAsk.value = false; toast("Director moved into an agentnet window"); await win("/agents/root/open", "Opening the director in Terminal on the server Mac"); }
  catch (e) { toast((e as Error).message || "Could not move the director"); }
  finally { moving.value = false; }
}
const openWin = (name: string) => win(`/agents/${encodeURIComponent(name)}/open`, `Opening ${name} in Terminal on the server Mac`);
const closeWin = (name: string) => win(`/agents/${encodeURIComponent(name)}/close`, `Closed ${name}'s window; the agent keeps running`);
const closeAll = () => win("/windows/close-all", "Closed every agent window; agents keep running");
const newTeam = ref(false);
const TIP = "Terminal windows on the server Mac";
</script>

<template>
  <main class="anv" aria-label="Agents">
    <header :class="['ph', 'anv-h', { ov: mode === 'map' && !phone }]" :style="{ '--cover': cover + 'px' }">
      <span v-if="net.lastFrameAt > 0" class="pill anv-pill num" :class="net.connected && !staleSince ? 'ok' : 'warn'" role="status">
        {{ !net.connected ? "Reconnecting…" : staleSince ? `Stale since ${time(staleSince)}` : `${count} live` }}
      </span>
      <button v-if="pendingChecks.length" type="button" class="pill anv-wait" aria-haspopup="dialog" @click="checkUi.id = 0; checkUi.list = true">{{ pendingChecks.length }} waiting for you</button>
      <div class="seg" role="tablist" aria-label="View">
        <button type="button" role="tab" :aria-selected="mode === 'map'" :class="{ on: mode === 'map' }" @click="mode = 'map'"><Icon name="network" :size="14" /> Map</button>
        <button type="button" role="tab" :aria-selected="mode === 'cards'" :class="{ on: mode === 'cards' }" @click="mode = 'cards'"><Icon name="layout-grid" :size="14" /> Cards</button>
      </div>
      <div v-if="mode === 'map'" class="seg" role="tablist" aria-label="Map dimension">
        <button type="button" role="tab" :aria-selected="dim === '2d'" :class="{ on: dim === '2d' }" @click="setDim('2d')">2D</button>
        <button type="button" role="tab" :aria-selected="dim === '3d'" :class="{ on: dim === '3d' }" @click="setDim('3d')">3D</button>
      </div>
      <button type="button" class="btn sm ghost nt" @click="newTeam = true"><Icon name="plus" :size="15" /> New team</button>
      <button type="button" class="btn sm ghost cl" :disabled="!windows.available || !!windows.busy" :title="windows.available ? `Closes every agent window (${TIP}); agents keep running` : `${TIP} arrive with M8`" @click="closeAll">
        <Icon name="x" :size="15" /> Close all windows
      </button>
    </header>

    <CheckSheet />
    <TriageTip :director="!!rootRow" :refresh="tipN" @add="triageSheet = true" />
    <HookAddSheet :open="triageSheet" template="agentnet-triage" @close="triageSheet = false" @added="triageAdded" />

    <div :class="['anv-b', { pushed: !!sel && !phone, frozen: mode === 'map' && net.lastFrameAt > 0 && !net.connected }]">
      <Transition name="mode" mode="out-in">
      <Office3D v-if="mode === 'map' && dim === '3d'" key="map3" :selected="sel" :cover="cover" :half="half" @select="(id: string) => id && pick(id)" @fail="fail3d" />
      <AgentnetFiberMap v-else-if="mode === 'map'" key="map" :selected="sel" :cover="cover" :had-root="hadRoot" :last="lastRun" @select="openChat" @details="details" @resume="startRoot(true)" @fresh="startRoot(false)" />
      <section v-else key="cards" class="grid-wrap" aria-label="Live agents">
        <div class="grp">
          <h2>Director</h2>
          <div class="an-grid">
            <AgentCard :row="rootRow" :had-root="hadRoot" :last="lastRun" :name="ROOT" dir acts :sel="sel === ROOT" @pick="openChat(ROOT)" @details="details(ROOT)" @resume="startRoot(true)" @fresh="startRoot(false)" @open="openWin(ROOT)" @close="closeWin(ROOT)" />
          </div>
        </div>
        <TransitionGroup name="anc">
        <div v-for="g in groups" :key="g.boss" class="grp">
          <h2>Reports to {{ g.boss }} <span>{{ g.ids.length }}</span></h2>
          <TransitionGroup tag="div" name="anc" class="an-grid">
            <!-- keyed children only (no v-if inside): a gone id leaves the list, so the card gets its 200 ms leave fade -->
            <AgentCard v-for="id in g.ids.filter((x) => net.agents[x])" :key="id" :id="id" :row="net.agents[id]" :name="net.agents[id].name" acts :sel="sel === id"
              @pick="openChat(id)" @details="details(id)" @open="openWin(net.agents[id].name)" @close="closeWin(net.agents[id].name)" />
          </TransitionGroup>
        </div>
        </TransitionGroup>
        <div v-if="net.connected && !count" class="empty">
          <p>No live agents. Start one and it shows here within seconds.</p>
          <div class="cmd"><code>{{ SPAWN_CMD }}</code>
            <button type="button" class="cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copyCmd"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
        </div>
      </section>
      </Transition>

      <Transition name="acv"><AgentChatView v-if="shownChat" ref="chatView" :key="shownChat" :row="chatRow" :name="shownChat" :mode="chatMode" :phone="phone" @close="closeChat" @details="chatDetails" @mode="setChatMode" @cover="(px: number) => (chatCover = px)" /></Transition>

      <MapState v-if="mode === 'map'" :count="count" :cmd="SPAWN_CMD" :failed3d="dim === '2d' ? failed3d : null" @try3d="setDim('3d')" />

      <Teleport to="body"><div v-if="moveAsk" class="mv-scrim" @click.self="moveAsk = false" @keydown.esc="moveAsk = false">
        <div class="mv" role="alertdialog" aria-label="Move the director into an agentnet window?">
          <h3>Move the director into an agentnet window?</h3>
          <p>The director runs in a terminal agentnet cannot open. Agentnet can stop it and start it again in the same folder, inside its own window. Its current conversation ends; you can resume it with /resume.</p>
          <div class="mv-b"><button type="button" class="btn sm ghost" :disabled="moving" @click="moveAsk = false">Cancel</button>
            <button type="button" class="btn sm" :disabled="moving" @click="moveRoot">{{ moving ? "Moving…" : "Move director" }}</button></div>
        </div></div></Teleport>
      <Teleport to="body"><AgentnetDirectorSetup v-if="setup" @close="setup = false" /></Teleport>
      <Teleport to="body"><AgentnetTeamForm v-if="newTeam" @close="newTeam = false" @created="(id) => (sel = 'team:' + id)" /></Teleport>
      <Teleport to="body" :disabled="!phone">
            <Transition :name="phone ? 'sheet' : 'side'">
        <AgentnetTeamPanel v-if="sel?.startsWith('team:')" ref="panel" :key="'t' + (phone ? 'sheet' : 'side')" :id="sel.slice(5)" :sheet="phone" @close="sel = null" @select="(id: string, tab?: 'trail') => { startTab = tab; pick(id); }" />
        <AgentnetPanel v-else-if="sel" ref="panel" :key="phone ? 'sheet' : 'side'" :row="selRow" :name="selName" :sheet="phone" :start-tab="startTab"
          @close="sel = null" @chat="sel && openChat(sel)" @open="selRow && openWin(selRow.name)" @close-win="selRow && closeWin(selRow.name)" />
      </Transition>
      </Teleport>
    </div>
  </main>
</template>

<style>
html[data-half] .side-panel.sheet,html[data-half] .tp.sheet{height:46dvh !important;max-height:46dvh !important}
</style>
<style scoped>
.mv-scrim{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:rgba(0,0,0,.45);padding:16px}
.mv{max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
.mv h3{margin:0 0 8px;font-size:16px}.mv p{margin:0 0 16px;font-size:14px;line-height:1.5;color:var(--muted)}
.mv-b{display:flex;justify-content:flex-end;gap:8px}
.anv{position:relative;display:flex;flex-direction:column;height:100%;min-height:0}
/* on the map the controls float over its top edge (owner 8304): the map gets the full height; the right end stops before Fit and the open panel */
.anv-h.ov{position:absolute;top:10px;left:10px;right:calc(78px + var(--cover,0px));z-index:5;margin:0;pointer-events:none}
.anv-h.ov > *{pointer-events:auto}
.anv-h.ov .btn{background:var(--panel);border:1px solid var(--line)}
.anv-h{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.anv-pill{padding:4px 10px;background:var(--on-bg);color:var(--on);font:600 12px/1.2 var(--body)}
.anv-pill.warn{background:var(--warn-bg);color:var(--warn)}
.anv-wait{border:1px solid color-mix(in srgb,var(--pend) 60%,transparent);background:var(--pend-bg);color:var(--pend-ink);font:700 13px var(--body);min-height:36px;padding:0 14px;cursor:pointer;animation:wpop .4s var(--spring)}
.anv-wait:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
@keyframes wpop{from{transform:scale(.85);opacity:0}}
@media (max-width:760px){.anv-wait{min-height:44px}}
@media (prefers-reduced-motion:reduce){.anv-wait{animation:none}}
.cl{display:inline-flex;align-items:center;gap:5px;margin-left:auto}
.nt{display:inline-flex;align-items:center;gap:5px;margin-left:auto}
.nt + .cl{margin-left:0}
.seg{flex:none;display:inline-flex;flex-direction:row;flex-wrap:nowrap;white-space:nowrap;padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.seg button{flex:none;width:auto;display:inline-flex;flex-direction:row;white-space:nowrap;align-items:center;gap:5px;min-height:34px;padding:0 12px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:600 13px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.seg button.on{background:var(--track);color:var(--ink)}
.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.mode-enter-active,.mode-leave-active{transition:opacity .18s var(--ease)}
.mode-enter-from,.mode-leave-to{opacity:0}
.anv-b{flex:1;min-height:0;display:flex;gap:16px;position:relative}
.anv-b.frozen :deep(.fm),.anv-b.frozen :deep(.o3){filter:grayscale(1);opacity:.55;pointer-events:none}
.grid-wrap{flex:1;min-width:0;overflow-y:auto;padding-bottom:16px;transition:margin-right .3s cubic-bezier(.2,.8,.2,1)}
.anv-b.pushed .grid-wrap{margin-right:452px}
@media (prefers-reduced-motion:reduce){.grid-wrap{transition:none}}
.grp{margin-bottom:18px}
.grp h2{margin:0 0 8px;color:var(--muted);font:600 13px/1.2 var(--body)}
.grp h2 span{margin-left:4px;opacity:.7}
.an-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));grid-auto-rows:1fr;gap:16px;padding:2px}
.empty{color:var(--muted)}
.empty p{margin:0 0 10px}
.cmd{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.cmd code{flex:1;min-width:0;white-space:normal;word-break:break-word;color:var(--ink);font:12.5px/1.4 var(--mono)}
.cp{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:36px;padding:0 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--ink);font:600 12px var(--body);cursor:pointer;transition:background .15s var(--ease)}
.cp:hover{background:var(--panel-2)}
.anc-leave-active{transition:opacity .2s var(--ease),transform .2s var(--ease)}
.anc-leave-to{opacity:0;transform:scale(.96)}
.anc-enter-active{transition:opacity .25s var(--ease),transform .25s var(--ease)}
.anc-enter-from{opacity:0;transform:translateY(6px)}
.anc-move{transition:transform .25s var(--ease)}
/* panel motion (the panel itself is AgentnetPanel.vue): slides in over the right edge, a sheet rises on a phone */
.side-enter-active,.side-leave-active,.sheet-enter-active,.sheet-leave-active{transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.side-enter-from,.side-leave-to{transform:translateX(calc(100% + 24px));opacity:0}
.sheet-enter-from,.sheet-leave-to{transform:translateY(100%)}
/* while the side panel slides, its box reaches past the right edge and would widen the page's scroll width. Clip it for that time only.
   The 20px margin is the page padding, so the panel's shadow paints exactly as before and nothing pops when the slide ends. */
.anv:has(> .anv-b > .side-enter-active,> .anv-b > .side-leave-active){contain:paint;overflow-clip-margin:20px}
/* the chat opens: the docked panel slides in from the right edge like the details panel, the floating one and the full view
   rise and fade; transform and opacity only (Motion board: 360 ms cubic-bezier(.2,.8,.2,1)) */
/* Motion board view timing: 260 ms in, 180 ms out, cubic-bezier(.23,1,.32,1) (same as the expand/collapse FLIP) */
.acv-enter-active,.acv-leave-active{transition:opacity .18s cubic-bezier(.23,1,.32,1),transform .26s cubic-bezier(.23,1,.32,1)}
.acv-leave-active{transition-duration:.15s,.18s}
.acv-enter-from,.acv-leave-to{opacity:0;transform:translateY(8px) scale(.995)}
/* owner 8436: the docked chat only moves, it does not fade */
.acv-enter-from.dock,.acv-leave-to.dock,.acv-leave-to.full{opacity:1;transform:translateX(calc(100% + 24px))}
.anv:has(> .anv-b > .acv.dock.acv-enter-active,> .anv-b > .acv.dock.acv-leave-active,> .anv-b > .acv.full.acv-leave-active){contain:paint;overflow-clip-margin:20px}
/* the floating chat grows out of its card and shrinks back (AgentChatView fly()); Vue's CSS run stays out of its way */
@media (prefers-reduced-motion:no-preference){.acv-enter-active.float,.acv-leave-active.float{transition:none}.acv-enter-from.float,.acv-leave-to.float{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.acv-enter-active,.acv-leave-active{transition:opacity .15s}.acv-enter-from,.acv-leave-to,.acv-enter-from.dock,.acv-leave-to.dock,.acv-leave-to.full{transform:none}.acv-enter-from.dock,.acv-leave-to.dock,.acv-leave-to.full{opacity:0}}
.anv-scrim{position:fixed;inset:0;z-index:60;background:transparent} /* sheets have no dark backdrop (board page 00); a tap outside still closes */
.scrim-enter-active,.scrim-leave-active{transition:opacity .22s var(--ease)}
.scrim-enter-from,.scrim-leave-to{opacity:0}
@media (max-width:760px){
  .an-grid{grid-template-columns:1fr}
  .cl{margin-left:0}
}
@media (prefers-reduced-motion:reduce){.anc-leave-active,.anc-enter-active,.anc-move{transition:opacity .01s}.side-enter-active,.side-leave-active,.sheet-enter-active,.sheet-leave-active{transition:opacity .2s var(--ease)}.side-enter-from,.side-leave-to,.sheet-enter-from,.sheet-leave-to{transform:none;opacity:0}}
</style>
