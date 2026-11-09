<script setup lang="ts">
// Chat tab of the agent panel: the agent's agentnet thread, oldest first, as bubbles (out = sent to the agent, in = sent by it).
// The box sends as root through POST /agentnet/agents/:name/message (panel auth). Messages come from the shared net stream: no extra connection.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net, type Msg } from "../net";
import { api } from "../ui/api";

const props = defineProps<{ name: string; blocked: string | null }>();
const KINDS = ["info", "task", "question"] as const;
const kind = ref<(typeof KINDS)[number]>("info");
const text = ref(""), busy = ref(false), err = ref("");
const list = ref<HTMLElement | null>(null);

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const msgs = computed(() => net.messages.filter((m) => m.from === props.name || m.to === props.name).slice(-60));
/** A day divider before the first message and whenever the day changes. */
const rows = computed(() => msgs.value.map((m, i) => ({ m, div: i === 0 || day(msgs.value[i - 1].at) !== day(m.at) ? day(m.at) : null })));
const mine = (m: Msg) => m.from === "root"; // root is the viewer: its messages sit on the right
const subject = (m: Msg) => m.subject ?? m.body.split("\n")[0].slice(0, 60);

const toEnd = () => nextTick(() => { const el = list.value; if (el) el.scrollTop = el.scrollHeight; });
watch(() => msgs.value.length, toEnd, { flush: "post" });
watch(() => props.name, toEnd);
onMounted(toEnd);

async function send() {
  const body = text.value.trim();
  if (!body || busy.value || props.blocked) return;
  busy.value = true; err.value = "";
  try {
    await api(`v1/panel/agents/${encodeURIComponent(props.name)}/message`, { method: "POST", body: { body, kind: kind.value } });
    text.value = "";
  } catch (e) { err.value = (e as Error).message; }
  finally { busy.value = false; }
}
function onKey(e: KeyboardEvent) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }
</script>

<template>
  <div class="ac">
    <div ref="list" class="ac-list" role="log" aria-live="polite" :aria-label="`Messages with ${name}`">
      <p v-if="!rows.length" class="ac-none">No messages with {{ name }} yet.</p>
      <template v-for="({ m, div }, i) in rows" :key="(m.id ?? 'x') + ':' + m.at + ':' + i">
        <p v-if="div" class="ac-day">{{ div }}</p>
        <article :class="['ac-b', mine(m) ? 'out' : 'in']">
          <p class="ac-h"><span class="ac-kind">{{ m.kind }}</span><span class="ac-who" :title="`${m.from} to ${m.to}`">{{ mine(m) ? "to " + m.to : m.from + " to " + m.to }}</span><time>{{ time(m.at) }}</time></p>
          <p v-if="m.subject && m.subject !== m.body" class="ac-s">{{ subject(m) }}</p>
          <p class="ac-t">{{ m.body }}</p>
        </article>
      </template>
    </div>

    <form class="ac-box" :class="{ off: !!blocked }" @submit.prevent="send">
      <div class="ac-kinds" role="radiogroup" aria-label="Message kind">
        <button v-for="k in KINDS" :key="k" type="button" role="radio" :aria-checked="kind === k" :class="{ on: kind === k }" :disabled="!!blocked" @click="kind = k">{{ k }}</button>
      </div>
      <div class="ac-row">
        <textarea v-model="text" rows="2" :disabled="!!blocked" :placeholder="blocked ?? `Message ${name} as root`" :aria-label="blocked ?? `Message ${name}`" @keydown="onKey" />
        <button class="ac-send" type="submit" :disabled="!!blocked || busy || !text.trim()" aria-label="Send message"><Icon :name="busy ? 'loader' : 'send'" :size="18" :class="{ spin: busy }" /></button>
      </div>
      <p v-if="err" class="ac-err" role="alert">{{ err }}</p>
    </form>
  </div>
</template>

<style scoped>
.ac{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%}
.ac *{min-width:0}
.ac-list{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:grid;gap:8px;align-content:start;padding:16px 16px 24px;scroll-padding-bottom:24px}
.ac-none{margin:0;color:var(--muted);font-size:13px}
.ac-day{margin:6px 0 0;text-align:center;color:var(--muted);font:600 11px/1 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ac-b{display:grid;gap:3px;max-width:88%;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--ink) 4%,transparent)}
.ac-b.out{justify-self:end;border-color:color-mix(in srgb,var(--on) 40%,var(--line));background:color-mix(in srgb,var(--on) 10%,transparent);border-bottom-right-radius:5px}
.ac-b.in{justify-self:start;border-bottom-left-radius:5px}
.ac-h{display:flex;align-items:center;gap:7px;margin:0;font-size:11.5px;line-height:1.3;color:var(--muted)}
.ac-kind{flex:none;padding:1px 6px;border-radius:6px;background:var(--track);font:600 10.5px/1.5 var(--mono)}
.ac-who{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.ac-h time{flex:none;font:500 11px/1 var(--mono)}
.ac-s{margin:0;font:650 13px/1.35 var(--body);overflow-wrap:anywhere}
.ac-t{margin:0;font-size:13px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:12;-webkit-box-orient:vertical;overflow:hidden}

.ac-box{flex:none;display:grid;gap:8px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--panel)}
.ac-kinds{display:flex;gap:4px;overflow:hidden}
.ac-kinds button{flex:1;min-height:32px;padding:0 6px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--muted);font:600 11.5px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease),border-color .2s var(--ease)}
.ac-box.off .ac-kinds button,.ac-box.off textarea{opacity:.5;cursor:not-allowed}
.ac-kinds button.on{background:color-mix(in srgb,var(--on) 14%,transparent);border-color:color-mix(in srgb,var(--on) 50%,var(--line));color:var(--ink)}
.ac-row{display:flex;gap:8px;align-items:flex-end}
.ac-row textarea{flex:1;resize:none;max-height:120px;padding:9px 11px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:inherit;font-size:14px;line-height:1.4}
.ac-row textarea:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ac-send{flex:none;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:var(--on);color:#06210f;cursor:pointer;transition:opacity .2s var(--ease),transform .2s var(--ease)}
.ac-send:disabled{opacity:.35;cursor:default}
.ac-send:not(:disabled):active{transform:scale(.94)}
.ac-err{margin:0;color:var(--bad);font-size:12.5px}
.spin{animation:acspin 1.1s linear infinite}
@keyframes acspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.ac-send,.ac-kinds button{transition:none}}
</style>
