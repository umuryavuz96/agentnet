<script setup lang="ts">
// The body of the chat's step panel: what one tool call was given and what came back. A Write shows the file it wrote with
// line numbers, an Edit or MultiEdit the old and new text as a small diff; both carry a chip for the file that opens the
// focus view (the file as it is now, from the service). Any other call shows its input above its output.
import { computed, ref } from "vue";
import FocusView from "./FocusView.vue";
import ToolTile from "./ToolTile.vue";
import { esc, hlLine } from "../../chatMarkers";
import type { FeedItem } from "../../chatFeed";

const props = defineProps<{ item: FeedItem; agent: string }>();

const file = computed(() => props.item.file ?? null);
const ext = computed(() => (file.value?.path.split(".").pop() ?? "").toLowerCase());
const name = computed(() => { const p = file.value?.path ?? ""; return p.slice(p.lastIndexOf("/") + 1); });
const dir = computed(() => { const p = file.value?.path ?? "", i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : ""; });
const lines = (s: string) => s.replace(/\n$/, "").split("\n");
// Code colours only for code files: prose (.md, .txt) and unknown types read as plain text, or "of" and "in" light up as keywords.
const CODE = new Set("ts tsx js jsx mjs cjs vue json jsonl css scss html sh bash zsh py rs go swift sql yaml yml toml rb kt java c h cpp".split(" "));
const code = computed(() => (file.value?.content !== undefined ? lines(file.value.content).map((l) => (CODE.has(ext.value) ? hlLine(l, ext.value) : esc(l))) : null));
const gutter = computed(() => String(code.value?.length ?? 1).length);
// One block per edit: the removed lines, then the added ones. An edit with no old text (a notebook cell) is only added lines.
const diff = computed(() => (file.value?.edits ?? []).map((e) => [
  ...(e.old ? lines(e.old).map((t) => ({ t, k: "del" as const })) : []),
  ...(e.new ? lines(e.new).map((t) => ({ t, k: "add" as const })) : []),
]));
const counts = computed(() => diff.value.flat().reduce((c, l) => (c[l.k]++, c), { add: 0, del: 0 }));

const chip = ref<HTMLElement | null>(null);
const open = ref(false), origin = ref<{ x: number; y: number; w: number; h: number } | null>(null);
function show() { const r = chip.value?.getBoundingClientRect(); origin.value = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; open.value = true; }
</script>

<template>
  <div class="sd">
    <template v-if="file">
      <button ref="chip" type="button" class="sd-chip" :title="`Open ${file.path}`" @click="show">
        <ToolTile kind="edit" icon="file-code" /><span class="sd-fn"><b>{{ name }}</b><small v-if="dir">{{ dir }}</small></span>
        <span v-if="diff.length" class="sd-ct"><i class="add">+{{ counts.add }}</i><i class="del">−{{ counts.del }}</i></span>
      </button>
      <small class="sd-lb">{{ code ? "Wrote" : "Changed" }}</small>
      <pre v-if="code" class="sd-code" tabindex="0" aria-label="What the step wrote"><span v-for="(l, i) in code" :key="i" class="sd-l"><span class="sd-n" :style="{ width: gutter + 'ch' }">{{ i + 1 }}</span><!-- eslint-disable-next-line vue/no-v-html -- escaped in hlLine --><span class="sd-t" v-html="l || ' '" /></span></pre>
      <div v-else class="sd-code sd-diff" tabindex="0" aria-label="What the step changed">
        <pre v-for="(d, j) in diff" :key="j"><span v-for="(l, i) in d" :key="i" :class="['sd-l', l.k]"><span class="sd-m" aria-hidden="true">{{ l.k === "add" ? "+" : "−" }}</span><span class="sd-t"><span class="sr">{{ l.k === "add" ? "added" : "removed" }} </span>{{ l.t || " " }}</span></span></pre>
      </div>
      <template v-if="item.out"><small class="sd-lb">Output</small><pre class="sd-out fix" tabindex="0">{{ item.out }}</pre></template>
      <FocusView v-if="open" :path="file.path" :from="agent" :origin="origin" @close="open = false" />
    </template>
    <template v-else>
      <template v-if="item.inp"><small class="sd-lb">Input</small><pre class="sd-in" tabindex="0">{{ item.inp }}</pre></template>
      <template v-if="item.out"><small class="sd-lb">Output</small><pre class="sd-out grow" tabindex="0">{{ item.out }}</pre></template>
      <p v-if="!item.out && !item.inp" class="sd-none">This step has no output yet.</p>
    </template>
  </div>
</template>

<style scoped>
.sd{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px}
.sd-lb{flex:none;margin-top:4px;color:var(--muted);font:650 11px/1 var(--body);letter-spacing:.06em;text-transform:uppercase}
.sd-chip{flex:none;display:flex;align-items:center;gap:10px;min-height:48px;padding:6px 12px 6px 8px;border:1px solid var(--hair);border-radius:12px;background:transparent;color:var(--ink);text-align:left;cursor:pointer;transition:background-color .2s var(--e-hv,ease)}
.sd-chip:hover{background:var(--soft)}
.sd-chip:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
.sd-fn{flex:1;min-width:0;display:grid;gap:2px}
.sd-fn b{font:600 13px/1.3 var(--mono);overflow-wrap:anywhere}
.sd-fn small{color:var(--muted);font:500 11.5px/1.3 var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.sd-ct{flex:none;display:flex;gap:6px;font:600 12px/1 var(--mono)}
.sd-ct i{font-style:normal}
.add{--c:var(--on,#3fb950)}.del{--c:var(--bad,#f85149)}
.sd-ct .add,.sd-ct .del{color:var(--c)}
pre{margin:0;font:500 12.5px/1.55 var(--mono);tab-size:2}
.sd-code{flex:0 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;padding:10px 0;border-radius:12px;background:var(--soft);color:var(--ink)}
.sd-code:focus-visible,.sd-in:focus-visible,.sd-out:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
.sd-diff{display:grid;gap:10px}
/* long lines wrap; the number (or the +/- mark) stays on the first row and the wrapped rows keep to the text column */
.sd-l{display:grid;grid-template-columns:auto minmax(0,1fr);padding:0 14px 0 0}
.sd-t{white-space:pre-wrap;overflow-wrap:anywhere}
.sd-n{box-sizing:content-box;padding:0 12px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;user-select:none}
.sd-l.add,.sd-l.del{background:color-mix(in srgb,var(--c) 14%,transparent);box-shadow:inset 3px 0 0 var(--c)}
.sd-m{width:2.2ch;padding-left:10px;color:var(--c);user-select:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.sd-in,.sd-out{flex:0 1 auto;min-height:0;padding:12px 14px;overflow:auto;overscroll-behavior:contain;border-radius:12px;background:var(--soft);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
.sd-in{max-height:38%}
.sd-out.grow{flex:1 1 auto}
/* under a written file the output is a short note: it keeps its height (up to a quarter) and the code gives way */
.sd-out.fix{flex:none;max-height:25%}
.sd-none{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5}
</style>
