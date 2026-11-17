<script setup lang="ts">
// Agent trail, size 2 (map board 10-agent-trail, peek()): name and count, a live line saying what it does now, then up to
// five steps on the rail. Content only: the map's popover owns the place, width (320 px), card background and shadow.
import { computed } from "vue";
import Icon from "../ui/Icon.vue";
import AgentTrail from "./AgentTrail.vue";
import { net, pendingChecks, type AgentRow } from "../net";
import { trailView, dur } from "../trailView";
const props = defineProps<{ row: AgentRow }>();
const check = computed(() => pendingChecks.value.find((c) => c.agent === props.row.name) ?? null);
const v = computed(() => trailView(props.row, check.value));
const lead = computed(() => ({ work: { ico: "pen", cls: "on" }, gate: { ico: "user", cls: "gate" }, block: { ico: "triangle-alert", cls: "block" }, reply: { ico: "message-circle", cls: "gate" } } as const)[v.value.mode as "work"] ?? null);
const word = computed(() => (v.value.mode === "block" ? `Blocked on ${props.row.reported?.blockedOn ?? "something"}` : v.value.word));
</script>

<template>
  <div class="tpk">
    <div class="h"><b>{{ row.name }}</b><span class="c num">{{ v.count }}</span></div>
    <div v-if="lead" :class="['ld', lead.cls]"><Icon :name="lead.ico" :size="16" /><span class="w">{{ word }}</span><span v-if="v.mode !== 'block' && v.since != null" class="s num">{{ dur(net.now - v.since) }}</span></div>
    <p v-if="!v.n" class="none">{{ v.word }}. It has not written steps yet.</p>
    <AgentTrail v-else class="pop" :row="row" peek />
  </div>
</template>

<style scoped>
.tpk{display:flex;flex-direction:column;min-width:0;font-size:13px;color:var(--ink)}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.h{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.h b{font-weight:650;overflow-wrap:anywhere;min-width:0}
.h .c{margin-left:auto;font:600 12px/1 var(--mono)}
.ld{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;margin-bottom:4px;font-size:12px}
.ld .w{font-weight:600;overflow-wrap:anywhere}
.ld.on .w{color:var(--on)}.ld.gate .w{color:var(--pend)}.ld.block .w{color:var(--bad)}
.ld .s{font:500 12px/1 var(--mono);color:var(--muted);white-space:nowrap}
.none{margin:0;color:var(--muted)}
</style>
