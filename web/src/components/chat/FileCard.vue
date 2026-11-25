<script setup lang="ts">
// A file on its own line in a reply (canvas Files, "Alone on a line: a card with the first lines"; a picture file shows the
// picture instead). The card never scrolls: the first lines are cut with a fade. Tap, Enter or Space opens the focus view.
import { computed, ref } from "vue";
import { fileUrl, loadFile } from "./fileApi";
import Icon from "../../ui/Icon.vue";
import { onMounted } from "vue";
import CardSurface from "./CardSurface.vue";
import FocusView from "./FocusView.vue";
import ToolTile from "./ToolTile.vue";

const props = defineProps<{ path: string; lines?: string; note?: string; content?: string; /** the agent that wrote it: a local picture is asked for in its name */ from?: string }>();

const IMG = /\.(png|jpe?g|gif|webp)$/i;
const isImg = computed(() => IMG.test(props.path));
const slash = computed(() => props.path.lastIndexOf("/"));
const name = computed(() => props.path.slice(slash.value + 1));
const dir = computed(() => (slash.value > 0 ? props.path.slice(0, slash.value) : slash.value === 0 ? "/" : ""));
// The first lines: the reply's own `content`, else asked from the service ("loading" until it answers, "gone" when it cannot).
const state = ref<"loading" | "ok" | "gone">(props.content !== undefined || isImg.value || !props.from ? "ok" : "loading");
const head = ref<string[]>((props.content ?? "").replace(/\n$/, "").split("\n").slice(0, 6));
const total = ref(props.content !== undefined ? props.content.replace(/\n$/, "").split("\n").length : 0);
const hasText = computed(() => !isImg.value && total.value > 0);
onMounted(async () => {
  if (state.value !== "loading" || !props.from) return;
  try { const r = await loadFile(props.from, props.path, "1-6"); head.value = r.text.split("\n"); total.value = r.total; state.value = "ok"; } catch { state.value = "gone"; }
});
const imgSrc = computed(() => (isImg.value && props.from ? fileUrl(props.from, props.path) : null));
const broken = ref(false), loaded = ref(false), tries = ref(0);
const src = computed(() => (imgSrc.value ? imgSrc.value + (tries.value ? `&r=${tries.value}` : "") : null));
function retry() { broken.value = false; loaded.value = false; tries.value++; }

const card = ref<HTMLElement | null>(null);
const open = ref(false), origin = ref<{ x: number; y: number; w: number; h: number } | null>(null);
function show() { const r = card.value?.getBoundingClientRect(); origin.value = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; open.value = true; }
</script>

<template>
  <p v-if="state === 'gone'" class="fc-plain"><code>{{ path }}</code></p>
  <div v-else ref="card" class="fc" role="button" tabindex="0" :aria-label="`Open ${path}`" @click="show" @keydown.enter.prevent="show" @keydown.space.prevent="show">
    <CardSurface />
    <div class="fc-head">
      <ToolTile :kind="isImg ? 'image' : 'read'" :icon="isImg ? 'image' : 'file-code'" size="lg" />
      <span class="fc-t"><b>{{ name }}</b><small v-if="dir">{{ dir }}</small></span>
      <span v-if="hasText" class="fc-n">{{ total }} lines</span>
      <Icon name="maximize" :size="14" class="fc-x" />
    </div>
    <p v-if="note" class="fc-note">{{ note }}</p>
    <template v-if="isImg">
      <div v-if="src" class="fc-pic">
        <img v-if="!broken" :src="src" :alt="name" loading="lazy" decoding="async" :class="{ on: loaded }" @load="loaded = true" @error="broken = true">
        <div v-else class="fc-miss"><Icon name="image" :size="20" /><span>This picture did not load.<br><code>{{ path }}</code></span><button type="button" data-lift="pill" @click.stop="retry"><Icon name="rotate-ccw" :size="14" />Try again</button></div>
      </div>
    </template>
    <div v-else-if="state === 'loading'" class="fc-code fc-load" aria-label="Reading"><i /><i /><i /></div>
    <div v-else-if="hasText" class="fc-code"><pre><span v-for="(l, i) in head" :key="i"><span class="fc-ln">{{ i + 1 }}</span>{{ l || " " }}</span></pre></div>
    <FocusView v-if="open" :path="path" :lines="lines" :content="content" :from="from" :image-src="src" :origin="origin" @close="open = false" />
  </div>
</template>

<style scoped>
.fc{--cd:#1e1e21;--hair:rgba(255,255,255,.1);position:relative;isolation:isolate;display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px 14px;border-radius:16px;background:var(--cd,var(--panel));font-size:13.5px;line-height:1.45;cursor:pointer;transition:transform .16s cubic-bezier(.23,1,.32,1)}
.fc :deep(.cs){z-index:-1}
.fc:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.fc:active{transform:scale(.985)}
@media (hover:hover) and (pointer:fine){.fc:hover{transform:translateY(-1.5px)}.fc:active{transform:scale(.985)}}
.fc-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.fc-t{flex:1;min-width:0;display:grid;gap:1px}
.fc-t b{font-weight:600;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.fc-t small{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.fc-n{flex:none;font:500 11.5px/20px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.fc-x{flex:none;margin-top:3px;color:var(--muted)}
.fc-plain{margin:0;overflow-wrap:anywhere}
.fc-plain code{font:500 12.5px/1.5 var(--mono);color:var(--muted)}
.fc-note{margin:0;color:var(--muted);font-size:12.5px}
.fc-code{margin:0 -14px -14px;border-top:1px solid var(--hair);border-radius:0 0 16px 16px;overflow:hidden;background:var(--panel-2,var(--panel))}
.fc-code pre{margin:0;padding:8px 0;max-height:118px;overflow:hidden;font:500 12px/1.55 var(--mono);-webkit-mask:linear-gradient(#000 55%,transparent);mask:linear-gradient(#000 55%,transparent)}
.fc-code pre>span{display:block;white-space:pre;padding:0 12px 0 0}
.fc-ln{display:inline-block;width:40px;padding-right:10px;text-align:right;color:var(--muted)}
.fc-load{display:grid;gap:8px;padding:12px 14px}.fc-load i{display:block;height:8px;border-radius:4px;background:color-mix(in srgb,var(--ink) 10%,transparent);animation:fc-pulse 1.4s cubic-bezier(.65,0,.35,1) infinite}.fc-load i:nth-child(2){width:80%;animation-delay:.15s}.fc-load i:nth-child(3){width:60%;animation-delay:.3s}
@keyframes fc-pulse{50%{opacity:.45}}
.fc-pic{position:relative;margin:0 -14px -14px;aspect-ratio:16/9;border-radius:0 0 16px 16px;overflow:hidden;background:var(--panel-2,var(--panel))}
.fc-pic img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .2s var(--ease)}
.fc-pic img.on{opacity:1}
.fc-miss{position:absolute;inset:0;display:grid;gap:8px;justify-items:center;align-content:center;padding:12px;color:var(--muted);font-size:13px;text-align:center}
.fc-miss code{font-size:.9em}
.fc-miss button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border:0;border-radius:999px;background:var(--cd,var(--panel));color:var(--ink);font:600 13px var(--body);cursor:pointer;box-shadow:0 0 0 .75px var(--hair),0 1px 2px rgba(0,0,0,.3)}
.fc-miss button{transition:transform .16s cubic-bezier(.23,1,.32,1)}.fc-miss button:active{transform:scale(.97)}
@media (prefers-reduced-motion:reduce){.fc,.fc-pic img,.fc-miss button{transition:none}.fc:hover,.fc:active,.fc-miss button:active{transform:none}.fc-load i{animation:none}}
:root[data-theme="light"] .fc{--cd:#fbfbfc;--hair:rgba(0,0,0,.09)}
</style>
