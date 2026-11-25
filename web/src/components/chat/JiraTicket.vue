<script setup lang="ts">
// One Jira ticket (canvas: Jira): a row in a list, or the lead of a one-ticket card. The header is a button that opens the
// details in place (fields, description, linked issues) and closes on a second press. In a draft the row has a checkbox;
// a refused row is red with Jira's reason and the retry. Draws only: the block owns what is picked and what is sent.
import { computed } from "vue";
import Icon from "../../ui/Icon.vue";
import { renderMd } from "../../md";
import Chip from "./Chip.vue";
import DotTile from "./DotTile.vue";
import { pointsLabel, type JiraKind, type JiraTicket } from "../../chatJira";

const props = defineProps<{
  ticket: JiraTicket; open: boolean; /** the one ticket of a card: bigger title, no checkbox, no points pill */ lead?: boolean;
  draft?: boolean; checked?: boolean; /** nothing can be sent any more */ locked?: boolean; uid: string;
}>();
const emit = defineEmits<{ toggle: [e: Event]; check: []; retry: []; leave: [] }>();

const KIND: Record<JiraKind, { label: string; bg: string; path: string }> = {
  bug: { label: "Bug", bg: "#e5484d", path: "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" },
  story: { label: "Story", bg: "#3f9f52", path: "M8 5.5h8V19l-4-3.4L8 19z" },
  task: { label: "Task", bg: "#4a8fe0", path: "m8 12.4 2.7 2.7L16 9.6" },
  epic: { label: "Epic", bg: "#8e4ec6", path: "M13.2 4 7 13.2h4.1L10.2 20 17 10.6h-4.2z" },
  subtask: { label: "Subtask", bg: "#4a8fe0", path: "M8 7h5v5h3m0 0-2-2m2 2-2 2" },
};
const PRIO: Record<string, string> = { highest: "M6 14l6-5 6 5M6 18l6-5 6 5", high: "M6 15l6-6 6 6", medium: "M6 9.5h12M6 14.5h12", low: "M6 9l6 6 6-6", lowest: "M6 6l6 5 6-5M6 10l6 5 6-5" };
const k = computed(() => KIND[props.ticket.kind]);
const failed = computed(() => !!props.ticket.error);
const prioTone = computed(() => (props.ticket.priority === "highest" || props.ticket.priority === "high" ? "var(--bad)" : props.ticket.priority === "low" || props.ticket.priority === "lowest" ? "var(--sel)" : "var(--muted)"));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fields = computed(() => {
  const t = props.ticket, f: { label: string; kind?: JiraKind; text?: string; tag?: boolean; who?: boolean; labels?: string[] }[] = [{ label: "Type", kind: t.kind, text: k.value.label }];
  if (props.lead || t.priority) f.push({ label: "Priority", text: t.priority ? cap(t.priority) : undefined });
  if (t.points !== undefined) f.push({ label: "Estimate", text: pointsLabel(t.points) });
  f.push({ label: "Assignee", who: true, text: t.assignee });
  if (t.labels.length) f.push({ label: "Labels", labels: t.labels });
  if (t.component) f.push({ label: "Component", labels: [t.component] });
  return f;
});
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const dots = (s: string) => [...s].reduce((a, c) => (a * 17 + c.charCodeAt(0)) % 512, 9).toString(2).padStart(9, "0").slice(-9);
const statusTone = (s: string) => (/done|closed|resolved/i.test(s) ? "done" : /progress|review/i.test(s) ? "prog" : "todo");
</script>

<template>
  <div :class="['jt', { lead, failed, open }]">
    <div class="jt-head">
      <label v-if="draft && !lead" class="jt-ck"><input type="checkbox" :checked="checked" :disabled="locked" :aria-label="'Create this ticket: ' + ticket.title" @change="emit('check')" /></label>
      <button type="button" class="jt-btn" data-tk :aria-expanded="open" :aria-controls="'jt-' + uid" @click="emit('toggle', $event)">
        <span class="jt-k" role="img" :aria-label="k.label" :style="{ background: k.bg }"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="k.path" :fill="ticket.kind === 'task' || ticket.kind === 'subtask' ? 'none' : '#fff'" stroke="#fff" :stroke-width="ticket.kind === 'task' || ticket.kind === 'subtask' ? 2.2 : 0" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
        <span class="jt-t"><b>{{ ticket.title }}</b><span v-if="failed" class="jt-err">{{ ticket.error }}</span></span>
        <span v-if="!lead && ticket.priority" class="jt-p" :style="{ color: prioTone }"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="PRIO[ticket.priority]" /></svg>{{ cap(ticket.priority) }}</span>
        <span v-if="ticket.key && !failed" class="jt-key"><Chip tone="jira" :text="ticket.key" strong /></span>
        <span v-if="ticket.status && !failed" :class="['jt-st', statusTone(ticket.status)]">{{ ticket.status }}</span>
        <span v-if="failed" class="jt-st bad">Not created</span>
        <span v-if="!lead && ticket.points !== undefined" class="jt-pts" role="img" :aria-label="pointsLabel(ticket.points)">{{ ticket.points }}</span>
        <Icon name="chevron-down" :size="14" class="jt-cv" />
      </button>
    </div>
    <div v-if="failed && !locked" class="jt-fix">
      <button type="button" class="jb-pill primary" data-lift="pill" @click="emit('retry')"><Icon name="rotate-ccw" :size="13" />{{ ticket.fix ?? "Retry" }}</button>
      <button type="button" class="jb-pill" data-lift="pill" @click="emit('leave')">Leave it out</button>
    </div>
    <div :id="'jt-' + uid" :class="['jt-fold', { open }]" :inert="!open || undefined">
      <div class="jt-fold-in"><div class="jt-body">
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized in md.ts -->
        <div v-if="ticket.description" class="ac-md jt-desc" v-html="renderMd(ticket.description)" />
        <dl class="jt-f">
          <div v-for="f in fields" :key="f.label">
            <dt>{{ f.label }}</dt>
            <dd>
              <template v-if="f.kind"><span class="jt-k s" :style="{ background: KIND[f.kind].bg }"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="KIND[f.kind].path" :fill="f.kind === 'task' || f.kind === 'subtask' ? 'none' : '#fff'" stroke="#fff" :stroke-width="f.kind === 'task' || f.kind === 'subtask' ? 2.2 : 0" stroke-linecap="round" stroke-linejoin="round" /></svg></span>{{ f.text }}</template>
              <template v-else-if="f.who"><DotTile v-if="f.text" size="sm" state="idle" :hue="hue(f.text)" :pattern="dots(f.text)" />{{ f.text ?? "" }}<span v-if="!f.text" class="jt-un"><i />Unassigned</span></template>
              <template v-else-if="f.labels"><Chip v-for="l in f.labels" :key="l" tone="plain" :text="l" /></template>
              <template v-else-if="f.label === 'Priority'"><span v-if="f.text" class="jt-pr" :style="{ color: prioTone }"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="PRIO[ticket.priority!]" /></svg>{{ f.text }}</span><span v-else class="jt-mute">Not set</span></template>
              <template v-else>{{ f.text }}</template>
            </dd>
          </div>
        </dl>
        <dl v-if="ticket.links.length" class="jt-l">
          <dt>Linked issues</dt>
          <dd><span v-for="l in ticket.links" :key="l.rel + l.key">{{ l.rel }} <Chip tone="jira" icon="circle-dot" :text="l.title ? l.key + ' ' + l.title : l.key" /></span></dd>
        </dl>
      </div></div>
    </div>
  </div>
</template>

<style scoped>
.jt{min-width:0;--jt-line:color-mix(in srgb,var(--ink) 10%,transparent)}
.jt-head{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center}
.jt-ck{display:grid;place-items:center;width:32px;height:44px;margin-left:-6px;cursor:pointer}
.jt-ck input{width:16px;height:16px;margin:0;accent-color:var(--sel)}
.jt-btn{grid-column:-2/-1;display:grid;grid-template-columns:18px minmax(0,1fr) auto auto auto auto 16px;align-items:center;column-gap:10px;width:100%;min-height:44px;padding:6px 0;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:transform .16s cubic-bezier(.23,1,.32,1)}
.jt-head:not(:has(.jt-ck)) .jt-btn{grid-column:1/-1}
.jt-btn:hover{background:color-mix(in srgb,currentColor 5%,transparent)}
.jt-btn:active{transform:scale(.99)}
.jt-btn:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.jt.failed{margin:6px -8px;padding:4px 8px 10px;border-radius:10px;background:color-mix(in srgb,var(--bad) 8%,transparent)}
.failed .jt-btn{align-items:start}
.jt-k{flex:none;display:grid;place-items:center;width:18px;height:18px;border-radius:4px}
.jt-k svg{width:18px;height:18px}
.jt-k.s{width:16px;height:16px}.jt-k.s svg{width:16px;height:16px}
.jt-t{min-width:0;display:grid;gap:2px}
.jt-t b{min-width:0;font:600 13.5px/1.35 var(--body);overflow-wrap:anywhere}
.lead .jt-btn{grid-template-columns:20px minmax(0,1fr) auto auto 16px;column-gap:10px;padding:4px 0;min-height:0;align-items:start}
.lead .jt-k{width:20px;height:20px;margin-top:1px}.lead .jt-k svg{width:20px;height:20px}
.lead .jt-t b{font:650 16px/1.3 var(--body);letter-spacing:-.01em}
.jt-err{font-size:12.5px;color:color-mix(in srgb,var(--bad) 80%,var(--ink))}
.jt-p,.jt-pr{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;font-size:12.5px;font-weight:500}
.jt-p svg,.jt-pr svg{flex:none;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.jt-st{flex:none;padding:0 6px;border-radius:4px;font:650 11px/18px var(--body);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;background:color-mix(in srgb,var(--ink) 10%,transparent);color:color-mix(in srgb,var(--ink) 82%,transparent)}
.jt-st.prog{background:color-mix(in srgb,var(--sel) 18%,transparent);color:var(--sel)}
.jt-st.done{background:color-mix(in srgb,var(--on) 16%,transparent);color:var(--on)}
.jt-st.bad{background:color-mix(in srgb,var(--bad) 16%,transparent);color:color-mix(in srgb,var(--bad) 80%,var(--ink))}
.jt-pts{flex:none;display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:color-mix(in srgb,var(--ink) 10%,transparent);font:600 11.5px/1 var(--mono);font-variant-numeric:tabular-nums}
.jt-cv{color:var(--muted);transition:transform .2s cubic-bezier(.23,1,.32,1)}
.open .jt-cv{transform:rotate(180deg)}
.failed .jt-cv{margin-top:3px}
.jt-fix{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 6px 28px}
.jt-fold{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s cubic-bezier(.23,1,.32,1)}
.jt-fold.open{grid-template-rows:1fr}
.jt-fold-in{min-height:0;overflow:hidden}
.jt-body{display:grid;gap:10px;margin:2px 0 12px 28px;animation:jt-in .2s cubic-bezier(.23,1,.32,1) both}
.lead .jt-body{margin-left:0}
.draft-row .jt-body{margin-left:60px}
.jt-desc{font-size:14px;line-height:1.5;max-width:66ch}
.jt-desc :deep(p){margin:0 0 6px}
.jt-f{margin:0;padding:10px 12px;border-radius:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px 14px;background:color-mix(in srgb,var(--ink) 5%,transparent)}
.jt-f>div{display:grid;gap:2px;min-width:0}
.jt-f dt,.jt-l dt{font-size:12px;color:var(--muted)}
.jt-f dd{margin:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:600 13px/1.4 var(--body)}
.jt-un{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-weight:500}
.jt-un i{width:16px;height:16px;border-radius:50%;border:1.5px dashed var(--muted)}
.jt-mute{color:var(--muted);font-weight:500}
.jt-l{margin:0;display:grid;gap:4px;min-width:0}
.jt-l dd{margin:0;display:flex;align-items:center;gap:6px 16px;flex-wrap:wrap}
.jt-l dd>span{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px;color:var(--muted)}
.jb-pill{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border:0;border-radius:999px;font:600 13px var(--body);cursor:pointer;background:var(--cd,var(--panel-2));color:var(--ink);box-shadow:0 0 0 .75px color-mix(in srgb,var(--ink) 12%,transparent),0 1px 2px rgba(0,0,0,.25),0 6px 12px -5px rgba(0,0,0,.35);transition:transform .16s cubic-bezier(.23,1,.32,1)}
.jb-pill.primary{background:var(--sel);color:#07172b;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 1px 2px rgba(0,0,0,.4),0 8px 16px -6px color-mix(in srgb,var(--sel) 55%,transparent)}
:root[data-theme="light"] .jb-pill.primary{color:#fff}
.jb-pill:hover{transform:translateY(-1.5px)}.jb-pill:active{transform:scale(.97)}
.jb-pill:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.jb-pill:hover,.jb-pill:active{transform:none}}
@keyframes jt-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.jt-body{animation:none}.jt-fold,.jt-cv{transition:none}.jt-btn:active{transform:none}}
</style>
