<script setup lang="ts">
// The focus view (canvas Files, "Focus view, open"): one file or picture read large, in a dialog that grows out of the card
// it was opened from (260 ms in, 180 ms out; transform and opacity only). Focus is trapped, Esc and Close return it to the card.
// The lines the agent named are marked; code gets the reply's syntax colours. Reduced motion: no grow, the view just appears.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "../../ui/Icon.vue";
import ToolTile from "./ToolTile.vue";
import { loadFile } from "./fileApi";
import { hlLine } from "../../chatMarkers";

const props = defineProps<{ path: string; lines?: string; content?: string; from?: string; imageSrc?: string | null; origin?: { x: number; y: number; w: number; h: number } | null }>();
const emit = defineEmits<{ close: [] }>();

const LANG: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", vue: "Vue", json: "JSON", jsonl: "JSON lines", md: "Markdown", mdx: "Markdown", css: "CSS", scss: "SCSS", html: "HTML", yaml: "YAML", yml: "YAML", toml: "TOML", sh: "Shell", zsh: "Shell", py: "Python", rs: "Rust", go: "Go", swift: "Swift", sql: "SQL" };
const ext = computed(() => (props.path.split(".").pop() ?? "").toLowerCase());
const text = ref<string | undefined>(props.content);
const miss = ref(false);
const rows = computed(() => (text.value ?? "").replace(/\n$/, "").split("\n"));
const mark = computed<[number, number] | null>(() => { const m = /^(\d+)(?:-(\d+))?$/.exec(props.lines ?? ""); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null; });
const marked = (n: number) => !!mark.value && n >= mark.value[0] && n <= mark.value[1];
// The same three syntax colours as the code block in the reply (chatMarkers hlLine: keyword, string, comment).
const hl = computed(() => rows.value.map((l) => hlLine(l, ext.value)));
const gutter = computed(() => String(rows.value.length).length);

const root = ref<HTMLElement | null>(null), dlg = ref<HTMLElement | null>(null), body = ref<HTMLElement | null>(null), closeBtn = ref<HTMLButtonElement | null>(null);
const leaving = ref(false);
// A picture waits for its first decoded frame before the view shows and grows, so the grow starts at the picture's real
// size (no blank or jumping frame). The thumbnail already loaded the same URL, so this is the browser cache.
const waiting = ref(!!props.imageSrc);
const img = ref<HTMLImageElement | null>(null);
const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
let opener: Element | null = null;

// The dialog starts at the card's place and size (FLIP): the first frame is the card, the last is the view.
function grow() {
  const d = dlg.value, o = props.origin;
  if (!d || !o || reduce) return;
  const r = d.getBoundingClientRect();
  const sx = Math.max(.2, o.w / r.width), sy = Math.max(.2, o.h / r.height);
  const dx = o.x + o.w / 2 - (r.left + r.width / 2), dy = o.y + o.h / 2 - (r.top + r.height / 2);
  d.animate([{ transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, opacity: .4 }, { transform: "none", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.23,1,.32,1)" });
}
function close() {
  if (leaving.value) return;
  leaving.value = true;
  const d = dlg.value;
  const done = () => { emit("close"); (opener as HTMLElement | null)?.focus?.({ preventScroll: true }); };
  if (!d || reduce) return done();
  const o = props.origin, r = d.getBoundingClientRect();
  const to = o ? `translate(${o.x + o.w / 2 - (r.left + r.width / 2)}px,${o.y + o.h / 2 - (r.top + r.height / 2)}px) scale(${Math.max(.2, o.w / r.width)},${Math.max(.2, o.h / r.height)})` : "scale(.97)";
  d.animate([{ transform: "none", opacity: 1 }, { transform: to, opacity: 0 }], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).onfinish = done;
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab" || !dlg.value) return;
  const f = [...dlg.value.querySelectorAll<HTMLElement>("button,[tabindex='0'],a[href]")].filter((x) => !x.hasAttribute("disabled"));
  if (!f.length) return;
  const first = f[0]!, last = f[f.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
onMounted(async () => {
  if (text.value === undefined && !props.imageSrc && props.from) loadFile(props.from, props.path).then((r) => { text.value = r.text; nextTick(jump); }, () => { miss.value = true; });
  opener = document.activeElement;
  document.documentElement.style.overflow = "hidden";
  await nextTick();
  if (waiting.value) {
    await Promise.race([img.value?.decode().catch(() => {}), new Promise((ok) => setTimeout(ok, 400))]);
    waiting.value = false;
    await nextTick();
  }
  grow();
  closeBtn.value?.focus({ preventScroll: true });
  jump();
});
function jump() {
  const first = body.value?.querySelector<HTMLElement>("[data-mark]");
  if (first && body.value) body.value.scrollTop = Math.max(0, first.offsetTop - 60);
}
onBeforeUnmount(() => { document.documentElement.style.overflow = ""; });
</script>

<template>
  <Teleport to="body">
    <div ref="root" :class="['fv', { leaving, wait: waiting }]" @keydown="key">
      <div class="fv-scrim" @click="close" />
      <div ref="dlg" :class="['fv-dlg', { pic: imageSrc }]" role="dialog" aria-modal="true" :aria-label="path">
        <div class="fv-head">
          <ToolTile :kind="imageSrc ? 'image' : 'read'" :icon="imageSrc ? 'image' : 'file-code'" />
          <span class="fv-path" :title="imageSrc ? path : undefined">{{ imageSrc ? path.slice(path.lastIndexOf("/") + 1) : path }}</span>
          <span v-if="lines" class="fv-lines">{{ lines.includes("-") ? "lines " + lines.replace("-", " to ") : "line " + lines }}</span>
          <button ref="closeBtn" type="button" class="fv-x" aria-label="Close" @click="close"><Icon name="x" :size="14" /><span>Close</span></button>
        </div>
        <div ref="body" class="fv-body" tabindex="0">
          <img v-if="imageSrc" ref="img" :src="imageSrc" :alt="path" class="fv-img">
          <pre v-else-if="text !== undefined"><span v-for="(l, i) in rows" :key="i" :class="['fv-l', { hit: marked(i + 1) }]" :data-mark="marked(i + 1) && !marked(i) ? '' : undefined"><span class="fv-n" :style="{ width: gutter + 2 + 'ch' }">{{ i + 1 }}</span><!-- eslint-disable-next-line vue/no-v-html -- escaped in hlLine --><span v-html="hl[i] || ' '" /></span></pre>
          <p v-else-if="miss || !from" class="fv-none">No preview here. The path is <code>{{ path }}</code>.</p>
        </div>
        <div class="fv-foot"><span>{{ LANG[ext] ?? ext.toUpperCase() }}</span><span v-if="text !== undefined">{{ rows.length }} lines</span><span>Esc closes</span></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fv{--cd:#1e1e21;--hair:rgba(255,255,255,.1);position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px}
.fv-scrim{position:absolute;inset:0;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);animation:fv-in .2s var(--ease) both}
:root[data-theme="light"] .fv-scrim{background:rgba(22,22,26,.4)}
.fv.leaving .fv-scrim{opacity:0;transition:opacity .18s var(--ease);animation:none}
.fv-dlg{position:relative;display:flex;flex-direction:column;width:min(1100px,100%);max-height:100%;min-height:0;border-radius:16px;background:var(--cd,var(--panel));overflow:hidden;box-shadow:0 0 0 .75px rgba(255,255,255,.12),inset 0 1px 0 rgba(255,255,255,.08),0 12px 24px -8px rgba(0,0,0,.55),0 40px 80px -24px rgba(0,0,0,.75)}
:root[data-theme="light"] .fv-dlg{box-shadow:0 0 0 .75px rgba(22,22,26,.1),0 12px 24px -8px rgba(22,22,26,.2),0 40px 80px -24px rgba(22,22,26,.3)}
.fv-head{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 8px 0 14px;border-bottom:1px solid var(--hair);flex-wrap:wrap}
.fv-path{flex:1;min-width:0;font:500 12.5px/1.3 var(--mono);overflow-wrap:anywhere}
.fv-lines{flex:none;padding:0 8px;border-radius:999px;background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--muted);font:500 11.5px/20px var(--mono)}
.fv-x{display:inline-flex;align-items:center;gap:5px;min-height:44px;padding:0 10px;border:0;border-radius:7px;background:none;color:var(--muted);font:600 12px var(--body);cursor:pointer}
.fv-x:focus-visible{outline:2px solid var(--sel);outline-offset:-2px}
.fv-body{flex:1;min-height:0;overflow:auto;background:var(--panel-2,var(--panel));overscroll-behavior:contain}
.fv-body:focus-visible{outline:2px solid var(--sel);outline-offset:-2px}
pre{margin:0;padding:10px 0;font:500 12.5px/1.6 var(--mono);tab-size:2;min-width:max-content}
.fv-l{display:block;white-space:pre;padding:0 14px 0 0}
.fv-n{display:inline-block;box-sizing:content-box;padding-right:12px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;user-select:none}
.fv-l.hit{background:color-mix(in srgb,var(--lock) 22%,transparent);box-shadow:inset 3px 0 0 var(--lock)}
.fv-img{display:block;max-width:100%;max-height:calc(100vh - 160px);margin:0 auto;object-fit:contain}
/* A picture: the view is as wide as the picture, at most about 90 % of the window each way, never past its natural size. */
.fv-dlg.pic{width:min-content;min-width:min(320px,100%);max-width:90vw;max-height:90vh}
.fv-dlg.pic .fv-body{display:grid;place-items:center;overflow:hidden}
.fv-dlg.pic .fv-img{max-width:calc(90vw - 2px);max-height:calc(90vh - 90px)}
.fv.wait .fv-dlg{opacity:0}
.fv-none{margin:0;padding:24px 16px;color:var(--muted);font-size:13px}
.fv-foot{display:flex;gap:12px;padding:8px 14px;border-top:1px solid var(--hair);color:var(--muted);font:500 11.5px/1.3 var(--mono)}
@keyframes fv-in{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.fv-scrim{animation:none}}
:root[data-theme="light"] .fv{--cd:#fbfbfc;--hair:rgba(0,0,0,.09)}
</style>
