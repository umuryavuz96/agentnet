<script setup lang="ts">
// Search past work, board page 08: the bar keeps the words, filter chips by kind with counts and the time each source took, results on the left,
// the picked result in a 440 px pane on the right (a non-modal half sheet on a phone). Data: GET v1/panel/trails/search, notes and commits first
// (fts), past sessions (cass) after typing stops. The network feed that used to sit under the empty bar is the Activity page now.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, useAgentnet } from "../net";
import { route } from "../router";
import { toast, url } from "../ui/api";

interface Hit { id: string; kind: "note" | "commit" | "checkpoint" | "session" | "cass"; repo: string; date: string; agent: string; title: string; files: string[]; snippet: string; checkpoint: string; commit: string; score: number; matched: number }
type Cat = "note" | "commit" | "session";
const cat = (h: Hit): Cat => (h.kind === "note" ? "note" : h.kind === "commit" || h.kind === "checkpoint" ? "commit" : "session");
const META: Record<Cat, [string, string]> = { note: ["file-text", "Decision note"], commit: ["git-commit-horizontal", "Commit"], session: ["history", "Past session"] };

const stop = useAgentnet();
onUnmounted(stop);

const q = ref(typeof route.value.query.q === "string" ? route.value.query.q : "");
const hits = ref<Hit[]>([]), loading = ref(false), err = ref(""), ranFor = ref(""), ms = ref<number | null>(null);
const sessions = ref<Hit[]>([]), sLoading = ref(false), sFor = ref(""), sMs = ref<number | null>(null);
const filter = ref<"all" | Cat>("all");
const sel = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);
const term = computed(() => q.value.trim());
const searching = computed(() => term.value.length > 0);
const short = computed(() => term.value.length < 3);
const all = computed(() => [...hits.value, ...sessions.value]);
const count = (c: "all" | Cat) => (c === "all" ? all.value.length : all.value.filter((h) => cat(h) === c).length);
const rows = computed(() => (filter.value === "all" ? all.value : all.value.filter((h) => cat(h) === filter.value)));
const picked = computed(() => rows.value.find((h) => h.id === sel.value) ?? null);
const wide = ref(matchMedia("(min-width: 1100px)").matches);
const mq = matchMedia("(min-width: 1100px)"); const onMq = () => { wide.value = mq.matches; }; mq.addEventListener("change", onMq);
onUnmounted(() => mq.removeEventListener("change", onMq));

let timer: ReturnType<typeof setTimeout> | undefined, timer2: ReturnType<typeof setTimeout> | undefined, ctl: AbortController | null = null, ctl2: AbortController | null = null;
// cass snippets arrive HTML-escaped with **bold** match markers: show plain text (the terms are highlighted here).
const plain = (t: string) => t.replace(/\*\*/g, "").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let cassOn = true;
async function runSessions(text: string) {
  if (!cassOn) { sLoading.value = false; return; }
  ctl2?.abort(); ctl2 = new AbortController(); sLoading.value = true;
  const t0 = performance.now();
  try {
    const r = await fetch(url(`v1/panel/trails/search?q=${encodeURIComponent(text)}&limit=20&sources=cass`), { signal: ctl2.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json() as { hits?: Hit[]; cass?: boolean };
    if (j.cass === false) cassOn = false; // cass is not installed on this server: stop asking
    const seen = new Set(hits.value.map((h) => h.id));
    sessions.value = (j.hits ?? []).filter((h) => h.kind === "cass" && !seen.has(h.id)).map((h) => ({ ...h, title: plain(h.title), snippet: plain(h.snippet) }));
    sFor.value = text; sMs.value = performance.now() - t0; sLoading.value = false;
  } catch (e) { if ((e as Error).name !== "AbortError") { sessions.value = []; sLoading.value = false; } }
}
function stopSessions() { clearTimeout(timer2); ctl2?.abort(); sLoading.value = false; }
async function run(text: string) {
  ctl?.abort(); ctl = new AbortController(); loading.value = true; err.value = "";
  try {
    const r = await fetch(url(`v1/panel/trails/search?q=${encodeURIComponent(text)}&limit=20&sources=fts`), { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status === 404 ? "Search is not available on this server yet" : `HTTP ${r.status}`);
    const j = await r.json() as { hits?: Hit[]; ms?: number };
    hits.value = j.hits ?? []; ms.value = j.ms ?? null; ranFor.value = text;
    if (sFor.value !== text) sessions.value = sessions.value.filter((h) => !hits.value.some((x) => x.id === h.id));
    sel.value = wide.value ? rows.value[0]?.id ?? null : null;
    loading.value = false;
  } catch (e) {
    if ((e as Error).name === "AbortError") return; // a newer request owns the loading state
    err.value = (e as Error).message; loading.value = false;
  }
}
watch(term, (t) => {
  clearTimeout(timer); stopSessions();
  if (t.length < 3) { ctl?.abort(); loading.value = false; err.value = ""; sessions.value = []; sel.value = null; if (!t) { hits.value = []; ranFor.value = ""; sFor.value = ""; } return; }
  loading.value = true; timer = setTimeout(() => run(t), 150);
  if (cassOn) { timer2 = setTimeout(() => runSessions(t), 400); sLoading.value = true; }
}, { immediate: true });
watch(filter, () => { if (!rows.value.some((h) => h.id === sel.value)) sel.value = wide.value ? rows.value[0]?.id ?? null : null; });
onUnmounted(() => { clearTimeout(timer); stopSessions(); ctl?.abort(); });

// ---- highlight: whole words only (a word, then an optional plural s), as text nodes + <mark>, never v-html ----
const words = computed(() => [...new Set(ranFor.value.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? [])].filter((w) => w.length > 1));
const rx = computed(() => (words.value.length ? new RegExp(`(?<![A-Za-z0-9_])(${words.value.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(s?)(?![A-Za-z0-9_])`, "ig") : null));
function parts(text: string) {
  if (!rx.value) return [{ t: text, m: false }];
  const out: { t: string; m: boolean }[] = []; let last = 0;
  for (const m of text.matchAll(rx.value)) { if (m.index! > last) out.push({ t: text.slice(last, m.index), m: false }); out.push({ t: m[0], m: true }); last = m.index! + m[0].length; }
  if (last < text.length) out.push({ t: text.slice(last), m: false });
  return out;
}
function dateAgo(d: string) {
  const t = Date.parse(d + (d.length === 10 ? "T12:00:00" : "")); if (Number.isNaN(t)) return d;
  const days = Math.round((net.now - t) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 31 ? `${days} d ago` : d;
}
const secs = (n: number | null) => (n == null ? "" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);

// ---- keyboard ----
function move(d: number) {
  if (!rows.value.length) return;
  const i = rows.value.findIndex((h) => h.id === sel.value);
  sel.value = rows.value[(i + d + rows.value.length) % rows.value.length].id;
  void nextTick(() => document.getElementById("hit-" + CSS.escape(sel.value!))?.scrollIntoView({ block: "nearest" }));
}
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  else if (e.key === "Escape") { if (sel.value && !wide.value) sel.value = null; else if (q.value) q.value = ""; else input.value?.blur(); }
}
function onGlobal(e: KeyboardEvent) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && e.shiftKey) { e.preventDefault(); input.value?.focus(); input.value?.select(); } }
onMounted(() => { input.value?.focus({ preventScroll: true }); addEventListener("keydown", onGlobal); });
onUnmounted(() => removeEventListener("keydown", onGlobal));

async function copy(t: string) { try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { toast("Could not copy"); } }
const sessionsNote = computed(() => (!sLoading.value && sFor.value === ranFor.value && !sessions.value.length && cassOn && ranFor.value ? `Past sessions: no match for "${ranFor.value}" (searched in ${secs(sMs.value)})` : ""));
</script>

<template>
  <section class="page fp sx">
    <header class="ph"><h1>Search past work</h1><span v-if="ranFor === term && searching && !short" class="ph-s"><b class="num">{{ all.length }}</b> results</span></header>
    <div class="main" :class="{ withpane: wide && searching && picked }">
      <div class="col">
        <div class="bar" :class="{ busy: loading }" role="search">
          <Icon name="search" :size="20" />
          <input ref="input" v-model="q" type="text" role="combobox" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
            placeholder="Search agent notes, commits and past sessions" aria-label="Search agent notes, commits and past sessions"
            aria-controls="hits" :aria-expanded="searching && rows.length > 0" @keydown="onKey" />
          <button v-if="q" type="button" class="clr" aria-label="Clear search" @click="q = ''; input?.focus()"><Icon name="x" :size="18" /></button>
          <i class="line" aria-hidden="true" />
        </div>
        <div v-if="searching && !short" class="chips" role="tablist" aria-label="Kind">
          <button v-for="[id, l] in ([['all', 'All'], ['note', 'Decision notes'], ['commit', 'Commits'], ['session', 'Past sessions']] as const)" :key="id" type="button" role="tab" class="chip" :class="{ on: filter === id, z: id !== 'all' && !count(id) && !(id === 'session' && sLoading) }" :aria-selected="filter === id" @click="filter = id">{{ l }}<b class="num">{{ id === "session" && sLoading ? "…" : count(id) }}</b></button>
          <span class="sp" />
          <small v-if="ms != null">{{ secs(ms) }}<template v-if="sMs != null"> · sessions {{ secs(sMs) }}</template><template v-else-if="sLoading"> · sessions …</template></small>
        </div>
        <div class="res" :class="{ stale: loading && ranFor !== term, shy: !wide && picked }" aria-live="polite">
          <p v-if="!searching" class="msg"><Icon name="search" :size="26" /><b>Find what the agents already did</b><span>Decision notes, commits and past sessions. Type at least 3 characters.</span><a href="#/activity">Watch what the network is doing now</a></p>
          <p v-else-if="short" class="msg"><span>Type at least 3 characters.</span></p>
          <p v-else-if="err" class="msg bad" role="alert"><Icon name="triangle-alert" :size="26" /><b>Search failed</b><span>{{ err }}</span><button type="button" class="btn" @click="run(term)">Try again</button></p>
          <p v-else-if="loading && !rows.length" class="msg" role="status"><Icon name="loader" :size="22" class="spin" /><span>Searching…</span></p>
          <template v-else>
            <ul v-if="rows.length" id="hits" class="hits" role="listbox" aria-label="Results">
              <li v-for="h in rows" :id="'hit-' + h.id" :key="h.id" class="hit" :class="{ on: sel === h.id }" role="option" :aria-selected="sel === h.id" tabindex="0" @click="sel = h.id" @keydown.enter="sel = h.id">
                <span class="ic"><Icon :name="META[cat(h)][0] as never" :size="17" /></span>
                <span class="t"><template v-for="(p, j) in parts(h.title)" :key="j"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
                <span class="w">{{ dateAgo(h.date) }}</span>
                <span class="m"><span>{{ META[cat(h)][1] }}</span><b v-if="h.agent">{{ h.agent }}</b><span v-if="h.repo">{{ h.repo }}</span><span v-if="h.commit" class="num">{{ h.commit }}</span><span v-if="h.files.length">{{ h.files.length }} file{{ h.files.length > 1 ? "s" : "" }}</span></span>
                <span v-if="h.snippet" class="sn"><template v-for="(p, j) in parts(h.snippet)" :key="j"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
              </li>
            </ul>
            <p v-else-if="ranFor === term && !sLoading" class="msg"><Icon name="search" :size="26" /><b>Nothing found for "{{ term }}"</b><span>Try another word, a file name or an agent name.</span></p>
            <p v-if="sLoading" class="sess" role="status"><Icon name="loader" :size="16" class="spin" />Searching past sessions…</p>
            <p v-else-if="sessionsNote" class="sess"><Icon name="history" :size="16" />{{ sessionsNote }}</p>
          </template>
        </div>
      </div>

      <Transition name="pn">
        <aside v-if="searching && picked" :key="'p'" class="pane" :class="{ sheet: !wide }" :aria-label="'Result: ' + picked.title">
          <div v-if="!wide" class="grab" aria-hidden="true" />
          <Transition name="fd" mode="out-in">
            <div :key="picked.id" class="dt">
              <div class="top"><Icon :name="META[cat(picked)][0] as never" :size="15" />{{ META[cat(picked)][1] }}<span class="sp" /><button type="button" class="ico" aria-label="Close" @click="sel = null"><Icon name="x" :size="17" /></button></div>
              <h3>{{ picked.title }}</h3>
              <div class="kv"><span>Agent</span><b>{{ picked.agent || "not recorded" }}</b><span>Project</span><b>{{ picked.repo || "not recorded" }}</b><span>Date</span><b>{{ picked.date }} · {{ dateAgo(picked.date) }}</b><template v-if="picked.commit"><span>Commit</span><b class="num">{{ picked.commit }}</b></template><template v-if="picked.checkpoint"><span>Checkpoint</span><b class="num">{{ picked.checkpoint }}</b></template></div>
              <p v-if="picked.snippet" class="tx"><template v-for="(p, j) in parts(picked.snippet)" :key="j"><mark v-if="p.m">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></p>
              <template v-if="picked.files.length"><h4>Files</h4><div class="fl"><span v-for="f in picked.files" :key="f"><Icon name="file-text" :size="14" />{{ f }}</span></div></template>
              <div class="acts">
                <button v-if="picked.commit" type="button" class="btn" @click="copy(picked.commit)"><Icon name="copy" :size="15" />Copy commit</button>
                <a v-if="picked.agent" class="btn" :href="'#/agents?agent=' + encodeURIComponent(picked.agent)"><Icon name="user" :size="15" />Open {{ picked.agent }}</a>
              </div>
              <p class="rule">Past work can be stale: check the files before acting on it.</p>
            </div>
          </Transition>
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.sx{flex:1;min-height:0;gap:0}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.sp{flex:1}
.main{flex:1;min-height:0;display:flex;gap:16px}
.col{flex:1;min-width:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:14px}
.bar{position:relative;display:flex;align-items:center;gap:12px;height:52px;padding:0 16px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1.5px var(--ink);font-size:17px;overflow:hidden;color:var(--muted)}
.bar input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:var(--ink);font:500 17px var(--body)}
.bar input::placeholder{color:var(--muted);font-size:15px}
.clr{all:unset;cursor:pointer;display:grid;place-items:center;width:44px;height:44px;margin-right:-10px;color:var(--muted)}.clr:hover{color:var(--ink)}.clr:focus-visible{outline:2px solid var(--on);outline-offset:-2px;border-radius:10px}
.line{position:absolute;left:0;bottom:0;height:2px;width:100%;background:linear-gradient(90deg,transparent,var(--ink),transparent);transform:translateX(-100%);opacity:0}
.bar.busy .line{opacity:1;animation:sweep 1s linear infinite}@keyframes sweep{to{transform:translateX(100%)}}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{all:unset;box-sizing:border-box;cursor:pointer;height:28px;padding:0 11px;border-radius:999px;display:inline-flex;align-items:center;font:600 13px/1 var(--body);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line);transition:background .15s var(--ease),color .15s var(--ease)}
.chip b{font:500 12px var(--mono);margin-left:6px;opacity:.75}
.chip.on{background:var(--ink);color:var(--bg);box-shadow:none}.chip.z:not(.on){opacity:.5}
.chip:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.chips small{color:var(--muted);font-size:12px}
.res{overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-height:0;transition:opacity .18s}.res.stale{opacity:.6}
.hits{list-style:none;margin:0;padding:0}
.hit{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:4px 12px;padding:13px 18px;border-top:1px solid var(--hair);cursor:pointer}
.hit:first-child{border-top:0}.hit:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}.hit.on{background:var(--soft);box-shadow:inset 3px 0 0 var(--ink)}
.hit:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ic{color:var(--muted);padding-top:2px}
.t{font-weight:600;font-size:14.5px;line-height:1.35;overflow-wrap:anywhere}
.w{color:var(--muted);font-size:12px;white-space:nowrap;padding-top:3px}
.sn{grid-column:2/4;color:var(--muted);font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.m{grid-column:2/4;display:flex;flex-wrap:wrap;gap:4px 10px;color:var(--muted);font-size:12px}.m b{color:var(--ink);font-weight:600}
mark{background:color-mix(in srgb,var(--pend) 30%,transparent);color:inherit;border-radius:3px;padding:0 1px}
.sess{display:flex;gap:10px;align-items:center;margin:0;padding:12px 18px;border-top:1px solid var(--hair);color:var(--muted);font-size:13px}
.msg{display:grid;justify-items:center;gap:8px;margin:0;padding:48px 20px;color:var(--muted);text-align:center;font-size:14px}.msg b{color:var(--ink);font-size:16px}.msg.bad{color:var(--bad)}
.msg a{color:var(--ink);font-weight:600;text-underline-offset:3px}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:34px;padding:0 12px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);font:600 13px var(--body);color:var(--ink)}
.btn:hover{background:var(--soft)}.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.spin{animation:rot 1s linear infinite}@keyframes rot{to{transform:rotate(360deg)}}
.pane{flex:none;width:440px;min-height:0;overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}
.dt{padding:18px 16px;display:grid;align-content:start;gap:14px}
.top{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px}
.ico{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;margin:-8px -6px;color:var(--muted);border-radius:8px}.ico:hover{color:var(--ink);background:var(--soft)}.ico:focus-visible{outline:2px solid var(--on)}
.dt h3{margin:0;font:700 18px/1.3 var(--body);overflow-wrap:anywhere}
.kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 12px;font-size:13px}.kv span{color:var(--muted)}.kv b{font-weight:600;overflow-wrap:anywhere}
.tx{margin:0;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}
.dt h4{margin:0;font:600 12px/1 var(--body);color:var(--muted)}
.fl{display:grid;gap:6px}.fl span{display:flex;gap:8px;align-items:center;font:12.5px var(--mono);overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.rule{margin:0;color:var(--muted);font-size:12px}
.pn-enter-active,.pn-leave-active{transition:transform .2s var(--ease),opacity .2s var(--ease)}
.pn-enter-from,.pn-leave-to{transform:translateX(10px);opacity:0}
.fd-enter-active,.fd-leave-active{transition:opacity .12s var(--ease)}.fd-enter-from,.fd-leave-to{opacity:0}
@media (max-width:1099px){
  .pane.sheet{position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));width:auto;height:56%;max-height:calc(100dvh - 140px);border-radius:18px 18px 0 0;box-shadow:0 -1px 0 var(--line),0 -12px 32px rgba(0,0,0,.25);z-index:40}
  .pn-enter-from,.pn-leave-to{transform:translateY(24px)}
  .grab{width:36px;height:5px;border-radius:3px;background:var(--line);margin:8px auto 0}
}
@media (max-width:760px){
  .ph{display:none}.sx{padding-bottom:0}
  .bar{height:46px;font-size:16px}.bar input{font-size:16px}
  .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.chips small{display:none}.chip{flex:none}
  .hit{padding:12px 14px}.main{gap:0}
  .res.shy{padding-bottom:56%}
}
@media (prefers-reduced-motion:reduce){.pn-enter-active,.pn-leave-active{transition:opacity .12s}.pn-enter-from,.pn-leave-to{transform:none}.spin,.bar.busy .line{animation:none}}
</style>
