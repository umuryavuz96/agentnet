<script setup lang="ts">
// Shared offline bar (board page 14): the live stream dropped, so numbers on the page may be old. Shown under the page header
// on every page except the Office map, which draws its own. Retry skips the wait.
import { computed } from "vue";
import Icon from "./Icon.vue";
import { net, retryStream } from "../net";

const off = computed(() => net.lastFrameAt > 0 && !net.connected);
const clock = computed(() => new Date(net.lastFrameAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
</script>

<template>
  <Transition name="ob">
    <div v-if="off" class="ob" role="status"><Icon name="loader" :size="16" /><b>Live updates paused</b><span>Lost the connection at {{ clock }}. Retrying every few seconds; numbers below may be old.</span><button type="button" @click="retryStream"><Icon name="rotate-ccw" :size="15" />Retry now</button></div>
  </Transition>
</template>

<style scoped>
.ob{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 12px;padding:10px 14px;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--warn);font-size:13px;color:var(--ink)}
.ob .icon{color:var(--warn)}.ob b{font-weight:650}.ob span{color:var(--muted);min-width:0}
.ob button{margin-left:auto;display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border:0;border-radius:10px;background:transparent;box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);font:600 13px/1 var(--body);cursor:pointer}
.ob button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.ob-enter-active,.ob-leave-active{transition:opacity .15s}.ob-enter-from,.ob-leave-to{opacity:0}
</style>
