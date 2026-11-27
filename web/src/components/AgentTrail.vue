<script setup lang="ts">
// Agent trail, sizes 2 and 3 (map board 10-agent-trail, step() / under() / full()): a fiber rail through the steps, lit up to
// the current one. Full (panel): every step; under the current one the rail branches out in an S-curve through the last
// call, the running call and the background jobs, and joins again before the next step; a question to the owner sits on
// the step. peek: the step before, the current one and the next ones (at most 5 rows), no branch, no motion.
// Motion (full only) is the board's: trailMotion.ts moves what this template drew, the keyframes are at the end of the style.
// Not drawn because no data records it yet: sub-steps with file:line and +/- counts, a gate planned ahead ("Approval").
// An agent with a planned job (plan.ts): every step carries its number ("2.4"), a done step its proof, a step added after
// the plan sits under an "added later" line with where it came from, a dropped step stays, struck through, with the reason.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, pendingChecks, answerCheck, bgVisible, type AgentRow, type EvidenceKind } from "../net";
import { phrase } from "../trail";
import { trailView, dur, short, type TStep } from "../trailView";
import { openAsks, proofs, stepLook, stepNo, stepTime } from "../plan";
import type { IconName } from "../ui/icons";
import { snap, settle, runHead, rowsIn, replay, trailChange, type TrailSig } from "../trailMotion";
const props = defineProps<{ row: AgentRow; peek?: boolean }>();
const emit = defineEmits<{ msg: [id: number] }>();
const check = computed(() => pendingChecks.value.find((c) => c.agent === props.row.name) ?? null);
const v = computed(() => trailView(props.row, check.value));
const tasks = computed(() => v.value.steps);
/** The planned job these rows belong to; null on the plain list (no job, or a job run with the old task tools). */
const job = computed(() => (v.value.plan ? v.value.job : null));
const EV: Record<Exclude<EvidenceKind, "none">, IconName> = { commit: "git-commit-horizontal", file: "file-text", check: "circle-check", shot: "image", msg: "message-circle" };
const c = computed(() => (v.value.cur < 0 ? v.value.n - 1 : v.value.cur));
const from = computed(() => (props.peek ? Math.max(0, c.value - 1) : 0));
const to = computed(() => (props.peek ? Math.min(v.value.n, from.value + 4) : v.value.n));
const isCur = (i: number) => i === v.value.cur && v.value.mode !== "idle";
const kind = (t: TStep, i: number) => (t.status === "done" ? "tr-done done" : t.status === "dropped" ? (t.step && stepLook(t.step) === "unfinished" ? "tr-drop tr-unf" : "tr-drop") : isCur(i) ? "tr-cur" : "tr-pend");
const tint = (i: number) => (i !== v.value.cur ? "" : v.value.mode === "gate" || v.value.mode === "reply" ? "gate-c" : v.value.mode === "block" ? "block-c" : v.value.mode === "closed" ? "idle-c" : "");
const ms = (n: number | null | undefined) => (n == null ? "" : n < 1000 ? ` · ${n} ms` : ` · ${(n / 1000).toFixed(1)} s`);
const BGK: Record<string, string> = { subagent: "Subagent", shell: "Shell", monitor: "Monitor" };
const FILE_TOOL = /^(Read|Edit|Write|Grep|Glob)$/; // only a file target is shown under the running call; a raw command never is

// the branch under the current step, in time order: last call, running call, side jobs. The branch is lit up to the running call.
interface Row { key: string; cls: string; kind: "last" | "live" | "bg"; text: string; strong?: string; ok?: boolean; target?: string; meta: string; live?: number }
const branch = computed<Row[]>(() => {
  const a = props.row, m = v.value.mode, rows: Row[] = [];
  if (props.peek || v.value.cur < 0 || !isCur(v.value.cur)) return rows;
  if (a.lastTool && m !== "gate") rows.push({ key: "last:" + a.lastTool.at, kind: "last", cls: "", text: `Last: ${phrase(a.lastTool)} `, ok: a.lastTool.ok, meta: short(net.now - a.lastTool.at) + " ago", strong: ms(a.lastTool.ms) });
  if (m === "work" && a.action) rows.push({ key: "act:" + a.action.at, kind: "live", cls: "live", text: "", strong: phrase(a.action), target: FILE_TOOL.test(a.action.tool) ? a.action.target ?? "" : "", meta: "", live: a.action.at });
  for (const b of bgVisible(a.bg, net.now))
    rows.push({ key: "bg:" + b.id, kind: "bg", cls: b.state === "running" ? "run" : b.state === "failed" ? "bad" : "", text: ` · ${b.label}`, strong: BGK[b.kind] ?? b.kind, meta: b.state === "running" ? "" : b.state, live: b.state === "running" ? b.startedAt : undefined });
  return rows;
});
const liveAt = computed(() => branch.value.findIndex((r) => r.kind === "live"));
const branched = computed(() => branch.value.length > 0);
/** What a closed agent left open: the step it was in, and the ones it never started. */
const left = computed(() => { const st = v.value.job?.steps ?? [], inWork = st.filter((x) => stepLook(x) === "unfinished").length; return { inWork, notStarted: st.filter((x) => x.unfinished).length - inWork }; });
const asksOpen = computed(() => openAsks(props.row).length);
const firstAdded = computed(() => (job.value && !props.peek ? tasks.value.findIndex((t) => t.step?.added) : -1));
const steps = computed(() => tasks.value.slice(from.value, to.value).map((t, k) => {
  const i = from.value + k, j = job.value, s = j ? t.step : undefined;
  return { t, i, s, no: j && s ? stepNo(j, s) : "", time: j && s ? stepTime(j, s) : null, proofs: j && s && !props.peek ? proofs(j, s) : [],
    why: !s || s.status !== "dropped" || props.peek ? "" : stepLook(s) === "unfinished" ? `Unfinished · ${(s.reason ?? "closed").replace(/: unfinished$/, "")}` : `Dropped · ${s.reason || "no reason given"}` };
}));

// ---- motion: what changed in the live row decides what plays (the board's play(), fed by the stream) ----
const root = ref<HTMLElement | null>(null);
const just = ref(-1), enter = ref(-1), arrive = ref(false), lead = ref(false);
let clear: ReturnType<typeof setTimeout> | undefined;
// everything a change can be read from, as one string: the clock (net.now) is not in it, so a timer tick plays nothing
const sig = computed(() => JSON.stringify({ name: props.row.name, done: tasks.value.flatMap((t, i) => (t.status === "done" ? [i] : [])), cur: isCur(v.value.cur) ? v.value.cur : -1, check: check.value?.id ?? 0, rows: branch.value.map((r) => r.key) }));
watch(sig, async (nw, old) => {
  if (props.peek) return;
  const n = JSON.parse(nw) as TrailSig, o = JSON.parse(old) as TrailSig, { how, from: a, to: b } = trailChange(o, n);
  if (how === "agent") { clearTimeout(clear); just.value = enter.value = -1; arrive.value = lead.value = false; await nextTick(); replay(root.value); return; } // another agent in the open panel: its trail draws itself
  const was = snap(root.value); // before the DOM changes: where every step sits
  // the classes belong to this change only (the board draws fresh markup per change): a class left from the last change
  // would put its delays on a row that arrives now
  just.value = how === "complete" ? a : -1;
  enter.value = how === "complete" || how === "start" ? b : -1; lead.value = how === "start";
  arrive.value = how === "gate";
  clearTimeout(clear); clear = setTimeout(() => { just.value = enter.value = -1; arrive.value = lead.value = false; }, 1600);
  await nextTick();
  settle(root.value, was, how === "complete" ? 60 : 0);
  if (a >= 0 && b >= 0) runHead(root.value, a, b);
  if (how === "tick" || how === "gate" || how === "answer") rowsIn(Array.from(root.value?.querySelectorAll<HTMLElement>(".tr-row") ?? []).filter((r) => !o.rows.includes(r.dataset.k ?? "")));
}, { flush: "pre" });
onMounted(() => { if (!props.peek) replay(root.value); }); // the trail draws itself when it opens
onBeforeUnmount(() => clearTimeout(clear));

const answering = ref(""), err = ref("");
async function answer(label: string) {
  if (!check.value || answering.value) return;
  answering.value = label; err.value = await answerCheck(check.value.id, label, ""); answering.value = "";
}
</script>

<template>
  <div ref="root" class="trw" :style="lead ? { '--lead': '300ms' } : undefined">
    <template v-if="!peek">
      <div v-if="v.mode === 'block'" class="tr-ban block"><Icon name="triangle-alert" :size="18" /><span><b>Blocked</b> on {{ row.reported?.blockedOn ?? "something" }}<small v-if="row.reported">reported {{ short(net.now - row.reported.at) }} ago</small></span></div>
      <div v-else-if="v.mode === 'reply' && row.lastMsg" class="tr-ban reply"><Icon name="message-circle" :size="18" /><span><b>Waiting for {{ row.lastMsg.peer }}</b> to reply<small>asked {{ short(net.now - row.lastMsg.at) }} ago: {{ row.lastMsg.snippet }}</small></span></div>
      <div v-else-if="v.mode === 'closed'" class="tr-ban reply clear"><Icon name="lock" :size="18" /><span><b>Closed</b> {{ short(net.now - (v.since ?? net.now)) }} ago<template v-if="row.goneReason"> · {{ row.goneReason }}</template><small v-if="v.plan && v.job">Job {{ v.job.id }} {{ v.job.outcome ?? "open" }}: {{ left.inWork }} {{ left.inWork === 1 ? "step" : "steps" }} unfinished, {{ left.notStarted }} not started. Read only.</small><small v-else>{{ v.n - v.done }} of {{ v.n }} steps were open. Read only.</small></span></div>
      <div v-else-if="v.plan && v.job && v.job.closedAt != null" :class="['tr-ban', 'reply', 'clear', 'hair', { good: v.job.outcome === 'done' }]"><Icon :name="v.job.outcome === 'done' ? 'check' : 'triangle-alert'" :size="18" /><span><b>Job {{ v.job.id }} {{ v.job.outcome }}</b> · reported {{ short(net.now - v.job.closedAt) }} ago<small>{{ v.plan.done }} of {{ v.plan.plan }} brief steps<template v-if="v.plan.added">, {{ v.plan.added }} added</template><template v-if="v.plan.dropped">, {{ v.plan.dropped }} dropped</template><template v-if="v.plan.unfinished">, {{ v.plan.unfinished }} unfinished</template> · {{ asksOpen ? `${asksOpen} open ${asksOpen === 1 ? "ask" : "asks"}` : "no open asks" }} · {{ v.job.grade != null ? "grade " + v.job.grade : "not graded yet" }}</small></span></div>
      <div v-else-if="v.mode === 'idle' && v.n && v.done === v.n" class="tr-ban reply clear hair"><Icon name="check" :size="18" /><span><b>All {{ v.n }} steps done</b><small>idle for {{ short(net.now - (v.since ?? net.now)) }}</small></span></div>
    </template>
    <div v-if="!v.n" class="tr-empty"><p class="tr-empty-h">No plan yet</p><p>{{ row.name }} has no plan yet. It shows here when the steps of its brief are read in, or when the agent sets it. The map card shows its status sentence until then.<template v-if="row.lastTool"> Last: {{ phrase(row.lastTool) }}.</template></p></div>
    <ol v-else :class="['tr-list', { dead: v.mode === 'closed', pk: peek, wide: !!job && job.steps.some((x) => x.n > 9) }]" :aria-label="job ? `Plan of job ${job.id}` : 'Trail'">
      <i class="tr-head"><i /></i>
      <li v-if="peek && from > 0" class="tr-more">{{ from }} done before</li>
      <li v-for="s in steps" :key="s.t.id" :data-i="s.i" :data-no="s.no || undefined"
        :class="['tr-step', kind(s.t, s.i), tint(s.i), { 'tr-branch': isCur(s.i) && branched, just: s.i === just, enter: s.i === enter, add1: s.i === firstAdded && s.i > 0, 'pre-add': s.i + 1 === firstAdded }]"
        :style="isCur(s.i) && branched ? { '--rows': branch.length } : undefined">
        <span v-if="s.i === firstAdded && s.i > 0" class="tr-div">Added later</span>
        <i class="tr-lit" />
        <template v-if="isCur(s.i) && branched"><i class="tr-stem" /><i class="tr-tail" /></template>
        <span class="tr-node" aria-hidden="true"><i class="o" /><i class="p" /><span class="ck"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg><i class="cv" /></span></span>
        <span v-if="!job" class="tr-t">{{ s.t.text }}</span>
        <span v-else class="tr-t pl"><span class="tr-n">{{ s.no }}</span><span class="tx">{{ s.t.text }}</span>
          <span v-if="!peek && (s.s?.added || s.proofs.length || s.why)" class="tr-x">
            <button v-if="s.s?.added && s.s.origin === 'boss' && s.s.originMsg != null" type="button" class="tr-chip or" :title="`Added on a message from the boss. Opens the messages.`" @click="emit('msg', s.s.originMsg)">Boss #{{ s.s.originMsg }}</button>
            <span v-else-if="s.s?.added" class="tr-chip or">{{ s.s.origin === "self" ? "Self" : s.s.origin === "boss" ? "Boss" : "Brief" }}</span>
            <template v-for="(e, k) in s.proofs" :key="k">
              <span v-if="e.kind === 'none'" class="tr-chip none" title="Closed without proof">No proof · {{ e.value }}</span>
              <span v-else :class="['tr-chip', { miss: e.ok === false }]" :title="e.ok ? 'Checked by the service' : e.ok === false ? `The service could not find this ${e.kind}` : 'Not checkable by the service'"><Icon :name="EV[e.kind]" :size="12" /><b>{{ e.value }}</b><template v-if="e.ok === false">not verified</template><Icon v-else-if="e.ok" name="check" :size="12" class="tick" label="verified" /></span>
            </template>
            <span v-if="s.why" class="tr-why">{{ s.why }}</span>
          </span>
        </span>
        <span class="tr-r">
          <template v-if="job && s.t.status === 'done'"><span v-if="s.time === 'nowork'" class="tr-nw" title="No work tool call between the start and the close of this step">no work seen</span><span v-else-if="s.time" class="tr-sec" :title="`${s.s?.workCalls} work ${s.s?.workCalls === 1 ? 'call' : 'calls'}`">{{ short(s.time.ms) }}</span></template>
          <span v-else-if="s.t.status === 'done' && s.t.doneAt && s.t.startedAt" class="tr-sec">{{ short(s.t.doneAt - s.t.startedAt) }}</span>
          <template v-else-if="isCur(s.i) && v.mode === 'work'"><span class="tr-tag on">{{ v.word.split(" ")[0] }}</span><span v-if="s.t.startedAt" class="tr-sec">{{ dur(net.now - s.t.startedAt) }}</span></template>
          <span v-else-if="isCur(s.i) && (v.mode === 'gate' || v.mode === 'reply')" class="tr-tag">{{ v.mode === "gate" ? "You" : "Reply" }}</span>
        </span>
        <div v-if="isCur(s.i) && branched" class="tr-sub">
          <svg class="tr-br in" viewBox="0 0 22 20" aria-hidden="true"><path d="M1 0A10 10 0 0 0 11 10A10 10 0 0 1 21 20" /></svg><svg class="tr-br out" viewBox="0 0 22 20" aria-hidden="true"><path d="M21 0A10 10 0 0 1 11 10A10 10 0 0 0 1 20" /></svg>
          <div v-for="(r, k) in branch" :key="r.key" :data-k="r.key" :class="['tr-row', r.cls, { lit: k < liveAt }]" :style="{ '--n': k }">
            <span />
            <span><template v-if="r.kind === 'live'"><b>{{ r.strong }}</b><template v-if="r.target"><br /><span class="tg">{{ r.target }}</span></template></template><template v-else-if="r.kind === 'last'">{{ r.text }}<span :class="r.ok ? 'ok' : 'fail'">{{ r.ok ? "ok" : "failed" }}</span>{{ r.strong }}</template><template v-else><b>{{ r.strong }}</b>{{ r.text }}</template></span>
            <span :class="['meta', { 'tr-sec': r.live != null }]">{{ r.live != null ? dur(net.now - r.live) : r.meta }}</span>
          </div>
        </div>
        <div v-if="isCur(s.i) && check && !peek" :class="['tr-gate', { arrive }]" role="group" aria-label="Question for you">
          <div class="lbl"><span>Waiting for you</span><span class="tr-sec meta">{{ dur(net.now - check.createdAt) }}</span></div>
          <p class="q">{{ check.question }}</p>
          <div class="opts"><button v-for="o in check.options" :key="o.label" type="button" :class="o.tone" :disabled="!!answering" @click="answer(o.label)">{{ o.label }}</button></div>
          <p v-if="err" class="gerr">{{ err }}</p>
        </div>
      </li>
      <li v-if="peek && to < v.n" class="tr-more">{{ v.n - to }} more after</li>
    </ol>
  </div>
</template>

<!-- the look of one call row on the branch, shared with the chat's steps (ChatWork.vue) -->
<style scoped src="../ui/trail-row.css"></style>
<style scoped>
/* Board 10-agent-trail, "shared rail (peek and full)". Token map: --card = --panel, --ground = --panel-2, --k-question = --pend,
   --hair = --line, --faint = --muted; --fiber, --lit, --head carry the board's own values (ui/tokens.css). */
.trw{display:flex;flex-direction:column;gap:12px;min-width:0;container-type:inline-size}
.tr-list{list-style:none;margin:0;padding:0;position:relative;--tr-dim:color-mix(in srgb,var(--fiber) 55%,var(--panel))}
.tr-step{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr) auto;column-gap:12px;padding:7px 0}
/* the rail: a fiber segment from this node to the next one */
.tr-step::before,.tr-step>.tr-lit{content:"";position:absolute;left:11px;top:19px;bottom:-19px;width:2px;border-radius:1px}
.tr-step::before{background:var(--fiber);opacity:.55;transform-origin:top}
.tr-step:last-child::before,.tr-step:last-child>.tr-lit{display:none}
.tr-step>.tr-lit{background:var(--lit);transform-origin:top;transform:scaleY(0)}
.tr-step.done>.tr-lit{transform:scaleY(1)}
.tr-list.dead .tr-step::before{background:none;border-left:2px dashed color-mix(in srgb,var(--off) 60%,transparent);opacity:1;box-shadow:none}
.tr-list.dead .tr-lit{display:none}
/* nodes */
.tr-node{position:relative;width:24px;height:24px;display:grid;place-items:center;grid-row:1 / span 2;align-self:start}
.tr-node i{position:absolute;border-radius:50%}
.tr-node .o{inset:7px;box-shadow:inset 0 0 0 1.5px var(--fiber);background:var(--panel-2)}
.tr-done .tr-node .o{inset:3px;background:color-mix(in srgb,var(--lit) 16%,var(--panel));box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--lit) 70%,transparent)}
.tr-node svg{position:relative;width:12px;height:12px;fill:none;stroke:var(--lit);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;opacity:0}
.tr-done .tr-node svg{opacity:1}
.tr-node .ck{position:absolute;inset:4px;overflow:hidden;border-radius:50%;display:grid;place-items:center}
.tr-node .cv{position:absolute;inset:0;background:color-mix(in srgb,var(--lit) 16%,var(--panel));transform:translateX(100%)}
.tr-cur .tr-node .o{inset:3px;background:var(--panel);box-shadow:inset 0 0 0 2px var(--c,var(--on))}
.tr-cur .tr-node .p{inset:8px;background:var(--c,var(--on))}
.tr-step.gate-c{--c:var(--pend)}.tr-step.block-c{--c:var(--bad)}.tr-step.idle-c{--c:var(--off)}
/* text */
.tr-t{font-size:13px;color:var(--muted);padding-top:3px;overflow-wrap:anywhere}
.tr-cur .tr-t{color:var(--ink);font-weight:600}
.tr-pend .tr-t{color:color-mix(in srgb,var(--ink) 72%,transparent)}
.tr-r{padding-top:4px;display:flex;gap:6px;align-items:baseline}
.tr-sec{font:500 12px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);min-width:6ch;text-align:right;white-space:nowrap}
.tr-tag{height:20px;padding:0 8px;border-radius:999px;font:600 11px/20px var(--mono);letter-spacing:.02em;white-space:nowrap;color:var(--pend);background:color-mix(in srgb,var(--pend) 14%,transparent)}
.tr-tag.on{color:var(--on);background:none;padding:0}
/* ---- a planned job on the rail ----
   step number: a hanging mono figure; the text and what hangs under it (origin, proof, reason) share the second column */
.tr-t.pl{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:5px}
.tr-n{font:500 11px/19px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);min-width:3ch}
.tr-list.wide .tr-n{min-width:4ch}
.tr-cur .tr-n{color:var(--ink)}
.tr-x{grid-column:2;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;font-weight:400}
.tr-chip{display:inline-flex;align-items:center;gap:5px;min-height:20px;max-width:100%;margin:0;padding:2px 7px;border:0;border-radius:10px;font:500 11px/1.35 var(--mono);color:var(--muted);background:color-mix(in srgb,var(--ink) 6%,transparent);overflow-wrap:anywhere;text-align:left}
.tr-chip :deep(svg){flex:none}
.tr-chip b{font-weight:600;color:var(--ink)}
.tr-chip :deep(.tick){color:var(--on)}
.tr-chip.miss{color:var(--pend);background:color-mix(in srgb,var(--pend) 12%,transparent)}
.tr-chip.miss b{color:var(--pend)}
.tr-chip.none{background:transparent;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--off) 55%,transparent);font-family:var(--body)}
.tr-chip.or{font-family:var(--body);font-weight:600}
button.tr-chip.or{position:relative;color:var(--ink);background:transparent;box-shadow:inset 0 0 0 1px var(--line);cursor:pointer}
button.tr-chip.or::after{content:"";position:absolute;inset:-10px -4px}
button.tr-chip.or:hover{background:var(--track)}
button.tr-chip.or:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
/* a step closed with no work call under it: grey words where the time would be */
.tr-nw{font:500 11.5px/1.2 var(--body);color:var(--muted);white-space:nowrap;padding-top:1px}
/* dropped: a hollow node with a bar, the text struck through, the reason under it */
.tr-drop .tr-node .o{inset:5px;background:transparent;box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--off) 70%,transparent)}
.tr-drop .tr-node .p{left:9px;right:9px;top:11.25px;height:1.5px;border-radius:1px;background:color-mix(in srgb,var(--off) 90%,transparent)}
.tr-drop .tx{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.tr-why{font:400 12px/1.35 var(--body);color:var(--muted)}
/* unfinished: the step that was in work when the job closed */
.tr-unf .tr-node .o{inset:3px;box-shadow:none;border:1.5px dashed var(--off)}
.tr-unf .tr-node .p{inset:8px;height:auto;border-radius:50%;background:var(--off)}
.tr-unf .tx{text-decoration:none;color:var(--ink);font-weight:600}
/* the thin "added later" line belongs to the first added step. The step keeps its own box (the motion measures it), so the
   line sits in a margin above it and the rail of the step before runs on through that margin. */
.tr-step.add1{margin-top:29px}
.tr-div{position:absolute;left:36px;right:0;top:-24px;display:flex;align-items:center;gap:8px;font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.tr-div::after{content:"";flex:1;height:1px;background:var(--line)}
.tr-step.pre-add::before,.tr-step.pre-add>.tr-lit{bottom:-48px}
.tr-step.pre-add>.tr-tail{margin-bottom:-55px}
/* what hangs under the current step: a branch of the rail. It leaves the main line below the node in an S-curve, runs through
   one node per call and side job, and joins the main line again before the next step. Main line x = 12px, branch x = 32px;
   each S is two quarter arcs. The step's grid: row 1 node + title, row 2 the branch rows, row 3 the gate. */
.tr-branch::before,.tr-branch>.tr-lit{display:none}
.tr-branch>.tr-node{grid-area:1 / 1}
.tr-branch>.tr-t{grid-area:1 / 2}
.tr-branch>.tr-r{grid-area:1 / 3}
.tr-branch>.tr-gate{grid-area:3 / 2 / 4 / -1}
.tr-stem,.tr-tail{grid-column:1;justify-self:center;width:2px;border-radius:1px}
.tr-stem{grid-row:1;margin:12px 0 -1px;border-radius:0;background:var(--lit)}
.tr-tail{grid-row:3;margin:6px 0 -26px;border-radius:0;background:var(--tr-dim);transform-origin:top}
.tr-sub{position:relative;grid-area:2 / 1 / 3 / -1;display:flex;flex-direction:column;gap:2px;margin-top:8px;padding:0 0 8px 24px}
/* each S is one stroked path (no borders, so no corner joins): x 12 on the main line to x 32 on the branch, two quarter arcs of
   radius 10. The lines it joins have square ends and sit on the same pixel row, so nothing overlaps and nothing is left open. */
.tr-br{position:absolute;left:11px;width:22px;height:20px;overflow:visible;pointer-events:none;fill:none;stroke:var(--tr-dim);stroke-width:2;stroke-linecap:butt}
.tr-br.in{top:-7px;stroke:var(--lit)}
.tr-br.out{bottom:-6px}
/* the last step has no next node to join */
.tr-step:last-child>.tr-tail,.tr-step:last-child .tr-br.out,.tr-step:last-child .tr-row:last-child::after{display:none}
.tr-list.dead .tr-stem,.tr-list.dead .tr-tail,.tr-list.dead .tr-row::after{background:none;box-shadow:none;border-left:2px dashed color-mix(in srgb,var(--off) 60%,transparent)}
.tr-list.dead .tr-br{stroke:color-mix(in srgb,var(--off) 60%,transparent);stroke-dasharray:3 2}
/* gate: a question to the owner, on the step */
.tr-gate{grid-column:2 / -1;margin-top:8px;padding:12px;border-radius:12px;background:color-mix(in srgb,var(--pend) 9%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--pend) 40%,transparent)}
.tr-gate .lbl{display:flex;gap:8px;justify-content:space-between;font:600 11px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--pend)}
.tr-gate .q{margin:6px 0 10px;color:var(--ink);font-size:13px;overflow-wrap:anywhere}
.tr-gate .opts{display:flex;flex-wrap:wrap;gap:6px}
.tr-gate .opts button{min-height:36px;padding:0 14px;border:0;border-radius:999px;font:600 13px var(--body);color:var(--ink);background:var(--panel);box-shadow:0 0 0 1px var(--line);cursor:pointer}
.tr-gate .opts button.good{color:var(--on)}.tr-gate .opts button.bad{color:var(--bad)}
.tr-gate .opts button:disabled{opacity:.5;cursor:progress}
.gerr{margin:8px 0 0;color:var(--bad);font-size:12px}
/* a banner above the rail: blocked, waiting for a reply, closed, all done */
.tr-ban{display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;padding:10px 12px;border-radius:12px;font-size:13px;color:var(--ink);overflow-wrap:anywhere}
.tr-ban.block{background:color-mix(in srgb,var(--bad) 10%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--bad) 40%,transparent)}
.tr-ban.block :deep(svg){color:var(--bad)}
.tr-ban.reply{background:color-mix(in srgb,var(--pend) 8%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--pend) 30%,transparent)}
.tr-ban.reply :deep(svg){color:var(--pend)}
.tr-ban.clear{background:transparent}.tr-ban.hair{box-shadow:0 0 0 1px var(--line)}
.tr-ban small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.tr-ban.good :deep(svg){color:var(--on)}
/* a narrow sheet (phone): the step text takes the full width and the time drops under it */
@container (max-width:380px){
  .trw:not(.pop) .tr-step>.tr-t{grid-column:2 / -1}
  .trw:not(.pop) .tr-step>.tr-r{grid-column:2 / -1;grid-row:2;padding-top:2px}
  .trw:not(.pop) .tr-step>.tr-r:empty{display:none}
  .trw:not(.pop) .tr-step>.tr-r .tr-sec{min-width:0;text-align:left}
  .trw:not(.pop) .tr-branch>.tr-t{grid-area:1 / 2 / 2 / -1}
  .trw:not(.pop) .tr-branch>.tr-r{grid-area:2 / 2 / 3 / -1}
  .trw:not(.pop) .tr-branch>.tr-stem{grid-row:1 / 3}
  .trw:not(.pop) .tr-branch>.tr-sub{grid-area:3 / 1 / 4 / -1}
  .trw:not(.pop) .tr-branch>.tr-gate{grid-area:4 / 2 / 5 / -1}
  .trw:not(.pop) .tr-branch>.tr-tail{grid-row:4}
}
/* no task list */
.tr-empty{padding:16px 0;color:var(--muted);font-size:13px}
.tr-empty p{margin:0}.tr-empty-h{margin:0 0 4px !important;font:650 15px/1.3 var(--body);color:var(--ink)}
.tr-empty p:last-child{max-width:46ch}
/* peek */
.pk .tr-step{padding:5px 0}
.tr-more{list-style:none;font-size:12px;color:var(--muted);padding:2px 0 0 36px}
/* the light that runs down the rail when a step completes */
.tr-head{position:absolute;left:12px;top:0;width:0;height:0;pointer-events:none;opacity:0;z-index:2}
.tr-head::after{content:"";position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:var(--head);box-shadow:0 0 0 1px var(--lit)}
.tr-head i{position:absolute;left:-1px;bottom:0;width:2px;height:56px;border-radius:1px;background:linear-gradient(to top,var(--lit),transparent)}

/* a step completes, in this order (transform and opacity only):
   0 ms    its branch fades out in place (a copy, see settle()) and the cover slides off the check
   60 ms   the steps below slide up to their new place; the rail between two nodes stretches with the gap (settle())
   300 ms  the rail lights and the head runs to the next node
   560 ms  that node grows from the small waiting size
   600 ms  its branch opens: the curve out, then one row every 30 ms, then the curve back
   A question arriving or being answered uses the same slide, with no wait.
   --lead: when the next step starts in a later frame than the finish, its half starts at once (300 ms taken off). */
.tr-step.just .cv{animation:tr-uncover 360ms cubic-bezier(.2,.8,.2,1) 1 both}
.tr-step.just .tr-node svg{opacity:1}
.tr-step.just>.tr-lit{animation:tr-fill 320ms cubic-bezier(.65,0,.35,1) 300ms 1 both}
.tr-head.run{animation:tr-run 320ms cubic-bezier(.65,0,.35,1) calc(300ms - var(--lead,0ms)) 1 both}
.tr-step.enter .tr-node .o{animation:tr-grow 240ms cubic-bezier(.2,.8,.2,1) calc(560ms - var(--lead,0ms)) 1 both}
.tr-step.enter .tr-node .p{animation:tr-on 240ms cubic-bezier(.2,.8,.2,1) calc(560ms - var(--lead,0ms)) 1 both}
.tr-step.enter>.tr-stem,.tr-step.enter .tr-br.in{animation:tr-fade 160ms cubic-bezier(.2,.8,.2,1) calc(600ms - var(--lead,0ms)) 1 both}
.tr-step.enter .tr-row{animation:tr-in 200ms cubic-bezier(.2,.8,.2,1) calc(660ms - var(--lead,0ms) + var(--n,0) * 30ms) 1 both}
.tr-step.enter .tr-br.out,.tr-step.enter>.tr-tail{animation:tr-fade 160ms cubic-bezier(.2,.8,.2,1) calc(690ms - var(--lead,0ms) + var(--rows,0) * 30ms) 1 both}
.tr-step.enter .tr-gate{animation:tr-in 360ms cubic-bezier(.2,.8,.2,1) calc(620ms - var(--lead,0ms)) 1 both}
/* the copy of a branch or question that just went: it sits where the part was and fades */
.tr-ghost{position:absolute;z-index:1;margin:0;pointer-events:none}
.tr-gate.arrive{animation:tr-in 360ms cubic-bezier(.2,.8,.2,1) 1 both}
.tr-gone{animation:tr-out 220ms ease-out 1 both}
@keyframes tr-uncover{from{transform:translateX(0)}to{transform:translateX(100%)}}
@keyframes tr-fill{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes tr-run{0%{opacity:0;transform:translateY(var(--from))}12%{opacity:1}86%{opacity:1}100%{opacity:0;transform:translateY(var(--to))}}
@keyframes tr-on{from{opacity:0;transform:scale(.7)}to{opacity:1;transform:scale(1)}}
@keyframes tr-grow{from{opacity:.45;transform:scale(.56)}to{opacity:1;transform:scale(1)}}
@keyframes tr-fade{from{opacity:0}to{opacity:1}}
@keyframes tr-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@keyframes tr-out{to{opacity:0}}
@media (prefers-reduced-motion:reduce){
  .tr-head.run{animation:none;opacity:0}
  .tr-step.just .cv{animation:tr-fadecv 300ms ease 1 both}
  .tr-step.just>.tr-lit{animation:tr-fade 300ms ease 1 both;transform:scaleY(1)}
  .tr-step.enter .tr-node .o,.tr-step.enter .tr-node .p,.tr-step.enter .tr-gate,.tr-step.enter>.tr-stem,.tr-step.enter>.tr-tail,.tr-step.enter .tr-br.in,.tr-step.enter .tr-br.out,.tr-step.enter .tr-row,.tr-gate.arrive{animation:tr-fade 300ms ease 1 both}
  @keyframes tr-fadecv{from{opacity:1;transform:none}to{opacity:0;transform:none}}
}
</style>
