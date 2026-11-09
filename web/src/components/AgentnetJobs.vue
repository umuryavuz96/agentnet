<script setup lang="ts">
// Two parts of the agent panel. mode "tasks": the agent's task checklist (inside Overview). mode "jobs": a fixed collapsible
// panel under the tab control, visible on every tab, listing the background jobs it started with bgjob.sh (status, progress,
// runtime, log tail). Jobs poll /bgjobs every 3 s while mounted and the page is visible. Open state is kept per browser;
// until the user toggles it, it is open while a job runs and folded otherwise.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, jobFocus, type Task } from "../net";
import { api } from "../ui/api";

interface Prog { done: number; total: number | null; label: string | null }
interface Job { id: string; owner: string | null; desc: string; status: "running" | "done" | "failed" | "stopped"; exit: number | null; started: number; runtimeMs: number; progress: Prog | null; outputCount: number; log?: string[] }

const props = defineProps<{ name: string; tasks: Task[]; mode: "tasks" | "jobs" }>();
const jobs = ref<Job[]>([]), detail = ref<Record<string, Job>>({}), open = ref<string | null>(null), loaded = ref(false), err = ref("");
const known = (o: string | null) => !!o && Object.values(net.agents).some((a) => a.name === o);
// root also lists jobs whose owner is gone: the map hangs those under root with a "retired owner" tag
const mine = computed(() => jobs.value.filter((j) => j.owner === props.name || (props.name === "root" && !known(j.owner))).sort((a, b) => b.started - a.started));
const runningJobs = computed(() => mine.value.filter((j) => j.status === "running"));
const finishedJobs = computed(() => mine.value.filter((j) => j.status !== "running"));
const running = computed(() => runningJobs.value.length);
const showFin = ref(false);
type Row = Job | { id: "__sep" };
const ordered = computed<Row[]>(() => [...runningJobs.value, ...(finishedJobs.value.length ? [{ id: "__sep" as const }] : []), ...(showFin.value ? finishedJobs.value : [])]);
const isSep = (r: Row): r is { id: "__sep" } => r.id === "__sep";
const KEY = "agentnet.jobsOpen";
const saved = ref<boolean | null>((() => { try { const v = localStorage.getItem(KEY); return v === null ? null : v === "1"; } catch { return null; } })());
const panelOpen = computed(() => saved.value ?? running.value > 0);
const togglePanel = () => { const v = !panelOpen.value; saved.value = v; try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* per-viewer convenience only */ } };
const done = computed(() => props.tasks.filter((t) => t.status === "done").length);
const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const pct = (p: Prog | null) => (p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : null);
const runtime = (j: Job) => dur(j.status === "running" ? net.now - j.started : j.runtimeMs);

let timer: ReturnType<typeof setInterval> | null = null, busy = false;
async function tick() {
  if (busy || document.hidden) return; busy = true;
  try {
    jobs.value = await api<Job[]>("v1/panel/bgjobs"); err.value = ""; loaded.value = true;
    if (open.value && mine.value.some((j) => j.id === open.value)) detail.value = { ...detail.value, [open.value]: await api<Job>(`v1/panel/bgjobs/${encodeURIComponent(open.value)}`) };
  } catch (e) { err.value = (e as Error).message; loaded.value = true; } finally { busy = false; }
}
onMounted(() => { if (props.mode !== "jobs") return; void tick(); timer = setInterval(tick, 3000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
const toggle = (id: string) => { focusId.value = ""; open.value = open.value === id ? null : id; void tick(); };
// A job tapped on the map: open this fold, expand the job and highlight it.
const focusId = ref("");
function applyFocus() {
  if (props.mode !== "jobs" || !jobFocus.id || Date.now() - jobFocus.at > 5000) return;
  const j = mine.value.find((x) => x.id === jobFocus.id); if (!j) return;
  saved.value = true; if (j.status !== "running") showFin.value = true;
  focusId.value = j.id; open.value = j.id; void tick();
  nextTick(() => setTimeout(() => document.querySelector(`[data-job="${CSS.escape(j.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 320));
}
watch(() => jobFocus.n, applyFocus); watch(loaded, applyFocus);
</script>

<template>
  <div v-if="mode === 'tasks'" class="aj">
    <section aria-label="Tasks">
      <h3>Tasks <span class="num">{{ done }}/{{ tasks.length }}</span></h3>
      <div v-if="tasks.length" class="bar thin" aria-hidden="true"><i :style="{ width: (done / tasks.length) * 100 + '%' }" /></div>
      <ul v-if="tasks.length" class="tasks">
        <li v-for="t in tasks" :key="t.id" :class="t.status">
          <Icon :name="t.status === 'done' ? 'circle-check' : t.status === 'in_progress' ? 'loader' : 'square'" :size="16" :class="{ spin: t.status === 'in_progress' }" />
          <span>{{ t.text }}</span>
        </li>
      </ul>
      <p v-else class="none">No tasks yet.</p>
    </section>

  </div>
  <section v-else class="jp" aria-label="Background jobs">
    <button type="button" class="jph" :aria-expanded="panelOpen" aria-controls="ap-jobs" @click="togglePanel">
      <span class="jt">Background jobs</span>
      <span v-if="mine.length" class="num cnt">{{ mine.length }}</span>
      <span v-if="running" class="rn">· <i class="jdot running" aria-hidden="true" />{{ running }} running</span>
      <Icon name="chevron-down" :size="16" class="cv" />
    </button>
    <div id="ap-jobs" class="jpb" :class="{ 'is-open': panelOpen }" :inert="!panelOpen || undefined">
      <div>
        <div class="jpi">
      <p v-if="err" class="none bad">{{ err }}</p>
      <p v-else-if="loaded && !mine.length" class="none">No background jobs from {{ name }}.</p>
      <p v-else-if="loaded && !running && finishedJobs.length && !showFin" class="none">No running jobs.</p>
      <ul v-if="ordered.length" class="jobs">
        <template v-for="j in ordered" :key="j.id">
        <li v-if="isSep(j)" class="fin"><button type="button" class="fin-b" :aria-expanded="showFin" @click="showFin = !showFin">{{ showFin ? "Hide" : "Show" }} {{ finishedJobs.length }} finished<Icon name="chevron-down" :size="14" class="cv" /></button></li>
        <li v-else :class="['job', j.status, { focus: focusId === j.id }]" :data-job="j.id">
          <button type="button" class="jh" :aria-expanded="open === j.id" @click="toggle(j.id)">
            <i :class="['jdot', j.status]" :aria-label="j.status" role="img" />
            <span class="jd" :title="j.desc">{{ j.desc }}</span>
            <time class="num">{{ runtime(j) }}</time>
            <Icon name="chevron-down" :size="16" class="cv" />
          </button>
          <div v-if="pct(j.progress) != null" class="pbar"><div class="bar" role="progressbar" :aria-valuenow="pct(j.progress)!" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: pct(j.progress) + '%' }" /></div><span class="num">{{ pct(j.progress) }}%</span></div>
          <div class="jb" :class="{ 'is-open': open === j.id }" :inert="open !== j.id || undefined">
            <div>
              <p class="sm">{{ j.status }}<template v-if="j.exit != null"> · exit {{ j.exit }}</template><template v-if="j.progress?.label"> · {{ j.progress.label }}</template><template v-if="j.outputCount"> · {{ j.outputCount }} {{ j.outputCount === 1 ? "output" : "outputs" }}</template></p>
              <pre v-if="detail[j.id]?.log?.length" class="log">{{ detail[j.id].log!.slice(-8).join("\n") }}</pre>
              <p v-else-if="open === j.id" class="none">No log lines yet.</p>
            </div>
          </div>
        </li>
        </template>
      </ul>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.aj{display:grid;gap:18px;min-width:0}
.aj *,.jp *{min-width:0}
h3{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.num{font-variant-numeric:tabular-nums}
h3 .num{letter-spacing:0;color:var(--ink);opacity:.8}
.none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.sm{margin:0;color:var(--muted);font-size:12px;line-height:1.35;overflow-wrap:anywhere}
.bad{color:var(--bad)}
.bar{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px;background:var(--on);transition:width .4s var(--ease)}
.bar.thin{height:4px;margin:-2px 0 8px}
.tasks{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.tasks li{display:flex;gap:9px;align-items:flex-start;padding:6px 8px;margin:0 -8px;border-radius:9px;font-size:13.5px;line-height:1.4;overflow-wrap:anywhere}
.tasks li .icon{flex:none;margin-top:1px;color:var(--muted)}
.tasks li.in_progress{background:color-mix(in srgb,var(--on) 8%,transparent);font-weight:600}
.tasks li.in_progress .icon{color:var(--on)}
.tasks li.done{color:var(--muted)}
.tasks li.done span{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 50%,transparent)}
.tasks li.done .icon{color:var(--on)}
/* fixed panel under the tab control: header never scrolls, the list scrolls inside its own max-height */
.jp{flex:none;border-bottom:1px solid var(--line);padding:0 16px}
.jph{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--muted);cursor:pointer;text-align:left;font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.jph:focus-visible{outline:2px solid var(--on);outline-offset:1px;border-radius:8px}
.jt{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cnt{flex:none;letter-spacing:0;color:var(--ink);opacity:.8}
.rn{flex:1;display:flex;align-items:center;gap:6px;overflow:visible;white-space:nowrap;text-transform:none;letter-spacing:0;font-weight:500;color:var(--on)}
.rn .jdot{margin:0 4px 0 2px}
.jph > .cv{margin-left:auto}
.jph[aria-expanded="true"] > .cv{transform:rotate(180deg)}
.jpb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.jpb.is-open{grid-template-rows:1fr;opacity:1}
.jpb > div{overflow:hidden}
.jpi{max-height:240px;overflow-y:auto;overscroll-behavior:contain;padding-bottom:12px}
@media (max-width:700px){.jpi{max-height:134px}}
.fin-b{display:flex;align-items:center;gap:6px;width:100%;min-height:36px;padding:0 4px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:600 12px/1 var(--body)}
.fin-b:focus-visible{outline:2px solid var(--on);outline-offset:1px;border-radius:8px}
.fin-b .cv{margin-left:auto}
.fin-b[aria-expanded="true"] .cv{transform:rotate(180deg)}
.jobs{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.job{border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 3%,transparent);padding:0 12px}
.jh{display:flex;align-items:center;gap:9px;width:100%;min-height:44px;padding:0;border:0;background:transparent;color:var(--ink);cursor:pointer;text-align:left;font:600 13.5px/1.3 var(--body)}
.job.focus{border-color:color-mix(in srgb,var(--on) 55%,var(--line));background:color-mix(in srgb,var(--on) 8%,transparent)}
.jh:focus-visible{outline:2px solid var(--on);outline-offset:2px;border-radius:8px}
.jdot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--off)}
.jdot.running{background:var(--on);animation:pulse 1.6s var(--ease) infinite}
.jdot.done{background:var(--on)}
.jdot.failed{background:var(--bad)}
.jd{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.jh time{flex:none;color:var(--muted);font:500 11.5px/1 var(--mono)}
.cv{flex:none;color:var(--muted);transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.jh[aria-expanded="true"] .cv{transform:rotate(180deg)}
.pbar{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.pbar .bar{flex:1}
.pbar .num{flex:none;font-size:12px;color:var(--muted)}
.jb{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
.jb.is-open{grid-template-rows:1fr;opacity:1}
.jb > div{overflow:hidden;display:grid;gap:8px;transition:padding .3s cubic-bezier(.2,.8,.2,1)}
.jb.is-open > div{padding-bottom:12px}
.log{margin:0;padding:8px 10px;border-radius:10px;background:var(--track);font:11.5px/1.45 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow-y:auto}
.spin{animation:ajspin 1.1s linear infinite}
@keyframes ajspin{to{transform:rotate(360deg)}}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
@media (prefers-reduced-motion:reduce){.spin,.jdot.running{animation:none}.cv,.jb,.jb > div,.jpb,.bar i{transition:none}}
</style>
