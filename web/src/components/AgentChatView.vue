<script setup lang="ts">
// The agent's chat, on its own (owner 8362): tapping a card opens it over the Agents page; the details panel is a separate,
// smaller button. Its header is not a band (owner 8361): the messages run under it to the very top, only the chips have a
// surface. The header's measured height becomes --hd-h, so the first message clears it at rest.
// Owner 8377: it opens as a side panel first (docked right, the page stays usable beside it), the header can be dragged to
// float it anywhere and double-clicked to dock it back, its left edge resizes it (floating: every edge and corner, owner 8488), and a header chip expands it to the full
// view (the chat's own `wide`, whose All/Messages/Terminal choice teleports into #ap-tab-extra here). Size and place: chatDock.ts.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, nextTick } from "vue";
import AgentnetChat from "./AgentnetChat.vue";
import Chip from "./chat/Chip.vue";
import DotTile from "./chat/DotTile.vue";
import Icon from "../ui/Icon.vue";
import { agentHue } from "./chat/agentHue";
import { crewState, modelShort } from "../crewTree";
import { net, teams, type AgentRow } from "../net";
import { agentClosed } from "../agentClosed";
import { CURSOR, DIRS, EASE, GAP, MIN_W, MS_IN, MS_OUT, clampFloat, clampW, fadeFrames, inset, maxW, moveFrames, readDock, resizeBox, sameRect, writeDock, type Box, type Dir, type R as Rect, type Skin } from "../ui/chatDock";

const props = defineProps<{ row: AgentRow | null; name: string; mode: "panel" | "full"; phone?: boolean }>();
const emit = defineEmits<{ close: []; details: []; mode: [m: "panel" | "full"]; cover: [px: number] }>();

const r = computed(() => props.row);
const isRoot = computed(() => props.name === "root");
const gone = computed(() => !!r.value && (r.value.life === "gone" || r.value.life === "failed"));
// Closed: despawned, or no longer on the map (agentClosed.ts; an idle or "not running" agent that is still listed is not).
// The window then covers its body with a calm "closed" card; Keep reading hides it for this window (the view is keyed per
// agent in Agents.vue, so a new window asks again).
const closed = computed(() => agentClosed(props.name, r.value, net));
const keepReading = ref(false);
const cover = computed(() => closed.value.closed && !keepReading.value);
const closedAt = computed(() => {
  const t = closed.value.at; if (!t) return null;
  const d = new Date(t), same = d.toDateString() === new Date().toDateString();
  return (same ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", ") + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
});
const coverBtn = ref<HTMLButtonElement | null>(null);
watch(cover, (on) => { if (on) nextTick(() => coverBtn.value?.focus({ preventScroll: true })); }, { flush: "post" });
// Esc on the card closes the window in every mode (capture: before the chat's own Esc, which would only collapse the full view)
const onCoverKey = (e: KeyboardEvent) => { if (cover.value && e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); emit("close"); } };
const st = computed(() => crewState(r.value));
const tileState = computed(() => (st.value === "working" || st.value === "waiting" || st.value === "blocked" ? st.value : "idle"));
const WORD: Record<string, string> = { working: "Working", waiting: "Needs you", blocked: "Blocked", idle: "Idle", starting: "Starting", done: "Closed", off: "Not running" };
const TONE: Record<string, "ok" | "warn" | "bad" | "plain"> = { working: "ok", waiting: "warn", blocked: "bad" };
const model = computed(() => modelShort(r.value?.model ?? null));
const teamName = computed(() => { const t = teams.list.find((x) => x.members.includes(props.name)); return t ? t.name || t.id : null; });
// the mark and hue the agent's card has (AgentCard.vue), so the chat reads as the same agent
const pattern = computed(() => {
  let h = 2166136261; for (const c of props.name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let b = ((h >>> 0) >>> 3) & 511; if ([...b.toString(2)].filter((x) => x === "1").length < 4) b ^= 0b101110101;
  return Array.from({ length: 9 }, (_, i) => ((b >> i) & 1 ? "1" : "0")).join("");
});
const hue = computed(() => agentHue(props.name));

const el = ref<HTMLElement | null>(null), hd = ref<HTMLElement | null>(null);
const full = computed(() => props.mode === "full");

// ---- size and place: docked (right edge, full height) or floating (x, y, h inside the page area) ----
const dock = reactive(readDock());
const area = reactive({ w: 0, h: 0 });
const w = computed(() => (area.w ? clampW(dock.w, area.w) : dock.w));
// before the page area is measured (the first render) a saved float holds as saved, so the chat is a float from its first
// frame and its open can grow it (it used to mount as a dock and then jump to the float)
const fl = computed(() => (dock.float && area.w ? clampFloat(dock.float, w.value, area.w, area.h) : dock.float));
const kind = computed(() => (full.value ? "full" : props.phone ? "sheet" : fl.value ? "float" : "dock"));
const box = computed(() => {
  if (kind.value === "dock") return { "--cw": w.value + "px" };
  const f = fl.value; return kind.value === "float" && f ? { left: f.x + "px", top: f.y + "px", width: w.value + "px", height: f.h + "px" } : {};
});
const save = () => writeDock({ w: w.value, float: fl.value });
// the map keeps its controls and the picked node out from under a docked panel (same as the details panel's cover)
// The full view keeps the cover it had as a panel: the map is under it anyway, and re-framing the office there made the
// page behind move during expand and again during collapse (motion-audit E6/C2).
let coverPx = 0;
watch(() => (kind.value === "dock" ? w.value + GAP : kind.value === "full" ? coverPx : 0), (px) => { coverPx = px; emit("cover", px); }, { immediate: true });

// ---- motion: a change of kind moves the real box (owner 8436: "cant you just move it? The same chat?"). Its left, top,
// width and height run per frame with the Motion board view timing (260 ms in, 180 ms out, cubic-bezier(.23,1,.32,1)), so
// the one live chat lays out at each frame's size and reflows as it grows, like a window being resized: no scale, no
// frozen copy, no fade. The box is contained (layout, paint) during the run, so the page behind never reflows, and the
// edge that does not move (the dock's right edge, a float's top-left) stays put by itself. A second press mid-run reads
// the rect on screen before the old run stops and turns round from there. The reader's place is pinned once, at the end.
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
let run: Animation | null = null, fade: Animation | null = null, pin: (() => void) | null = null;
let first: { r: Rect; s: Skin } | null = null;
/** The box's rect in its containing block, as drawn now (mid-run: the animated one). */
function rectOf(a: HTMLElement): Rect {
  const p = a.offsetParent as HTMLElement | null, o = a.getBoundingClientRect(), q = p?.getBoundingClientRect();
  return { left: o.left - (q?.left ?? 0) - (p?.clientLeft ?? 0), top: o.top - (q?.top ?? 0) - (p?.clientTop ?? 0), width: o.width, height: o.height };
}
const skinOf = (a: HTMLElement): Skin => { const c = getComputedStyle(a); return { borderRadius: c.borderRadius, boxShadow: c.boxShadow }; };
function stopRun() { run?.cancel(); fade?.cancel(); run = fade = null; el.value?.classList.remove("run"); }
function settle() { const p = pin; pin = null; if (p) { p(); requestAnimationFrame(p); setTimeout(p, 120); } }
function capture() {
  const a = el.value;
  if (!a || reduced() || dragging.value) { stopRun(); first = null; return; }
  first = { r: rectOf(a), s: skinOf(a) };
  stopRun();
}
async function play() {
  await nextTick();
  const a = el.value, f = first; first = null;
  if (!a || !f) { settle(); return; }
  const l = rectOf(a), ls = skinOf(a);
  if (!l.width || !l.height || sameRect(f.r, l)) { settle(); return; }
  a.classList.add("run");
  const me = (run = a.animate(moveFrames(f.r, l, f.s, ls), { duration: kind.value === "full" ? MS_IN : MS_OUT, easing: EASE }));
  me.finished.then(() => { if (run === me) { stopRun(); settle(); } }, () => {});
}
watch(kind, capture, { flush: "pre" });

// ---- the floating chat opens and closes the same way (root 8465, owner 8466): the one live box grows out of the card
// that opened it (or from its own spot, a little smaller, when that card is not on screen) and shrinks back into it. Same
// geometry run, timing and curve as the expand. The box stays fully opaque for the whole move (owner 8436): only the first
// 30 ms of an open and the last 30 ms of a close ramp the opacity, so the tiny first and last frames do not pop. A press mid-run reads the rect and opacity on
// screen and turns round from there. Agents.vue keeps the chat mounted until the close has run (fly("out") resolves).
/** The card or map node of this agent, if it is on screen, as a rect in the box's containing block. */
function originOf(a: HTMLElement): { r: Rect; s: Skin } | null {
  const p = a.offsetParent as HTMLElement | null, q = p?.getBoundingClientRect();
  for (const id of [props.row?.id, props.name]) {
    if (!id) continue;
    for (const n of document.querySelectorAll<HTMLElement>(`.anc[data-id="${CSS.escape(id)}"]`)) {
      const o = n.getBoundingClientRect();
      if (o.width < 8 || o.height < 8 || o.right <= 0 || o.bottom <= 0 || o.left >= innerWidth || o.top >= innerHeight) continue;
      return { r: { left: o.left - (q?.left ?? 0) - (p?.clientLeft ?? 0), top: o.top - (q?.top ?? 0) - (p?.clientTop ?? 0), width: o.width, height: o.height },
        s: { borderRadius: getComputedStyle(n).borderRadius, boxShadow: skinOf(a).boxShadow } };
    }
  }
  return null;
}
/** Open (in) or close (out) a floating chat. fresh: an open from nothing (starts at the origin, invisible). Resolves true
 *  when the run ended (a close then holds its last frame until Agents.vue unmounts it), false when there was nothing to
 *  run (not a float, reduced motion: the CSS fade does it) or a newer press took over. */
function fly(dir: "in" | "out", fresh = false): Promise<boolean> {
  const a = el.value;
  if (!a || reduced() || kind.value !== "float") { if (a) a.style.opacity = ""; return Promise.resolve(false); }
  const now = rectOf(a), nowS = skinOf(a), op = fresh ? 0 : +getComputedStyle(a).opacity;
  stopRun();
  a.style.opacity = "";
  const home = rectOf(a), homeS = skinOf(a), o = originOf(a) ?? { r: inset(home), s: homeS };
  const from = fresh ? o.r : now, fromS = fresh ? o.s : nowS;
  const [to, toS] = dir === "in" ? [home, homeS] : [o.r, o.s];
  const ms = dir === "in" ? MS_IN : MS_OUT, fill = dir === "out" ? "forwards" : "none";
  a.classList.add("run");
  a.style.pointerEvents = dir === "out" ? "none" : "";
  const me = (run = a.animate(moveFrames(from, to, fromS, toS), { duration: ms, easing: EASE, fill }));
  fade = a.animate(fadeFrames(op, dir, ms), { duration: ms, easing: "linear", fill });
  return me.finished.then(() => { if (run !== me) return false; if (dir === "in") stopRun(); else run = fade = null; return true; }, () => false);
}
watch(kind, () => void play());

// ---- expand / back to the panel: the reader keeps their place (the first row on screen stays where it was) ----
// The place is read at the press; it is put back when the box has settled (play() ends with settle()), not during the run.
function holdPlace() {
  const list = el.value?.querySelector<HTMLElement>(".ac-list"); if (!list) return;
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 4) { pin = () => { list.scrollTop = list.scrollHeight; }; return; }
  const top = list.getBoundingClientRect().top;
  const row = [...list.querySelectorAll<HTMLElement>("[data-k]")].find((n) => n.getBoundingClientRect().bottom > top + 1); if (!row) return;
  const dy = row.getBoundingClientRect().top - top;
  pin = () => { if (row.isConnected) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - dy; };
}
function setMode(m: "panel" | "full") { if (m === props.mode) return; holdPlace(); emit("mode", m); }
const toggleFull = () => setMode(full.value ? "panel" : "full");
// The chat's own Esc (it is always in its large layout here) asks to collapse: the full view goes back to the panel, the panel closes.
const onWide = (on: boolean) => (on ? setMode("full") : full.value ? setMode("panel") : emit("close"));
// Esc: the full view's Esc is the chat's own (back to the panel); on the panel Esc closes it. Open settings or a picked
// step take Esc first and mark it handled.
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !full.value && !e.defaultPrevented) { e.preventDefault(); emit("close"); } };

// ---- drag the header to float the panel; double-click docks it again ----
const area0 = () => el.value?.parentElement?.getBoundingClientRect() ?? null;
const dragging = ref(false);
let hdDrag: { id: number; x: number; y: number; fx: number; fy: number; on: boolean } | null = null;
function hdDown(e: PointerEvent) {
  if (full.value || props.phone || e.button !== 0) return;
  if (run && kind.value === "float") stopRun(); // a grab mid-open takes the box where it is meant to be
  if ((e.target as Element).closest("button, a, input, textarea, [role='radio']")) return;
  const a = el.value?.getBoundingClientRect(), p = area0(); if (!a || !p) return;
  hdDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, fx: a.left - p.left, fy: a.top - p.top, on: false };
  // the header itself lets pointers through (only its chips have a surface): capture on the row that was pressed
  ((e.target as Element).closest<HTMLElement>(".acv-who, .acv-act") ?? hd.value)?.setPointerCapture(e.pointerId);
}
function hdMove(e: PointerEvent) {
  const d = hdDrag; if (!d || e.pointerId !== d.id) return;
  const dx = e.clientX - d.x, dy = e.clientY - d.y;
  if (!d.on) {
    if (Math.hypot(dx, dy) < 4) return;
    d.on = true; dragging.value = true;
    // a docked panel lifts off at its place; it keeps its height unless that is the whole page area
    if (!dock.float) { const h = el.value?.offsetHeight ?? 600; dock.float = { x: d.fx, y: d.fy, h: Math.min(h, Math.round(area.h * 0.8)) }; }
  }
  dock.float = clampFloat({ x: d.fx + dx, y: d.fy + dy, h: dock.float!.h }, w.value, area.w, area.h);
}
function hdUp(e: PointerEvent) {
  const d = hdDrag; if (!d || e.pointerId !== d.id) return;
  hdDrag = null; dragging.value = false;
  if (d.on) save();
}
function hdDbl(e: MouseEvent) {
  if (full.value || !dock.float || (e.target as Element).closest("button, a, input, textarea, [role='radio']")) return;
  dock.float = null; save();
}

// ---- resize: docked, the left edge only; floating, every edge and corner like a window (owner 8488): the dragged edges
// move, the opposite ones stay put (chatDock resizeBox). Arrow keys on the left edge too (Left wider, Right narrower;
// Shift for big steps; Home/End).
const handles = computed<Dir[]>(() => (kind.value === "float" ? DIRS : kind.value === "dock" ? ["w"] : []));
const rzOn = ref<Dir | null>(null); // the handle being dragged stays lit
let rz: { id: number; dir: Dir; x: number; y: number; w: number; right: number; b: Box | null } | null = null;
function setW(nw: number, right?: number) {
  const v = clampW(nw, area.w);
  dock.w = v;
  if (dock.float && right != null) dock.float = clampFloat({ ...dock.float, x: right - v }, v, area.w, area.h);
}
function rzDown(e: PointerEvent, dir: Dir) {
  if (e.button !== 0) return;
  e.preventDefault();
  if (run) stopRun(); // a grab mid-open takes the box where it is meant to be, no jump
  const f = fl.value;
  rz = { id: e.pointerId, dir, x: e.clientX, y: e.clientY, w: w.value, right: (f?.x ?? 0) + w.value, b: kind.value === "float" && f ? { x: f.x, y: f.y, w: w.value, h: f.h } : null };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); dragging.value = true; rzOn.value = dir;
}
function rzMove(e: PointerEvent) {
  const d = rz; if (!d || e.pointerId !== d.id) return;
  if (!d.b) { setW(d.w + d.x - e.clientX); return; }
  const n = resizeBox(d.b, d.dir, e.clientX - d.x, e.clientY - d.y, area.w, area.h);
  dock.w = n.w; dock.float = { x: n.x, y: n.y, h: n.h };
}
function rzUp(e: PointerEvent) { if (!rz || e.pointerId !== rz.id) return; rz = null; rzOn.value = null; dragging.value = false; save(); }
function rzKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16, right = (fl.value?.x ?? 0) + w.value;
  const nw = e.key === "ArrowLeft" ? w.value + step : e.key === "ArrowRight" ? w.value - step : e.key === "Home" ? MIN_W : e.key === "End" ? maxW(area.w) : null;
  if (nw == null) return;
  e.preventDefault(); setW(nw, right); save();
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  const a = el.value, h = hd.value, p = a?.parentElement;
  const measure = () => { if (p) { area.w = p.clientWidth; area.h = p.clientHeight; } };
  measure();
  // a float opens by growing out of its card: hidden until the clamped rect is laid out, then fly() takes it from there
  if (a && kind.value === "float" && !reduced()) { a.style.opacity = "0"; void nextTick(() => fly("in", true)); }
  if (a && h) a.style.setProperty("--hd-h", h.offsetHeight + "px");
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => { measure(); if (a && h) a.style.setProperty("--hd-h", h.offsetHeight + "px"); });
    if (h) ro.observe(h); if (p) ro.observe(p);
  }
  a?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  addEventListener("keydown", onKey);
  addEventListener("keydown", onCoverKey, true);
  if (cover.value) nextTick(() => coverBtn.value?.focus({ preventScroll: true }));
});
onBeforeUnmount(() => { ro?.disconnect(); removeEventListener("keydown", onKey); removeEventListener("keydown", onCoverKey, true); emit("cover", 0); });
defineExpose({ el, fly });
</script>

<template>
  <section ref="el" :class="['acv', kind, { moving: dragging }]" :style="box" role="dialog" :aria-label="`Chat with ${name}`">
    <template v-for="d in handles" :key="d">
      <div v-if="d === 'w'" :class="['acv-rz', 'rz-w', { on: rzOn === d }]" role="separator" tabindex="0" aria-orientation="vertical" aria-label="Chat width"
        :aria-valuenow="w" :aria-valuemin="MIN_W" :aria-valuemax="maxW(area.w)" title="Drag to resize; arrow keys too"
        @pointerdown="rzDown($event, d)" @pointermove="rzMove" @pointerup="rzUp" @pointercancel="rzUp" @keydown="rzKey" />
      <div v-else :class="['acv-rz', 'rz-' + d, { on: rzOn === d }]" :style="{ cursor: CURSOR[d] }" aria-hidden="true"
        @pointerdown="rzDown($event, d)" @pointermove="rzMove" @pointerup="rzUp" @pointercancel="rzUp" />
    </template>
    <header ref="hd" :class="['acv-hd', { grab: kind === 'dock' || kind === 'float' }]" :title="kind === 'float' ? 'Drag to move; double-click to dock' : kind === 'dock' ? 'Drag to move' : undefined"
      @pointerdown="hdDown" @pointermove="hdMove" @pointerup="hdUp" @pointercancel="hdUp" @dblclick="hdDbl">
      <div class="acv-who">
        <span class="acv-nm" :title="name"><DotTile :hue="hue" :state="tileState" :pattern="pattern" size="sm" /><b>{{ name }}</b></span>
        <Chip v-if="model" class="mdl" :text="model" :strong="false" :title="r?.model ?? undefined" />
        <Chip v-if="teamName" class="team" :text="teamName" :strong="false" />
        <Chip :class="['stt', { keep: closed.closed || (st !== 'working' && st !== 'idle') }]" :tone="TONE[st] ?? 'plain'" :text="isRoot && gone ? 'Not running' : closed.closed ? 'Closed' : WORD[st] ?? st" :strong="false" />
      </div>
      <div class="acv-act">
        <div id="ap-tab-extra" class="acv-x" />
        <button type="button" class="acv-b lbl" :aria-pressed="full" :aria-label="full ? 'Back to the side panel' : 'Expand'" :title="full ? 'Back to the side panel (Esc)' : 'Expand to the full view'" @click="toggleFull"><Icon :name="full ? 'minimize' : 'maximize'" :size="14" /><span>{{ full ? "Panel" : "Expand" }}</span></button>
        <button type="button" class="acv-b lbl" title="Details: now, trail, usage" aria-label="Details" @click="emit('details')"><Icon name="panel-right" :size="15" /><span>Details</span></button>
        <button type="button" class="acv-b ico" :title="full ? 'Close chat' : 'Close chat (Esc)'" aria-label="Close chat" @click="emit('close')"><Icon name="x" :size="16" /></button>
      </div>
    </header>
    <AgentnetChat class="acv-chat" :name="name" :is-root="isRoot" :gone="(gone || closed.closed) && !isRoot" :inert="cover || undefined" :connected="!!r && r.life === 'live' && !!r.connectedAt" :working="!!r && r.life === 'live' && r.state === 'working'" :wide="true" :panel="full" :agent-id="r?.id" @wide="onWide" @plan="emit('details')" />
    <Transition name="acv-cl" appear>
      <div v-if="cover" class="acv-cl" role="dialog" aria-modal="false" aria-labelledby="acv-cl-t" aria-describedby="acv-cl-d">
        <div class="acv-clc">
          <span class="acv-cln"><DotTile :hue="hue" state="idle" :pattern="pattern" size="sm" /><b>{{ name }}</b></span>
          <h2 id="acv-cl-t">This agent is closed</h2>
          <p id="acv-cl-d">{{ closedAt ? `Closed at ${closedAt}. ` : "" }}Its messages stay below, read only.</p>
          <div class="acv-clb">
            <button ref="coverBtn" type="button" class="acv-clp" @click="emit('close')">Close window<kbd>Esc</kbd></button>
            <button type="button" class="acv-cls" @click="keepReading = true">Keep reading</button>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
/* the side panel's surface (side-panel.css): same border, radius and shadow; the full view keeps its ring that hides the page under the corners */
.acv{position:absolute;z-index:30;display:grid;grid-template-rows:minmax(0,1fr);min-height:0;min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--panel);
  box-shadow:-24px 0 60px -12px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.06)}
/* while the box moves (play()), its own reflow stays inside it and paints nowhere else */
.acv.run{contain:layout paint}
.acv.full{inset:0;border-radius:16px;box-shadow:0 0 0 14px var(--bg)}
.acv.dock{top:12px;right:12px;bottom:12px;width:var(--cw,520px)}
/* owner 8406: in the panel and floating the composer box sits 8 px inside the panel's bottom, left and right edges */
.acv.dock .acv-chat :deep(.ac-box),.acv.float .acv-chat :deep(.ac-box){--bx:8px;padding-bottom:8px}
.acv.float{box-shadow:0 24px 70px -16px rgba(0,0,0,.6),0 0 0 .75px color-mix(in srgb,var(--ink) 8%,transparent),inset 0 1px 0 rgba(255,255,255,.06)}
.acv.sheet{top:12px;left:12px;right:12px;bottom:12px}
:root[data-theme="light"] .acv:not(.full){box-shadow:-18px 0 44px -14px rgba(22,22,26,.22),0 0 0 .75px rgba(22,22,26,.06)}
:root[data-theme="light"] .acv.float{box-shadow:0 22px 56px -16px rgba(22,22,26,.28),0 0 0 .75px rgba(22,22,26,.08)}
/* resize handles: docked, the left edge (10 px); floating, 6 px edges and 12 px corners all round, like a window. An edge
   lights a line while hovered, focused or dragged (side-panel.css look). Corners sit over the header's 12 px padding, so
   they never cover its buttons. */
.acv-rz{position:absolute;z-index:8;touch-action:none;outline:none}
.acv-rz.rz-w{left:0;top:0;bottom:0;width:10px;cursor:ew-resize}
.acv.float .acv-rz.rz-w,.acv-rz.rz-e{width:6px;top:12px;bottom:12px}
.acv-rz.rz-e{right:0}
.acv-rz.rz-n,.acv-rz.rz-s{left:12px;right:12px;height:6px}
.acv-rz.rz-n{top:0}.acv-rz.rz-s{bottom:0}
.acv-rz.rz-ne,.acv-rz.rz-nw,.acv-rz.rz-se,.acv-rz.rz-sw{width:12px;height:12px;z-index:9}
.acv-rz.rz-ne{top:0;right:0}.acv-rz.rz-nw{top:0;left:0}.acv-rz.rz-se{bottom:0;right:0}.acv-rz.rz-sw{bottom:0;left:0}
.acv-rz::after{content:"";position:absolute;border-radius:2px;background:var(--accent,#38c6d9);opacity:0;transition:opacity .15s ease-out}
.acv-rz.rz-w::after,.acv-rz.rz-e::after{top:6px;bottom:6px;width:2px}
.acv-rz.rz-w::after{left:1px}.acv-rz.rz-e::after{right:1px}
.acv-rz.rz-n::after,.acv-rz.rz-s::after{left:6px;right:6px;height:2px}
.acv-rz.rz-n::after{top:1px}.acv-rz.rz-s::after{bottom:1px}
.acv-rz:hover::after,.acv-rz:focus-visible::after,.acv-rz.on::after{opacity:.7}
.acv-rz:focus-visible::after{opacity:1;width:3px}
@media (prefers-reduced-motion:reduce){.acv-rz::after{transition:none}}
.acv.moving,.acv.moving *{user-select:none}
.acv-hd.grab{touch-action:none}
/* panel and floating are the full view, narrower (owner 8381): one row of chips over the messages. As the box narrows the
   lower-priority chips step out (team, then model), the buttons drop their words, then the status chip goes */
.acv{container-type:inline-size}
.acv:not(.full) .acv-hd{flex-wrap:nowrap}
.acv:not(.full) .acv-who{flex-wrap:nowrap}
.acv:not(.full) .acv-who > *{flex:none;white-space:nowrap}
/* a long name gives way first: it ends in an ellipsis (the full name is its title) rather than cut at the edge */
.acv-who .acv-nm,.acv:not(.full) .acv-who > .acv-nm{flex:0 1 auto;min-width:0;max-width:100%}
.acv-nm b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acv:not(.full) .acv-act{flex-wrap:nowrap}
@container (max-width:900px){.acv-who .team{display:none}}
@container (max-width:760px){.acv-who .mdl{display:none}.acv-b.lbl span{display:none}.acv-b.lbl{width:30px;padding:0;justify-content:center}}
/* the state chip gives way only while it says the plain Working or Idle; Closed, Needs you, Blocked, Not running stay, and
   the name ends in an ellipsis first (verifier 2026-11-24: a closed agent's 520 px window showed no "Closed") */
@container (max-width:660px){.acv-who .stt:not(.keep){display:none}}
/* under 500 px (the narrowest panels, the phone sheet) a name and the switch cannot share one row without cutting the name:
   the buttons and switch take a second row rather than clip text */
@container (max-width:500px){.acv:not(.full) .acv-hd{flex-wrap:wrap}.acv:not(.full) .acv-act{flex:1 1 100%;justify-content:flex-end}}
/* the full view's gutter times sit left of each reply; a narrow box has no gutter for them (the old narrow chat hid them too) */
@container (max-width:760px){.acv .acv-chat.ac :deep(.ac-at){display:none}}
/* a picked step's output: beside the list in the full view, over the list in a narrow box */
@container (max-width:760px){.acv-chat :deep(.ac-main.det){grid-template-columns:minmax(0,1fr)}.acv-chat :deep(.ac-det){position:absolute;inset:0;z-index:5;padding-top:calc(12px + var(--hd-h,0px));background:var(--panel);border-left:0}}
.acv-hd.grab .acv-who{cursor:grab}
.acv.moving .acv-hd.grab .acv-who{cursor:grabbing}
.acv-chat{grid-row:1;grid-column:1;min-height:0}
/* owner 2026-11-24: in the panel and floating, the "no connection" banner keeps the header's 14 px side inset (it used to
   run to the window's edges, and later sat on the 780 px message column, out of line with the header above it) */
.acv:not(.full) .acv-chat :deep(.ac-wrap > .ac-off){box-sizing:border-box;width:auto;margin-inline:14px}
/* a closed agent: a calm card over the chat body; the history stays dimmed behind it, the header (and its close) above */
.acv-cl{grid-row:1;grid-column:1;z-index:5;display:grid;place-items:center;padding:24px 14px;background:color-mix(in srgb,var(--panel) 72%,transparent)}
.acv-clc{display:grid;justify-items:center;gap:8px;width:min(100%,360px);padding:22px 20px 18px;border-radius:16px;background:var(--panel);text-align:center;
  box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 12%,transparent),0 18px 44px -18px rgba(0,0,0,.55)}
:root[data-theme="light"] .acv-clc{box-shadow:0 0 0 .75px rgba(22,22,26,.1),0 18px 40px -18px rgba(22,22,26,.25)}
.acv-cln{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--muted)}
.acv-cln b{color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acv-clc h2{margin:4px 0 0;font-size:17px;font-weight:650;color:var(--ink)}
.acv-clc p{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.acv-clb{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:10px}
.acv-clb button{display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border:0;border-radius:12px;font:600 13.5px/1 var(--body,inherit);cursor:pointer}
.acv-clp{background:var(--on);color:var(--panel)}
:root[data-theme="light"] .acv-clp{color:#fff}
.acv-clp kbd{padding:2px 6px;border-radius:6px;background:color-mix(in srgb,var(--panel) 22%,transparent);font:600 11px/1.2 var(--mono,ui-monospace,monospace)}
.acv-cls{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.acv-cls:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
.acv-clb button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.acv-cl-enter-active,.acv-cl-leave-active{transition:opacity .2s cubic-bezier(.23,1,.32,1)}
.acv-cl-enter-from,.acv-cl-leave-to{opacity:0}
@media (prefers-reduced-motion:reduce){.acv-cl-enter-active,.acv-cl-leave-active{transition:none}}
/* the header: no band, but a fade strong enough (90 % of the panel over the chip row, then to nothing) that text scrolled
   under the chips is mostly gone; only the chips have a surface */
.acv-hd{position:absolute;top:0;left:0;right:0;z-index:6;display:flex;align-items:flex-start;gap:10px;padding:12px 14px 18px;pointer-events:none;
  background:linear-gradient(to bottom,color-mix(in srgb,var(--panel) 90%,transparent) 0,color-mix(in srgb,var(--panel) 90%,transparent) 62%,transparent)}
.acv-hd > *{pointer-events:auto}
.acv-who{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.acv-act{flex:none;display:flex;align-items:center;gap:6px}
@media (max-width:760px){.acv-hd{flex-wrap:wrap}.acv-act{flex:1 1 100%;flex-wrap:wrap;justify-content:flex-end}}
.acv-nm{display:inline-flex;align-items:center;gap:7px;min-height:30px;padding:4px 10px 4px 5px;border-radius:12px;background:color-mix(in srgb,var(--ink) 9%,var(--panel));box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 9%,transparent),0 1px 2px rgba(0,0,0,.25);color:var(--ink);font:600 14px/1.2 var(--body);overflow-wrap:anywhere}
.acv-who :deep(.cx-chip){min-height:26px;padding:3px 9px;border-radius:12px}
/* tone chips are see-through washes in a message; over moving text they sit on the panel colour so nothing reads through */
.acv-who :deep(.cx-ok){background:color-mix(in srgb,var(--on) 13%,var(--panel))}
.acv-who :deep(.cx-warn){background:color-mix(in srgb,var(--pend) 13%,var(--panel))}
.acv-who :deep(.cx-bad){background:color-mix(in srgb,var(--bad) 12%,var(--panel))}
.acv-b{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 10px;border:0;border-radius:12px;background:color-mix(in srgb,var(--ink) 9%,var(--panel));box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 9%,transparent),0 1px 2px rgba(0,0,0,.25);color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .15s var(--ease),transform .12s var(--ease)}
.acv-b.ico{width:30px;padding:0;justify-content:center}
.acv-b:hover{background:color-mix(in srgb,var(--ink) 15%,var(--panel))}
.acv-b:active{transform:scale(.96)}
.acv-b:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
:root[data-theme="light"] .acv-nm,:root[data-theme="light"] .acv-b{background:#fff;box-shadow:0 1px 2px rgba(22,22,26,.07),0 3px 6px -3px rgba(22,22,26,.12),0 0 0 .75px rgba(22,22,26,.08)}
:root[data-theme="light"] .acv-b:hover{background:color-mix(in srgb,var(--ink) 5%,#fff)}
/* the chat's own filter, teleported here, drawn as a chip group; its Collapse is this view's close chip */
.acv-x{display:flex;align-items:center}
.acv-x:empty{display:none}
.acv-x :deep(.ac-top.tp){height:auto;padding:0}
.acv-x :deep(.ac-xp),.acv-chat :deep(.ac-xp){display:none} /* the header's Expand/Panel chip drives it */
.acv-x :deep(.ac-top.tp .ac-seg){width:auto;gap:2px;padding:2px;border:0;border-radius:12px;background:color-mix(in srgb,var(--ink) 9%,var(--panel));box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 9%,transparent),0 1px 2px rgba(0,0,0,.25)}
.acv-x :deep(.ac-top.tp .ac-seg button){flex:none;min-height:26px;padding:0 10px;border-radius:10px;font-size:12px}
:root[data-theme="light"] .acv-x :deep(.ac-seg){background:#fff;box-shadow:0 1px 2px rgba(22,22,26,.07),0 3px 6px -3px rgba(22,22,26,.12),0 0 0 .75px rgba(22,22,26,.08)}
</style>
