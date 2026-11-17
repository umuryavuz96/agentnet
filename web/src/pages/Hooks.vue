<script setup lang="ts">
// Hooks page (board 09): one row per hook, not per settings entry (a hook set on 10 events is one row). Three tiles on
// top (what a prompt waits for, failing as a share, the setup count), a list, and a 420 px pane for the picked hook.
// Switching backs up settings.json on the server; Undo switches the same entries back for 10 s.
import { ref, computed, onMounted, watch } from "vue";
import { route, toHash } from "../router";
import { api, ago, toast } from "../ui/api";
import Icon from "../ui/Icon.vue";
import HookAddSheet from "./HookAddSheet.vue";

interface Run { at: number; ms: number | null; ok: boolean; text: string }
interface HookInfo { id: string; event: string; matcher: string | null; command: string; script: string; timeout: number | null; enabled: boolean; name: string; about: string; log: string | null; runs: number; failures: number; avgMs: number | null; p95Ms: number | null; lastAt: number | null; recent: Run[] }
interface Res { hooks: HookInfo[]; backups: string[]; error?: string }
interface HG { key: string; name: string; about: string; events: string[]; entries: HookInfo[]; script: string; command: string; timeout: number | null; enabled: boolean; logged: boolean; runs: number; failures: number; avgMs: number | null; p95Ms: number | null; lastAt: number | null; recent: Run[] }

const hooks = ref<HookInfo[]>([]), backups = ref<string[]>([]), err = ref(""), loaded = ref(false), busy = ref<string | null>(null), open = ref<string | null>(null);
const ORDER = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "StopFailure", "SubagentStop", "PreCompact", "SessionEnd"];
const rank = (e: string) => { const i = ORDER.indexOf(e); return i < 0 ? 99 : i; };
/** One group per hook: entries with the same name and script (set on several events) are one hook. Failing first, then most runs; a switch never moves a row. */
const groups = computed<HG[]>(() => {
  const m = new Map<string, HookInfo[]>();
  for (const h of hooks.value) { const k = h.name + "\u0000" + h.script; (m.get(k) ?? m.set(k, []).get(k)!).push(h); }
  const out: HG[] = [...m.entries()].map(([key, es]) => {
    const runs = es.reduce((a, h) => a + h.runs, 0), withAvg = es.filter((h) => h.avgMs != null && h.runs), w = withAvg.reduce((a, h) => a + h.runs, 0);
    return {
      key, name: es[0].name, about: es[0].about, entries: es, script: es[0].script, command: es[0].command, timeout: es[0].timeout,
      events: [...new Set(es.map((h) => h.event))].sort((a, b) => rank(a) - rank(b)),
      enabled: es.every((h) => h.enabled), logged: es.some((h) => !!h.log), runs, failures: es.reduce((a, h) => a + h.failures, 0),
      avgMs: w ? withAvg.reduce((a, h) => a + (h.avgMs ?? 0) * h.runs, 0) / w : null,
      p95Ms: es.some((h) => h.p95Ms != null) ? Math.max(...es.map((h) => h.p95Ms ?? 0)) : null,
      lastAt: es.reduce<number | null>((a, h) => (h.lastAt && (!a || h.lastAt > a) ? h.lastAt : a), null),
      recent: es.flatMap((h) => h.recent).sort((a, b) => b.at - a.at).slice(0, 5),
    };
  });
  return out.sort((a, b) => b.failures - a.failures || b.runs - a.runs || a.name.localeCompare(b.name));
});
const failingGroups = computed(() => groups.value.filter((g) => g.failures > 0));
const loggedCount = computed(() => groups.value.filter((g) => g.logged).length);
const offCount = computed(() => groups.value.filter((g) => !g.enabled).length);
/** Prompt hooks run side by side, so a prompt waits for the slowest p95 among them. */
const promptGroups = computed(() => groups.value.filter((g) => g.events.includes("UserPromptSubmit")));
const waitBars = computed(() => promptGroups.value.filter((g) => g.p95Ms != null).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0)).slice(0, 3));
const waitMs = computed(() => waitBars.value[0]?.p95Ms ?? null);
const waitLimit = computed(() => Math.max(1, ...promptGroups.value.map((g) => g.timeout ?? 0)));
const picked = computed(() => groups.value.find((g) => g.key === open.value) ?? null);
const take = (r: Res) => { hooks.value = r.hooks; backups.value = r.backups; err.value = r.error ?? ""; loaded.value = true; };
async function load() { try { take(await api<Res>("v1/panel/hooks")); } catch (e) { err.value = (e as Error).message; loaded.value = true; } }

/** Switch every entry of a hook one after the other (the server backs settings up each time), then offer Undo for 10 s. */
const sw = ref<{ name: string; ids: string[]; to: boolean } | null>(null);
let swTimer = 0;
async function setGroup(ids: string[], to: boolean) { for (const id of ids) take(await api<Res>(`v1/panel/hooks/${id}/enabled`, { body: { enabled: to } })); }
async function toggle(g: HG) {
  if (busy.value) return; busy.value = g.key;
  const to = !g.enabled, ids = g.entries.map((h) => h.id);
  try { await setGroup(ids, to); sw.value = { name: g.name, ids, to }; clearTimeout(swTimer); swTimer = window.setTimeout(() => { sw.value = null; }, 10_000); }
  catch (e) { toast((e as Error).message); await load(); } finally { busy.value = null; }
}
async function undoSwitch() {
  const s = sw.value; if (!s || busy.value) return; sw.value = null; busy.value = "undo";
  try { await setGroup(s.ids, !s.to); } catch (e) { toast((e as Error).message); await load(); } finally { busy.value = null; }
}
const menu = ref(false);
async function rollback() {
  if (busy.value) return; busy.value = "rollback"; menu.value = false; sw.value = null;
  try { const r = await api<Res & { restored: string }>("v1/panel/hooks/rollback", { body: {} }); take(r); toast(`Restored ${r.restored}`); }
  catch (e) { toast((e as Error).message); } finally { busy.value = null; }
}

const ms = (n: number | null) => (n == null ? "—" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`);
/** Bar fill and the avg mark as a share of the hook's own limit; amber past 60%. */
const lim = (g: HG) => (g.timeout ? g.timeout * 1000 : null);
const frac = (v: number | null, g: HG) => (v == null ? 0 : Math.min(1, v / (lim(g) ?? Math.max(v, 1))));
const hot = (g: HG) => !!lim(g) && (g.p95Ms ?? 0) / lim(g)! > 0.6;
const runsOn = (g: HG) => (g.events.length === 1 ? g.events[0] : `${g.events.length} events`);
const lastFail = (g: HG) => g.recent.find((r) => !r.ok) ?? null;
const showRuns = ref(false);
/** Home directories shown as ~ (keeps the user name out of the page). */
const tilde = (s: string) => s.replace(/\/(?:Users|home)\/[^/\s]+/g, "~");
const pick = (g: HG) => { open.value = open.value === g.key ? null : g.key; showRuns.value = false; };

/** Add flow: the sheet reports a new hook; scroll its row in with a short highlight, offer Undo while its backup is still the newest. */
const adding = ref(false), starter = ref(false), hl = ref<string | null>(null), undo = ref<{ name: string; backup: string } | null>(null), confirmRm = ref<string | null>(null);
let undoTimer = 0, hlTimer = 0;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
async function reveal(id: string) {
  const g = groups.value.find((x) => x.entries.some((h) => h.id === id)); if (!g) return;
  open.value = g.key; await Promise.resolve();
  document.getElementById("hk-" + g.key.replace(/\W/g, "_"))?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
  if (!reduced()) { hl.value = g.key; clearTimeout(hlTimer); hlTimer = window.setTimeout(() => { hl.value = null; }, 1500); }
}
async function added(r: Res & { installed: string; backup: string | null }, name: string) {
  take(r); toast(`${name} added`);
  if (r.backup) { undo.value = { name, backup: r.backup }; clearTimeout(undoTimer); undoTimer = window.setTimeout(() => { undo.value = null; }, 10_000); }
  await reveal(r.installed);
}
const canUndo = computed(() => !!undo.value && backups.value[backups.value.length - 1] === undo.value.backup);
async function undoAdd() { undo.value = null; await rollback(); }
async function switchOn(id: string) { const g = groups.value.find((x) => x.entries.some((h) => h.id === id)); if (g) { await toggle(g); await reveal(id); } }
async function remove(g: HG) {
  if (busy.value) return;
  if (confirmRm.value !== g.key) { confirmRm.value = g.key; return; }
  busy.value = g.key; confirmRm.value = null;
  try { for (const h of g.entries) take(await api<Res>(`v1/panel/hooks/${h.id}`, { method: "DELETE" })); open.value = null; toast(`${g.name} removed`); }
  catch (e) { toast((e as Error).message); await load(); } finally { busy.value = null; }
}
onMounted(load);
// Deep link #/hooks?starter=1 (director onboarding): open the sheet on the Starter set review.
watch(() => route.value.page === "hooks" && route.value.query.starter === "1", (on) => { if (on) { starter.value = true; adding.value = true; } }, { immediate: true });
function closeSheet() {
  adding.value = false; starter.value = false;
  if (route.value.query.starter) { const { starter: _s, ...query } = route.value.query; route.value = { page: "hooks", query }; history.replaceState(null, "", toHash(route.value)); }
}
const rid = (g: HG) => "hk-" + g.key.replace(/\W/g, "_");
</script>

<template>
  <div class="page hk" :class="{ pk: !!picked }">
    <header class="ph">
      <div class="hk-ttl"><h1>Hooks</h1><span class="hk-meta num">{{ loaded ? groups.length : "–" }} hooks<template v-if="failingGroups.length"> · <b class="bad">{{ failingGroups.length }} failing</b></template></span></div>
      <span class="hk-hb">
        <span class="hk-bk">
          <button type="button" class="hk-btn" :aria-expanded="menu" aria-label="Backups" aria-haspopup="menu" :disabled="!!busy" @click="menu = !menu"><Icon name="history" :size="14" /><span class="hk-bt">Backups</span></button>
          <span v-if="menu" class="hk-menu" role="menu">
            <button type="button" role="menuitem" class="hk-mi" :disabled="!backups.length" @click="rollback"><b>Roll back settings</b><small>{{ backups.length ? `Put the newest of ${backups.length} backups of settings.json back` : "No backup yet" }}</small></button>
          </span>
        </span>
        <button type="button" class="hk-btn pri" aria-label="Add hook" :disabled="!!busy" @click="adding = true"><Icon name="plus" :size="14" /><span class="hk-bt">Add hook</span></button>
      </span>
    </header>
    <p v-if="canUndo" class="hk-undo" role="status">{{ undo?.name }} added. <button type="button" class="hk-link" @click="undoAdd">Undo</button></p>
    <p v-else-if="sw" class="hk-undo" role="status">{{ sw.name }} switched {{ sw.to ? "on" : "off" }}. A backup of settings was made. <button type="button" class="hk-link" @click="undoSwitch">Undo</button></p>
    <HookAddSheet :open="adding" :starter="starter" @close="closeSheet" @added="added" @switch-on="switchOn" @show="reveal" />
    <p v-if="err" class="hk-err" role="alert">{{ err }}</p>

    <div class="hk-tiles">
      <section class="hk-t t1" aria-label="What each prompt waits for">
        <h2>{{ waitMs != null ? "What each prompt waits for" : "Prompt wait" }}</h2>
        <template v-if="waitMs != null">
          <p class="hk-big num"><b>{{ ms(waitMs) }}</b><span>{{ waitBars[0].name }}, p95 of {{ waitLimit }} s</span></p>
          <ul class="hk-wb">
            <li v-for="g in waitBars" :key="g.key"><span class="hk-wt"><i :class="{ hot: hot(g) }" :style="{ width: frac(g.p95Ms, g) * 100 + '%' }" /></span><span class="hk-wn">{{ g.name }} <span class="num">{{ ms(g.p95Ms) }}</span></span></li>
          </ul>
          <p class="hk-sm">The {{ promptGroups.length }} prompt hooks run side by side, so a prompt waits for the slowest: {{ waitBars[0].name }}, {{ ms(waitMs) }} at p95{{ waitBars[0].avgMs != null ? ` (${ms(waitBars[0].avgMs)} on average)` : "" }}. {{ waitBars.length }} of the {{ promptGroups.length }} have a log.</p>
        </template>
        <p v-else class="hk-sm">{{ loaded ? "No prompt hook has a log yet, so there is no wait figure." : "Loading." }}</p>
        <p class="hk-ph num">{{ failingGroups.length ? failingGroups.length + " failing" : "none failing" }} · {{ groups.length }} hooks · {{ hooks.length }} entries</p>
      </section>
      <section class="hk-t t2" aria-label="Failing">
        <h2>Failing</h2>
        <p class="hk-big num"><b :class="{ bad: failingGroups.length }">{{ loaded ? failingGroups.length : "–" }}</b><span>of {{ groups.length }} hooks failed a run</span></p>
        <ul v-if="failingGroups.length" class="hk-fl">
          <li v-for="g in failingGroups.slice(0, 3)" :key="g.key"><b>{{ g.name }}</b><span class="num bad">{{ g.failures }} of {{ g.runs }} · {{ (g.failures / g.runs * 100).toFixed(1) }}%</span><i class="hk-fb"><i :style="{ width: Math.max(2, g.failures / g.runs * 100) + '%' }" /></i></li>
        </ul>
        <p v-else class="hk-sm">No hook has a failed run in its log.</p>
      </section>
      <section class="hk-t t3" aria-label="Set up">
        <h2>Set up</h2>
        <p class="hk-big num"><b>{{ loaded ? groups.length : "–" }}</b><span>hooks on {{ new Set(hooks.map((h) => h.event)).size }} events</span></p>
        <p class="hk-sm">{{ hooks.length }} entries in settings{{ hooks.length > groups.length ? ": a hook set on several events is one hook" : "" }}. <span class="num">{{ loggedCount }}</span> of {{ groups.length }} write a log this page can read. {{ offCount ? offCount + " switched off." : "All switched on." }}</p>
      </section>
    </div>

    <div class="hk-body">
      <div v-if="loaded && !hooks.length && !err" class="hk-empty">
        <p>No hooks yet. The starter set adds agentnet's recommended hooks in one step: safety blockers, prompt triage, usage guard, task-list reminder and context warning.</p>
        <button type="button" class="hk-btn pri" @click="starter = true; adding = true"><Icon name="plus" :size="14" /> Review the starter set</button>
      </div>
      <div v-else class="hk-list" role="table" aria-label="Hooks">
        <div class="hk-hd" role="row"><span role="columnheader">Hook</span><span role="columnheader">Runs on</span><span role="columnheader">Failed</span><span role="columnheader">Time (p95, avg mark)</span><span role="columnheader">Last run</span><span role="columnheader">On</span></div>
        <ul class="hk-rows">
          <li v-for="g in groups" :id="rid(g)" :key="g.key" class="hk-r" :class="{ on: open === g.key, off: !g.enabled, hl: hl === g.key }" role="row">
            <button type="button" class="hk-pick" :aria-expanded="open === g.key" :aria-label="`${g.name}: details`" @click="pick(g)">
              <span class="c-n"><b>{{ g.name }}</b><span class="hk-ab">{{ g.about || "No description yet" }}</span><small class="hk-ph2 num">{{ runsOn(g) }}<template v-if="g.logged"> · <span :class="{ bad: g.failures }">{{ g.failures }} of {{ g.runs }} failed</span><template v-if="g.p95Ms != null"> · p95 {{ ms(g.p95Ms) }}</template></template><template v-else> · no log</template></small></span>
              <span class="c-e"><code class="hk-chip">{{ runsOn(g) }}</code></span>
              <span class="c-f num"><template v-if="g.logged"><b :class="{ bad: g.failures }">{{ g.failures }} failed</b><small>of last {{ g.runs }}</small></template><small v-else>none logged</small></span>
              <span class="c-t num">
                <template v-if="g.p95Ms != null"><span class="hk-tr" role="img" :aria-label="`Slowest 5 percent ${ms(g.p95Ms)}, average ${ms(g.avgMs)}${g.timeout ? ' of ' + g.timeout + ' s' : ''}`"><i :class="{ hot: hot(g) }" :style="{ width: frac(g.p95Ms, g) * 100 + '%' }" /><u v-if="g.avgMs != null" :style="{ left: frac(g.avgMs, g) * 100 + '%' }" /></span><small>p95 {{ ms(g.p95Ms) }} · avg {{ ms(g.avgMs) }}<template v-if="g.timeout"> of {{ g.timeout }} s</template></small></template>
                <small v-else-if="g.runs">runs logged, no times</small><small v-else>no log yet</small>
              </span>
              <span class="c-l num">{{ g.lastAt ? ago(g.lastAt / 1000) : "never seen" }}</span>
            </button>
            <button type="button" class="sw" role="switch" :aria-checked="g.enabled" :aria-label="`${g.name}: ${g.enabled ? 'on' : 'off'}`" :class="{ busy: busy === g.key }" :disabled="!!busy" @click="toggle(g)"></button>
          </li>
        </ul>
      </div>

      <aside v-if="picked" class="hk-pane" aria-label="Hook detail">
        <header><span class="hk-eb"><Icon name="webhook" :size="14" /> Hook</span><button type="button" class="hk-x" aria-label="Close" @click="open = null"><Icon name="circle-x" :size="18" /></button></header>
        <h2>{{ picked.name }}</h2>
        <p class="hk-pa">{{ picked.about || "No description yet" }}</p>
        <dl class="hk-dl">
          <dt>Runs on</dt><dd>{{ picked.events.join(", ") }}<template v-if="picked.entries[0].matcher"> · on {{ picked.entries[0].matcher }}</template></dd>
          <dt>Script</dt><dd class="mono">{{ picked.script }}</dd>
          <dt>Time limit</dt><dd class="num">{{ picked.timeout ? picked.timeout + " s" : "none set" }}</dd>
          <dt>Last run</dt><dd class="num">{{ picked.lastAt ? ago(picked.lastAt / 1000) : "never seen" }}</dd>
        </dl>
        <template v-if="picked.logged">
          <h3>Last 5 runs</h3>
          <p class="hk-pips num"><span v-for="(r, i) in picked.recent" :key="i" :class="['hk-pip', r.ok ? 'ok' : 'bad']" role="img" :aria-label="r.ok ? 'run ok' : 'run failed'">{{ r.ok ? "" : "×" }}</span><small>{{ picked.recent.filter((r) => !r.ok).length }} failed<template v-if="picked.recent[0]">, newest {{ ago(picked.recent[0].at / 1000) }}</template></small></p>
          <template v-if="picked.p95Ms != null">
            <h3>Time, last {{ picked.runs }} runs</h3>
            <span class="hk-tr big"><i :class="{ hot: hot(picked) }" :style="{ width: frac(picked.p95Ms, picked) * 100 + '%' }" /><u v-if="picked.avgMs != null" :style="{ left: frac(picked.avgMs, picked) * 100 + '%' }" /></span>
            <small class="num hk-cap">p95 {{ ms(picked.p95Ms) }} · avg {{ ms(picked.avgMs) }}<template v-if="picked.timeout"> of {{ picked.timeout }} s</template></small>
          </template>
          <template v-if="lastFail(picked)"><h3>Last failure</h3><p class="hk-fail">{{ lastFail(picked)!.text || "failed" }}</p></template>
          <ol v-if="showRuns" class="hk-runs"><li v-for="r in picked.recent" :key="r.at" :class="{ bad: !r.ok }"><span class="num">{{ ago(r.at / 1000) }}</span><span class="num">{{ ms(r.ms) }}</span><span class="hk-txt">{{ r.text || (r.ok ? "ok" : "failed") }}</span></li></ol>
        </template>
        <p v-else class="hk-sm">This hook keeps no log, so there are no run numbers.</p>
        <code class="hk-cmd">{{ tilde(picked.command) }}</code>
        <div class="hk-acts">
          <button v-if="picked.logged" type="button" class="hk-btn" :aria-pressed="showRuns" @click="showRuns = !showRuns"><Icon name="file-text" :size="14" /> {{ showRuns ? "Hide log" : "Open log" }}</button>
          <button type="button" class="hk-btn" :disabled="!!busy" @click="toggle(picked)">{{ picked.enabled ? "Switch off" : "Switch on" }}</button>
          <button type="button" class="hk-btn bad" :disabled="!!busy" @click="remove(picked)"><Icon name="trash" :size="14" /> {{ confirmRm === picked.key ? "Click again to remove for good" : "Remove" }}</button>
        </div>
        <p class="hk-sm">A change applies to new sessions. Settings are backed up first; Undo stays for 10 s.</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.hk{flex:1;min-height:0;gap:12px}
.hk-ttl{display:flex;align-items:baseline;gap:12px}
.hk-meta{color:var(--muted);font-size:13px}
.bad{color:var(--bad)}
.num{font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono)}
.hk-hb{display:flex;gap:8px;align-items:center}
.hk-bk{position:relative}
.hk-btn{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);font:600 13px var(--body);cursor:pointer}
.hk-btn.pri{background:var(--ink);color:var(--panel);border-color:var(--ink)}
.hk-btn.bad{color:var(--bad)}
.hk-btn:disabled{opacity:.45;cursor:default}
.hk-btn:focus-visible,.hk-link:focus-visible,.hk-pick:focus-visible,.hk-x:focus-visible,.hk-mi:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.hk-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:30;width:280px;padding:6px;border-radius:12px;border:1px solid var(--line);background:var(--panel);box-shadow:0 12px 32px rgba(0,0,0,.28)}
.hk-mi{all:unset;box-sizing:border-box;display:grid;gap:2px;width:100%;padding:10px 12px;border-radius:8px;cursor:pointer}
.hk-mi:hover:not(:disabled){background:var(--track)}.hk-mi:disabled{opacity:.5;cursor:default}
.hk-mi b{font:600 13px var(--body)}.hk-mi small{color:var(--muted);font:400 12px/1.4 var(--body)}
.hk-undo{margin:0;display:flex;align-items:center;gap:8px;color:var(--ink);font:500 13px var(--body)}
.hk-link{padding:0;min-height:24px;border:0;background:none;color:var(--ink);font:600 13px var(--body);text-decoration:underline;cursor:pointer}
.hk-err{color:var(--warn);margin:0}
.hk-tiles{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr);gap:12px}
.hk-t{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--panel);display:grid;gap:8px;align-content:start;min-width:0}
.hk-t h2{margin:0;font:600 12px var(--body);color:var(--muted)}
.hk-big{margin:0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.hk-big b{font:700 28px/1 var(--body)}.hk-big span{color:var(--muted);font:400 13px var(--body)}
.hk-wb,.hk-fl{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.hk-wb li{display:grid;gap:3px}
.hk-wt,.hk-tr,.hk-fb{display:block;position:relative;height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.hk-wt i,.hk-tr i,.hk-fb i{display:block;height:100%;min-width:2px;border-radius:3px;background:var(--muted)}
.hk-wt i.hot,.hk-tr i.hot{background:var(--warn)}
.hk-fb i{background:var(--bad)}
.hk-tr{overflow:visible}.hk-tr i{border-radius:3px}
.hk-tr u{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink);text-decoration:none;border-radius:1px}
.hk-wn,.hk-fl li{font:500 12.5px var(--body)}
.hk-wn .num{color:var(--muted)}
.hk-fl li{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center}.hk-fl li .hk-fb{grid-column:1/-1}
.hk-sm{margin:0;color:var(--muted);font:400 12.5px/1.45 var(--body)}
.hk-ph{display:none;margin:0;color:var(--muted);font:500 12.5px var(--body)}.hk-ph.num{font-variant-numeric:tabular-nums}
.hk-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.pk .hk-body{grid-template-columns:minmax(0,1fr) 420px}
.hk-list{min-height:0;display:flex;flex-direction:column;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.hk-hd,.hk-pick{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1.3fr) minmax(0,1fr) minmax(0,2fr) minmax(0,.9fr)}
.hk-hd{padding:10px 76px 10px 18px;color:var(--muted);font:600 12px var(--body);border-bottom:1px solid var(--line);gap:14px}
.hk-hd span:last-child{display:none}
.hk-rows{list-style:none;margin:0;padding:0;overflow-y:auto;flex:1;min-height:0}
.hk-r{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding-right:18px;scroll-margin:60px;transition:box-shadow .4s}
.hk-r.on{background:var(--track);box-shadow:inset 3px 0 0 var(--ink)}
.hk-r.hl{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--ink) 40%,transparent)}
.hk-r.off .hk-pick{opacity:.55}
.hk-pick{all:unset;box-sizing:border-box;flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1.3fr) minmax(0,1fr) minmax(0,2fr) minmax(0,.9fr);gap:14px;align-items:center;padding:14px 0 14px 18px;cursor:pointer}
.c-n{display:grid;gap:3px;min-width:0}.c-n b{font:600 14px/1.3 var(--body);overflow-wrap:anywhere}
.hk-ab{color:var(--muted);font:400 12.5px/1.4 var(--body);overflow-wrap:anywhere}
.hk-ph2{display:none}
.hk-chip{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--track);font:500 11.5px var(--mono);overflow-wrap:anywhere}
.c-f,.c-t{display:grid;gap:3px;font-size:13px}.c-f small,.c-t small{color:var(--muted);font:400 11.5px var(--mono)}.c-f b{font:600 13px var(--body)}
.c-t{overflow-wrap:anywhere}
.c-l{font-size:12.5px;color:var(--muted)}
.hk-empty{display:grid;gap:10px;justify-items:start;color:var(--muted);padding:16px}.hk-empty p{margin:0;max-width:60ch}
.sw{flex:none;margin-top:0}
.hk-pane{min-height:0;overflow-y:auto;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel);display:grid;gap:10px;align-content:start}
.hk-pane header{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font:500 12.5px var(--body)}
.hk-eb{display:inline-flex;align-items:center;gap:6px}
.hk-x{all:unset;display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border-radius:10px;color:var(--muted);cursor:pointer}
.hk-pane h2{margin:0;font:700 18px/1.25 var(--body);overflow-wrap:anywhere}
.hk-pane h3{margin:4px 0 0;font:600 12px var(--body);color:var(--muted)}
.hk-pa{margin:0;font:400 13.5px/1.5 var(--body)}
.hk-dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 18px;font:400 13px var(--body)}
.hk-dl dt{color:var(--muted)}.hk-dl dd{margin:0;font-weight:600;overflow-wrap:anywhere}.hk-dl dd.mono{font:600 12.5px var(--mono)}
.hk-pips{margin:0;display:flex;align-items:center;gap:6px}.hk-pips small{margin-left:6px;color:var(--muted);font:400 12px var(--body)}
.hk-pip{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;font:700 10px/1 var(--mono)}
.hk-pip.ok{background:var(--on)}.hk-pip.bad{background:var(--bad-bg);color:var(--bad);box-shadow:inset 0 0 0 1.5px var(--bad)}
.hk-tr.big{height:8px}.hk-cap{color:var(--muted);font:400 12px var(--mono)}
.hk-fail{margin:0;padding:10px 12px;border-radius:10px;background:var(--track);font:400 12.5px/1.45 var(--mono);overflow-wrap:anywhere}
.hk-cmd{display:block;padding:8px 10px;border-radius:8px;background:var(--track);overflow-wrap:anywhere;color:var(--muted);font:500 12px var(--mono)}
.hk-acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,118px),1fr));gap:8px}
.hk-acts .hk-btn{justify-content:center;white-space:nowrap;padding:0 10px;min-width:0}
.hk-runs{list-style:none;margin:0;padding:0;display:grid}
.hk-runs li{display:grid;grid-template-columns:84px 64px minmax(0,1fr);gap:10px;font:400 12.5px var(--body);color:var(--muted);padding:4px 0;border-top:1px solid var(--line)}
.hk-runs li.bad{color:var(--bad)}.hk-txt{overflow-wrap:anywhere}
@media (max-width:1100px){
  .hk-hd,.hk-pick{grid-template-columns:minmax(0,3fr) minmax(0,1fr) minmax(0,1.6fr)}
  .hk-hd span:nth-child(2),.hk-hd span:nth-child(5),.c-e,.c-l{display:none}
  .pk .hk-body{grid-template-columns:minmax(0,1fr) 360px}
}
@media (max-width:760px){
  .hk-ttl{display:none}.ph{justify-content:flex-end}.hk-bt{display:none}.hk-hb .hk-btn{padding:0;width:44px;justify-content:center}
  .hk-tiles{grid-template-columns:minmax(0,1fr)}
  .hk-t.t2,.hk-t.t3,.hk-t.t1 .hk-wb,.hk-t.t1 .hk-sm{display:none}
  .hk-ph{display:block}
  .hk-hd,.c-e,.c-f,.c-t,.c-l{display:none}
  .hk-pick{display:grid;grid-template-columns:minmax(0,1fr);padding:12px 0 12px 14px}
  .hk-ab{display:none}.hk-ph2{display:block;color:var(--muted);font:400 12.5px var(--body)}
  .hk-r{padding-right:14px}
  .pk .hk-body{grid-template-columns:minmax(0,1fr)}
  .hk-pane{position:fixed;left:8px;right:8px;bottom:calc(68px + env(safe-area-inset-bottom));max-height:58vh;z-index:25;box-shadow:0 -8px 28px rgba(0,0,0,.35)}
  .hk-menu{right:auto;left:0}
}
@media (prefers-reduced-motion:reduce){.hk-r{transition:none}}
</style>
