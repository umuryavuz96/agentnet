<script setup lang="ts">
// The `jira` ui block (docs/CHAT-UI-BLOCKS.md; canvas: Jira). Three states: a draft (dashed, nothing in Jira yet, checkbox rows,
// Create), created (solid, keys and status, the beam runs along the top edge once on Create) and refused (a red row with Jira's
// reason and the retry). Every ticket opens in place to its details and closes on a second press; what sits below slides 200 ms.
// No Jira call here: Create, Retry, Leave it out and Edit send the owner's choice as a message, like a choices pick.
import { computed, nextTick, ref } from "vue";
import Icon from "../../ui/Icon.vue";
import CardSurface from "./CardSurface.vue";
import Chip from "./Chip.vue";
import JiraTicket from "./JiraTicket.vue";
import { createMessage, draftSummary, editMessage, leaveOutMessage, madeCount, retryMessage, ticketCount, type JiraBlock } from "../../chatJira";

const props = defineProps<{ block: JiraBlock; /** the owner's next prompt after this reply, if any: locks the buttons */ answer?: string | null; canSend?: boolean }>();
const emit = defineEmits<{ pick: [text: string] }>();

const root = ref<HTMLElement | null>(null);
const uid = Math.random().toString(36).slice(2, 8);
const isDraft = computed(() => props.block.state === "draft");
const lead = computed(() => props.block.tickets.length === 1 && !props.block.epic);
const checked = ref(props.block.tickets.map(() => true));
const open = ref(props.block.tickets.map((_, i) => (lead.value ? isDraft.value : isDraft.value && i === 0)));
const beam = ref(false), picked = ref(false);
const locked = computed(() => picked.value || props.answer != null || !props.canSend);
const chosen = computed(() => props.block.tickets.filter((_, i) => checked.value[i]));
const made = computed(() => madeCount(props.block.tickets));
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run a change, then slide whatever sits below it from its old place (transform only). */
function slide(change: () => void) {
  const el = root.value, moved: [Element, number][] = [];
  const can = el && !reduced() && typeof el.animate === "function";
  if (can) el!.querySelectorAll("[data-slide]").forEach((n) => moved.push([n, n.getBoundingClientRect().top]));
  change();
  if (!can) return;
  void nextTick(() => requestAnimationFrame(() => moved.forEach(([n, y]) => {
    const d = y - n.getBoundingClientRect().top;
    if (d) n.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.23,1,.32,1)" });
  })));
}
const toggle = (i: number) => slide(() => { open.value = open.value.map((o, j) => (j === i ? !o : o)); });
const check = (i: number) => { checked.value = checked.value.map((c, j) => (j === i ? !c : c)); };
function send(text: string) { if (locked.value) return; picked.value = true; emit("pick", text); }
function create() {
  if (locked.value || beam.value || !chosen.value.length) return;
  const text = createMessage(chosen.value);
  if (reduced()) return send(text);
  beam.value = true;
  setTimeout(() => { beam.value = false; send(text); }, 900);
}
const label = computed(() => (lead.value ? "Create in Jira" : `Create ${ticketCount(chosen.value.length)}`));
const refused = computed(() => props.block.tickets.length - made.value);
const under = computed(() => {
  const n = made.value, r = refused.value, s = (x: number) => (x === 1 ? "1 story" : `${x} stories`);
  return props.block.state === "draft" ? props.block.note ?? "New stories under this epic" : r ? `${s(n)} added, ${r} refused` : `${s(n)} added`;
});
const aria = computed(() => (isDraft.value ? `Jira draft, ${ticketCount(props.block.tickets.length)}, not created yet` : `Jira, ${made.value} of ${props.block.tickets.length} created`));
</script>

<template>
  <section ref="root" :class="['jb', props.block.state]" :aria-label="aria">
    <CardSurface :draft="isDraft" :tint="isDraft ? undefined : '#5399ea'" />
    <i v-if="beam" class="jb-beam" aria-hidden="true" />
    <header class="jb-hd">
      <span class="jb-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="m9 12 2 2 4-4" /></svg></span>
      <b>Jira</b><span>{{ block.project }}{{ block.board ? ", " + block.board : "" }}</span>
      <span class="jb-r">
        <template v-if="isDraft"><span>not in Jira yet</span><span class="jb-badge draft">Draft</span></template>
        <span v-else class="jb-badge">{{ made }} of {{ block.tickets.length }} created</span>
      </span>
    </header>
    <div v-if="block.epic" class="jb-epic" data-slide>
      <span class="jb-eic" role="img" aria-label="Epic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 4 7 13.2h4.1L10.2 20 17 10.6h-4.2z" fill="#fff" /></svg></span>
      <Chip tone="jira" :text="block.epic.key" strong /><b>{{ block.epic.title }}</b><span class="jb-under">{{ under }}</span>
    </div>
    <ul :class="['jb-list', { one: lead }]">
      <li v-for="(t, i) in block.tickets" :key="i" :class="{ 'draft-row': isDraft && !lead }" :data-slide="i ? '' : undefined">
        <JiraTicket :ticket="t" :uid="uid + i" :open="open[i]!" :lead="lead" :draft="isDraft" :checked="checked[i]" :locked="locked" @toggle="toggle(i)" @check="check(i)" @retry="send(retryMessage(t))" @leave="send(leaveOutMessage(t))" />
      </li>
    </ul>
    <footer class="jb-ft" data-slide>
      <template v-if="isDraft">
        <button type="button" class="jb-pill primary" data-lift="pill" :disabled="locked || !chosen.length || beam" @click="create"><Icon name="plus" :size="13" />{{ label }}</button>
        <button type="button" class="jb-pill" data-lift="pill" :disabled="locked || beam" @click="send(editMessage(block.tickets))"><Icon name="pen-line" :size="13" />Edit</button>
        <span class="jb-sum">{{ lead ? `Goes to the ${block.project} backlog` : draftSummary(chosen) }}</span>
      </template>
      <template v-else>
        <a v-if="block.url" class="jb-pill" data-lift="pill" :href="block.url" target="_blank" rel="noopener noreferrer"><Icon name="external-link" :size="13" />Open {{ block.epic ? "the epic" : "it" }} in Jira</a>
        <span v-if="block.backlog" class="jb-sum">{{ block.backlog }}</span>
      </template>
    </footer>
  </section>
</template>

<style scoped>
.jb{--cd:#1e1e21;position:relative;isolation:isolate;display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 14px 14px;border-radius:16px;font-size:13.5px;line-height:1.45;background:var(--cd);overflow:hidden}
:root[data-theme="light"] .jb{--cd:#fbfbfc}
.jb.draft{background:transparent}
.jb>*:not(.cs){position:relative}
.jb-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
.jb-hd b{font-weight:650;color:var(--ink)}
.jb-ico{flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:rgba(38,132,255,.16);color:#4c9aff}
.jb-r{margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.jb-badge{flex:none;padding:0 6px;border-radius:4px;font:650 11px/18px var(--body);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;background:color-mix(in srgb,var(--ink) 10%,transparent);color:color-mix(in srgb,var(--ink) 82%,transparent)}
.jb-badge.draft{background:transparent;color:var(--muted);border:1px dashed var(--muted);line-height:16px}
.jb-epic{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jb-eic{flex:none;display:grid;place-items:center;width:18px;height:18px;border-radius:4px;background:#8e4ec6}
.jb-eic svg{width:18px;height:18px}
.jb-epic b{font-weight:600;font-size:14px}
.jb-under{margin-left:auto;font-size:12.5px;color:var(--muted)}
.jb-list{list-style:none;margin:0;padding:0}
.jb-list>li{border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent)}
.jb-list.one>li{border-top:0}
.jb-ft{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.jb-sum{margin-left:auto;font-size:12.5px;color:var(--muted)}
.jb.created .jb-ft,.jb.refused .jb-ft{border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent);padding-top:10px}
.jb.created:has(.one) .jb-ft:empty,.jb-ft:empty{display:none}
.jb-pill{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border:0;border-radius:999px;font:600 13px var(--body);cursor:pointer;text-decoration:none;background:var(--panel-2);color:var(--ink);box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 12%,transparent),0 1px 2px rgba(0,0,0,.25),0 6px 12px -5px rgba(0,0,0,.35);transition:transform .16s cubic-bezier(.23,1,.32,1),opacity .16s}
.jb-pill.primary{background:var(--sel);color:#07172b;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.4),0 8px 16px -6px color-mix(in srgb,var(--sel) 55%,transparent)}
:root[data-theme="light"] .jb-pill.primary{color:#fff}
.jb-pill:hover:not(:disabled){transform:translateY(-1.5px)}.jb-pill:active:not(:disabled){transform:scale(.97)}
.jb-pill:disabled{opacity:.45;cursor:default}
.jb-pill:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.jb-beam{position:absolute;top:0;left:-170px;width:170px;height:2px;z-index:1;background:linear-gradient(90deg,transparent,var(--sel),transparent);box-shadow:0 0 12px var(--sel);animation:jb-beam 900ms cubic-bezier(.65,0,.35,1) both;pointer-events:none}
@keyframes jb-beam{0%{left:-170px;opacity:0}15%{opacity:1}80%{opacity:1}100%{left:100%;opacity:0}}
@media (prefers-reduced-motion:reduce){.jb-beam{animation:none;display:none}.jb-pill{transition:none}.jb-pill:hover,.jb-pill:active{transform:none}}
@media (max-width:560px){.jb-sum,.jb-under{margin-left:0}}
</style>
