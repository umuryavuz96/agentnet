<script setup lang="ts">
// A draft (canvas Task, "Draft"): a dashed outline with no fill, because it is not real until someone sends it. At most two
// actions: the first sends (as the owner, like a choices pick), the second puts the text in the composer. After Send the
// outline goes, the surface is back and the card says it was sent. Send runs a beam along the top edge (900 ms), then the card
// flips to sent and the receiver's name rings once (150 ms in, 250 held, 800 out) (canvas Motion, "A draft is sent").
import { computed, ref } from "vue";
import Icon from "../../ui/Icon.vue";
import type { IconName } from "../../ui/icons";
import type { Block } from "../../chatBlocks";
import CardSurface from "./CardSurface.vue";
import DotTile from "./DotTile.vue";
import ToolTile from "./ToolTile.vue";
import { agentHue } from "./agentHue";

type DraftBlock = Extract<Block, { type: "draft" }>;
const props = defineProps<{ block: DraftBlock; canSend?: boolean; /** the owner's next prompt after this reply: the draft was answered */ answer?: string | null }>();
const emit = defineEmits<{ send: [text: string]; edit: [text: string] }>();
const KIND: Record<DraftBlock["kind"], { head: string; state: string; sent: string; icon: IconName; act: string }> = {
  message: { head: "Draft message", state: "not sent", sent: "Sent", icon: "pen-line", act: "Send" },
  commit: { head: "Draft commit", state: "not committed", sent: "Committed", icon: "git-commit-horizontal", act: "Commit" },
  brief: { head: "Draft brief", state: "not sent", sent: "Sent", icon: "file-text", act: "Send" },
  post: { head: "Draft post", state: "not posted", sent: "Posted", icon: "pen-line", act: "Post" },
};
const k = computed(() => KIND[props.block.kind]);
const sentNow = ref(false), beam = ref(false), ring = ref(false);
const sent = computed(() => sentNow.value || props.answer != null);
const labels = computed(() => ({ send: props.block.actions[0] ?? k.value.act, edit: props.block.actions[1] ?? "Edit" }));
const reduce = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function send() {
  if (sent.value || beam.value || !props.canSend) return;
  const done = () => { beam.value = false; sentNow.value = true; emit("send", props.block.body); if (reduce()) return; ring.value = true; setTimeout(() => { ring.value = false; }, 1200); };
  if (reduce()) return done();
  beam.value = true;
  setTimeout(done, 900);
}
</script>

<template>
  <section :class="['dr', { sent }]" :aria-label="`${k.head}: ${block.title}`">
    <CardSurface :draft="!sent" :tint="sent ? 'var(--sel)' : undefined" />
    <span v-if="beam" class="dr-beam" aria-hidden="true"><i /></span>
    <div class="dr-top">
      <ToolTile :kind="sent ? 'info' : 'plain'" :icon="sent ? 'send' : k.icon" />
      <span class="dr-h">{{ sent ? k.sent : k.head }}<template v-if="block.to">{{ " to " }}<span class="dr-rcv"><DotTile :hue="agentHue(block.to)" :state="sent ? 'working' : 'idle'" size="sm" class="dr-to" /><b>{{ block.to }}</b><i v-if="ring" class="dr-ring" aria-hidden="true" /></span></template></span>
      <span class="dr-s">{{ sent ? "sent" : k.state }}</span>
    </div>
    <div :class="['dr-body', { mono: block.kind === 'commit' }]"><b v-if="block.kind !== 'commit'">{{ block.title }}.</b> {{ block.body }}</div>
    <div v-if="!sent" class="dr-acts">
      <button type="button" class="pri" data-lift="pill" :disabled="!canSend || beam" @click="send"><Icon :name="block.kind === 'commit' ? 'check' : 'send'" :size="14" />{{ labels.send }}</button>
      <button v-if="block.actions.length !== 1" type="button" data-lift="pill" :disabled="beam" @click="emit('edit', block.body)"><Icon name="pen-line" :size="14" />{{ labels.edit }}</button>
    </div>
  </section>
</template>

<style scoped>
.dr{position:relative;isolation:isolate;display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 14px 14px;border-radius:16px;font-size:13.5px;line-height:1.45;--cd:#1e1e21}
:root[data-theme="light"] .dr{--cd:#fbfbfc}
.dr.sent{background:var(--cd)}
.dr :deep(.cs){z-index:-1}
.dr-top{display:flex;align-items:center;gap:8px;min-width:0;font-weight:600;font-size:12.5px}
.dr-h{flex:1;min-width:0;overflow-wrap:anywhere;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dr-to{vertical-align:middle}
.dr-s{flex:none;padding:0 9px;border-radius:999px;background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--muted);font:500 11.5px/20px var(--mono)}
.dr-body{padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--ink) 7%,transparent);overflow-wrap:anywhere;white-space:pre-wrap}
.dr-body.mono{font:500 12.5px/1.6 var(--mono)}
.dr.sent .dr-body{padding:0;background:none}
.dr-acts{display:flex;gap:8px;flex-wrap:wrap}
.dr-acts button{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 14px;border:0;border-radius:999px;background:color-mix(in srgb,var(--ink) 10%,transparent);color:var(--ink);font:600 13px var(--body);cursor:pointer;transition:transform .16s cubic-bezier(.23,1,.32,1),background-color .15s var(--ease)}
.dr-acts button.pri{background:var(--sel);color:#0b0d12}
:root[data-theme="light"] .dr-acts button.pri{color:#fff}
.dr-acts button:disabled{opacity:.5;cursor:default}
.dr-acts button:not(:disabled):active{transform:scale(.97)}
@media (hover:hover) and (pointer:fine){.dr-acts button:not(:disabled):hover{transform:translateY(-1.5px)}.dr-acts button:not(:disabled):active{transform:scale(.97)}}
.dr-rcv{position:relative;display:inline-flex;align-items:center;gap:6px}
.dr-ring{position:absolute;inset:-4px -6px;border-radius:9px;pointer-events:none;box-shadow:0 0 0 1.5px var(--sel),0 0 16px color-mix(in srgb,var(--sel) 45%,transparent);opacity:0;animation:dr-ring 1.2s ease-out both}
@keyframes dr-ring{0%{opacity:0}12.5%{opacity:1}33.3%{opacity:1}100%{opacity:0}}
.dr-beam{position:absolute;left:16px;right:16px;top:-1px;height:3px;overflow:hidden;pointer-events:none;border-radius:2px;z-index:1}
.dr-beam i{position:absolute;left:-170px;top:0;width:170px;height:2.5px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--sel) 55%,color-mix(in srgb,var(--sel) 35%,#fff));animation:dr-beam .9s cubic-bezier(.65,0,.35,1) both}
@keyframes dr-beam{0%{left:-170px;opacity:0}15%{opacity:1}80%{opacity:1}100%{left:100%;opacity:0}}
.dr-acts button:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.dr-acts button{transition:none}.dr-acts button:hover,.dr-acts button:active{transform:none}.dr-beam,.dr-ring{display:none}}
</style>
