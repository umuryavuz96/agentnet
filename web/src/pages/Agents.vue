<script setup lang="ts">
// Live Agents page: reads only /api/v1/agentnet/stream (hello + merge patches + gone + msg + ping).
// Cards are grouped by boss, the grouping is recomputed only when the id:boss:job set changes, a gone card fades out
// in 200 ms, and a click opens the side panel with the agent's tasks and message threads. AgmsgView stays as it was.
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetCard from "../components/AgentnetCard.vue";
import AgentnetMap from "../components/AgentnetMap.vue";
import AgentnetPanel from "../components/AgentnetPanel.vue";
import AgentnetTeamPanel from "../components/AgentnetTeamPanel.vue";
import AgentnetTeamForm from "../components/AgentnetTeamForm.vue";
import { net, useAgentnet, useAgentHooks, useTeams, staleSince, layoutKey, windows, windowCall } from "../net";
import { toast } from "../ui/api";
import { route } from "../router";

const SPAWN_CMD = 'bin/agentnet spawn hello-1 --job "say hello" --boot-prompt "Add one task, mark it done, report to your boss."';
const copied = ref(false);
async function copyCmd() { try { await navigator.clipboard.writeText(SPAWN_CMD); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { toast("Copy failed"); } }

const stop = useAgentnet(), stopTeams = useTeams();
// Map (org chart) or Cards; the choice is remembered per browser (storage can be blocked: then it is just Map).
const mode = ref<"map" | "cards">((() => { try { return localStorage.getItem("anv-mode") === "cards" ? "cards" : "map"; } catch { return "map"; } })());
watch(mode, (m) => { try { localStorage.setItem("anv-mode", m); } catch { /* not remembered */ } });

const ROOT = "root";
/** Groups by boss, recomputed only on a layoutKey change (status patches never move a card). */
const groups = shallowRef<{ boss: string; ids: string[] }[]>([]);
watch(layoutKey, () => {
  const by = new Map<string, string[]>();
  for (const a of Object.values(net.agents)) { if (a.name === ROOT) continue; /* root has its own Director card */ const b = a.boss ?? ROOT; (by.get(b) ?? by.set(b, []).get(b)!).push(a.id); }
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
const pick = (id: string) => { sel.value = sel.value === id ? null : id; };
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
  document.documentElement.style.overflow = id && phone.value ? "hidden" : "";
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
const cover = computed(() => (sel.value && !phone.value ? 424 : 0));
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---- Terminal windows (M8) ----
async function win(path: string, what: string) {
  const r = await windowCall(path);
  toast(r.ok ? what : r.detail ?? "Failed");
}
const openWin = (name: string) => win(`/agents/${encodeURIComponent(name)}/open`, `Opening ${name} in Terminal on the server Mac`);
const closeWin = (name: string) => win(`/agents/${encodeURIComponent(name)}/close`, `Closed ${name}'s window; the agent keeps running`);
const closeAll = () => win("/windows/close-all", "Closed every agent window; agents keep running");
const newTeam = ref(false);
const TIP = "Terminal windows on the server Mac";
</script>

<template>
  <main class="anv">
    <header class="ph anv-h">
      <h1>Agents</h1>
      <span class="pill anv-pill" :class="net.connected && !staleSince ? 'ok' : 'warn'" role="status">
        {{ !net.connected ? "Reconnecting…" : staleSince ? `Stale since ${time(staleSince)}` : `${count} live` }}
      </span>
      <div class="seg" role="tablist" aria-label="View">
        <button type="button" role="tab" :aria-selected="mode === 'map'" :class="{ on: mode === 'map' }" @click="mode = 'map'"><Icon name="network" :size="14" /> Map</button>
        <button type="button" role="tab" :aria-selected="mode === 'cards'" :class="{ on: mode === 'cards' }" @click="mode = 'cards'"><Icon name="layout-grid" :size="14" /> Cards</button>
      </div>
      <button type="button" class="btn sm ghost nt" @click="newTeam = true"><Icon name="plus" :size="15" /> New team</button>
      <button type="button" class="btn sm ghost cl" :disabled="!windows.available || !!windows.busy" :title="windows.available ? `Closes every agent window (${TIP}); agents keep running` : `${TIP} arrive with M8`" @click="closeAll">
        <Icon name="x" :size="15" /> Close all windows
      </button>
    </header>

    <div class="anv-b">
      <Transition name="mode" mode="out-in">
      <AgentnetMap v-if="mode === 'map'" key="map" :selected="sel" :cover="cover" @select="pick" />
      <section v-else key="cards" class="grid-wrap" aria-label="Live agents">
        <div class="grp">
          <h2>Director</h2>
          <div class="an-grid">
            <AgentnetCard :row="rootRow" :name="ROOT" :selected="sel === ROOT" @select="pick(ROOT)" @open="openWin(ROOT)" @close="closeWin(ROOT)" />
          </div>
        </div>
        <TransitionGroup name="anc">
        <div v-for="g in groups" :key="g.boss" class="grp">
          <h2>Reports to {{ g.boss }} <span>{{ g.ids.length }}</span></h2>
          <TransitionGroup tag="div" name="anc" class="an-grid">
            <!-- keyed children only (no v-if inside): a gone id leaves the list, so the card gets its 200 ms leave fade -->
            <AgentnetCard v-for="id in g.ids.filter((x) => net.agents[x])" :key="id" :row="net.agents[id]" :name="net.agents[id].name" :selected="sel === id"
              @select="pick(id)" @open="openWin(net.agents[id].name)" @close="closeWin(net.agents[id].name)" />
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

      <Teleport to="body"><AgentnetTeamForm v-if="newTeam" @close="newTeam = false" @created="(id) => (sel = 'team:' + id)" /></Teleport>
      <Teleport to="body" :disabled="!phone">
      <Transition name="scrim"><div v-if="sel && phone" class="anv-scrim" aria-hidden="true" @click="sel = null" /></Transition>
      <Transition :name="phone ? 'sheet' : 'side'">
        <AgentnetTeamPanel v-if="sel?.startsWith('team:')" ref="panel" :key="'t' + (phone ? 'sheet' : 'side')" :id="sel.slice(5)" :sheet="phone" @close="sel = null" @select="pick" />
        <AgentnetPanel v-else-if="sel" ref="panel" :key="phone ? 'sheet' : 'side'" :row="selRow" :name="selName" :sheet="phone"
          @close="sel = null" @open="selRow && openWin(selRow.name)" @close-win="selRow && closeWin(selRow.name)" />
      </Transition>
      </Teleport>
    </div>
  </main>
</template>

<style scoped>
.anv{display:flex;flex-direction:column;height:100%;min-height:0}
.anv-h{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.anv-pill{padding:4px 10px;background:var(--on-bg);color:var(--on);font:600 12px/1.2 var(--body)}
.anv-pill.warn{background:var(--warn-bg);color:var(--warn)}
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
.grid-wrap{flex:1;min-width:0;overflow-y:auto;padding-bottom:16px}
.grp{margin-bottom:18px}
.grp h2{margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.grp h2 span{margin-left:4px;opacity:.7}
.an-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));grid-auto-rows:1fr;gap:12px}
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
.anv-scrim{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5)}
.scrim-enter-active,.scrim-leave-active{transition:opacity .22s var(--ease)}
.scrim-enter-from,.scrim-leave-to{opacity:0}
@media (max-width:760px){
  .an-grid{grid-template-columns:1fr}
  .cl{margin-left:0}
}
@media (prefers-reduced-motion:reduce){.anc-leave-active,.anc-enter-active,.anc-move{transition:opacity .01s}.side-enter-active,.side-leave-active,.sheet-enter-active,.sheet-leave-active{transition:opacity .2s var(--ease)}.side-enter-from,.side-leave-to,.sheet-enter-from,.sheet-leave-to{transform:none;opacity:0}}
</style>
