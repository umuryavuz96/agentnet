<script setup lang="ts">
// An agent's name inside chat text (agentMention.ts writes the placeholder, AgentnetChatBody.vue mounts this into it):
// the chat header's chip at text size. The agent's mark in its hue, the name, a dot in its state colour. A closed agent
// reads muted. Click (or Enter) opens that agent's chat; the tooltip says model and state. It sits on the text's line
// box and never breaks across lines.
import { computed } from "vue";
import DotTile from "./DotTile.vue";
import { agentHue } from "./agentHue";
import { crewState, modelShort } from "../../crewTree";
import { net } from "../../net";
import { openAgentChat } from "../../mentionNames";

const props = defineProps<{ name: string }>();
const row = computed(() => Object.values(net.agents).find((a) => a.name === props.name) ?? null);
const st = computed(() => crewState(row.value));
const gone = computed(() => props.name !== "root" && (st.value === "done" || st.value === "off"));
const tile = computed(() => (st.value === "working" || st.value === "waiting" || st.value === "blocked" ? st.value : "idle"));
const WORD: Record<string, string> = { working: "Working", waiting: "Needs you", blocked: "Blocked", idle: "Idle", starting: "Starting", done: "Closed", off: "Not running" };
const word = computed(() => (gone.value ? "Closed" : WORD[st.value] ?? st.value));
const tip = computed(() => [props.name, modelShort(row.value?.model ?? null), word.value].filter(Boolean).join(" · "));
const pattern = computed(() => {
  let h = 2166136261; for (const c of props.name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let b = ((h >>> 0) >>> 3) & 511; if ([...b.toString(2)].filter((x) => x === "1").length < 4) b ^= 0b101110101;
  return Array.from({ length: 9 }, (_, i) => ((b >> i) & 1 ? "1" : "0")).join("");
});
const hue = computed(() => agentHue(props.name));
</script>

<template>
  <button type="button" :class="['agm', 's-' + (gone ? 'gone' : st)]" :title="tip" :aria-label="`${tip}. Open chat`" @click.stop="openAgentChat(name)">
    <DotTile :hue="hue" :state="gone ? 'idle' : tile" :pattern="pattern" size="xs" /><b>{{ name }}</b><i class="agm-dot" aria-hidden="true" />
  </button>
</template>

<style scoped>
/* Line box: the chip is 1.36em tall inside the text's 1.55em line. It hangs from the line's top (an inline-flex box with a
   mark first has no text baseline, so baseline alignment pushed the line 10 px taller) and is nudged down to its middle,
   so a paragraph with chips is exactly as tall as without. */
.agm{box-sizing:border-box;position:relative;top:.095em;display:inline-flex;align-items:center;gap:.3em;height:1.36em;max-width:100%;margin:0 .05em;padding:0 .45em 0 .16em;border:0;border-radius:.42em;vertical-align:top;
  background:color-mix(in srgb,var(--ink) 8%,var(--panel));box-shadow:inset 0 0 0 .75px color-mix(in srgb,var(--ink) 12%,transparent);color:var(--ink);font:inherit;line-height:1;white-space:nowrap;cursor:pointer;
  transition:background-color .15s cubic-bezier(.23,1,.32,1),box-shadow .15s cubic-bezier(.23,1,.32,1)}
:root[data-theme="light"] .agm{background:#fff;box-shadow:0 0 0 .75px rgba(22,22,26,.1),0 1px 2px rgba(22,22,26,.07)}
.agm:hover{background:color-mix(in srgb,var(--ink) 14%,var(--panel))}
:root[data-theme="light"] .agm:hover{background:color-mix(in srgb,var(--ink) 5%,#fff)}
.agm:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.agm > b{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.agm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--off)}
.s-working .agm-dot{background:var(--on)}
.s-waiting .agm-dot,.s-starting .agm-dot{background:var(--warn)}
.s-blocked .agm-dot{background:var(--bad)}
.s-gone{color:var(--muted)}
.s-gone > :deep(.dt){opacity:.5;filter:saturate(.3)}
.s-gone .agm-dot{background:transparent;box-shadow:inset 0 0 0 1.25px var(--muted)}
@media (prefers-reduced-motion:reduce){.agm{transition:none}}
</style>
