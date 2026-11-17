<script setup lang="ts">
// Agent trail, size 1 (map board 10-agent-trail, line()): one row on a card. Count, one segment per step coloured by
// where the agent is, the step in words, a live timer. Under 310 px of room the word drops to its own second row.
import { computed, nextTick, ref, watch } from "vue";
import { net, pendingChecks, type AgentRow } from "../net";
import { trailView, dur, short, SEG, WORD } from "../trailView";
const props = defineProps<{ row: AgentRow }>();
const check = computed(() => pendingChecks.value.find((c) => c.agent === props.row.name) ?? null);
const v = computed(() => trailView(props.row, check.value));
// where the steps added after the plan begin (a wider gap on the line); none on the plain list
const firstAdded = computed(() => (v.value.plan ? v.value.steps.findIndex((s) => s.step?.added) : -1));
const calm = computed(() => ["idle", "none", "closed"].includes(v.value.mode));
const sec = computed(() => (v.value.since == null ? "" : calm.value ? short(net.now - v.value.since) : dur(net.now - v.value.since)));
const label = computed(() => { const p = v.value.plan; return p ? `${p.done} of ${p.plan} brief steps done${p.added ? `, ${p.added} added` : ""}, ${v.value.word}` : v.value.n ? `${v.value.done} of ${v.value.n} steps done, ${v.value.word}` : v.value.word; });
// one sweep of light over the current segment when a step changes (a step done, the next one started, a question
// arrived), never looping: the board's sweep(). In the live stream "done" and "next started" can land apart; the sweep
// plays on whichever leaves a current segment to run over.
const el = ref<HTMLElement | null>(null);
watch(() => [v.value.done, v.value.cur, check.value?.id ?? 0, props.row.name] as const, async (n, o) => {
  if (n[3] !== o[3] || !(n[0] > o[0] || (n[1] !== o[1] && n[1] >= 0 && n[0] >= o[0]) || (n[2] && n[2] !== o[2]))) return;
  await nextTick();
  const s = el.value?.querySelector<HTMLElement>(".tr-seg.cur .sw, .tr-seg.gate .sw"); if (!s) return;
  s.classList.remove("go"); void s.offsetWidth; s.classList.add("go");
});
</script>

<template>
  <div class="trl">
    <div ref="el" class="tr-line" role="img" :aria-label="label">
      <span class="tr-count num">{{ v.count || "0" }}<span v-if="v.plan?.added" :class="['tr-plus', { grew: v.plan.grew }]" :title="`${v.plan.added} ${v.plan.added === 1 ? 'step' : 'steps'} added after the plan was set`">+{{ v.plan.added }}</span></span>
      <span :class="['tr-segs', { none: !v.n }]"><i v-for="(t, i) in v.steps" :key="t.id" :class="['tr-seg', t.status === 'done' ? 'done' : t.status === 'dropped' ? 'drop' : i === v.cur ? SEG[v.mode] : '', { dead: v.mode === 'closed', gap: i === firstAdded && i > 0 }]"><b class="sw" /></i></span>
      <span :class="['tr-word', WORD[v.mode]]">{{ v.word }}</span>
      <span class="tr-sec num">{{ sec }}</span>
    </div>
  </div>
</template>

<style scoped>
.trl{container-type:inline-size;min-width:0}
.tr-line{display:grid;grid-template-columns:auto minmax(40px,1fr) auto auto;grid-template-areas:"count segs word sec";align-items:center;gap:8px;min-height:20px;font-size:12px}
.tr-count{grid-area:count;display:inline-flex;align-items:baseline;gap:5px;font:600 12px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--ink)}
/* steps added after the plan was set: a figure of their own, amber once the plan grew by more than half */
.tr-plus{color:var(--muted)}.tr-plus.grew{color:var(--pend)}
.tr-segs{grid-area:segs;display:flex;gap:2px;height:4px}
.tr-word{grid-area:word;white-space:nowrap;color:var(--ink);font-weight:600;min-width:0;overflow-wrap:break-word}
.tr-sec{grid-area:sec;font:500 12px/1 var(--mono);color:var(--muted);min-width:6ch;text-align:right;white-space:nowrap}
@container (max-width:309px){
  .tr-line{grid-template-columns:auto minmax(40px,1fr) auto;grid-template-areas:"count segs sec" "word word word";row-gap:6px}
  .tr-word{white-space:normal}
}
.tr-seg{position:relative;flex:1;min-width:2px;border-radius:2px;background:var(--tr-track);overflow:hidden}
.tr-seg::before{content:"";position:absolute;inset:0;border-radius:inherit;background:var(--lit);opacity:0;transition:opacity .32s ease}
.tr-seg.done::before{opacity:.7}
.tr-seg.cur::before{background:var(--on);opacity:1}
.tr-seg.gate::before{background:var(--pend);opacity:1}
.tr-seg.block::before{background:var(--bad);opacity:1}
.tr-seg.idle::before{background:var(--off);opacity:.9}
.tr-seg.dead{background:transparent;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--off) 55%,transparent)}
.tr-seg.dead.done::before{background:var(--off);opacity:.55}
.tr-segs.none{height:0;border-top:1px dashed var(--tr-track);align-self:center}
/* a wider gap where the added steps begin; a dropped step is a hollow segment */
.tr-seg.gap{margin-left:5px}
.tr-seg.drop{background:transparent;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--off) 55%,transparent)}
/* height, margin, radius: the global .sw (a switch, ui/tokens.css) must not reach this one */
.sw{position:absolute;inset:0 auto 0 0;width:60%;height:auto;margin:0;border-radius:0;cursor:inherit;transition:none;background:linear-gradient(90deg,transparent,var(--head),transparent);opacity:0;transform:translateX(-100%)}
.sw.go{animation:tr-sweep .9s cubic-bezier(.65,0,.35,1) 1}
@keyframes tr-sweep{0%{opacity:.9;transform:translateX(-100%)}100%{opacity:0;transform:translateX(260%)}}
.tr-word.on{color:var(--on)}.tr-word.gate{color:var(--pend)}.tr-word.block{color:var(--bad)}.tr-word.muted{color:var(--muted);font-weight:500}
@media (prefers-reduced-motion:reduce){.sw.go{animation:none;opacity:0}}
</style>
