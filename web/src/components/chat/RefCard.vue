<script setup lang="ts">
// The hover card of a commit or pull request chip. It lies over the page (nothing moves under it), is placed once from the
// chip's box, below it or above when there is no room, and keeps the edge next to the chip when its text arrives.
import { computed } from "vue";
import Icon from "../../ui/Icon.vue";
import Skel from "../../ui/Skel.vue";
import Chip from "./Chip.vue";
import { checksLine, stateChips } from "../../refLookup";
import type { Card } from "./useRefChips";

const props = defineProps<{ card: Card | null }>();
const emit = defineEmits<{ enter: []; leave: [] }>();
const W = 360, ROOM = 260, GAP = 6;
const place = computed(() => {
  const r = props.card?.rect; if (!r) return {};
  const left = Math.max(8, Math.min(r.left, innerWidth - W - 8)) + "px";
  return r.bottom + GAP + ROOM <= innerHeight || r.top < ROOM ? { left, top: r.bottom + GAP + "px" } : { left, bottom: innerHeight - r.top + GAP + "px" };
});
const a = computed(() => props.card?.answer ?? null);
const commit = computed(() => (a.value?.available && a.value.kind === "sha" ? a.value.commit : null));
const pr = computed(() => (a.value?.available && a.value.kind === "pr" ? a.value.pr : null));
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }); };
const repo = computed(() => (a.value?.available ? a.value.repo : undefined));
const branches = computed(() => { const b = commit.value?.branches ?? []; return b.length > 3 ? `${b.slice(0, 3).join(", ")} and ${b.length - 3} more` : b.join(", "); });
</script>

<template>
  <Teleport to="body">
    <Transition name="rfc">
      <div v-if="card" id="ref-card" :key="card.kind + card.id" class="rfc" role="tooltip" :style="place" :aria-busy="!a" @pointerenter="emit('enter')" @pointerleave="emit('leave')">
        <p class="rfc-h">
          <Icon :name="card.kind === 'sha' ? 'git-commit-horizontal' : 'git-pull-request'" :size="14" />
          <b>{{ card.kind === "sha" ? commit?.short ?? card.id : "PR #" + card.id }}</b>
          <span class="rfc-st"><Chip v-for="s in a ? stateChips(a) : []" :key="s.text" :tone="s.tone" :text="s.text" /></span>
        </p>
        <template v-if="commit">
          <p class="rfc-t">{{ commit.subject }}</p>
          <p class="rfc-m">{{ commit.author }} · {{ when(commit.date) }}</p>
          <p class="rfc-m"><b v-if="repo">{{ repo }}</b><span>{{ branches ? "on " + branches : "on no branch" }}</span></p>
          <p class="rfc-m"><span>{{ commit.filesChanged }} {{ commit.filesChanged === 1 ? "file" : "files" }}</span><span class="add">+{{ commit.insertions }}</span><span class="del">−{{ commit.deletions }}</span></p>
          <p class="rfc-f">Click for the message and files</p>
        </template>
        <template v-else-if="pr">
          <p class="rfc-t">{{ pr.title }}</p>
          <p class="rfc-m">{{ pr.author }}</p>
          <p class="rfc-m"><b v-if="repo">{{ repo }}</b><span>{{ pr.branch }} into {{ pr.base }}</span></p>
          <p class="rfc-m">{{ checksLine(pr.checks) }}</p>
          <p class="rfc-f">Click to open the pull request in a new tab</p>
        </template>
        <template v-else-if="a && !a.available">
          <p class="rfc-t">Not available</p>
          <p class="rfc-m">{{ a.reason }}</p>
        </template>
        <Skel v-else :lines="4" class="rfc-load" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rfc{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:360px;max-width:calc(100vw - 16px);min-height:152px;padding:12px 14px;border-radius:14px;background:var(--card,var(--panel));color:var(--ink);box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 16%,transparent),0 12px 28px -8px rgba(0,0,0,.6),0 28px 56px -24px rgba(0,0,0,.7)}
:root[data-theme="light"] .rfc{background:#fff;box-shadow:0 0 0 .75px rgba(22,22,26,.12),0 10px 24px -8px rgba(22,22,26,.2),0 28px 56px -24px rgba(22,22,26,.3)}
.rfc p{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;min-width:0;margin:0;overflow-wrap:anywhere}
.rfc-h{font:600 12.5px/20px var(--mono)}
.rfc-h .icon{color:var(--muted)}
.rfc-st{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px;margin-left:auto}
.rfc p.rfc-t{font:600 13.5px/1.4 var(--body)}
.rfc-m{font:400 12px/1.45 var(--body);color:var(--muted)}
.rfc-m b{font-weight:600;color:var(--ink)}
.rfc-m span{min-width:0}
.rfc-m .add,.rfc-m .del{font:600 12px/1.45 var(--mono)}
.add{color:var(--on)}.del{color:var(--bad)}
.rfc p.rfc-f{margin-top:auto;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--ink) 11%,transparent);font:500 11.5px/1.3 var(--body);color:var(--muted)}
.rfc-load{margin-top:2px}
.rfc-enter-active{transition:opacity .16s cubic-bezier(.23,1,.32,1),transform .16s cubic-bezier(.23,1,.32,1)}
.rfc-leave-active{transition:opacity .12s cubic-bezier(.4,0,1,1),transform .12s cubic-bezier(.4,0,1,1);pointer-events:none}
.rfc-enter-from,.rfc-leave-to{opacity:0;transform:translateY(4px)}
@media (prefers-reduced-motion:reduce){.rfc-enter-active,.rfc-leave-active{transition:opacity .12s linear}.rfc-enter-from,.rfc-leave-to{transform:none}}
</style>
