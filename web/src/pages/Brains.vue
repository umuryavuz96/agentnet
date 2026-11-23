<script setup lang="ts">
// Brains: the fixed agent inventory every spawn starts from (brains dir, index.json maps roles to brains).
// Read only: frontmatter, role mapping, newest changelog lines, spawn count and average job grade. Cards on the left,
// the selected brain's detail beside them on desktop (always shown, so selection never resizes the grid); a non-modal half sheet on phone.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { api } from "../ui/api";
import Icon from "../ui/Icon.vue";
import { route, toHash } from "../router";
import BrainImport from "../components/BrainImport.vue";

interface Change { v: number | null; date: string | null; source: string | null; change: string }
interface BrainRow { name: string; version: number | null; description: string; changelog: Change[]; reads: string[]; skills: string[]; lines: number; roles: string[]; uses: number; graded: number; grade_avg: number | null; error?: string }
interface Res { dir: string; default: string | null; roles: Record<string, string>; brains: BrainRow[]; error?: string }

const data = ref<Res | null>(null), err = ref(""), loading = ref(true);
const brains = computed(() => data.value?.brains ?? []);
const selName = computed(() => route.value.query.brain ?? "");
const sel = computed(() => brains.value.find((b) => b.name === selName.value) ?? null);
/** Desktop always shows a brain in the pane: the chosen one, else the first. Phone shows the sheet only after a tap. */
const shown = computed(() => sel.value ?? brains.value[0] ?? null);
const totalUses = computed(() => brains.value.reduce((n, b) => n + b.uses, 0));

async function load() {
  try { data.value = await api<Res>("v1/panel/brains"); err.value = ""; } catch (e) { err.value = (e as Error).message; } finally { loading.value = false; }
}
onMounted(load);

function pick(name: string | null) {
  route.value = { page: "brains", query: name ? { brain: name } : {} };
  history.replaceState(null, "", toHash(route.value));
}
const paneEl = ref<HTMLElement | null>(null);
watch(selName, () => { paneEl.value?.scrollTo({ top: 0 }); });

const vtxt = (b: BrainRow) => (b.version != null ? "v" + b.version : "v?");
const gradeTxt = (b: BrainRow) => (b.grade_avg != null ? b.grade_avg.toFixed(1) : "–");
const spawns = (n: number) => `${n} ${n === 1 ? "spawn" : "spawns"}`;
const changeLine = (c: Change) => [c.v != null ? "v" + c.v : null, c.date].filter(Boolean).join(" · ");
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const adding = ref(false);
async function added(name: string) {
  adding.value = false; await load(); pick(name);
  await nextTick(); document.querySelector(".bp .card[aria-current=true]")?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
</script>

<template>
  <section class="page fp bp">
    <header class="ph"><h1>Brains</h1><span v-if="brains.length" class="ph-s"><b class="num">{{ brains.length }}</b> brains · <b class="num">{{ totalUses }}</b> {{ totalUses === 1 ? "spawn" : "spawns" }}<template v-if="data?.default"> · default <b>{{ data.default }}</b></template></span></header>

    <p v-if="loading" class="msg">Loading brains…</p>
    <div v-else-if="err" class="msg" role="alert">Could not load the brains: {{ err }} <button type="button" class="lnk" @click="load">Retry</button></div>
    <div v-else-if="!brains.length" class="msg">
      <b>Brains are off.</b> No brain files in <code>{{ data ? home(data.dir) : "the brains folder" }}</code>.<br />Add <code>&lt;name&gt;.md</code> files and an <code>index.json</code> with a <code>roles</code> map; spawns then start from them.
    </div>

    <div v-else class="main">
      <div class="col">
        <div class="top"><p class="note">Every spawn starts from one brain: the one named with <code>--brain</code>, else the role's brain from <code>index.json</code>, else the role's last word, else <b>{{ data?.default ?? "the default" }}</b>. Files live in <code>{{ home(data!.dir) }}</code>.</p><button type="button" class="btn add" aria-haspopup="dialog" @click="adding = true"><Icon name="plus" :size="16" />Add from catalog</button></div>
        <p v-if="data?.error" class="err" role="alert">{{ data.error }}</p>
        <div class="grid" role="list" aria-label="Brains">
          <button v-for="b in brains" :key="b.name" type="button" role="listitem" class="card" :class="{ on: shown?.name === b.name, sel: sel?.name === b.name, bad: !!b.error }" :aria-current="shown?.name === b.name" @click="pick(b.name)">
            <span class="hd"><b class="nm">{{ b.name }}</b><em class="ver num">{{ vtxt(b) }}</em><em v-if="data?.default === b.name" class="tag">default</em><span class="sp" /><span class="stat num" :title="b.graded ? `average of ${b.graded} graded jobs, 1 to 5` : 'no graded job yet'"><Icon name="gauge" :size="13" />{{ gradeTxt(b) }}</span></span>
            <span v-if="b.error" class="ds bad"><Icon name="triangle-alert" :size="13" /> {{ b.error }}</span>
            <span v-else class="ds">{{ b.description || "No description." }}</span>
            <span class="rl"><template v-if="b.roles.length"><i v-for="r in b.roles" :key="r" class="chp">{{ r }}</i></template><i v-else class="dim">no role maps here<template v-if="data?.default === b.name">; picked when nothing else matches</template></i></span>
            <span v-if="b.changelog[0]" class="cl"><b class="num">{{ changeLine(b.changelog[0]) }}</b>{{ b.changelog[0].change }}</span>
            <span class="ft num">{{ spawns(b.uses) }} · {{ b.graded ? b.graded + " graded" : "not graded yet" }}</span>
          </button>
        </div>
      </div>

      <Transition name="pn">
        <aside v-if="shown" :key="'pane'" ref="paneEl" class="pane" :class="{ open: !!sel }" role="region" :aria-label="'Brain ' + shown.name" @keydown.esc="pick(null)">
          <div class="grab" aria-hidden="true" />
          <div class="dt">
            <div class="tp"><Icon name="brain" :size="15" />Brain<span class="sp" /><button type="button" class="ico x" aria-label="Close" @click="pick(null)"><Icon name="x" :size="17" /></button></div>
            <h3>{{ shown.name }} <em class="ver num">{{ vtxt(shown) }}</em></h3>
            <p v-if="shown.error" class="err">{{ shown.error }}</p>
            <p v-else class="tx">{{ shown.description || "No description." }}</p>
            <div class="kv">
              <span>Roles</span><b>{{ shown.roles.join(", ") || (data?.default === shown.name ? "none (default brain)" : "none") }}</b>
              <span>Spawns</span><b class="num">{{ shown.uses }}</b>
              <span>Grade</span><b class="num">{{ shown.grade_avg != null ? `${shown.grade_avg.toFixed(1)} of 5, ${shown.graded} graded ${shown.graded === 1 ? "job" : "jobs"}` : "no graded job yet" }}</b>
              <span>Body</span><b class="num">{{ shown.lines }} lines</b>
              <span>File</span><b class="mono">{{ home(data!.dir) }}/{{ shown.name }}.md</b>
            </div>
            <h4>Reads before work <span class="num">{{ shown.reads.length }}</span></h4>
            <ul v-if="shown.reads.length" class="rd"><li v-for="r in shown.reads" :key="r" class="mono">{{ r }}</li></ul>
            <p v-else class="note s">No files to read first.</p>
            <h4>Skills <span class="num">{{ shown.skills.length }}</span></h4>
            <div v-if="shown.skills.length" class="chips"><i v-for="s in shown.skills" :key="s" class="chp">{{ s }}</i></div>
            <p v-else class="note s">No skills listed.</p>
            <h4>Changelog <span class="num">{{ shown.changelog.length }}</span></h4>
            <ol v-if="shown.changelog.length" class="log">
              <li v-for="(c, i) in shown.changelog" :key="i"><span class="num">{{ changeLine(c) || "undated" }}<template v-if="c.source"> · {{ c.source }}</template></span><p>{{ c.change }}</p></li>
            </ol>
            <p v-else class="note s">No changelog entries.</p>
          </div>
        </aside>
      </Transition>
    </div>
    <BrainImport :open="adding" :taken="brains.map((b) => b.name)" @close="adding = false" @added="added" />
  </section>
</template>

<style scoped>
.bp{flex:1;min-height:0;gap:0;position:relative}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.sp{flex:1}.dim{color:var(--muted);font-style:normal}
.err{margin:0;color:var(--bad);font-size:13px}.lnk{all:unset;cursor:pointer;text-decoration:underline;color:var(--ink)}.lnk:focus-visible{outline:2px solid var(--on)}
.msg{margin:0;padding:48px 20px;color:var(--muted);text-align:center;font-size:14px;line-height:1.6}.msg b{color:var(--ink)}
code{font:500 12px var(--mono);color:var(--ink);white-space:nowrap}
.main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:16px}
.col{min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px}
.note{margin:0;color:var(--muted);font-size:13px;line-height:1.5}
.top{display:flex;align-items:center;gap:12px 16px}.top .note{flex:1;min-width:0}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:44px;padding:0 14px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);font:600 13.5px var(--body);color:var(--ink);white-space:nowrap}
.btn:hover{background:var(--soft)}.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.note.s{padding:8px 10px;border-radius:8px;background:var(--soft);font-size:12px}
.grid{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-content:start;padding:2px}
.card{all:unset;box-sizing:border-box;cursor:pointer;display:grid;align-content:start;gap:9px;padding:14px 16px;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);font-size:13px;transition:box-shadow .15s,background .15s}
.card:hover{background:color-mix(in srgb,var(--ink) 3%,var(--panel))}
.card.on{box-shadow:inset 0 0 0 1.5px var(--ink)}
.card:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.card.bad{box-shadow:inset 0 0 0 1px var(--bad)}
.hd{display:flex;align-items:center;gap:8px;min-width:0}
.nm{font:700 15px/1.2 var(--body);overflow-wrap:anywhere}
.ver{font:600 11.5px var(--mono);font-style:normal;padding:1px 6px;border-radius:5px;background:var(--soft);color:var(--ink)}
.tag{font:600 11px var(--body);font-style:normal;padding:2px 7px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--line);color:var(--muted)}
.stat{display:inline-flex;align-items:center;gap:4px;font:600 13px var(--mono);color:var(--ink)}.stat :deep(svg){color:var(--muted)}
.ds{color:var(--ink);line-height:1.45;overflow-wrap:anywhere}.ds.bad{color:var(--bad)}
.rl,.chips{display:flex;flex-wrap:wrap;gap:4px}
.chp{font:11.5px var(--mono);font-style:normal;padding:2px 7px;border-radius:6px;background:var(--soft);color:var(--ink)}
.rl .dim{font-size:12px}
.cl{display:block;padding:8px 10px;border-radius:8px;background:var(--soft);color:var(--muted);font-size:12px;line-height:1.45;overflow-wrap:anywhere}.cl b{color:var(--ink);font:600 11.5px var(--mono);margin-right:8px}
.ft{color:var(--muted);font:12px var(--mono)}
/* pane */
.pane{min-height:0;overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line)}
.grab{display:none}
.dt{padding:16px;display:grid;align-content:start;gap:14px}
.tp{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px;min-height:34px}
.ico{all:unset;cursor:pointer;display:grid;place-items:center;width:44px;height:44px;margin:-6px -10px -6px 0;color:var(--muted);border-radius:8px}.ico:hover{color:var(--ink);background:var(--soft)}.ico:focus-visible{outline:2px solid var(--on)}
.x{visibility:hidden}.pane.open .x{visibility:visible}
.dt h3{margin:0;font:700 20px/1.3 var(--body);overflow-wrap:anywhere;display:flex;align-items:center;gap:8px}
.tx{margin:0;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}
.dt h4{margin:4px 0 0;font:600 12px/1 var(--body);color:var(--muted)}.dt h4 .num{color:var(--ink);margin-left:4px}
.kv{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px 12px;font-size:13px}.kv>span{color:var(--muted)}.kv b{font-weight:600;overflow-wrap:anywhere}
.mono{font:500 11.5px var(--mono)!important;overflow-wrap:anywhere}
.rd{list-style:none;margin:0;padding:0;display:grid;gap:4px}.rd li{padding:6px 10px;border-radius:8px;background:var(--soft)}
.log{list-style:none;margin:0;padding:0;display:grid;gap:0}
.log li{display:grid;gap:3px;padding:10px 0 10px 14px;border-left:2px solid var(--line);position:relative}
.log li::before{content:"";position:absolute;left:-5px;top:14px;width:8px;height:8px;border-radius:50%;background:var(--panel);box-shadow:inset 0 0 0 2px var(--ink)}
.log li:first-child::before{background:var(--ink)}
.log span{font:600 11.5px var(--mono);color:var(--muted)}.log p{margin:0;font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.pn-enter-active,.pn-leave-active{transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s}.pn-enter-from,.pn-leave-to{transform:translateY(24px);opacity:0}
@media (max-width:1100px){.main{grid-template-columns:minmax(0,1fr) 380px}.grid{grid-template-columns:minmax(0,1fr)}}
@media (max-width:760px){
  .ph{display:none}
  .top{flex-direction:column;align-items:stretch}.btn.add{justify-content:center}
  .main{grid-template-columns:minmax(0,1fr)}
  .grid{grid-template-columns:minmax(0,1fr)}
  .card.on:not(.sel){box-shadow:inset 0 0 0 1px var(--line)} /* phone: no pane beside the list, so only a tapped card is marked */
  /* phone: the pane is a non-modal half sheet, only after a tap; the list stays usable behind it */
  .pane{position:fixed;left:0;right:0;top:auto;bottom:calc(56px + env(safe-area-inset-bottom));height:62dvh;z-index:60;border-radius:18px 18px 0 0;box-shadow:inset 0 0 0 1px var(--line),0 -16px 40px -20px rgb(0 0 0/.6);
    transform:translateY(calc(100% + 80px));visibility:hidden;transition:transform .26s cubic-bezier(.2,.8,.2,1),visibility 0s .26s}
  .pane.open{transform:none;visibility:visible;transition:transform .26s cubic-bezier(.2,.8,.2,1)}
  .grab{display:block;width:36px;height:5px;border-radius:3px;background:var(--line);margin:8px auto 0}
  .col:has(~ .pane.open) .grid::after{content:"";height:62dvh} /* the last cards can scroll above the sheet; a spacer, not padding, so the grid box keeps its size */
}
@media (prefers-reduced-motion:reduce){.pn-enter-active,.pn-leave-active{transition:opacity .15s}.pn-enter-from,.pn-leave-to{transform:none}.pane,.pane.open{transition:none}}
</style>
