<script setup lang="ts">
// Preview and import (mock E, SPEC-step5 section 4). The preview lists every op and file the server planned; Import opens the SSE
// stream first, then calls apply, and shows one line per op as it runs. Undo asks once inside the sheet and calls rollback.
import { computed, onUnmounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { api, url } from "../ui/api";
import { parseDiff } from "../adopt";
import { fmtSize, hasDiff, importedDirector, initLines, isStale, linesFromPlan, markRunning, opLabel, reduceLines, runSummary, visibleLines, type ImportManifest, type ImportPlan, type Line, type Progress, type Rollback } from "../importView";

type Stage = "preview" | "running" | "done" | "failed" | "rolledback";
const props = defineProps<{ plan: ImportPlan; stage?: Stage; manifest?: ImportManifest | null; error?: string | null }>();
const emit = defineEmits<{ back: []; rescan: []; next: [director: string | null]; phase: [s: Stage] }>();

const stage = ref<Stage>(props.stage ?? "preview");
const lines = ref<Line[]>(props.stage && props.stage !== "preview" ? linesFromPlan(props.plan) : initLines(props.plan));
const manifest = ref<ImportManifest | null>(props.manifest ?? null);
const err = ref(props.error ?? ""), stale = ref(isStale(props.error ?? "")), open = ref<Record<string, boolean>>({});
const asking = ref(false), undoing = ref(false), undone = ref<Rollback | null>(null), undoErr = ref("");
let es: EventSource | null = null;
onUnmounted(() => es?.close());

const diffOps = computed(() => props.plan.ops.filter(hasDiff));
const conflicts = computed(() => props.plan.ops.flatMap((o) => o.conflicts ?? []));
const total = computed(() => props.plan.files.reduce((n, f) => n + f.size, 0));
const vis = computed(() => visibleLines(lines.value));
const summary = computed(() => (manifest.value ? runSummary(manifest.value, props.plan, lines.value) : ""));
const failedOps = computed(() => lines.value.filter((l) => l.status === "failed"));
const director = computed(() => importedDirector(props.plan, lines.value));
const set = (s: Stage) => { stage.value = s; emit("phase", s); };

async function run() {
  err.value = ""; stale.value = false; set("running");
  lines.value = markRunning(initLines(props.plan), true);
  es?.close(); es = new EventSource(url("api/v1/agent-import/stream"));
  es.addEventListener("import.progress", (m) => { try { lines.value = reduceLines(lines.value, JSON.parse((m as MessageEvent).data) as Progress, props.plan.runId, stage.value === "running"); } catch { /* bad frame */ } });
  await new Promise((r) => { es!.addEventListener("open", r, { once: true }); setTimeout(r, 1500); }); // the stream first; apply does not wait forever on it
  try {
    const r = await api<{ manifest: ImportManifest; errors: string[] }>("api/v1/agent-import/apply", { method: "POST", body: { planId: props.plan.planId } });
    manifest.value = r.manifest; await settle(); set("done");
    if (r.errors.length) err.value = `${r.errors.length} ${r.errors.length === 1 ? "step" : "steps"} failed; the rest was imported.`;
  } catch (e) {
    const m = (e as Error).message; err.value = m; stale.value = isStale(m);
    await settle(); await state(); set("failed");
  } finally { es?.close(); es = null; lines.value = markRunning(lines.value, false); }
}
/** Let the last SSE frames land, then trust the run's own op states (the server saved them). */
async function settle() { await new Promise((r) => setTimeout(r, 250)); }
async function state() { try { const s = await api<{ manifest?: ImportManifest | null }>("api/v1/agent-import"); if (s.manifest) manifest.value = s.manifest; } catch { /* keep */ } }
async function undo() {
  undoing.value = true; undoErr.value = "";
  try { undone.value = await api<Rollback>("api/v1/agent-import/rollback", { method: "POST", body: { runId: props.plan.runId } }); asking.value = false; set("rolledback"); }
  catch (e) { undoErr.value = (e as Error).message; } finally { undoing.value = false; }
}
const icon = (s: Line["status"]) => (s === "done" ? "check" : s === "failed" ? "x" : s === "running" ? "loader" : "");
const canUndo = computed(() => !!manifest.value && (stage.value === "done" || stage.value === "failed"));
/** Paths inside the agentnet folder, shown from the folder down (claude/base/…, agents/…, workspace/…). */
const short = (p: string) => p.replace(/^.*?\/(claude\/base|agents|workspace)\//, "$1/");
</script>

<template>
  <div class="ir">
    <!-- preview -->
    <template v-if="stage === 'preview'">
      <p class="ir-t"><b class="num">{{ plan.ops.length }}</b> steps, <b class="num">{{ plan.files.length }}</b> files ({{ fmtSize(total) }}). Nothing is written until you press Import.</p>
      <p v-if="err" class="ir-err" role="alert">{{ err }}</p>
      <section aria-labelledby="ir-ops"><h4 id="ir-ops">Steps</h4>
        <ol class="ir-ops"><li v-for="o in plan.ops" :key="o.id"><span>{{ opLabel(o) }}</span></li></ol></section>
      <section v-if="diffOps.length" aria-labelledby="ir-df"><h4 id="ir-df">Changes to read</h4>
        <ul class="ir-files">
          <li v-for="o in diffOps" :key="o.id" class="ir-file">
            <button type="button" class="ir-row" :aria-expanded="!!open[o.id]" :aria-controls="'df-' + o.id" @click="open[o.id] = !open[o.id]">
              <span class="ir-lab">{{ opLabel(o) }}</span><Icon name="chevron-down" :size="15" class="chev" /></button>
            <Transition name="ir-fold"><pre v-if="open[o.id]" :id="'df-' + o.id" class="ir-diff" tabindex="0" :aria-label="'Diff: ' + opLabel(o)"><span v-for="(l, j) in parseDiff(o.diff ?? '')" :key="j" :class="l.t">{{ l.s || " " }}
</span></pre></Transition>
          </li>
        </ul></section>
      <section v-if="conflicts.length" aria-labelledby="ir-cf"><h4 id="ir-cf">Keys set on both sides</h4>
        <ul class="ir-cf"><li v-for="c in conflicts" :key="c"><code>{{ c }}</code><span>import wins</span></li></ul></section>
      <section aria-labelledby="ir-fl"><h4 id="ir-fl">Files</h4>
        <ul class="ir-fl"><li v-for="f in plan.files" :key="f.target"><code>{{ short(f.target) }}</code><em class="num">{{ f.size ? fmtSize(f.size) : "new" }}</em></li></ul></section>
      <p v-for="w in plan.warnings" :key="w" class="ir-warn"><Icon name="triangle-alert" :size="14" /> {{ w }}</p>
      <div class="ir-foot">
        <button type="button" class="ir-b ghost" @click="emit('back')">Back to review</button>
        <button type="button" class="ir-b" @click="run">Import {{ plan.ops.length }} steps</button>
      </div>
    </template>

    <!-- running, done, failed, rolled back -->
    <template v-else>
      <p class="ir-t" role="status" aria-live="polite">
        <template v-if="stage === 'running'">Importing and starting your staff…</template>
        <template v-else-if="stage === 'done'"><span class="ir-live" /> Import done. {{ summary }}.</template>
        <template v-else-if="stage === 'failed'">The import stopped.</template>
        <template v-else>Import undone.</template>
      </p>
      <ol v-if="stage !== 'rolledback'" class="ir-run" aria-label="Import steps">
        <TransitionGroup name="ir-ln">
          <li v-for="l in vis.shown" :key="l.id" :class="l.status">
            <i><Icon v-if="icon(l.status)" :name="(icon(l.status) as any)" :size="12" :class="{ spin: l.status === 'running' }" /></i>
            <span>{{ l.label }}<small v-if="l.error" class="ir-le">{{ l.error }}</small></span>
          </li>
        </TransitionGroup>
        <li v-if="vis.notRun" class="skipped"><i /> <span>{{ vis.notRun }} later {{ vis.notRun === 1 ? "step was" : "steps were" }} not run</span></li>
      </ol>
      <p v-if="err && stage !== 'rolledback'" class="ir-err" role="alert">{{ stale ? "Source changed since preview. Rescan to see the files as they are now." : err }}</p>

      <div v-if="undone" class="ir-undone">
        <p class="ir-t">Removed {{ undone.removed.length }} {{ undone.removed.length === 1 ? "file" : "files" }}, restored {{ undone.restored.length }}, retired {{ undone.agents.length }} {{ undone.agents.length === 1 ? "agent" : "agents" }}, archived {{ undone.teams.length }} {{ undone.teams.length === 1 ? "team" : "teams" }}.</p>
        <ul class="ir-fl"><li v-for="f in undone.removed" :key="f"><code>{{ short(f) }}</code><em>removed</em></li><li v-for="f in undone.restored" :key="f"><code>{{ short(f) }}</code><em>restored</em></li>
          <li v-for="a in undone.agents" :key="'a' + a"><code>{{ a }}</code><em>retired</em></li><li v-for="t in undone.teams" :key="'t' + t"><code>{{ t }}</code><em>archived</em></li>
          <li v-for="k in undone.kept" :key="'k' + k.file"><code>{{ short(k.file) }}</code><em>{{ k.why }}</em></li></ul>
      </div>

      <Transition name="ir-fold">
        <div v-if="asking" class="ir-ask" role="alertdialog" aria-labelledby="ir-ask-t" aria-describedby="ir-ask-d">
          <p id="ir-ask-t" class="ir-t"><b>Undo this import?</b></p>
          <p id="ir-ask-d" class="ir-t sm">It removes what this import created: copied files, the agents it started (retired) and its teams (archived). Files you edited since are kept. Your own ~/.claude is not touched.</p>
          <p v-if="undoErr" class="ir-err" role="alert">{{ undoErr }}</p>
          <div class="ir-row2"><button type="button" class="ir-b ghost" :disabled="undoing" @click="asking = false">Keep it</button><button type="button" class="ir-b bad" :disabled="undoing" @click="undo">{{ undoing ? "Undoing…" : "Undo import" }}</button></div>
        </div>
      </Transition>

      <div class="ir-foot">
        <template v-if="stage === 'running'"><small class="ir-t sm">Undo removes everything this import created.</small></template>
        <template v-else-if="stage === 'done'">
          <button type="button" class="ir-b ghost" :disabled="asking" @click="asking = true">Undo import</button>
          <button type="button" class="ir-b" @click="emit('next', director)">{{ director ? "Continue" : "Next: start the director" }}</button>
        </template>
        <template v-else-if="stage === 'failed'">
          <button v-if="canUndo" type="button" class="ir-b ghost" :disabled="asking" @click="asking = true">Undo import</button>
          <button v-if="stale || !canUndo" type="button" class="ir-b" @click="emit('rescan')">Rescan</button>
        </template>
        <template v-else>
          <button type="button" class="ir-b" @click="emit('rescan')">Scan again</button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ir{display:grid;gap:14px;min-width:0}.ir *{min-width:0}
.ir-t{margin:0;font-size:13.5px;line-height:1.45}.ir-t.sm{font-size:12.5px;color:var(--muted)}
.ir h4{margin:0 0 6px;color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ir-ops{margin:0;padding:0 0 0 22px;display:grid;gap:4px;font-size:13px}
.ir-files,.ir-fl,.ir-cf{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ir-file{border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.ir-row{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 12px;border:0;border-radius:12px;background:none;color:var(--ink);font:500 13px var(--body);text-align:left;cursor:pointer}
.ir-lab{flex:1;overflow-wrap:anywhere}
.ir-row .chev{flex:none;color:var(--muted);transition:transform .22s cubic-bezier(.2,.8,.2,1)}.ir-row[aria-expanded="true"] .chev{transform:rotate(180deg)}
.ir-diff{margin:0 8px 8px;padding:8px 0;max-height:280px;overflow:auto;border-radius:10px;background:var(--track);font:12px/1.5 var(--mono)}
.ir-diff span{display:block;padding:0 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.ir-diff .add{background:var(--on-bg);color:color-mix(in srgb,var(--on) 60%,var(--ink))}.ir-diff .del{background:var(--bad-bg);color:color-mix(in srgb,var(--bad) 60%,var(--ink))}
.ir-diff .hunk{color:var(--lock)}.ir-diff .meta{color:var(--muted)}
.ir-fl li,.ir-cf li{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.ir-fl code,.ir-cf code{flex:1;font:12px var(--mono);overflow-wrap:anywhere}
.ir-fl em,.ir-cf span{flex:none;font:500 12px var(--mono);font-style:normal;color:var(--muted)}
.ir-cf span{color:var(--warn)}
.ir-warn{display:flex;gap:6px;align-items:flex-start;margin:0;color:var(--warn);font:600 12.5px var(--body)}
.ir-err{margin:0;padding:8px 12px;border-radius:10px;background:var(--bad-bg);color:var(--bad);font:600 13px var(--body);overflow-wrap:anywhere}
.ir-run{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ir-run li{display:flex;align-items:flex-start;gap:10px;color:var(--muted);font-size:13.5px;transition:color .2s}
.ir-run li i{flex:none;display:grid;place-items:center;width:20px;height:20px;margin-top:1px;border:1.5px solid var(--line);border-radius:50%;font-style:normal;transition:background-color .2s,border-color .2s}
.ir-run li span{display:grid;gap:2px}
.ir-run li.done{color:var(--ink)}.ir-run li.done i{background:var(--on);border-color:var(--on);color:#06210f}
.ir-run li.running{color:var(--ink)}.ir-run li.running i{border-color:var(--sel);color:var(--sel)}
.ir-run li.failed{color:var(--bad)}.ir-run li.failed i{border-color:var(--bad)}
.ir-run li.skipped{font-style:italic}
.ir-le{color:var(--bad);font-size:12px;overflow-wrap:anywhere}
.ir-live{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%;background:var(--on)}
.ir-undone{display:grid;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.ir-ask{display:grid;gap:8px;padding:12px;border:1px solid color-mix(in srgb,var(--bad) 45%,var(--line));border-radius:12px;background:var(--bad-bg)}
.ir-row2{display:flex;gap:10px;flex-wrap:wrap}
.ir-foot{position:sticky;bottom:-20px;z-index:2;display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 -20px -20px;padding:12px 20px;background:var(--panel);border-top:1px solid var(--line)}
.ir-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer;white-space:nowrap}
.ir-b:disabled{opacity:.35;cursor:default}
.ir-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.ir-b.bad{background:var(--bad);color:#fff}
.ir-row:focus-visible,.ir-b:focus-visible,.ir-diff:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.spin{animation:irspin 1s linear infinite}@keyframes irspin{to{transform:rotate(360deg)}}
.ir-fold-enter-active,.ir-fold-leave-active{transition:opacity .2s cubic-bezier(.2,.8,.2,1),transform .2s cubic-bezier(.2,.8,.2,1)}
.ir-fold-enter-from,.ir-fold-leave-to{opacity:0;transform:translateY(-6px)}
.ir-ln-enter-active{transition:opacity .22s cubic-bezier(.2,.8,.2,1),transform .22s cubic-bezier(.2,.8,.2,1)}
.ir-ln-enter-from{opacity:0;transform:translateY(4px)}
@media (max-width:760px){.ir-foot{bottom:-14px;margin:0 -14px -14px;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px))}.ir-foot .ir-b:not(.ghost){flex:1}}
:global(:root[data-theme="light"] .ir-b:not(.ghost):not(.bad)){color:#fff}
:global(:root[data-theme="light"] .ir-run li.done i){color:#fff}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.ir-fold-enter-from,.ir-fold-leave-to,.ir-ln-enter-from{transform:none}.ir-row .chev{transition:none}}
</style>
