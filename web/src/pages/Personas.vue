<script setup lang="ts">
// Personas (board 11): the persona catalog new agents start from (~/.agents/arsenal), the role defaults that
// pick-soul.sh reads (editable, writes roles.json) and the recent picks with a fit mark.
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { api, ago, toast } from "../ui/api";
import Icon from "../ui/Icon.vue";

interface Entry { id: string; name: string; repo: string; path: string; source_url?: string; stars: number; licence: string; category: string; description: string; tools: string[]; model_hint: string | null; tags: string[]; review?: { status: string; note?: string } }
interface RoleDef { default: string; alternates?: string[]; categories?: string[] }
interface Dec { ts: string; agent: string; role: string; job: string; ask: string; soul: string; score: number; kw: number; reason: string }
interface Res { generated: string | null; agents: Entry[]; roles: Record<string, RoleDef>; decisions: Dec[]; sources: unknown[] | null }

const data = ref<Res | null>(null), err = ref(""), loading = ref(true);
const view = ref<"catalog" | "roles" | "picks">("catalog");
const q = ref(""), cat = ref(""), model = ref(""), repo = ref(""), sort = ref<"picks" | "stars" | "name">("picks"), limit = ref(80);
const sel = ref<Entry | null>(null), selPick = ref<Dec | null>(null);
const body = ref(""), bodyErr = ref(""), showText = ref(false), copied = ref(false);
const draft = ref<Record<string, RoleDef> | null>(null), saving = ref(false);
const up = ref(false);
const picker = ref<string | null>(null), pq = ref(""), pat = ref(0);
let pbox = null as HTMLElement | null, pin = null as HTMLInputElement | null;

const agents = computed(() => data.value?.agents ?? []);
const byId = computed(() => new Map(agents.value.map((a) => [a.id, a])));
const decs = computed(() => data.value?.decisions ?? []);
const roles = computed(() => draft.value ?? data.value?.roles ?? {});
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(data.value?.roles));
const defaultOf = computed(() => { const m = new Map<string, string[]>(); for (const [r, d] of Object.entries(data.value?.roles ?? {})) (m.get(d.default) ?? m.set(d.default, []).get(d.default)!).push(r); return m; });
const used = computed(() => { const m = new Map<string, number>(); for (const d of decs.value) m.set(d.soul, (m.get(d.soul) ?? 0) + 1); return m; });
const tally = (f: (a: Entry) => string) => { const m = new Map<string, number>(); for (const a of agents.value) m.set(f(a), (m.get(f(a)) ?? 0) + 1); return [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])); };
const cats = computed(() => tally((a) => a.category));
const models = computed(() => tally((a) => a.model_hint ?? "none"));
const repos = computed(() => tally((a) => a.repo).map(([r, n]) => { const e = agents.value.find((a) => a.repo === r)!; return { r, n, stars: e.stars, licence: e.licence }; }));
const inhouse = computed(() => agents.value.filter((a) => a.repo === "in-house").length);
const nRepos = computed(() => repos.value.filter((x) => x.r !== "in-house").length);
const clean = computed(() => agents.value.filter((a) => a.review?.status === "clean").length);

const match = (a: Entry, w: string[]) => w.every((x) => (a.name + " " + a.id + " " + a.tags.join(" ") + " " + a.category + " " + a.description).toLowerCase().includes(x));
const shown = computed(() => {
  const w = q.value.toLowerCase().split(/\s+/).filter(Boolean), u = used.value;
  const l = agents.value.filter((a) => (!cat.value || a.category === cat.value) && (!model.value || (a.model_hint ?? "none") === model.value) && (!repo.value || a.repo === repo.value) && match(a, w));
  return l.sort((x, y) => sort.value === "name" ? x.name.localeCompare(y.name)
    : sort.value === "stars" ? y.stars - x.stars || x.name.localeCompare(y.name)
    : (u.get(y.id) ?? 0) - (u.get(x.id) ?? 0) || Number(defaultOf.value.has(y.id)) - Number(defaultOf.value.has(x.id)) || y.stars - x.stars || x.name.localeCompare(y.name));
});
const filtered = computed(() => !!(q.value || cat.value || model.value || repo.value));
watch([q, cat, model, repo, sort], () => { limit.value = 80; });
const stars = (n: number) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
const picksTxt = (id: string) => { const n = used.value.get(id) ?? 0; return n ? n + (n > 1 ? " picks" : " pick") : "not yet"; };

// a pick "fits" when the persona is the role's default, one of its alternates, or in one of its categories
const fits = (d: Dec) => { const r = data.value?.roles[d.role], s = byId.value.get(d.soul); return !!r && (d.soul === r.default || (r.alternates ?? []).includes(d.soul) || (!!s && (r.categories ?? []).includes(s.category))); };
const nOff = computed(() => decs.value.filter((d) => !fits(d)).length);
const when = (ts: string) => ago(Date.parse(ts) / 1000);
const nm = (id: string) => byId.value.get(id)?.name ?? id.split("/").pop() ?? id;

async function load() {
  try { data.value = await api<Res>("v1/panel/arsenal"); err.value = ""; } catch (e) { err.value = (e as Error).message; } finally { loading.value = false; }
}
onMounted(() => { void load(); document.addEventListener("mousedown", outside); });
onUnmounted(() => document.removeEventListener("mousedown", outside));

async function open(a: Entry) {
  sel.value = a; showText.value = false; body.value = ""; bodyErr.value = ""; copied.value = false;
}
async function readText() {
  const a = sel.value; if (!a) return; showText.value = true;
  if (body.value) return;
  try { const r = await api<{ body: string }>("v1/panel/arsenal/agent?id=" + encodeURIComponent(a.id)); if (sel.value?.id === a.id) body.value = r.body; }
  catch (e) { bodyErr.value = (e as Error).message; }
}
const close = () => { sel.value = null; selPick.value = null; };
async function copy() { if (!body.value) await readText(); try { await navigator.clipboard.writeText(body.value); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { toast("Copy failed"); } }
watch(view, close);

function edit(): Record<string, RoleDef> { if (!draft.value) draft.value = JSON.parse(JSON.stringify(data.value?.roles ?? {})); return draft.value!; }
function pick(role: string, id: string) { const d = edit(); d[role] = { ...d[role], default: id }; picker.value = null; pq.value = ""; }
function setDefaultFromPane(role: string) { if (sel.value) { pick(role, sel.value.id); toast(`${role} default is now ${sel.value.name}. Save on the Roles view.`); } }
async function saveRoles() {
  if (!draft.value || saving.value) return; saving.value = true;
  try { const r = await api<{ roles: Record<string, RoleDef> }>("v1/panel/arsenal/roles", { method: "PUT", body: { roles: draft.value } }); data.value = { ...data.value!, roles: r.roles }; draft.value = null; toast("Role defaults saved"); }
  catch (e) { err.value = (e as Error).message; } finally { saving.value = false; }
}
// default-persona dropdown: role categories first, then by stars; type to filter
const pickList = computed(() => {
  if (!picker.value) return [];
  const r = roles.value[picker.value], w = pq.value.toLowerCase().split(/\s+/).filter(Boolean), cs = new Set(r?.categories ?? []);
  return agents.value.filter((a) => match(a, w)).sort((x, y) => Number(cs.has(y.category)) - Number(cs.has(x.category)) || y.stars - x.stars).slice(0, 40);
});
function toggle(r: string, e?: MouseEvent) { if (picker.value === r) { picker.value = null; return; } up.value = !!e && (e.currentTarget as HTMLElement).getBoundingClientRect().bottom > innerHeight * 0.55; picker.value = r; pq.value = ""; pat.value = 0; void nextTick(() => pin?.focus()); }
function onPk(e: KeyboardEvent) {
  const n = pickList.value.length;
  if (e.key === "ArrowDown") { e.preventDefault(); pat.value = (pat.value + 1) % Math.max(n, 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); pat.value = (pat.value + n - 1) % Math.max(n, 1); }
  else if (e.key === "Enter") { e.preventDefault(); const a = pickList.value[pat.value]; if (a && picker.value) pick(picker.value, a.id); }
  else if (e.key === "Escape") { e.stopPropagation(); picker.value = null; }
}
const outside = (e: MouseEvent) => { if (picker.value && pbox && !pbox.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".dd")) picker.value = null; };
const MC: Record<string, string> = { haiku: "#6aa8ff", sonnet: "#f2b04a", opus: "#3ecf8e", fable: "#b48cff" };
const OLD_CAP = 120; // picks logged before 2026-11-17 kept only 120 characters; newer ones keep 500
const jobAll = ref(false);
const jobOf = (d: Dec) => d.job || d.ask || "not recorded";
watch(selPick, () => { jobAll.value = false; });
const changes = computed(() => Object.entries(draft.value ?? {}).filter(([r, d]) => d.default !== data.value?.roles[r]?.default).map(([r, d]) => `${r}: ${nm(d.default)} (was ${nm(data.value?.roles[r]?.default ?? "")})`));
const hasPane = computed(() => !!(sel.value || selPick.value));
</script>

<template>
  <section class="page fp ps">
    <header class="ph"><h1>Personas</h1><span v-if="agents.length" class="ph-s"><b class="num">{{ agents.length }}</b> from {{ nRepos }} repos<template v-if="inhouse"> and in-house</template><template v-if="clean === agents.length"> · all reviewed clean</template><template v-else> · {{ clean }} reviewed clean</template></span></header>
    <div class="top">
      <div class="seg" role="group" aria-label="Persona views">
        <button v-for="v in (['catalog', 'roles', 'picks'] as const)" :key="v" type="button" :class="{ on: view === v }" :aria-pressed="view === v" @click="view = v">{{ v === "catalog" ? "Catalog" : v === "roles" ? "Roles" : "Picks" }}</button>
      </div>
      <p v-if="err" class="err" role="alert">{{ err }} <button type="button" class="lnk" @click="load">Retry</button></p>
    </div>

    <p v-if="loading" class="msg">Loading personas…</p>
    <div v-else-if="!agents.length && !err" class="msg">The catalog is empty. Run the inventory first (~/.agents/arsenal/catalog.json).</div>

    <!-- CATALOG -->
    <div v-else-if="view === 'catalog'" class="main">
      <aside class="flt" aria-label="Filters">
        <label class="srch"><Icon name="search" :size="15" /><input v-model="q" type="search" placeholder="Search name, tag or text" aria-label="Search the catalog" /></label>
        <div class="fg"><h4>Category</h4>
          <div class="fl"><button type="button" :class="{ on: !cat }" @click="cat = ''">All<span class="num">{{ agents.length }}</span></button><button v-for="[c, n] in cats" :key="c" type="button" :class="{ on: cat === c }" @click="cat = cat === c ? '' : c"><i class="cn">{{ c }}</i><span class="num">{{ n }}</span></button></div></div>
        <div class="fg"><h4>Model it asks for</h4>
          <div class="fl"><button v-for="[m, n] in models" :key="m" type="button" :class="{ on: model === m }" @click="model = model === m ? '' : m"><i class="cn">{{ m === "none" ? "Not set" : m }}</i><span class="num">{{ n }}</span></button></div></div>
        <div class="fg"><h4>Source</h4>
          <div class="fl"><button v-for="s in repos" :key="s.r" type="button" :class="{ on: repo === s.r }" @click="repo = repo === s.r ? '' : s.r"><span class="rn">{{ s.r === "in-house" ? "In-house" : s.r }}<small>{{ s.r === "in-house" ? "written here, no repo" : "★ " + stars(s.stars) + " · " + s.licence }}</small></span><span class="num">{{ s.n }}</span></button></div></div>
      </aside>
      <div class="col">
        <div class="sortbar"><span class="cnt" role="status"><b class="num">{{ shown.length }}</b> of {{ agents.length }} shown<template v-if="filtered"> · <button type="button" class="lnk" @click="q = ''; cat = ''; model = ''; repo = ''">Clear filters</button></template></span>
          <div class="seg s2" role="group" aria-label="Sort"><button type="button" :class="{ on: sort === 'picks' }" :aria-pressed="sort === 'picks'" @click="sort = 'picks'">Most picked</button><button type="button" :class="{ on: sort === 'stars' }" :aria-pressed="sort === 'stars'" @click="sort = 'stars'">Stars</button><button type="button" :class="{ on: sort === 'name' }" :aria-pressed="sort === 'name'" @click="sort = 'name'">A–Z</button></div></div>
        <div class="list" role="list">
          <div class="hr th" aria-hidden="true"><span>Persona</span><span>Category</span><span>Source</span><span class="r">Stars</span><span>Model</span><span class="r">Last {{ decs.length }}</span></div>
          <p v-if="!shown.length" class="msg">Nothing matches.</p>
          <button v-for="a in shown.slice(0, limit)" :key="a.id" type="button" role="listitem" class="hr" :class="{ on: sel?.id === a.id }" @click="open(a)">
            <span class="nm"><b>{{ a.name }}</b><em v-if="defaultOf.get(a.id)" class="tag">default: {{ defaultOf.get(a.id)!.join(", ") }}</em><small>{{ a.description }}</small></span>
            <span class="c">{{ a.category }}</span><span class="rp">{{ a.repo === "in-house" ? "In-house" : a.repo }}</span><span class="st num r">★ {{ stars(a.stars) }}</span>
            <span class="mc"><template v-if="a.model_hint"><i :style="{ background: MC[a.model_hint] ?? 'var(--muted)' }" />{{ a.model_hint }}</template><template v-else><span class="dim">not set</span></template></span>
            <span class="u num r" :class="{ z: !used.get(a.id) }">{{ picksTxt(a.id) }}</span>
          </button>
          <button v-if="shown.length > limit" type="button" class="more" @click="limit += 80">Show {{ Math.min(80, shown.length - limit) }} more</button>
        </div>
      </div>
    </div>

    <!-- ROLES -->
    <div v-else-if="view === 'roles'" class="main one">
      <div class="col">
        <p class="note">At spawn, <code>pick-soul.sh</code> matches the job's words against the whole catalog. The role's default gets +3 and its categories +1. Pick the default from the list; only personas that exist are offered.</p>
        <div class="list" role="table" aria-label="Role defaults">
          <div class="rl th" role="row" aria-hidden="true"><span>Role</span><span>Default persona</span><span>Alternates</span><span>Categories</span><span class="r">Picks</span></div>
          <div v-for="(d, r) in roles" :key="r" class="rl" role="row" :class="{ ch: data?.roles[r]?.default !== d.default }">
            <b class="rn2">{{ r }}</b>
            <span class="dc">
              <button type="button" class="dd" :aria-expanded="picker === r" aria-haspopup="listbox" :class="{ bad: !byId.get(d.default) }" @click="toggle(r as string, $event)"><span>{{ byId.get(d.default)?.name ?? d.default }}<small v-if="!byId.get(d.default)">not in the catalog</small></span><Icon name="chevron-down" :size="14" /></button>
              <Transition name="fd">
                <div v-if="picker === r" :ref="(e) => (pbox = e as HTMLElement | null)" class="menu" :class="{ up }" role="dialog" :aria-label="'Default for ' + r" @keydown="onPk">
                  <label class="mi"><Icon name="search" :size="15" /><input :ref="(e) => (pin = e as HTMLInputElement | null)" v-model="pq" type="text" role="combobox" aria-expanded="true" placeholder="Find a persona" autocomplete="off" spellcheck="false" @input="pat = 0" /></label>
                  <ul class="al" role="listbox">
                    <li v-for="(a, i) in pickList" :key="a.id" role="option" :class="{ on: pat === i }" :aria-selected="d.default === a.id" @mousemove="pat = i" @click="pick(r as string, a.id)"><span>{{ a.name }}<small>{{ a.category }} · {{ a.repo }}</small></span><b class="num">★ {{ stars(a.stars) }}</b></li>
                    <li v-if="!pickList.length" class="none">No persona matches "{{ pq }}".</li>
                  </ul>
                </div>
              </Transition>
            </span>
            <span class="alts"><span v-for="a in d.alternates ?? []" :key="a" class="chp">{{ nm(a) }}</span><span v-if="!(d.alternates ?? []).length" class="dim">none</span></span>
            <span class="cs">{{ (d.categories ?? []).join(", ") || "all" }}</span>
            <span class="n num r">{{ decs.filter((x) => x.role === r).length || "no" }}<i class="pl"> picks</i></span>
          </div>
        </div>
        <Transition name="fd">
          <div v-if="dirty" class="unsaved" role="region" aria-label="Unsaved role defaults"><span class="sp"><b>{{ changes.length }} {{ changes.length === 1 ? "change" : "changes" }}:</b> {{ changes.join("; ") }}</span><button type="button" class="btn ghost" @click="draft = null">Discard</button><button type="button" class="btn pri" :disabled="saving" @click="saveRoles">{{ saving ? "Saving…" : "Save" }}</button></div>
        </Transition>
      </div>
    </div>

    <!-- PICKS -->
    <div v-else class="main">
      <div class="col picks">
        <div class="tiles">
          <div class="tile"><h4>How a persona is picked</h4><p>At spawn, the words of the job are matched against all <b>{{ agents.length }}</b> personas. A name hit counts most, then tags, then the text. The role's default gets <b>+3</b> and its categories <b>+1</b>. The best score wins.</p></div>
          <div class="tile"><h4>Fit with the role, last {{ decs.length }} picks</h4><div class="big num">{{ nOff }}<small>outside the role · {{ decs.length - nOff }} fit</small></div><div class="fitbar" aria-hidden="true"><i :style="{ flex: decs.length - nOff }" /><u :style="{ flex: nOff }" /></div><p>"Fits" means the role default, one of its alternates, or a persona from the role's categories.</p></div>
        </div>
        <div class="list" role="list">
          <div class="pk th" aria-hidden="true"><span>Agent</span><span>Persona it got</span><span class="r">Fit</span></div>
          <p v-if="!decs.length" class="msg">No persona has been picked yet. Each spawn with a persona adds a line here.</p>
          <button v-for="(d, i) in decs" :key="i" type="button" role="listitem" class="pk" :class="{ on: selPick === d }" @click="selPick = d; sel = null">
            <span><b>{{ d.agent || d.role }}</b><small>{{ d.role }}</small></span>
            <span><b>{{ nm(d.soul) }}</b><small>{{ byId.get(d.soul)?.category ?? "?" }} · score {{ Math.round(d.score) }}<template v-if="d.reason.startsWith('default')"> · role default</template></small></span>
            <span class="w"><em class="tag" :class="fits(d) ? 'fit' : 'off'">{{ fits(d) ? "fits the role" : "outside the role" }}</em><small>{{ when(d.ts) }}</small></span>
          </button>
        </div>
      </div>
    </div>

    <!-- PANE -->
    <Transition name="pn">
      <aside v-if="hasPane && view !== 'roles'" class="pane" role="dialog" :aria-label="sel?.name ?? 'Pick'" @keydown.esc="close">
        <div class="grab" aria-hidden="true" />
        <div v-if="sel" class="dt">
          <div class="tp"><Icon name="sparkles" :size="15" />Persona<span class="sp" /><button type="button" class="ico" aria-label="Close" @click="close"><Icon name="x" :size="17" /></button></div>
          <h3>{{ sel.name }}</h3>
          <p class="tx">{{ sel.description }}</p>
          <div class="kv"><span>Source</span><b><a v-if="sel.source_url" :href="sel.source_url" target="_blank" rel="noopener noreferrer">{{ sel.repo }}<Icon name="external-link" :size="12" /></a><template v-else>{{ sel.repo }}</template> · ★ {{ stars(sel.stars) }} · {{ sel.licence }}</b>
            <span>Category</span><b>{{ sel.category }}</b><span>Model</span><b>{{ sel.model_hint ?? "not set" }}</b><span>Tools</span><b>{{ sel.tools.join(", ") || "all" }}</b><span>Tags</span><b>{{ sel.tags.join(", ") || "none" }}</b><span>File</span><b class="mono">{{ sel.path }}</b><span>Spawn</span><b class="mono">spawn.sh claude-code NAME --soul {{ sel.id }}</b></div>
          <div class="ck"><Icon name="shield-check" :size="16" /><span>Reviewed: {{ sel.review?.note || sel.review?.status || "not recorded" }}</span></div>
          <h4>Picked {{ used.get(sel.id) ?? 0 }} {{ (used.get(sel.id) ?? 0) === 1 ? "time" : "times" }} in the last {{ decs.length }}</h4>
          <div class="used"><div v-for="(d, i) in decs.filter((x) => x.soul === sel!.id).slice(0, 5)" :key="i"><b>{{ d.agent || d.role }}</b><span>{{ d.role }} · {{ when(d.ts) }}</span></div></div>
          <p v-if="defaultOf.get(sel.id)" class="note s">Default for {{ defaultOf.get(sel.id)!.join(", ") }}.</p>
          <p v-else class="note s">Not the default for any role.</p>
          <div class="acts"><button type="button" class="btn" @click="showText ? (showText = false) : readText()"><Icon name="file-text" :size="15" />{{ showText ? "Hide the text" : "Read the text" }}</button><button type="button" class="btn" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="15" />{{ copied ? "Copied" : "Copy text" }}</button></div>
          <template v-if="showText"><p v-if="bodyErr" class="err">{{ bodyErr }}</p><pre v-else class="pre">{{ body || "Loading…" }}</pre></template>
          <template v-if="Object.keys(roles).length"><h4>Make default for…</h4><div class="chips"><button v-for="(d, r) in roles" :key="r" type="button" class="chip" :class="{ on: d.default === sel.id }" :aria-pressed="d.default === sel.id" @click="setDefaultFromPane(r as string)">{{ r }}</button></div><p class="note">Changes wait on the Roles view until you save.</p></template>
        </div>
        <div v-else-if="selPick" class="dt">
          <div class="tp"><Icon name="sparkles" :size="15" />Pick<span class="sp" /><button type="button" class="ico" aria-label="Close" @click="close"><Icon name="x" :size="17" /></button></div>
          <h3>{{ selPick.agent || selPick.role }} got {{ nm(selPick.soul) }}</h3>
          <div class="kv"><span>Role</span><b>{{ selPick.role }} · looks in {{ (data?.roles[selPick.role]?.categories ?? []).join(", ") || "all" }}</b>
            <span>Role default</span><b>{{ nm(data?.roles[selPick.role]?.default ?? "") }}</b><span>Got</span><b>{{ nm(selPick.soul) }} · {{ byId.get(selPick.soul)?.category ?? "?" }}</b><span>Why</span><b>{{ selPick.reason.startsWith("default") ? "nothing in the job beat the role default" : "words in the job matched its text" }} (score {{ Math.round(selPick.score) }})</b><span>Job</span><b class="job" :class="{ fold: !jobAll }">{{ jobOf(selPick) }}<template v-if="[OLD_CAP, 500].includes(jobOf(selPick).length)">…</template></b></div>
          <p v-if="jobOf(selPick).length === OLD_CAP" class="note">The pick log kept only the first {{ OLD_CAP }} characters of older jobs.</p>
          <button v-if="jobOf(selPick).length > 90" type="button" class="lnk more2" @click="jobAll = !jobAll">{{ jobAll ? "Show less" : "Show more" }}</button>
          <p v-if="!fits(selPick)" class="note s">Outside the role. A {{ byId.get(selPick.soul)?.category ?? "?" }} persona on a {{ selPick.role }} job: the keyword match scores the whole catalog and the role default adds only 3 points.</p>
          <p v-else class="note s">Fits the role: default, alternate or one of its categories.</p>
          <div class="acts"><a class="btn" :href="'#/agents?agent=' + encodeURIComponent(selPick.agent)"><Icon name="user" :size="15" />Open {{ selPick.agent }}</a><button v-if="byId.get(selPick.soul)" type="button" class="btn" @click="view = 'catalog'; open(byId.get(selPick.soul)!)">Open persona</button><button type="button" class="btn" @click="view = 'roles'">Role defaults</button></div>
        </div>
      </aside>
    </Transition>
  </section>
</template>

<style scoped>
.ps{flex:1;min-height:0;gap:0;position:relative}
.ph{justify-content:flex-start;gap:16px}.ph-s{color:var(--muted);font-size:14px}.ph-s b{color:var(--ink)}
.sp{flex:1}.dim{color:var(--muted)}.r{text-align:right}
.top{display:flex;gap:14px;align-items:center;margin:0 0 12px;flex-wrap:wrap}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--soft)}
.seg button{all:unset;box-sizing:border-box;cursor:pointer;min-height:30px;padding:0 14px;border-radius:8px;display:inline-flex;align-items:center;font:600 13px var(--body);color:var(--muted);transition:background .15s,color .15s}
.seg button.on{background:var(--ink);color:var(--bg)}.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.seg.s2 button{min-height:26px;padding:0 10px;font-size:12px}
.err{margin:0;color:var(--bad);font-size:13px}.lnk{all:unset;cursor:pointer;text-decoration:underline;color:var(--ink)}.lnk:focus-visible{outline:2px solid var(--on)}
.msg{margin:0;padding:48px 20px;color:var(--muted);text-align:center;font-size:14px}
.main{flex:1;min-height:0;display:flex;gap:16px}
.main.one .col{max-width:none}
.col{flex:1;min-width:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:12px}
.main.one .col{grid-template-rows:auto minmax(0,1fr) auto}
.picks{grid-template-rows:auto minmax(0,1fr)}
.flt{flex:none;width:236px;display:grid;align-content:start;gap:16px;overflow:auto;overscroll-behavior:contain;padding-right:4px}
.flt h4,.dt h4{margin:0 0 6px;font:600 12px/1 var(--body);color:var(--muted)}
.srch{display:flex;gap:8px;align-items:center;height:36px;padding:0 10px;border-radius:10px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted)}
.srch input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--ink);font:400 13px var(--body)}.srch:focus-within{box-shadow:inset 0 0 0 1.5px var(--ink)}
.fl{display:grid;gap:1px}
.fl button{all:unset;box-sizing:border-box;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:30px;padding:4px 10px;border-radius:8px;font-size:13px}
.fl button:hover{background:var(--soft)}.fl button:focus-visible{outline:2px solid var(--on)}
.fl button.on{background:var(--soft);font-weight:600;box-shadow:inset 3px 0 0 var(--ink)}
.fl .num{color:var(--muted);font:12px var(--mono)}.cn{font-style:normal;text-transform:capitalize}
.rn{display:block;min-width:0;overflow-wrap:anywhere}.rn small{display:block;color:var(--muted);font-size:11.5px;font-weight:400}
.sortbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.cnt{color:var(--muted);font-size:13px}.cnt b{color:var(--ink)}
.list{overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);min-height:0}
.th{position:sticky;top:0;z-index:1;background:var(--panel);color:var(--muted);font:600 12px var(--body)}
.hr{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:minmax(0,2.6fr) 96px minmax(0,1.1fr) 64px 82px 78px;gap:14px;align-items:start;padding:12px 18px;border-top:1px solid var(--hair);font-size:13px;cursor:pointer}
.hr.th{border-top:0;padding:12px 18px 8px;cursor:default;align-items:center}
.hr:not(.th):hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}.hr.on{background:var(--soft);box-shadow:inset 3px 0 0 var(--ink)}.hr:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.nm b{font-weight:600;font-size:14px;overflow-wrap:anywhere}.nm small{display:block;color:var(--muted);font-size:12.5px;line-height:1.4;margin-top:2px;overflow-wrap:anywhere}
.tag{font:600 11px var(--body);font-style:normal;margin-left:8px;padding:2px 7px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);white-space:nowrap}
.tag.off{color:var(--pend);box-shadow:inset 0 0 0 1px var(--pend)}.tag.fit{color:var(--muted)}
.c{text-transform:capitalize}.rp{font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}.st{font:12.5px var(--mono)}
.mc{display:inline-flex;align-items:center;gap:6px;font:600 12px var(--mono)}.mc i{width:8px;height:8px;border-radius:50%}
.u{font:600 12.5px var(--mono)}.u.z{color:var(--muted);font-weight:400}
.more{all:unset;box-sizing:border-box;cursor:pointer;display:block;width:100%;padding:14px;text-align:center;font:600 13px var(--body);border-top:1px solid var(--hair)}.more:hover{background:var(--soft)}
.note{margin:0;color:var(--muted);font-size:13px;line-height:1.5}.note code{font:500 12px var(--mono);color:var(--ink)}
.note.s{padding:8px 10px;border-radius:8px;background:var(--soft);font-size:12px}
/* roles */
.rl{display:grid;grid-template-columns:150px minmax(0,1.3fr) minmax(0,2fr) 140px 60px;gap:14px;align-items:center;padding:11px 18px;border-top:1px solid var(--hair);font-size:13px}
.rl.th{border-top:0;padding:12px 18px 8px}.rl.ch{box-shadow:inset 3px 0 0 var(--pend)}
.rn2{font-weight:600}.dc{position:relative;min-width:0}
.dd{all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:36px;padding:6px 10px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--line);font:12.5px var(--mono);overflow-wrap:anywhere}
.dd:hover{background:var(--soft)}.dd:focus-visible{outline:2px solid var(--on)}.dd.bad{color:var(--bad)}.dd small{display:block;font-size:11px}
.alts{display:flex;flex-wrap:wrap;gap:4px}.chp{font:11.5px var(--mono);padding:2px 7px;border-radius:6px;background:var(--soft)}
.cs{color:var(--muted);font-size:12.5px}.n{font:600 12.5px var(--mono)}
.menu.up{top:auto;bottom:42px}
.menu{position:absolute;left:0;top:42px;z-index:10;width:min(380px,90vw);max-height:min(420px,50dvh);display:flex;flex-direction:column;border-radius:12px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),0 18px 40px -12px rgb(0 0 0/.55);overflow:hidden}
.mi{display:flex;gap:8px;align-items:center;height:44px;padding:0 14px;border-bottom:1px solid var(--line);color:var(--muted);flex:none}
.mi input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--ink);font:500 14px var(--body)}
.al{list-style:none;margin:0;padding:4px 0;overflow:auto}
.al li{display:flex;justify-content:space-between;gap:10px;align-items:center;min-height:44px;padding:4px 14px;font-size:13.5px;cursor:pointer;overflow-wrap:anywhere}
.al li small{display:block;color:var(--muted);font-size:11.5px}.al li.on{background:var(--track)}.al li[aria-selected=true]{font-weight:700}.al b{font:500 12px var(--mono);color:var(--muted);flex:none}.al .none{color:var(--muted);cursor:default}
.unsaved{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:12px;background:var(--ink);color:var(--bg);font-size:13px}
.unsaved .btn{color:var(--bg);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bg) 40%,transparent)}.unsaved .btn.pri{background:var(--bg);color:var(--ink);box-shadow:none}
/* picks */
.tiles{display:grid;grid-template-columns:1.3fr 1fr;gap:16px}
.tile{border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);padding:14px 16px;display:grid;gap:8px;align-content:start}
.tile h4{margin:0;font:600 12px/1 var(--body);color:var(--muted)}.tile p{margin:0;font-size:12.5px;color:var(--muted);line-height:1.45}.tile p b{color:var(--ink)}
.big{font:700 28px/1 var(--body)}.big small{font:500 13px var(--body);color:var(--muted);margin-left:6px}
.fitbar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--track)}.fitbar i{background:var(--ink);opacity:.8}.fitbar u{background:var(--pend);text-decoration:none}
.picks{grid-template-rows:auto minmax(0,1fr)}
.pk{all:unset;box-sizing:border-box;width:100%;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) 130px;gap:4px 14px;align-items:center;padding:12px 18px;border-top:1px solid var(--hair);font-size:13px;cursor:pointer}
.pk.th{border-top:0;padding:12px 18px 8px;cursor:default}.pk:not(.th):hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}.pk.on{background:var(--soft);box-shadow:inset 3px 0 0 var(--ink)}.pk:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.pk b{font-weight:600;overflow-wrap:anywhere}.pk small{display:block;color:var(--muted);font-size:12px}.pk .w{display:grid;justify-items:end;gap:3px}.pk .tag{margin:0}
/* pane */
.pane{position:absolute;right:0;top:0;bottom:0;width:440px;z-index:5;overflow:auto;overscroll-behavior:contain;border-radius:14px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line),-16px 0 40px -20px rgb(0 0 0/.5)}
.grab{display:none}
.dt{padding:18px 16px;display:grid;align-content:start;gap:14px}
.tp{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px}
.ico{all:unset;cursor:pointer;display:grid;place-items:center;width:34px;height:34px;margin:-8px -6px;color:var(--muted);border-radius:8px}.ico:hover{color:var(--ink);background:var(--soft)}.ico:focus-visible{outline:2px solid var(--on)}
.dt h3{margin:0;font:700 18px/1.3 var(--body);overflow-wrap:anywhere}.tx{margin:0;font-size:13.5px;line-height:1.55;overflow-wrap:anywhere}
.kv{display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px 12px;font-size:13px}.kv>span{color:var(--muted)}.kv b{font-weight:600;overflow-wrap:anywhere}.kv a{color:var(--ink);display:inline-flex;gap:4px;align-items:center}
.job.fold{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.more2{justify-self:start;font-size:12.5px}
.pl{display:none;font-style:normal}
.unsaved .sp{line-height:1.4;overflow-wrap:anywhere}
.mono{font:500 11.5px var(--mono)!important}
.ck{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.45;color:var(--muted)}.ck :deep(svg){flex:none;color:var(--on)}
.used{display:grid;gap:6px}.used div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;font-size:13px}.used span{color:var(--muted);font-size:12px}
.acts,.chips{display:flex;flex-wrap:wrap;gap:8px}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;min-height:34px;padding:0 12px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);font:600 13px var(--body);color:var(--ink)}
.btn:hover{background:var(--soft)}.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}.btn:disabled{opacity:.5;cursor:default}
.chip{all:unset;box-sizing:border-box;cursor:pointer;height:28px;padding:0 11px;border-radius:999px;display:inline-flex;align-items:center;font:600 12.5px/1 var(--body);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)}
.chip.on{background:var(--ink);color:var(--bg);box-shadow:none}.chip:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.pre{margin:0;padding:12px;border-radius:12px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere;font:400 12px/1.55 var(--mono)}
.pn-enter-active,.pn-leave-active{transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .2s}.pn-enter-from,.pn-leave-to{transform:translateX(24px);opacity:0}
.fd-enter-active,.fd-leave-active{transition:opacity .15s}.fd-enter-from,.fd-leave-to{opacity:0}
@media (min-width:1401px){.main:has(~ .pane){padding-right:456px}}
@media (max-width:1400px){.pane{box-shadow:inset 0 0 0 1px var(--line),-16px 0 40px -20px rgb(0 0 0/.7)}}
@media (max-width:1100px){
  .flt{display:none}.hr{grid-template-columns:minmax(0,2.4fr) 90px 64px 78px}.hr>.rp,.hr>.mc{display:none}.hr.th>:nth-child(3),.hr.th>:nth-child(5){display:none}
  .tiles{grid-template-columns:1fr}.rl{grid-template-columns:120px minmax(0,1fr) 60px}.rl>.alts,.rl>.cs{display:none}.rl.th>:nth-child(3),.rl.th>:nth-child(4){display:none}
}
@media (max-width:760px){
  .ph{display:none}.top{margin-top:2px}
  .seg{width:100%}.seg button{flex:1;justify-content:center}
  .hr{grid-template-columns:minmax(0,1fr) auto}.hr>.c,.hr>.st{display:none}.hr.th{display:none}
  .pk{grid-template-columns:minmax(0,1fr) auto}.pk>:nth-child(2){grid-column:1}.pk>.w{grid-column:2;grid-row:1/3}.pk.th{display:none}
  .rl{grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);align-items:start}.rl.th{display:none}.rl>.dc{grid-column:2;grid-row:1/3}.rl>.n{grid-column:1;grid-row:2;text-align:left;font-weight:400;color:var(--muted)}.pl{display:inline!important}.dd{pointer-events:none}.dd :deep(svg){display:none}
  .pane{position:fixed;left:0;right:0;top:auto;bottom:calc(56px + env(safe-area-inset-bottom));width:auto;height:62dvh;z-index:60;border-radius:18px 18px 0 0}
  .grab{display:block;width:36px;height:5px;border-radius:3px;background:var(--line);margin:8px auto 0}
  .sortbar{flex-direction:column;align-items:stretch}.seg.s2{width:100%}
}
@media (prefers-reduced-motion:reduce){.pn-enter-active,.pn-leave-active{transition:opacity .15s}.pn-enter-from,.pn-leave-to{transform:none}}
</style>
