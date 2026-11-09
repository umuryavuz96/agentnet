<script setup lang="ts">
// Search: one big bar, live results while typing (GET /trails/search), and while the bar is empty
// three bento cards with the last 3 activities on the agent network (the live agentnet stream, messages).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, useAgentnet } from "../net";
import { url } from "../ui/api";

interface Hit { id: string; kind: "note" | "commit" | "checkpoint" | "session" | "cass"; repo: string; date: string; agent: string; title: string; files: string[]; snippet: string; checkpoint: string; commit: string; score: number; matched: number }

const stop = useAgentnet();
onUnmounted(stop);

const q = ref(""), hits = ref<Hit[]>([]), loading = ref(false), err = ref(""), ranFor = ref(""), ms = ref<number | null>(null);
const sessions = ref<Hit[]>([]), sLoading = ref(false), sFor = ref("");
const rows = computed(() => [...hits.value, ...sessions.value]);
const active = ref(-1), openId = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);
const term = computed(() => q.value.trim());
const searching = computed(() => term.value.length > 0);
const short = computed(() => term.value.length < 3);

let timer: ReturnType<typeof setTimeout> | undefined, timer2: ReturnType<typeof setTimeout> | undefined, ctl: AbortController | null = null, ctl2: AbortController | null = null;
// Phase 2: once typing pauses, ask for past-session (cass) hits. The server fills cass only after the FTS hits, so we keep
// just kind "cass" and drop ids phase 1 already showed. No cass on the server = no hits = nothing shown.
// cass snippets arrive HTML-escaped and with **bold** match markers: show plain text (we highlight the terms ourselves).
const plain = (t: string) => t.replace(/\*\*/g, "").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let cassOn = true;
async function runSessions(text: string) {
  if (!cassOn) return;
  ctl2?.abort(); ctl2 = new AbortController(); sLoading.value = true;
  try {
    const r = await fetch(url(`v1/panel/trails/search?q=${encodeURIComponent(text)}&limit=20&sources=cass`), { signal: ctl2.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { hits?: Hit[]; cass?: boolean };
    if (j.cass === false) cassOn = false; // cass is not installed on this server: stop asking
    const seen = new Set(hits.value.map((h) => h.id));
    sessions.value = (j.hits ?? []).filter((h) => h.kind === "cass" && !seen.has(h.id)).map((h) => ({ ...h, title: plain(h.title), snippet: plain(h.snippet) })); sFor.value = text; sLoading.value = false;
  } catch (e) { if ((e as Error).name !== "AbortError") { sessions.value = []; sLoading.value = false; } }
}
function stopSessions() { clearTimeout(timer2); ctl2?.abort(); sLoading.value = false; }
async function run(text: string) {
  ctl?.abort(); ctl = new AbortController(); loading.value = true; err.value = "";
  try {
    const r = await fetch(url(`v1/panel/trails/search?q=${encodeURIComponent(text)}&limit=20&sources=fts`), { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status === 404 ? "Search is not available on this server yet" : `HTTP ${r.status}`);
    const j = await r.json() as { hits?: Hit[]; ms?: number };
    hits.value = j.hits ?? []; ms.value = j.ms ?? null; ranFor.value = text; active.value = hits.value.length ? 0 : -1; openId.value = null; if (sFor.value !== text) sessions.value = sessions.value.filter((h) => !hits.value.some((x) => x.id === h.id));
    loading.value = false;
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // a newer request owns the loading state
    err.value = (e as Error).message; loading.value = false;
  }
}
watch(term, (t) => {
  clearTimeout(timer);
  stopSessions();
  if (t.length < 3) { ctl?.abort(); loading.value = false; err.value = ""; sessions.value = []; if (!t) { hits.value = []; ranFor.value = ""; } return; }
  loading.value = true; timer = setTimeout(() => run(t), 150);
  if (cassOn) { timer2 = setTimeout(() => runSessions(t), 400); sLoading.value = true; }
});
onUnmounted(() => { clearTimeout(timer); stopSessions(); ctl?.abort(); });

// ---- highlight: split a snippet on the query terms, render as text nodes + <mark> (no v-html) ----
const words = computed(() => [...new Set(ranFor.value.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [])].map((w) => w.replace(/[._-]+$/, "")).filter((w) => w.length > 2));
const rx = computed(() => (words.value.length ? new RegExp(`(${words.value.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig") : null));
function parts(text: string) { return rx.value ? text.split(rx.value).map((t, i) => ({ t, m: i % 2 === 1 })).filter((p) => p.t) : [{ t: text, m: false }]; }

const KIND: Record<Hit["kind"], string> = { note: "Note", commit: "Commit", checkpoint: "Commit", session: "Session", cass: "History" };
const dayMs = 86_400_000;
function ago(ts: number) {
  const s = Math.max(0, Math.round((net.now - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function dateAgo(d: string) {
  const t = Date.parse(d + (d.length === 10 ? "T12:00:00" : "")); if (Number.isNaN(t)) return d;
  const days = Math.round((net.now - t) / dayMs);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 31 ? `${days} d ago` : d;
}

// ---- keyboard ----
function move(d: number) { if (!rows.value.length) return; active.value = (active.value + d + rows.value.length) % rows.value.length; nextTick(() => document.getElementById("hit-" + active.value)?.scrollIntoView({ block: "nearest" })); }
function toggle(i: number) { const h = rows.value[i]; if (h) { active.value = i; openId.value = openId.value === h.id ? null : h.id; } }
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Enter" && searching.value) { e.preventDefault(); toggle(active.value); }
  else if (e.key === "Escape") { if (q.value) q.value = ""; else input.value?.blur(); }
}
function onGlobal(e: KeyboardEvent) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.value?.focus(); input.value?.select(); } }
onMounted(() => { input.value?.focus({ preventScroll: true }); addEventListener("keydown", onGlobal); });
onUnmounted(() => removeEventListener("keydown", onGlobal));
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---- bento: last 3 activities on the network ----
const recent = computed(() => [...net.messages].sort((a, b) => b.at - a.at).slice(0, 3));
const KIND_TXT: Record<string, string> = { task: "Task", report: "Report", question: "Question", answer: "Answer", info: "Message" };
const dotOf = (name: string) => { const a = Object.values(net.agents).find((x) => x.name === name); return name === "root" ? "root" : !a ? "gone" : a.life !== "live" ? a.life : a.state; };
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const title = (m: (typeof recent.value)[number]) => clean(m.subject || m.body).slice(0, 110);
const detail = (m: (typeof recent.value)[number], big = false) => (m.subject ? clean(m.body).slice(0, big ? 900 : 420) : clean(m.body).slice(110, big ? 1000 : 520));
function openAgent(name: string) { location.hash = `agentnet?agent=${encodeURIComponent(name)}`; }
const target = (m: (typeof recent.value)[number]) => (m.from === "root" && m.to !== "root" ? m.to : m.from);
</script>

<template>
  <section class="page srch">
    <div class="bar-wrap">
      <h1 class="sr-only">Search</h1>
      <div class="sv-bar" :class="{ busy: loading }" role="search">
        <Icon name="search" :size="22" class="lens" />
        <input ref="input" v-model="q" type="text" role="combobox" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
          placeholder="Search agent notes, commits, sessions" aria-label="Search agent notes, commits and sessions"
          aria-controls="hits" :aria-expanded="searching && rows.length > 0" :aria-activedescendant="active >= 0 && searching ? 'hit-' + active : undefined" @keydown="onKey" />
        <button v-if="q" type="button" class="clr" aria-label="Clear search" @click="q = ''; input?.focus()"><Icon name="x" :size="18" /></button>
        <kbd v-else class="kb" aria-hidden="true">{{ isMac ? "⌘" : "Ctrl" }} K</kbd>
        <i class="line" aria-hidden="true" />
      </div>
      <p class="sv-sub" aria-live="polite">
        <template v-if="!searching">Agent notes, commits and past sessions. Or look at what the network did last.</template>
        <template v-else-if="short">Type at least 3 characters.</template>
        <template v-else-if="err">&nbsp;</template>
        <template v-else-if="ranFor === term">{{ hits.length }} {{ hits.length === 1 ? "result" : "results" }}<template v-if="ms != null"> · {{ Math.round(ms) }} ms</template><template v-if="sessions.length"> · {{ sessions.length }} past {{ sessions.length === 1 ? "session" : "sessions" }}</template></template>
        <template v-else>Searching…</template>
      </p>
    </div>

    <Transition name="swap" mode="out-in">
      <div v-if="!searching" key="idle" class="idle">
        <h2 class="lbl">Latest on the network</h2>
        <TransitionGroup v-if="recent.length" name="sv-bento" tag="div" class="sv-bento">
          <button v-for="(m, i) in recent" :key="m.id ?? m.at + m.from" type="button" class="bc" :class="{ 'sv-big': i === 0 }" @click="openAgent(target(m))">
            <span class="sv-top">
              <span class="av" :class="'d-' + dotOf(m.from)"><b>{{ m.from.charAt(0).toUpperCase() }}</b><i /></span>
              <span class="who"><b>{{ m.from }}</b> <span class="arr">to</span> {{ m.to }}</span>
              <span class="k" :class="'k-' + m.kind">{{ KIND_TXT[m.kind] ?? m.kind }}</span>
            </span>
            <span class="tt">{{ title(m) }}</span>
            <span v-if="detail(m, i === 0)" class="dt">{{ detail(m, i === 0) }}</span>
            <span class="sv-ft"><span>{{ ago(m.at) }}</span><span class="go">Open {{ target(m) }} <Icon name="arrow-up-right" :size="14" /></span></span>
          </button>
        </TransitionGroup>
        <p v-else class="sv-empty">{{ net.connected ? "No activity on the network yet." : "Connecting to the agent network…" }}</p>
      </div>

      <div v-else key="res" class="res" :class="{ stale: loading && ranFor !== term }">
        <p v-if="err" class="sv-err" role="alert">{{ err }}</p>
        <ul id="hits" class="hits" role="listbox" aria-label="Search results">
          <template v-for="(h, i) in rows" :key="h.id"><li v-if="i === hits.length && sessions.length" class="divider" role="presentation"><span>Past sessions</span></li>
          <li :id="'hit-' + i" class="hit" :class="['t-' + h.kind, { on: active === i, isopen: openId === h.id }]" role="option" :aria-selected="active === i">
            <button type="button" class="hrow" :aria-expanded="openId === h.id" @click="toggle(i)" @mousemove="active = i">
              <span class="hm">
                <span class="sv-chip2" :class="'c-' + h.kind">{{ KIND[h.kind] }}</span>
                <span v-if="h.agent" class="ag">{{ h.agent }}</span>
                <span class="dd">{{ dateAgo(h.date) }}</span>
                <Icon name="chevron-down" :size="16" class="chev" />
              </span>
              <span class="ht">{{ h.title }}</span>
              <span v-if="h.snippet" class="sn"><template v-for="(p, j) in parts(h.snippet)" :key="j"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
              <span v-if="h.files.length" class="fl"><code v-for="f in h.files.slice(0, 3)" :key="f">{{ f }}</code><span v-if="h.files.length > 3" class="more">+{{ h.files.length - 3 }}</span></span>
            </button>
            <div class="fold" :class="{ on: openId === h.id }"><div class="fold-in">
              <dl class="det">
                <template v-if="h.commit"><dt>Commit</dt><dd><code>{{ h.commit }}</code></dd></template>
                <template v-if="h.checkpoint"><dt>Checkpoint</dt><dd><code>{{ h.checkpoint }}</code></dd></template>
                <template v-if="h.repo"><dt>Repo</dt><dd><code>{{ h.repo }}</code></dd></template>
                <template v-if="h.date"><dt>Date</dt><dd>{{ h.date }}</dd></template>
                <template v-if="h.files.length"><dt>Files</dt><dd class="files"><code v-for="f in h.files" :key="f">{{ f }}</code></dd></template>
              </dl>
              <button v-if="h.agent" type="button" class="sv-open" @click="openAgent(h.agent)">Open {{ h.agent }} <Icon name="arrow-up-right" :size="14" /></button>
            </div></div>
          </li></template>
        </ul>
        <p v-if="sLoading" class="sload" role="status"><i /><i /><i /> Searching past sessions…</p>
        <div v-if="!rows.length && !short && !err && ranFor === term && !loading && !sLoading" class="none"><Icon name="search" :size="26" /><b>Nothing found for “{{ term }}”</b><span>Try another word, a file name or an agent name.</span></div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.srch { max-width: 980px; margin-inline: auto; padding-bottom: 40px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.bar-wrap { padding: clamp(8px, 4vh, 40px) 0 6px; }
.sv-bar { position: relative; display: flex; align-items: center; gap: 12px; height: 64px; padding: 0 16px 0 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 10px 40px rgba(0, 0, 0, .35); transition: border-color .2s, box-shadow .2s; overflow: hidden; }
.sv-bar:focus-within { border-color: var(--chrome); box-shadow: 0 10px 40px rgba(0, 0, 0, .35), 0 0 0 3px rgba(201, 204, 209, .16); }
.lens { color: var(--muted); }
.sv-bar input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--ink); font: 500 18px var(--body); }
.sv-bar input::placeholder { color: var(--muted); font-size: 16px; }
.kb { font: 600 12px var(--mono); color: var(--muted); border: 1px solid var(--line); border-radius: 7px; padding: 3px 8px; white-space: nowrap; }
.clr { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; border: 0; background: var(--panel-2); color: var(--muted); cursor: pointer; }
.clr:hover { color: var(--ink); } .clr:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.line { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: linear-gradient(90deg, transparent, var(--chrome), transparent); transform: translateX(-100%); opacity: 0; }
.sv-bar.busy .line { opacity: 1; animation: sweep 1s linear infinite; }
@keyframes sweep { to { transform: translateX(100%); } }
.sv-sub { margin: 10px 4px 0; color: var(--muted); font-size: 13.5px; min-height: 20px; }

.lbl { margin: 22px 4px 10px; }
.sv-bento { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: auto auto; gap: 12px; }
.bc { all: unset; box-sizing: border-box; cursor: pointer; display: grid; align-content: start; gap: 8px; min-width: 0; padding: 16px 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; transition: transform .28s cubic-bezier(.2, .8, .2, 1), border-color .2s, background .2s; }
.bc.sv-big { grid-row: span 2; grid-template-rows: auto auto 1fr auto; align-content: stretch; padding: 22px 24px; gap: 12px; background: linear-gradient(160deg, rgba(255, 255, 255, .05), transparent 60%), var(--panel); }
.bc:hover { border-color: var(--chrome); transform: translateY(-2px); }
.bc:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.sv-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.av { position: relative; flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--panel-2); border: 1px solid var(--line); font: 700 14px var(--display); }
.av i { position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px; border-radius: 50%; background: var(--off); border: 2px solid var(--panel); }
.d-working i { background: var(--on); animation: pulse 1.6s ease-in-out infinite; } .d-waiting i { background: var(--warn); } .d-blocked i { background: var(--bad); } .d-root i { background: var(--chrome); }
@keyframes pulse { 50% { opacity: .35; } }
.who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13.5px; }
.who b { color: var(--ink); font-weight: 700; } .arr { opacity: .7; }
.k { flex: none; font: 600 11px var(--mono); padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.k-report { color: var(--on); background: var(--on-bg); border-color: transparent; } .k-task { color: var(--warn); background: var(--warn-bg); border-color: transparent; } .k-question { color: var(--lock); }
.tt { font: 700 16px/1.3 var(--body); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sv-big .tt { font-size: 22px; -webkit-line-clamp: 4; }
.dt { color: var(--muted); font-size: 13.5px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.sv-big .dt { -webkit-line-clamp: 14; font-size: 16.5px; line-height: 1.55; color: var(--ink); opacity: .82; }
.sv-ft { align-self: end; display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; color: var(--muted); font: 500 12px var(--mono); }
.go { display: inline-flex; align-items: center; gap: 4px; color: var(--ink); opacity: .75; }
.bc:hover .go { opacity: 1; }
.sv-empty { color: var(--muted); padding: 24px 4px; }
.sv-bento-enter-active, .sv-bento-leave-active { transition: opacity .3s, transform .3s cubic-bezier(.2, .8, .2, 1); }
.sv-bento-enter-from { opacity: 0; transform: translateY(10px); } .sv-bento-leave-to { opacity: 0; } .sv-bento-leave-active { position: absolute; }
.sv-bento-move { transition: transform .3s cubic-bezier(.2, .8, .2, 1); }

.res { min-height: 240px; transition: opacity .18s; }
.res.stale { opacity: .6; }
.hits { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 8px; }
.hit { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; transition: border-color .15s, background .15s; min-width: 0; }
.hit.on { border-color: var(--chrome); background: linear-gradient(180deg, rgba(255, 255, 255, .035), transparent), var(--panel); }
.hrow { all: unset; box-sizing: border-box; display: grid; gap: 6px; width: 100%; padding: 13px 16px; cursor: pointer; border-radius: 16px; min-width: 0; }
.hrow:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.hm { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12.5px; min-width: 0; }
.sv-chip2 { font: 700 11px var(--mono); letter-spacing: .04em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); }
.c-note { color: var(--on); background: var(--on-bg); border-color: transparent; } .c-commit, .c-checkpoint { color: var(--warn); background: var(--warn-bg); border-color: transparent; } .c-session, .c-cass { color: var(--lock); }
.ag { color: var(--ink); font-weight: 600; } .dd { margin-right: auto; }
.chev { transition: transform .28s cubic-bezier(.2, .8, .2, 1); } .isopen .chev { transform: rotate(180deg); }
.ht { font: 700 16px/1.3 var(--body); overflow-wrap: anywhere; }
.sn { color: var(--muted); font-size: 13.5px; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.isopen .sn { -webkit-line-clamp: unset; }
.sn :deep(mark), mark { background: rgba(255, 178, 30, .22); color: var(--ink); border-radius: 3px; padding: 0 2px; }
.fl { display: flex; flex-wrap: wrap; gap: 4px 6px; }
code { font: 500 12px/1.4 var(--mono); color: var(--chrome); background: var(--panel-2); border-radius: 6px; padding: 1px 6px; overflow-wrap: anywhere; word-break: break-all; }
.more { font: 600 12px var(--mono); color: var(--muted); align-self: center; }
.fold { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .3s cubic-bezier(.2, .8, .2, 1); }
.fold.on { grid-template-rows: 1fr; }
.fold-in { overflow: hidden; min-height: 0; padding: 0 16px; }
.fold.on .fold-in { padding-bottom: 14px; }
.det { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; margin: 4px 0 8px; font-size: 13px; border-top: 1px solid var(--line); padding-top: 12px; }
.det dt { color: var(--muted); font-weight: 600; } .det dd { margin: 0; min-width: 0; }
.files { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.sv-open { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font: 600 13px var(--body); color: var(--ink); padding: 6px 10px; border: 1px solid var(--line); border-radius: 9px; }
.sv-open:hover { border-color: var(--chrome); } .sv-open:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.divider { list-style: none; display: flex; align-items: center; gap: 12px; margin: 10px 4px 2px; color: var(--muted); font: 700 12px var(--display); letter-spacing: .14em; text-transform: uppercase; }
.divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.sload { display: flex; align-items: center; gap: 6px; margin: 12px 6px 0; color: var(--muted); font-size: 13px; }
.sload i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: dots 1s ease-in-out infinite; }
.sload i:nth-child(2) { animation-delay: .15s; } .sload i:nth-child(3) { animation-delay: .3s; margin-right: 4px; }
@keyframes dots { 50% { opacity: .25; transform: translateY(-2px); } }
.none { display: grid; justify-items: center; gap: 6px; padding: 48px 12px; color: var(--muted); text-align: center; }
.none b { color: var(--ink); font-size: 16px; }
.sv-err { background: var(--bad-bg); color: var(--bad); border-radius: 10px; padding: 10px 12px; font-weight: 600; margin: 14px 0 0; }

.swap-enter-active, .swap-leave-active { transition: opacity .18s, transform .18s cubic-bezier(.2, .8, .2, 1); }
.swap-enter-from, .swap-leave-to { opacity: 0; transform: translateY(8px); }

@media (max-width: 760px) {
  .sv-bento { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
  .bc.sv-big { grid-row: auto; padding: 18px; } .sv-big .tt { font-size: 19px; } .sv-big .dt { -webkit-line-clamp: 5; }
  .sv-bar { height: 56px; border-radius: 16px; } .sv-bar input { font-size: 16px; } .kb { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .swap-enter-from, .swap-leave-to, .sv-bento-enter-from { transform: none; }
  .sv-bento-move, .bc, .chev, .fold { transition: none; }
  .bc:hover { transform: none; } .d-working i { animation: none; }
  .sv-bar.busy .line { animation: none; transform: none; } .sload i { animation: none; }
}
</style>
