<script setup lang="ts">
// Routing tab of the Agent network page: the current usage mode, every tunable of var/config/model-routing.json as a form
// (the same file scripts/pick-model.sh reads), and the recent decisions it logged. Save checks every value on the
// server, backs the file up and writes it atomically; the 90% reserve cannot be set lower.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { route, toHash } from "../router";
import { pickCounts } from "../pickCounts";
import { api, ago, toast } from "../ui/api";
import Icon from "../ui/Icon.vue";
import BentoCard from "../ui/BentoCard.vue";

interface Field { path: string; group: string; label: string; hint?: string; type: "int" | "float" | "bool" | "enum" | "string[]" | "bands"; value: any; min?: number; max?: number; options?: string[]; locked?: string }
interface Band { max_score: number | null; model: string; effort: string }
interface Win { key: string; pct: number; resetsAt: number | null; hours: number }
interface Mode { mode: "normal" | "careful" | "eco" | "reserve"; usagePct: number; windows: Win[]; pace: string | null; source: string; override: boolean; thresholds: { careful: number; eco: number; reserve: number } }
interface Decision { ts: string; agent: string; job: string; mode: string; usage: number | null; model: string; effort: string; score: number | null; reason: string; status: string; warnings: string[] }
interface Res { fields: Field[]; mode: Mode; decisions: Decision[]; backups: string[]; error: string | null }

const data = ref<Res | null>(null), draft = ref<Record<string, any>>({}), err = ref(""), saving = ref(false), opened = ref(new Set<string>());
const MODELS = ["haiku", "sonnet", "opus", "fable"], EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const GORDER = ["Scoring", "Risk floors", "Expectation points", "Expectation words", "Roles", "Score bands", "Usage modes"];
const groups = computed(() => { const m = new Map<string, Field[]>(); for (const f of data.value?.fields ?? []) (m.get(f.group) ?? m.set(f.group, []).get(f.group)!).push(f); const o = (g: string) => (GORDER.indexOf(g) + 99) % 99; return [...m.entries()].sort((a, b) => o(a[0]) - o(b[0])); });
const cur = (f: Field) => (f.path in draft.value ? draft.value[f.path] : f.value);
const dirty = computed(() => Object.keys(draft.value).filter((p) => JSON.stringify(draft.value[p]) !== JSON.stringify(data.value?.fields.find((f) => f.path === p)?.value)));
function set(f: Field, v: any) { err.value = ""; draft.value = { ...draft.value, [f.path]: v }; }
function bump(f: Field, d: number) { const step = f.type === "float" ? 0.05 : 1; const v = Math.round((Number(cur(f)) + d * step) * 100) / 100; set(f, Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v))); }
function typed(f: Field, e: Event) { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(f, f.type === "int" ? Math.round(n) : n); }
const toggle = (g: string) => { const s = new Set(opened.value); s.has(g) ? s.delete(g) : s.add(g); opened.value = s; };
/** Groups start closed; a group with unsaved changes stays open. */
const isShut = (g: string, l: Field[]) => !opened.value.has(g) && !changes(l);
const word = ref<Record<string, string>>({});
function addWord(f: Field) { const w = (word.value[f.path] ?? "").trim().toLowerCase(); if (!w) return; const l = cur(f) as string[]; if (!l.includes(w)) set(f, [...l, w]); word.value = { ...word.value, [f.path]: "" }; }
const bands = (f: Field) => cur(f) as Band[];
function setBand(f: Field, i: number, k: keyof Band, v: any) { const l = bands(f).map((b, j) => (j === i ? { ...b, [k]: v } : b)); set(f, l); }
function addBand(f: Field) { const l = [...bands(f)]; const last = l.pop()!; const prev = l.length ? (l[l.length - 1].max_score ?? 0) : 0; set(f, [...l, { max_score: prev + 2, model: last.model, effort: last.effort }, last]); }
function dropBand(f: Field, i: number) { const l = bands(f); if (l.length > 1 && i < l.length - 1) set(f, l.filter((_, j) => j !== i)); }

// Auto-compact window (config/spawn.json): one default plus per-role overrides. Own save, own endpoint; applies to new spawns only.
interface Compact { default: string; roles: Record<string, string>; min: string; max: string }
const cw = ref<Compact | null>(null), cwDef = ref(300), cwRoles = ref<{ role: string; k: number }[]>([]), cwErr = ref(""), cwSaving = ref(false), cwShut = ref(true);
const kOf = (v: string) => Number.parseInt(v, 10);
const cwMin = computed(() => kOf(cw.value?.min ?? "100k")), cwMax = computed(() => kOf(cw.value?.max ?? "1000k"));
const cwDirty = computed(() => !!cw.value && (cwDef.value !== kOf(cw.value.default) || JSON.stringify(cwRoles.value.filter((r) => r.role)) !== JSON.stringify(Object.entries(cw.value.roles).map(([role, v]) => ({ role, k: kOf(v) })))));
function cwFill(c: Compact) { cw.value = c; cwDef.value = kOf(c.default); cwRoles.value = Object.entries(c.roles).map(([role, v]) => ({ role, k: kOf(v) })); }
const clampK = (n: number) => Math.min(cwMax.value, Math.max(cwMin.value, Math.round(Number.isFinite(n) ? n : 300)));
async function loadCw() { try { cwFill(await api<Compact>("v1/panel/compact")); } catch (e) { cwErr.value = (e as Error).message; } }
async function saveCw() {
  if (cwSaving.value) return; cwSaving.value = true; cwErr.value = "";
  try { cwFill(await api<Compact>("v1/panel/compact", { method: "PUT", body: { default: cwDef.value + "k", roles: Object.fromEntries(cwRoles.value.filter((r) => r.role.trim()).map((r) => [r.role.trim().toLowerCase(), r.k + "k"])) } })); toast("Compact window saved"); }
  catch (e) { cwErr.value = (e as Error).message; } finally { cwSaving.value = false; }
}
async function load() { try { data.value = await api<Res>("v1/panel/routing"); } catch (e) { err.value = (e as Error).message; } }
/** One bar saves both: the routing file, then (own endpoint) the compact window. */
async function save() {
  if ((!dirty.value.length && !cwDirty.value) || saving.value) return; saving.value = true; err.value = "";
  try {
    if (dirty.value.length) { data.value = await api<Res>("v1/panel/routing", { method: "PUT", body: { changes: Object.fromEntries(dirty.value.map((p) => [p, draft.value[p]])) } }); draft.value = {}; }
    if (cwDirty.value) await saveCw();
    if (cwErr.value) err.value = cwErr.value; else toast("Routing saved");
  } catch (e) { err.value = (e as Error).message; } finally { saving.value = false; }
}
const discard = () => { draft.value = {}; err.value = ""; cwErr.value = ""; if (cw.value) cwFill(cw.value); };
let poll: ReturnType<typeof setInterval>; onMounted(() => { load(); loadCw(); poll = setInterval(load, 60_000); }); onUnmounted(() => clearInterval(poll));
/** The four-step track: normal up to careful, careful up to eco, eco up to reserve, reserve to 100. Fill per step follows usagePct. */
const steps = computed(() => {
  const m = data.value?.mode; if (!m) return [];
  const t = m.thresholds, edge = [0, t.careful, t.eco, t.reserve, 100];
  return (["normal", "careful", "eco", "reserve"] as const).map((k, i) => ({ k, from: edge[i], w: Math.max(1, edge[i + 1] - edge[i]), fill: Math.min(100, Math.max(0, ((m.usagePct - edge[i]) / Math.max(1, edge[i + 1] - edge[i])) * 100)) }));
});
const MORDER = ["haiku", "sonnet", "opus", "fable"] as const;
/** Windows line for the hero: every reported window, muted note when fewer than two. */
const winLine = computed(() => { const w = data.value?.mode.windows ?? []; return w.map((x) => `${winName(x.key)} ${Math.round(x.pct)}%${x.resetsAt ? ", resets " + resets(x.resetsAt) : ""}`).join(" · ") + (w.length < 2 ? (w.length ? " · one window reported" : "No fresh usage reading") : ""); });
const modeIdx = computed(() => (["normal", "careful", "eco", "reserve"] as const).indexOf(data.value?.mode.mode ?? "normal"));
const share = computed(() => {
  const l = data.value?.decisions ?? [];
  return MORDER.map((k) => ({ k, n: l.filter((d) => d.model === k).length, pct: l.length ? (l.filter((d) => d.model === k).length / l.length) * 100 : 0 }));
});
const winName = (k: string) => (k === "seven_day" ? "Week" : k === "five_hour" ? "5 hours" : k);
const resets = (t: number | null) => (t ? ago(t > 1e12 ? t / 1000 : t) : "");
const isRoles = (g: string) => g === "Roles";
const fullW = (g: string) => g === "Roles" || g === "Score bands" || g === "Usage modes";
const PLAIN: Record<string, string> = {
  "points.scope_step": "Per scope step", "points.novelty_step": "Per novelty step", "points.risk_step": "Per risk level",
  "expect.low": "Quick or cheap ask", "expect.normal": "No signal", "expect.high": "Quality or important ask",
  "expect_keywords.high": "Words that mean high", "expect_keywords.low": "Words that mean low", bands: "Bands",
  "floors.risk_sonnet_high": "Sonnet/high from risk level", "floors.risk_opus": "Opus from risk level",
  "usage.window": "Window that drives the mode", "usage.stale_hours": "Ignore readings older than (hours)", "usage.pace.enabled": "Pace escalation",
  "usage.pace.projected_pct": "Escalate at projected usage (%)", "usage.pace.min_elapsed": "Judge pace after (share of window)",
  "usage.modes.careful.min_pct": "Starts at (%)", "usage.modes.careful.effort_drop": "Effort levels dropped", "usage.modes.careful.opus_min_score": "Opus from score", "usage.modes.careful.allow_fable": "Allow Fable",
  "usage.modes.eco.min_pct": "Starts at (%)", "usage.modes.eco.builder_max_model": "Max model for writers", "usage.modes.eco.light_model": "Model for light roles", "usage.modes.eco.max_effort": "Max effort", "usage.modes.eco.max_active_teams": "Max active teams", "usage.modes.eco.max_agents_per_team": "Max agents per team",
  "usage.modes.reserve.min_pct": "Starts at (%)",
};
const lab = (f: Field) => PLAIN[f.path] ?? f.label;
/** Usage modes split into sub-headed sections; other groups are one section. */
const sections = (g: string, l: Field[]) => {
  if (g !== "Usage modes") return [{ h: "", cls: "", fields: l }];
  const pick = (re: RegExp) => l.filter((f) => re.test(f.path));
  return [
    { h: "Window and pace", cls: "gen", fields: l.filter((f) => !f.path.startsWith("usage.modes.")) },
    { h: "Careful", cls: "", fields: pick(/^usage\.modes\.careful\./) },
    { h: "Eco", cls: "", fields: pick(/^usage\.modes\.eco\./) },
    { h: "Reserve", cls: "", fields: pick(/^usage\.modes\.reserve\./) },
  ];
};
const val = (p: string) => { const f = data.value?.fields.find((x) => x.path === p); return f ? cur(f) : undefined; };
const summary = (g: string, l: Field[]) => {
  switch (g) {
    case "Scoring": return `Scope ${val("points.scope_step")} · Novelty ${val("points.novelty_step")} · Risk ${val("points.risk_step")}`;
    case "Expectation points": return `Low ${val("expect.low")} · Normal ${val("expect.normal")} · High ${val("expect.high")}`;
    case "Expectation words": return `${val("expect_keywords.high")?.length ?? 0} high · ${val("expect_keywords.low")?.length ?? 0} low words`;
    case "Risk floors": return `Sonnet/high from risk ${val("floors.risk_sonnet_high")} · Opus from ${val("floors.risk_opus")}`;
    case "Roles": { const r = roleRows(l); return `${r.length} roles · ${r.filter((x) => x.fields.some((f) => f.path.endsWith(".writes") && cur(f))).length} write code`; }
    case "Score bands": { const b = bands(l[0]); const t = b[b.length - 1]; return `${b.length} bands, top ${t?.model}/${t?.effort}`; }
    case "Usage modes": return `Window ${String(val("usage.window")).replace("_", " ")} · careful ${val("usage.modes.careful.min_pct")}% · eco ${val("usage.modes.eco.min_pct")}% · reserve ${val("usage.modes.reserve.min_pct")}%`;
    default: return "";
  }
};
/** Roles group: one row per role (path roles.<role>.<points|writes|light>), columns in fixed order. */
const roleRows = (l: Field[]) => {
  const m = new Map<string, Field[]>();
  for (const f of l) { const r = f.path.split(".")[1] ?? f.path; (m.get(r) ?? m.set(r, []).get(r)!).push(f); }
  const ord = (f: Field) => ["points", "writes", "light"].findIndex((k) => f.path.includes(k));
  return [...m.entries()].map(([role, fields]) => ({ role, hint: fields.find((f) => f.hint)?.hint, fields: fields.sort((a, b) => ord(a) - ord(b)) }));
};
/** Six open groups in three columns (board 10, Rules at 1920). */
const COLS = [[["Scoring"], ["Expectation points", "Expectation words"], ["Risk floors"]], [["Usage modes"]], [["Roles"], ["Score bands"]]];
const cols = computed(() => { const m = new Map(groups.value); return COLS.map((c) => c.map((s) => s.filter((g) => m.has(g)).map((g) => [g, m.get(g)!] as [string, Field[]])).filter((s) => s.length)); });
const secTitle = (sec: [string, Field[]][]) => (sec[0][0] === "Scoring" ? "Score points per step" : sec[0][0] === "Expectation points" ? "Expectation" : sec[0][0] === "Risk floors" ? "Risk floors and compact window" : sec[0][0]);
const show = (v: unknown): string => (Array.isArray(v) ? (v.length && typeof v[0] === "object" ? `${v.length} bands` : `${v.length} words`) : typeof v === "boolean" ? (v ? "on" : "off") : String(v));
const nChg = computed(() => dirty.value.length + (cwDirty.value ? 1 : 0));
const dirtyText = computed(() => [...dirty.value.map((p) => { const f = data.value?.fields.find((x) => x.path === p); return f ? `${lab(f).toLowerCase()} ${show(f.value)} to ${show(draft.value[p])}` : p; }), ...(cwDirty.value ? [`compact window ${cw.value?.default ?? ""} to ${cwDef.value}k`] : [])].join(", "));
const wide = (l: Field[]) => l.some((f) => f.type === "bands" || f.type === "string[]");
const changes = (l: Field[]) => l.filter((f) => dirty.value.includes(f.path)).length;
const when = (ts: string) => ago(Date.parse(ts) / 1000);
const MODE_NOTE: Record<string, string> = { normal: "Full rubric: every agent gets the model its score says.", careful: "One effort level lower; Fable falls back to Opus unless asked for.", eco: "Builders max Sonnet, light roles Haiku, one team of at most three agents.", reserve: "No new heavy work. Chat and light checks only." };

/** Picks (default) and Rules are two views of one page: #/routing and #/routing?view=rules. */
const view = computed(() => (route.value.query.view === "rules" ? "rules" : "picks"));
function setView(v: "picks" | "rules") { route.value = { page: "routing", query: v === "rules" ? { view: "rules" } : {} }; history.replaceState(null, "", toHash(route.value)); }
const RANK = ["haiku", "sonnet", "opus", "fable"], ERANK = ["low", "medium", "high", "xhigh", "max"];
const bandList = computed(() => ((data.value?.fields.find((f) => f.path === "bands")?.value ?? []) as Band[]));
const bandIdx = (score: number | null) => (score == null ? -1 : bandList.value.findIndex((b) => b.max_score === null || score <= b.max_score));
interface Pick { id: string; d: Decision; band: Band | null; changed: boolean; owner: boolean; tag: string }
const picks = computed<Pick[]>(() => (data.value?.decisions ?? []).map((d) => {
  const band = bandList.value[bandIdx(d.score)] ?? null, owner = /explicit:/.test(d.reason);
  const changed = !!band && (band.model !== d.model || band.effort !== d.effort);
  const lowerModel = !!band && RANK.indexOf(d.model) < RANK.indexOf(band.model);
  const tag = owner ? `owner asked ${d.model}` : changed ? `${d.mode} ${lowerModel ? "capped" : "lowered effort"}` : "";
  return { id: d.ts + d.agent, d, band, changed, owner, tag };
}));
const cnt = computed(() => pickCounts(picks.value));
const openPick = ref<string | null>(null);
const pickedPick = computed(() => picks.value.find((p) => p.id === openPick.value) ?? null);
const fval = (p: string) => data.value?.fields.find((f) => f.path === p)?.value;
/** Eco is the only mode with a model ceiling: builders max Sonnet, effort max medium (both read from the saved rules). */
const ceiling = computed(() => (data.value?.mode.mode === "eco" ? { model: String(fval("usage.modes.eco.builder_max_model") ?? "sonnet"), effort: String(fval("usage.modes.eco.max_effort") ?? "medium") } : null));
const ceilText = computed(() => (ceiling.value ? `eco ceiling: ${ceiling.value.model}, ${ceiling.value.effort}` : ""));
const above = (b: Band) => !!ceiling.value && (RANK.indexOf(b.model) > RANK.indexOf(ceiling.value.model) || (RANK.indexOf(b.model) === RANK.indexOf(ceiling.value.model) && ERANK.indexOf(b.effort) > ERANK.indexOf(ceiling.value.effort)));
/** Ladder rows, top band first; the ceiling line is drawn above the first step that is not struck. */
const bandRows = computed(() => {
  const bl = bandList.value; let seenOk = false;
  const rows = bl.map((b, i) => {
    const lo = i === 0 ? null : (bl[i - 1].max_score ?? 0) + 1;
    const range = b.max_score === null ? `${lo} +` : lo === null ? `up to ${b.max_score}` : lo === b.max_score ? `${lo}` : `${lo} to ${b.max_score}`;
    return { model: b.model, effort: b.effort, range, struck: above(b), n: picks.value.filter((p) => bandIdx(p.d.score) === i).length, ceilingAbove: false };
  }).reverse();
  for (const r of rows) { if (!r.struck && !seenOk && ceiling.value) { r.ceilingAbove = rows.some((x) => x.struck); seenOk = true; } }
  return rows;
});
/** Score sum rebuilt from the log line ("scope4 nov2 risk1 mobile-dev+1 expect:normal") and the saved point steps. */
const pickedSum = computed(() => {
  const d = pickedPick.value?.d; if (!d) return { rows: [] as { l: string; v: string }[] };
  const n = (re: RegExp) => { const m = d.reason.match(re); return m ? Number(m[1]) : null; };
  const sg = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v);
  const scope = n(/scope(\d)/), nov = n(/nov(\d)/), risk = n(/risk(\d)/), role = d.reason.match(/\b([a-z][a-z0-9-]*)([+-]\d+)\b/), ex = d.reason.match(/expect:(\w+)/)?.[1];
  const rows: { l: string; v: string }[] = [];
  if (scope != null) rows.push({ l: `Scope ${scope} (files and systems)`, v: sg((scope - 1) * Number(fval("points.scope_step") ?? 1)) });
  if (nov != null) rows.push({ l: `Novelty ${nov}`, v: sg((nov - 1) * Number(fval("points.novelty_step") ?? 2)) });
  if (risk != null) rows.push({ l: `Risk ${risk}`, v: sg(risk * Number(fval("points.risk_step") ?? 2)) });
  if (role) rows.push({ l: `Role ${role[1]}`, v: sg(Number(role[2])) });
  if (ex) rows.push({ l: `Expectation: ${ex}`, v: sg(Number(fval("expect." + ex) ?? 0)) });
  return { rows };
});
function modeRule(d: Decision) {
  const at = d.usage != null ? ` at ${Math.round(d.usage)}%` : "";
  if (d.mode === "normal") return `Normal mode${at}: the score picks the model as it is.`;
  const note = MODE_NOTE[d.mode] ?? "";
  return `${d.mode[0].toUpperCase() + d.mode.slice(1)} mode${at}: ${note[0]?.toLowerCase() ?? ""}${note.slice(1)}`;
}
</script>

<template>
  <div class="page rp" :class="{ pk: !!pickedPick && view === 'picks' }">
    <header class="ph">
      <div class="rp-ttl"><h1>Routing</h1><span v-if="data" class="rp-meta num">{{ data.mode.mode }} · {{ Math.round(data.mode.usagePct) }}% used</span></div>
      <div class="rp-seg" role="tablist" aria-label="View">
        <button type="button" role="tab" :aria-selected="view === 'picks'" @click="setView('picks')">Picks</button>
        <button type="button" role="tab" :aria-selected="view === 'rules'" @click="setView('rules')">Rules<span v-if="dirty.length" class="rp-dot" aria-label="unsaved changes" /></button>
      </div>
    </header>
    <p v-if="data?.error" class="ar-err" role="alert">{{ data.error }}</p>
    <p v-if="!data && err" class="ar-err" role="alert">{{ err }}</p>
    <section v-if="view === 'picks'" class="rp-picks" aria-label="Model picks">
      <div class="rp-left">
        <BentoCard v-if="data" title="Mode now" flat>
          <template #control><span v-if="data.mode.override" class="ar-tag">reserve override on</span></template>
          <div class="rt-wrap">
            <div class="rt" role="meter" aria-label="Usage and routing mode" :aria-valuenow="Math.round(data.mode.usagePct)" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="`${Math.round(data.mode.usagePct)} percent used, mode ${data.mode.mode}; careful from ${data.mode.thresholds.careful}, eco from ${data.mode.thresholds.eco}, reserve from ${data.mode.thresholds.reserve}`">
              <div v-for="(st, i) in steps" :key="st.k" class="rt-s" :class="{ on: st.k === data.mode.mode, past: i < modeIdx }" :style="{ flex: st.w + ' 1 0' }">
                <span class="rt-b"><i :style="{ width: st.fill + '%' }" /></span>
                <span class="rt-l"><b>{{ st.k }}</b><small class="num">{{ st.from === 0 ? "from 0%" : "from " + st.from + "%" }}</small></span>
              </div>
              <span class="rt-m" :style="{ left: Math.min(100, data.mode.usagePct) + '%' }"><em class="num">{{ Math.round(data.mode.usagePct) }}%</em></span>
            </div>
          </div>
          <p class="ar-win num">{{ winLine }}</p>
          <p class="ar-note">{{ MODE_NOTE[data.mode.mode] }}<template v-if="data.mode.pace"> Raised one step because {{ data.mode.pace }}.</template></p>
          <template #foot><span class="ar-lock2"><Icon name="lock" :size="12" /> Reserve from {{ data.mode.thresholds.reserve }}% is a fixed rule and cannot be set lower.</span> Source {{ data.mode.source }}.</template>
        </BentoCard>
        <section v-if="data && bandRows.length" class="rp-card rp-lad" aria-label="Score to model">
          <h2>Score to model, and what {{ data.mode.mode }} allows</h2>
          <ul>
            <template v-for="(r, i) in bandRows" :key="i">
              <li v-if="r.ceilingAbove" class="rp-ceil"><span>{{ ceilText }}</span></li>
              <li class="rp-st"><span class="num rp-rg">{{ r.range }}</span><span class="rp-bar" :class="{ cut: r.struck }">{{ r.model }} · {{ r.effort }}</span><span class="rp-cn">{{ r.n ? r.n + " of the last " + picks.length : "none lately" }}</span></li>
            </template>
          </ul>
          <p v-if="ceilText" class="rp-ft">Struck-through steps are above the {{ data.mode.mode }} ceiling, so they run lower unless the owner names a model.</p>
        </section>
      </div>
      <section class="rp-card rp-list" aria-label="Last picks">
        <h2>Last {{ picks.length }} picks: <b>{{ cnt.mode }}</b> changed by the mode, <b>{{ cnt.owner }}</b> named by the owner, <b>{{ cnt.kept }}</b> kept their band</h2>
        <p v-if="data && !picks.length" class="rp-ft">Nothing logged yet.</p>
        <ul class="rp-rows" role="list">
          <li v-for="p in picks" :key="p.id" :class="{ on: openPick === p.id }">
            <button type="button" :aria-expanded="openPick === p.id" :aria-label="`${p.d.agent}: why it got ${p.d.model} ${p.d.effort}`" @click="openPick = openPick === p.id ? null : p.id">
              <span class="rp-l1"><b>{{ p.d.agent || "unknown" }}</b><span class="rp-sc num">score {{ p.d.score ?? "n/a" }}</span><span class="rp-sc num">{{ p.d.mode }}<template v-if="p.d.usage != null"> · {{ Math.round(p.d.usage) }}%</template></span><span class="rp-when num">{{ when(p.d.ts) }}</span></span>
              <span class="rp-l2">
                <template v-if="p.changed && p.band"><s class="rp-was">{{ p.band.model }} · {{ p.band.effort }}</s><Icon name="arrow-right" :size="13" /></template>
                <span class="rp-ran"><i :class="'m-' + p.d.model" />{{ p.d.model }} · {{ p.d.effort }}</span>
                <span v-if="p.tag" class="rp-tag" :class="{ own: p.owner }">{{ p.tag }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>
      <aside v-if="pickedPick" class="rp-pane" aria-label="Why this pick">
        <header><span class="rp-eb"><Icon name="sliders" :size="14" /> Pick · {{ when(pickedPick.d.ts) }}</span><button type="button" class="rp-x" aria-label="Close" @click="openPick = null"><Icon name="circle-x" :size="18" /></button></header>
        <h2>Why {{ pickedPick.d.agent }} got {{ pickedPick.d.model }} · {{ pickedPick.d.effort }}</h2>
        <ul v-if="pickedSum.rows.length" class="rp-sum">
          <li v-for="r in pickedSum.rows" :key="r.l"><span>{{ r.l }}</span><b class="num">{{ r.v }}</b></li>
          <li class="tot"><span>Score</span><b class="num">{{ pickedPick.d.score ?? "n/a" }}</b></li>
        </ul>
        <p v-else class="rp-ft">This pick has no score breakdown in its log line.</p>
        <ol class="rp-steps">
          <li><i>1</i><span>Score {{ pickedPick.d.score ?? "n/a" }} falls in the band for <code>{{ pickedPick.band ? pickedPick.band.model + " · " + pickedPick.band.effort : "unknown" }}</code>.</span></li>
          <li><i>2</i><span>{{ modeRule(pickedPick.d) }}</span></li>
          <li class="last"><i>3</i><span>Ran as <code>{{ pickedPick.d.model }} · {{ pickedPick.d.effort }}</code>.</span></li>
        </ol>
        <div class="rp-acts"><a class="rp-btn" :href="'#/agents?agent=' + encodeURIComponent(pickedPick.d.agent)"><Icon name="arrow-right" :size="14" /> Open {{ pickedPick.d.agent }}</a><button type="button" class="rp-btn" @click="setView('rules')"><Icon name="sliders" :size="14" /> See the rules</button></div>
      </aside>
    </section>
    <section v-else class="ar rp-rules" :class="{ bar: nChg || err }" aria-label="Model routing rules">
      <div class="rr">
        <div v-for="(col, ci) in cols" :key="ci" class="rr-col">
          <section v-for="sec in col" :key="sec[0][0]" class="rr-g" :aria-label="secTitle(sec)">
            <h2>{{ secTitle(sec) }}<span v-if="sec.some(([, l]) => changes(l))" class="ar-cc num"><i class="ar-dot" />{{ sec.reduce((n, [, l]) => n + changes(l), 0) }} changed</span></h2>
            <div v-for="[g, list] in sec" :key="g" class="rr-s">
              <h3 v-if="sec.length > 1">{{ g.replace("Expectation ", "") }}</h3>
              <div class="ar-gi">
            <table v-if="isRoles(g)" class="ar-rt"><thead><tr><th>Role</th><th>Points</th><th>Writes code</th><th>Light role</th></tr></thead>
              <tbody><tr v-for="r in roleRows(list)" :key="r.role" :class="{ changed: r.fields.some((f) => dirty.includes(f.path)) }">
                <th scope="row" :title="r.hint">{{ r.role }}</th>
                <td v-for="f in r.fields" :key="f.path">
                  <div v-if="f.type === 'int' || f.type === 'float'" class="ar-step">
                    <button type="button" :aria-label="`${r.role} points less`" :disabled="f.min !== undefined && cur(f) <= f.min" @click="bump(f, -1)">−</button>
                    <input :key="cur(f)" class="roll" type="number" inputmode="decimal" :aria-label="`${r.role} points`" :min="f.min" :max="f.max" :value="cur(f)" @change="typed(f, $event)" />
                    <button type="button" :aria-label="`${r.role} points more`" :disabled="f.max !== undefined && cur(f) >= f.max" @click="bump(f, 1)">+</button>
                  </div>
                  <button v-else type="button" class="sw" role="switch" :aria-checked="!!cur(f)" :aria-label="`${r.role}: ${f.label.split(':').pop()?.trim()}`" @click="set(f, !cur(f))"></button>
                </td>
              </tr></tbody></table>
            <div v-for="sec in (isRoles(g) ? [] : sections(g, list))" :key="sec.h" class="ar-sec" :class="sec.cls"><h3 v-if="sec.h">{{ sec.h }}</h3>
            <div v-for="f in sec.fields" :key="f.path" class="ar-row" :class="{ changed: dirty.includes(f.path), wide: f.type === 'bands' || f.type === 'string[]' }">
              <div class="ar-l"><label :for="'f-' + f.path" class="ar-lt">{{ lab(f) }}</label><p v-if="f.hint" class="ar-h">{{ f.hint }}</p><p v-if="f.locked" class="ar-lock"><Icon name="lock" :size="11" /> {{ f.locked }}</p></div>
              <div class="ar-c">
                <div v-if="f.path === 'usage.modes.reserve.min_pct'" class="ar-fix"><Icon name="lock" :size="13" /> fixed at <b class="num">{{ cur(f) }}%</b></div>
                <div v-else-if="f.type === 'int' || f.type === 'float'" class="ar-step">
                  <button type="button" aria-label="Less" :disabled="f.min !== undefined && cur(f) <= f.min" @click="bump(f, -1)">−</button>
                  <input :key="cur(f)" class="roll" :id="'f-' + f.path" type="number" inputmode="decimal" :min="f.min" :max="f.max" :step="f.type === 'float' ? 0.05 : 1" :value="cur(f)" @change="typed(f, $event)" />
                  <button type="button" aria-label="More" :disabled="f.max !== undefined && cur(f) >= f.max" @click="bump(f, 1)">+</button>
                </div>
                <button v-else-if="f.type === 'bool'" :id="'f-' + f.path" type="button" class="sw" role="switch" :aria-checked="!!cur(f)" :aria-label="lab(f)" @click="set(f, !cur(f))"></button>
                <div v-else-if="f.type === 'enum'" class="ar-seg" role="radiogroup" :aria-label="lab(f)"><button v-for="o in f.options" :key="o" type="button" role="radio" :aria-checked="cur(f) === o" @click="set(f, o)">{{ o.replace("_", " ") }}</button></div>
                <div v-else-if="f.type === 'string[]'" class="ar-chips">
                  <span v-for="w in cur(f)" :key="w" class="ar-chip">{{ w }}<button type="button" :aria-label="`Remove ${w}`" @click="set(f, cur(f).filter((x: string) => x !== w))">×</button></span>
                  <input :id="'f-' + f.path" v-model="word[f.path]" placeholder="add a word" maxlength="40" @keydown.enter.prevent="addWord(f)" @blur="addWord(f)" />
                </div>
                <div v-else-if="f.type === 'bands'" class="ar-bands">
                  <div v-for="(b, i) in bands(f)" :key="i" class="ar-band">
                    <span class="ar-bl">{{ b.max_score === null ? "above" : "score ≤" }}</span>
                    <input v-if="b.max_score !== null" type="number" :aria-label="`Band ${i + 1} score limit`" :value="b.max_score" @change="setBand(f, i, 'max_score', Number(($event.target as HTMLInputElement).value))" />
                    <span v-else class="ar-inf num">{{ bands(f)[i - 1]?.max_score ?? 0 }}</span>
                    <div class="ar-seg sm" role="radiogroup" :aria-label="`Band ${i + 1} model`"><button v-for="m in MODELS" :key="m" type="button" role="radio" :aria-checked="b.model === m" @click="setBand(f, i, 'model', m)">{{ m }}</button></div>
                    <div class="ar-seg sm" role="radiogroup" :aria-label="`Band ${i + 1} effort`"><button v-for="e in EFFORTS" :key="e" type="button" role="radio" :aria-checked="b.effort === e" @click="setBand(f, i, 'effort', e)">{{ e }}</button></div>
                    <button type="button" class="ar-x" :disabled="i === bands(f).length - 1 || bands(f).length < 2" :aria-label="`Remove band ${i + 1}`" @click="dropBand(f, i)">×</button>
                  </div>
                  <button type="button" class="ar-add" :disabled="bands(f).length >= 8" @click="addBand(f)">+ Add band</button>
                </div>
              </div>
            </div>
            </div>
          </div>
            </div>
            <div v-if="ci === 0 && sec[0][0] === 'Risk floors' && cw" class="rr-s">
              <h3>Auto-compact window</h3>
              <div class="ar-gi">
            <p class="ar-h cw-note">Each new agent compacts its context at this size, so the context card divides by it. Changes apply to new spawns only; agents already running keep the window they started with. <span class="num">{{ cw.min }} to {{ cw.max }}</span>.</p>
            <div class="ar-row">
              <div class="ar-l"><label for="cw-def" class="ar-lt">Default window</label><p class="ar-h">Used by every role without an override. The AGENT_COMPACT_WINDOW variable still wins at spawn.</p></div>
              <div class="ar-c"><div class="ar-step">
                <button type="button" aria-label="Less" :disabled="cwDef <= cwMin" @click="cwDef = clampK(cwDef - 50)">−</button>
                <input id="cw-def" type="number" inputmode="numeric" :min="cwMin" :max="cwMax" step="50" :value="cwDef" @change="cwDef = clampK(Number(($event.target as HTMLInputElement).value))" />
                <button type="button" aria-label="More" :disabled="cwDef >= cwMax" @click="cwDef = clampK(cwDef + 50)">+</button>
              </div><span class="cw-u">k tokens</span></div>
            </div>
            <div class="ar-row wide">
              <div class="ar-l"><span class="ar-lt">Per-role overrides</span><p class="ar-h">Role is the agent name without its number: backend-1 is backend.</p></div>
              <div class="ar-c ar-bands">
                <div v-for="(r, i) in cwRoles" :key="i" class="ar-band">
                  <input class="cw-role" v-model="r.role" :aria-label="`Override ${i + 1} role`" placeholder="role" maxlength="31" />
                  <div class="ar-step">
                    <button type="button" aria-label="Less" :disabled="r.k <= cwMin" @click="r.k = clampK(r.k - 50)">−</button>
                    <input type="number" inputmode="numeric" :min="cwMin" :max="cwMax" step="50" :aria-label="`Override ${i + 1} window`" :value="r.k" @change="r.k = clampK(Number(($event.target as HTMLInputElement).value))" />
                    <button type="button" aria-label="More" :disabled="r.k >= cwMax" @click="r.k = clampK(r.k + 50)">+</button>
                  </div><span class="cw-u">k</span>
                  <button type="button" class="ar-x" :aria-label="`Remove override ${i + 1}`" @click="cwRoles = cwRoles.filter((_, j) => j !== i)">×</button>
                </div>
                <button type="button" class="ar-add" :disabled="cwRoles.length >= 20" @click="cwRoles = [...cwRoles, { role: '', k: cwDef }]">+ Add override</button>
              </div>
            </div>
            <p v-if="cwErr" class="ar-sm bad" role="alert">{{ cwErr }}</p>
          </div>
            </div>
          </section>
        </div>
      </div>

      <Transition name="ar-bar">
        <div v-if="nChg || err" class="ar-save" role="region" aria-label="Unsaved changes">
          <span class="ar-sm" :class="{ bad: err }">{{ err || `${nChg} change${nChg > 1 ? "s" : ""}: ${dirtyText}` }}</span>
          <button type="button" class="ar-b" :disabled="saving" @click="discard">Discard</button>
          <button type="button" class="ar-b go" :disabled="saving || !nChg" @click="save">{{ saving ? "Saving…" : "Save" }}</button>
        </div>
      </Transition>
    </section>
  </div>
</template>

<style scoped>
.ar{display:flex;flex-direction:column;gap:12px;padding-bottom:24px}
.ar-err,.bad{color:var(--warn)}
.ar-tag{font:500 11px var(--mono);padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.ar-note{margin:10px 0 0;color:var(--ink);font:400 13px/1.45 var(--body)}
.ar-lock2{display:inline-flex;align-items:center;gap:5px;color:var(--lock)}
.rt-wrap{padding:22px 4px 40px}
.rt{position:relative;display:flex;gap:3px}
.rt-s{min-width:0}
.rt-b{display:block;height:12px;border-radius:4px;background:var(--track);overflow:hidden}
.rt-b i{display:block;height:100%;background:var(--chrome);transform-origin:left;animation:rt-grow .45s cubic-bezier(.2,.8,.2,1) both}
.rt-s.on .rt-b{box-shadow:0 0 0 1.5px var(--ink)}
.rt-l{display:flex;flex-direction:column;margin-top:6px;color:var(--muted);font:500 11.5px/1.3 var(--body)}
.rt-l b{font-weight:600;text-transform:capitalize}
.rt-s.on .rt-l{color:var(--ink)}
.rt-m{position:absolute;top:-6px;height:24px;width:2px;margin-left:-1px;background:var(--ink)}
.rt-m em{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:2px;font:700 12px var(--mono);font-style:normal}
.rt-w{display:block;height:10px;border-radius:5px;background:var(--track);overflow:hidden;margin-top:10px}
.rt-w i{display:block;height:100%;border-radius:5px;background:var(--chrome);transform-origin:left;animation:rt-grow .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes rt-grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
.sh{display:flex;gap:2px;height:14px;border-radius:5px;overflow:hidden}
.sh i{display:block;min-width:4px}
.sh-k{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:4px;font-size:12.5px}
.sh-k li{display:flex;align-items:center;gap:8px}
.sh-k li i{width:10px;height:10px;border-radius:3px;flex:none}
.sh-k li span{flex:1}
.ar-cc{color:var(--muted);font:600 11.5px var(--mono)}
.ar-tg{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:var(--muted);cursor:pointer}
.ar-tg:focus-visible{outline:2px solid var(--ink);outline-offset:-4px;border-radius:10px}
.ar-chev{transition:transform .22s}.ar-grp:not(.shut) .ar-chev{transform:rotate(180deg)}
.ar-grp.shut{gap:0}
.ar-gb{display:grid;grid-template-rows:1fr;transition:grid-template-rows .26s cubic-bezier(.2,.8,.2,1)}
.ar-grp.shut .ar-gb{grid-template-rows:0fr}
.ar-gi{overflow:hidden;min-height:0}
.ar-grp.shut .ar-gi{visibility:hidden;transition:visibility 0s .26s}
.ar-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--line)}
.ar-gi > .ar-row:first-child{border-top:0}
.ar-row.wide{flex-direction:column;align-items:stretch;gap:8px}
.ar-row.changed .ar-lt::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hook);margin-left:8px;vertical-align:middle}
.ar-l{min-width:0;flex:1}.ar-lt{font:500 13px var(--body);text-transform:capitalize}
.ar-h{margin:2px 0 0;color:var(--muted);font:400 12px/1.4 var(--body)}
.ar-lock{margin:3px 0 0;color:var(--lock);font:400 11.5px var(--body);display:flex;align-items:center;gap:5px}
.ar-c{flex:none;max-width:100%}.ar-row.wide .ar-c{flex:1}
.ar-step{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.ar-step button{width:36px;height:36px;border:0;background:var(--track);color:var(--ink);font:600 16px var(--body);cursor:pointer}
.ar-step button:disabled{opacity:.3;cursor:default}
.ar-step input,.ar-band input{width:58px;height:36px;border:0;background:none;color:var(--ink);text-align:center;font:600 14px var(--body);-moz-appearance:textfield;appearance:textfield}
.ar-step input::-webkit-outer-spin-button,.ar-step input::-webkit-inner-spin-button,.ar-band input::-webkit-outer-spin-button,.ar-band input::-webkit-inner-spin-button{-webkit-appearance:none}
.ar-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:10px;background:var(--track)}
.ar-seg button{min-height:32px;padding:0 11px;border:0;border-radius:8px;background:none;color:var(--muted);font:600 12.5px var(--body);cursor:pointer;transition:background .15s,color .15s}
.ar-seg button[aria-checked="true"]{background:color-mix(in srgb,var(--ink) 16%,transparent);color:var(--ink)}
.ar-seg.sm button{min-height:28px;padding:0 8px;font-size:11.5px}
.ar-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ar-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 10px;border-radius:999px;background:var(--track);font:500 12px var(--body)}
.ar-chip button{width:20px;height:20px;border:0;border-radius:50%;background:none;color:var(--muted);cursor:pointer;font-size:14px}
.ar-chips input{height:30px;min-width:110px;padding:0 10px;border-radius:999px;border:1px dashed var(--line);background:none;color:var(--ink);font:400 12px var(--body)}
.ar-bands{display:flex;flex-direction:column;gap:8px}
.ar-band{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;border-radius:10px;background:var(--panel-2)}
.ar-bl{width:52px;color:var(--muted);font:400 12px var(--body)}.ar-band input{width:48px;border:1px solid var(--line);border-radius:8px;height:30px}.ar-inf{width:48px;text-align:center;color:var(--muted)}
.ar-x,.ar-add{border:1px solid var(--line);background:none;color:var(--muted);border-radius:8px;min-height:30px;padding:0 10px;cursor:pointer;font:500 12px var(--body)}
.ar-x:disabled,.ar-add:disabled{opacity:.3;cursor:default}.ar-add{align-self:flex-start}
.cw-note{margin:0 0 6px}.cw-u{margin-left:8px;color:var(--muted);font:500 12px var(--mono)}.cw-role{width:140px!important;text-align:left!important;border:1px solid var(--line);border-radius:8px;padding:0 8px}
.cw-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:12px 0 0;border-top:1px solid var(--line)}.cw-foot .ar-sm{text-align:left}
.ar-rt{width:100%;border-collapse:collapse;font-size:13px}
.ar-rt th,.ar-rt td{padding:6px 8px;border-top:1px solid var(--line);text-align:center}
.ar-rt thead th{border-top:0;color:var(--muted);font:600 11px var(--body)}
.ar-rt tbody th{text-align:left;font:500 13px var(--body);text-transform:capitalize;white-space:nowrap}
.ar-rt tr.changed th::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hook);margin-left:8px;vertical-align:middle}
.ar-rt .ar-step{margin:0 auto}
.ar-dec{max-height:408px;overflow:auto;margin-top:12px}
.ar-dm{display:contents}
.ar-d{display:grid;grid-template-columns:minmax(140px,1.6fr) 92px 72px 72px 80px 84px;gap:10px;align-items:center;min-height:51px;padding:6px 0;border-top:1px solid var(--line);font:400 12.5px var(--body)}
.ar-d:first-child{border-top:0}
.ar-dt{color:var(--muted);text-align:right;white-space:nowrap}.ar-da{display:flex;flex-direction:column;min-width:0}.ar-da b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ar-da small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-ds{color:var(--muted)}
.ar-pill{display:inline-flex;align-items:center;gap:6px;justify-self:start;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--ink) 10%,transparent);font:600 11px var(--mono)}.ar-pill.dim{background:color-mix(in srgb,var(--ink) 5%,transparent);color:var(--muted)}
.ar-pill.diff{color:var(--warn);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--warn) 50%,transparent)}
.ar-pill i,.sh-k i{width:9px;height:9px;border-radius:3px;flex:none}
.ar-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ar-d{position:relative}
.ar{--m-haiku:#3987e5;--m-sonnet:#d95926;--m-opus:#199e70;--m-fable:#c98500}
:root[data-theme="light"] .ar{--m-haiku:#2a78d6;--m-sonnet:#eb6834;--m-opus:#1baf7a;--m-fable:#eda100}
.m-haiku{background:var(--m-haiku)}.m-sonnet{background:var(--m-sonnet)}.m-opus{background:var(--m-opus)}.m-fable{background:var(--m-fable)}
.sh-w{display:flex;flex-direction:column;gap:8px}
.sh-t{color:var(--muted);font:500 12px var(--body)}
.sh{display:flex;gap:2px;height:14px;border-radius:5px;overflow:hidden}.sh i{display:block;min-width:4px}
.sh-k{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 22px;font-size:12.5px}
.sh-k li{display:flex;align-items:center;gap:7px}.sh-k li.zero{color:var(--muted)}.sh-k li.zero i{opacity:.35}
.ar-win{margin:8px 0 0;color:var(--muted);font:500 12.5px var(--mono)}
.ar-sum.bd{margin:0;white-space:normal;max-width:none}
.ar-sum{flex:1;min-width:0;max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:400 12.5px var(--body)}
.ar-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--hook);margin-right:6px}
.ar-sec h3{margin:12px 0 2px;color:var(--muted);font:600 11.5px var(--body);letter-spacing:.06em;text-transform:uppercase}
.ar-sec:first-child h3{margin-top:0}
.ar-grp{align-self:start}
@media(min-width:1280px){.ar-gi:has(.ar-sec ~ .ar-sec){display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 28px}.ar-sec.gen{grid-column:1/-1}}
@media(min-width:1280px){.ar-sec.gen{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px}.ar-sec.gen h3{grid-column:1/-1}}
.rt-s.past .rt-b i{background:color-mix(in srgb,var(--ink) 38%,var(--panel))}
.rt-s.on .rt-b i{background:var(--ink)}
.rt-s:last-child{overflow:visible}.rt-s:last-child .rt-l{width:max-content;position:absolute;right:0;align-items:flex-end;text-align:right;white-space:nowrap}
.rt-l small{color:var(--ink);opacity:.78}
.rt-l b,.rt-l small{white-space:nowrap}
.ar-save{position:sticky;bottom:12px;margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:var(--panel);border:1px solid var(--ink);box-shadow:0 -10px 30px rgba(0,0,0,.25);z-index:20}
.ar-sm{flex:1;font:500 13px var(--body)}
.ar-b{min-height:44px;padding:0 16px;border-radius:9px;border:1px solid var(--line);background:none;color:var(--ink);font:600 13px var(--body);cursor:pointer}
.ar-b.go{background:var(--ink);color:var(--bg);border-color:var(--ink)}.ar-b:disabled{opacity:.5;cursor:default}
.ar-bar-enter-active,.ar-bar-leave-active{transition:transform .2s cubic-bezier(.2,.8,.2,1),opacity .2s}
.ar-bar-enter-from,.ar-bar-leave-to{transform:translateY(16px);opacity:0}
@media (max-width:700px){.ar-d{grid-template-columns:minmax(0,1fr) auto;row-gap:4px;padding:8px 0}.ar-dm{grid-column:1/-1;grid-row:2;display:flex;align-items:center;flex-wrap:wrap;gap:8px}.ar-dt{grid-column:2;grid-row:1}.ar-row:not(.wide){flex-wrap:wrap}.ar-sum.hd{display:none}}
@media (min-width:701px){.ar-sum.bd{display:none}}
@media (max-width:420px){.ar-row:not(.wide){flex-direction:column;align-items:stretch;gap:8px}.ar-row:not(.wide) .ar-c{flex:none}}
@media (prefers-reduced-motion:reduce){.ar-gb,.rt-b i,.rt-w i,.ar-bar-enter-active,.ar-bar-leave-active,.ar-chev{transition:none;animation:none}}

.rp{flex:1;min-height:0;gap:12px}
.rp-ttl{display:flex;align-items:baseline;gap:12px}.rp-meta{color:var(--muted);font-size:13px}.num{font-variant-numeric:tabular-nums}
.rp-seg{display:inline-flex;padding:3px;border-radius:10px;border:1px solid var(--line);background:var(--panel)}
.rp-seg button{all:unset;box-sizing:border-box;position:relative;min-height:38px;padding:0 16px;display:inline-flex;align-items:center;border-radius:8px;font:600 13px var(--body);color:var(--muted);cursor:pointer}
.rp-seg button[aria-selected="true"]{background:var(--track);color:var(--ink)}
.rp-seg button:focus-visible,.rp-rows button:focus-visible,.rp-x:focus-visible,.rp-btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.rp-dot{width:7px;height:7px;border-radius:50%;background:var(--warn);margin-left:6px}
.rp-picks{flex:1;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);grid-template-columns:minmax(300px,440px) minmax(0,1fr);gap:12px}
.pk .rp-picks{grid-template-columns:minmax(280px,380px) minmax(0,1fr) 420px}
.rp-left{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto}
.rp-card{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--panel);min-width:0}
.rp-card h2{margin:0 0 10px;font:600 12.5px/1.4 var(--body);color:var(--muted)}.rp-card h2 b{color:var(--ink)}
.rp-lad ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.rp-st{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:10px;align-items:center;font:500 12px var(--mono)}
.rp-rg{color:var(--muted)}
.rp-bar{padding:4px 8px;border-radius:6px;background:var(--track);font:500 12px var(--mono)}
.rp-bar.cut{text-decoration:line-through;color:var(--muted);background:repeating-linear-gradient(135deg,var(--track) 0 6px,transparent 6px 12px)}
.rp-cn{color:var(--muted);font:400 12px var(--body)}
.rp-ceil{border-top:2px dashed var(--warn);color:var(--warn);font:600 11.5px var(--body);text-align:right;padding-top:2px}
.rp-ft{margin:8px 0 0;color:var(--muted);font:400 12.5px/1.45 var(--body)}
.rp-list{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.rp-rows{list-style:none;margin:0;padding:0;overflow-y:auto;flex:1;min-height:0}
.rp-rows li{border-top:1px solid var(--line)}.rp-rows li.on{background:var(--track);box-shadow:inset 3px 0 0 var(--ink)}
.rp-rows button{all:unset;box-sizing:border-box;display:grid;gap:6px;width:100%;padding:12px 8px 12px 12px;cursor:pointer}
.rp-l1{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.rp-l1 b{font:600 14px var(--body);overflow-wrap:anywhere}
.rp-sc{color:var(--muted);font:400 12.5px var(--body)}.rp-when{margin-left:auto;color:var(--muted);font:400 12.5px var(--body)}
.rp-l2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font:500 12px var(--mono)}
.rp-was{color:var(--muted)}
.rp-ran{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;background:var(--track)}
.rp-ran i{width:8px;height:8px;border-radius:50%}
.rp-tag{padding:2px 8px;border-radius:6px;font:600 11.5px var(--body);color:var(--warn);box-shadow:inset 0 0 0 1px var(--warn)}
.rp-tag.own{color:var(--ink);box-shadow:inset 0 0 0 1px var(--ink)}
.rp-pane{min-height:0;overflow-y:auto;padding:16px;border:1px solid var(--line);border-radius:14px;background:var(--panel);display:grid;gap:12px;align-content:start}
.rp-pane header{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font:500 12.5px var(--body)}
.rp-eb{display:inline-flex;align-items:center;gap:6px}
.rp-x{all:unset;display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border-radius:10px;color:var(--muted);cursor:pointer}
.rp-pane h2{margin:0;font:700 18px/1.3 var(--body);overflow-wrap:anywhere}
.rp-sum{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.rp-sum li{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;font:400 13px var(--body);color:var(--muted);border-top:1px solid var(--line)}.rp-sum li:first-child{border-top:0}
.rp-sum li.tot{background:var(--track);color:var(--ink);font-weight:600}.rp-sum b{color:var(--ink)}
.rp-steps{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.rp-steps li{display:flex;gap:10px;font:400 13px/1.45 var(--body)}
.rp-steps i{flex:none;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--muted);font:600 11px var(--body);font-style:normal}
.rp-steps li.last i{background:var(--ink);color:var(--panel);box-shadow:none}
.rp-steps code{font:500 12px var(--mono);padding:1px 6px;border-radius:5px;background:var(--track)}
.rp-acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:8px}
.rp-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 10px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);font:600 13px var(--body);color:var(--ink);cursor:pointer;white-space:nowrap;min-width:0}
.ar.rp-rules{flex:1;min-height:0;overflow:hidden;padding-bottom:12px}
@media (max-width:1100px){.rp-picks,.pk .rp-picks{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)}.pk .rp-picks{grid-template-columns:minmax(0,1fr) 360px}.pk .rp-left{display:none}}
@media (max-width:760px){
  .rp-picks,.pk .rp-picks{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .rp-left{overflow:visible}.rp-lad{display:none}.pk .rp-left{display:flex}
  .rp-pane{position:fixed;left:8px;right:8px;bottom:calc(68px + env(safe-area-inset-bottom));max-height:58vh;z-index:25;box-shadow:0 -8px 28px rgba(0,0,0,.35)}
}

.rr{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.rr-col{min-height:0;overflow-y:auto;display:grid;gap:12px;align-content:start}
.rr-g{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--panel);min-width:0}
.rr-g h2{margin:0 0 6px;display:flex;align-items:center;justify-content:space-between;gap:8px;font:650 14px var(--body)}
.rr-s h3{margin:10px 0 0;color:var(--muted);font:600 11.5px var(--body);text-transform:capitalize}
.rr .ar-gi{overflow:visible}
.rr .ar-row{padding:7px 0}
.rr .ar-h{display:none}
.rr .ar-row.wide .ar-h{display:block}
.ar-fix{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;box-shadow:inset 0 0 0 1px var(--lock);color:var(--lock);font:600 13px var(--body)}
.ar-step input.roll{animation:rr-roll .2s cubic-bezier(.2,.8,.2,1)}
@keyframes rr-roll{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}
.ar-save .ar-sm{overflow-wrap:anywhere}
.rr .ar-chips,.rr .ar-row.wide .ar-c{min-width:0;max-width:100%}.rr .ar-chips input{min-width:0;width:110px;max-width:100%}.rr-g,.rr-s{min-width:0;overflow-x:clip}
.rr .ar-gi,.rr .ar-sec.gen{display:block}
.rr .ar-lt{text-transform:none}
.rr .ar-sec h3{text-transform:none;letter-spacing:0;margin:10px 0 0}
.rr .ar-row{padding:3px 0;gap:10px}.rr .ar-step button,.rr .ar-step input{height:30px}.rr-g{padding:12px 14px}.rr-col{gap:10px}
.rr .ar-step input{width:48px}.rr .ar-rt th,.rr .ar-rt td{padding:3px 6px}
.rr .ar-lock{display:none}
.rr .ar-rt .ar-step button,.rr .ar-rt .ar-step input{height:28px}.rr .ar-rt .ar-step button{width:28px}.rr .ar-rt .ar-step input{width:38px}
.rr .ar-rt .sw{transform:scale(.85)}.rr .ar-rt th,.rr .ar-rt td{padding:1px 6px}
.rr .ar-band{gap:6px;padding:6px}@media (min-width:1101px){.rr .ar-band{flex-wrap:nowrap}.rr .ar-seg.sm{flex-wrap:nowrap}}.rr .ar-bl{width:auto;font-size:11px}.rr .ar-band input{width:40px;height:28px}.rr .ar-inf{width:40px}
.rr .ar-seg.sm button{min-height:26px;padding:0 5px;font-size:11px}.rr .ar-bands .ar-x{padding:0 7px}
.rr .cw-note{display:none}.rr .ar-bands{gap:5px}
.rr .ar-h{display:none!important}
.rr .ar-gi:has(.ar-sec ~ .ar-sec) .ar-sec:not(.gen) .ar-row{flex-direction:column;align-items:flex-start;gap:4px;padding:5px 0}
.rr .ar-gi:has(.ar-sec ~ .ar-sec) .ar-sec:not(.gen) .ar-seg{flex-wrap:wrap}
.rr .ar-gi:has(.ar-sec ~ .ar-sec) .ar-sec:not(.gen) .ar-seg button{min-height:26px;padding:0 8px}
@media (min-width:1101px){.ar.rp-rules{position:relative;padding-bottom:0}.ar.rp-rules .ar-save{position:absolute;left:0;right:0;bottom:0;margin:0}.ar.rp-rules.bar .rr-col{padding-bottom:78px}}
@media (max-width:1100px){.rr{grid-template-columns:minmax(0,1fr);grid-auto-rows:max-content;overflow-y:auto}.rr-col{overflow:visible}}
@media (prefers-reduced-motion:reduce){.ar-step input.roll{animation:none}.ar-bar-enter-active,.ar-bar-leave-active{transition:opacity .2s}.ar-bar-enter-from,.ar-bar-leave-to{transform:none}}
</style>
