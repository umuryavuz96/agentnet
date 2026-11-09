<script setup lang="ts">
// Header pill for agentnet updates. Shows only when a newer release is known or an update ran in the last 10 minutes,
// and opens the update sheet. All state lives in ui/useUpdate.ts; the header just mounts this.
import { computed, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { pill } from "../ui/update";
import { useUpdate } from "../ui/useUpdate";
import UpdateSheet from "./UpdateSheet.vue";

const u = useUpdate();
const open = ref(false);
const p = computed(() => pill(u.m.value, u.now.value));
const icon = computed(() => (p.value?.kind === "busy" ? "loader" : p.value?.kind === "bad" ? "triangle-alert" : p.value?.kind === "ok" ? "circle-check" : "circle-arrow-up") as "loader" | "triangle-alert" | "circle-check" | "circle-arrow-up");
function show() { open.value = true; void u.refresh(); }
function reload() { u.dispatch({ type: "dismiss" }); location.reload(); }
</script>

<template>
  <button v-if="p" type="button" class="up" :class="p.kind" :aria-label="p.text + ', open the update panel'" aria-haspopup="dialog" @click="show">
    <Icon :name="icon" :size="15" :class="{ spin: p.kind === 'busy' }" /><span>{{ p.text }}</span>
  </button>
  <UpdateSheet :open="open && !!(p || u.m.value.phase !== 'none')" :m="u.m.value" :now="u.now.value" :can-check="u.canCheck.value" :checking="u.checking.value"
    @close="open = false" @ask="u.dispatch({ type: 'ask' })" @cancel="u.dispatch({ type: 'cancel' })" @start="u.start()" @check="u.check()"
    @dismiss="u.dispatch({ type: 'dismiss' })" @reload="reload" />
</template>

<style scoped>
.up{display:inline-flex;align-items:center;gap:6px;flex:none;min-height:34px;padding:0 12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg);color:var(--on);font:600 12.5px var(--body);white-space:nowrap;cursor:pointer;transition:background-color .15s var(--ease)}
.up:hover{background:color-mix(in srgb,var(--on) 22%,transparent)}
.up.busy{border-color:var(--line);background:var(--track);color:var(--ink)}
.up.bad{border-color:color-mix(in srgb,var(--warn) 60%,transparent);background:var(--warn-bg);color:var(--warn)}
.up:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.spin{animation:upsp 1s linear infinite}@keyframes upsp{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}.up{transition:none}}
</style>
