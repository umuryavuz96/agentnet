<script setup lang="ts">
// Chat tab of the agent panel: one timeline of the agent's agentnet messages and its live terminal (owner prompts, agent text,
// tool calls), merged by time (web/src/chatFeed.ts). The terminal comes from GET v1/panel/agents/:name/feed (SSE, only while this
// tab is open). The box talks as YOU by typing into the agent's terminal (POST .../prompt), or sends an agentnet message as root.
// Entry: owner and root on the right, the agent on the left, tool calls as compact rows (3+ in a row fold into "N steps").
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, type Msg } from "../net";
import { api, url } from "../ui/api";
import { FILTERS, buildRows, feedItems, type FeedItem, type Filter, type Row } from "../chatFeed";

const props = defineProps<{ name: string; isRoot: boolean; gone: boolean; connected: boolean; working: boolean }>();

// ---------- view state ----------
const FKEY = "agentnet.chat.filter";
const readFilter = (): Filter => { try { const v = localStorage.getItem(FKEY); return v === "messages" || v === "terminal" ? v : "all"; } catch { return "all"; } };
const filter = ref<Filter>(readFilter());
const setFilter = (f: Filter) => { filter.value = f; try { localStorage.setItem(FKEY, f); } catch { /* private window */ } };
const KINDS = ["info", "task", "question"] as const;
const kind = ref<(typeof KINDS)[number]>("info");
const mode = ref<"you" | "agentnet">("you");
const text = ref(""), busy = ref(false), err = ref(""), noTerm = ref("");
const list = ref<HTMLElement | null>(null);
const open = ref(new Set<string>());
const stick = ref(true);

// ---------- the live terminal feed ----------
const items = shallowRef(new Map<string, FeedItem>());
const serverPending = shallowRef<FeedItem[]>([]);
const local = shallowRef<FeedItem[]>([]);
let es: EventSource | null = null;
function connect() {
  es?.close(); es = null;
  items.value = new Map(); serverPending.value = []; local.value = [];
  const name = props.name;
  es = new EventSource(url(`v1/panel/agents/${encodeURIComponent(name)}/feed`));
  es.addEventListener("reset", (e) => { const d = JSON.parse((e as MessageEvent).data) as { items: FeedItem[]; pending: FeedItem[] }; items.value = new Map(d.items.map((i) => [i.id, i])); serverPending.value = d.pending; });
  es.addEventListener("items", (e) => { const m = new Map(items.value); for (const i of JSON.parse((e as MessageEvent).data) as FeedItem[]) m.set(i.id, i); items.value = m; });
  es.addEventListener("pending", (e) => { serverPending.value = JSON.parse((e as MessageEvent).data); });
}
watch(() => props.name, () => { stick.value = true; open.value = new Set(); err.value = ""; noTerm.value = ""; mode.value = "you"; connect(); }, { immediate: true });
onBeforeUnmount(() => { es?.close(); es = null; });

// ---------- timeline ----------
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const msgs = computed<Msg[]>(() => net.messages.filter((m) => m.from === props.name || m.to === props.name).slice(-60));
const pend = computed(() => { const seen = new Set<string>(); return [...local.value, ...serverPending.value].filter((p) => p.nonce && !seen.has(p.nonce) && seen.add(p.nonce)); });
const rows = computed(() => {
  const r = buildRows(msgs.value, feedItems(items.value, pend.value), filter.value);
  return r.map((row, i) => ({ row, div: i === 0 || day(r[i - 1]!.at) !== day(row.at) ? day(row.at) : null }));
});
const mine = (m: Msg) => m.from === "root";
const subject = (m: Msg) => m.subject ?? m.body.split("\n")[0]!.slice(0, 60);
const dur = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
const toggle = (k: string) => { const s = new Set(open.value); s.has(k) ? s.delete(k) : s.add(k); open.value = s; };
const empty = computed(() => !rows.value.length);

function toEnd(smooth = false) { nextTick(() => { const el = list.value; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" }); }); }
function onScroll() { const el = list.value; if (el) stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }
watch(() => [rows.value.length, props.working], () => { if (stick.value) toEnd(); }, { flush: "post" });
watch(() => props.name, () => toEnd());
watch(filter, () => { stick.value = true; toEnd(); });

// ---------- the box ----------
const agentnetOff = computed(() => (props.gone ? "Retired: read-only history" : !props.connected ? "Not connected" : null));
const youOff = computed(() => (props.gone ? "Retired: read-only history" : noTerm.value || null));
const off = computed(() => (mode.value === "you" ? youOff.value : agentnetOff.value));
const placeholder = computed(() => off.value ?? (mode.value === "you" ? `Message ${props.name} as you` : `Message ${props.name} as root`));
watch(mode, () => { err.value = ""; noTerm.value = ""; });

async function send() {
  const body = text.value.trim();
  if (!body || busy.value || off.value) return;
  busy.value = true; err.value = "";
  const base = encodeURIComponent(props.name);
  try {
    if (mode.value === "agentnet") { await api(`v1/panel/agents/${base}/message`, { method: "POST", body: { body, kind: kind.value } }); text.value = ""; return; }
    const nonce = crypto.randomUUID();
    local.value = [...local.value, { id: `sending:${nonce}`, ts: Date.now(), kind: "owner", text: body, nonce, sending: true }];
    stick.value = true;
    const r = await fetch(url(`v1/panel/agents/${base}/prompt`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: body, nonce }) });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { detail?: string; title?: string; code?: string };
      local.value = local.value.filter((p) => p.nonce !== nonce);
      if (j.code === "NO_TERMINAL") noTerm.value = j.detail ?? "This agent runs in a terminal agentnet cannot type into.";
      else err.value = j.detail ?? j.title ?? `HTTP ${r.status}`;
      return;
    }
    text.value = "";
  } catch (e) { err.value = (e as Error).message; }
  finally { busy.value = false; }
}
function onKey(e: KeyboardEvent) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }
const rowKey = (r: Row) => r.key;
</script>

<template>
  <div class="ac">
    <div class="ac-top">
      <div class="ac-seg" role="radiogroup" aria-label="Show">
        <button v-for="f in FILTERS" :key="f.id" type="button" role="radio" :aria-checked="filter === f.id" :class="{ on: filter === f.id }" @click="setFilter(f.id)">{{ f.label }}</button>
      </div>
    </div>

    <div ref="list" class="ac-list" role="log" aria-live="polite" :aria-label="`Chat with ${name}`" @scroll.passive="onScroll">
      <p v-if="empty" class="ac-none">{{ filter === "terminal" ? `No terminal activity from ${name} yet.` : `Nothing with ${name} yet.` }}</p>
      <template v-for="{ row, div } in rows" :key="rowKey(row)">
        <p v-if="div" class="ac-day">{{ div }}</p>

        <article v-if="row.type === 'msg'" :class="['ac-b', mine(row.m) ? 'out' : 'in']">
          <p class="ac-h"><span class="ac-kind">{{ row.m.kind }}</span><span class="ac-who" :title="`${row.m.from} to ${row.m.to}`">{{ mine(row.m) ? "to " + row.m.to : row.m.from + " to " + row.m.to }}</span><time>{{ time(row.m.at) }}</time></p>
          <p v-if="row.m.subject && row.m.subject !== row.m.body" class="ac-s">{{ subject(row.m) }}</p>
          <p class="ac-t">{{ row.m.body }}</p>
        </article>

        <article v-else-if="row.type === 'owner'" :class="['ac-b', 'out', 'you', { sending: row.sending }]">
          <p class="ac-h"><span class="ac-kind">you</span><span class="ac-who">{{ row.sending ? "sending" : "typed in the terminal" }}</span><time>{{ time(row.at) }}</time></p>
          <p class="ac-t">{{ row.text }}</p>
        </article>

        <article v-else-if="row.type === 'assistant'" class="ac-b in">
          <p class="ac-h"><span class="ac-who">{{ name }}</span><time>{{ time(row.at) }}</time></p>
          <p class="ac-t">{{ row.text }}</p>
        </article>

        <p v-else-if="row.type === 'step'" :class="['ac-st', row.step.status]">
          <Icon :name="row.step.status === 'running' ? 'loader' : row.step.status === 'error' ? 'circle-x' : 'square-terminal'" :size="14" :class="{ spin: row.step.status === 'running' }" />
          <span class="ac-sw" :title="row.step.out || row.step.title">{{ row.step.title }}</span>
          <span v-if="row.step.ms != null && row.step.status !== 'running'" class="ac-ms">{{ dur(row.step.ms) }}</span>
          <time>{{ time(row.at) }}</time>
        </p>

        <div v-else-if="row.type === 'steps'" class="ac-grp">
          <button type="button" class="ac-gh" :aria-expanded="open.has(row.key)" :aria-controls="'g-' + row.key" @click="toggle(row.key)">
            <Icon :name="row.running ? 'loader' : 'square-terminal'" :size="14" :class="{ spin: row.running }" />
            <span class="ac-sw">{{ row.steps.length }} steps</span>
            <span v-if="row.failed" class="ac-bad">{{ row.failed }} failed</span>
            <time>{{ time(row.at) }}</time>
            <Icon name="chevron-down" :size="16" class="ac-cv" />
          </button>
          <div :id="'g-' + row.key" class="ac-gb" :class="{ 'is-open': open.has(row.key) }" :inert="!open.has(row.key) || undefined">
            <div>
              <p v-for="s in row.steps" :key="s.id" :class="['ac-st', s.status]">
                <Icon :name="s.status === 'running' ? 'loader' : s.status === 'error' ? 'circle-x' : 'check'" :size="14" :class="{ spin: s.status === 'running' }" />
                <span class="ac-sw" :title="s.out || s.title">{{ s.title }}</span>
                <span v-if="s.ms != null && s.status !== 'running'" class="ac-ms">{{ dur(s.ms) }}</span>
                <time>{{ time(s.ts) }}</time>
              </p>
            </div>
          </div>
        </div>

        <p v-else class="ac-note">{{ row.text }}</p>
      </template>
    </div>

    <div class="ac-live" aria-live="polite">
      <template v-if="working && !gone"><span class="ac-dots" aria-hidden="true"><i /><i /><i /></span>{{ name }} is working</template>
      <button v-else-if="!stick && !empty" type="button" class="ac-latest" @click="stick = true; toEnd(true)"><Icon name="chevron-down" :size="14" /> Latest</button>
    </div>

    <form class="ac-box" :class="{ off: !!off }" @submit.prevent="send">
      <div class="ac-row">
        <textarea v-model="text" rows="1" :disabled="!!off" :placeholder="placeholder" :aria-label="off ?? `Message ${name}`" @keydown="onKey" />
        <button class="ac-send" type="submit" :disabled="!!off || busy || !text.trim()" aria-label="Send message"><Icon :name="busy ? 'loader' : 'send'" :size="18" :class="{ spin: busy }" /></button>
      </div>
      <div v-if="!isRoot" class="ac-ctl">
        <div v-if="!isRoot" class="ac-seg sm" role="radiogroup" aria-label="Send as">
          <button type="button" role="radio" :aria-checked="mode === 'you'" :class="{ on: mode === 'you' }" @click="mode = 'you'">You</button>
          <button type="button" role="radio" :aria-checked="mode === 'agentnet'" :class="{ on: mode === 'agentnet' }" @click="mode = 'agentnet'">agentnet message</button>
        </div>
        <div v-if="mode === 'agentnet' && !isRoot" class="ac-kinds" role="radiogroup" aria-label="Message kind">
        <button v-for="k in KINDS" :key="k" type="button" role="radio" :aria-checked="kind === k" :class="{ on: kind === k }" :disabled="!!off" @click="kind = k">{{ k }}</button>
      </div>
      </div>
      <p v-if="off" class="ac-off" role="status">{{ off }}</p>
      <p v-if="err" class="ac-err" role="alert">{{ err }}</p>
    </form>
  </div>
</template>

<style scoped>
.ac{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%}
.ac *{min-width:0}
.ac-top{flex:none;padding:8px 16px 0}
.ac-top .ac-seg button{min-height:30px;font-size:12px}
.ac-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-seg.sm{display:inline-flex;flex:none;gap:2px;padding:2px}
.ac-seg.sm button{flex:none;min-height:30px;padding:0 10px;font-size:12px}
.ac-seg{display:flex;gap:4px;padding:3px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.ac-seg button{flex:1;min-height:36px;padding:0 8px;border:0;border-radius:9px;background:transparent;color:var(--muted);font:600 12.5px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease)}
.ac-seg button.on{background:color-mix(in srgb,var(--ink) 12%,transparent);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.25)}
.ac-seg button:focus-visible,.ac-gh:focus-visible,.ac-latest:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ac-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:grid;gap:8px;align-content:start;padding:10px 16px 8px;overflow-anchor:none}
.ac-none{margin:0;color:var(--muted);font-size:13px}
.ac-day{margin:6px 0 0;text-align:center;color:var(--muted);font:600 11px/1 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ac-b{display:grid;gap:3px;max-width:88%;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.ac-b.out{justify-self:end;border-color:color-mix(in srgb,var(--on) 40%,var(--line));background:color-mix(in srgb,var(--on) 10%,transparent);border-bottom-right-radius:5px}
.ac-b.in{justify-self:start;border-bottom-left-radius:5px}
.ac-b.sending{opacity:.6}
.ac-h{display:flex;align-items:center;gap:7px;margin:0;font-size:11.5px;line-height:1.3;color:var(--muted)}
.ac-kind{flex:none;padding:1px 6px;border-radius:6px;background:var(--track);font:600 10.5px/1.5 var(--mono)}
.ac-who{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ac-h time,.ac-st time,.ac-gh time{flex:none;font:500 11px/1 var(--mono);color:var(--muted)}
.ac-s{margin:0;font:650 13px/1.35 var(--body);overflow-wrap:anywhere}
.ac-t{margin:0;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:14;-webkit-box-orient:vertical;overflow:hidden}
.ac-note{margin:0;text-align:center;color:var(--muted);font-size:11.5px}
.ac-st{display:flex;align-items:center;gap:7px;margin:0;padding:0 2px;min-height:22px;color:var(--muted);font-size:12.5px}
.ac-st .icon{flex:none}
.ac-st.error{color:var(--bad)}
.ac-sw{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ac-ms{flex:none;font:500 11px/1 var(--mono)}
.ac-grp{display:grid;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 3%,transparent)}
.ac-gh{display:flex;align-items:center;gap:7px;width:100%;min-height:36px;padding:0 10px;border:0;border-radius:12px;background:transparent;color:var(--muted);font:600 12.5px/1 var(--body);cursor:pointer;text-align:left}
.ac-bad{flex:none;color:var(--bad);font-weight:600}
.ac-cv{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.ac-gh[aria-expanded="true"] .ac-cv{transform:rotate(180deg)}
.ac-gb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.ac-gb.is-open{grid-template-rows:1fr;opacity:1}
.ac-gb > div{overflow:hidden;display:grid;gap:2px;padding:0 10px}
.ac-gb.is-open > div{padding-bottom:8px}

.ac-live{flex:none;display:flex;align-items:center;gap:8px;height:24px;padding:0 16px;color:var(--muted);font-size:12.5px}
.ac-dots{display:inline-flex;gap:3px}
.ac-dots i{width:5px;height:5px;border-radius:50%;background:var(--on);animation:acdot 1.2s var(--ease) infinite}
.ac-dots i:nth-child(2){animation-delay:.15s}.ac-dots i:nth-child(3){animation-delay:.3s}
@keyframes acdot{0%,80%,100%{opacity:.25}40%{opacity:1}}
.ac-latest{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:var(--track);color:var(--ink);font:600 12px/1 var(--body);cursor:pointer}

.ac-box{flex:none;display:grid;gap:6px;padding:8px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel)}
.ac-kinds{display:flex;flex:1;gap:4px;overflow:hidden}
.ac-kinds button{flex:1;min-height:30px;padding:0 6px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--muted);font:600 11.5px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease),border-color .2s var(--ease)}
.ac-box.off .ac-kinds button,.ac-box.off textarea{opacity:.5;cursor:not-allowed}
.ac-kinds button.on{background:color-mix(in srgb,var(--on) 14%,transparent);border-color:color-mix(in srgb,var(--on) 50%,var(--line));color:var(--ink)}
.ac-row{display:flex;gap:8px;align-items:flex-end}
.ac-row textarea{flex:1;resize:none;field-sizing:content;min-height:44px;max-height:120px;padding:9px 11px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:inherit;font-size:16px;line-height:1.4}
.ac-row textarea:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ac-send{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:var(--on);color:#06210f;cursor:pointer;transition:opacity .2s var(--ease),transform .2s var(--ease)}
.ac-send:disabled{opacity:.35;cursor:default}
.ac-send:not(:disabled):active{transform:scale(.94)}
.ac-err{margin:0;color:var(--bad);font-size:12.5px}
.ac-off{margin:0;color:var(--warn);font-size:12.5px;line-height:1.35}
.spin{animation:acspin 1.1s linear infinite}
@keyframes acspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin,.ac-dots i{animation:none}.ac-send,.ac-kinds button,.ac-seg button,.ac-cv,.ac-gb{transition:none}}
</style>
