<script setup lang="ts">
// An agent's mark outside the map card: the same 3x3 dot pattern from its name, on the same tile, with the same edge for
// its state (a turning arc while it works) and the same wave of the dots. The drawing follows AgentCard.vue; the colour is
// the agent's hue, read from `--ag` where it is used.
import { computed } from "vue";
import { net } from "../net";
const props = defineProps<{ name: string; state?: "working" | "waiting" | "blocked" | "starting" | "idle" }>();
const hash = computed(() => { let h = 2166136261; for (const c of props.name) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; });
// the agent's place among live agents, as on the card: it picks the order its dots light in and their speed
const slot = computed(() => {
  if (props.name === "root") return 0;
  const names = Object.values(net.agents).filter((a) => a.name !== "root" && a.life !== "gone" && a.life !== "failed").map((a) => a.name).sort();
  const i = names.indexOf(props.name);
  return i >= 0 ? i + 1 : hash.value;
});
const SPIRAL = [0, 1, 2, 7, 8, 3, 6, 5, 4];
const dur = computed(() => 1.1 + ((slot.value * 3) % 5) * 0.2);
const delay = (i: number) => {
  const r = Math.floor(i / 3), c = i % 3, h = hash.value;
  return [(r + c) * 120, r * 200, c * 200, (Math.abs(r - 1) + Math.abs(c - 1)) * 180, SPIRAL[i]! * 95, ((h >>> (i * 3)) & 7) * 120][slot.value % 6] + "ms";
};
const mark = computed(() => { let b = (hash.value >>> 3) & 511; if ([...b.toString(2)].filter((x) => x === "1").length < 4) b ^= 0b101110101; return Array.from({ length: 9 }, (_, i) => !!((b >> i) & 1)); });
const st = computed(() => props.state ?? "idle");
</script>

<template>
  <span :class="['am', 's-' + st]" :style="{ '--md': dur + 's' }" aria-hidden="true">
    <i class="am-ring"><i class="am-rot" /></i>
    <span class="am-mk"><i v-for="(on, i) in mark" :key="i" :class="{ on }" :style="{ animationDelay: delay(i) }" /></span>
  </span>
</template>

<style scoped>
.am{--sc:var(--on);position:relative;flex:none;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--ag) 10%,var(--bg));box-shadow:inset 0 0 0 .75px color-mix(in srgb,var(--ink) 14%,transparent)}
.am.s-waiting{--sc:var(--warn)}.am.s-blocked{--sc:var(--bad)}
.am-mk{position:relative;display:grid;grid-template-columns:repeat(3,4px);gap:2.5px}
.am-mk i{width:4px;height:4px;border-radius:1.2px;background:var(--ag);opacity:.16}
.am-mk i.on{opacity:1}
.s-idle .am-mk i.on{opacity:.55}
.s-working .am-mk i{animation:am-dot var(--md,1.5s) ease-in-out infinite}
.s-working .am-mk i.on{animation-name:am-dot-on}
@keyframes am-dot{0%,100%{opacity:.12}45%{opacity:.45}}
@keyframes am-dot-on{0%,100%{opacity:.35;transform:scale(.8)}45%{opacity:1;transform:scale(1.1)}}
.am-ring{position:absolute;inset:0;border-radius:inherit;padding:1.5px;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .3s cubic-bezier(.23,1,.32,1);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.s-working .am-ring{opacity:1;background:color-mix(in srgb,var(--sc) 26%,transparent)}
.s-waiting .am-ring,.s-blocked .am-ring{opacity:1;background:var(--sc)}
.s-starting .am-ring{opacity:1}
.am-rot{position:absolute;inset:-45%}
.s-working .am-rot{background:conic-gradient(transparent 0 58%,color-mix(in srgb,var(--sc) 40%,transparent) 80%,var(--sc) 100%);animation:am-spin 1.6s linear infinite}
.s-starting .am-rot{background:repeating-conic-gradient(var(--muted) 0 6%,transparent 0 12.5%);animation:am-spin 4s linear infinite}
@keyframes am-spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.am-rot,.am-mk i{animation:none!important}}
</style>
