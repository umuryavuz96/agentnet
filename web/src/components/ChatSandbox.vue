<script setup lang="ts">
// Live UI an agent wrote (a `ui-html` fence, docs/CHAT-UI-BLOCKS.md): its own HTML, CSS and script, run in a frame that
// can reach nothing. The frame is `sandbox="allow-scripts"` with no `allow-same-origin` (opaque origin: no cookies, storage
// or chat DOM) and loads the service's shell page, whose policy allows no network (src/net/web.ts). The shell says ready,
// this component posts the document (the chat's tokens as CSS variables, base styles, the bridge, the agent's markup).
// The frame reports its height; it may ask to send one line as the owner, and chatSandbox.ts judges that from what this
// page measured itself: a click inside the frame, just now. Anything else that goes wrong shows the source as code.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { url } from "../ui/api";
import { MARK, clampHeight, judgeSend, readMessage, sandboxDoc, type Theme } from "../chatSandbox";

const props = defineProps<{ html: string; /** the owner's next prompt after this reply, if any */ answer?: string | null; canSend?: boolean; from?: string }>();
const emit = defineEmits<{ pick: [text: string] }>();

const SRC = url("sandbox.html"), START_MS = 4000;
const root = ref<HTMLElement | null>(null), frame = ref<HTMLIFrameElement | null>(null);
const seen = ref(false);                       // near the view once: only then is the frame made
const state = ref<"wait" | "live" | "code">("wait");
const why = ref("");
const code = ref(false);                       // the owner asked to see the source
const h = ref(heights.get(props.html) ?? 96);
const sent = ref<string | null>(null), ask = ref<string | null>(null);
const locked = computed(() => sent.value !== null || props.answer != null);
let started = false, loads = 0, timer = 0, io: IntersectionObserver | null = null, mo: MutationObserver | null = null;
const mq = matchMedia("(prefers-color-scheme: dark)");

function fail(reason: string) { state.value = "code"; why.value = reason; ask.value = null; clearTimeout(timer); }
const post = (m: Record<string, unknown>) => frame.value?.contentWindow?.postMessage({ ...m, [MARK]: 1 }, "*"); // an opaque origin has no name to address

/** The chat's tokens as the frame gets them, resolved to plain colours here (the frame cannot see the chat's variables). */
function theme(): Theme {
  const probe = document.createElement("i");
  probe.style.display = "none";
  root.value?.appendChild(probe);
  const color = (v: string) => { probe.style.color = ""; probe.style.color = v; return getComputedStyle(probe).color; };
  const ink = color("var(--ink)"), rgb = ink.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255];
  const max = ink.startsWith("color(") ? 1 : 255, dark = (rgb[0]! + rgb[1]! + rgb[2]!) / 3 > max / 2;
  const vars: Record<string, string> = {
    "--bg": color("var(--panel-2)"), "--panel": color("var(--panel)"), "--ink": ink, "--muted": color("var(--muted)"),
    "--line": color("var(--hair, var(--line))"), "--accent": color("var(--sel)"), "--on-accent": dark ? "#06121f" : "#fff",
    "--agent": color("var(--ag, var(--sel))"), "--ok": color("var(--on)"), "--warn": color("var(--warn)"), "--bad": color("var(--bad)"),
    "--font": 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', "--mono": "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace", "--radius": "12px",
  };
  probe.remove();
  return { mode: dark ? "dark" : "light", vars };
}
const retheme = () => { if (state.value === "live") post({ t: "theme", ...theme() }); };

function onMessage(e: MessageEvent) {
  const w = frame.value?.contentWindow;
  if (!w || e.source !== w) return;
  const m = readMessage(e.data);
  if (!m) return;
  if (m.t === "ready") {
    if (started) return fail("The frame loaded a second time.");
    started = true; clearTimeout(timer);
    post({ t: "init", doc: sandboxDoc(props.html, theme()) });
    state.value = "live";
    if (locked.value) setTimeout(() => post({ t: "answered", text: sent.value ?? props.answer ?? "" }), 0);
  } else if (m.t === "size") {
    h.value = clampHeight(m.h); heights.set(props.html, h.value);
  } else if (state.value === "live") {
    const text = m.text.trim();
    const verdict = judgeSend({ text, fromFrame: true, active: navigator.userActivation?.isActive ?? false, focused: document.activeElement === frame.value, locked: locked.value, canSend: !!props.canSend, sinceOwnInput: performance.now() - ownInputAt });
    if (verdict === "send") send(text); else if (verdict === "confirm") ask.value = text;
  }
}
function send(text: string) { ask.value = null; sent.value = text; emit("pick", text); post({ t: "answered", text }); }
// The shell loads once, and writing the document into it counts as a second load. A third is the frame going somewhere else.
function onLoad() { if (++loads > 2) fail("The frame tried to open another page."); }

watch(() => props.answer, (a) => { if (a != null) { ask.value = null; post({ t: "answered", text: a }); } });
watch(seen, (on) => { if (on) timer = window.setTimeout(() => { if (!started) fail("The frame did not start."); }, START_MS); });
onMounted(() => {
  addEventListener("message", onMessage);
  io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { seen.value = true; io?.disconnect(); io = null; } }, { rootMargin: "400px" });
  if (root.value) io.observe(root.value);
  mo = new MutationObserver(retheme);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  mq.addEventListener("change", retheme);
});
onBeforeUnmount(() => { removeEventListener("message", onMessage); io?.disconnect(); mo?.disconnect(); mq.removeEventListener("change", retheme); clearTimeout(timer); });
</script>

<script lang="ts">
// Shared by every frame on the page: the height each source last had (so a row that comes back does not jump), and when the
// owner last clicked or typed in the chat page itself. Events inside a frame never reach these listeners.
const heights = new Map<string, number>();
let ownInputAt = -Infinity;
if (typeof window !== "undefined") for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, (e) => { if (e.isTrusted) ownInputAt = performance.now(); }, true);
</script>

<template>
  <section ref="root" :class="['sb', state, { answered: locked }]">
    <header class="sb-h">
      <span class="sb-ic"><Icon name="app-window" :size="14" /></span>
      <span class="sb-t">Live UI<template v-if="from"> from {{ from }}</template></span>
      <span v-if="state !== 'code'" class="sb-safe" title="Runs in a sandbox: it cannot read this page, your cookies or the network"><Icon name="shield-check" :size="13" />Sandboxed</span>
      <span v-else class="sb-safe off"><Icon name="triangle-alert" :size="13" />Not run</span>
      <button v-if="state !== 'code'" type="button" class="sb-b" :aria-pressed="code" @click="code = !code">{{ code ? "Show UI" : "Code" }}</button>
    </header>
    <p v-if="state === 'code'" class="sb-why">{{ why }} Its source is shown instead.</p>
    <div v-if="state !== 'code'" v-show="!code" class="sb-f" :style="{ height: h + 'px' }">
      <iframe v-if="seen" ref="frame" :src="SRC" sandbox="allow-scripts" referrerpolicy="no-referrer" :title="from ? `Live UI from ${from}` : 'Live UI'" @load="onLoad" />
    </div>
    <pre v-if="code || state === 'code'" class="sb-code" tabindex="0"><code>{{ html }}</code></pre>
    <p v-if="ask" class="sb-ask" role="group" aria-label="Send as your message">
      <span>Send as your message:</span><q>{{ ask }}</q>
      <button type="button" class="sb-b go" @click="send(ask)"><Icon name="arrow-up" :size="14" />Send</button>
      <button type="button" class="sb-b" @click="ask = null">Cancel</button>
    </p>
    <p v-else-if="sent" class="sb-note"><Icon name="check" :size="13" />Sent as your message</p>
  </section>
</template>

<style scoped>
.sb{--edge:color-mix(in srgb,var(--ag,var(--sel)) 50%,transparent);display:grid;grid-template-columns:minmax(0,1fr);min-width:0;border:1px solid var(--edge);border-radius:14px;background:var(--panel-2);overflow:hidden}
.sb.code{--edge:var(--hair,var(--line))}
.sb-h{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 6px 0 9px;border-bottom:1px solid var(--hair,var(--line));background:color-mix(in srgb,var(--ag,var(--sel)) 9%,var(--panel));font:600 12.5px/1.2 var(--body)}
.sb.code .sb-h{background:color-mix(in srgb,var(--ink) 5%,var(--panel))}
.sb-ic{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--ag,var(--sel)) 18%,transparent);color:var(--ag,var(--sel))}
.sb.code .sb-ic{background:color-mix(in srgb,var(--ink) 10%,transparent);color:var(--muted)}
.sb-t{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.sb-safe{flex:none;display:inline-flex;align-items:center;gap:4px;margin-left:auto;color:var(--on);font:600 11.5px/1 var(--body)}
.sb-safe.off{color:var(--warn)}
.sb-b{flex:none;display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:0 10px;border:1px solid var(--hair,var(--line));border-radius:8px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .22s cubic-bezier(.2,.8,.2,1),transform .12s var(--ease)}
.sb-b:active{transform:scale(.97)}
.sb-b:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
.sb-b.go{border-color:transparent;background:var(--sel);color:var(--on-you,#06121f)}
@media (hover:hover) and (pointer:fine){.sb-b:not(.go):hover{background:color-mix(in srgb,var(--ink) 9%,transparent)}.sb-b.go:hover{filter:brightness(1.08)}}
.sb-f{position:relative;transition:height .22s cubic-bezier(.23,1,.32,1)}
.sb.wait .sb-f{background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--ink) 5%,transparent),transparent)}
.sb-f iframe{display:block;width:100%;height:100%;border:0;background:transparent;color-scheme:normal}
.sb-why{margin:0;padding:8px 11px 0;color:var(--muted);font-size:12.5px;line-height:1.4}
.sb-code{margin:0;padding:10px 12px;max-height:340px;overflow:auto;overscroll-behavior:contain;color:var(--ink);font:500 12px/1.55 var(--mono);white-space:pre;tab-size:2}
.sb-code:focus-visible{outline:2px solid var(--sel);outline-offset:-2px}
.sb-ask,.sb-note{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;padding:8px 9px 8px 11px;border-top:1px solid var(--hair,var(--line));font-size:12.5px;line-height:1.4}
.sb-ask{background:color-mix(in srgb,var(--sel) 10%,transparent)}
.sb-ask q{flex:1 1 120px;min-width:0;font-weight:600;overflow-wrap:anywhere;quotes:"\201C" "\201D"}
.sb-note{color:var(--muted)}
.sb-note .icon{color:var(--sel)}
@media (prefers-reduced-motion:reduce){.sb-f,.sb-b{transition:none}}
</style>
