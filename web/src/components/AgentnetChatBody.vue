<script setup lang="ts">
// One chat body: agent or owner text as safe markdown (web/src/md.ts), with the agent's ```ui fences drawn as real blocks
// (web/src/chatBlocks.ts, ChatBlock.vue; `blocks` turns that on, so the owner's own text never becomes a block).
// Blocks that come one after another sit in one group: the small ones (card, stats, checklist, steps) go two across when the
// lane is wide enough, the others take the full row.
// A `ui-html` fence runs as live UI in a sandboxed frame (ChatSandbox.vue).
// With `fold`, a body taller than about 16 lines folds to about 12 with "Show more". Fenced code has a Copy button (works on
// plain http too). The parent owns the open state so it survives re-renders.
import { computed, h, onBeforeUnmount, onMounted, onUpdated, ref, render } from "vue";
import Icon from "../ui/Icon.vue";
import ChatBlock from "./ChatBlock.vue";
import FocusView from "./chat/FocusView.vue";
import ChatSandbox from "./ChatSandbox.vue";
import "./chat/chatText.css";
import { renderMd } from "../md";
import AgentMention from "./chat/AgentMention.vue";
import { mentionNames } from "../mentionNames";
import { checkFileChips } from "../chatMarkers";
import { fileUrl } from "./chat/fileApi";
import { parsePathRef, splitBlocks, type Segment } from "../chatBlocks";

const props = defineProps<{ text: string; open: boolean; fold?: boolean; blocks?: boolean; answer?: string | null; canSend?: boolean; /** who wrote it: named on a live-UI frame */ from?: string }>();
const emit = defineEmits<{ toggle: []; pick: [text: string]; edit: [text: string] }>();
const FOLD = 236, SLACK = 84;
const parts = computed<Segment[]>(() => {
  if (!props.blocks) return [{ kind: "md", text: props.text }];
  const out: Segment[] = [];
  for (const p of splitBlocks(props.text)) {
    const last = out[out.length - 1];
    if (p.kind === "md" && !p.text.trim()) continue;
    if (p.kind === "ui" && last?.kind === "ui") last.blocks.push(...p.blocks); else out.push(p.kind === "ui" ? { kind: "ui", blocks: [...p.blocks] } : p);
  }
  return out;
});
const SMALL = new Set(["card", "stats", "checklist", "steps"]);
/** Which blocks of a group take the full row: the large types, and a small one left without a neighbour. */
function fullRow(blocks: { type: string }[]): boolean[] {
  const out = blocks.map((b) => !SMALL.has(b.type));
  for (let i = 0, run = 0; i <= blocks.length; i++) {
    if (i < blocks.length && !out[i]) { run++; continue; }
    if (run % 2) out[i - 1] = true;
    run = 0;
  }
  return out;
}
const inner = ref<HTMLElement | null>(null);
const full = ref(0);
const long = computed(() => !!props.fold && full.value > FOLD + SLACK);
let ro: ResizeObserver | null = null;
// A path in the text is plain code until the service has the file under the agent's folder (chatMarkers.ts checkFileChips).
const probe = (path: string) => fetch(fileUrl(props.from!, path) + "&lines=1&probe=1").then((r) => (r.ok ? r.json() : null)).then((j) => !!j?.found);
const checkPaths = () => { if (props.from && inner.value) checkFileChips(inner.value, props.from, probe); };
// Agent names in the text (agentMention.ts placeholders) get the live chip mounted in place. The v-html re-render on a feed
// frame drops a placeholder: its chip is unmounted on the next update, so no watcher outlives its text.
const chips = new Set<HTMLElement>();
function mountChips() {
  for (const el of chips) if (!el.isConnected) { render(null, el); chips.delete(el); }
  if (!inner.value) return;
  for (const el of inner.value.querySelectorAll<HTMLElement>("span.cx-agm[data-ag]:not([data-m])")) {
    el.dataset.m = ""; el.textContent = "";
    render(h(AgentMention, { name: el.dataset.ag! }), el);
    chips.add(el);
  }
}
onUpdated(() => { checkPaths(); mountChips(); });
onMounted(() => {
  checkPaths(); mountChips();
  const el = inner.value;
  if (!el) return;
  full.value = el.offsetHeight;
  ro = new ResizeObserver(() => { full.value = el.offsetHeight; });
  ro.observe(el);
});
onBeforeUnmount(() => { ro?.disconnect(); for (const el of chips) render(null, el); chips.clear(); });

async function copy(text: string): Promise<boolean> {
  try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch { /* blocked: try the old way */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}
const focus = ref<{ path: string; lines?: string; origin: { x: number; y: number; w: number; h: number } } | null>(null);
async function onClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>("[data-path]"), ref0 = chip ? parsePathRef(chip.dataset.path ?? "") : null;
  if (chip && ref0 && props.from) { const r = chip.getBoundingClientRect(); focus.value = { ...ref0, origin: { x: r.left, y: r.top, w: r.width, h: r.height } }; return; }
  const more = t.closest<HTMLButtonElement>(".md-more");
  if (more) {
    const box = more.closest(".md-code");
    const n = box?.querySelectorAll(".cx-ln").length ?? 0;
    const open = box?.classList.toggle("open");
    const label = more.querySelector("span");
    if (label) label.textContent = open ? "Show less" : `Show all ${n} lines`;
    return;
  }
  const b = t.closest<HTMLButtonElement>(".md-copy");
  if (!b) return;
  const code = b.closest(".md-code")?.querySelector("code")?.textContent ?? "";
  const label = b.querySelector("span");
  const ok = await copy(code);
  if (label) label.textContent = ok ? "Copied" : "Copy failed";
  b.classList.toggle("ok", ok);
  setTimeout(() => { if (label) label.textContent = "Copy"; b.classList.remove("ok"); }, 2000);
}
</script>

<template>
  <div :class="['cb', { long, open }]">
    <div class="cb-clip" :style="long ? { maxHeight: (open ? full : FOLD) + 'px' } : undefined">
      <div ref="inner" class="cb-parts" @click="onClick">
        <template v-for="(p, i) in parts" :key="i">
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized in md.ts -->
          <div v-if="p.kind === 'md'" class="ac-md" v-html="renderMd(p.text, mentionNames)" />
          <ChatSandbox v-else-if="p.kind === 'html'" :html="p.html" :answer="answer" :can-send="canSend" :from="from" @pick="(t) => emit('pick', t)" />
          <div v-else class="cb-ui">
            <ChatBlock v-for="(b, j) in p.blocks" :key="i + ':' + j" :class="{ 'cb-full': fullRow(p.blocks)[j] }" :block="b" :answer="answer" :can-send="canSend" :from="from" @pick="(t) => emit('pick', t)" @edit="(t) => emit('edit', t)" />
          </div>
        </template>
      </div>
    </div>
    <FocusView v-if="focus" :path="focus.path" :lines="focus.lines" :from="from" :origin="focus.origin" @close="focus = null" />
    <button v-if="long" type="button" class="cb-more" :aria-expanded="open" @click="emit('toggle')">{{ open ? "Show less" : "Show more" }}<Icon name="chevron-down" :size="14" /></button>
  </div>
</template>

<style scoped>
.cb{display:grid;grid-template-columns:minmax(0,1fr);min-width:0}
.cb-parts{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0}
.cb-ui{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:10px;align-items:start;min-width:0}
.cb-ui > .cb-full{grid-column:1/-1}
.cb.long .cb-clip{overflow:hidden}
.cb-clip{min-width:0;transition:max-height .3s cubic-bezier(.2,.8,.2,1)}
/* the folded long body is an inner scroll (no bar): its rest is reachable, so it is not cut text; Show more opens it */
.cb.long:not(.open) .cb-clip{overflow-x:hidden;overflow-y:auto;scrollbar-width:none}
.cb.long:not(.open) .cb-clip::-webkit-scrollbar{display:none}
.cb.long:not(.open) .cb-clip{-webkit-mask-image:linear-gradient(#000 calc(100% - 44px),transparent);mask-image:linear-gradient(#000 calc(100% - 44px),transparent)}
.cb-more{justify-self:start;display:inline-flex;align-items:center;gap:4px;min-height:28px;margin-top:4px;padding:0 9px 0 10px;border:1px solid var(--hair,var(--line));border-radius:999px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);letter-spacing:.01em;cursor:pointer;transition:background-color .15s var(--ease)}
.cb-more:hover{background:color-mix(in srgb,var(--ink) 8%,transparent)}
.cb-more:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.cb-more .icon{transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.cb.open .cb-more .icon{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.cb-clip,.cb-more,.cb-more .icon{transition:none}}
</style>

<style>
/* Rendered markdown (v-html, so not scoped). */
.ac-md{min-width:0;font-size:var(--fs,13.5px);line-height:1.55;overflow-wrap:anywhere}
.ac-md :where(p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr){margin:0}
.ac-md > * + *{margin-top:.65em}
.ac-md h1,.ac-md h2,.ac-md h3,.ac-md h4,.ac-md h5,.ac-md h6{font-family:var(--body);font-weight:650;line-height:1.3}
.ac-md h1,.ac-md h2{font-size:1.15em}
.ac-md h3{font-size:1.07em}
.ac-md h4,.ac-md h5,.ac-md h6{font-size:1em}
.ac-md > * + h1,.ac-md > * + h2,.ac-md > * + h3,.ac-md > * + h4{margin-top:1em}
.ac-md strong{font-weight:650}
.ac-md a{color:var(--sel);text-decoration:underline;text-underline-offset:2px}
.ac-md a:focus-visible{outline:2px solid var(--on);outline-offset:1px;border-radius:3px}
.ac-md ul,.ac-md ol{padding-left:1.35em}
.ac-md li + li,.ac-md li > ul,.ac-md li > ol{margin-top:.2em}
.ac-md li > p + p{margin-top:.4em}
.ac-md li:has(> .md-cb),.ac-md li:has(> p:first-child > .md-cb){list-style:none;margin-left:-1.35em;padding-left:0}
.ac-md .md-cb{display:inline-block;position:relative;width:14px;height:14px;margin-right:4px;vertical-align:-2px;border:1.5px solid var(--muted);border-radius:4px}
.ac-md .md-cb.on{border-color:var(--on);background:var(--on)}
.ac-md .md-cb.on::after{content:"";position:absolute;left:3.5px;top:.5px;width:3.5px;height:7px;border:solid var(--panel);border-width:0 1.8px 1.8px 0;transform:rotate(45deg)}
.ac-md blockquote{padding:1px 0 1px 10px;border-left:2px solid color-mix(in srgb,var(--ink) 28%,transparent);color:var(--muted)}
.ac-md blockquote > * + *{margin-top:.5em}
.ac-md hr{height:0;border:0;border-top:1px solid var(--hair,var(--line))}
.ac-md code{padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--ink) 11%,transparent);font:500 .89em/1.4 var(--mono)}
.ac-md .md-copy{border:0;background:transparent;color:var(--muted);font:600 12px/1 var(--body);padding:0 8px;cursor:pointer;transition:background-color .15s var(--ease),color .15s var(--ease)}
.ac-md .md-copy:hover{background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--ink)}
.ac-md .md-copy:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ac-md .md-ch{display:flex;align-items:center;justify-content:space-between}
.ac-md pre{padding:9px 11px;max-height:340px;overflow:auto;overscroll-behavior-x:contain}
.ac-md pre code{padding:0;border-radius:0;background:none;font:500 .87em/1.55 var(--mono);white-space:pre;overflow-wrap:normal}
.ac-md .md-table{width:fit-content;max-width:100%;border:1px solid var(--hair,var(--line));border-radius:10px;overflow-x:auto;overscroll-behavior-x:contain}
.ac-md table{width:max-content;border-collapse:collapse;font-size:.93em;line-height:1.4}
.ac-md th,.ac-md td{max-width:30ch;padding:6px 10px;border-bottom:1px solid var(--hair,var(--line));text-align:left;vertical-align:top;overflow-wrap:break-word}
.ac-md th{background:color-mix(in srgb,var(--ink) 10%,transparent);font-weight:650;white-space:nowrap}
.ac-md tr:last-child > td{border-bottom:0}
.ac-md th[align="center"],.ac-md td[align="center"]{text-align:center}
.ac-md th[align="right"],.ac-md td[align="right"]{text-align:right;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.ac-md .md-copy{transition:none}}
</style>
