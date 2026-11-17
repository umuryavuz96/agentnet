<script setup lang="ts">
// Activity, board page 08: every message on the network, newest first, with its kind colour, from and to, subject and the body in full.
// A team post fans out to each member ("[team] subject"); the feed shows it once, "to <team> · team". Data: the live stream (net.messages), no new polling.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { loadTeams, net, teams, useAgentnet } from "../net";

const stop = useAgentnet();
onUnmounted(stop);
onMounted(() => { if (!teams.list.length) void loadTeams(); });

const KC: Record<string, string> = { task: "var(--warn)", report: "var(--on)", question: "#6aa8ff", answer: "#b48cff", info: "#38c6d9" };
const KINDS = ["task", "report", "question", "answer", "info"] as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

interface Row { key: string; at: number; from: string; to: string; team: string | null; kind: string; subject: string; body: string }
const tName = (id: string) => teams.list.find((t) => t.id === id)?.name || id;
const feed = computed<Row[]>(() => {
  const M = [...net.messages].sort((a, b) => b.at - a.at);
  const out: Row[] = [], posts: Row[] = [];
  for (const m of M) if (m.to.startsWith("team:")) posts.push({ key: `${m.id ?? m.at}:${m.from}`, at: m.at, from: m.from, to: m.to, team: m.to.slice(5), kind: m.kind, subject: m.subject ?? "", body: m.body });
  out.push(...posts);
  const pre = /^\[[^\]]+\] /;
  for (const m of M) {
    if (m.to.startsWith("team:")) continue;
    const subject = m.subject ?? "";
    if (pre.test(subject) && posts.some((t) => t.subject === subject.replace(pre, "") && t.at === m.at)) continue; // the per-member copy of a team post
    out.push({ key: `${m.id ?? m.at}:${m.from}:${m.to}`, at: m.at, from: m.from, to: m.to, team: null, kind: m.kind, subject, body: m.body });
  }
  return out.sort((a, b) => b.at - a.at);
});
const filter = ref<"all" | (typeof KINDS)[number]>("all");
const who = ref<string | null>(null);
const inKind = computed(() => (filter.value === "all" ? feed.value : feed.value.filter((r) => r.kind === filter.value)));
const rows = computed(() => (who.value ? inKind.value.filter((r) => r.from === who.value || r.to === who.value) : inKind.value));
// agent filter: every agent seen in the feed, with how many messages it sent or got (from or to)
const open = ref(false), aq = ref(""), box2 = ref<HTMLElement | null>(null), ain = ref<HTMLInputElement | null>(null), at = ref(0);
const agentList = computed(() => {
  const n = new Map<string, number>();
  for (const r of feed.value) { n.set(r.from, (n.get(r.from) ?? 0) + 1); if (!r.team && r.to !== r.from) n.set(r.to, (n.get(r.to) ?? 0) + 1); }
  return [...n].map(([name, c]) => ({ name, c })).sort((a, b) => b.c - a.c || a.name.localeCompare(b.name));
});
const shown = computed(() => agentList.value.filter((a) => a.name.toLowerCase().includes(aq.value.trim().toLowerCase())));
function toggle() { open.value = !open.value; aq.value = ""; at.value = 0; if (open.value) void nextTick(() => ain.value?.focus()); }
function choose(n: string | null) { who.value = n; open.value = false; }
function onAk(e: KeyboardEvent) {
  const n = shown.value.length + 1; // row 0 = Any agent
  if (e.key === "ArrowDown") { e.preventDefault(); at.value = (at.value + 1) % n; }
  else if (e.key === "ArrowUp") { e.preventDefault(); at.value = (at.value + n - 1) % n; }
  else if (e.key === "Enter") { e.preventDefault(); choose(at.value === 0 ? null : shown.value[at.value - 1]?.name ?? null); }
  else if (e.key === "Escape") { e.stopPropagation(); open.value = false; }
}
const outside = (e: MouseEvent) => { if (open.value && box2.value && !box2.value.contains(e.target as Node)) open.value = false; };
onMounted(() => document.addEventListener("mousedown", outside));
onUnmounted(() => document.removeEventListener("mousedown", outside));
const base = computed(() => (who.value ? feed.value.filter((r) => r.from === who.value || r.to === who.value) : feed.value));
const count = (k: string) => (k === "all" ? base.value.length : base.value.filter((r) => r.kind === k).length);
const sel = ref<string | null>(null);
const picked = computed(() => rows.value.find((r) => r.key === sel.value) ?? null);
const wide = ref(matchMedia("(min-width: 1100px)").matches);
const mq = matchMedia("(min-width: 1100px)"); const onMq = () => { wide.value = mq.matches; }; mq.addEventListener("change", onMq);
onUnmounted(() => mq.removeEventListener("change", onMq));

const hm = (ms: number) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const dayOf = (ms: number) => { const d = new Date(ms), n = new Date(net.now); const same = (a: Date, b: Date) => a.toDateString() === b.toDateString(); const y = new Date(net.now - 86_400_000);
  return (same(d, n) ? "Today, " : same(d, y) ? "Yesterday, " : "") + d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const span = computed(() => (feed.value.length > 1 ? Math.round((feed.value[0].at - feed.value[feed.value.length - 1].at) / 60_000) : 0));
const spanTxt = computed(() => (span.value >= 120 ? `${Math.round(span.value / 60)} h` : `${span.value} min`));

// "N new" pill instead of moving the list while the reader is scrolled down.
const box = ref<HTMLElement | null>(null);
const fresh = ref(0);
let seen = 0;
watch(() => feed.value.length, (n) => {
  if (!seen) { seen = n; return; }
  const d = n - seen; seen = n;
  if (d > 0 && (box.value?.scrollTop ?? 0) > 40) fresh.value += d;
}, { immediate: true });
const toTop = () => { fresh.value = 0; box.value?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); };
const onScroll = () => { if ((box.value?.scrollTop ?? 0) <= 40) fresh.value = 0; };
const days = computed(() => { const g: { day: string; rows: Row[] }[] = []; for (const r of rows.value) { const d = dayOf(r.at); (g[g.length - 1]?.day === d ? g[g.length - 1] : g[g.push({ day: d, rows: [] }) - 1]).rows.push(r); } return g; });
function pick(r: Row) { sel.value = r.key; void nextTick(); }
</script>

<template>
  <section class="page fp ac">
    <header class="ph"><h1>Activity</h1><span v-if="feed.length" class="ph-s"><b class="num">{{ feed.length }}</b> messages<template v-if="span"> · last {{ spanTxt }}</template></span></header>
    <div class="main">
      <div class="col">
        <div class="chips" role="group" aria-label="Filters">
          <button type="button" class="chip" :class="{ on: filter === 'all' }" :aria-pressed="filter === 'all'" @click="filter = 'all'">All<b class="num">{{ count("all") }}</b></button>
          <button v-for="k in KINDS" :key="k" type="button" class="chip" :class="{ on: filter === k, z: !count(k) }" :aria-pressed="filter === k" @click="filter = k"><i class="kd" :style="{ background: KC[k] }" />{{ cap(k) }}<b class="num">{{ count(k) }}</b></button>
          <span class="sp" />
          <div ref="box2" class="ag">
            <button type="button" class="chip pick" :class="{ on: !!who }" aria-haspopup="listbox" :aria-expanded="open" @click="toggle"><Icon name="user" :size="14" />{{ who ?? "Any agent" }}<Icon name="chevron-down" :size="14" class="cv" /></button>
            <Transition name="fd">
              <div v-if="open" class="menu" role="dialog" aria-label="Filter by agent" @keydown="onAk">
                <label class="mi"><Icon name="search" :size="15" /><input ref="ain" v-model="aq" type="text" role="combobox" aria-controls="agl" aria-expanded="true" placeholder="Find an agent" autocomplete="off" spellcheck="false" @input="at = 0" /></label>
                <ul id="agl" class="al" role="listbox">
                  <li role="option" :class="{ on: at === 0 }" :aria-selected="!who" @mousemove="at = 0" @click="choose(null)">Any agent<b class="num">{{ feed.length }}</b></li>
                  <li v-for="(a, i) in shown" :key="a.name" role="option" :class="{ on: at === i + 1 }" :aria-selected="who === a.name" @mousemove="at = i + 1" @click="choose(a.name)"><span>{{ a.name }}</span><b class="num">{{ a.c }}</b></li>
                  <li v-if="!shown.length" class="none">No agent matches "{{ aq }}".</li>
                </ul>
              </div>
            </Transition>
          </div>
        </div>
        <div class="feed-w">
          <div ref="box" class="feed" @scroll.passive="onScroll">
            <p v-if="!feed.length" class="msg" role="status">{{ net.connected ? "No messages on the network yet." : "Connecting to the agent network…" }}</p>
            <p v-else-if="!rows.length" class="msg">No {{ filter }} messages in this window.</p>
            <template v-for="g in days" :key="g.day">
              <div class="day">{{ g.day }}</div>
              <TransitionGroup name="ev" tag="div">
                <div v-for="m in g.rows" :key="m.key" class="ev" :class="{ on: sel === m.key }" :style="{ '--k': KC[m.kind] ?? 'var(--muted)' }" role="button" tabindex="0" :aria-pressed="sel === m.key" @click="pick(m)" @keydown.enter="pick(m)">
                  <time>{{ hm(m.at) }}</time><span class="k" />
                  <div class="h"><b>{{ m.from }}</b><span class="ar">to</span><template v-if="m.team"><b>{{ tName(m.team) }}</b><span class="tm">team</span></template><b v-else>{{ m.to }}</b><span class="kn">{{ m.kind }}</span></div>
                  <span class="s">{{ m.subject || m.body }}</span>
                  <span v-if="m.subject && m.body" class="b">{{ m.body }}</span>
                </div>
              </TransitionGroup>
            </template>
          </div>
          <Transition name="fd"><button v-if="fresh" type="button" class="pill" @click="toTop">{{ fresh }} new</button></Transition>
        </div>
      </div>

      <Transition name="pn">
        <aside v-if="picked" class="pane" :class="{ sheet: !wide }" :aria-label="'Message: ' + (picked.subject || picked.from)">
          <div v-if="!wide" class="grab" aria-hidden="true" />
          <div class="dt">
            <div class="top"><i class="kd" :style="{ background: KC[picked.kind] }" />{{ picked.kind }} · {{ hm(picked.at) }}<span class="sp" /><button type="button" class="ico" aria-label="Close" @click="sel = null"><Icon name="x" :size="17" /></button></div>
            <h3>{{ picked.subject || picked.body.slice(0, 120) }}</h3>
            <div class="kv"><span>From</span><b>{{ picked.from }}</b><span>To</span><b>{{ picked.team ? tName(picked.team) + " (team channel)" : picked.to }}</b></div>
            <p class="tx">{{ picked.body }}</p>
            <div class="acts">
              <a v-if="picked.team" class="btn" :href="'#/agents?team=' + encodeURIComponent(picked.team)"><Icon name="users" :size="15" />Open team</a>
              <a class="btn" :href="'#/agents?agent=' + encodeURIComponent(picked.from)"><Icon name="user" :size="15" />Open {{ picked.from }}</a>
            </div>
          </div>
        </aside>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.ac{flex:1;min-height:0;gap:0}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.sp{flex:1}
.main{flex:1;min-height:0;display:flex;gap:16px}
.col{flex:1;min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{all:unset;box-sizing:border-box;cursor:pointer;height:28px;white-space:nowrap;padding:0 11px;border-radius:999px;display:inline-flex;align-items:center;font:600 13px/1 var(--body);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line);transition:background .15s var(--ease),color .15s var(--ease)}
.chip b{font:500 12px var(--mono);margin-left:6px;opacity:.75}
.chip.on{background:var(--ink);color:var(--bg);box-shadow:none}.chip.z:not(.on){opacity:.5}.chip:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.ag{position:relative}
.pick{gap:6px}.pick .cv{opacity:.7}
.menu{position:absolute;right:0;top:34px;z-index:10;width:300px;max-height:min(420px,60dvh);display:flex;flex-direction:column;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),0 18px 40px -12px rgb(0 0 0/.55);overflow:hidden}
.mi{display:flex;gap:8px;align-items:center;height:44px;padding:0 14px;border-bottom:1px solid var(--line);color:var(--muted)}
.mi input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--ink);font:500 14px var(--body)}
.al{list-style:none;margin:0;padding:4px 0;overflow:auto}
.al li{display:flex;justify-content:space-between;gap:10px;align-items:center;min-height:36px;padding:0 14px;font-size:13.5px;cursor:pointer;overflow-wrap:anywhere}
.al li.on{background:var(--track)}.al li[aria-selected=true]{font-weight:700}.al b{font:500 12px var(--mono);color:var(--muted)}
.al .none{color:var(--muted);cursor:default}
.kd{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.top .kd{margin-right:0}
.feed-w{position:relative;min-height:0;display:grid}
.feed{overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-height:0}
.day{position:sticky;top:0;z-index:1;padding:10px 18px;background:var(--panel);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600}
.ev{display:grid;grid-template-columns:52px 10px minmax(0,1fr);gap:4px 12px;padding:12px 18px;border-top:1px solid var(--hair);cursor:pointer}
.ev:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}.ev.on{background:var(--soft);box-shadow:inset 3px 0 0 var(--ink)}
.ev:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.ev time{color:var(--muted);font:12px var(--mono);padding-top:3px}
.ev .k{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--k)}
.h{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;font-size:13px}.h b{font-weight:600;overflow-wrap:anywhere}.ar,.kn{color:var(--muted)}.kn{margin-left:auto;font-size:12px}
.tm{font:600 11px/1 var(--mono);color:var(--muted);padding:3px 6px;border-radius:6px;box-shadow:inset 0 0 0 1px var(--line)}
.s{grid-column:3;font-weight:600;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.b{grid-column:3;color:var(--muted);font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.msg{margin:0;padding:48px 20px;color:var(--muted);text-align:center;font-size:14px}
.pill{position:absolute;top:44px;left:50%;transform:translateX(-50%);height:32px;padding:0 14px;border:0;border-radius:999px;background:var(--ink);color:var(--bg);font:600 13px var(--body);cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:2}
.pill:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.pane{flex:none;width:440px;min-height:0;overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}
.dt{padding:18px 16px;display:grid;align-content:start;gap:14px}
.top{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px}
.ico{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;margin:-8px -6px;color:var(--muted);border-radius:8px}.ico:hover{color:var(--ink);background:var(--soft)}.ico:focus-visible{outline:2px solid var(--on)}
.dt h3{margin:0;font:700 18px/1.3 var(--body);overflow-wrap:anywhere}
.kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:8px 12px;font-size:13px}.kv span{color:var(--muted)}.kv b{font-weight:600;overflow-wrap:anywhere}
.tx{margin:0;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:34px;padding:0 12px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);font:600 13px var(--body);color:var(--ink)}
.btn:hover{background:var(--soft)}.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.ev-enter-active{transition:transform .2s var(--ease),opacity .2s var(--ease)}.ev-enter-from{transform:translateY(-8px);opacity:0}
.pn-enter-active,.pn-leave-active{transition:transform .2s var(--ease),opacity .2s var(--ease)}.pn-enter-from,.pn-leave-to{transform:translateX(10px);opacity:0}
.fd-enter-active,.fd-leave-active{transition:opacity .12s var(--ease)}.fd-enter-from,.fd-leave-to{opacity:0}
@media (max-width:1099px){
  .pane.sheet{position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));width:auto;height:56%;max-height:calc(100dvh - 140px);border-radius:18px 18px 0 0;box-shadow:0 -1px 0 var(--line),0 -12px 32px rgba(0,0,0,.25);z-index:40}
  .pn-enter-from,.pn-leave-to{transform:translateY(24px)}
  .grab{width:36px;height:5px;border-radius:3px;background:var(--line);margin:8px auto 0}
}
@media (max-width:760px){
  .ph{display:none}.chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.chip{flex:none}.sp{display:none}.ag{position:static}.menu{position:fixed;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));top:auto;width:auto;max-height:60dvh;border-radius:18px 18px 0 0}.al li{min-height:44px}
  .ev{padding:12px 14px}.main{gap:0}
}
@media (prefers-reduced-motion:reduce){.ev-enter-active,.pn-enter-active,.pn-leave-active{transition:opacity .12s}.ev-enter-from,.pn-enter-from,.pn-leave-to{transform:none}}
</style>
