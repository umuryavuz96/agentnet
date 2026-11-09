<script setup lang="ts">
// One live agent (or the fixed root card): state dot, name, job, boss, doing, progress, tasks x/y, context %, last
// message, and the Terminal-window buttons. Reads its row straight from the reactive map, so a merge patch only
// re-renders the bindings that changed.
import { computed } from "vue";
import Icon from "../ui/Icon.vue";
import { net, windows, humanDoing, ctxView, bgVisible, bgShown, type AgentRow } from "../net";

const props = defineProps<{ row: AgentRow | null; name: string; selected?: boolean }>();
const emit = defineEmits<{ select: []; open: []; close: [] }>();

const TIP = "Opens a Terminal window on the server Mac";
const gone = computed(() => !!props.row && (props.row.life === "gone" || props.row.life === "failed"));
const dot = computed(() => {
  const r = props.row;
  if (!r) return "root";
  if (r.life === "starting") return "starting";
  if (r.life === "stopping" || gone.value) return "stopping";
  return r.state; // working | idle | waiting | blocked
});
const DOT_LABEL: Record<string, string> = { root: "root", starting: "starting", stopping: "stopping", working: "working", idle: "idle", waiting: "waiting for input", blocked: "blocked" };
const tasks = computed(() => props.row?.tasks ?? []);
const done = computed(() => tasks.value.filter((t) => t.status === "done").length);
const progress = computed(() => (typeof props.row?.progressPct === "number" ? props.row.progressPct : null)); // task-derived (server progressPct), never the self-reported %
const ctxv = computed(() => ctxView(props.row));
const ctx = computed(() => (ctxv.value ? Math.round(ctxv.value.pct) : null));
const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k");
// Background work (subagents, shells, monitors) the agent started itself; finished rows leave after BG_KEEP_MS.
const KIND: Record<string, string> = { subagent: "subagent", shell: "shell", monitor: "monitor" };
const bg = computed(() => bgVisible(props.row?.bg, net.now || Date.now()));
const dur = (b: { startedAt: number; endedAt: number | null; state: string }) => { const s = Math.max(0, Math.round(((b.state === "running" ? net.now || Date.now() : b.endedAt ?? Date.now()) - b.startedAt) / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };
const blocked = computed(() => props.row?.reported?.blockedOn ?? null);
const doingText = computed(() => (blocked.value ? "Blocked: " + blocked.value : props.row ? (humanDoing(props.row.doing) ?? DOT_LABEL[dot.value]) : "Director of every agent"));
const cost = computed(() => (props.row?.cost != null ? "$" + props.row.cost.toFixed(2) : null));
const weekly = computed(() => (props.row?.weekly ? Math.round(props.row.weekly.pct) : null));
const last = computed(() => props.row?.lastMsg ?? null);
// M8: the row carries `window: {open}` (truth = tmux clients, 1 s sweep). Absent before M8: show nothing.
const winOpen = computed(() => (props.row?.window as { open?: boolean } | undefined)?.open === true);
const btnOff =computed(() => gone.value || !windows.available || !!windows.busy);
const btnTip = computed(() => (gone.value ? "Agent is gone" : !windows.available ? `${TIP} (arrives with M8)` : TIP));
</script>

<template>
  <article class="anc" :class="['s-' + dot, { sel: selected, root: !row || row.name === 'root', setup: !row }]" role="button" tabindex="0" :aria-pressed="selected ? 'true' : 'false'"
    @click="emit('select')" @keydown.enter.prevent="emit('select')" @keydown.space.prevent="emit('select')">
    <header class="anc-h">
      <span class="dot" :title="DOT_LABEL[dot]" :aria-label="DOT_LABEL[dot]" role="img" />
      <b class="nm" :title="name">{{ row ? name : "Set up your director" }}</b>
      <span v-if="winOpen" class="chip win" title="Its Terminal window is open on the server Mac"><Icon name="square-terminal" :size="12" /> open</span>
      <span v-if="row?.model" class="chip" :class="{ nm2: winOpen }" :title="row.model">{{ row.model.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "") }}</span>
    </header>
    <p class="job" :title="row?.job ?? undefined">{{ row ? (row.job ?? "no job") : "No director connected yet" }}</p>
    <p v-if="!row" class="cta">Set up now <Icon name="arrow-up-right" :size="14" /></p>
    <p v-if="row" class="boss"><Icon name="users" :size="13" /> {{ row.boss ?? "no boss" }}</p>

    <p v-if="row" class="doing" :class="{ warn: blocked }" :title="doingText">{{ doingText }}</p>

    <TransitionGroup v-if="bg.length" tag="ul" name="bgr" class="bgl" aria-label="Background work">
      <li v-for="b in bg" :key="b.id" :class="['bgi', bgShown(b, net.now || Date.now())]" :title="`${KIND[b.kind]}: ${b.label} · ${b.state}`"><i class="bgd" /><span class="bgk">{{ KIND[b.kind] }}</span><span class="bgt">{{ b.label }}</span><span class="bgs">{{ bgShown(b, net.now || Date.now()) === "stale" ? "stale" : b.state === "running" ? dur(b) : b.state + " · " + dur(b) }}</span></li>
    </TransitionGroup>

    <div v-if="row" class="meta">
      <div class="bar" :aria-label="progress == null ? 'no tasks' : progress + '% done'" role="progressbar" :aria-valuenow="progress ?? undefined" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ transform: `scaleX(${(progress ?? 0) / 100})` }" />
      </div>
      <span class="n" title="tasks done / total">{{ done }}/{{ tasks.length }}</span>
      <span class="n" :title="ctxv ? `${tok(ctxv.tokens)} of ${tok(ctxv.window)}${ctxv.compact ? ` (auto-compact window; model window ${tok(ctxv.model)})` : ''}` : 'context window used'">{{ ctx == null ? "–" : ctx + "%" }} ctx</span>
      <span v-if="cost" class="n" title="cost of this session">{{ cost }}</span>
      <span v-if="weekly !== null" class="n" title="share of the weekly limit">{{ weekly }}% wk</span>
    </div>
    <p v-if="last" class="last" :title="`${last.dir === 'out' ? 'to' : 'from'} ${last.peer}: ${last.snippet}`"><Icon :name="last.dir === 'out' ? 'send' : 'message'" :size="13" /> <span>{{ last.dir === "out" ? "to" : "from" }} {{ last.peer }}: {{ last.snippet }}</span></p>
    <p v-else-if="row" class="last none">No messages yet</p>

    <footer v-if="row" class="acts" @click.stop @keydown.stop>
      <button type="button" class="btn sm" :disabled="btnOff" :title="btnTip" :aria-label="`Open ${name} in Terminal`" @click="emit('open')"><Icon name="square-terminal" :size="15" /> Open</button>
      <button type="button" class="btn sm ghost" :disabled="btnOff" :title="gone ? 'Agent is gone' : 'Closes its Terminal window; the agent keeps running'" :aria-label="`Close ${name} window`" @click="emit('close')"><Icon name="x" :size="15" /> Close</button>
    </footer>
  </article>
</template>

<style scoped>
.bgl{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:3px}
.bgi{display:flex;align-items:center;gap:6px;font-size:11.5px;min-width:0;color:var(--muted,#8a8f98)}
.bgd{width:7px;height:7px;border-radius:50%;flex:none;background:var(--off,#777)}
.bgi.running .bgd{background:var(--on,#3c9);animation:bgp 1.6s ease-in-out infinite}
.bgi.stale{opacity:.5} .bgi.done .bgd{background:var(--on,#3c9)} .bgi.failed .bgd{background:var(--bad,#e55)}
.bgk{flex:none;text-transform:uppercase;font-size:10px;letter-spacing:.04em;opacity:.8}
.bgt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bgs{flex:none;font-variant-numeric:tabular-nums}
.bgr-enter-active,.bgr-leave-active{transition:opacity .35s,transform .35s}
.bgr-enter-from,.bgr-leave-to{opacity:0;transform:translateY(-4px)}
@keyframes bgp{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.bgi.running .bgd{animation:none}.bgr-enter-active,.bgr-leave-active{transition:none}}
.anc{display:flex;flex-direction:column;gap:6px;min-width:0;height:100%;padding:14px 14px 12px;border:1px solid var(--line);border-radius:16px;background:var(--panel);cursor:pointer;
  transition:border-color .2s var(--ease),transform .2s var(--ease),background-color .2s var(--ease)}
.anc:hover{border-color:color-mix(in srgb,var(--ink) 25%,var(--line))}
.anc:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.anc.sel{border-color:#4c7dff;box-shadow:0 0 0 1px #4c7dff;background:color-mix(in srgb,#4c7dff 7%,var(--panel))}
.anc.root{background:linear-gradient(180deg,color-mix(in srgb,var(--lock) 10%,var(--panel)),var(--panel))}
.anc-h{display:flex;align-items:center;gap:8px;min-width:0}
.nm{font:650 15px/1.2 var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{margin-left:auto;padding:2px 7px;border-radius:999px;background:var(--track);color:var(--muted);font:500 11px/1.4 var(--mono)}
.chip.win{display:inline-flex;align-items:center;gap:4px;background:var(--on-bg);color:var(--on)}
.chip.nm2{margin-left:0}
.dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--off)}
.s-working .dot{background:var(--on);box-shadow:0 0 0 0 var(--on);animation:pulse 1.6s var(--ease) infinite}
.s-waiting .dot{background:var(--warn)}
.s-blocked .dot{background:var(--bad)}
.s-starting .dot{background:transparent;border:2px dashed var(--muted)}
.s-starting{border-style:dashed}
.anc.setup{border-style:dashed;border-color:color-mix(in srgb,var(--on) 55%,var(--line));background:color-mix(in srgb,var(--on) 6%,var(--panel))}
.anc.setup .dot{background:transparent;border:2px dashed var(--on)}
.cta{margin:auto 0 0;display:inline-flex;align-items:center;gap:6px;justify-self:start;align-self:flex-start;min-height:36px;padding:0 14px;border-radius:12px;background:var(--on);color:#06210f;font:600 13px/36px var(--body)}
.s-stopping{opacity:.6}
.s-root .dot{background:var(--lock)}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--on) 55%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.job,.boss,.doing,.last{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.job{color:var(--muted);font:500 12.5px/1.3 var(--body)}
.boss{display:flex;align-items:center;gap:5px;color:var(--muted);font:500 12px/1.3 var(--body)}
.doing{font:500 13.5px/1.35 var(--body);white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:2.7em}
.doing.warn{color:var(--warn)}
.meta{display:flex;align-items:center;gap:10px}
.bar{flex:1;height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.bar i{display:block;height:100%;background:var(--on);transform-origin:left;transition:transform .4s var(--ease)}
.n{color:var(--muted);font:500 12px/1 var(--mono);white-space:nowrap}
.last{display:flex;align-items:center;gap:5px;color:var(--muted);font:500 12px/1.3 var(--body)}
.last span{overflow:hidden;text-overflow:ellipsis}
.last.none{opacity:.7}
.acts{display:flex;gap:6px;margin-top:auto;padding-top:4px}
.acts .btn{display:inline-flex;align-items:center;gap:5px;min-height:34px}
.btn.ghost{background:transparent}
@media (prefers-reduced-motion:reduce){.s-working .dot{animation:none}.anc,.bar i{transition:none}}
</style>
