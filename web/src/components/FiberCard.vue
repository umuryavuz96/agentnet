<script setup lang="ts">
// One agent card on the 2D fiber map. Text that changes (state word, doing line) is keyed, so a new value fades in.
import { computed } from "vue";
import { net, humanDoing, ctxView, type AgentRow } from "../net";
import { curJob, endedText, planCount, planLine } from "../plan";
import { short } from "../trailView";
import { brk, modelShort, type CrewState } from "../crewTree";
import TrailLine from "./TrailLine.vue";

const props = defineProps<{ id: string; name: string; row: AgentRow; state: CrewState; lead?: boolean; dir?: boolean; sel?: boolean; got?: boolean; hot?: boolean; k?: string }>();
const emit = defineEmits<{ pick: []; hover: [on: boolean, el: HTMLElement] }>();
const WORD: Record<string, string> = { working: "Working", idle: "Idle", blocked: "Blocked", waiting: "Waiting for you", starting: "Starting" };
const word = computed(() => WORD[props.state] ?? props.state);
const doing = computed(() => { const t = humanDoing(props.row.doing) ?? ""; return t && t.toLowerCase() !== word.value.toLowerCase() && t.toLowerCase() !== props.state ? t : ""; });
const ctx = computed(() => { const c = ctxView(props.row); return c ? Math.round(c.pct) : null; });
// an agent with a plan: the step in work (with its number) stands in the place of the status sentence, or how the job ended
const pl = computed(() => planLine(props.row));
const grew = computed(() => { const j = curJob(props.row); return !!j && !j.legacy && planCount(j).grew; });
</script>

<template>
  <button type="button" :data-id="id" :class="['fcard', state, { sel, got, hot, none: !row.tasks?.length }]" :style="{ '--k': k }" :aria-pressed="sel ? 'true' : 'false'"
    @click="emit('pick')" @pointerenter="(e) => e.pointerType === 'mouse' && emit('hover', true, e.currentTarget as HTMLElement)" @pointerleave="(e) => e.pointerType === 'mouse' && emit('hover', false, e.currentTarget as HTMLElement)">
    <span class="fch"><i :class="['fdot', state]" /><b class="fnm">{{ brk(name) }}</b><span v-if="dir" class="fchip dir">Director</span><span v-else-if="lead" class="fchip lead">Lead</span><span v-if="ctx != null" :class="['fctx', { hi: ctx >= 80 }]">{{ ctx }}%</span></span>
    <span class="fch"><span :key="word" class="fstw fx">{{ word }}</span><span v-if="modelShort(row.model)" class="fchip">{{ modelShort(row.model) }}</span><span v-if="grew" class="fchip grew" title="The plan grew by more than half of the brief's steps">Scope grew</span></span>
    <span v-if="pl && 'no' in pl" :key="pl.no" class="fline fx"><span class="fno">{{ pl.no }}</span>{{ pl.text }}</span>
    <span v-else-if="pl" :key="'job' + pl.ended.id" class="fline fx">{{ endedText(pl, short(net.now - pl.ended.closedAt!)) }}</span>
    <span v-else-if="doing" :key="doing" class="fline fx">{{ doing }}</span>
    <TrailLine :row="row" />
  </button>
</template>

<style scoped>
.fcard{position:relative;width:300px;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:11px 13px 12px;border:0;border-radius:14px;background:var(--cd,var(--panel));box-shadow:inset 0 0 0 1px var(--cdl,var(--line)),0 1px 2px rgba(0,0,0,.28);color:var(--ink);text-align:left;font:inherit;cursor:pointer;transition:box-shadow .18s}
.fcard:focus-visible{outline:2px solid var(--sel);outline-offset:3px}
.fcard.hot{box-shadow:inset 0 0 0 1px var(--ink),0 1px 2px rgba(0,0,0,.28)}
/* rings sit on pseudo-elements and only their opacity changes (map board: selection 160 ms, glow 450 ms) */
.fcard::before{content:"";position:absolute;inset:-1px;border-radius:inherit;box-shadow:0 0 0 2px var(--sel);pointer-events:none;opacity:0;transition:opacity .16s ease}
.fcard.sel::before{opacity:1}
.fcard::after{content:"";position:absolute;inset:-1px;border-radius:inherit;box-shadow:0 0 0 1.5px var(--warn);pointer-events:none;opacity:0;transition:opacity .45s ease}
.fcard.waiting::after{opacity:1}
.fcard.got::after{opacity:1;box-shadow:0 0 0 1.5px var(--k),0 0 24px color-mix(in srgb,var(--k) 45%,transparent)}
/* a message leaving or landing: the map sets the colour and animates this ring's opacity */
.fcard[data-glow]::after{box-shadow:0 0 0 1.5px var(--gk),0 0 24px color-mix(in srgb,var(--gk) 45%,transparent)}
.fch{display:flex;align-items:center;gap:8px;min-width:0}
.fnm{font-weight:650;font-size:14px;overflow-wrap:anywhere;min-width:0}
.fctx{margin-left:auto;font:600 11px/1 var(--mono);color:var(--muted)}.fctx.hi{color:var(--warn)}
.fstw{font-weight:600;font-size:12px;color:var(--muted)}
.fcard.working .fstw{color:var(--on)}.fcard.blocked .fstw{color:var(--bad)}.fcard.waiting .fstw{color:var(--warn)}
.fline{color:var(--muted);font-size:12.5px;line-height:17px;overflow-wrap:anywhere;text-wrap:pretty}
.fno{margin-right:6px;font:500 11px/17px var(--mono);font-variant-numeric:tabular-nums;color:var(--ink)}
.fx{animation:fx-in .2s ease}
@keyframes fx-in{from{opacity:0}to{opacity:1}}
.fdot{width:8px;height:8px;border-radius:50%;background:var(--off);flex:none}
.fdot.working{background:var(--on);box-shadow:0 0 0 3px color-mix(in srgb,var(--on) 18%,transparent)}
.fdot.blocked{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 18%,transparent)}
.fdot.waiting{background:var(--warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 20%,transparent)}
.fchip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font:600 11px/1 var(--mono);color:var(--muted);background:color-mix(in srgb,var(--line) 60%,transparent);white-space:nowrap}
.fchip.grew{color:var(--pend);background:color-mix(in srgb,var(--pend) 12%,transparent);font-family:var(--body)}
.fchip.lead{color:var(--ink);background:transparent;box-shadow:inset 0 0 0 1px var(--muted);font-family:var(--body)}
.fchip.dir{color:var(--ink);background:transparent;box-shadow:inset 0 0 0 1.5px var(--ink);font-family:var(--body)}
</style>
