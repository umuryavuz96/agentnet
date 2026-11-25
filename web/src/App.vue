<script setup lang="ts">
import { themePref } from "./theme";
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import Icon from "./ui/Icon.vue";
import OfflineBar from "./ui/OfflineBar.vue";
import type { IconName } from "./ui/icons";
import { api, toastMsg } from "./ui/api";
import { PAGES, route, toHash, type Page } from "./router";
import { noteHostHash, noteRoute, postRoute, readEmbed } from "./embed";
import Agents from "./pages/Agents.vue";
import { waitingItems } from "./waiting";
import { useAgentnet, useUsage, usage } from "./net";
import Asks from "./pages/Asks.vue";
import Usage from "./pages/Usage.vue";
import Scores from "./pages/Scores.vue";
import Trails from "./pages/Trails.vue";
import Lines from "./pages/Lines.vue";
import Search from "./pages/Search.vue";
import Activity from "./pages/Activity.vue";
import Hooks from "./pages/Hooks.vue";
import Routing from "./pages/Routing.vue";
import Brains from "./pages/Brains.vue";
import Settings from "./pages/Settings.vue";
import BrandLockup from "./brand/BrandLockup.vue";
import Evals from "./pages/Evals.vue";
import UpdatePill from "./components/UpdatePill.vue";
import CommandPalette from "./components/CommandPalette.vue";

const em = readEmbed(location.search);
const COMPONENTS: Record<Page, Component> = { agents: Agents, asks: Asks, usage: Usage, scores: Scores, trails: Trails, lines: Lines, search: Search, activity: Activity, hooks: Hooks, routing: Routing, brains: Brains, evals: Evals, settings: Settings };
const NAV: Record<Page, [string, IconName]> = {
  agents: ["Agents", "network"], asks: ["Asks", "circle-check"], usage: ["Usage", "chart-line"], scores: ["Scores", "gauge"], trails: ["Trails", "history"], lines: ["Lines", "layers"],
  search: ["Search", "search"], activity: ["Activity", "activity"], hooks: ["Hooks", "webhook"], routing: ["Routing", "sliders"], brains: ["Brains", "brain"], evals: ["Evals", "gauge"], settings: ["Settings", "settings"],
};
/** Rail groups (board page 01). Search stays a page until the palette lands. */
const GROUPS: { title: string; pages: Page[] }[] = [
  { title: "Network", pages: ["asks", "agents", "activity", "search"] },
  { title: "Insights", pages: ["usage", "scores", "evals", "trails", "lines"] },
  { title: "Setup", pages: ["hooks", "routing", "brains"] },
];
const TABS: Page[] = ["agents", "asks", "activity", "usage"];
const MORE: Page[] = ["search", "scores", "evals", "trails", "lines", "hooks", "routing", "brains", "settings"];
const palette = ref(false);
let stopNet: (() => void) | null = null, stopUsage: (() => void) | null = null; // the rail counts need the live stream and the usage poll on every page
// Setup counts: hooks switched off or failing, and the routing mode when it is not normal. One light GET each, every 60 s.
const hookBad = ref(0), routeMode = ref("");
async function loadRail() {
  try {
    const r = await api<{ hooks: { name: string; script: string; enabled: boolean; failures: number }[] }>("v1/panel/hooks");
    const g = new Map<string, boolean>();
    for (const h of r.hooks) { const k = h.name + "\u0000" + h.script; g.set(k, (g.get(k) ?? false) || !h.enabled || h.failures > 0); }
    hookBad.value = [...g.values()].filter(Boolean).length;
  } catch { /* keep the last count */ }
  try { routeMode.value = (await api<{ mode: { mode: string } }>("v1/panel/routing")).mode.mode; } catch { /* keep */ }
}
let railTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { stopNet = useAgentnet(); stopUsage = useUsage(); void loadRail(); railTimer = setInterval(loadRail, 60_000); });
onBeforeUnmount(() => { stopNet?.(); stopUsage?.(); clearInterval(railTimer); });
const weekPct = computed(() => usage.data?.windows.weekly.accountPct ?? null);
const count = (p: Page): string | number =>
  p === "asks" ? waitingItems.value.length
  : p === "usage" ? (weekPct.value != null ? Math.round(weekPct.value) + "%" : 0)
  : p === "hooks" ? hookBad.value
  : p === "routing" ? (routeMode.value && routeMode.value !== "normal" ? routeMode.value : 0)
  : 0;
const page = computed(() => route.value.page);
/** The page on screen. The shell layout follows it when the new page enters, so the old page keeps its layout while it fades out (out-in). */
const shownPage = ref(page.value);
const current = computed(() => COMPONENTS[page.value]);

// Theme: the host's choice in embed mode, else the system setting.
const mq = matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => { document.documentElement.dataset.theme = em.theme ?? (themePref.value !== "system" ? themePref.value : mq.matches ? "light" : "dark"); };
applyTheme(); mq.addEventListener("change", applyTheme); watch(themePref, applyTheme);

// Embed: tell the host about route changes (the host may also set our hash; noteRoute stops the echo).
if (em.embed) {
  noteRoute(location.hash);
  noteHostHash(location.hash);
  window.addEventListener("hashchange", () => noteHostHash(location.hash));
  watch(route, (r) => postRoute(toHash(r)));
}

// Health dot
const health = ref<{ ok: boolean; title: string; ver?: string }>({ ok: false, title: "checking" });
async function checkHealth() {
  try { const h = await api<{ name?: string; version?: string }>("v1/health"); health.value = { ok: h.name === "agentnet", title: h.version ? `agentnet ${h.version}` : "agentnet", ver: h.version }; }
  catch (e) { health.value = { ok: false, title: (e as Error).message }; }
}
let timer: ReturnType<typeof setInterval>;
const menu = ref(false);
const onKey = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); palette.value = !palette.value; }
  if (e.key === "Escape") menu.value = false;
};
onMounted(() => { if (!em.embed) { void checkHealth(); timer = setInterval(checkHealth, 30_000); } addEventListener("keydown", onKey); });
onBeforeUnmount(() => { clearInterval(timer); removeEventListener("keydown", onKey); mq.removeEventListener("change", applyTheme); });
watch(page, () => { menu.value = false; });
</script>

<template>
  <div class="shell" :class="{ embed: em.embed, fixed: shownPage === 'agents' || shownPage === 'asks' || shownPage === 'usage' || shownPage === 'scores' || shownPage === 'trails' || shownPage === 'lines' || shownPage === 'search' || shownPage === 'activity' || shownPage === 'hooks' || shownPage === 'brains' || shownPage === 'evals' || shownPage === 'routing' || shownPage === 'settings' }">
    <aside v-if="!em.embed" class="rail" aria-label="agentnet">
      <a class="brand" href="#/agents" aria-label="agentnet home"><BrandLockup :height="26" /></a>
      <button type="button" class="find" title="Find or run (⌘K)" @click="palette = true"><Icon name="search" :size="16" /><span>Find or run</span><kbd>⌘K</kbd></button>
      <nav class="nav" aria-label="Pages">
        <template v-for="g in GROUPS" :key="g.title">
          <h6>{{ g.title }}</h6>
          <a v-for="p in g.pages" :key="p" :href="'#/' + p" :title="NAV[p][0]" :class="{ on: page === p }" :aria-current="page === p ? 'page' : undefined"><Icon :name="NAV[p][1]" :size="18" /><span>{{ NAV[p][0] }}</span><i v-if="count(p)" class="cnt num">{{ count(p) }}</i></a>
        </template>
      </nav>
      <div class="foot">
        <a href="#/settings" title="Settings" :class="{ on: page === 'settings' }" :aria-current="page === 'settings' ? 'page' : undefined"><Icon name="settings" :size="18" /><span>Settings</span></a>
        <UpdatePill />
        <span class="svc" role="status"><i class="dot" :class="health.ok ? 'ok' : 'bad'" :title="health.title" /><span>{{ health.ok ? "Service up" : "Not answering" }}<small v-if="health.ver"> · {{ health.ver }}</small></span></span>
      </div>
    </aside>
    <header v-if="!em.embed" class="bar">
      <h1 class="ptitle">{{ NAV[page][0] }}</h1>
      <UpdatePill />
      <button type="button" class="sbtn" aria-label="Search" @click="palette = true"><Icon name="search" :size="20" /></button>
      <span class="dot" :class="health.ok ? 'ok' : 'bad'" :title="health.title" role="status" :aria-label="health.ok ? 'agentnet is up' : 'agentnet is not answering'" />
    </header>
    <div class="body">
      <OfflineBar v-if="!em.embed && page !== 'agents'" />
      <Transition name="pg" mode="out-in" @before-enter="shownPage = page"><component :is="current" :key="page" /></Transition>
    </div>
    <Transition name="sh">
      <div v-if="menu && !em.embed" class="more" role="dialog" aria-label="More pages">
        <div class="grab" aria-hidden="true" />
        <template v-for="g in GROUPS.slice(1)" :key="g.title">
          <h6>{{ g.title }}</h6>
          <a v-for="p in g.pages.filter((x) => !TABS.includes(x))" :key="p" :href="'#/' + p" :class="{ on: page === p }" @click="menu = false"><Icon :name="NAV[p][1]" :size="20" /> {{ NAV[p][0] }}</a>
          <a v-if="g.title === 'Setup'" href="#/settings" :class="{ on: page === 'settings' }" @click="menu = false"><Icon name="settings" :size="20" /> Settings</a>
        </template>
      </div>
    </Transition>
    <nav v-if="!em.embed" class="tabs" aria-label="Pages">
      <a v-for="p in TABS" :key="p" :href="'#/' + p" :class="{ on: page === p }" :aria-current="page === p ? 'page' : undefined" @click="menu = false"><Icon :name="NAV[p][1]" :size="20" /><span>{{ NAV[p][0] }}</span><i v-if="count(p)" class="cnt num">{{ count(p) }}</i></a>
      <button type="button" :class="{ on: menu || MORE.includes(page) }" :aria-expanded="menu" @click="menu = !menu"><Icon name="ellipsis" :size="20" /><span>More</span></button>
    </nav>
    <CommandPalette v-if="!em.embed" :open="palette" :nav="NAV" @close="palette = false" />
    <Transition name="toast"><div v-if="toastMsg.text" class="toast" role="status">{{ toastMsg.text }}</div></Transition>
  </div>
</template>

<style scoped>
.shell{min-height:100dvh;display:grid;grid-template-columns:232px minmax(0,1fr);grid-template-rows:auto 1fr}
.shell.fixed{height:100dvh;overflow:hidden}
.shell.embed{grid-template-columns:minmax(0,1fr)}
.rail{grid-row:1/3;display:flex;flex-direction:column;gap:2px;padding:14px 12px;background:var(--panel-2);border-right:1px solid var(--line);position:sticky;top:0;height:100dvh;overflow-y:auto;z-index:50}
.brand{display:inline-flex;align-items:center;color:var(--ink);text-decoration:none;border-radius:6px;padding:4px 8px 14px}
.find{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;min-height:40px;margin:0 0 4px;padding:0 10px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);font:500 13px var(--body);cursor:pointer}.find:hover{color:var(--ink)}.find:focus-visible{outline:2px solid var(--on);outline-offset:1px}.find kbd{margin-left:auto;font:500 11px/1 var(--mono)}
.cnt{margin-left:auto;min-width:20px;padding:2px 6px;border-radius:999px;background:var(--ink);color:var(--bg);font:600 11px/16px var(--mono);font-style:normal;text-align:center}
.nav{display:flex;flex-direction:column;gap:2px}
.nav h6{margin:14px 8px 4px;font:600 12px/1 var(--body);color:var(--muted)}
.rail a:not(.brand){display:flex;align-items:center;gap:10px;min-height:40px;padding:0 10px;border-radius:9px;color:var(--muted);font:600 14px var(--body);text-decoration:none;white-space:nowrap;transition:background-color .15s var(--ease),color .15s var(--ease)}
.rail a:not(.brand):hover{color:var(--ink)}
.rail a.on{background:var(--track);color:var(--ink)}
.rail a:focus-visible,.brand:focus-visible,.sbtn:focus-visible,.tabs a:focus-visible,.tabs button:focus-visible,.more a:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.foot{margin-top:auto;display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:1px solid var(--line)}
.svc{display:flex;align-items:center;gap:8px;padding:6px 12px;font:500 12px var(--body);color:var(--muted);white-space:nowrap}.svc small{font-size:12px}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--bad)}
.dot.ok{background:var(--on)}
.bar,.tabs,.more{display:none}
.bar .brand{padding:0;flex:none}
.body{grid-column:2;grid-row:2;min-width:0;min-height:0;display:flex;flex-direction:column;width:100%;padding:16px 20px}
.embed .body{grid-column:1;grid-row:1;padding:12px}
.body > :deep(*){min-height:0}
.fixed .body{overflow:hidden}
.fixed .body > :deep(.anv),.fixed .body > :deep(.wt),.fixed .body > :deep(.fp),.fixed .body > :deep(.hk),.fixed .body > :deep(.rp),.fixed .body > :deep(.st){flex:1}
.pg-enter-active,.pg-leave-active{transition:opacity .14s var(--ease)}
.pg-enter-from,.pg-leave-to{opacity:0}
.sh-enter-active,.sh-leave-active{transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .2s var(--ease)}
.sh-enter-from,.sh-leave-to{transform:translateY(100%);opacity:0}
/* 768-1279: the rail folds to 64 px icons, names on hover (title) */
@media (max-width:1279px){
  .shell{grid-template-columns:64px minmax(0,1fr)}
  .rail{padding:14px 10px;align-items:center}
  .rail span,.nav h6,.find kbd{display:none}
  .rail a:not(.brand){position:relative}.rail .cnt{position:absolute;top:2px;right:0;margin:0;min-width:16px;padding:0 4px;font-size:10px;line-height:16px}
  .find{width:44px;height:44px;padding:0;justify-content:center}
  .nav{align-items:center}
  .rail a:not(.brand){width:44px;height:44px;padding:0;justify-content:center}
  .rail .brand{padding:0 0 12px;max-width:44px;overflow:hidden}
  .foot{align-items:center}.svc{padding:6px 0}.svc span{display:none}
}
/* phone: top bar + four bottom tabs, More is a half sheet with no backdrop */
@media (max-width:760px){
  .shell{grid-template-columns:minmax(0,1fr);grid-template-rows:auto 1fr auto}
  .shell.embed{grid-template-rows:1fr}
  .rail{display:none}
  .bar{display:flex;align-items:center;gap:12px;grid-column:2;grid-column:1;grid-row:1;height:var(--bar-h);padding:0 16px;border-bottom:1px solid var(--line);background:var(--panel-2);position:sticky;top:0;z-index:50}
  .bar .sbtn{all:unset;box-sizing:border-box;cursor:pointer;margin-left:auto;display:grid;place-items:center;width:44px;height:44px;border-radius:10px;color:var(--ink)}
  .ptitle{margin:0;font:700 20px/1 var(--head,var(--body));color:var(--ink)}
  .body :deep(h1){display:none}
  .body{grid-column:1;grid-row:2;padding:12px}
  .tabs{display:grid;grid-template-columns:repeat(5,1fr);grid-column:1;grid-row:3;position:sticky;bottom:0;z-index:50;background:var(--panel-2);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
  .tabs a,.tabs button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:56px;border:0;background:transparent;color:var(--muted);font:600 11px var(--body);text-decoration:none;cursor:pointer}
  .tabs .on{color:var(--ink)}
  .tabs a{position:relative}.tabs .cnt{position:absolute;top:6px;left:calc(50% + 6px);margin:0;min-width:16px;padding:0 4px;font-size:10px;line-height:16px}
  .more{display:flex;flex-direction:column;gap:2px;position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));z-index:49;padding:8px 12px 12px;background:var(--panel);border:1px solid var(--line);border-radius:16px 16px 0 0;max-height:60dvh;overflow-y:auto}
  .more .grab{align-self:center;width:40px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--ink) 28%,transparent);margin:4px 0 6px}
  .more h6{margin:12px 8px 4px;font:600 12px/1 var(--body);color:var(--muted)}
  .more a{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 10px;border-radius:10px;color:var(--ink);font:500 15px var(--body);text-decoration:none}
  .more a.on{background:var(--track)}
}
@media (prefers-reduced-motion:reduce){.sh-enter-active,.sh-leave-active{transition:opacity .15s}.sh-enter-from,.sh-leave-to{transform:none}}
</style>
