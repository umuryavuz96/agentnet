<script setup lang="ts">
// The surface of a chat card (canvas: CardSurface). Put it as the first child of a `position:relative` card: it fills the card
// with a lift shadow (or a dashed outline for a draft), an optional tint pool and wash, a progress bar on the bottom edge and a
// running glow, and on a state change one ripple band (`ripple` counts changes; each new count runs the band once, 950 ms).
// Colours are CSS values (var(--on), #e854d9). Draws only; it takes no pointer events.
import { computed } from "vue";

const props = withDefaults(defineProps<{ tint?: string; bar?: string; progress?: number; glow?: string; draft?: boolean; radius?: number; ripple?: number }>(), { progress: 0, radius: 16, ripple: 0 });
const rad = computed(() => props.radius + "px");
const clamp = computed(() => Math.min(1, Math.max(0, props.progress)));
</script>

<template>
  <div class="cs" :class="{ draft }" :style="{ '--rad': rad, '--tint': tint, '--bar': bar, '--glow': glow }" aria-hidden="true">
    <div class="cs-edge" :class="{ pool: !!tint }" />
    <div v-if="tint" class="cs-clip"><div class="cs-wash" /></div>
    <div v-if="bar" class="cs-barwrap"><div class="cs-track" /><i :style="{ transform: `scaleX(${clamp})` }" /></div>
    <div v-if="glow" class="cs-glow" />
    <div v-if="ripple" class="cs-clip"><i :key="ripple" class="cs-rip" /></div>
  </div>
</template>

<style scoped>
.cs{position:absolute;inset:0;border-radius:var(--rad);pointer-events:none;--lift:0 0 0 .75px rgba(255,255,255,.09),inset 0 1px 0 rgba(255,255,255,.07),0 1px 1px rgba(0,0,0,.4),0 8px 16px -6px rgba(0,0,0,.5),0 22px 36px -18px rgba(0,0,0,.6);--poolmix:42%;--washmix:26%}
:root[data-theme="light"] .cs{--lift:0 0 0 .75px rgba(22,22,26,.08),0 1px 1px rgba(22,22,26,.05),0 8px 16px -6px rgba(22,22,26,.12),0 22px 36px -18px rgba(22,22,26,.2);--poolmix:34%;--washmix:16%}
.cs-edge{box-sizing:border-box;position:absolute;inset:0;border-radius:inherit;box-shadow:var(--lift)}
.cs-edge.pool{box-shadow:var(--lift),0 20px 30px -20px color-mix(in srgb,var(--tint) var(--poolmix),transparent)}
.draft .cs-edge{box-shadow:none;border:1.5px dashed color-mix(in srgb,var(--muted) 70%,transparent)}
.cs-clip{position:absolute;inset:0;border-radius:inherit;overflow:hidden}
.cs-wash{position:absolute;inset:0;background:radial-gradient(130% 95% at 0% 100%,color-mix(in srgb,var(--tint) var(--washmix),transparent),transparent 62%)}
.cs-barwrap{position:absolute;left:0;right:0;bottom:0;height:16px;border-radius:0 0 var(--rad) var(--rad);overflow:hidden}
.cs-track{position:absolute;left:0;right:0;bottom:0;height:3px;background:color-mix(in srgb,var(--ink) 9%,transparent)}
.cs-barwrap i{position:absolute;left:0;right:0;bottom:0;height:3px;border-radius:0 2px 2px 0;background:var(--bar);transform-origin:0 50%;transition:transform .7s cubic-bezier(.23,1,.32,1)}
.cs-glow{position:absolute;inset:0;border-radius:inherit;box-shadow:0 0 0 1px color-mix(in srgb,var(--glow) 40%,transparent),0 0 26px -2px color-mix(in srgb,var(--glow) 45%,transparent);animation:cs-glow 3.2s cubic-bezier(.65,0,.35,1) infinite}
.cs-rip{position:absolute;left:-10%;right:-10%;top:0;height:100%;opacity:0;transform:translateY(85%);background:linear-gradient(8deg,transparent 22%,color-mix(in srgb,var(--bar,var(--tint,var(--sel))) 30%,transparent) 48%,rgba(255,255,255,.16) 54%,transparent 76%);animation:cs-rip .95s cubic-bezier(.3,.6,.2,1) forwards}
@keyframes cs-rip{0%{transform:translateY(85%);opacity:0}30%{opacity:1}100%{transform:translateY(-85%);opacity:0}}
@keyframes cs-glow{0%,100%{opacity:.5}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.cs-rip{display:none}.cs-glow{animation:none;opacity:.8}.cs-barwrap i{transition:none}}
</style>
