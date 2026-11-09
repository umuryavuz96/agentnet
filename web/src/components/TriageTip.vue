<script setup lang="ts">
// A slim tip above the board. Shown only when a director exists and prompt triage is not working. The server decides (triageState):
// no UserPromptSubmit triage hook at all (offer to add it), or the hook's last 5 log records are all "not_logged_in"/"no_claude" skips. Anything else shows nothing. "Not now" is remembered per tip in localStorage (may be blocked).
import { computed, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { api } from "../ui/api";

const props = defineProps<{ director: boolean; refresh: number }>();
const emit = defineEmits<{ add: [] }>();
const KEY = { add: "anv-triage-tip", key: "anv-triage-key-tip" } as const;
const triage = ref<string | null>(null), hidden = ref<Record<string, boolean>>({});
const read = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
hidden.value = { add: read(KEY.add), key: read(KEY.key) };

async function load() {
  try { triage.value = (await api<{ triage: string }>("v1/panel/director")).triage; } catch { triage.value = null; }
}
onMounted(load); watch(() => props.refresh, load);

const kind = computed<"add" | "key" | null>(() => (!props.director ? null : triage.value === "off" ? "add" : triage.value === "nologin" ? "key" : null));
const show = computed(() => !!kind.value && !hidden.value[kind.value]);
const last = ref<"add" | "key">("add"); // keeps the text while the tip closes
watch(kind, (k) => { if (k) last.value = k; }, { immediate: true });
function dismiss() { const k = last.value; hidden.value = { ...hidden.value, [k]: true }; try { localStorage.setItem(KEY[k], "1"); } catch { /* not remembered */ } }
</script>

<template>
  <div class="tt" :class="{ open: show }" :inert="!show || undefined">
    <div class="tt-in">
      <section class="tt-c" role="status" aria-label="Prompt triage">
        <Icon name="sparkles" :size="16" class="tt-i" />
        <p v-if="last === 'add'">Prompt triage is off. It sorts each prompt and tells the director when to form a team and which model to use. Without it the director works alone.</p>
        <p v-else>Prompt triage is installed but Claude Code is not logged in, so it skips every prompt. Run claude once and log in.</p>
        <span class="tt-b">
          <button v-if="last === 'add'" type="button" class="tt-p" @click="emit('add')">Add prompt triage</button>
          <button type="button" class="tt-g" @click="dismiss">Not now</button>
        </span>
      </section>
    </div>
  </div>
</template>

<style scoped>
.tt{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.tt.open{grid-template-rows:1fr;opacity:1}
.tt-in{overflow:hidden;min-height:0}
.tt-c{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--on) 40%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--on) 6%,var(--panel))}
.tt-c p{flex:1 1 260px;margin:0;font-size:13px;line-height:1.4;min-width:0}
.tt-c a{color:var(--ink);text-underline-offset:2px}
.tt-i{flex:none;color:var(--on)}
.tt-b{display:flex;gap:8px;margin-left:auto}
.tt-b button{min-height:36px;padding:0 14px;border-radius:10px;font:600 13px/1 var(--body);cursor:pointer}
.tt-p{border:0;background:var(--on);color:#06210f}
.tt-g{border:1px solid var(--line);background:transparent;color:var(--ink)}
.tt-b button:focus-visible,.tt-c a:focus-visible{outline:2px solid var(--on);outline-offset:2px}
@media (max-width:520px){.tt-b{width:100%}.tt-b button{flex:1;min-height:44px}}
@media (prefers-reduced-motion:reduce){.tt{transition:none}}
</style>
