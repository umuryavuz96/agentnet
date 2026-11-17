<script setup lang="ts">
// One chat body: agent or owner text as safe markdown (web/src/md.ts). A body taller than about 16 lines folds to about 12 with
// "Show more". Fenced code has a Copy button (works on plain http too). The parent owns the open state so it survives re-renders.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { renderMd } from "../md";

const props = defineProps<{ text: string; open: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const FOLD = 236, SLACK = 84;
const html = computed(() => renderMd(props.text));
const inner = ref<HTMLElement | null>(null);
const full = ref(0);
const long = computed(() => full.value > FOLD + SLACK);
let ro: ResizeObserver | null = null;
onMounted(() => {
  const el = inner.value;
  if (!el) return;
  full.value = el.offsetHeight;
  ro = new ResizeObserver(() => { full.value = el.offsetHeight; });
  ro.observe(el);
});
onBeforeUnmount(() => ro?.disconnect());

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
async function onClick(e: MouseEvent) {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".md-copy");
  if (!b) return;
  const code = b.closest(".md-code")?.querySelector("code")?.textContent ?? "";
  b.textContent = (await copy(code)) ? "Copied" : "Copy failed";
  setTimeout(() => { b.textContent = "Copy"; }, 1600);
}
</script>

<template>
  <div :class="['cb', { long, open }]">
    <div class="cb-clip" :style="long ? { maxHeight: (open ? full : FOLD) + 'px' } : undefined">
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized in md.ts -->
      <div ref="inner" class="ac-md" @click="onClick" v-html="html" />
    </div>
    <button v-if="long" type="button" class="cb-more" :aria-expanded="open" @click="emit('toggle')">{{ open ? "Show less" : "Show more" }}<Icon name="chevron-down" :size="14" /></button>
  </div>
</template>

<style scoped>
.cb{display:grid;grid-template-columns:minmax(0,1fr);min-width:0}
.cb-clip{min-width:0;overflow:hidden;transition:max-height .3s cubic-bezier(.2,.8,.2,1)}
.cb.long:not(.open) .cb-clip{-webkit-mask-image:linear-gradient(#000 calc(100% - 44px),transparent);mask-image:linear-gradient(#000 calc(100% - 44px),transparent)}
.cb-more{justify-self:start;display:inline-flex;align-items:center;gap:4px;min-height:28px;margin-top:4px;padding:0 9px 0 10px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);letter-spacing:.01em;cursor:pointer;transition:background-color .15s var(--ease)}
.cb-more:hover{background:color-mix(in srgb,var(--ink) 8%,transparent)}
.cb-more:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.cb-more .icon{transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.cb.open .cb-more .icon{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.cb-clip,.cb-more,.cb-more .icon{transition:none}}
</style>

<style>
/* Rendered markdown (v-html, so not scoped). */
.ac-md{min-width:0;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.ac-md :where(p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,hr){margin:0}
.ac-md > * + *{margin-top:.65em}
.ac-md h1,.ac-md h2,.ac-md h3,.ac-md h4,.ac-md h5,.ac-md h6{font-family:var(--body);font-weight:650;line-height:1.3}
.ac-md h1,.ac-md h2{font-size:15.5px}
.ac-md h3{font-size:14.5px}
.ac-md h4,.ac-md h5,.ac-md h6{font-size:13.5px}
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
.ac-md hr{height:0;border:0;border-top:1px solid var(--line)}
.ac-md code{padding:1px 5px;border-radius:5px;background:color-mix(in srgb,var(--ink) 9%,transparent);font:500 12px/1.4 var(--mono)}
.ac-md .md-code{border:1px solid var(--line);border-radius:10px;background:var(--panel-2);overflow:hidden}
.ac-md .md-ch{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;padding:0 4px 0 11px;border-bottom:1px solid var(--line);color:var(--muted);font:500 11px/1 var(--mono);letter-spacing:.02em}
.ac-md .md-copy{min-width:52px;min-height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--muted);font:600 11.5px/1 var(--body);letter-spacing:.02em;cursor:pointer;transition:background-color .15s var(--ease),color .15s var(--ease)}
.ac-md .md-copy:hover{background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--ink)}
.ac-md .md-copy:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ac-md pre{padding:9px 11px;max-height:340px;overflow:auto;overscroll-behavior-x:contain}
.ac-md pre code{padding:0;border-radius:0;background:none;font:500 12px/1.55 var(--mono);white-space:pre;overflow-wrap:normal}
.ac-md .md-table{width:fit-content;max-width:100%;border:1px solid var(--line);border-radius:10px;overflow-x:auto;overscroll-behavior-x:contain}
.ac-md table{width:max-content;border-collapse:collapse;font-size:12.5px;line-height:1.4}
.ac-md th,.ac-md td{max-width:30ch;padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:break-word}
.ac-md th{background:color-mix(in srgb,var(--ink) 6%,transparent);font-weight:650;white-space:nowrap}
.ac-md tr:last-child > td{border-bottom:0}
.ac-md th[align="center"],.ac-md td[align="center"]{text-align:center}
.ac-md th[align="right"],.ac-md td[align="right"]{text-align:right;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion:reduce){.ac-md .md-copy{transition:none}}
</style>
