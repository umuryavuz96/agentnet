<script setup lang="ts">
// The coloured tile that says the kind of tool (canvas ToolTile): one hue per kind, neutral for commands, violet for
// thoughts. `run` swaps the fill for a green arc turning round the edge. Values are the canvas's, token for token.
import { computed } from "vue";
import Icon from "../../ui/Icon.vue";
import type { IconName } from "../../ui/icons";

export type ToolKind = "agentnet" | "read" | "edit" | "search" | "web" | "browser" | "agent" | "tool" | "image" | "cmd" | "plain" | "think" | "ok" | "warn" | "bad" | "info" | "note";
const props = withDefaults(defineProps<{ kind?: ToolKind; icon?: IconName; size?: "md" | "lg"; run?: boolean }>(), { kind: "edit", size: "md", run: false });
const HUE: Partial<Record<ToolKind, number>> = { agentnet: 100, read: 188, edit: 262, search: 172, web: 240, browser: 334, agent: 307, tool: 285, image: 212 };
const ICON: Record<ToolKind, IconName> = { agentnet: "network", read: "file-text", edit: "pen-line", search: "search", web: "globe", browser: "camera", agent: "bot", tool: "plug", image: "image", cmd: "square-terminal", plain: "square-terminal", think: "brain", ok: "circle-check", warn: "triangle-alert", bad: "circle-x", info: "info", note: "info" };
const FLAT: Partial<Record<ToolKind, string>> = { cmd: "muted", plain: "muted", think: "lock", ok: "on", warn: "warn", bad: "bad", info: "sel", note: "lit" };
const style = computed(() => {
  const f = FLAT[props.kind];
  return f ? { "--tt-ac": `var(--${f})`, "--tt-fg": f === "muted" ? "var(--ink)" : `var(--${f})` } : { "--tt-ac": `hsl(${HUE[props.kind] ?? 212} 78% var(--tt-acl))`, "--tt-fg": `hsl(${HUE[props.kind] ?? 212} var(--tt-acs) var(--tt-actl))` };
});
</script>

<template>
  <span :class="['tt', size, { run }]" :style="style" aria-hidden="true">
    <Icon :name="icon ?? ICON[kind]" :size="size === 'lg' ? 16 : 13" />
    <span v-if="run" class="ring"><span class="arc" /></span>
  </span>
</template>

<style scoped>
.tt{--tt-acl:62%;--tt-acs:82%;--tt-actl:74%;--tt-sh:0 1px 2px rgba(0,0,0,.4);--tt-glow:50%;box-sizing:border-box;position:relative;flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;color:var(--tt-fg);
  background:color-mix(in srgb,var(--tt-ac) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tt-ac) 38%,transparent),var(--tt-sh),0 4px 8px -4px color-mix(in srgb,var(--tt-ac) var(--tt-glow),transparent)}
:root[data-theme="light"] .tt{--tt-acl:52%;--tt-acs:72%;--tt-actl:28%;--tt-sh:0 1px 2px rgba(22,22,26,.08);--tt-glow:40%}
.tt.lg{width:30px;height:30px;border-radius:9px}
.tt.run{background:none;box-shadow:none}
.ring{box-sizing:border-box;position:absolute;inset:0;border-radius:inherit;padding:1.5px;overflow:hidden;pointer-events:none;background:color-mix(in srgb,var(--on) 26%,transparent);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.arc{position:absolute;inset:-45%;background:conic-gradient(transparent 0 58%,color-mix(in srgb,var(--on) 40%,transparent) 80%,var(--on) 100%);animation:tt-spin 1.6s linear infinite}
@keyframes tt-spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){.arc{animation:none}}
</style>
