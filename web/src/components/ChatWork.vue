<script setup lang="ts">
// The inside of one work run in the chat, drawn as the canvas's open trail: the plan steps are nodes on a thin rail
// (RailNode), the calls of each step are rows on its branch, a ToolTile per kind of tool says what it was. A finished
// step folds to its proof chips; the step with the work shows its calls. A row with output opens to its Out box; a failed
// row is red and opens by itself. A step that read an image shows the picture, tap opens it large.
// A thought whose text the transcript did not keep is not a row (the run's summary counts it). The text is already
// redacted by the feed (src/net/feed.ts). A click opens a row in place; in the large chat a step's open body has a button
// at its far right that shows it in the side panel beside the conversation.
// On a plan (canvas Trail, open) the rail is one line at one x: it runs through the step nodes, bends out with an S-curve to
// the open step's calls and back in to the next node. Calls outside every step sit first, under "Before the plan".
// When a step finishes, the canvas Motion plays: the tick uncovers, the rail fills down, a light runs to the next node, that
// node grows, its rows come in 30 ms apart. Transform and opacity only; nothing moves with reduced motion.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import RailNode from "./chat/RailNode.vue";
import ToolTile, { type ToolKind } from "./chat/ToolTile.vue";
import Chip from "./chat/Chip.vue";
import { railSteps, type CallGroup, type FeedItem, type PlanBit } from "../chatFeed";
import { url } from "../ui/api";
import FocusView from "./chat/FocusView.vue";
import { usePicFocus } from "./chat/picFocus";

const props = defineProps<{ items: FeedItem[]; pick?: boolean; picked?: string | null; /** the agent: a step that read an image shows it, asked for in its name */ agent?: string; /** the plan steps, to group the calls under */ plan?: PlanBit[]; /** the run before ended in this run's first step: no header for it, the rail goes on */ cont?: boolean; /** draw the plan's next nodes after the last step (off when a later run goes on in it) */ tail?: boolean; /** a row a reference chip asked for: its step and the row open */ show?: string | null }>();
const emit = defineEmits<{ pick: [item: FeedItem] }>();
const lines = computed(() => props.items.filter((i) => i.kind !== "thinking" || !!i.text));
const stepped = computed(() => railSteps(lines.value, props.plan ?? [], props.tail !== false));
// no plan step in this run: one plain group, drawn as a list with no nodes
const groups = computed<CallGroup[]>(() => stepped.value ?? [{ step: null, items: lines.value }]);
const open = ref(new Set<string>()), unshut = ref(new Set<number>());
const flip = (set: typeof open, k: string) => { const s = new Set(set.value); s.has(k) ? s.delete(k) : s.add(k); set.value = s; };
// a failed call opens by itself, unless the owner closed it: `open` then holds "!id"
const isOpen = (it: FeedItem) => (it.status === "error" && !open.value.has("!" + it.id) ? true : open.value.has(it.id));
const clickRow = (it: FeedItem) => {
  if (it.status === "error") return flip(open, "!" + it.id);
  flip(open, it.id);
};
const gn = (g: CallGroup) => g.step?.n ?? 0;
const live = (g: CallGroup) => g.items.some((i) => i.status === "running");
// a finished step, and the calls before the plan once they are done, fold to one line; the step with the work stays open
const shuts = (g: CallGroup) => (g.step ? g.step.status === "done" : !live(g));
// the first step of a run that goes on from the run before: its header is that run's, so it never folds behind one
const ct = (gi: number) => !!props.cont && gi === 0 && !!stepped.value && !!groups.value[0]?.step;
const folded = (g: CallGroup) => !!stepped.value && !!g.items.length && shuts(g) && !unshut.value.has(gn(g)) && groups.value.length > 1 && !(props.cont && g === groups.value[0]);
const toggleGroup = (g: CallGroup) => { if (g.items.length) flip2(gn(g)); };
const flip2 = (n: number) => { const s = new Set(unshut.value); s.has(n) ? s.delete(n) : s.add(n); unshut.value = s; };
watch(() => props.show, (id) => {
  const g = id ? groups.value.find((x) => x.items.some((i) => i.id === id)) : undefined;
  if (!g) return;
  unshut.value = new Set(unshut.value).add(gn(g));
  open.value = new Set(open.value).add(id!);
}, { immediate: true });
const dur = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
// an agentnet row (a message, a delivery) says when it happened, not how long it took
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const can = (it: FeedItem) => (it.kind === "thinking" ? !!it.text : !!it.out || !!it.inp);
const imgUrl = (path: string) => url(`v1/panel/agents/${encodeURIComponent(props.agent ?? "")}/image?path=${encodeURIComponent(path)}`);
const base = (p: string) => p.split("/").pop() ?? p;
const pf = usePicFocus(); // a picture opens large in place, not in a new tab
const gone = ref(new Set<string>()); // images that did not load: the row stays, the picture goes

type Kind = NonNullable<FeedItem["tool"]> | "thought";
const TILE: Record<Kind, ToolKind> = { agentnet: "agentnet", read: "read", image: "image", search: "search", web: "web", agent: "agent", edit: "edit", command: "cmd", browser: "browser", other: "tool", thought: "think" };
// a feed from before the server sent `tool` is read by its title, so old turns are not all one colour
const guess = (t: string): Kind => (/^agentnet · /.test(t) ? "agentnet" : /^Reading .+\.(png|jpe?g|gif|webp)$/i.test(t) ? "image" : /^Reading a web page|^Searching the web/.test(t) ? "web" : /^Reading /.test(t) ? "read" : /^(Editing|Writing) /.test(t) ? "edit" : /^Searching the code/.test(t) ? "search" : /^Sub-agent/.test(t) ? "agent" : /^(Chrome|playwright) · /.test(t) ? "browser" : / · |^Loading tools|^Updating the task list/.test(t) ? "other" : "command");
const kind = (it: FeedItem): Kind => (it.kind === "thinking" ? "thought" : it.tool ?? guess(it.title ?? ""));
const tile = (it: FeedItem): ToolKind => (it.status === "error" ? "bad" : TILE[kind(it)]);
const glyph = (it: FeedItem) => (it.status === "error" ? ({ agentnet: "network", read: "file-text", image: "image", search: "search", web: "globe", agent: "bot", edit: "pen-line", command: "square-terminal", browser: "camera", other: "plug", thought: "brain" } as const)[kind(it)] : undefined);
/** "Editing ChatWork.vue" reads as a verb and its object; "Skill · run" as a name and its part. Anything else is one phrase. */
function words(it: FeedItem): [string, string] {
  if (it.kind === "thinking") return ["Thought", ""];
  const t = it.title ?? "", m = /^(Reading|Editing|Writing) (.+)$/.exec(t) ?? /^(.+?) · (.+)$/.exec(t);
  return m ? [m[1]!, m[2]!] : [t, ""];
}
const node = (g: CallGroup) => (!g.step ? (live(g) ? "cur" : "todo") : g.step.status === "done" ? "done" : g.step.status === "active" ? "cur" : "todo");
const calls = (g: CallGroup) => g.items.filter((i) => i.kind === "step").length;
const no = (s: PlanBit) => (s.job != null ? `${s.job}.${s.n}` : String(s.n));
const look = (g: CallGroup) => (!g.step ? "pre" : g.step.status === "active" ? "cur" : g.step.status === "done" ? "done" : "todo");
// the line that leaves a node is lit once the work above it is done
const lit = (g: CallGroup) => (g.step ? g.step.status === "done" : !!g.items.length && !live(g));
const took = (s: PlanBit) => (s.at != null && s.end != null && s.end > s.at ? dur(s.end - s.at) : "");
const proofIcon = (p: string) => (/^[0-9a-f]{7,40}$/.test(p) ? "git-commit-horizontal" : /[/.]\w/.test(p) ? "file-text" : undefined);

// ---- canvas Motion "a step finishes" ----
const ol = ref<HTMLElement | null>(null);
const fin = ref<{ n: number; next: number | null; from: number; to: number } | null>(null);
let finT: ReturnType<typeof setTimeout> | undefined;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const centre = (n: number) => { const r = ol.value?.querySelector<HTMLElement>(`[data-n="${n}"] .rn`), o = ol.value; if (!r || !o) return null; const a = r.getBoundingClientRect(), b = o.getBoundingClientRect(); return a.top - b.top + a.height / 2; };
watch(() => (props.plan ?? []).map((s) => `${s.n}:${s.status}`).join(" "), async (now, before) => {
  if (!before || !stepped.value || still()) return;
  const was = new Map(before.split(" ").map((x) => x.split(":") as [string, string]));
  const done = (props.plan ?? []).filter((s) => s.status === "done" && was.get(String(s.n)) !== "done" && groups.value.some((g) => g.step?.n === s.n));
  const n = done.at(-1)?.n; if (n == null) return;
  const next = (props.plan ?? []).find((s) => s.status === "active" && s.n !== n)?.n ?? null;
  await nextTick();
  const from = centre(n), to = next != null ? centre(next) : null;
  clearTimeout(finT);
  fin.value = { n, next, from: from ?? 0, to: to ?? from ?? 0 };
  finT = setTimeout(() => { fin.value = null; }, 1100);
});
onBeforeUnmount(() => clearTimeout(finT));
const rowDelay = (g: CallGroup, i: number) => (fin.value && fin.value.next === gn(g) ? 660 : 0) + Math.min(i, 8) * 30 + "ms";
</script>

<template>
  <div v-if="lines.length" :class="['cw', { flat: !stepped }]">
    <ol ref="ol" class="sp">
      <li v-for="(g, gi) in groups" :key="g.step?.n ?? 'pre'" :data-n="gn(g)" :class="['st', look(g), { open: !!g.items.length && !folded(g), end: gi === groups.length - 1, lit: lit(g), fin: fin?.n === gn(g) && !!g.step, nx: fin?.next === gn(g) && !!g.step, ct: ct(gi) }]">
        <button v-if="stepped && !ct(gi)" type="button" class="gh" :disabled="!g.items.length" :aria-expanded="g.items.length ? !folded(g) : undefined" @click="toggleGroup(g)">
          <RailNode :state="node(g)" surface="panel" :play="fin?.n === gn(g) && g.step ? 'fin' : fin?.next === gn(g) && g.step ? 'grow' : null" />
          <span class="gt">
            <small v-if="g.step">{{ no(g.step) }}</small><span v-else class="pre-n" />
            <span>{{ g.step ? g.step.text : "Before the plan" }}</span>
            <span v-if="folded(g)" class="px">
              <Chip :text="`${calls(g)} ${calls(g) === 1 ? 'call' : 'calls'}`" />
              <span v-if="g.step && took(g.step)" class="cx-chip"><Icon name="clock" :size="12" /><b>{{ took(g.step) }}</b></span>
              <Chip v-for="p in (g.step?.proofs ?? []).slice(0, 3)" :key="p" :text="p" :icon="proofIcon(p)" />
            </span>
          </span>
          <span class="gr"><span v-if="g.step?.status === 'active'" class="now">NOW</span></span>
          <Icon v-if="g.items.length" name="chevron-down" :size="14" :class="['cv', { up: !folded(g) }]" />
          <span v-else />
        </button>
        <i v-if="stepped && gi < groups.length - 1 && !(g.items.length && !folded(g))" class="sg" aria-hidden="true" />
        <div v-if="g.items.length && !folded(g)" class="br">
          <svg v-if="stepped && !ct(gi)" class="cu out" width="22" height="20" viewBox="0 0 22 20" fill="none" stroke-width="2" aria-hidden="true"><path d="M1 0A10 10 0 0 0 11 10A10 10 0 0 1 21 20" /></svg>
          <ol class="rows">
            <li v-for="(it, i) in g.items" :key="it.id" :data-row="it.id" :class="['row', it.kind, { run: it.status === 'running', bad: it.status === 'error', sel: picked === it.id, tail: gi === groups.length - 1 && i === g.items.length - 1 }]" :style="{ '--d': rowDelay(g, i) }">
            <component :is="can(it) ? 'button' : 'p'" :type="can(it) ? 'button' : undefined" class="rh" :aria-expanded="can(it) ? isOpen(it) : undefined" @click="can(it) && clickRow(it)">
              <ToolTile :kind="tile(it)" :icon="glyph(it)" :run="it.status === 'running'" />
              <span class="rt"><b>{{ words(it)[0] }}</b><span v-if="words(it)[1]" class="tg">{{ words(it)[1] }}</span></span>
              <span class="meta">{{ it.tool === "agentnet" ? clock(it.ts) : it.kind === "step" && it.status !== "running" ? dur(it.ms) : "" }}</span>
              <Icon v-if="can(it)" name="chevron-down" :size="14" :class="['cv', { up: isOpen(it) }]" />
              <span v-else />
            </component>
            <div v-if="it.img && agent && !gone.has(it.id)" class="x img">
              <a :href="imgUrl(it.img)" target="_blank" rel="noopener" role="button" aria-haspopup="dialog" :title="it.img" @click="pf.open($event, imgUrl(it.img!), it.img!)" @keydown.space.prevent="pf.open($event, imgUrl(it.img!), it.img!)"><img :src="imgUrl(it.img)" :alt="it.title ?? 'The image this step read'" loading="lazy" decoding="async" @error="gone = new Set(gone).add(it.id)"></a>
              <span class="cap"><b>{{ base(it.img) }}</b>The agent looked at this.</span>
            </div>
            <p v-if="it.kind === 'thinking'" :class="['x', 'th', { on: open.has(it.id) }]">{{ it.text }}</p>
            <div v-else-if="it.out || it.inp" :class="['xw', { on: isOpen(it) }]" :inert="!isOpen(it) || undefined"><div><div :class="['x', { xp: pick && it.kind === 'step' }]"><div class="xb"><template v-if="it.inp"><small>In</small><pre tabindex="0">{{ it.inp }}</pre></template><template v-if="it.out"><small :class="{ o2: !!it.inp }">Out</small><pre tabindex="0">{{ it.out }}</pre></template></div><button v-if="pick && it.kind === 'step'" type="button" class="xo" :aria-pressed="picked === it.id" :aria-label="picked === it.id ? 'Close the side panel' : 'Open in side panel'" :title="picked === it.id ? 'Close the side panel' : 'Open in side panel'" @click="emit('pick', it)"><Icon name="panel-right" :size="15" /></button></div></div></div>
            </li>
          </ol>
          <svg v-if="stepped && gi < groups.length - 1" class="cu back" width="22" height="20" viewBox="0 0 22 20" fill="none" stroke-width="2" aria-hidden="true"><path d="M21 0A10 10 0 0 1 11 10A10 10 0 0 0 1 20" /></svg>
        </div>
        <i v-if="stepped && gi < groups.length - 1 && g.items.length && !folded(g)" class="sg stub" aria-hidden="true" />
      </li>
      <i v-if="fin && fin.next != null" class="lt" :style="{ '--from': fin.from + 'px', '--to': fin.to + 'px' }" aria-hidden="true"><i /></i>
    </ol>
  <FocusView v-if="pf.pic.value" :path="pf.pic.value.path" :image-src="pf.pic.value.src" :origin="pf.pic.value.origin" @close="pf.close" />
  </div>
</template>

<style scoped>
.cw{--rail:color-mix(in srgb,var(--fiber) 55%,var(--panel));margin:0;min-width:0;font-size:12.5px;color:var(--muted)}
/* the spine: canvas Trail, open. Node centre at x 12 of a step; the branch rows at x 32 */
.sp{position:relative;margin:0;padding:0 0 0 2px;list-style:none;min-width:0}
.flat .sp{padding:0}
.st{position:relative;min-width:0}
.cw:not(.flat) .st{padding:7px 0}
.gh{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr) auto 16px;align-items:start;column-gap:12px;width:100%;margin:0;padding:0 6px 0 0;border:0;border-radius:8px;background:none;color:var(--muted);font:inherit;text-align:left;cursor:pointer;transition:background-color .22s cubic-bezier(.2,.8,.2,1)}
.gh:disabled{cursor:default;color:inherit}
.gh:focus-visible,.rh:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
@media (hover:hover) and (pointer:fine){.gh:not(:disabled):hover,button.rh:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}}
.gt{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:5px;min-width:0;padding-top:3px;font-size:13px;overflow-wrap:anywhere;color:var(--muted)}
.gt small{min-width:3ch;font:500 11px/19px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted)}
.gt .pre-n{min-width:3ch}
.st.cur .gt{color:var(--ink);font-weight:600}.st.cur .gt small{color:var(--ink)}
.st.todo .gt{color:color-mix(in srgb,var(--ink) 35%,var(--muted))}
.px{grid-column:2;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;font-weight:400;min-width:0}
.px > *{max-width:100%}
.gr{padding-top:4px;display:flex;gap:6px;align-items:baseline}
.now{font:600 11px/20px var(--mono);letter-spacing:.02em;white-space:nowrap;color:var(--on)}
.gh > .cv{margin-top:5px}
/* one line from node to node: a segment under a folded or empty step, a stub under an open step's back curve */
.sg{position:absolute;left:11px;top:28px;bottom:-10px;width:2px;border-radius:1px;background:var(--rail);transform-origin:top}
.st.lit > .sg{background:var(--lit)}
.sg.stub{top:auto;height:11px}
/* an open step: the line drops from its node to where the S-curve starts, however many lines the title takes */
.cw:not(.flat) .st.open > .gh::after{content:"";position:absolute;left:11px;top:22px;bottom:-1px;width:2px;background:var(--lit);pointer-events:none}
.br{position:relative;display:flex;flex-direction:column;min-width:0;margin-top:8px;padding:0 0 8px 24px}
/* a run that goes on in the step the run above ended in: no node and no title, the branch line comes in from the top */
.cw:not(.flat) .st.ct{padding-top:0}
.st.ct > .br{margin-top:0}
.st.ct > .br::before{content:"";position:absolute;left:31px;top:-4px;height:16px;width:2px;border-radius:1px;background:var(--lit)}
.flat .br{margin:0;padding:0}
.cu{position:absolute;left:11px;width:22px;height:20px;overflow:visible;pointer-events:none;fill:none;stroke-width:2;stroke-linecap:butt}
.cu.out{top:-7px;stroke:var(--lit)}
.cu.back{bottom:-6px;stroke:var(--rail)}
.st.lit .cu.back{stroke:var(--lit)}
.br .row:last-child::after{bottom:6px;background:var(--rail)}
.st.lit .br .row:last-child::after{background:var(--lit)}
/* canvas Motion "a step finishes": rail fills down (320 ms at 300), the branch curve fades in (160 ms at 600), the light
   runs from the finished node to the next (320 ms at 300); the nodes play in RailNode, the rows by --d */
.st.fin > .sg{animation:cw-fill 320ms cubic-bezier(.65,0,.35,1) 300ms 1 both}
.st.nx .cu.out{animation:cw-fade 160ms cubic-bezier(.2,.8,.2,1) 600ms 1 both}
.lt{position:absolute;left:14px;top:0;width:0;height:0;pointer-events:none;opacity:0;z-index:2;animation:cw-run 320ms cubic-bezier(.65,0,.35,1) 300ms 1 both}
.lt i{position:absolute;left:-1px;bottom:0;width:2px;height:56px;border-radius:1px;background:linear-gradient(to top,var(--lit),transparent)}
.lt::after{content:"";position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 0 1px var(--lit)}
@keyframes cw-fill{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes cw-fade{from{opacity:0}to{opacity:1}}
@keyframes cw-run{0%{opacity:0;transform:translateY(var(--from))}12%{opacity:1}86%{opacity:1}100%{opacity:0;transform:translateY(var(--to))}}
.rows{margin:0;padding:0;list-style:none;min-width:0}
.row{position:relative;min-width:0;margin-top:2px;animation:cw-in 200ms cubic-bezier(.2,.8,.2,1) var(--d,0ms) 1 both}
.row:first-child{margin-top:0}
@keyframes cw-in{from{opacity:0;transform:translateY(6px)}}
.row::before{content:"";position:absolute;z-index:1;left:5px;top:12px;width:6px;height:6px;border-radius:50%;background:var(--lit)}
.row::after{content:"";position:absolute;left:7px;top:15px;bottom:-17px;width:2px;background:var(--lit)}
.row.tail::after{display:none}
.row.run::before{background:var(--on)}.row.bad::before{background:var(--bad)}
.row.run::after{background:var(--rail)}
.rh{display:grid;grid-template-columns:22px minmax(0,1fr) auto 16px;align-items:center;column-gap:8px;width:100%;min-height:30px;margin:0;padding:2px 6px 2px 22px;border:0;border-radius:8px;background:none;color:var(--muted);font:inherit;text-align:left;transition:background-color .22s cubic-bezier(.2,.8,.2,1)}
button.rh{cursor:pointer}
.row.sel .rh{background:color-mix(in srgb,var(--ink) 9%,transparent)}
.rt{min-width:0;overflow-wrap:anywhere;line-height:1.4}
.rt b{color:var(--ink);font-weight:600}
.row.run .rt b{color:var(--on)}
.row.bad .rt b{color:var(--bad)}
.row.thinking .rt b{color:var(--lock)}
.tg{margin-left:6px;font:11.5px var(--mono);color:var(--muted)}
.meta{font:500 11.5px/1.6 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.cv{color:var(--muted);transition:transform .22s cubic-bezier(.2,.8,.2,1)}
.cv.up{transform:rotate(180deg)}
.x{margin:2px 0 8px 52px;min-width:0}
/* in the large chat a step's body has, at its far right, the button that shows it in the side panel (owner 2026-11-24) */
.x.xp{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;column-gap:6px}
.xb{min-width:0}
.xo{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:none;color:var(--muted);cursor:pointer;transition:background-color .15s cubic-bezier(.23,1,.32,1),color .15s cubic-bezier(.23,1,.32,1),transform .12s cubic-bezier(.23,1,.32,1)}
.xo:hover,.xo[aria-pressed="true"]{background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--ink)}
.xo:active{transform:scale(.94)}
.xo:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
.img{display:flex;gap:10px;align-items:flex-start;animation:cw-in 180ms cubic-bezier(.23,1,.32,1) 1 both}
.img a{display:block;border-radius:10px;cursor:zoom-in;box-shadow:0 0 0 .75px rgba(255,255,255,.09),0 1px 2px rgba(0,0,0,.45),0 6px 12px -5px rgba(0,0,0,.5)}
.img a:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.img img{display:block;width:132px;aspect-ratio:16/10;object-fit:cover;object-position:50% 0;border-radius:10px}
.cap{font-size:12px;min-width:0;overflow-wrap:anywhere}
.cap b{display:block;font:500 11.5px/1.4 var(--mono);color:var(--ink)}
.th{margin:2px 0 6px 52px;color:var(--muted);font-size:12.5px;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.th.on{display:block;color:var(--ink)}
.xw{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .24s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
.xw.on{grid-template-rows:1fr;opacity:1}
.xw > div{min-height:0;overflow:hidden}
.x small{display:block;margin-bottom:4px;font:600 11.5px/1 var(--body);color:var(--muted)}
.x pre{margin:0;padding:8px 10px;max-height:200px;overflow:auto;overscroll-behavior:contain;border-radius:10px;background:var(--panel-2);color:var(--ink);font:500 12px/1.5 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 0 0 .75px rgba(255,255,255,.09),0 1px 2px rgba(0,0,0,.45)}
:root[data-theme="light"] .x pre{box-shadow:0 0 0 .75px rgba(0,0,0,.09),0 1px 2px rgba(22,22,26,.08)}
.row.bad .x pre{background:color-mix(in srgb,var(--bad) 12%,var(--panel-2));color:var(--ink);box-shadow:0 0 0 .75px color-mix(in srgb,var(--bad) 40%,transparent)}
.x small.o2{margin-top:6px}
.x pre:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.row,.img,.st.fin > .sg,.st.nx .cu.out{animation:none}.lt{display:none}.xw,.gh,.rh,.cv,.xo{transition:none}}
</style>
