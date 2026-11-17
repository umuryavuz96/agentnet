<script setup lang="ts">
// One place for the state glyph: a small Lucide icon that sits next to the status dot, so colour is never the only signal.
// Used by the agent card and the detail panel; any page that shows an agent state takes it from here.
import Icon from "./Icon.vue";
import type { IconName } from "./icons";

const props = defineProps<{ state: string }>();
const GLYPH: Record<string, IconName> = { working: "loader", idle: "circle", waiting: "circle-arrow-up", blocked: "triangle-alert", starting: "loader", stopping: "circle-stop", notrunning: "circle-stop", failed: "circle-x", root: "network" };
</script>

<template>
  <Icon :name="GLYPH[props.state] ?? 'circle'" :size="13" class="st-mark" :class="'st-' + props.state" />
</template>

<style scoped>
.st-mark{flex:none;color:var(--muted)}
.st-working,.st-starting{color:var(--on)}
.st-waiting{color:var(--pend)}
.st-blocked,.st-failed{color:var(--bad)}
</style>
