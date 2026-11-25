// The agent names chat text may mention (agentMention.ts): every agent on the map now, plus the ones that were and left.
// The stream drops a despawned agent's row (`gone` frame), so names seen this session are kept here, with the teams' past
// members, so a closed agent's name still reads as a (muted) chip.
import { computed, ref, watch } from "vue";
import { net, teams } from "./net";
import { route, toHash } from "./router";

const seen = ref<string[]>([]);
watch(() => Object.values(net.agents).map((a) => a.name), (names) => {
  const add = names.filter((n) => n && !seen.value.includes(n));
  if (add.length) seen.value = [...seen.value, ...add];
}, { immediate: true });

/** Sorted names: live, gone this session, and teams' past members. */
export const mentionNames = computed(() => {
  const s = new Set(seen.value);
  for (const a of Object.values(net.agents)) if (a.name) s.add(a.name);
  for (const t of teams.list) for (const n of t.past ?? []) s.add(n);
  return [...s].sort();
});

/** Open the agent's chat, as clicking its card does (Agents.vue openChat): the chat lives in the hash. */
export function openAgentChat(name: string): void {
  const cur = route.value, onAgents = cur.page === "agents";
  const query: Record<string, string> = onAgents ? { ...cur.query } : {};
  query.chat = name;
  query.mode = onAgents && cur.query.chat ? cur.query.mode || "panel" : "panel";
  delete query.agent; delete query.team;
  location.hash = toHash({ page: "agents", query });
}
