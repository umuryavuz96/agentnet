<script setup lang="ts">
// The agent's mark (canvas DotTile): a 3x3 dot pattern in the agent's hue. Working: the dots pulse in a wave and a green
// light turns round the edge; waiting: amber ring; blocked: red ring; idle: still. Reduced motion shows it still.
import { computed } from "vue";

const props = withDefaults(defineProps<{ hue?: number; state?: "working" | "waiting" | "idle" | "blocked"; pattern?: string; size?: "md" | "sm" | "xs" }>(), { hue: 307, state: "working", pattern: "111101111", size: "md" });
const DELAY = [0, 0.11, 0.22, 0.77, 0.88, 0.33, 0.66, 0.55, 0.44];
const dots = computed(() => DELAY.map((d, i) => ({ on: props.pattern[i] === "1", d })));
const ring = computed(() => (props.state === "waiting" ? "var(--warn)" : props.state === "blocked" ? "var(--bad)" : props.state === "working" ? "color-mix(in srgb,var(--on) 26%,transparent)" : "transparent"));
</script>

<template>
  <span :class="['dt', size, state]" :style="{ '--dt-h': hue, '--dt-ring': ring }" aria-hidden="true">
    <span class="g"><i v-for="(d, i) in dots" :key="i" :class="{ on: d.on }" :style="{ animationDelay: d.d + 's' }" /></span>
    <span class="rg"><span v-if="state === 'working'" class="arc" /></span>
  </span>
</template>

<style scoped>
.dt{--dt-ac:hsl(var(--dt-h) 78% 62%);--dt-d:4px;--dt-gap:2.5px;--dt-hair:rgba(255,255,255,.1);box-sizing:border-box;position:relative;flex:none;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;
  background:color-mix(in srgb,var(--dt-ac) 10%,var(--card,var(--panel)));box-shadow:inset 0 0 0 .75px var(--dt-hair),inset 0 1px 0 rgba(255,255,255,.08),0 1px 2px rgba(0,0,0,.45),0 6px 12px -5px rgba(0,0,0,.5),0 9px 14px -8px color-mix(in srgb,var(--dt-ac) 55%,transparent)}
:root[data-theme="light"] .dt{--dt-ac:hsl(var(--dt-h) 78% 52%);--dt-hair:rgba(0,0,0,.09);box-shadow:inset 0 0 0 .75px var(--dt-hair),0 1px 2px rgba(22,22,26,.08),0 6px 12px -5px rgba(22,22,26,.14),0 9px 14px -8px color-mix(in srgb,var(--dt-ac) 45%,transparent)}
.dt.sm{--dt-d:2.5px;--dt-gap:1.5px;width:20px;height:20px;border-radius:6px}
/* text size (AgentMention.vue): flat, so an agent name inside a line reads as text with a mark */
.dt.xs{--dt-d:2px;--dt-gap:1.25px;width:1.08em;height:1.08em;border-radius:.3em;box-shadow:inset 0 0 0 .75px var(--dt-hair)}
:root[data-theme="light"] .dt.xs{box-shadow:inset 0 0 0 .75px var(--dt-hair)}
.dt.xs .rg{padding:1px}
.g{position:relative;display:grid;grid-template-columns:repeat(3,var(--dt-d));gap:var(--dt-gap)}
.g i{width:var(--dt-d);height:var(--dt-d);border-radius:1.2px;background:var(--dt-ac);opacity:.16}
.g i.on{opacity:1}
.idle .g i.on{opacity:.55}
.working .g i{animation:dt-dot 1.5s ease-in-out infinite}
.working .g i.on{animation-name:dt-dot-on}
.rg{box-sizing:border-box;position:absolute;inset:0;border-radius:inherit;padding:1.5px;overflow:hidden;pointer-events:none;background:var(--dt-ring);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.arc{position:absolute;inset:-45%;background:conic-gradient(transparent 0 58%,color-mix(in srgb,var(--on) 40%,transparent) 80%,var(--on) 100%);animation:dt-spin 1.6s linear infinite}
@keyframes dt-dot{0%,100%{opacity:.12}45%{opacity:.45}}
@keyframes dt-dot-on{0%,100%{opacity:.35;transform:scale(.8)}45%{opacity:1;transform:scale(1.1)}}
@keyframes dt-spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.working .g i,.arc{animation:none}}
</style>
