<script setup lang="ts">
// "+" on the Brains page: search the persona catalog (name, tags, description) and add one as a new brain (version 1).
// A dialog on desktop, a bottom sheet on phone; above the sticky header (teleported to body), Esc and the backdrop close it.
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { api } from "../ui/api";
import Icon from "../ui/Icon.vue";

interface Entry { id: string; name: string; repo: string; category: string; description: string; tags: string[]; stars: number }
const props = defineProps<{ open: boolean; taken: string[] }>();
const emit = defineEmits<{ close: []; added: [name: string] }>();

const all = ref<Entry[]>([]), loading = ref(true), err = ref("");
const q = ref(""), sel = ref<Entry | null>(null), name = ref(""), busy = ref(false), at = ref(0);
const inp = ref<HTMLInputElement | null>(null), nameInp = ref<HTMLInputElement | null>(null);

async function loadCatalog() {
  if (all.value.length) return;
  loading.value = true;
  try { all.value = (await api<{ agents: Entry[] }>("v1/panel/arsenal")).agents; err.value = ""; } catch (e) { err.value = (e as Error).message; } finally { loading.value = false; }
}
watch(() => props.open, (o) => {
  document.body.style.overflow = o ? "hidden" : "";
  if (o) { q.value = ""; sel.value = null; err.value = ""; void loadCatalog(); void nextTick(() => inp.value?.focus()); }
}, { immediate: true });
onUnmounted(() => { document.body.style.overflow = ""; });

const hits = computed(() => {
  const w = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  const l = all.value.filter((a) => w.every((x) => (a.name + " " + a.id + " " + a.tags.join(" ") + " " + a.category + " " + a.description).toLowerCase().includes(x)));
  const inName = (a: Entry) => w.filter((x) => a.name.toLowerCase().includes(x)).length; // more query words in the name ranks first
  return l.sort((x, y) => inName(y) - inName(x) || y.stars - x.stars);
});
const LIMIT = 60;
watch(q, () => { at.value = 0; });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function choose(a: Entry) { sel.value = a; name.value = slug(a.name); err.value = ""; void nextTick(() => nameInp.value?.focus()); }
const nameOk = computed(() => /^[a-z0-9][a-z0-9-]{0,39}$/.test(name.value));
const clash = computed(() => props.taken.includes(name.value));
async function add() {
  if (!sel.value || !nameOk.value || clash.value || busy.value) return;
  busy.value = true; err.value = "";
  try { await api("v1/panel/brains/import", { method: "POST", body: { catalogId: sel.value.id, name: name.value } }); emit("added", name.value); }
  catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
function onKey(e: KeyboardEvent) {
  const n = Math.min(hits.value.length, LIMIT);
  if (e.key === "ArrowDown") { e.preventDefault(); at.value = (at.value + 1) % Math.max(n, 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); at.value = (at.value + n - 1) % Math.max(n, 1); }
  else if (e.key === "Enter") { e.preventDefault(); const a = hits.value[at.value]; if (a) choose(a); }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="bi">
    <div v-if="open" class="bi-back" @click.self="emit('close')" @keydown.esc="emit('close')">
      <div class="bi" role="dialog" aria-modal="true" aria-label="Add a brain from the persona catalog">
        <div class="grab" aria-hidden="true" />
        <header class="bh"><h3>Add a brain from the catalog</h3><span class="sp" /><button type="button" class="ico" aria-label="Close" @click="emit('close')"><Icon name="x" :size="17" /></button></header>
        <label class="srch"><Icon name="search" :size="15" /><input ref="inp" v-model="q" type="search" role="combobox" aria-expanded="true" aria-controls="bi-list" placeholder="Search name, tag or text" aria-label="Search the persona catalog" autocomplete="off" spellcheck="false" @keydown="onKey" /></label>
        <p class="cnt" role="status"><template v-if="loading">Loading the catalog…</template><template v-else><b class="num">{{ hits.length }}</b> of {{ all.length }} personas<template v-if="hits.length > LIMIT">, first {{ LIMIT }} shown</template></template></p>
        <ul id="bi-list" class="al" role="listbox" aria-label="Personas">
          <li v-for="(a, i) in hits.slice(0, LIMIT)" :key="a.id" role="option" :aria-selected="sel?.id === a.id" :class="{ at: at === i }" @mousemove="at = i" @click="choose(a)">
            <span class="t"><b>{{ a.name }}</b><small>{{ a.category }} · {{ a.repo === "in-house" ? "in-house" : a.repo }}</small></span>
            <span class="d">{{ a.description }}</span>
          </li>
          <li v-if="!loading && !hits.length" class="none">No persona matches "{{ q }}".</li>
        </ul>
        <footer class="ft">
          <template v-if="sel">
            <span class="pk"><Icon name="brain" :size="15" /><span>From <b>{{ sel.name }}</b></span></span>
            <label class="nm"><span>Brain name</span><input ref="nameInp" v-model="name" type="text" autocomplete="off" spellcheck="false" :aria-invalid="!nameOk || clash" @keydown.enter="add" /></label>
            <button type="button" class="btn pri" :disabled="!nameOk || clash || busy" @click="add"><Icon name="plus" :size="15" />{{ busy ? "Adding…" : "Add as brain" }}</button>
            <p v-if="clash" class="hint bad">A brain named {{ name }} exists. Pick another name.</p>
            <p v-else-if="!nameOk" class="hint bad">Lowercase letters, digits and dashes, up to 40.</p>
            <p v-else class="hint">Version 1, no reads or skills yet. Map a role to it in index.json to use it at spawn.</p>
          </template>
          <p v-else class="hint">Pick a persona to add it as a brain.</p>
          <p v-if="err" class="hint bad" role="alert">{{ err }}</p>
        </footer>
      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bi-back{position:fixed;inset:0;z-index:200;background:rgb(0 0 0/.45);display:grid;place-items:center;padding:24px}
.bi{width:min(720px,100%);height:min(720px,86dvh);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:16px;background:var(--panel);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line),0 24px 60px -20px rgb(0 0 0/.6)}
.grab{display:none}
.bh{display:flex;align-items:center;gap:8px}.bh h3{margin:0;font:700 17px/1.3 var(--body)}.sp{flex:1}
.ico{all:unset;cursor:pointer;display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;color:var(--muted);border-radius:8px}.ico:hover{color:var(--ink);background:var(--soft)}.ico:focus-visible{outline:2px solid var(--on)}
.srch{display:flex;gap:8px;align-items:center;height:44px;padding:0 12px;border-radius:10px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted)}
.srch input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--ink);font:400 15px var(--body)}.srch:focus-within{box-shadow:inset 0 0 0 1.5px var(--ink)}
.cnt{margin:0;color:var(--muted);font-size:12.5px}.cnt b{color:var(--ink)}
.al{flex:1;list-style:none;margin:0;padding:0;overflow:auto;overscroll-behavior:contain;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);min-height:0}
.al li{display:grid;gap:3px;min-height:44px;padding:10px 14px;border-top:1px solid var(--hair);cursor:pointer}
.al li:first-child{border-top:0}
.al li.at{background:var(--soft)}.al li[aria-selected=true]{box-shadow:inset 3px 0 0 var(--ink);background:var(--soft)}
.t{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.t b{font:600 14px var(--body);overflow-wrap:anywhere}.t small{color:var(--muted);font:12px var(--mono);overflow-wrap:anywhere}
.d{color:var(--muted);font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}
.none{color:var(--muted);cursor:default!important}
.ft{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding-top:4px}
.pk{display:inline-flex;gap:6px;align-items:center;font-size:13px}.pk :deep(svg){color:var(--muted)}
.nm{display:flex;align-items:center;gap:8px;flex:1;min-width:200px}.nm span{color:var(--muted);font-size:12.5px;white-space:nowrap}
.nm input{flex:1;min-width:0;height:40px;padding:0 10px;border:0;outline:0;border-radius:9px;background:var(--bg);color:var(--ink);font:500 14px var(--mono);box-shadow:inset 0 0 0 1px var(--line)}
.nm input:focus{box-shadow:inset 0 0 0 1.5px var(--ink)}.nm input[aria-invalid=true]{box-shadow:inset 0 0 0 1.5px var(--bad)}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:44px;padding:0 16px;border-radius:10px;font:600 14px var(--body)}
.btn.pri{background:var(--ink);color:var(--bg)}.btn:disabled{opacity:.45;cursor:default}.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.hint{flex-basis:100%;margin:0;color:var(--muted);font-size:12.5px}.hint.bad{color:var(--bad)}
.bi-enter-active,.bi-leave-active{transition:opacity .2s ease}.bi-enter-active .bi,.bi-leave-active .bi{transition:transform .24s cubic-bezier(.2,.8,.2,1),opacity .2s}
.bi-enter-from,.bi-leave-to{opacity:0}.bi-enter-from .bi,.bi-leave-to .bi{opacity:0;transform:translateY(16px) scale(.98)}
@media (max-width:760px){
  .bi-back{place-items:end stretch;padding:0}
  .bi{width:100%;height:88dvh;border-radius:18px 18px 0 0;padding:8px 16px calc(16px + env(safe-area-inset-bottom))}
  .grab{display:block;width:36px;height:5px;border-radius:3px;background:var(--line);margin:0 auto}
  .nm{flex-basis:100%}.btn.pri{flex:1;justify-content:center}
}
@media (max-width:760px){.bi-enter-from .bi,.bi-leave-to .bi{transform:translateY(60px)}}
@media (prefers-reduced-motion:reduce){.bi-enter-active .bi,.bi-leave-active .bi{transition:opacity .15s}.bi-enter-from .bi,.bi-leave-to .bi{transform:none}}
</style>
