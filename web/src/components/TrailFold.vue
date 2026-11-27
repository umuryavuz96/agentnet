<script setup lang="ts">
// The folded trail of one reply (canvas Trail, "Folded"): a toolbox icon, one 8 px square per call, the state in a word,
// the time and a chevron. A finished run with a failure reads "Done, 1 failed" (canvas Reply). The box is as wide as what is in it. Green square = done, red = failed, the running one is green
// with a light sweeping over it. A run with no calls, only thinking, reads as one thought tile. Tap opens or closes.
// Open, it is one box (owner 2026-11-25): this line is its top and the calls (the slot) sit under a hairline inside the
// same edge and radius. The box takes the column's width the moment it opens and gives it back when the close has ended;
// only the height of the calls and their opacity move, so the rows around it follow without a jump.
import { computed } from "vue";
import Icon from "../ui/Icon.vue";
import ToolTile from "./chat/ToolTile.vue";
import { doneWord, squares, type FeedItem } from "../chatFeed";
import { dur } from "../trailView";

const props = defineProps<{ items: FeedItem[]; running: boolean; failed: number; ms: number; word: string; open: boolean; controls?: string; title?: string }>();
defineEmits<{ toggle: [] }>();
const sq = computed(() => squares(props.items));
const state = computed(() => (props.running ? props.word : doneWord(props.failed)));
const tone = computed(() => (props.running ? "on" : props.failed ? "bad" : "muted"));
const time = computed(() => (props.ms >= 1000 ? dur(props.ms) : ""));
const only = computed(() => !sq.value.length);
// Owner 8413: the squares already count the calls, so the line starts with a toolbox icon, not "8 calls". A screen reader
// still hears the count (the squares are aria-hidden).
const label = computed(() => (only.value ? undefined : `${sq.value.length} tool ${sq.value.length === 1 ? "call" : "calls"}, ${state.value}${time.value ? ", " + time.value : ""}`));
</script>

<template>
  <div :class="['tfb', { open }]">
    <button type="button" :class="['tf', { only }]" :aria-expanded="open" :aria-controls="controls" :aria-label="label" :title="title" @click="$emit('toggle')">
      <template v-if="only">
        <ToolTile kind="think" icon="brain" />
        <span class="w muted">Thought</span>
      </template>
      <template v-else>
        <Icon name="toolbox" :size="16" class="n" />
        <span class="sq" aria-hidden="true"><i v-for="(s, i) in sq" :key="i" :class="s"><u v-if="s === 'run'" /></i></span>
        <span :class="['w', tone, { fix: !running }]">{{ state }}</span>
      </template>
      <span class="t">{{ time }}</span>
      <Icon name="chevron-down" :size="14" class="cv" />
    </button>
    <div :id="controls" class="bd" :inert="!open || undefined"><div><div class="in"><slot /></div></div></div>
  </div>
</template>

<style scoped>
/* the box: closed it is as wide as its line (the pill), open as wide as the column. min-width switches at once on open and
   after the .22 s close, so the width is never animated */
.tfb{width:fit-content;max-width:100%;min-width:0%;border-radius:12px;background:var(--tool-fill,var(--card,var(--panel-2)));
  box-shadow:0 0 0 1px var(--tool-edge,rgba(255,255,255,.09)),inset 0 1px 0 rgba(255,255,255,.07),0 1px 2px rgba(0,0,0,.45),0 6px 12px -5px rgba(0,0,0,.5);transition:transform .16s cubic-bezier(.23,1,.32,1),min-width 0s linear .22s}
.tfb.open{min-width:100%;transition-delay:0s}
:root[data-theme="light"] .tfb{box-shadow:0 0 0 1px var(--tool-edge,rgba(0,0,0,.09)),0 1px 2px rgba(22,22,26,.08),0 6px 12px -5px rgba(22,22,26,.14)}
.tf{display:grid;grid-template-columns:auto auto auto auto 16px;justify-content:start;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 10px;border:0;border-radius:12px;background:transparent;color:var(--ink);font:12.5px/1.2 var(--body);text-align:left;cursor:pointer;transition:background-color .22s cubic-bezier(.2,.8,.2,1)}
.tfb.open > .tf{border-radius:12px 12px 0 0}
/* the calls: no width of their own while shut, so a closed pill stays as narrow as its line */
.bd{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:0fr;contain:inline-size;opacity:0;visibility:hidden;transition:grid-template-rows .22s cubic-bezier(.33,1,.68,1),opacity .22s cubic-bezier(.33,1,.68,1),visibility .22s}
.tfb.open > .bd{grid-template-rows:1fr;opacity:1;visibility:visible}
.bd > div{min-width:0;min-height:0;overflow:hidden}
.in{padding:6px 8px 4px;border-top:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}
.tf.only{grid-template-columns:auto auto auto 16px;gap:8px;padding-left:7px}
.tf:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.tfb.open > .tf:focus-visible{outline-offset:-2px}
/* shut, the pill lifts and presses; open, only its line takes a tint, because a whole list should not move */
@media (hover:hover) and (pointer:fine){.tfb:not(.open):has(> .tf:hover){transform:translateY(-1.5px)}.tfb.open > .tf:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}}
.tfb:not(.open):has(> .tf:active){transform:scale(.985)}
.n{flex:none;color:var(--muted)}
.sq{display:flex;align-items:center;gap:3px;min-width:0;flex-wrap:wrap}
.sq i{position:relative;flex:none;width:8px;height:8px;border-radius:2.5px;background:var(--lit);opacity:.7;overflow:hidden}
.sq i.bad{background:var(--bad);opacity:1}
.sq i.run{background:var(--on);opacity:1}
.sq u{position:absolute;inset:0 auto 0 0;width:60%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.85),transparent);transform:translateX(-100%);animation:tf-sweep 1.4s cubic-bezier(.65,0,.35,1) infinite}
@keyframes tf-sweep{to{transform:translateX(260%)}}
.w{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(32ch,40vw)}
/* "Done" or "Done, 1 failed" is never cut: the squares wrap first; only a running call's long title ellipses */
.w.fix{overflow:visible;max-width:none;min-width:max-content}
/* a phone: the running call's title wraps instead of being cut */
@media (max-width:480px){.w:not(.fix){white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:clip}}
.w.on{color:var(--on)}.w.bad{color:var(--bad)}.w.muted{color:var(--muted);font-weight:500}
.t{font:500 12px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.cv{color:var(--muted);transition:transform .22s cubic-bezier(.2,.8,.2,1)}
.tf[aria-expanded="true"] .cv{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.sq u{animation:none;display:none}.tfb,.tf,.bd,.cv{transition:none}.tfb:not(.open):has(> .tf:hover),.tfb:not(.open):has(> .tf:active){transform:none}}
</style>
