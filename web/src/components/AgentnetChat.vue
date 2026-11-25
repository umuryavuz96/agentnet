<script lang="ts">
// What the owner was typing to each agent, kept while the page is open, so switching agents or tabs never loses a draft.
const drafts = new Map<string, string>();
</script>

<script setup lang="ts">
// Chat tab of the agent panel: one timeline of the agent's agentnet messages and its live terminal (owner prompts, agent text,
// thinking, tool calls), merged by time (web/src/chatFeed.ts). The terminal comes from GET v1/panel/agents/:name/feed (SSE, only
// while this tab is open). The box talks as YOU by typing into the agent's terminal (POST .../prompt), or sends an agentnet
// message as root.
// Reading: the agent's replies are flowing text with no bubble; the owner is a bubble on the right. Thinking and tool calls
// between two replies fold into one line (ChatWork.vue opens it). A reply can hold agent-chosen UI blocks (chatBlocks.ts).
// Sending is instant: the bubble is in the list in the same task as the key press, the box clears and keeps the focus, and
// nothing waits for the server. The bubble carries one nonce from that moment to the transcript line, so it is never rebuilt.
// `wide` is the expanded view (the panel owns the size, see chatWide.ts): the same list with the turns (each prompt and what
// came back) on the left and the runs on the right. The list follows the bottom only while the reader is there.
// Colour says who speaks: the owner is --sel (bubble, composer, anything that sends as the owner), the agent is its team hue
// (the map's card colour), work is --on, a failure --bad, thinking --lock, an agentnet message its kind's colour.
// The composer's settings (which key sends, queue or interrupt, text size, quick prompts) live in chatPrefs.ts.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import AgentnetChatBody from "./AgentnetChatBody.vue";
import ChatWork from "./ChatWork.vue";
import FocusView from "./chat/FocusView.vue";
import StepDetail from "./chat/StepDetail.vue";
import { usePicFocus } from "./chat/picFocus";
import TrailFold from "./TrailFold.vue";
import { curJob, planSteps } from "../plan";
import AgentMark from "./AgentMark.vue";
import { agentHue } from "./chat/agentHue";
import Icon from "../ui/Icon.vue";
import Skel from "../ui/Skel.vue";
import { net, type Msg } from "../net";
import { serviceDown } from "../agentClosed";
import { api, url } from "../ui/api";
import { FILTERS, buildRows, feedItems, railLinks, lastStep, promptHistory, rail, runs, speaker, picProblem, splitImages, withImages, workLine, workSum, type FeedItem, type Filter, type PlanBit, type Row } from "../chatFeed";
import { prefs } from "../chatPrefs";
import { agentnetFeed } from "../agentnetRows";

const props = defineProps<{ name: string; isRoot: boolean; gone: boolean; connected: boolean; working: boolean; wide?: boolean; /** the step side panel is offered (only the full view has room for it); defaults to `wide` */ panel?: boolean; /** the agent's id on the map, to take its card colour */ agentId?: string }>();
const emit = defineEmits<{ wide: [on: boolean] }>();

// ---------- view state ----------
const FKEY = "agentnet.chat.filter";
const readFilter = (): Filter => { try { const v = localStorage.getItem(FKEY); return v === "messages" || v === "terminal" ? v : "all"; } catch { return "all"; } };
const filter = ref<Filter>(readFilter());
const setFilter = (f: Filter) => { filter.value = f; try { localStorage.setItem(FKEY, f); } catch { /* private window */ } };
const KINDS = ["info", "task", "question"] as const;
const SIZES = [{ id: "s", label: "Small" }, { id: "m", label: "Medium" }, { id: "l", label: "Large" }] as const;
const kind = ref<(typeof KINDS)[number]>("info");
const mode = ref<"you" | "agentnet">("you");
const text = ref(drafts.get(props.name) ?? ""), err = ref(""), noTerm = ref(""), stopping = ref(false);
const list = ref<HTMLElement | null>(null), inner = ref<HTMLElement | null>(null), ta = ref<HTMLTextAreaElement | null>(null);
const open = ref(new Set<string>());
// the trails turned away from their default (folded, or open with "Tool calls start expanded"); the setting resets them
const flip = ref(new Set<string>());
const seen = ref(new Set<string>()); // work rows opened at least once: their inside is built on first open and kept for the close motion
const stick = ref(true);
const unseen = ref(0);
const loaded = ref(false);
const flash = ref("");
// Rows that arrive after the first load rise in; `armed` keeps the first paint and filter switches still.
const fresh = ref(new Set<string>());
// older turns, asked for on scroll-up (declared here: connect() below resets it)
const older = ref<"idle" | "busy" | "none">("idle");
let prepending = false;
// the next older page, fetched ahead (loadOlder below); PAGE items per call, set off within PREFETCH_SCREENS of the top
const PAGE = 200, PREFETCH_SCREENS = 1.5;
let buffer: { agent: string; before: string; items: FeedItem[]; more: boolean } | null = null;
let fetching: Promise<void> | null = null;
let holdId = 0;
const known = new Set<string>();
let armed = false, armT = 0, knownFilter: Filter = filter.value;
let hist = -1, draft = ""; // place in the owner's earlier prompts (ArrowUp), and the text that was in the box before

// ---------- the live terminal feed ----------
const items = shallowRef(new Map<string, FeedItem>());
const serverPending = shallowRef<FeedItem[]>([]);
const local = shallowRef<FeedItem[]>([]);
const localMsgs = shallowRef<Msg[]>([]);
const hidden = ref(new Set<string>()); // failed sends the owner discarded
let es: EventSource | null = null;
function connect() {
  es?.close(); es = null;
  items.value = new Map(); serverPending.value = []; local.value = []; localMsgs.value = []; hidden.value = new Set();
  older.value = "idle"; buffer = null; holdId++; known.clear(); armed = false; loaded.value = false; unseen.value = 0; fresh.value = new Set();
  const arm = (ms: number) => { clearTimeout(armT); armT = window.setTimeout(() => { armed = true; loaded.value = true; }, ms); };
  arm(3000);
  const name = props.name;
  es = new EventSource(url(`v1/panel/agents/${encodeURIComponent(name)}/feed`));
  // A reconnect sends `reset` again: the items are merged, so the older pages the reader loaded stay and nothing moves.
  es.addEventListener("reset", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { items: FeedItem[]; pending: FeedItem[] };
    if (loaded.value && items.value.size) { const m = new Map(items.value); for (const i of d.items) m.set(i.id, i); items.value = m; }
    else items.value = new Map(d.items.map((i) => [i.id, i]));
    serverPending.value = d.pending;
    if (!loaded.value) { loaded.value = true; arm(500); }
    // a short window (a transcript whose last lines are huge holds only a few items) fills the screen without a scroll
    void nextTick(() => prefetch().then(nearTop));
  });
  es.addEventListener("items", (e) => { const m = new Map(items.value); for (const i of JSON.parse((e as MessageEvent).data) as FeedItem[]) m.set(i.id, i); items.value = m; });
  es.addEventListener("pending", (e) => { serverPending.value = JSON.parse((e as MessageEvent).data); });
}
watch(() => props.name, (n, o) => {
  if (o !== undefined) { drafts.set(o, text.value); text.value = drafts.get(n) ?? ""; }
  stick.value = true; open.value = new Set(); flip.value = new Set(); seen.value = new Set(); err.value = ""; noTerm.value = ""; mode.value = "you"; hist = -1;
  connect();
}, { immediate: true });
watch(text, (t) => { if (t) drafts.set(props.name, t); else drafts.delete(props.name); });
onBeforeUnmount(() => { es?.close(); es = null; clearTimeout(armT); ro?.disconnect(); removeEventListener("keydown", onEsc, true); removeEventListener("pointerdown", onAway, true); removeEventListener("keydown", onCfgEsc, true); });

// ---------- who is who ----------
// The agent's hue is the one its card has on the map: one shared rule (chat/agentHue.ts), so root is blue 212 here as there.
const hue = computed(() => agentHue(props.name));

// ---------- timeline ----------
// the plan steps of the agent's current job, so a run's calls sit under the step that was open
// net.agents is keyed by id (name#gen): find the open agent's row by name, the live one first (as AgentnetCrewRows.vue).
const agentRow = computed(() => Object.values(net.agents).find((a) => a.name === props.name && a.life !== "gone") ?? Object.values(net.agents).find((a) => a.name === props.name));
const plan = computed<PlanBit[]>(() => { const j = curJob(agentRow.value ?? {}); return j && !j.legacy ? planSteps(j).all.map((s) => ({ n: s.n, job: j.id, text: s.text, status: s.status, ...(s.activatedAt != null ? { at: s.activatedAt } : {}), ...(s.closedAt != null ? { end: s.closedAt } : {}), proofs: s.status === "done" ? s.evidence.map((e) => e.value).filter(Boolean) : [] })) : []; });
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
// While older transcript pages are still to come, a message from before the oldest loaded item waits for its page: shown now
// it would sit above that page's rows and the page would land under it, moving everything the reader is looking at.
const floor = computed(() => (older.value === "none" ? -Infinity : (items.value.values().next().value as FeedItem | undefined)?.ts ?? -Infinity));
const realMsgs = computed<Msg[]>(() => net.messages.filter((m) => (m.from === props.name || m.to === props.name) && m.at >= floor.value).slice(-60));
// A local copy of a root message leaves the moment the real one is in the stream.
const waitingMsgs = computed(() => localMsgs.value.filter((l) => !realMsgs.value.some((m) => m.from === "root" && m.body === l.body && m.at >= l.at - 5000)));
const msgs = computed<Msg[]>(() => [...realMsgs.value, ...waitingMsgs.value]);
// The page's own copy wins over the server's for the same nonce. A send the server lists is already typed into the terminal.
const pend = computed(() => {
  const s = new Set<string>();
  return [...local.value, ...serverPending.value.map((p) => ({ ...p, sending: false }))].filter((p) => p.nonce && !hidden.value.has(p.nonce) && !s.has(p.nonce) && s.add(p.nonce));
});
// agentnet traffic (messages, notices, deliveries, the agent's own agentnet calls) comes in as trail rows (agentnetRows.ts):
// only the owner's prompts and the agent's own words are chat rows.
// A run that holds only thoughts whose text the transcript did not keep says nothing: it is left out.
const plain = computed(() => buildRows([], agentnetFeed(msgs.value, feedItems(items.value, pend.value), filter.value, props.name, plan.value), "all").filter((r) => r.type !== "work" || r.steps > 0 || r.running || r.items.some((i) => !!i.text)));
const rows = computed(() => {
  const r = plain.value, run = runs(r, day), rl = rail(r);
  return r.map((row, i) => ({ row, div: i === 0 || day(r[i - 1]!.at) !== day(row.at) ? day(row.at) : null, first: run[i]!.first, rl: rl[i]! }));
});
// Runs of one plan step split by text join into one trail: later runs go on without a second header, only the last shows what is next.
const links = computed(() => railLinks(plain.value, plan.value));
/** What the owner said after each agent reply (null = nothing yet): a reply's choice buttons lock once it is answered. */
const answers = computed(() => {
  const m = new Map<string, string | null>();
  let next: string | null = null;
  for (let i = plain.value.length - 1; i >= 0; i--) {
    const r = plain.value[i]!;
    if (r.type === "owner") next = r.text; else if (r.type === "assistant") m.set(r.key, next);
  }
  return m;
});
watch(rows, (rs) => {
  const quiet = !armed || prepending || knownFilter !== filter.value;
  knownFilter = filter.value;
  const add: string[] = [];
  let bubbles = 0;
  for (const { row } of rs) {
    if (known.has(row.key)) continue;
    known.add(row.key);
    if (!quiet && speaker(row) !== null) { add.push(row.key); if (row.type !== "owner") bubbles++; }
  }
  if (!add.length) return;
  fresh.value = new Set([...fresh.value, ...add]);
  setTimeout(() => { const s = new Set(fresh.value); for (const k of add) s.delete(k); fresh.value = s; }, 500);
  if (!stick.value) unseen.value += bubbles;
}, { immediate: true });
const toggle = (k: string) => { const s = new Set(open.value); s.has(k) ? s.delete(k) : s.add(k); open.value = s; };
// A trail is one line until the owner opens it, a running one too (canvas States: the folded trail with the skeleton bars
// under it while the agent works).
// With "Tool calls start expanded" on (owner 8404) every trail starts open; one the owner folds by hand stays folded
// (kept in `flip`) until reload.
watch(() => prefs.toolsOpen, () => { flip.value = new Set(); });
const isOpen = (w: Extract<Row, { type: "work" }>) => flip.value.has(w.key) !== prefs.toolsOpen;
// Canvas Motion "Trail or a call row opens": the new content fades up 6 px and everything below slides from its old place,
// 190 ms on cubic-bezier(.23,1,.32,1), transform and opacity only (FLIP); reduced motion: no slide.
const OPEN_MOTION: KeyframeAnimationOptions = { duration: 190, easing: "cubic-bezier(.23,1,.32,1)" };
function slideBelow(k: string, change: () => void) {
  const row = list.value?.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`);
  if (!row || !list.value || matchMedia("(prefers-reduced-motion: reduce)").matches) { change(); return; }
  const below = Array.from(list.value.querySelectorAll<HTMLElement>("[data-k], .ac-th"))
    .filter((e) => row.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING && !row.contains(e) && !e.parentElement?.closest("[data-k]"));
  const tops = below.map((e) => e.getBoundingClientRect().top);
  change();
  nextTick(() => {
    // only rows on screen before or after move; the rest would animate unseen
    below.forEach((e, i) => { const now = e.getBoundingClientRect().top, d = Math.round(tops[i]! - now); if (d && Math.min(tops[i]!, now) < innerHeight) e.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], OPEN_MOTION); });
    row.querySelector<HTMLElement>(".ac-gb.is-open > div")?.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], OPEN_MOTION);
  });
}
const toggleWork = (w: Extract<Row, { type: "work" }>) => {
  const k = w.key;
  if (!seen.value.has(k)) seen.value = new Set(seen.value).add(k);
  if (!isOpen(w)) stick.value = false;
  slideBelow(k, () => { const s = new Set(flip.value); s.has(k) ? s.delete(k) : s.add(k); flip.value = s; });
};
const empty = computed(() => !rows.value.length);
/** Show more / Show less on a long body. Opening lets go of the bottom so the reader keeps their place; closing brings the bubble back into view. */
function toggleBody(k: string) {
  const opening = !open.value.has(k);
  toggle(k);
  if (opening) { stick.value = false; return; }
  nextTick(() => list.value?.querySelector(`[data-k="${CSS.escape(k)}"]`)?.scrollIntoView({ block: "nearest" }));
}
const SEND_LABEL = { sending: "Sending", sent: "Delivered to the terminal", shown: "In the terminal", failed: "Not sent" } as const;

// Only the reader lets go of the bottom: a scroll with no wheel, touch, key or pointer just before it is ours (a smooth
// follow passes through "far from the bottom" on its way down) and must not unstick the list.
let userAt = 0;
const userInput = () => { userAt = performance.now(); };
function toEnd(smooth = false) {
  nextTick(() => {
    const el = list.value;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const s = smooth && gap < el.clientHeight * 1.5 && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: s ? "smooth" : "auto" });
  });
}
// The stream carries the newest items only. The page asks for the page before them as soon as the list is there and keeps
// it ready (`buffer`); when the reader comes within PREFETCH_SCREENS of the top it goes in above them at once and the next
// page is asked for. The row under the reader's eye stays at the same pixel: its place is taken before the change and the
// list is moved by what changed above it (the anchor-row method; Safari has no overflow-anchor), then held there while late
// layout settles. Sending never waits on this.
const firstKey = () => items.value.keys().next().value as string | undefined;
function prefetch(): Promise<void> {
  const agent = props.name, before = firstKey();
  if (fetching || older.value === "none" || !before || (buffer && buffer.before === before)) return fetching ?? Promise.resolve();
  fetching = api<{ items: FeedItem[]; more: boolean }>(`v1/panel/agents/${encodeURIComponent(agent)}/history?before=${encodeURIComponent(before)}&n=${PAGE}`)
    .then((j) => { if (agent !== props.name || before !== firstKey()) return; if (!j.items.length && !j.more) older.value = "none"; else buffer = { agent, before, items: j.items, more: j.more }; })
    .catch(() => { /* the next scroll asks again */ })
    .finally(() => { fetching = null; });
  return fetching;
}
/** The row to hold still: the first one on screen whose key a new page cannot change. A trail's key is its first call's id,
 *  so the trail at the top of the loaded part takes a new key when older calls join it: it is skipped while another row is in view. */
function steady(el: HTMLElement): { k: string } | null {
  const r = el.getBoundingClientRect(); let first: string | null = null;
  for (const n of el.querySelectorAll<HTMLElement>("[data-k]")) {
    const b = n.getBoundingClientRect();
    if (b.bottom <= r.top + 1) continue;
    first ??= n.dataset.k!; // a row below the view still holds the place when only a trail is on screen
    if (!n.dataset.k!.startsWith("w:")) return { k: n.dataset.k! };
  }
  return first ? { k: first } : null;
}
/** Where a row sits in the list's content (not on screen): only layout above it changes this, never the reader's scroll. */
const contentY = (el: HTMLElement, n: HTMLElement) => n.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
async function loadOlder() {
  const el = list.value;
  if (older.value === "busy" || older.value === "none" || !loaded.value || !el || !firstKey()) return;
  older.value = "busy";
  const agent = props.name;
  if (!buffer || buffer.before !== firstKey()) await prefetch();
  const page = buffer;
  if (agent !== props.name || !page || page.before !== firstKey()) { if (agent === props.name) older.value = "idle"; return; }
  buffer = null;
  const at = steady(el), anchor = at && el.querySelector<HTMLElement>(`[data-k="${CSS.escape(at.k)}"]`);
  let y0 = anchor ? contentY(el, anchor) : 0;
  prepending = true;
  items.value = new Map([...page.items.map((i) => [i.id, i] as const), ...items.value]);
  older.value = page.more ? "idle" : "none";
  await nextTick();
  prepending = false;
  // same task as the DOM change, so no frame paints in between
  const keep = () => { const n = at && el.querySelector<HTMLElement>(`[data-k="${CSS.escape(at.k)}"]`); if (!n) return; const d = contentY(el, n) - y0; if (Math.abs(d) >= 0.5) { el.scrollTop += d; y0 += d; } };
  keep();
  // pictures, code blocks and fonts can still change height above the anchor for a moment: follow it for 600 ms
  const id = ++holdId, t0 = performance.now();
  const hold = () => { if (id !== holdId || stick.value) return; keep(); if (performance.now() - t0 < 600) requestAnimationFrame(hold); };
  requestAnimationFrame(hold);
  if (page.more) void prefetch();
  // still near the top (a short page): go on
  if (older.value === "idle") nearTop();
}
/** Within PREFETCH_SCREENS of the top (or a list too short to scroll): the next page goes in. */
function nearTop() { const el = list.value; if (el && el.scrollTop < el.clientHeight * PREFETCH_SCREENS) void loadOlder(); }
function onScroll() {
  const el = list.value;
  if (!el) return;
  nearTop();
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) { stick.value = true; unseen.value = 0; }
  else if (performance.now() - userAt < 1500) stick.value = false;
}
// Follow anything that changes the height (a new row, text growing in place, the sheet resizing), not only new rows.
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => { if (stick.value) toEnd(armed && !resizing); });
  if (inner.value) ro.observe(inner.value);
  if (list.value) ro.observe(list.value);
});
watch(() => props.name, () => toEnd());
watch(filter, () => { stick.value = true; unseen.value = 0; toEnd(); });
const pill = computed(() => (unseen.value ? `${unseen.value} new ${unseen.value === 1 ? "message" : "messages"}` : "Latest"));

// ---------- expand / collapse: the reader keeps their place and the draft ----------
let resizing = false;
/** The first row on screen and how far its top is from the list's top. */
function place(): { k: string; dy: number } | null {
  const el = list.value; if (!el) return null;
  const top = el.getBoundingClientRect().top;
  for (const n of el.querySelectorAll<HTMLElement>("[data-k]")) { const r = n.getBoundingClientRect(); if (r.bottom > top + 1) return { k: n.dataset.k!, dy: r.top - top }; }
  return null;
}
// The place is taken at the click, before the panel changes size: by the time the `wide` prop arrives the panel is already
// at its new width and the rows above have re-wrapped.
let held: { k: string; dy: number } | null = null;
function askWide(on: boolean) { held = stick.value ? null : place(); emit("wide", on); }
watch(() => props.wide, async () => {
  const at = held, t = userAt;
  resizing = true;
  await nextTick();
  // Text re-wraps and long replies unfold at the new width, some of it a frame or a transition later: hold the place until it settles.
  const hold = () => {
    const el = list.value;
    if (!el || t !== userAt) return;
    const n = at && el.querySelector<HTMLElement>(`[data-k="${CSS.escape(at.k)}"]`);
    if (n) el.scrollTop += n.getBoundingClientRect().top - el.getBoundingClientRect().top - at!.dy; else if (!at) el.scrollTop = el.scrollHeight;
  };
  hold(); requestAnimationFrame(hold); setTimeout(hold, 120); setTimeout(() => { hold(); resizing = false; }, 360);
  if (props.wide) { addEventListener("keydown", onEsc, true); ta.value?.focus({ preventScroll: true }); } else removeEventListener("keydown", onEsc, true);
}, { flush: "pre" });
/** Esc brings the expanded chat back to the panel; the page's own Esc (close the panel) must not also fire. Open settings take it first (onCfgEsc). */
function onEsc(e: KeyboardEvent) { if (e.key !== "Escape" || e.defaultPrevented || cfg.value || (e.target instanceof Element && e.target.closest(".fv"))) return; e.preventDefault(); e.stopPropagation(); if (pickedId.value) pickedId.value = null; else askWide(false); }
onMounted(() => { if (props.wide) addEventListener("keydown", onEsc, true); });

// ---------- the rail and the step beside it ----------
type Work = Extract<Row, { type: "work" }>;
const works = computed(() => plain.value.filter((r): r is Work => r.type === "work"));
const lastWork = computed(() => works.value[works.value.length - 1] ?? null);
/** The agent's last words in the turn that is going on: its node on the rail is the live one. */
const curKey = computed(() => {
  if (!props.working) return "";
  for (let i = plain.value.length - 1; i >= 0; i--) { const r = plain.value[i]!; if (r.type === "owner") return ""; if (r.type === "assistant") return r.key; }
  return "";
});
/** The stretch of the rail that is going on now: its head shows the working mark. */
const liveHead = computed(() => { if (!props.working) return ""; let k = ""; for (const r of rows.value) if (r.rl.head) k = r.row.key; const last = rows.value[rows.value.length - 1]; return last?.rl.on ? k : ""; });
/** The step whose output shows beside the conversation in the large view. It pushes the column over, it never covers it. */
const pickedId = ref<string | null>(null);
const canPanel = computed(() => props.panel ?? !!props.wide);
const picked = computed(() => { const id = pickedId.value; if (!id) return null; for (const w of works.value) for (const i of w.items) if (i.id === id) return i; return null; });
const pick = (i: FeedItem) => { pickedId.value = pickedId.value === i.id ? null : i.id; };
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
const slot = ref(false); // the panel's tab row has a place for the filter and Collapse in the large view
onMounted(() => { slot.value = !!document.getElementById("ap-tab-extra"); });
const nowLine = computed(() => (props.working && lastWork.value?.running ? workLine(lastWork.value) : ""));

// the banner: only when the service stream itself is down (an agent that is not running is not "no connection")
// It waits 1.5 s before it shows: a hidden tab closes the stream and reopens it on show, which must not flash the banner.
const offline = ref(false);
let offT: ReturnType<typeof setTimeout> | undefined;
watch(() => serviceDown(net), (down) => { clearTimeout(offT); if (!down) offline.value = false; else offT = setTimeout(() => (offline.value = true), 1_500); }, { immediate: true });
onBeforeUnmount(() => clearTimeout(offT));

// ---------- the box ----------
const agentnetOff = computed(() => (props.gone ? "Retired: read-only history" : !props.connected ? "Not connected" : null));
const youOff = computed(() => (props.gone ? "Retired: read-only history" : noTerm.value || null));
const off = computed(() => (mode.value === "you" ? youOff.value : agentnetOff.value));
const cut = computed(() => props.working && prefs.busy === "interrupt" && !props.isRoot && mode.value === "you");
const placeholder = computed(() => off.value ?? (mode.value === "agentnet" ? `Message ${props.name} as root` : !props.working ? `Message ${props.name} as you` : cut.value ? `Message ${props.name} (stops the turn first)` : `Message ${props.name} (queued)`));
// the route takes 8 kB of text; the count shows only when the draft is near it
const LIMIT = 8 * 1024;
// ---------- pictures: pasted or dropped into the box, kept by the service, sent as a path the agent can read ----------
interface Pic { id: string; src: string; path?: string; error?: string }
const PIC_MAX = 10 * 1024 * 1024, PICS_MAX = 6;
const pics = ref<Pic[]>([]);
const picsBusy = computed(() => pics.value.some((p) => !p.path && !p.error));
const picsReady = computed(() => pics.value.filter((p) => p.path).map((p) => p.path!));
const pf = usePicFocus(); // a sent or read picture opens large in place, not in a new tab
const imgUrl = (path: string) => url(`v1/panel/agents/${base()}/image?path=${encodeURIComponent(path)}`);
const setPic = (id: string, p: Partial<Pic>) => { pics.value = pics.value.map((x) => (x.id === id ? { ...x, ...p } : x)); };
function dropPic(id: string) { const p = pics.value.find((x) => x.id === id); if (p) URL.revokeObjectURL(p.src); pics.value = pics.value.filter((x) => x.id !== id); ta.value?.focus(); }
/** The picture shows in the box at once; the upload runs beside it, so by Send its path is known and sending stays instant. */
function addPics(files: Iterable<File>) {
  for (const f of files) {
    const id = newNonce(), agent = props.name, error = picProblem(f.type, f.size, pics.value.length, PICS_MAX, PIC_MAX);
    if (error && pics.value.length >= PICS_MAX) { err.value = error; continue; }
    pics.value = [...pics.value, { id, src: URL.createObjectURL(f), ...(error ? { error } : {}) }];
    if (error) continue;
    void fetch(url(`v1/panel/agents/${encodeURIComponent(agent)}/image`), { method: "POST", headers: { "Content-Type": f.type }, body: f })
      .then(async (r) => { const j = (await r.json().catch(() => ({}))) as { path?: string; detail?: string }; if (agent === props.name) setPic(id, r.ok && j.path ? { path: j.path } : { error: j.detail ?? `HTTP ${r.status}` }); })
      .catch(() => { if (agent === props.name) setPic(id, { error: "agentnet did not answer" }); });
  }
}
const imageFiles = (d: DataTransfer | null) => [...(d?.files ?? [])].filter((f) => f.type.startsWith("image/"));
function onPaste(e: ClipboardEvent) { const f = imageFiles(e.clipboardData); if (!f.length || off.value) return; e.preventDefault(); addPics(f); }
const dragging = ref(false);
function onDrop(e: DragEvent) { dragging.value = false; const f = imageFiles(e.dataTransfer); if (!f.length) return; e.preventDefault(); if (!off.value) addPics(f); }
function onDragOver(e: DragEvent) { if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return; e.preventDefault(); dragging.value = true; }
watch(() => props.name, () => { for (const p of pics.value) URL.revokeObjectURL(p.src); pics.value = []; });
const bytes = computed(() => (text.value.length * 3 < LIMIT * 0.75 ? 0 : new TextEncoder().encode(text.value).length));
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "\u2318" : "Ctrl";
// the attach button opens the file picker; what it picks goes the same way as a paste
const fileIn = ref<HTMLInputElement | null>(null);
function onPick(e: Event) { const el = e.target as HTMLInputElement; const f = [...(el.files ?? [])].filter((x) => x.type.startsWith("image/")); if (f.length && !off.value) addPics(f); el.value = ""; ta.value?.focus(); }
// ---------- the composer floats over the list: the list keeps room under its last row for the box's height ----------
const box = ref<HTMLElement | null>(null), boxH = ref(0);
let boxRo: ResizeObserver | null = null;
onMounted(() => { if (!box.value) return; boxRo = new ResizeObserver(() => { const h = box.value?.offsetHeight ?? 0; if (h !== boxH.value) { const keep = stick.value; boxH.value = h; if (keep) toEnd(); } }); boxRo.observe(box.value); });
onBeforeUnmount(() => boxRo?.disconnect());

// ---------- composer settings ----------
const cfg = ref(false), cfgEl = ref<HTMLElement | null>(null), cfgBtn = ref<HTMLElement | null>(null);
function onAway(e: PointerEvent) { const t = e.target as Node; if (!cfgEl.value?.contains(t) && !cfgBtn.value?.contains(t)) cfg.value = false; }
// Esc closes the settings first (before the large view or the panel hears it) and gives the focus back to the button.
function onCfgEsc(e: KeyboardEvent) { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); cfg.value = false; cfgBtn.value?.focus(); }
watch(cfg, (on) => { for (const [ev, fn] of [["pointerdown", onAway], ["keydown", onCfgEsc]] as const) (on ? addEventListener : removeEventListener)(ev, fn as EventListener, true); });
watch(mode, () => { err.value = ""; noTerm.value = ""; });
const base = () => encodeURIComponent(props.name);
/** Works on plain http too, where crypto.randomUUID is missing. */
const newNonce = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return [...a].map((n) => n.toString(36)).join("-"); };
const patch = (nonce: string, p: Partial<FeedItem>) => { local.value = local.value.map((i) => (i.nonce === nonce ? { ...i, ...p } : i)); };

/** Type into the agent's terminal. The bubble is already on screen; this only moves its state. */
async function post(agent: string, nonce: string, body: string) {
  const mineStill = () => agent === props.name;
  try {
    const r = await fetch(url(`v1/panel/agents/${encodeURIComponent(agent)}/prompt`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body, nonce }) });
    if (!mineStill()) return;
    if (r.ok) { patch(nonce, { sending: false }); return; }
    const j = (await r.json().catch(() => ({}))) as { detail?: string; title?: string; code?: string };
    if (j.code === "NO_TERMINAL") noTerm.value = j.detail ?? "This agent runs in a terminal agentnet cannot type into.";
    patch(nonce, { sending: false, failed: true, error: j.detail ?? j.title ?? `HTTP ${r.status}` });
  } catch { if (mineStill()) patch(nonce, { sending: false, failed: true, error: "agentnet did not answer" }); }
}
/** Interrupt, then type: the owner chose that a send while the agent works stops the turn first. A stop that fails still sends (the terminal queues it). */
async function stopThen(agent: string, nonce: string, body: string) {
  try { await api(`v1/panel/agents/${encodeURIComponent(agent)}/stop`, { method: "POST" }); await new Promise((r) => setTimeout(r, 350)); } catch { /* queued instead */ }
  await post(agent, nonce, body);
}
/** Send the box (or `asked`: a choice the owner picked, which always goes as the owner, or a quick prompt, which follows the
 *  composer's mode). Nothing here waits: the row is in the list before this returns. */
function send(asked?: string, how: "you" | "mode" = "you") {
  const typed = (asked ?? text.value).trim();
  if (asked == null && picsBusy.value) return; // a picture is still on its way; Send is off until it lands
  const body = asked == null ? withImages(typed, picsReady.value) : typed;
  const asYou = mode.value === "you" || (asked != null && how === "you");
  if (!body || (asYou ? youOff.value : agentnetOff.value)) return;
  err.value = ""; hist = -1;
  if (asked == null) { text.value = ""; for (const p of pics.value) URL.revokeObjectURL(p.src); pics.value = []; }
  stick.value = true; unseen.value = 0;
  if (!asYou) { void sendMsg(body, kind.value); return; }
  const nonce = newNonce();
  local.value = [...local.value, { id: `sending:${nonce}`, ts: Date.now(), kind: "owner", text: body, nonce, sending: true }];
  void (cut.value ? stopThen(props.name, nonce, body) : post(props.name, nonce, body));
}
function retry(r: Extract<Row, { type: "owner" }>) {
  if (!r.nonce) return;
  noTerm.value = "";
  if (local.value.some((i) => i.nonce === r.nonce)) patch(r.nonce, { sending: true, failed: false, error: undefined });
  else local.value = [...local.value, { id: `sending:${r.nonce}`, ts: r.at, kind: "owner", text: r.text, nonce: r.nonce, sending: true }];
  void post(props.name, r.nonce, r.text);
}
function discard(r: Extract<Row, { type: "owner" }>) {
  if (!r.nonce) return;
  local.value = local.value.filter((i) => i.nonce !== r.nonce);
  hidden.value = new Set(hidden.value).add(r.nonce);
  if (!text.value) text.value = r.text;
  ta.value?.focus();
}
/** An agentnet message as root: shown at once from a local copy, which the real one replaces when the stream has it. */
async function sendMsg(body: string, k: string) {
  const agent = props.name, copy: Msg = { id: null, from: "root", to: agent, kind: k, body, at: Date.now() };
  localMsgs.value = [...localMsgs.value, copy];
  try { await api(`v1/panel/agents/${encodeURIComponent(agent)}/message`, { method: "POST", body: { body, kind: k } }); }
  catch (e) {
    if (agent !== props.name) return;
    localMsgs.value = localMsgs.value.filter((m) => m !== copy);
    err.value = `Not sent: ${(e as Error).message}`;
    if (!text.value) text.value = body;
  }
}
/** Send now: the message waits in the agent's queue. The server stops the step (the Stop key) and Claude Code then takes the queued text. */
const nowing = ref(new Set<string>()), nowErr = ref(new Map<string, string>());
async function sendNow(r: Extract<Row, { type: "owner" }>) {
  const n = r.nonce;
  if (!n || nowing.value.has(n)) return;
  nowing.value = new Set(nowing.value).add(n); nowErr.value.delete(n);
  try { await api(`v1/panel/agents/${base()}/send-now`, { body: { nonce: n } }); }
  catch (e) { if (!/already/i.test((e as Error).message)) nowErr.value = new Map(nowErr.value).set(n, `Not sent now: ${(e as Error).message}`); }
  finally { const s = new Set(nowing.value); s.delete(n); nowing.value = s; }
}
async function stop() {
  if (stopping.value) return;
  stopping.value = true; err.value = "";
  try { await api(`v1/panel/agents/${base()}/stop`, { method: "POST" }); } catch (e) { err.value = (e as Error).message; }
  finally { stopping.value = false; }
}

// Earlier prompts: ArrowUp at the very start of the box walks back, ArrowDown at the end walks forward to the draft.
function onKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "Enter" && (prefs.sendKey === "enter" ? !e.shiftKey : e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); return; }
  const el = e.target as HTMLTextAreaElement;
  if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0 && (hist >= 0 || !text.value)) {
    const h = promptHistory(plain.value);
    if (hist + 1 >= h.length) return;
    e.preventDefault();
    if (hist < 0) draft = text.value;
    text.value = h[++hist]!;
    nextTick(() => el.setSelectionRange(0, 0));
  } else if (e.key === "ArrowDown" && hist >= 0 && el.selectionStart === el.value.length) {
    e.preventDefault();
    text.value = --hist < 0 ? draft : promptHistory(plain.value)[hist]!;
  }
}
const rowKey = (r: Row) => r.key;
</script>

<template>
  <div :class="['ac', 'sz-' + prefs.size, { wide }]" :style="{ '--hue': hue, '--box-h': boxH + 'px' }">
    <Teleport defer to="#ap-tab-extra" :disabled="!wide || !slot">
      <div :class="['ac-top', { tp: wide && slot }]">
        <div class="ac-seg" role="radiogroup" aria-label="Show">
          <button v-for="f in FILTERS" :key="f.id" type="button" role="radio" :aria-checked="filter === f.id" :class="{ on: filter === f.id }" @click="setFilter(f.id)">{{ f.label }}</button>
        </div>
        <button type="button" class="ac-xp" :aria-pressed="!!wide" :title="wide ? 'Back to the panel (Esc)' : 'Expand the chat'" @click="askWide(!wide)">
          <Icon :name="wide ? 'minimize' : 'maximize'" :size="16" /><span>{{ wide ? "Collapse" : "Expand" }}</span>
        </button>
      </div>
    </Teleport>

    <div :class="['ac-main', { det: canPanel && !!picked }]">
      <div class="ac-col">
        <div class="ac-wrap">
          <p v-if="offline && !gone" class="ac-off" role="status"><span class="ac-offi" aria-hidden="true"><Icon name="triangle-alert" :size="16" /></span><b>No connection to the agentnet service</b><span>Replies below are as of the last update. New ones show when the connection is back.</span></p>
          <div ref="list" class="ac-list" role="log" aria-live="polite" :aria-label="`Chat with ${name}`" @scroll.passive="onScroll" @wheel.passive="userInput" @touchmove.passive="userInput" @pointerdown.passive="userInput" @keydown="userInput">
            <div ref="inner" class="ac-in">
              <p v-if="!empty && older !== 'none'" :class="['ac-old', { on: older === 'busy' }]" role="status"><template v-if="older === 'busy'"><i class="ac-arc" aria-hidden="true" />Loading earlier messages</template></p>
              <Skel v-if="empty && !loaded" :lines="3" class="ac-load" />
              <div v-else-if="empty" class="ac-none">
                <p class="ac-nh">{{ filter === "terminal" ? "No terminal activity yet" : "No messages yet" }}</p>
                <p>{{ filter === "terminal" ? `What ${name} types and runs shows here, live.` : gone && !isRoot ? `${name} is retired and left no messages.` : `Write below to message ${name}.` }}</p>
              </div>
              <template v-for="{ row, div, first, rl } in rows" :key="rowKey(row)">
                <p v-if="div" class="ac-day"><span>{{ div }}</span></p>

                <div v-if="row.type === 'owner'" :data-k="row.key" :class="['ac-m', 'out', 'you', 'st-' + row.state, { cont: !first, 'is-new': fresh.has(row.key), flash: flash === row.key }]">
                  <p v-if="first" class="ac-h"><span class="ac-who">You</span><time>{{ time(row.at) }}</time></p>
                  <article class="ac-bub" :title="first ? undefined : time(row.at)">
                    <p v-if="splitImages(row.text).images.length" class="ac-bp ac-span"><a v-for="p in splitImages(row.text).images" :key="p" :href="imgUrl(p)" target="_blank" rel="noopener" role="button" aria-haspopup="dialog" :title="p" @click="pf.open($event, imgUrl(p), p)" @keydown.space.prevent="pf.open($event, imgUrl(p), p)"><img :src="imgUrl(p)" alt="Picture sent with this prompt" loading="lazy" /></a></p>
                    <AgentnetChatBody v-if="splitImages(row.text).text" :text="splitImages(row.text).text" :open="open.has(row.key)" fold @toggle="toggleBody(row.key)" />
                    <span class="ac-tick" role="img" :aria-label="SEND_LABEL[row.state]" :title="SEND_LABEL[row.state]"><Icon :name="row.state === 'sending' ? 'clock' : row.state === 'failed' ? 'triangle-alert' : 'check'" :size="13" /></span>
                  </article>
                  <p v-if="row.state === 'sent' && working && !gone" class="ac-wait" aria-live="polite"><span>{{ nowing.has(row.nonce ?? "") ? "Stopping the step to send it" : nowErr.get(row.nonce ?? "") ?? `Waits for ${name} to finish its step` }}</span><button v-if="!isRoot" type="button" :disabled="nowing.has(row.nonce ?? '')" title="Stop the current step and send this now" @click="sendNow(row)"><Icon name="arrow-up" :size="13" />Send now</button></p>
                  <p v-if="row.state === 'failed'" class="ac-fail" role="alert"><span>Not sent{{ row.error ? `: ${row.error}` : "" }}</span><button type="button" @click="retry(row)"><Icon name="rotate-ccw" :size="13" />Retry</button><button type="button" @click="discard(row)">Discard</button></p>
                </div>

                <template v-else>
                  <p v-if="rl.head" :class="['ac-th', { live: liveHead === row.key }]"><AgentMark :name="name" :state="liveHead === row.key ? 'working' : 'idle'" /><span class="ac-who">{{ name }}</span><span v-if="liveHead === row.key" class="ac-st">Working</span><time>{{ time(row.at) }}</time></p>

                  <div v-if="row.type === 'assistant'" :data-k="row.key" :class="['ac-m', 'in', 'ag', 'rl', { end: rl.end, cur: curKey === row.key, 'is-new': fresh.has(row.key) }]">
                    <time v-if="!rl.head" class="ac-at">{{ time(row.at) }}</time>
                    <article class="ac-bub" :title="time(row.at)">
                      <AgentnetChatBody :text="row.text" :open="open.has(row.key)" :fold="!wide" blocks :answer="answers.get(row.key)" :can-send="!youOff" :from="name" @toggle="toggleBody(row.key)" @pick="send" @edit="(t) => (text = t)" />
                    </article>
                  </div>

                  <div v-else-if="row.type === 'work'" :data-k="row.key" :class="['ac-w', 'rl', { end: rl.end, running: row.running, bad: row.failed > 0, flash: flash === row.key }]">
                    <TrailFold :items="row.items" :running="row.running" :failed="row.failed" :ms="row.ms" :word="workLine(row)" :open="isOpen(row)" :controls="'w-' + row.key" :title="time(row.at)" @toggle="toggleWork(row)" />
                    <div :id="'w-' + row.key" class="ac-gb" :class="{ 'is-open': isOpen(row) }" :inert="!isOpen(row) || undefined">
                      <div><ChatWork v-if="row.running || isOpen(row) || seen.has(row.key)" :items="row.items" :plan="plan" :cont="links.get(row.key)?.cont" :tail="links.get(row.key)?.tail ?? true" :pick="canPanel" :picked="pickedId" :agent="name" @pick="pick" /></div>
                    </div>
                  </div>

                  <div v-else-if="row.type === 'note'" :data-k="row.key" :class="['ac-note', 'rl', { end: rl.end }]">
                    <button v-if="row.body" type="button" class="ac-wh" :aria-expanded="open.has(row.key)" @click="toggle(row.key)"><span class="ac-wl">{{ row.text }}</span><time>{{ time(row.at) }}</time><Icon name="chevron-down" :size="14" class="ac-cv" /></button>
                    <p v-else class="ac-nt">{{ row.text }}<time>{{ time(row.at) }}</time></p>
                    <article v-if="row.body && open.has(row.key)" class="ac-nb"><AgentnetChatBody :text="row.body" :open="open.has(row.key + ':b')" fold @toggle="toggleBody(row.key + ':b')" /></article>
                  </div>
                </template>
              </template>
            </div>
          </div>
          <Transition name="ac-pill">
            <button v-if="!stick && !empty && !cfg" type="button" :class="['ac-latest', { has: unseen > 0 }]" @click="stick = true; unseen = 0; toEnd(true)"><Icon name="chevron-down" :size="14" />{{ pill }}</button>
          </Transition>
        </div>

        <form ref="box" :class="['ac-box', { off: !!off, pop: cfg }]" @submit.prevent="send()">
          <div :class="['ac-field', { drag: dragging }]" @dragover="onDragOver" @dragleave="dragging = false" @drop="onDrop">
            <p v-if="working && !gone" class="ac-now" aria-live="polite" :title="nowLine || undefined"><i class="ac-arc" aria-hidden="true" /><b>Working</b><span v-if="nowLine">{{ nowLine }}</span></p>
            <ul v-if="pics.length" class="ac-pics" aria-label="Pictures to send">
              <li v-for="p in pics" :key="p.id" :class="{ wait: !p.path && !p.error, bad: !!p.error }" :title="p.error ?? (p.path ? 'Ready to send' : 'Saving the picture')">
                <img :src="p.src" alt="Pasted picture" />
                <i v-if="!p.path && !p.error" class="ac-arc" aria-hidden="true" />
                <span v-if="p.error" class="ac-pe" role="alert">{{ p.error }}</span>
                <button type="button" aria-label="Remove the picture" title="Remove" @click="dropPic(p.id)"><Icon name="x" :size="12" /></button>
              </li>
            </ul>
            <div class="ac-in2">
              <textarea ref="ta" v-model="text" rows="1" :disabled="!!off" :placeholder="placeholder" :aria-label="off ?? `Message ${name}`" @keydown="onKey" @paste="onPaste" />
              <span v-if="bytes" :class="['ac-cnt', { over: bytes > LIMIT }]" :title="`The terminal route takes ${LIMIT} bytes`">{{ bytes }} / {{ LIMIT }}</span>
              <input ref="fileIn" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden @change="onPick" />
              <button type="button" class="ac-ib" :disabled="!!off" title="Attach a picture" aria-label="Attach a picture" @click="fileIn?.click()"><Icon name="image" :size="16" /></button>
              <button ref="cfgBtn" type="button" class="ac-ib" :aria-expanded="cfg" aria-controls="ac-cfg" title="Composer settings" aria-label="Composer settings" @click="cfg = !cfg"><Icon name="sliders" :size="16" /></button>
              <button v-if="working && !isRoot && !gone" type="button" class="ac-ib ac-stop" :disabled="stopping" title="Stop the current turn" aria-label="Stop the current turn" @click="stop"><Icon name="square" :size="11" /></button>
              <button class="ac-ib ac-send" type="submit" aria-label="Send" :disabled="!!off || (!text.trim() && !picsReady.length) || picsBusy || bytes > LIMIT" :title="picsBusy ? 'Saving the picture' : mode === 'agentnet' ? `Send as a ${kind} message from root` : 'Type it into the terminal'"><Icon name="arrow-up" :size="16" /></button>
            </div>
          </div>
          <Transition name="ac-pop">
            <div v-if="cfg" id="ac-cfg" ref="cfgEl" class="ac-cfg" role="dialog" aria-label="Composer settings">
              <div class="ac-cr"><span>Send as</span>
                <div class="ac-seg sm" role="radiogroup" aria-label="Send as">
                  <button type="button" role="radio" :aria-checked="mode === 'you'" :class="{ on: mode === 'you' }" title="Type it into the agent's terminal" @click="mode = 'you'">You</button>
                  <button type="button" role="radio" :aria-checked="mode === 'agentnet'" :class="{ on: mode === 'agentnet' }" title="An agentnet message from root" @click="mode = 'agentnet'">Message</button>
                </div></div>
              <div v-if="mode === 'agentnet'" class="ac-cr"><span>Kind</span>
                <div class="ac-seg sm" role="radiogroup" aria-label="Message kind">
                  <button v-for="k in KINDS" :key="k" type="button" role="radio" :aria-checked="kind === k" :class="{ on: kind === k }" @click="kind = k">{{ k }}</button>
                </div></div>
              <div class="ac-cr"><span>Send with</span>
                <div class="ac-seg sm" role="radiogroup" aria-label="Send with">
                  <button type="button" role="radio" :aria-checked="prefs.sendKey === 'enter'" :class="{ on: prefs.sendKey === 'enter' }" @click="prefs.sendKey = 'enter'">Enter</button>
                  <button type="button" role="radio" :aria-checked="prefs.sendKey === 'mod'" :class="{ on: prefs.sendKey === 'mod' }" @click="prefs.sendKey = 'mod'">{{ MOD }} Enter</button>
                </div></div>
              <div v-if="!isRoot" class="ac-cr"><span>While {{ name }} works</span>
                <div class="ac-seg sm" role="radiogroup" aria-label="While the agent works">
                  <button type="button" role="radio" :aria-checked="prefs.busy === 'queue'" :class="{ on: prefs.busy === 'queue' }" title="The prompt waits in the terminal until the turn ends" @click="prefs.busy = 'queue'">Queue</button>
                  <button type="button" role="radio" :aria-checked="prefs.busy === 'interrupt'" :class="{ on: prefs.busy === 'interrupt' }" title="Stop the turn, then type the prompt" @click="prefs.busy = 'interrupt'">Interrupt</button>
                </div></div>
              <div class="ac-cr"><span id="ac-to">Tool calls start expanded</span>
                <button type="button" class="sw sm" role="switch" :aria-checked="prefs.toolsOpen" aria-labelledby="ac-to" @click="prefs.toolsOpen = !prefs.toolsOpen" />
              </div>
              <div class="ac-cr"><span>Text size</span>
                <div class="ac-seg sm" role="radiogroup" aria-label="Text size">
                  <button v-for="z in SIZES" :key="z.id" type="button" role="radio" :aria-checked="prefs.size === z.id" :class="{ on: prefs.size === z.id }" @click="prefs.size = z.id">{{ z.label }}</button>
                </div></div>
            </div>
          </Transition>
          <p v-if="off" class="ac-note" role="status">{{ off }}</p>
          <p v-if="err" class="ac-err" role="alert">{{ err }}</p>
        </form>
      </div>

      <Transition name="ac-det"><aside v-if="canPanel && picked" class="ac-det" aria-label="Step output">
        <h3><span>{{ picked.title }}</span><time>{{ time(picked.ts) }}</time><button type="button" class="ac-dx" aria-label="Close the step" title="Close (Esc)" @click="pickedId = null"><Icon name="x" :size="15" /></button></h3>
        <dl><dt>Result</dt><dd :class="picked.status">{{ picked.status === "error" ? "failed" : picked.status === "running" ? "running" : "ok" }}</dd><template v-if="picked.ms != null && picked.status !== 'running'"><dt>Took</dt><dd>{{ took(picked.ms) }}</dd></template></dl>
        <a v-if="picked.img" class="ac-di" :href="imgUrl(picked.img)" target="_blank" rel="noopener" role="button" aria-haspopup="dialog" :title="picked.img" @click="pf.open($event, imgUrl(picked.img!), picked.img!)" @keydown.space.prevent="pf.open($event, imgUrl(picked.img!), picked.img!)"><img :src="imgUrl(picked.img)" :alt="picked.title ?? 'The image this step read'" /></a>
        <StepDetail :item="picked" :agent="name" />
      </aside></Transition>
      <FocusView v-if="pf.pic.value" :path="pf.pic.value.path" :image-src="pf.pic.value.src" :origin="pf.pic.value.origin" @close="pf.close" />
    </div>
  </div>
</template>

<style scoped>
.ac{--you:var(--sel);--on-you:#06121f;--agl:66%;--ag:hsl(var(--hue,212) 78% var(--agl));--think:var(--lock);--hair:color-mix(in srgb,var(--ink) 14%,transparent);--soft:color-mix(in srgb,var(--ink) 6%,transparent);--fs:13.5px;--gut:0px;--pad:12px;
  --e-out:cubic-bezier(.23,1,.32,1);--e-hv:cubic-bezier(.2,.8,.2,1);display:flex;flex-direction:column;min-width:0;min-height:0;height:100%}
:root[data-theme="light"] .ac{--on-you:#fff;--agl:34%}
.ac.sz-s{--fs:12.5px}.ac.sz-l{--fs:15px}
.ac.wide{--fs:15px;--gut:44px;--pad:24px}
.ac.wide.sz-s{--fs:13.5px}.ac.wide.sz-l{--fs:16.5px}
.ac *,.ac-top *{min-width:0}
.ac-top{flex:none;display:flex;align-items:center;gap:8px;padding:8px var(--pad,12px) 0}
/* the panel header floats over the chat (--hd-h); the narrow filter row floats right under it */
.ac:not(.wide) .ac-top{position:absolute;top:var(--hd-h,0px);left:0;right:0;z-index:4;padding-bottom:6px;background:color-mix(in srgb,var(--panel) 72%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.ac-top .ac-seg{flex:1}
.ac-top .ac-seg button{min-height:30px;font-size:12px}
.ac-top.tp{padding:0;height:100%}
.ac-top.tp .ac-seg{flex:none;width:280px}
.ac-top.tp .ac-seg button{min-height:26px}
.ac-top.tp .ac-xp{min-height:32px}
.ac-xp{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 11px;border:1px solid var(--hair,var(--line));border-radius:11px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .15s var(--ease),transform .12s var(--ease)}
.ac-xp:active{transform:scale(.97)}
.ac-seg{display:flex;gap:3px;padding:3px;border:1px solid var(--hair,var(--line));border-radius:12px;background:var(--track)}
.ac-seg button{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:600 12.5px/1 var(--body);white-space:nowrap;cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.ac-seg button.on{background:color-mix(in srgb,var(--ink) 14%,transparent);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.25)}
.ac-seg.sm{display:inline-flex;flex:none}
.ac-seg.sm button{flex:none;min-height:28px;padding:0 11px;font-size:12px}
.ac :is(button,textarea):focus-visible,.ac-top button:focus-visible{outline:2px solid var(--you,var(--sel));outline-offset:1px}
.ac textarea:focus-visible{outline:none}
/* composer icon buttons: keyboard focus is a neutral ring, never the blue one (owner 8355) */
.ac-ib:focus-visible{outline:2px solid color-mix(in srgb,var(--ink) 45%,transparent);outline-offset:1px}
.ac-main{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr)}
.ac-col{position:relative;display:flex;flex-direction:column;min-height:0}
.ac-wrap{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.ac-off{flex:none;display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:10px;margin:4px var(--pad) 6px;padding:10px 12px;border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--warn) 14%,var(--card)),var(--card) 70%);box-shadow:0 0 0 .75px color-mix(in srgb,var(--warn) 30%,transparent);font-size:12.5px;line-height:1.45;color:var(--ink)}
.ac-off b{color:var(--warn);font-weight:650;font-size:13px}
.ac-off > span:last-child{grid-column:2}
.ac-offi{grid-row:1 / span 2;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
:root[data-theme="light"] .ac-off b{color:var(--pend)}
.ac-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:calc(4px + var(--hd-h,0px) + var(--ac-sw,0px)) var(--pad) calc(16px + var(--box-h,0px));overflow-anchor:none}
.ac:not(.wide){--ac-sw:46px}
.ac-wrap > .ac-off{margin-top:calc(4px + var(--hd-h,0px) + var(--ac-sw,0px))}
.ac-wrap > .ac-off ~ .ac-list{padding-top:4px}
.ac-in{display:grid;grid-template-columns:minmax(0,1fr);align-content:start}
.ac-in > :first-child{margin-top:6px}
.ac-load{max-width:70%}
.ac-none{display:grid;gap:3px;color:var(--muted);font-size:13px;line-height:1.5}
.ac-none p{margin:0}
.ac-nh{color:var(--ink);font:650 14px/1.3 var(--body)}
.ac-day{display:flex;align-items:center;gap:10px;margin:14px 0 2px;color:var(--muted);font:600 11.5px/1 var(--body)}
.ac-day::before,.ac-day::after{content:"";flex:1;height:1px;background:var(--hair)}
.ac-m{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:5px;margin-top:14px;border-radius:14px}
.ac-m.cont{margin-top:4px}
.ac-m.in{justify-items:start}
.ac-m.out{justify-items:end}
.ac-h{display:flex;align-items:center;gap:8px;max-width:100%;margin:0;padding:0 2px;font-size:12.5px;line-height:1.3;color:var(--muted)}
.ac-who{color:var(--ink);font-weight:650;letter-spacing:.01em;overflow-wrap:anywhere}
.ac time{flex:none;font:500 11.5px/1 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
.ac-bub{display:grid;grid-template-columns:minmax(0,1fr);gap:5px;max-width:min(92%,720px);padding:9px 12px 10px;border:1px solid var(--hair);border-radius:14px;background:var(--soft);font-size:var(--fs)}
/* the agent's own words: flowing text, no bubble, the full width of the lane */
.ac-m.ag .ac-bub{width:100%;max-width:100%;padding:0 2px;border:0;border-radius:0;background:none}
/* the owner: one colour for everything that speaks as the owner */
.ac-m.you .ac-bub{grid-template-columns:minmax(0,1fr) auto;column-gap:9px;align-items:end;max-width:min(88%,860px);border-color:color-mix(in srgb,var(--you) 55%,transparent);background:color-mix(in srgb,var(--you) 20%,var(--panel));border-radius:14px 14px 4px 14px}
/* pictures take the bubble's whole first row; the text and the tick share the row under them (a long text beside a picture
   in the 1fr column squeezed it to 0 px: owner 8336) */
.ac-m.you .ac-span{grid-column:1 / -1}
.ac-m.you.cont .ac-bub{border-top-right-radius:4px}
.ac-tick{display:grid;place-items:center;width:14px;height:19px;color:var(--muted);transition:color .2s var(--ease)}
.st-sent .ac-tick,.st-shown .ac-tick{color:var(--you)}
.st-failed .ac-tick{color:var(--bad)}
.st-failed .ac-bub{border-color:color-mix(in srgb,var(--bad) 60%,transparent);background:color-mix(in srgb,var(--bad) 14%,var(--panel))}
.ac-fail{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px 8px;margin:0;padding:0 2px;color:var(--bad);font-size:12.5px;line-height:1.3}
.ac-fail span{overflow-wrap:anywhere}
/* the sent message waits in the agent's queue until its step ends: a muted line under the bubble, faded in late so a quick take never flashes it */
.ac-wait{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px 8px;margin:0;padding:0 2px;color:var(--muted);font-size:12.5px;line-height:1.3;animation:acfade .2s var(--ease) .5s both}
.ac-wait span{overflow-wrap:anywhere}
.ac-wait button{display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:0 9px;border:1px solid var(--hair);border-radius:8px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:background .15s var(--ease)}
.ac-wait button:hover{background:color-mix(in srgb,var(--ink) 9%,transparent)}
.ac-wait button:disabled{opacity:.55;cursor:progress}
.ac-wait button:focus-visible{outline:2px solid color-mix(in srgb,var(--ink) 45%,transparent);outline-offset:1px}
.ac-fail button{display:inline-flex;align-items:center;gap:4px;min-height:26px;padding:0 9px;border:1px solid var(--hair);border-radius:8px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer}
/* a bubble the owner just sent is simply there: no entrance, nothing between the key and the paint */
.ac-m.is-new:not(.you){animation:acin .28s var(--e-out) both}
@keyframes acin{from{opacity:0;transform:translateY(8px)}}
@keyframes acfade{from{opacity:0}}
.ac-m.flash,.ac-w.flash{animation:acflash 1.4s var(--ease)}
@keyframes acflash{0%,45%{box-shadow:0 0 0 6px color-mix(in srgb,var(--you) 26%,transparent)}100%{box-shadow:0 0 0 6px transparent}}

/* the agent's work between two replies: one row, a tick per thought and step in its state's colour */
.ac-tk{flex:none;display:inline-flex;gap:2px;align-items:center}
.ac-tk i{width:5px;height:14px;border-radius:1.5px;background:var(--on)}
.ac-tk.sm i{width:4px;height:10px;border-radius:1px}
.ac-tk i.think{background:var(--think)}
.ac-tk i.bad{background:var(--bad)}
.ac-tk i.run{background:var(--on);animation:actk 1.6s linear infinite}
@keyframes actk{0%,100%{opacity:1}50%{opacity:.25}}
.ac-wl{flex:0 1 auto;overflow-wrap:anywhere}
.ac-bad{flex:none;padding:2px 8px;border-radius:999px;background:var(--bad-bg);color:var(--bad);font:650 11.5px/1.4 var(--body)}
.ac-cv{flex:none;color:var(--muted);transform:rotate(-90deg);transition:transform .22s var(--e-out)}
.ac-wh[aria-expanded="true"] .ac-cv{transform:none}
.ac-gb{display:none}
.ac-gb.is-open{display:block}
@media (hover:hover) and (pointer:fine){
  .ac-wh:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
  .ac-xp:hover,.ac-fail button:hover{background:color-mix(in srgb,var(--ink) 9%,transparent)}
}

/* work in progress: the arc of the map's avatar edge, 1.6 s a turn */
.ac-arc{flex:none;width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--on) 25%,transparent);border-top-color:var(--on);animation:acspin 1.6s linear infinite}
@keyframes acspin{to{transform:rotate(360deg)}}
.ac:not(.wide) .ac-latest{left:auto;right:10px;transform:none}
.ac-latest{position:absolute;left:50%;bottom:calc(10px + var(--box-h,0px));z-index:4;display:inline-flex;align-items:center;gap:5px;min-height:32px;padding:0 12px 0 9px;border:1px solid var(--line);border-radius:999px;background:var(--card,var(--panel));color:var(--ink);font:600 12px/1 var(--body);letter-spacing:.01em;white-space:nowrap;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);transform:translateX(-50%)}
/* unread: the words say it; the outline stays the neutral hairline of the composer box (owner 8355, 8406: no blue borders) */
.ac-latest.has{color:var(--you)}
.ac-pill-enter-active,.ac-pill-leave-active{transition:opacity .18s var(--ease),transform .22s var(--e-out)}
.ac-pill-enter-from,.ac-pill-leave-to{opacity:0;transform:translate(-50%,8px)}

/* the composer floats over the bottom of the chat: the list scrolls under it (its bottom padding is the box's height, read by a
   ResizeObserver). One hairline box in the canvas border token, no colour ring; only Send is filled. */
/* Layers in the chat window, written once (owner 8410): settings popover (form.pop, 7) > header chips (6) > Latest pill (4) >
   composer (3). The pill also hides while the popover is open. --bx is the composer's side inset; the popover lines up with it. */
.ac-box{--bx:var(--pad);position:absolute;left:0;right:0;bottom:0;z-index:3;display:grid;gap:6px;padding:0 var(--bx) calc(12px + env(safe-area-inset-bottom));pointer-events:none}
.ac-box.pop{z-index:7}
.ac-box > *{pointer-events:auto}
/* a short fade to the background right under the box, so a row passing under it never shows below its edge */
.ac-box::before{content:"";position:absolute;left:0;right:0;bottom:0;height:calc(12px + 28px + env(safe-area-inset-bottom));background:linear-gradient(to bottom,transparent,var(--panel) 45%);pointer-events:none}
.ac.wide .ac-box{padding-bottom:16px}
.ac-field{position:relative;display:grid;border:1px solid var(--line);border-radius:16px;background:var(--card,var(--panel-2));box-shadow:0 1px 2px rgba(0,0,0,.28),0 10px 24px -12px rgba(0,0,0,.55);transition:border-color .2s var(--e-hv)}
:root[data-theme="light"] .ac-field{box-shadow:0 1px 2px rgba(22,22,26,.06),0 10px 24px -12px rgba(22,22,26,.18)}
.ac-field:focus-within{border-color:color-mix(in srgb,var(--line) 60%,var(--muted))}
.ac-field.drag{border-style:dashed;border-color:var(--muted)}
.ac-pics{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:8px 12px 0;list-style:none}
.ac-pics li{position:relative;width:64px;height:64px;border-radius:10px;overflow:hidden;background:var(--soft);box-shadow:inset 0 0 0 1px var(--hair)}
.ac-pics img{display:block;width:100%;height:100%;object-fit:cover;transition:opacity .2s var(--ease)}
.ac-pics li.wait img{opacity:.45}
.ac-pics li.bad img{opacity:.25}
.ac-pics li.bad{box-shadow:inset 0 0 0 1.5px var(--bad)}
.ac-pics .ac-arc{position:absolute;inset:0;margin:auto;width:18px;height:18px}
.ac-pe{position:absolute;inset:auto 0 0 0;padding:2px 3px;background:var(--bad);color:#fff;font:650 9.5px/1.2 var(--body);text-align:center}
.ac-pics button{position:absolute;top:3px;right:3px;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:color-mix(in srgb,#000 68%,transparent);color:#fff;cursor:pointer}
.ac-pics button::after{content:"";position:absolute;inset:-8px}
.ac-bp{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 6px}
.ac-bp a{display:block;flex:none;max-width:min(100%,260px);border-radius:10px;overflow:hidden;background:var(--soft)}
.ac-bp img{display:block;width:auto;height:auto;max-width:100%;max-height:180px}
.ac-box.off .ac-field{background:var(--panel-2)}
.ac-box.off textarea{opacity:.6;cursor:not-allowed}
.ac-in2{display:flex;align-items:flex-end;gap:2px;padding:0 8px 8px 0}
.ac-field textarea{display:block;flex:1;min-width:0;align-self:stretch;resize:none;field-sizing:content;min-height:44px;max-height:min(240px,32vh);margin-bottom:-8px;padding:11px 8px 11px 14px;border:0;background:transparent;color:var(--ink);font:inherit;font-size:calc(var(--fs) + .5px);line-height:1.45;outline:none;overflow-y:auto}
.ac-field textarea::placeholder{color:var(--muted);opacity:1}
.ac-now{display:flex;align-items:center;gap:7px;min-width:0;margin:0;padding:9px 14px 0;font-size:12px;line-height:1.3;color:var(--muted);white-space:nowrap}
.ac-now b{flex:none;color:var(--on);font-weight:650}
.ac-now span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ac-now .ac-arc{width:11px;height:11px;border-width:1.5px}
.ac-cnt{flex:none;align-self:center;font:500 11.5px/1 var(--mono);color:var(--muted);font-variant-numeric:tabular-nums}
.ac-cnt.over{color:var(--bad)}
.ac-ib{flex:none;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;cursor:pointer;transition:transform .16s var(--e-out),background-color .2s var(--ease),color .2s var(--ease);background:transparent;color:var(--muted)}
@media (hover:hover) and (pointer:fine){.ac-ib:not(:disabled):not(.ac-send):hover{background:color-mix(in srgb,var(--ink) 8%,transparent);color:var(--ink)}.ac-send:not(:disabled):hover{filter:brightness(1.08)}}
.ac-ib:disabled{cursor:default}
.ac-ib:not(.ac-send):not(.ac-stop):disabled{opacity:.45}
.ac-ib[aria-expanded="true"]{background:color-mix(in srgb,var(--ink) 10%,transparent);color:var(--ink)}
.ac-stop{margin-left:2px;background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.ac-stop .icon{fill:currentColor}
.ac-stop:disabled{opacity:.5;cursor:default}
.ac-send{margin-left:2px;background:var(--on);color:var(--panel)}
:root[data-theme="light"] .ac-send{color:#fff}
.ac-send:disabled{background:color-mix(in srgb,var(--ink) 10%,transparent);color:var(--muted)}
.ac-ib:not(:disabled):active{transform:scale(.94)}
.ac-err{margin:0;color:var(--bad);font-size:12.5px}
/* the box's one-line status; its own class, so it never resets the banner's inset (.ac-off above) */
.ac-note{margin:0;color:var(--warn);font-size:12.5px;line-height:1.35}
/* settings: a small sheet that grows out of its button */
.ac-cfg{position:absolute;right:var(--bx);bottom:calc(100% + 8px);z-index:5;display:grid;gap:10px;width:min(360px,calc(100% - 2 * var(--pad)));padding:12px;border:1px solid var(--hair);border-radius:14px;background:var(--panel);box-shadow:0 14px 34px -10px rgba(0,0,0,.55);transform-origin:calc(100% - 22px) 100%}
.ac-cr{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px}
.ac-pop-enter-active{transition:opacity .16s var(--e-hv),transform .18s var(--e-out)}
.ac-pop-leave-active{transition:opacity .12s var(--ease),transform .12s var(--ease)}
.ac-pop-enter-from,.ac-pop-leave-to{opacity:0;transform:scale(.96) translateY(4px)}

/* ---------- the agent's rail ----------
   The agent's side of a turn is one line read from top to bottom, as in the Trail tab: its mark at the head, a node for
   each thing it said, what it did for it hanging under the node. Spacing scale: 4, 8, 12, 20, 32. */
.ac{--rg:10px;--tool-fill:color-mix(in srgb,var(--ink) 15%,transparent);--tool-edge:color-mix(in srgb,var(--ink) 38%,transparent);--rx:11px;--rgut:30px;--rail:color-mix(in srgb,var(--fiber) 55%,transparent);--done:var(--on)}
.ac.wide{--rx:16px;--rgut:46px}
/* tool-call surfaces stand apart from the chat: fill >= 1.5:1 and edge >= 3:1 against the background (WCAG 1.4.11), in both themes */
:root[data-theme="light"] .ac{--tool-fill:color-mix(in srgb,var(--ink) 5%,transparent);--tool-edge:color-mix(in srgb,var(--ink) 48%,transparent)}
.ac-th{position:relative;display:flex;align-items:center;gap:10px;margin:20px 0 0;padding:0 0 4px;font-size:13px;color:var(--muted)}
.ac-th .ac-who{font-size:calc(var(--fs) - .5px)}
.ac-th time{margin-left:2px}
.ac-st{color:var(--on);font-weight:650}
.ac-th :deep(.am){width:22px;height:22px;border-radius:7px}
.ac-th :deep(.am-mk){grid-template-columns:repeat(3,3px);gap:1.5px}
.ac-th :deep(.am-mk i){width:3px;height:3px;border-radius:1px}
.ac.wide .ac-th{margin-top:32px;gap:14px}
.ac.wide .ac-th :deep(.am){width:32px;height:32px;border-radius:10px}
.ac.wide .ac-th :deep(.am-mk){grid-template-columns:repeat(3,4px);gap:2.5px}
.ac.wide .ac-th :deep(.am-mk i){width:4px;height:4px;border-radius:1.2px}
.ac .rl{position:relative;margin:0;padding:var(--rg) 0 var(--rg) var(--rgut)}
.ac-at{display:none}
.ac-note{color:var(--muted);font-size:12.5px;line-height:1.4}
/* the loading line keeps its slot while there is more to load, so showing it never moves the rows */
.ac-old{display:flex;align-items:center;justify-content:center;gap:8px;height:20px;margin:4px 0 8px;color:var(--muted);font-size:12.5px;opacity:0;transition:opacity .2s var(--ease)}
.ac-old.on{opacity:1}
.ac-old .ac-arc{width:12px;height:12px}
.ac-nt{display:flex;align-items:baseline;gap:10px;margin:0;min-height:20px}
.ac-nb{margin:6px 0 4px;padding:10px 14px;border-radius:12px;background:var(--soft);color:var(--ink);font-size:calc(var(--fs) - 1px)}
.ac.wide .ac-m.rl{margin-top:0}
.ac .ac-note.rl{padding-block:4px}
/* what the agent did between two things it said: one grey line under the node; open, a line per step */
/* the pill keeps the same space from the text above and below as one message keeps from the next (2 x --rg) */
.ac .ac-w.rl{padding-block:var(--rg)}
.ac .ac-w.rl.running{padding-top:0}
.ac-wh{display:flex;align-items:center;gap:8px;max-width:100%;min-height:28px;margin-left:-8px;padding:2px 8px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:500 13px/1.35 var(--body);cursor:pointer;text-align:left;transition:background-color .22s var(--e-hv),color .22s var(--e-hv)}
.ac-wl{flex:none}
.ac-w.running .ac-wl{flex:0 1 auto;color:var(--on);font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ac-wt{flex:0 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:color-mix(in srgb,var(--ink) 80%,transparent)}
.ac-wt::before{content:"";display:inline-block;width:3px;height:3px;margin:0 8px 3px 0;border-radius:50%;background:var(--muted)}
.ac-wh .ac-arc{width:12px;height:12px}
.ac-wh .ac-cv{opacity:0;transition:opacity .22s var(--e-hv),transform .22s var(--e-out)}
.ac-wh:hover .ac-cv,.ac-wh:focus-visible .ac-cv,.ac-wh[aria-expanded="true"] .ac-cv{opacity:1}
.ac-wh:hover{color:var(--ink)}
.ac-gb.is-open > div{margin-top:8px;padding:6px 8px 4px;border-radius:12px;background:var(--tool-fill);box-shadow:0 0 0 1px var(--tool-edge)}

/* ---------- expanded: one centred column; a picked step opens beside it and pushes it over ---------- */
.ac.wide{--col:780px;--text:680px}
/* The picked step's panel lies over the right edge and slides in (transform and opacity only); the chat column keeps its
   width and slides left by half the panel, so its centre stays in the free space and no line rewraps. Never past its own
   side margin: a narrow window lets the panel cover the column's right edge instead of squeezing the text. */
.ac.wide{--det-w:clamp(320px,27vw,440px);--det-t:240ms}
.ac.wide .ac-main{position:relative;overflow:hidden}
.ac.wide .ac-col{transition:transform var(--det-t) var(--e-hv)}
.ac.wide .ac-main.det .ac-col{transform:translateX(calc(-1 * max(0px, min(var(--det-w) / 2, (100% - var(--col)) / 2 - var(--pad)))))}
.ac.wide .ac-list{padding:calc(12px + var(--hd-h,0px)) var(--pad) calc(24px + var(--box-h,0px))}
.ac.wide .ac-in,.ac.wide .ac-box{width:min(100%,var(--col));margin-inline:auto}
.ac.wide .ac-wrap > .ac-off{box-sizing:border-box;width:min(100% - 2 * var(--pad),var(--col));margin-inline:auto}
.ac.wide .ac-box{--bx:0px}
.ac.wide .ac-m{margin-top:20px}
.ac.wide .ac-m.cont{margin-top:8px}
.ac.wide .ac-m.you .ac-bub{max-width:min(86%,var(--text))}
/* a reply's lines stay readable; tables, code and blocks may use the whole column */
.ac.wide .ac-m.ag :deep(.ac-md > :not(pre,table,.md-tw)){max-width:var(--text)}
.ac.wide .ac-at{display:block;position:absolute;right:calc(100% + 14px);top:calc(var(--rg) + (var(--fs) * 1.55 - 11.5px) / 2)}
/* the Latest pill sits beside the column, off the lines being read */
.ac.wide .ac-latest{left:calc(50% + min(50% - 64px,var(--col) / 2 + 64px))}
/* the floating panel header (--hd-h) sits over the top: the pane starts below its chips, as the list does */
.ac-det{position:absolute;top:0;right:0;bottom:0;z-index:5;width:var(--det-w);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;min-height:0;padding:calc(20px + var(--hd-h,0px)) 22px 20px;border-left:1px solid var(--hair);background:var(--panel);box-shadow:-18px 0 40px -28px rgba(0,0,0,.5)}
/* Keyframes, not a transition: they start on the frame the class lands, the same frame the column starts to move (a Vue
   enter/leave transition waits two frames for its -to class and would trail the column). */
.ac-det-enter-active{animation:acdet var(--det-t) var(--e-hv) both}
.ac-det-leave-active{animation:acdet-out var(--det-t) var(--e-hv) both}
@keyframes acdet{from{transform:translateX(100%);opacity:0}}
@keyframes acdet-out{to{transform:translateX(100%);opacity:0}}
.ac-det h3{flex:none;display:flex;align-items:center;gap:10px;margin:0;font:650 15px/1.35 var(--body);color:var(--ink)}
.ac-det h3 span{flex:1;overflow-wrap:anywhere}
.ac-dx{flex:none;display:grid;place-items:center;width:30px;height:30px;margin:-4px -6px -4px 0;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;transition:background-color .22s var(--e-hv)}
.ac-dx:hover{background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--ink)}
.ac-det dl{flex:none;display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:0;font-size:13px}
.ac-det dt{color:var(--muted)}
.ac-det dd{margin:0;font-weight:600}
.ac-det dd.ok{color:var(--on)}.ac-det dd.error{color:var(--bad)}
.ac-di{flex:0 1 auto;min-height:0;display:block;border-radius:12px;overflow:hidden;background:var(--soft)}
.ac-di img{display:block;width:100%;height:auto;max-height:46vh;object-fit:contain}
@media (prefers-reduced-motion:reduce){.ac.wide .ac-col{transition:none}.ac-det-enter-active,.ac-det-leave-active{animation:none}.ac-wait{animation:none}.ac-arc,.ac-tk i.run{animation:none}.ac-ib,.ac-xp,.ac-seg button,.ac-cv,.ac-wh,.ac-field,.ac-w{transition:none}.ac-m.is-new:not(.you){animation:acfade .2s var(--ease) both}.ac-m.flash,.ac-w.flash{animation:none;box-shadow:0 0 0 6px color-mix(in srgb,var(--you) 26%,transparent)}.ac-pill-enter-active,.ac-pill-leave-active,.ac-pop-enter-active,.ac-pop-leave-active{transition:opacity .16s var(--ease)}.ac-pill-enter-from,.ac-pill-leave-to{transform:translateX(-50%)}.ac-pop-enter-from,.ac-pop-leave-to{transform:none}}
</style>
