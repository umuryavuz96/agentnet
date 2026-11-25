<script setup lang="ts">
// One agent-chosen UI block in a chat reply (web/src/chatBlocks.ts, docs/CHAT-UI-BLOCKS.md): card, stats, table, checklist,
// choices, section, steps or image. Text fields that allow markdown go through the same safe renderer as the reply itself.
// Choices send the picked answer back as the owner; once the owner has answered (picked here or typed), the row is locked.
// Colour: a card's tone fills its icon tile and tints the card; anything that sends as the owner is the owner's blue.
import { computed, ref } from "vue";
import Icon from "../ui/Icon.vue";
import CardSurface from "./chat/CardSurface.vue";
import DraftCard from "./chat/DraftCard.vue";
import JiraCard from "./chat/JiraBlock.vue";
import FileCard from "./chat/FileCard.vue";
import FocusView from "./chat/FocusView.vue";
import { usePicFocus } from "./chat/picFocus";
import RailNode from "./chat/RailNode.vue";
import ResultCard from "./chat/ResultCard.vue";
import TaskCard from "./chat/TaskCard.vue";
import ToolTile from "./chat/ToolTile.vue";
import { renderMd } from "../md";
import { isLocalImage, type Block, type StepState, type Tone } from "../chatBlocks";
import { url } from "../ui/api";

const props = defineProps<{ block: Block; /** the owner's next prompt after this reply, if any: locks choices */ answer?: string | null; canSend?: boolean; /** the agent that wrote it: a local picture is asked for in its name */ from?: string }>();
const emit = defineEmits<{ pick: [text: string]; edit: [text: string] }>();
const RAIL = { done: "done", active: "cur", todo: "todo", failed: "blocked" } as const;
const TONE_TINT: Record<Tone, string> = { info: "var(--sel)", ok: "var(--on)", warn: "var(--warn)", bad: "var(--bad)" };

const STEP_LABEL: Record<StepState, string> = { done: "done", active: "in progress", todo: "to do", failed: "failed" };
const open = ref(props.block.type === "section" && props.block.open);
const picked = ref<string | null>(null);
const locked = computed(() => picked.value !== null || props.answer != null);
const chosen = (send: string) => (picked.value ?? props.answer ?? "").trim() === send.trim();
function pick(send: string) { if (locked.value || !props.canSend) return; picked.value = send; emit("pick", send); }
const done = computed(() => (props.block.type === "steps" ? props.block.items.filter((i) => i.state === "done").length : props.block.type === "checklist" ? props.block.items.filter((i) => i.done).length : 0));
const broken = ref(false), tries = ref(0);
function retry() { broken.value = false; tries.value++; }
const pf = usePicFocus(); // the picture opens large in place, not in a new tab
function openPic(e: MouseEvent | KeyboardEvent) { if (imgSrc.value && props.block.type === "image") pf.open(e, imgSrc.value + (tries.value ? `&r=${tries.value}` : ""), props.block.src); }
/** Where the page loads a local picture from; null for a web address, which is only linked. */
const imgSrc = computed(() => (props.block.type === "image" && isLocalImage(props.block.src) && props.from ? url(`v1/panel/agents/${encodeURIComponent(props.from)}/image?path=${encodeURIComponent(props.block.src)}`) : null));
const uid = Math.random().toString(36).slice(2, 8);
</script>

<template>
  <section v-if="block.type === 'card'" :class="['ub', 'ub-card', 't-' + block.tone]">
    <CardSurface :tint="TONE_TINT[block.tone]" :radius="14" />
    <ToolTile :kind="block.tone" size="lg" />
    <div class="ub-cb">
      <h4 v-if="block.title">{{ block.title }}</h4>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized in md.ts -->
      <div v-if="block.body" class="ac-md" v-html="renderMd(block.body)" />
    </div>
  </section>

  <dl v-else-if="block.type === 'stats'" class="ub ub-stats">
    <CardSurface :radius="14" />
    <div v-for="(s, i) in block.items" :key="i"><dt>{{ s.label }}</dt><dd>{{ s.value }}</dd><p v-if="s.note">{{ s.note }}</p></div>
  </dl>

  <div v-else-if="block.type === 'table'" class="ub ub-table">
    <CardSurface :radius="14" />
    <div class="ub-ts"><table>
      <thead><tr><th v-for="(c, i) in block.columns" :key="i" :class="block.align[i]" scope="col">{{ c }}</th></tr></thead>
      <tbody><tr v-for="(r, y) in block.rows" :key="y"><td v-for="(c, i) in r" :key="i" :class="block.align[i]">{{ c }}</td></tr></tbody>
    </table></div>
  </div>

  <section v-else-if="block.type === 'checklist'" class="ub ub-list">
    <CardSurface :radius="14" />
    <h4 v-if="block.title">{{ block.title }}<span class="ub-n">{{ done }} of {{ block.items.length }}</span></h4>
    <ul>
      <li v-for="(it, i) in block.items" :key="i" :class="{ done: it.done }"><span class="ub-box" role="img" :aria-label="it.done ? 'done' : 'not done'"><Icon :name="it.done ? 'circle-check' : 'circle'" :size="16" /></span><span>{{ it.text }}</span></li>
    </ul>
  </section>

  <section v-else-if="block.type === 'choices'" :class="['ub', 'ub-choices', { locked }]">
    <p v-if="block.prompt">{{ block.prompt }}</p>
    <div class="ub-opts" role="group" :aria-label="block.prompt ?? 'Choose an answer'">
      <button v-for="(o, i) in block.options" :key="i" type="button" data-lift="pill" :class="{ on: chosen(o.send) }" :disabled="locked || !canSend" :aria-pressed="chosen(o.send)" :title="o.send !== o.label ? o.send : undefined" @click="pick(o.send)">
        <Icon v-if="chosen(o.send)" name="check" :size="14" />{{ o.label }}
      </button>
    </div>
    <p v-if="locked && !block.options.some((o) => chosen(o.send))" class="ub-hint">Answered in your own words</p>
    <p v-else-if="!locked && canSend" class="ub-hint">Picking one sends it as your message</p>
  </section>

  <section v-else-if="block.type === 'section'" class="ub ub-sec">
    <CardSurface :radius="14" />
    <button type="button" class="ub-sh" :aria-expanded="open" :aria-controls="'ub-' + uid" @click="open = !open"><Icon name="chevron-down" :size="16" class="ub-cv" /><span>{{ block.title }}</span></button>
    <div :id="'ub-' + uid" :class="['ub-fold', { open }]" :inert="!open || undefined">
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized in md.ts -->
      <div><div class="ac-md ub-sb" v-html="renderMd(block.body)" /></div>
    </div>
  </section>

  <section v-else-if="block.type === 'steps'" class="ub ub-steps">
    <CardSurface :radius="14" />
    <h4>{{ block.title ?? "Progress" }}<span class="ub-n">{{ done }} of {{ block.items.length }}</span></h4>
    <div class="ub-bar" role="progressbar" :aria-valuenow="done" aria-valuemin="0" :aria-valuemax="block.items.length"><i :style="{ transform: `scaleX(${done / block.items.length})` }" /></div>
    <ol>
      <li v-for="(it, i) in block.items" :key="i" :class="'s-' + it.state">
        <span class="ub-dot" role="img" :aria-label="STEP_LABEL[it.state]"><RailNode :state="RAIL[it.state]" /></span>
        <span class="ub-st">{{ it.text }}<small v-if="it.note">{{ it.note }}</small></span>
      </li>
    </ol>
  </section>

  <FileCard v-else-if="block.type === 'file'" :path="block.path" :lines="block.lines" :note="block.note" :content="block.content" :from="from" />

  <TaskCard v-else-if="block.type === 'task'" :block="block" />

  <DraftCard v-else-if="block.type === 'draft'" :block="block" :can-send="canSend" :answer="answer" @send="(t) => emit('pick', t)" @edit="(t) => emit('edit', t)" />

  <JiraCard v-else-if="block.type === 'jira'" :block="block" :answer="answer" :can-send="canSend" @pick="(t) => emit('pick', t)" />

  <ResultCard v-else-if="block.type === 'result'" :block="block" :from="from" />

  <figure v-else-if="block.type === 'image'" class="ub ub-img">
    <a v-if="imgSrc && !broken" :href="imgSrc + (tries ? `&r=${tries}` : '')" target="_blank" rel="noopener" role="button" aria-haspopup="dialog" :aria-label="`Open image: ${block.alt || block.src}`" @click="openPic" @keydown.space.prevent="openPic"><img :src="imgSrc + (tries ? `&r=${tries}` : '')" :alt="block.alt" loading="lazy" decoding="async" @error="broken = true"></a>
    <div v-else-if="imgSrc" class="ub-fail"><Icon name="image" :size="20" /><span>This picture did not load.<br><code>{{ block.src }}</code></span><button type="button" data-lift="pill" @click="retry"><Icon name="rotate-ccw" :size="14" />Try again</button></div>
    <p v-else class="ub-miss"><Icon name="image" :size="16" /><span>{{ block.alt || "A picture on the web" }}. The chat does not load pictures from other sites. <a :href="block.src" target="_blank" rel="noopener noreferrer">Open it in a new tab</a></span></p>
    <figcaption v-if="block.caption">{{ block.caption }}</figcaption>
    <FocusView v-if="pf.pic.value" :path="pf.pic.value.path" :image-src="pf.pic.value.src" :origin="pf.pic.value.origin" @close="pf.close" />
  </figure>
</template>

<style scoped>
.ub{min-width:0;margin:0;font-size:var(--fs,13.5px);line-height:1.5}
.ub h4{display:flex;align-items:baseline;gap:8px;margin:0;font:600 15px/1.35 var(--body)}
.ub-n{margin-left:auto;flex:none;color:var(--muted);font:500 11.5px/1 var(--mono);font-variant-numeric:tabular-nums}
.ub p{margin:0}

/* card: tone is a filled icon tile, a tint and the edge, never a coloured side stripe */
.ub-card,.ub-stats,.ub-table,.ub-list,.ub-steps,.ub-sec{--cd:#1e1e21;position:relative;isolation:isolate;border-radius:14px;background:var(--cd)}
:root[data-theme="light"] .ub-card,:root[data-theme="light"] .ub-stats,:root[data-theme="light"] .ub-table,:root[data-theme="light"] .ub-list,:root[data-theme="light"] .ub-steps,:root[data-theme="light"] .ub-sec{--cd:#fbfbfc}
:root[data-theme="light"] .ub-card{--cd:#fff}
.ub :deep(.cs){z-index:-1}
.ub-card{display:flex;gap:10px;align-items:flex-start;padding:11px 12px 11px 13px;font-size:14px}
.ub-cb{flex:1;display:grid;gap:1px}
.ub-card h4{color:var(--tt)}
.ub-card .ac-md{font-size:14px}
.t-ok{--tt:#a8e6cb}.t-info{--tt:#ccd5f8}.t-warn{--tt:#f7daa2}.t-bad{--tt:#f7acb1}
:root[data-theme="light"] .t-ok{--tt:#105a41}:root[data-theme="light"] .t-info{--tt:#2c4597}:root[data-theme="light"] .t-warn{--tt:#7f4f07}:root[data-theme="light"] .t-bad{--tt:#961d26}

/* stats: one ruled strip, the figure in the display face */
.ub-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}
.ub-stats > div{display:grid;align-content:start;gap:1px;padding:11px 14px}
.ub-stats > div + div{box-shadow:inset 1px 0 var(--hair,var(--line))}
.ub-stats dt{order:2;color:var(--ink);font-size:13px;font-weight:600;line-height:1.3}
.ub-stats dd{order:1;margin:0;font:600 24px/1.15 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em;overflow-wrap:anywhere}
.ub-stats p{order:3;color:var(--muted);font-size:12px;line-height:1.3}

.ub-ts{border-radius:14px;overflow-x:auto;overscroll-behavior-x:contain}
.ub-table td{font:12.5px/1.4 var(--mono)}
.ub-table table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.4}
.ub-table th,.ub-table td{padding:8px 14px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
.ub-table th{border-bottom:1px solid color-mix(in srgb,var(--ink) 10%,transparent);color:var(--muted);font-size:12.5px;font-weight:600;white-space:nowrap}
.ub-table tbody tr + tr > td{border-top:1px solid color-mix(in srgb,var(--ink) 5%,transparent)}
.ub-table .right{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}

.ub-list,.ub-steps{display:grid;gap:8px;padding:12px 14px 13px}
.ub-list ul,.ub-steps ol{display:grid;gap:4px;margin:0;padding:0;list-style:none}
.ub-list ul{font-size:13px}
.ub-list li{display:flex;gap:6px;align-items:flex-start}
.ub-box{flex:none;display:grid;place-items:center;width:16px;height:16px;margin-top:2px;color:var(--muted)}
.ub-list li.done .ub-box{color:var(--on)}
.ub-list li.done > span:last-child{color:var(--muted)}

.ub-choices{display:grid;gap:8px}
.ub-opts{display:flex;flex-wrap:wrap;gap:8px}
/* choices (canvas Blocks): a pill tinted in the owner's blue; the picked one fills with it */
.ub-choices > p:first-child{font-weight:600}
.ub-opts button{--pc:#1e1e21;display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border:0;border-radius:999px;background:color-mix(in srgb,var(--sel) 14%,var(--pc));color:var(--ink);font:600 13px/1.2 var(--body);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(90,169,255,.45),0 1px 2px rgba(0,0,0,.4),0 6px 12px -5px rgba(0,0,0,.5);transition:transform .16s cubic-bezier(.23,1,.32,1),background-color .15s var(--ease)}
:root[data-theme="light"] .ub-opts button{--pc:#fff;background:color-mix(in srgb,var(--sel) 9%,var(--pc));box-shadow:inset 0 0 0 1px rgba(31,111,214,.4),0 1px 2px rgba(22,22,26,.07),0 6px 12px -5px rgba(22,22,26,.14)}
.ub-opts button.on{background:var(--sel);color:#07172b;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.4),0 8px 16px -6px rgba(90,169,255,.55)}
:root[data-theme="light"] .ub-opts button.on{background:var(--sel);color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 1px 2px rgba(22,22,26,.12),0 8px 16px -6px rgba(31,111,214,.5)}
.ub-opts button:focus-visible,.ub-sh:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.ub-opts button:disabled{cursor:default}
.ub-choices.locked .ub-opts button:not(.on){background:transparent;color:var(--muted);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 14%,transparent)}
.ub-hint{color:var(--muted);font-size:12px}
/* press and hover (canvas Motion): pills .97, rise 1.5 px under a fine pointer */
[data-lift="pill"]:not(:disabled):active{transform:scale(.97)}
@media (hover:hover) and (pointer:fine){[data-lift="pill"]:not(:disabled):hover{transform:translateY(-1.5px)}[data-lift="pill"]:not(:disabled):active{transform:scale(.97)}.ub-sh:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}}

.ub-sh{display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:0 12px;border:0;border-radius:14px;background:none;color:var(--ink);font:600 14px/1.3 var(--body);text-align:left;cursor:pointer;transition:background-color .15s var(--ease)}
.ub-cv{color:var(--muted);transform:rotate(-90deg);transition:transform .22s cubic-bezier(.23,1,.32,1)}
.ub-sh[aria-expanded="true"] .ub-cv{transform:none}
.ub-fold{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .26s cubic-bezier(.23,1,.32,1),opacity .2s var(--ease)}
.ub-fold.open{grid-template-rows:1fr;opacity:1}
.ub-fold > div{overflow:hidden}
.ub-sb{padding:0 12px 12px;max-width:68ch;color:var(--muted);font-size:14px}

.ub-bar{height:4px;border-radius:2px;background:var(--track);overflow:hidden}
.ub-bar i{display:block;height:100%;background:var(--on);transform-origin:left;transition:transform .3s cubic-bezier(.23,1,.32,1)}
.ub-steps li{display:flex;gap:10px;align-items:flex-start}
.ub-dot{flex:none;display:grid;place-items:center;width:24px;height:24px;margin:-2px 0 0 -4px}
.ub-steps ol{gap:0}
.ub-steps li{position:relative;padding-bottom:10px}
.ub-steps li:last-child{padding-bottom:0}
.ub-steps li:not(:last-child)::before{content:"";position:absolute;left:8px;top:22px;bottom:-2px;width:2px;border-radius:1px;background:color-mix(in srgb,var(--ink) 14%,transparent)}
.s-todo .ub-st,.s-done .ub-st{color:var(--muted)}
.s-failed .ub-st{color:var(--bad)}
.s-active .ub-st{font-weight:600}
.ub-st{display:grid;gap:1px}
.ub-st small{color:var(--muted);font-size:12px;font-weight:400}

.ub-img{display:grid;gap:6px;justify-items:start}
.ub-img a{display:block;max-width:100%;border-radius:12px}
.ub-img a:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.ub-img img{display:block;max-width:100%;max-height:420px;border:1px solid var(--hair,var(--line));border-radius:12px;background:var(--panel-2)}
.ub-img figcaption{color:var(--muted);font-size:12px}
.ub-img:has(.ub-fail){justify-items:stretch}
.ub-fail{position:relative;display:grid;gap:8px;justify-items:center;align-content:center;aspect-ratio:16/9;padding:12px;border-radius:14px;background:var(--panel-2,var(--panel));color:var(--muted);font-size:13px;text-align:center;box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 9%,transparent),0 1px 2px rgba(0,0,0,.3)}
.ub-fail code{font:500 .9em var(--mono);overflow-wrap:anywhere}
.ub-fail button{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border:0;border-radius:999px;background:var(--cd,var(--panel));color:var(--ink);font:600 13px var(--body);cursor:pointer;box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 10%,transparent),0 1px 2px rgba(0,0,0,.3);transition:transform .16s cubic-bezier(.23,1,.32,1)}
.ub-fail button:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.ub-miss{display:flex;align-items:center;gap:7px;padding:10px 12px;border:1px dashed var(--hair,var(--line));border-radius:12px;color:var(--muted);font-size:12.5px}
.ub-miss a{color:var(--sel)}
@media (prefers-reduced-motion:reduce){.ub-fold,.ub-cv,.ub-bar i,.ub-opts button,.ub-sh,.ub-fail button{transition:none}[data-lift]:hover,[data-lift]:active{transform:none!important}}
</style>
