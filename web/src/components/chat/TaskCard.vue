<script setup lang="ts">
// A task, job, ticket or message the agent points at (canvas Task, "Task, job, ticket"): a solid card, its node says where it
// stands (the Trail tab's node), the owner and state word sit in the foot, progress is the bottom edge plus a count.
// Stale (canvas States): when the live plan says the step or job moved on since the reply, a warn line says so and Refresh
// shows where it stands now. A state change runs one ripple band and the edge fills (canvas Motion).
import { computed, ref, watch } from "vue";
import Icon from "../../ui/Icon.vue";
import { liveTaskState, type Block, type TaskState } from "../../chatBlocks";
import { net } from "../../net";
import CardSurface from "./CardSurface.vue";
import DotTile from "./DotTile.vue";
import RailNode from "./RailNode.vue";
import { agentHue } from "./agentHue";

type TaskBlock = Extract<Block, { type: "task" }>;
const props = defineProps<{ block: TaskBlock }>();
const KIND = { step: "Step", job: "Job", ticket: "Ticket", message: "Message" } as const;
const NODE = { todo: "todo", active: "cur", done: "done", blocked: "blocked", wait: "wait" } as const;
const WORD = { todo: "To do", active: "Working", done: "Done", blocked: "Blocked", wait: "Needs an answer" } as const;
const TINT = { todo: undefined, active: "var(--on)", done: undefined, blocked: "var(--bad)", wait: "var(--warn)" } as const;
const hue = computed(() => agentHue(props.block.owner));
const live = computed(() => liveTaskState(props.block, Object.values(net.agents)));
const fresh = ref(false);
/** The state drawn: the reply's, or the live one after Refresh. */
const state = computed<TaskState>(() => (fresh.value && live.value ? live.value : props.block.state));
const stale = computed(() => !fresh.value && live.value != null && live.value !== props.block.state);
const ripple = ref(0);
watch(state, (a, b) => { if (a !== b) ripple.value++; });
const done = computed(() => { const m = /^(\d+)\/(\d+)$/.exec(props.block.progress ?? ""); return m ? { a: Number(m[1]), b: Number(m[2]) } : null; });
const tint = computed(() => (state.value === "done" ? `hsl(${hue.value} 78% 62%)` : TINT[state.value]));
const word = computed(() => (fresh.value ? WORD[state.value] : props.block.note ?? WORD[state.value]));
</script>

<template>
  <section :class="['tk', 's-' + state]" :aria-label="`${KIND[block.kind]} ${block.id}: ${block.title}`">
    <CardSurface :tint="tint" :bar="done && state !== 'todo' ? tint : undefined" :progress="done ? done.a / Math.max(1, done.b) : 0" :draft="false" :ripple="ripple" />
    <div class="tk-top">
      <RailNode :state="NODE[state]" />
      <span class="tk-t"><b>{{ block.title }}</b><small>{{ block.sub ?? KIND[block.kind] }}</small></span>
      <span class="tk-id">{{ block.id }}</span>
    </div>
    <div v-if="block.owner || state !== 'todo' || done" class="tk-foot">
      <DotTile v-if="block.owner" :hue="hue" :state="state === 'active' ? 'working' : state === 'wait' ? 'waiting' : state === 'blocked' ? 'blocked' : 'idle'" size="sm" />
      <b v-if="block.owner">{{ block.owner }}</b>
      <span :class="['tk-w', 'w-' + state]">{{ word }}</span>
      <span v-if="done" class="tk-p">{{ done.a }} of {{ done.b }} done</span>
    </div>
    <div v-else class="tk-foot"><span class="tk-w w-todo">{{ word }}</span></div>
    <p v-if="stale" class="tk-stale"><Icon name="clock" :size="14" /><span>As of this reply it was {{ WORD[block.state] }}. It may have moved on.</span><button type="button" class="cx-chip cx-ref" data-lift="pill" @click="fresh = true"><Icon name="rotate-ccw" :size="12" /><b>Refresh</b></button></p>
  </section>
</template>

<style scoped>
.tk{position:relative;isolation:isolate;display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 14px 14px;border-radius:16px;background:var(--cd,var(--panel));--cd:#1e1e21;font-size:13.5px;line-height:1.45}
:root[data-theme="light"] .tk{--cd:#fbfbfc}
.tk :deep(.cs){z-index:-1}
.tk-top{display:flex;align-items:flex-start;gap:10px;min-width:0}
.tk-top :deep(.rn){margin-top:-1px}
.tk-t{flex:1;min-width:0;display:grid;gap:1px}
.tk-t b{font-weight:600;font-size:14px;line-height:1.35;overflow-wrap:anywhere}
.tk-t small{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.tk-id{flex:none;font:500 11.5px/20px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.tk-foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:12.5px}
.tk-foot b{font-weight:600}
.tk-w{font-weight:600}
.w-active{color:var(--on)}.w-done,.w-todo{color:var(--muted)}.w-blocked{color:var(--bad)}.w-wait{color:var(--warn)}
.tk-stale{display:flex;gap:8px;align-items:flex-start;margin:0;color:var(--warn);font-size:12.5px}
.tk-stale > svg{flex:none;margin-top:2px}
.tk-stale button{flex:none;margin-left:auto;cursor:pointer;transition:transform .16s cubic-bezier(.23,1,.32,1)}
.tk-stale button:active{transform:scale(.97)}
.tk-stale button:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.tk-stale button:hover{transform:translateY(-1.5px)}.tk-stale button:active{transform:scale(.97)}}
@media (prefers-reduced-motion:reduce){.tk-stale button{transition:none}.tk-stale button:hover,.tk-stale button:active{transform:none}}
.tk-p{margin-left:auto;color:var(--muted);font:500 11.5px/1 var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
</style>
