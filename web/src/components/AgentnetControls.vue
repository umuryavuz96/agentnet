<script setup lang="ts">
// Two parts of the agent panel. mode "schedules": what the agent has scheduled (session crons, monitors, external cron jobs
// linked to it) with a live countdown and Run now. mode "actions": Stop (interrupt the current turn) and Close (despawn, with an
// inline two-step confirm; never a browser confirm()). Every action tells the agent's boss, server side.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net } from "../net";
import { api, toast } from "../ui/api";

interface Sched { id: string; kind: "session-cron" | "monitor" | "cron-job"; label: string; cron?: string; nextRunAt?: number; startedAt?: number; source: string; canRun: boolean; running?: boolean; lastRun?: { at: number; ok: boolean; ms: number } }
const props = defineProps<{ name: string; mode: "schedules" | "actions"; canAct?: boolean }>();
const emit = defineEmits<{ closed: [] }>();

const dur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`; };
const live = (s: Sched) => s.kind === "monitor" || !!s.running;
const when = (s: Sched) => live(s) ? (s.startedAt ? `running ${dur(net.now - s.startedAt)}` : "running") : s.nextRunAt ? (s.nextRunAt - net.now < 1000 ? "due now" : `in ${dur(s.nextRunAt - net.now)}`) : "no schedule";
const KIND: Record<Sched["kind"], string> = { "session-cron": "Session job", monitor: "Monitor", "cron-job": "Cron job" };

// ---- schedules ----
const list = ref<Sched[]>([]), loaded = ref(false), err = ref(""), busyId = ref("");
let timer: ReturnType<typeof setTimeout> | null = null, inflight = false;
async function load() {
  if (inflight || document.hidden || props.mode !== "schedules") return; inflight = true;
  const n = props.name;
  try { const r = await api<{ schedules: Sched[] }>(`v1/panel/agents/${encodeURIComponent(n)}/schedules`); if (n === props.name) { list.value = r.schedules; err.value = ""; } }
  catch (e) { if (n === props.name) err.value = (e as Error).message; }
  finally { loaded.value = true; inflight = false; }
}
/** Poll every 10 s, every 2 s while a Run now is in flight so "running" and the result show up at once. */
const tick = () => { if (timer) clearTimeout(timer); timer = setTimeout(async () => { await load(); tick(); }, list.value.some((x) => x.running) ? 2000 : 10_000); };
onMounted(() => { void load().then(tick); });
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
watch(() => props.name, () => { list.value = []; loaded.value = false; confirming.value = false; void load(); });
async function runNow(s: Sched) {
  if (busyId.value) return; busyId.value = s.id;
  try { await api(`v1/panel/agents/${encodeURIComponent(props.name)}/run-schedule`, { body: { id: s.id } }); toast(s.kind === "session-cron" ? `Sent to ${props.name}` : `Started ${s.label}`); await load(); tick(); }
  catch (e) { toast(`Run now failed: ${(e as Error).message}`); }
  finally { busyId.value = ""; }
}

// ---- stop / close ----
const acting = ref<"" | "stop" | "close">(""), confirming = ref(false), cancelBtn = ref<HTMLButtonElement | null>(null), closeBtn = ref<HTMLButtonElement | null>(null);
async function stop() {
  if (acting.value) return; acting.value = "stop";
  try { await api(`v1/panel/agents/${encodeURIComponent(props.name)}/stop`, { method: "POST" }); toast(`Interrupted ${props.name}`); }
  catch (e) { toast(`Stop failed: ${(e as Error).message}`); }
  finally { acting.value = ""; }
}
const ask = () => { confirming.value = true; nextTick(() => cancelBtn.value?.focus()); };
const cancel = () => { confirming.value = false; nextTick(() => closeBtn.value?.focus()); };
async function close() {
  if (acting.value) return; acting.value = "close";
  try { await api(`v1/panel/agents/${encodeURIComponent(props.name)}/despawn`, { method: "POST" }); toast(`Closed ${props.name}`); confirming.value = false; emit("closed"); }
  catch (e) { toast(`Close failed: ${(e as Error).message}`); }
  finally { acting.value = ""; }
}
const rows = computed(() => list.value);
</script>

<template>
  <section v-if="mode === 'schedules'" class="sch" aria-label="Schedules">
    <h3><span>Schedules</span><span v-if="rows.length" class="n">{{ rows.length }}</span></h3>
    <ul v-if="rows.length" class="sl">
      <li v-for="s in rows" :key="s.id">
        <div class="tx">
          <b :title="s.label">{{ s.label }}</b>
          <span class="sub"><span class="kd">{{ KIND[s.kind] }}</span><span v-if="s.cron" class="mono" :title="'cron ' + s.cron">{{ s.cron }}</span><span v-if="s.lastRun && !s.running" :class="['lr', { bad: !s.lastRun.ok }]">last run {{ dur(net.now - s.lastRun.at) }} ago · {{ s.lastRun.ok ? "ok" : "failed" }} · {{ dur(s.lastRun.ms) }}</span></span>
        </div>
        <time :class="['when', { run: live(s) }]">{{ when(s) }}</time>
        <button v-if="s.canRun" type="button" class="btn sm ghost" :disabled="!!busyId || s.running" :aria-label="`Run ${s.label} now`" @click="runNow(s)">
          <Icon v-if="busyId === s.id || s.running" name="loader" :size="14" class="spin" />{{ s.running ? "Running" : "Run now" }}
        </button>
      </li>
    </ul>
    <p v-else-if="loaded && !err" class="none">No scheduled jobs.</p>
    <p v-else-if="err" class="none">Schedules unavailable: {{ err }}</p>
  </section>

  <div v-else-if="canAct" class="ctl-wrap">
    <div class="ctl">
      <button type="button" class="btn sm ghost" :disabled="!!acting || confirming" title="Interrupt the current turn; the agent stays alive" @click="stop"><Icon :name="acting === 'stop' ? 'loader' : 'square'" :size="14" :class="{ spin: acting === 'stop' }" /> Stop</button>
      <button ref="closeBtn" type="button" class="btn sm danger-ghost" :disabled="!!acting || confirming" :aria-expanded="confirming" @click="ask"><Icon name="x" :size="15" /> Close agent</button>
    </div>
    <Transition name="cf">
      <div v-if="confirming" class="cf" role="alertdialog" :aria-label="`Close ${name}?`" @keydown.esc.stop="cancel">
        <div class="cf-clip"><div class="cf-in">
          <span class="cf-ic"><Icon name="triangle-alert" :size="18" /></span>
          <div class="cf-tx">
            <b>Close {{ name }}?</b>
            <p>Its session ends and it is despawned. Unsaved work in its window is lost. Its boss gets an admin message.</p>
          </div>
          <div class="cf-act">
            <button ref="cancelBtn" type="button" class="btn sm ghost" :disabled="!!acting" @click="cancel">Cancel</button>
            <button type="button" class="btn sm solid-danger" :disabled="!!acting" @click="close"><Icon :name="acting === 'close' ? 'loader' : 'x'" :size="14" :class="{ spin: acting === 'close' }" />Close agent</button>
          </div>
        </div></div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sch h3{display:flex;align-items:baseline;gap:6px;margin:0 0 8px;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.sch h3 .n{letter-spacing:0;color:var(--ink);opacity:.8;font-variant-numeric:tabular-nums}
.sl{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.sl li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px 10px;padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.tx{display:grid;gap:2px;min-width:0}
.tx b{font:600 13px/1.3 var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{display:flex;gap:8px;min-width:0;color:var(--muted);font-size:11.5px;line-height:1.3}
.sub .mono{font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kd{flex:none}
.lr{flex:none;color:var(--muted)}.lr.bad{color:var(--bad)}
.when{font:600 12.5px/1.2 var(--body);font-variant-numeric:tabular-nums;color:var(--ink);white-space:nowrap}
.when.run{color:var(--on)}
.sl .btn{display:inline-flex;align-items:center;gap:5px;min-height:36px;padding-inline:10px}
.none{margin:0;color:var(--muted);font-size:13px;line-height:1.4}
.ctl-wrap{display:grid;gap:8px}
.ctl{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-left:-8px}
.ctl .btn{display:inline-flex;align-items:center;gap:5px;min-height:36px;padding-inline:8px}
.cf{display:grid;grid-template-rows:1fr;overflow:hidden}
.cf-clip{min-height:0;overflow:hidden}
.cf-in{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;padding:14px;border:1px solid color-mix(in srgb,var(--bad) 40%,transparent);border-radius:14px;background:color-mix(in srgb,var(--bad) 9%,var(--panel))}
.cf-ic{grid-row:1 / 3;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:var(--bad);background:color-mix(in srgb,var(--bad) 16%,transparent)}
.cf-tx{display:grid;gap:4px;min-width:0}
.cf-tx b{font:600 14.5px/1.3 var(--body);color:var(--ink);overflow-wrap:anywhere}
.cf-tx p{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.cf-act{grid-column:2;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:8px}
.cf-act .btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding-inline:14px}
.btn.solid-danger{color:#fff;background:var(--bad);border-color:var(--bad)}
.btn.solid-danger:hover:not(:disabled){filter:brightness(1.08)}
.cf-enter-active,.cf-leave-active{transition:grid-template-rows .26s var(--ease,cubic-bezier(.2,.8,.2,1)),opacity .2s}
.cf-enter-from,.cf-leave-to{grid-template-rows:0fr;opacity:0}
.spin{animation:spin 1.1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:420px){.sl li{grid-template-columns:minmax(0,1fr) auto}.sl li .btn{grid-column:1 / -1;justify-self:start}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.cf-enter-active,.cf-leave-active{transition:opacity .15s}}
</style>
