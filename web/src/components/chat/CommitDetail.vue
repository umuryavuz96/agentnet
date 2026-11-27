<script setup lang="ts">
// One commit beside the conversation (the chat's side pane): message, files with their added and removed lines, Copy sha.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Icon from "../../ui/Icon.vue";
import Skel from "../../ui/Skel.vue";
import Chip from "./Chip.vue";
import { copy } from "../../ui/copy";
import { api } from "../../ui/api";
import { loadRef, stateChips, type RefAnswer } from "../../refLookup";

const props = defineProps<{ agent: string; id: string }>();
const emit = defineEmits<{ close: [] }>();
const answer = ref<RefAnswer | null>(null);
const copied = ref<"" | "Copied" | "Copy failed">("");
let t: ReturnType<typeof setTimeout> | undefined;
watch(() => props.agent + "\n" + props.id, async (key) => {
  answer.value = null; copied.value = "";
  const a = await loadRef(props.agent, "sha", props.id, api);
  if (key === props.agent + "\n" + props.id) answer.value = a;
}, { immediate: true });
const c = computed(() => (answer.value?.available && answer.value.kind === "sha" ? answer.value.commit : null));
const repo = computed(() => (answer.value?.available ? answer.value.repo : undefined));
async function copySha() {
  if (!c.value) return;
  copied.value = (await copy(c.value.sha)) ? "Copied" : "Copy failed";
  clearTimeout(t); t = setTimeout(() => (copied.value = ""), 2000);
}
onBeforeUnmount(() => clearTimeout(t));
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }); };
</script>

<template>
  <h3 class="cd-h">
    <Icon name="git-commit-horizontal" :size="15" /><span>{{ c?.short ?? id }}</span>
    <Chip v-for="s in answer ? stateChips(answer) : []" :key="s.text" :tone="s.tone" :text="s.text" />
    <button type="button" class="cd-x" aria-label="Close the commit" title="Close (Esc)" @click="emit('close')"><Icon name="x" :size="15" /></button>
  </h3>
  <div class="cd-b" tabindex="0">
    <template v-if="c">
      <p class="cd-s">{{ c.subject }}</p>
      <p v-if="c.body" class="cd-msg">{{ c.body }}</p>
      <p class="cd-m">{{ c.author }} · {{ when(c.date) }}</p>
      <p v-if="repo || c.branches.length" class="cd-m"><b v-if="repo">{{ repo }}</b> {{ c.branches.join(", ") }}</p>
      <button type="button" class="cd-copy" :title="c.sha" @click="copySha"><Icon name="copy" :size="13" /><span aria-live="polite">{{ copied || "Copy sha" }}</span></button>
      <p class="cd-fh"><b>{{ c.filesChanged }} {{ c.filesChanged === 1 ? "file" : "files" }}</b><span class="add">+{{ c.insertions }}</span><span class="del">−{{ c.deletions }}</span></p>
      <ul class="cd-files">
        <li v-for="f in c.files" :key="f.path"><span>{{ f.path }}</span><template v-if="f.add == null"><i>binary</i></template><template v-else><span class="add">+{{ f.add }}</span><span class="del">−{{ f.del }}</span></template></li>
      </ul>
      <p v-if="c.filesChanged > c.files.length" class="cd-m">The first {{ c.files.length }} of {{ c.filesChanged }} files are listed.</p>
    </template>
    <template v-else-if="answer && !answer.available">
      <p class="cd-s">Not available</p>
      <p class="cd-m">{{ answer.reason }}</p>
    </template>
    <Skel v-else :lines="5" />
  </div>
</template>

<style scoped>
.cd-h{flex:none;display:flex;align-items:center;gap:8px;margin:0;font:650 14px/1.35 var(--mono);color:var(--ink)}
.cd-x{display:grid;place-items:center;width:44px;height:44px;margin:-12px -12px -12px auto;border:0;border-radius:10px;background:transparent;color:var(--muted);cursor:pointer;transition:background-color .22s cubic-bezier(.2,.8,.2,1)}
.cd-x:hover{background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--ink)}
.cd-b{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
.cd-b > *{flex:none}
.cd-b:focus-visible,.cd-x:focus-visible,.cd-copy:focus-visible{outline:2px solid var(--sel);outline-offset:-2px}
.cd-b p{margin:0;overflow-wrap:anywhere}
.cd-s{font:650 15px/1.4 var(--body);color:var(--ink)}
.cd-msg{white-space:pre-wrap;font:400 13px/1.55 var(--body);color:var(--ink)}
.cd-m{font:400 12.5px/1.45 var(--body);color:var(--muted)}
.cd-m b{font-weight:600;color:var(--ink)}
.cd-copy{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 12px 0 10px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--ink);font:600 12px/1 var(--body);cursor:pointer;transition:background-color .15s var(--ease)}
.cd-copy:hover{background:color-mix(in srgb,var(--ink) 8%,transparent)}
.cd-fh{display:flex;gap:8px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--ink) 14%,transparent);font:600 12.5px/1.45 var(--body);color:var(--ink)}
.cd-files{margin:0;padding:0;list-style:none}
.cd-files li{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:baseline;padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--ink) 8%,transparent);font:500 12px/1.45 var(--mono);color:var(--ink)}
.cd-files li > span:first-child{overflow-wrap:anywhere}
.cd-files i{grid-column:2/-1;font-style:normal;color:var(--muted)}
.add,.del{font:600 12px/1.45 var(--mono)}
.add{color:var(--on)}.del{color:var(--bad)}
@media (prefers-reduced-motion:reduce){.cd-x,.cd-copy{transition:none}}
</style>
