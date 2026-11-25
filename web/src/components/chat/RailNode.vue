<script setup lang="ts">
// The node on the plan rail (canvas RailNode): todo hollow, cur green dot in a ring, done lit with a tick, blocked red,
// wait amber. `surface` is what sits under the node, so the fill matches the card or the panel behind it.
// `play` runs the canvas Motion "a step finishes": `fin` slides a cover off the tick (360 ms), `grow` grows the next
// node's ring and dot in after the light has run to it (240 ms at 560 ms). Transform and opacity only.
withDefaults(defineProps<{ state?: "todo" | "cur" | "done" | "blocked" | "wait"; surface?: "card" | "panel"; play?: "fin" | "grow" | null }>(), { state: "cur", surface: "card", play: null });
</script>

<template>
  <span :class="['rn', state, surface, play]" aria-hidden="true">
    <i class="ring" /><i class="dot" />
    <span class="tk"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg><i v-if="play === 'fin'" class="cov" /></span>
  </span>
</template>

<style scoped>
.rn{padding:0;border:0;background:none;box-shadow:none;--rn-under:var(--panel);--rn-c:var(--on);--rn-done:color-mix(in srgb,var(--lit) 16%,var(--rn-under));position:relative;flex:none;width:24px;height:24px;display:grid;place-items:center}
.rn.panel{--rn-under:var(--panel)}
.rn.card{--rn-under:var(--card,var(--panel))}
.rn.blocked{--rn-c:var(--bad)}.rn.wait{--rn-c:var(--pend)}
i{position:absolute;border-radius:50%}
.ring{inset:3px;background:var(--rn-under);box-shadow:inset 0 0 0 2px var(--rn-c)}
.dot{inset:8px;background:var(--rn-c)}
.tk{position:absolute;inset:4px;overflow:hidden;border-radius:50%;display:grid;place-items:center}
svg{position:relative;width:12px;height:12px;fill:none;stroke:var(--lit);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:0}
.todo .ring{inset:7px;background:var(--panel-2);box-shadow:inset 0 0 0 1.5px var(--fiber)}
.todo .dot{background:transparent}
.done .ring{background:var(--rn-done);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--lit) 70%,transparent)}
.done .dot{background:transparent}
.done svg{opacity:1}
/* canvas Motion: the cover is the node's own fill, so the tick seems drawn left to right */
.cov{inset:0;background:var(--rn-done);transform:translateX(100%);animation:rn-uncover 360ms cubic-bezier(.2,.8,.2,1) 1 both}
.grow .ring{animation:rn-grow 240ms cubic-bezier(.2,.8,.2,1) 560ms 1 both}
.grow .dot{animation:rn-on 240ms cubic-bezier(.2,.8,.2,1) 560ms 1 both}
@keyframes rn-uncover{from{transform:translateX(0)}to{transform:translateX(100%)}}
@keyframes rn-grow{from{opacity:.45;transform:scale(.56)}to{opacity:1;transform:scale(1)}}
@keyframes rn-on{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.cov{display:none}.grow .ring,.grow .dot{animation:none}}
</style>
