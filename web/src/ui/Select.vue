<script setup lang="ts">
// Custom dropdown (playbook §3): an ARIA combobox button with a listbox, keyboard (arrows, Home/End, Enter, Escape, type-ahead),
// and the native <select> underneath as the value carrier and no-JS fallback (hidden from sight and from the tab order).
import { computed, nextTick, onUnmounted, ref } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ modelValue: string; options: { value: string; label: string; hint?: string }[]; label: string; id: string; invalid?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [v: string] }>();
const open = ref(false), act = ref(0), root = ref<HTMLElement | null>(null), btn = ref<HTMLButtonElement | null>(null);
const cur = computed(() => props.options.find((o) => o.value === props.modelValue) ?? props.options[0]);
const lid = computed(() => props.id + "-lb");
let typed = "", typedAt = 0;

function show() { act.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue)); open.value = true; document.addEventListener("pointerdown", outside, true); nextTick(scrollAct); }
function hide(focus = true) { open.value = false; document.removeEventListener("pointerdown", outside, true); if (focus) btn.value?.focus(); }
function pick(k: number) { const o = props.options[k]; if (o) emit("update:modelValue", o.value); hide(); }
function outside(e: Event) { if (!root.value?.contains(e.target as Node)) hide(false); }
function scrollAct() { root.value?.querySelector<HTMLElement>(`#${props.id}-o${act.value}`)?.scrollIntoView({ block: "nearest" }); }
function key(e: KeyboardEvent) {
  const n = props.options.length;
  if (!open.value) { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); } return; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); return; }
  if (e.key === "Tab") { hide(false); return; }
  const mv: Record<string, number> = { ArrowDown: act.value + 1, ArrowUp: act.value - 1, Home: 0, End: n - 1 };
  if (e.key in mv) { e.preventDefault(); act.value = (mv[e.key]! + n) % n; nextTick(scrollAct); return; }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(act.value); return; }
  if (e.key.length === 1) { // type-ahead
    const t = Date.now(); typed = (t - typedAt > 700 ? "" : typed) + e.key.toLowerCase(); typedAt = t;
    const k = props.options.findIndex((o) => o.label.toLowerCase().startsWith(typed)); if (k >= 0) { act.value = k; nextTick(scrollAct); }
  }
}
onUnmounted(() => document.removeEventListener("pointerdown", outside, true));
</script>

<template>
  <div ref="root" class="sel">
    <select class="sel-native" :id="id + '-native'" :value="modelValue" tabindex="-1" aria-hidden="true" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <button :id="id" ref="btn" type="button" class="sel-b" :class="{ bad: invalid }" role="combobox" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="lid" :aria-label="label"
      :aria-activedescendant="open ? `${id}-o${act}` : undefined" @click="open ? hide() : show()" @keydown="key">
      <span>{{ cur?.label }}</span><Icon name="chevron-down" :size="14" class="chev" />
    </button>
    <Transition name="sel-pop">
      <ul v-if="open" :id="lid" class="sel-l" role="listbox" :aria-label="label">
        <li v-for="(o, k) in options" :id="`${id}-o${k}`" :key="o.value" role="option" :aria-selected="o.value === modelValue" :class="{ act: k === act }" @pointerenter="act = k" @click="pick(k)">
          <span>{{ o.label }}</span><small v-if="o.hint">{{ o.hint }}</small><Icon v-if="o.value === modelValue" name="check" :size="14" class="ck" />
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.sel{position:relative;min-width:0}
.sel-native{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.sel-b{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:500 13px var(--mono);text-align:left;cursor:pointer}
.sel-b.bad{border-color:var(--bad)}
.sel-b:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.sel-b .chev{flex:none;color:var(--muted);transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.sel-b[aria-expanded="true"] .chev{transform:rotate(180deg)}
.sel-l{position:absolute;z-index:5;left:0;min-width:max(100%,13rem);top:calc(100% + 4px);margin:0;padding:4px;list-style:none;max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 12px 30px rgba(0,0,0,.28);transform-origin:top}
.sel-l li{display:grid;grid-template-columns:1fr auto;align-items:center;column-gap:8px;min-height:40px;padding:6px 10px;border-radius:8px;font:500 13px var(--mono);cursor:pointer}
.sel-l li small{grid-row:2;color:var(--muted);font:400 11.5px var(--body)}
.sel-l li .ck{grid-column:2;grid-row:1;color:var(--on)}
.sel-l li.act{background:var(--track)}
.sel-pop-enter-active,.sel-pop-leave-active{transition:opacity .18s cubic-bezier(.2,.8,.2,1),transform .18s cubic-bezier(.2,.8,.2,1)}
.sel-pop-enter-from,.sel-pop-leave-to{opacity:0;transform:translateY(-4px) scale(.98)}
@media (prefers-reduced-motion:reduce){.sel-pop-enter-from,.sel-pop-leave-to{transform:none}.sel-b .chev{transition:none}}
</style>
