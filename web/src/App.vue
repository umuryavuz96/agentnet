<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import Icon from "./ui/Icon.vue";
import type { IconName } from "./ui/icons";
import { api, toastMsg } from "./ui/api";
import { PAGES, route, toHash, type Page } from "./router";
import { noteHostHash, noteRoute, postRoute, readEmbed } from "./embed";
import Agents from "./pages/Agents.vue";
import Usage from "./pages/Usage.vue";
import Scores from "./pages/Scores.vue";
import Trails from "./pages/Trails.vue";
import Search from "./pages/Search.vue";
import Hooks from "./pages/Hooks.vue";
import Routing from "./pages/Routing.vue";
import Personas from "./pages/Personas.vue";

const em = readEmbed(location.search);
const COMPONENTS: Record<Page, Component> = { agents: Agents, usage: Usage, scores: Scores, trails: Trails, search: Search, hooks: Hooks, routing: Routing, personas: Personas };
const NAV: Record<Page, [string, IconName]> = {
  agents: ["Agents", "network"], usage: ["Usage", "chart-line"], scores: ["Scores", "gauge"], trails: ["Trails", "history"],
  search: ["Search", "search"], hooks: ["Hooks", "webhook"], routing: ["Routing", "sliders"], personas: ["Personas", "sparkles"],
};
const page = computed(() => route.value.page);
/** The page on screen. The shell layout follows it when the new page enters, so the old page keeps its layout while it fades out (out-in). */
const shownPage = ref(page.value);
const current = computed(() => COMPONENTS[page.value]);

// Theme: the host's choice in embed mode, else the system setting.
const mq = matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => { document.documentElement.dataset.theme = em.theme ?? (mq.matches ? "light" : "dark"); };
applyTheme(); mq.addEventListener("change", applyTheme);

// Embed: tell the host about route changes (the host may also set our hash; noteRoute stops the echo).
if (em.embed) {
  noteRoute(location.hash);
  noteHostHash(location.hash);
  window.addEventListener("hashchange", () => noteHostHash(location.hash));
  watch(route, (r) => postRoute(toHash(r)));
}

// Health dot
const health = ref<{ ok: boolean; title: string }>({ ok: false, title: "checking" });
async function checkHealth() {
  try { const h = await api<{ name?: string; version?: string }>("v1/health"); health.value = { ok: h.name === "agentnet", title: h.version ? `agentnet ${h.version}` : "agentnet" }; }
  catch (e) { health.value = { ok: false, title: (e as Error).message }; }
}
let timer: ReturnType<typeof setInterval>;
const menu = ref(false);
const onKey = (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); location.hash = "#/search"; }
  if (e.key === "Escape") menu.value = false;
};
onMounted(() => { if (!em.embed) { void checkHealth(); timer = setInterval(checkHealth, 30_000); } addEventListener("keydown", onKey); });
onBeforeUnmount(() => { clearInterval(timer); removeEventListener("keydown", onKey); mq.removeEventListener("change", applyTheme); });
watch(page, () => { menu.value = false; });
</script>

<template>
  <div class="shell" :class="{ embed: em.embed, fixed: shownPage === 'agents' }">
    <header v-if="!em.embed" class="bar">
      <a class="brand" href="#/agents">agentnet</a>
      <nav class="links" aria-label="Pages">
        <a v-for="p in PAGES" :key="p" :href="'#/' + p" :class="{ on: page === p }" :aria-current="page === p ? 'page' : undefined"><Icon :name="NAV[p][1]" :size="16" /> {{ NAV[p][0] }}</a>
      </nav>
      <span class="dot" :class="health.ok ? 'ok' : 'bad'" :title="health.title" role="status" :aria-label="health.ok ? 'agentnet is up' : 'agentnet is not answering'" />
      <button type="button" class="burger" :aria-expanded="menu" aria-label="Menu" @click="menu = !menu"><Icon :name="menu ? 'x' : 'menu'" :size="20" /></button>
    </header>
    <Transition name="ov">
      <nav v-if="menu && !em.embed" class="overlay" aria-label="Pages">
        <a v-for="p in PAGES" :key="p" :href="'#/' + p" :class="{ on: page === p }" @click="menu = false"><Icon :name="NAV[p][1]" :size="22" /> {{ NAV[p][0] }}</a>
      </nav>
    </Transition>
    <div class="body">
      <Transition name="pg" mode="out-in" @before-enter="shownPage = page"><component :is="current" :key="page" /></Transition>
    </div>
    <Transition name="toast"><div v-if="toastMsg.text" class="toast" role="status">{{ toastMsg.text }}</div></Transition>
  </div>
</template>

<style scoped>
.shell{min-height:100dvh;display:flex;flex-direction:column}
.shell.fixed{height:100dvh;overflow:hidden}
.bar{flex:none;height:var(--bar-h);display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:var(--panel-2);position:sticky;top:0;z-index:50}
.brand{font:700 18px/1 var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);text-decoration:none}
.links{display:flex;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.links a{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:9px;color:var(--muted);font:600 13.5px var(--body);text-decoration:none;white-space:nowrap;transition:background-color .15s var(--ease),color .15s var(--ease)}
.links a:hover{color:var(--ink)}
.links a.on{background:var(--track);color:var(--ink)}
.links a:focus-visible,.burger:focus-visible,.overlay a:focus-visible,.brand:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--bad)}
.dot.ok{background:var(--on)}
.burger{display:none;width:40px;height:40px;border:0;border-radius:9px;background:transparent;color:var(--ink);cursor:pointer;place-items:center}
.body{flex:1;min-height:0;display:flex;flex-direction:column;max-width:1280px;width:100%;margin:0 auto;padding:16px}
.body > :deep(*){min-height:0}
.embed .body{max-width:none;padding:12px}
.fixed .body{overflow:hidden;max-width:none}
.fixed .body > :deep(.anv){flex:1}
.overlay{position:fixed;inset:var(--bar-h) 0 0 0;z-index:49;background:var(--bg);display:flex;flex-direction:column;padding:12px 16px;gap:4px;overflow-y:auto}
.overlay a{display:flex;align-items:center;gap:14px;min-height:56px;padding:0 12px;border-radius:12px;color:var(--ink);font:600 22px var(--body);text-decoration:none}
.overlay a.on{background:var(--track)}
.ov-enter-active,.ov-leave-active{transition:opacity .2s cubic-bezier(.2,.8,.2,1),transform .2s cubic-bezier(.2,.8,.2,1)}
.ov-enter-from,.ov-leave-to{opacity:0;transform:translateY(8px)}
.pg-enter-active,.pg-leave-active{transition:opacity .14s var(--ease)}
.pg-enter-from,.pg-leave-to{opacity:0}
@media (max-width:760px){
  .links{display:none}
  .burger{display:grid;margin-left:auto}
  .dot{order:3}
  .body{padding:12px}
}
@media (prefers-reduced-motion:reduce){.ov-enter-active,.ov-leave-active{transition:none}.ov-enter-from,.ov-leave-to{transform:none}}
</style>
