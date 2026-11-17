<script setup lang="ts">
/** ⌘K palette (board page 01): find an agent, team or page, open it, or run an action on the picked agent. */
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import type { IconName } from "../ui/icons";
import StateMark from "../ui/StateMark.vue";
import { net, teams, useAgentnet, windowCall } from "../net";
import { modelShort } from "../crewTree";
import { PAGES } from "../router";
import { toast } from "../ui/api";

const props = defineProps<{ open: boolean; nav: Record<string, [string, IconName]> }>();
const emit = defineEmits<{ close: [] }>();
const q = ref(""), at = ref(0), inp = ref<HTMLInputElement | null>(null), field = ref<HTMLElement | null>(null);
let stop: (() => void) | null = null;
watch(() => props.open, (o) => {
  if (o) { q.value = ""; at.value = 0; stop ??= useAgentnet(); void nextTick(() => inp.value?.focus()); }
  else { stop?.(); stop = null; }
});
onUnmounted(() => stop?.());

interface Row { key: string; icon: IconName | ""; label: string; sub?: string; kbd?: string; state?: string; run: () => void }
const go = (hash: string) => { location.hash = hash; emit("close"); };
const match = (s: string) => !q.value.trim() || s.toLowerCase().includes(q.value.trim().toLowerCase());
const agents = computed(() => Object.values(net.agents).filter((a) => match(a.name + " " + (a.job ?? ""))).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 6));
const sections = computed(() => {
  const out: { title: string; rows: Row[] }[] = [];
  const ar = agents.value.map<Row>((a) => ({ key: "a:" + a.id, icon: "", state: a.state === "working" ? "working" : "idle", label: a.name, sub: [modelShort(a.model), a.boss].filter(Boolean).join(" · "), kbd: "↵ open", run: () => go(`#/agents?agent=${encodeURIComponent(a.name)}`) }));
  if (ar.length) out.push({ title: "Agents", rows: ar });
  const tr = teams.list.filter((t) => t.state === "active" && match(t.name + " " + t.id)).slice(0, 4).map<Row>((t) => ({ key: "t:" + t.id, icon: "users", label: t.name || t.id, sub: `lead ${t.lead ?? "none"} · ${t.members.length} members`, run: () => go(`#/agents?team=${encodeURIComponent(t.id)}`) }));
  if (tr.length) out.push({ title: "Teams", rows: tr });
  const pr = PAGES.filter((p) => match(props.nav[p][0])).map<Row>((p) => ({ key: "p:" + p, icon: props.nav[p][1], label: props.nav[p][0], run: () => go("#/" + p) }));
  if (pr.length) out.push({ title: "Pages", rows: pr });
  const top = agents.value[0];
  if (top && q.value.trim()) out.push({ title: `Actions on ${top.name}`, rows: [{ key: "x:win", icon: "app-window", label: "Open window", run: async () => { emit("close"); const r = await windowCall(`/agents/${encodeURIComponent(top.name)}/open`); toast(r.ok ? `Opening ${top.name} in Terminal on the server Mac` : r.detail ?? "Failed"); } }] });
  if (q.value.trim().length >= 3) out.push({ title: "Past work", rows: [{ key: "s:past", icon: "search", label: "Search past work", sub: `"${q.value.trim()}"`, kbd: "↵ search", run: () => go("#/search?q=" + encodeURIComponent(q.value.trim())) }] });
  return out;
});
const flat = computed(() => sections.value.flatMap((s) => s.rows));
watch(q, () => (at.value = 0));
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); emit("close"); }
  else if (e.key === "ArrowDown") { e.preventDefault(); at.value = Math.min(flat.value.length - 1, at.value + 1); scroll(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); at.value = Math.max(0, at.value - 1); scroll(); }
  else if (e.key === "Enter") { e.preventDefault(); flat.value[at.value]?.run(); }
}
const scroll = () => void nextTick(() => field.value?.querySelector(".on")?.scrollIntoView({ block: "nearest" }));
</script>

<template>
  <Transition name="pal">
    <div v-if="open" class="pw" @mousedown.self="emit('close')">
      <div class="pal" role="dialog" aria-modal="true" aria-label="Command palette" @keydown="key">
        <label class="in"><Icon name="search" :size="18" /><input ref="inp" v-model="q" type="text" placeholder="Find an agent, team or page" autocomplete="off" spellcheck="false" aria-label="Search" /><button type="button" class="x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="18" /></button></label>
        <div ref="field" class="list" role="listbox">
          <template v-for="s in sections" :key="s.title">
            <h6>{{ s.title }}</h6>
            <button v-for="r in s.rows" :key="r.key" type="button" role="option" class="row" :class="{ on: flat[at]?.key === r.key }" :aria-selected="flat[at]?.key === r.key" @mousemove="at = flat.findIndex((x) => x.key === r.key)" @click="r.run()">
              <StateMark v-if="r.state" :state="r.state" /><Icon v-else-if="r.icon" :name="r.icon" :size="16" />
              <b>{{ r.label }}</b><span v-if="r.sub" class="sub">{{ r.sub }}</span><kbd v-if="r.kbd">{{ r.kbd }}</kbd>
            </button>
          </template>
          <p v-if="!flat.length" class="none">Nothing matches "{{ q }}".</p>
        </div>
        <div class="foot"><span><kbd>↑↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.pw{position:fixed;inset:0;z-index:200;display:grid;justify-items:center;align-content:start;padding:min(140px,14dvh) 12px 12px;background:color-mix(in srgb,var(--bg) 55%,transparent)}
.pal{width:min(640px,100%);max-height:min(560px,80dvh);display:flex;flex-direction:column;border-radius:16px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),0 24px 60px -20px rgb(0 0 0/.6);overflow:hidden}
.in{display:flex;align-items:center;gap:10px;height:56px;padding:0 18px;border-bottom:1px solid var(--line);color:var(--muted)}
.in input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--ink);font:500 16px var(--body)}
.x{all:unset;display:none;cursor:pointer;width:44px;height:44px;place-items:center;margin-right:-12px;color:var(--ink)}
.list{overflow-y:auto;padding-bottom:6px}
h6{margin:12px 18px 6px;font:600 12px/1 var(--body);color:var(--muted)}
.row{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 18px;font:500 14px var(--body);color:var(--ink);cursor:pointer}
.row.on{background:var(--track);box-shadow:inset 2px 0 0 var(--ink)}
.row:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.sub{color:var(--muted);font-size:13px;min-width:0;overflow-wrap:anywhere}
kbd{margin-left:auto;font:500 11px/1 var(--mono);padding:4px 6px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);white-space:nowrap}
.none{margin:18px;color:var(--muted);font-size:14px}
.foot{display:flex;gap:16px;padding:10px 18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.foot kbd{margin:0 4px 0 0;padding:2px 5px;font-size:11px}
.pal-enter-active,.pal-leave-active{transition:opacity .12s var(--ease)}
.pal-enter-active .pal{transition:transform .12s var(--ease)}
.pal-enter-from,.pal-leave-to{opacity:0}
.pal-enter-from .pal{transform:scale(.98)}
@media (max-width:760px){.x{display:grid}.pw{padding:0}.pal{width:100%;max-height:100dvh;height:100dvh;border-radius:0}}
@media (prefers-reduced-motion:reduce){.pal-enter-active .pal{transition:none}}
</style>
