<script setup lang="ts">
// States of the Agents map (board page 14): loading, empty, offline, stale, 3D failed, service not answering.
// One overlay over the map area. It never moves people on old data: offline greys and freezes the map (class set by the page).
import { computed, onBeforeUnmount, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { net, staleSince, retryStream } from "../net";

const props = defineProps<{ count: number; cmd: string; failed3d: string | null }>();
const emit = defineEmits<{ open2d: []; try3d: [] }>();

const born = Date.now(), waited = ref(0);
const t = setInterval(() => (waited.value = Date.now() - born), 1_000);
onBeforeUnmount(() => clearInterval(t));
const copied = ref(false);
async function copy() { try { await navigator.clipboard.writeText(props.cmd); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { /* clipboard blocked: the command stays visible */ } }
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const mins = (ms: number) => Math.max(1, Math.round((net.now - ms) / 60_000));

const everLive = computed(() => net.lastFrameAt > 0);
const state = computed<"loading" | "slow" | "down" | "empty" | "offline" | "none">(() => {
  if (!everLive.value) return waited.value > 30_000 ? "down" : waited.value > 15_000 ? "slow" : "loading";
  if (!net.connected) return "offline";
  if (!props.count) return "empty";
  return "none";
});
const stale = computed(() => (state.value === "none" ? staleSince.value : null));
defineExpose({ frozen: computed(() => state.value === "offline") });
const rooms: [number, number, number, number][] = [[4, 6, 30, 40], [37, 6, 26, 40], [66, 6, 30, 40], [14, 52, 34, 42], [52, 52, 34, 42]];
</script>

<template>
  <div class="ms" aria-live="polite">
    <div v-if="state === 'offline'" class="bar wait" role="status"><Icon name="loader" :size="16" /><b>Live updates paused</b><span>Lost the connection at {{ clock(net.lastFrameAt) }}. Retrying every few seconds.</span><button type="button" class="b" @click="retryStream"><Icon name="rotate-ccw" :size="15" />Retry now</button></div>
    <div v-else-if="stale" class="bar" role="status"><Icon name="loader" :size="16" /><b>Last update {{ mins(stale) }} min ago</b><span>The service answers, but no event came in. Agents stay where they were.</span></div>
    <div v-else-if="failed3d" class="bar" role="status"><Icon name="circle-x" :size="16" /><b>3D could not start</b><span>{{ failed3d }}. The 2D map shows the same agents, teams and messages.</span><button type="button" class="b" @click="emit('try3d')">Try 3D again</button></div>

    <template v-if="state === 'loading' || state === 'slow'">
      <div v-for="(r, i) in rooms" :key="i" class="sk-room" :style="{ left: r[0] + '%', top: r[1] + '%', width: r[2] + '%', height: r[3] + '%' }"><i class="sk" /></div>
      <p v-if="state === 'slow'" class="slow"><Icon name="loader" :size="14" />Still loading: the service is slow to answer.<button type="button" class="b" @click="retryStream">Retry</button></p>
    </template>
    <div v-else-if="state === 'down'" class="center"><div class="box"><Icon name="circle-x" :size="26" /><h2>agentnet is not answering</h2><p>No answer from this service for 30 s. Agents keep working; only this page cannot see them. Start the service, for example with <code>agentnet install-service</code>.</p><div class="row"><button type="button" class="b pri" @click="retryStream"><Icon name="rotate-ccw" :size="15" />Retry</button></div></div></div>
    <div v-else-if="state === 'empty'" class="center"><div class="box"><Icon name="network" :size="26" /><h2>No agents running</h2><p>The map fills when an agent starts. Start one with the command below, or start Claude Code with the agentnet plugin and it joins on its own.</p><div class="cmd"><code>{{ cmd }}</code><button type="button" class="b" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="14" />{{ copied ? "Copied" : "Copy" }}</button></div></div></div>
  </div>
</template>

<style scoped>
.ms{position:absolute;inset:0;z-index:5;pointer-events:none;border-radius:14px}
.ms>*{pointer-events:auto}
.bar{position:absolute;left:12px;right:12px;top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-size:13px;color:var(--muted)}
.bar b{color:var(--ink);font-weight:650}
.bar.wait{box-shadow:inset 0 0 0 1px var(--warn);color:var(--ink)}
.bar.wait .icon{color:var(--warn)}
.bar .b{margin-left:auto}
.b{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border:0;border-radius:10px;background:transparent;box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);font:600 13px/1 var(--body);cursor:pointer}
.b.pri{background:var(--ink);color:var(--bg);box-shadow:none}
.b:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.center{position:absolute;inset:0;display:grid;place-items:center;padding:16px;pointer-events:none}
.box{pointer-events:auto;max-width:460px;display:grid;gap:10px;justify-items:start;padding:22px;border-radius:16px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}
.box h2{margin:0;font-size:18px}.box p{margin:0;color:var(--muted);font-size:14px;line-height:1.45}
.row{display:flex;gap:8px;flex-wrap:wrap}
.cmd{display:flex;gap:8px;align-items:flex-start;max-width:100%}
.cmd code{flex:1;min-width:0;overflow-wrap:anywhere;font:12px/1.5 var(--mono);color:var(--muted);padding:8px 10px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line)}
.sk-room{position:absolute;border-radius:16px;box-shadow:inset 0 0 0 1px var(--line);background:color-mix(in srgb,var(--panel) 50%,transparent)}
.sk{position:absolute;left:14px;top:14px;width:46%;height:16px;border-radius:6px;background:var(--track)}
.slow{position:absolute;left:12px;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;padding:10px 14px;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-size:13px}
.slow .b{margin-left:auto}
</style>
