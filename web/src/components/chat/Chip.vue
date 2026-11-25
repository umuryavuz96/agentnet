<script setup lang="ts">
// Shared chip (canvas Chip part): one fact with a tone. Tones: plain, ok, warn, bad, info, ref (outline, opens the thing),
// jira (Atlassian blue). md.ts writes the same classes as HTML for :ok[..] and reference chips, so both look alike.
import { computed } from "vue";
import { iconPaths, isChatIcon } from "../../chatIcons";
import "./chatText.css";

export type ChipTone = "plain" | "ok" | "warn" | "bad" | "info" | "ref" | "jira";
const props = withDefaults(defineProps<{ tone?: ChipTone; text: string; /** a name from chatIcons.ts, e.g. git-commit-horizontal */ icon?: string; strong?: boolean }>(), { tone: "plain", strong: true });
const paths = computed(() => (props.icon && isChatIcon(props.icon) ? iconPaths(props.icon) : ""));
</script>

<template>
  <span :class="['cx-chip', props.tone !== 'plain' && 'cx-' + props.tone]">
    <!-- eslint-disable-next-line vue/no-v-html -- static paths from chatIcons.ts -->
    <svg v-if="paths" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" v-html="paths" />
    <b v-if="strong">{{ text }}</b>
    <span v-else>{{ text }}</span>
  </span>
</template>
