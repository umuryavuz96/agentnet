<script setup lang="ts">
// People tab of the team pane (board page 04): the crew as indented rows, lead first, reports under their boss.
// Not-running and retired members fold into one line of chips. Tap a row: the pane swaps to that agent.
import { computed, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { net, ctxView } from "../net";
import { phrase } from "../trail";
import { brk, buildCrew, modelShort, type CrewNode } from "../crewTree";

const props = defineProps<{ name: string; members: string[]; lead: string | null; archived?: boolean; bosses?: Record<string, string | null> }>();
const emit = defineEmits<{ select: [id: string] }>();

const rowOf = (n: string) => Object.values(net.agents).find((a) => a.name === n && a.life !== "gone") ?? Object.values(net.agents).find((a) => a.name === n) ?? null;
const tree = computed(() => buildCrew(props.members, props.lead, rowOf, props.bosses));
const isOff = (n: CrewNode) => n.state === "off" || n.state === "done";
const flat = (t: CrewNode[], d = 0): { n: CrewNode; d: number }[] => t.flatMap((n) => (isOff(n) ? [] : [{ n, d }, ...flat(n.kids, d + 1)]));
const liveRows = computed(() => flat(tree.value));
const off = computed(() => { const o: CrewNode[] = []; const w = (t: CrewNode[]) => t.forEach((n) => { if (isOff(n)) o.push(n); w(n.kids); }); w(tree.value); return o; });
const open = ref(false);
const line = (n: CrewNode) => (!n.row ? "Not running" : n.state === "working" ? phrase(n.row.action ?? n.row.lastTool) || "Working" : n.state === "blocked" ? "Blocked" : n.state === "waiting" ? "Waiting for you" : "Idle");
const usd = (n: number | null | undefined) => (n == null ? "" : "$" + n.toFixed(2));
const WORD: Record<string, string> = { working: "Working", idle: "Idle", waiting: "Waiting", blocked: "Blocked", starting: "Starting" };
</script>

<template>
  <section class="cr" aria-label="People">
    <div v-if="!liveRows.length" class="cr-empty">
      <Icon name="users" :size="20" />
      <b>No one from {{ name }} is running</b>
      <p>The team keeps its goal, channel and tasks. Add an agent to start it again; it joins with the goal above.</p>
    </div>
    <ul v-else class="cr-l">
      <li v-for="{ n, d } in liveRows" :key="n.name" :class="{ sub: d > 0 }" :style="{ '--d': d }">
        <button type="button" class="cr-r" :disabled="!n.row" @click="n.row && emit('select', n.row.id)">
          <span class="cr-t">
            <i :class="['cr-dot', 's-' + n.state]" aria-hidden="true" />
            <b class="cr-nm">{{ brk(n.name) }}</b>
            <span v-if="n.lead" class="cr-chip ring">Lead</span>
            <span v-if="modelShort(n.row?.model)" class="cr-chip">{{ modelShort(n.row?.model) }}</span>
            <span :class="['cr-w', 's-' + n.state]">{{ WORD[n.state] ?? n.state }}</span>
          </span>
          <span class="cr-do">{{ line(n) }}</span>
          <span v-if="ctxView(n.row)" class="cr-m">
            <span :class="['cr-bar', { hot: ctxView(n.row)!.pct >= 80 }]"><i :style="{ transform: `scaleX(${Math.min(1, ctxView(n.row)!.pct / 100)})` }" /></span>
            <span class="num">{{ Math.round(ctxView(n.row)!.pct) }}% context</span>
            <span v-if="n.row?.cost != null" class="num">{{ usd(n.row.cost) }}</span>
          </span>
        </button>
      </li>
    </ul>
    <div v-if="off.length" class="cr-off">
      <button type="button" class="cr-fold" :aria-expanded="open" @click="open = !open">
        <Icon name="chevron-down" :size="15" :class="{ up: open }" /><b>{{ off.length }} {{ liveRows.length ? "not running" : "retired" }}</b><span>folded</span>
      </button>
      <ul v-show="open" class="cr-chips"><li v-for="n in off" :key="n.name"><i class="cr-dot s-off" aria-hidden="true" />{{ n.name }}</li></ul>
    </div>
  </section>
</template>

<style scoped>
.cr{display:grid;gap:12px}
.cr-l{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.cr-l li.sub{margin-left:calc(var(--d) * 16px);position:relative}
.cr-l li.sub::before{content:"";position:absolute;left:-9px;top:0;bottom:50%;width:8px;border-left:1.5px solid color-mix(in srgb,var(--ink) 28%,transparent);border-bottom:1.5px solid color-mix(in srgb,var(--ink) 28%,transparent);border-radius:0 0 0 6px}
.cr-r{display:grid;gap:4px;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--ink) 3%,transparent);color:var(--ink);text-align:left;font:inherit;cursor:pointer;transition:background-color .2s var(--ease)}
.cr-r:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 7%,transparent)}
.cr-r:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.cr-t{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.cr-nm{font:650 14px/1.3 var(--body);overflow-wrap:anywhere}
.cr-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--off)}
.cr-dot.s-working{background:var(--on)}.cr-dot.s-idle{background:var(--muted)}.cr-dot.s-waiting{background:var(--warn)}.cr-dot.s-blocked{background:var(--bad)}
.cr-chip{padding:1px 7px;border-radius:999px;background:var(--track);color:var(--muted);font:500 11px/1.5 var(--mono)}
.cr-chip.ring{background:transparent;box-shadow:inset 0 0 0 1px var(--muted);font:600 11px/1.5 var(--body)}
.cr-w{margin-left:auto;font:600 12px/1.3 var(--body);color:var(--muted)}
.cr-w.s-working{color:var(--on)}.cr-w.s-blocked{color:var(--bad)}.cr-w.s-waiting{color:var(--warn)}
.cr-do{color:var(--ink);font-size:13px;line-height:1.4;overflow-wrap:anywhere}
.cr-m{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}
.cr-bar{flex:1;max-width:120px;height:5px;border-radius:3px;background:var(--track);overflow:hidden}
.cr-bar i{display:block;height:100%;background:var(--muted);transform-origin:left}
.cr-bar.hot i{background:var(--warn)}
.num{font-variant-numeric:tabular-nums}
.cr-empty{display:grid;gap:8px;justify-items:start;padding:16px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}
.cr-empty b{font-size:15px}.cr-empty p{margin:0;color:var(--muted);font-size:13px}
.cr-fold{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:0 4px;border:0;background:transparent;color:var(--muted);font:500 13px/1 var(--body);cursor:pointer}
.cr-fold b{color:var(--ink)}
.cr-fold .icon{transition:transform .2s var(--ease)}.cr-fold .up{transform:rotate(180deg)}
.cr-chips{list-style:none;margin:0;padding:0 0 4px;display:flex;flex-wrap:wrap;gap:6px}
.cr-chips li{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
</style>
