<script setup lang="ts">
// A deliverable (canvas Deliverables): five kinds, one card. A kind tile, what it is in one line, the figure that proves it.
// The wash at the bottom left is the hue of the agent that made it. "Done" is the only card that speaks in green and it lists
// what was checked. At most one thing to tap besides itself: a picture opens in the focus view.
import { computed, ref } from "vue";
import Icon from "../../ui/Icon.vue";
import type { IconName } from "../../ui/icons";
import type { Block, CheckState, ResultKind } from "../../chatBlocks";
import CardSurface from "./CardSurface.vue";
import Chip from "./Chip.vue";
import DotTile from "./DotTile.vue";
import FocusView from "./FocusView.vue";
import ToolTile, { type ToolKind } from "./ToolTile.vue";
import { agentHue } from "./agentHue";
import { fileUrl } from "./fileApi";
import { esc, refChip } from "../../chatMarkers";

type ResultBlock = Extract<Block, { type: "result" }>;
const props = defineProps<{ block: ResultBlock; /** the agent that wrote it: its hue tints the card, a local picture is asked for in its name */ from?: string }>();
const TILE: Record<ResultKind, { kind: ToolKind; icon: IconName; label: string }> = {
  commit: { kind: "plain", icon: "git-commit-horizontal", label: "Commit" },
  shot: { kind: "image", icon: "camera", label: "Screenshot" },
  report: { kind: "read", icon: "file-text", label: "Report" },
  pr: { kind: "agent", icon: "git-pull-request", label: "Pull request" },
  done: { kind: "ok", icon: "circle-check", label: "Done" },
};
const CHECK: Record<Exclude<CheckState, "wait">, IconName> = { done: "circle-check", todo: "circle", skip: "minus" };
// A short sha in a check line is a commit chip, the same chip the reply text uses (canvas Deliverables: "in [839475a]").
const SHA_WORD = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,10}\b/g;
const checkHtml = (t: string) => esc(t).replace(SHA_WORD, (h) => refChip("sha", h));
const hue = computed(() => agentHue(props.block.by ?? props.from));
const tile = computed(() => TILE[props.block.kind]);
const tint = computed(() => (props.block.kind === "done" ? "var(--on)" : `hsl(${hue.value} 78% 62%)`));
const pic = computed(() => (props.block.image?.startsWith("/") && props.from ? fileUrl(props.from, props.block.image) : null));
const broken = ref(false), open = ref(false), origin = ref<{ x: number; y: number; w: number; h: number } | null>(null), thumb = ref<HTMLElement | null>(null);
function show() { const r = thumb.value?.getBoundingClientRect(); origin.value = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; open.value = true; }
</script>

<template>
  <section :class="['rc', 'k-' + block.kind]" :aria-label="`${tile.label}: ${block.title}`">
    <CardSurface :tint="tint" />
    <div class="rc-top">
      <ToolTile :kind="tile.kind" :icon="tile.icon" size="lg" />
      <span class="rc-t"><b>{{ block.title }}</b><small v-if="block.kind !== 'done'">{{ block.sub ?? tile.label }}</small></span>
      <span v-if="block.ref" class="rc-ref">{{ block.ref }}</span>
    </div>
    <div v-if="block.kind === 'shot' && (pic || block.path || block.tags.length)" class="rc-shot">
      <button v-if="pic && !broken" ref="thumb" type="button" class="rc-th" data-lift :aria-label="`Open ${block.image}`" @click="show"><img :src="pic" alt="" loading="lazy" decoding="async" @error="broken = true"></button>
      <span class="rc-side"><code v-if="block.path">{{ block.path }}</code><span v-if="block.tags.length" class="rc-tags"><Chip v-for="t in block.tags" :key="t" :text="t" :strong="false" /></span></span>
    </div>
    <code v-else-if="block.path" class="rc-path">{{ block.path }}</code>
    <dl v-if="block.figures.length" class="rc-fig"><div v-for="(f, i) in block.figures" :key="i"><dd>{{ f.value }}</dd><dt>{{ f.label }}</dt></div></dl>
    <ul v-if="block.checks.length" class="rc-ck">
      <li v-for="(c, i) in block.checks" :key="i" :class="'c-' + c.state">
        <!-- waiting is a still dashed circle (lucide circle-dashed); motion is only for what is running -->
        <svg v-if="c.state === 'wait'" class="rc-wait" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /><path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" /><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /></svg>
        <Icon v-else :name="CHECK[c.state]" :size="15" />
        <!-- eslint-disable-next-line vue/no-v-html -- escaped in checkHtml -->
        <span v-html="checkHtml(c.text)" />
      </li>
    </ul>
    <p v-if="block.foot" class="rc-foot">{{ block.foot }}</p>
    <p v-if="block.by" class="rc-by"><DotTile :hue="hue" state="idle" size="sm" /><b>{{ block.by }}</b><span v-if="block.kind === 'done' && block.sub">{{ block.sub }}</span></p>
    <FocusView v-if="open && block.image" :path="block.image" :from="from" :image-src="pic" :origin="origin" @close="open = false" />
  </section>
</template>

<style scoped>
.rc{position:relative;isolation:isolate;display:flex;flex-direction:column;gap:9px;min-width:0;padding:12px 14px 14px;border-radius:16px;background:var(--cd);--cd:#1e1e21;font-size:13.5px;line-height:1.45}
:root[data-theme="light"] .rc{--cd:#fbfbfc}
.rc :deep(.cs){z-index:-1}
.rc-top{display:flex;align-items:flex-start;gap:10px;min-width:0}
.rc-t{flex:1;min-width:0;display:grid;gap:1px}
.rc-t b{font-weight:600;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.rc-t small{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.k-done .rc-t b{font-size:16px;font-weight:650}
.rc-ref{flex:none;font:500 11.5px/20px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.rc-path,.rc-side code{font:500 12px/1.5 var(--mono);color:var(--muted);overflow-wrap:anywhere;word-break:break-all}
.rc-shot{display:flex;gap:10px;align-items:flex-start;min-width:0}
.rc-th{flex:none;width:112px;aspect-ratio:16/9;padding:0;border:0;border-radius:8px;overflow:hidden;background:var(--panel-2);cursor:pointer;box-shadow:0 0 0 .75px var(--hair,rgba(128,128,128,.25))}
.rc-th:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.rc-th img{display:block;width:100%;height:100%;object-fit:cover}
.rc-side{min-width:0;display:grid;gap:7px}
.rc-tags{display:flex;gap:6px;flex-wrap:wrap}
.rc-fig{display:flex;gap:22px;flex-wrap:wrap;margin:0}
.rc-fig div{display:grid;gap:1px}
.rc-fig dd{margin:0;font:700 17px/1.2 var(--mono);font-variant-numeric:tabular-nums}
.rc-fig dt{font-size:12px;color:var(--muted)}
.rc-ck{display:grid;gap:7px;margin:0;padding:0;list-style:none}
.rc-ck li{display:flex;align-items:center;gap:8px;min-width:0}
.rc-ck span{overflow-wrap:anywhere}
.c-done{color:var(--ink)}.c-done :deep(svg){color:var(--on)}
.c-todo,.c-skip,.c-wait{color:var(--muted)}
.rc-wait{flex:none}
.rc-foot{margin:0;color:var(--warn);font-weight:600}
.rc-by{display:flex;align-items:center;gap:8px;margin:0;font-size:12.5px;color:var(--muted)}
.rc-by b{color:var(--ink);font-weight:600}
.rc-th{transition:transform .16s cubic-bezier(.23,1,.32,1)}
.rc-th:active{transform:scale(.985)}
@media (hover:hover) and (pointer:fine){.rc-th:hover{transform:translateY(-1.5px)}.rc-th:active{transform:scale(.985)}}
@media (prefers-reduced-motion:reduce){.rc-th{transition:none}.rc-th:hover,.rc-th:active{transform:none}}
</style>
