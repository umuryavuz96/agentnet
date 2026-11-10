<script setup lang="ts">
// Step 4a of the adopt flow: the director's findings as plain-words cards (spec 7.4). Each card ends in a choice that maps to
// picks.findings[id] = apply | skip; the soul card also keeps a per-agent checklist (picks.skipActions). Nothing here reads a file:
// evidence rows show the path and the redacted quote the report carries.
import { computed, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { toast } from "../ui/api";
import AgentnetAdoptAfter from "./AgentnetAdoptAfter.vue";
import { changeOf, groupFindings, hasPicks, isGlobal, parkedNow, parkGroups, pickedFiles, shortPath, soulName, type AdoptReport, type Finding, type Picks } from "../adopt";

const props = defineProps<{ report: AdoptReport; picks: Picks; busy?: boolean; base?: string }>();
const emit = defineEmits<{ preview: []; back: []; rescan: [] }>();

const groups = computed(() => groupFindings(props.report.findings));
const files = computed(() => pickedFiles(props.report.findings, props.picks));
const empty = computed(() => !groups.value.cards.length && !groups.value.manual.length && !groups.value.system.length);
const open = ref<Record<string, boolean>>({});
const fineOpen = ref(false);
const toggle = (id: string) => (open.value[id] = !open.value[id]);
const pick = (f: Finding, v: "apply" | "skip", expand = false) => { props.picks.findings[f.id] = v; if (expand) open.value[f.id] = true; };
const on = (f: Finding) => props.picks.findings[f.id] === "apply";

const souls = (f: Finding) => f.actions.filter((a) => a.op === "register-souls");
const soulOn = (id: string) => !props.picks.skipActions.includes(id);
function toggleSoul(f: Finding, id: string) {
  const s = props.picks.skipActions, i = s.indexOf(id);
  if (i >= 0) s.splice(i, 1); else s.push(id);
  props.picks.findings[f.id] = souls(f).some((a) => soulOn(a.id)) ? "apply" : "skip";
}
function toggleAllSouls(f: Finding) {
  const all = souls(f).every((a) => soulOn(a.id));
  const ids = souls(f).map((a) => a.id), s = props.picks.skipActions;
  for (const id of ids) { const i = s.indexOf(id); if (all && i < 0) s.push(id); else if (!all && i >= 0) s.splice(i, 1); }
  props.picks.findings[f.id] = all ? "skip" : "apply";
}
const parks = (f: Finding) => (f.suggestion === "switch-off" ? parkGroups(f, props.base) : []);
const groupOn = (g: { actions: { id: string }[] }) => g.actions.some((a) => soulOn(a.id));
function toggleGroup(f: Finding, g: { actions: { id: string }[] }) {
  const s = props.picks.skipActions, turnOff = groupOn(g);
  for (const a of g.actions) { const i = s.indexOf(a.id); if (turnOff && i < 0) s.push(a.id); else if (!turnOff && i >= 0) s.splice(i, 1); }
  if (!turnOff) props.picks.findings[f.id] = "apply";
}
const kindCount = (g: { actions: { op: string }[] }) => { const h = g.actions.filter((a) => a.op === "park-hook").length, m = g.actions.length - h; return [h ? `${h} ${h === 1 ? "hook" : "hooks"}` : "", m ? `${m} MCP ${m === 1 ? "server" : "servers"}` : ""].filter(Boolean).join(" + "); };
const sourceNote = (a: Finding["actions"][number]) => (a.op === "register-souls" ? (a.source === "agent-def" && a.defFile ? a.defFile.split("/").slice(-3).join("/") : "CLAUDE.md only") : "");
const sp = (p: string) => shortPath(p, props.base);
const loc = (e: Finding["evidence"][number]) => sp(e.path) + (e.line ? ":" + e.line : "");
const confLabel = (c: string) => (c === "low" ? "Check this" : c);
async function copy(cmd: string) { try { await navigator.clipboard.writeText(cmd); toast("Copied"); } catch { toast("Copy failed"); } }
const choices = (f: Finding): { v: "apply" | "skip"; label: string; expand?: boolean }[] =>
  f.suggestion === "switch-off" ? [{ v: "apply", label: f.confidence === "high" ? "Switch off (recommended)" : "Switch off" }, { v: "skip", label: "Keep it" }, { v: "skip", label: "Not sure", expand: true }]
  : [{ v: "apply", label: "Replace those lines" }, { v: "skip", label: "Keep, agentnet rules win" }];
const question = (f: Finding) => (f.suggestion === "switch-off" ? "Switch it off for these agents?" : f.suggestion === "neutralise-lines" ? "These lines name an identity or a way to report." : "");
/** Roving radio group: arrows move focus and choose (WAI-ARIA radio pattern). */
function arrow(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d) return;
  const radios = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')];
  const next = radios[(radios.indexOf(document.activeElement as HTMLElement) + d + radios.length) % radios.length];
  e.preventDefault(); next?.focus(); next?.click();
}
const isSel = (f: Finding, c: { v: string; label: string }) => {
  const v = props.picks.findings[f.id];
  if (c.v === "apply") return v === "apply";
  return v === "skip" && (c.label === "Not sure") === !!open.value[f.id];
};
</script>

<template>
  <div class="af">
    <p class="af-sum">{{ report.summary }}<template v-if="report.more"> {{ report.more }} more not shown.</template></p>

    <p v-if="empty" class="af-empty" role="status"><Icon name="shield-check" :size="16" /> Nothing in this folder coordinates agents. You can safely continue.</p>

    <ul class="af-list">
      <li v-for="f in groups.cards" :key="f.id" class="af-card" :class="{ low: f.confidence === 'low' }">
        <div class="af-top">
          <h3>{{ f.title }}</h3>
          <span class="af-pill" :class="f.confidence">{{ confLabel(f.confidence) }}</span>
        </div>
        <p v-if="f.agents.length" class="af-agents"><span>Agents</span> {{ f.agents.join("  ") }}</p>
        <p v-if="isGlobal(f, report.workspace)" class="af-glob"><Icon name="triangle-alert" :size="14" /> Global: affects all your Claude Code sessions</p>
        <p class="af-about">{{ f.about }}</p>
        <div class="af-ch" :class="{ kept: !on(f) }" aria-label="What changes">
          <p class="b"><span>Now</span>{{ changeOf(f, base).before }}</p>
          <p class="a"><span>{{ on(f) ? "After" : "If applied" }}</span>{{ changeOf(f, base).after }}<em v-if="!on(f)">You chose to keep it, so nothing changes.</em></p>
        </div>

        <template v-if="f.evidence.length">
          <button type="button" class="af-ev" :aria-expanded="!!open[f.id]" @click="toggle(f.id)"><Icon name="chevron-down" :size="14" class="chev" /> Evidence ({{ f.evidence.length }})</button>
          <div class="af-x" :class="{ on: open[f.id] }"><ul class="af-in">
            <li v-for="e in f.evidence" :key="e.signal + e.path + (e.line ?? '')"><code class="af-loc">{{ loc(e) }}</code><q v-if="e.quote" class="af-q">{{ e.quote }}</q></li>
          </ul></div>
        </template>

        <ul v-if="parks(f).length > 1" class="af-souls af-park" aria-label="Where to switch off">
          <li v-for="g in parks(f)" :key="g.key">
            <button type="button" role="checkbox" class="af-ck" :aria-checked="groupOn(g) && on(f)" @click="toggleGroup(f, g)">
              <i class="box"><Icon v-if="groupOn(g) && on(f)" name="check" :size="13" /></i><b>{{ g.label }}</b><span>{{ kindCount(g) }}</span>
            </button>
          </li>
        </ul>

        <template v-if="f.suggestion === 'adopt-as-souls'">
          <button type="button" role="checkbox" class="af-ck all" :aria-checked="souls(f).every((a) => soulOn(a.id)) && on(f)" @click="toggleAllSouls(f)">
            <i class="box"><Icon v-if="souls(f).every((a) => soulOn(a.id)) && on(f)" name="check" :size="13" /></i> Add all as workspace souls
          </button>
          <ul class="af-souls" aria-label="Agents to add">
            <li v-for="a in souls(f)" :key="a.id">
              <button type="button" role="checkbox" class="af-ck" :aria-checked="soulOn(a.id) && on(f)" @click="toggleSoul(f, a.id)">
                <i class="box"><Icon v-if="soulOn(a.id) && on(f)" name="check" :size="13" /></i><b>{{ soulName(a) }}</b><span>{{ sourceNote(a) }}</span>
              </button>
            </li>
          </ul>
        </template>
        <template v-else>
          <p class="af-q2" :id="'q-' + f.id">{{ question(f) }}</p>
          <div class="af-seg" role="radiogroup" :aria-labelledby="'q-' + f.id" @keydown="arrow">
            <button v-for="c in choices(f)" :key="c.label" type="button" role="radio" class="af-opt" :class="{ sel: isSel(f, c), prime: c.v === 'apply' }" :aria-checked="isSel(f, c)" :tabindex="isSel(f, c) ? 0 : -1" @click="pick(f, c.v, c.expand)">{{ c.label }}</button>
          </div>
        </template>
      </li>
    </ul>

    <ul v-if="groups.system.length" class="af-list">
      <li v-for="f in groups.system" :key="f.id" class="af-card sys">
        <div class="af-top"><h3>{{ f.title }}</h3><span class="af-pill" :class="parkedNow(f, report.findings, picks) ? 'high' : 'medium'">{{ parkedNow(f, report.findings, picks) ? "Parked" : "Keeps running" }}</span></div>
        <p class="af-about">{{ f.about }}</p>
        <p class="af-sys"><Icon :name="parkedNow(f, report.findings, picks) ? 'check' : 'circle'" :size="14" /> {{ parkedNow(f, report.findings, picks) ? "Parked by the actions above. Nothing is left to do by hand." : "Keeps running beside agentnet. Switch off the cards above to park it." }}</p>
      </li>
    </ul>

    <ul v-if="groups.manual.length" class="af-list">
      <li v-for="f in groups.manual" :key="f.id" class="af-card manual">
        <div class="af-top"><h3>Do by hand: {{ f.title }}</h3><span class="af-pill manual">manual</span></div>
        <p class="af-about">{{ f.about }}</p>
        <ul class="af-cmds">
          <li v-for="a in f.actions" :key="a.id">
            <template v-if="a.op === 'manual'">
              <span class="af-ct">{{ a.title }}</span>
              <div v-if="a.command" class="af-cmd"><code>{{ a.command }}</code><button type="button" class="af-cp" :aria-label="'Copy ' + a.command" @click="copy(a.command)"><Icon name="copy" :size="14" /> Copy</button></div>
            </template>
          </li>
        </ul>
        <button type="button" class="af-b ghost" :disabled="busy" @click="emit('rescan')">I did it, scan again</button>
      </li>
    </ul>

    <template v-if="groups.fine.length">
      <button type="button" class="af-ev fine" :aria-expanded="fineOpen" @click="fineOpen = !fineOpen"><Icon name="chevron-down" :size="14" class="chev" /> Looks fine ({{ groups.fine.length }})</button>
      <div class="af-x" :class="{ on: fineOpen }"><ul class="af-in fine">
        <li v-for="f in groups.fine" :key="f.id"><b>{{ f.title }}</b> {{ f.about }}</li>
      </ul></div>
    </template>

    <AgentnetAdoptAfter v-if="!empty || report.findings.length" :report="report" :picks="picks" :base="base" />

    <div class="af-foot">
      <button type="button" class="af-b ghost" @click="emit('back')">Back</button>
      <button type="button" class="af-b" :disabled="busy" @click="emit('preview')">{{ busy ? "Preparing…" : empty ? "Continue" : hasPicks(report.findings, picks) ? `Preview changes (${files.length} ${files.length === 1 ? "file" : "files"})` : "Preview changes" }}</button>
    </div>
  </div>
</template>

<style scoped>
.af{display:grid;gap:12px;min-width:0}
.af *{min-width:0}
.af-sum{margin:0;font-size:13.5px;line-height:1.45}
.af-empty{display:flex;gap:8px;align-items:center;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--on) 45%,var(--line));border-radius:12px;font-size:13.5px}
.af-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.af-card{display:grid;gap:8px;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.af-card.low{border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.af-top{display:flex;align-items:flex-start;gap:8px}
.af-top h3{flex:1;margin:0;font:650 14.5px/1.3 var(--body);text-transform:none;letter-spacing:0;color:var(--ink)}
.af-pill{flex:none;padding:2px 9px;border-radius:999px;font:600 11.5px/1.5 var(--body);background:var(--track);color:var(--muted)}
.af-pill.high{background:var(--on-bg);color:color-mix(in srgb,var(--on) 70%,var(--ink))}
.af-pill.medium{background:var(--warn-bg);color:color-mix(in srgb,var(--warn) 65%,var(--ink))}
.af-pill.low{background:var(--warn-bg);color:color-mix(in srgb,var(--warn) 65%,var(--ink));outline:1px solid color-mix(in srgb,var(--warn) 50%,transparent)}
.af-agents{margin:0;font:500 12.5px var(--mono);word-spacing:.35em;color:var(--ink)}
.af-agents span{margin-right:6px;color:var(--muted);font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;word-spacing:0}
.af-glob{display:flex;gap:6px;align-items:center;margin:0;padding:6px 10px;border-radius:10px;background:var(--bad-bg);color:var(--bad);font:600 12.5px var(--body)}
.af-about{margin:0;font-size:13.5px;line-height:1.45}
.af-ch{display:grid;gap:4px;padding:8px 10px;border-radius:10px;background:var(--track);font-size:12.5px;line-height:1.45}
.af-ch p{margin:0}
.af-ch span{color:var(--muted);font:600 11px/1.6 var(--body);letter-spacing:.06em;text-transform:uppercase}
.af-ch .a{color:var(--ink);display:block}.af-ch .a span{display:inline-block;width:60px;margin-right:6px}.af-ch .b{display:block}.af-ch .b span{display:inline-block;width:60px;margin-right:6px}.af-ch em{display:block;margin-left:66px;font-style:normal;color:var(--muted)}.af-ch.kept .a{color:var(--muted)}
.af-q2{margin:2px 0 0;font:600 13px var(--body)}
.af-ev{justify-self:start;display:inline-flex;align-items:center;gap:6px;min-height:44px;margin:-6px 0;padding:0 4px;border:0;background:none;color:var(--muted);font:600 12.5px var(--body);cursor:pointer;border-radius:8px}
.af-ev:hover{color:var(--ink)}
.af-ev .chev{transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.af-ev[aria-expanded="true"] .chev{transform:rotate(180deg)}
.af-x{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1)}
.af-x.on{grid-template-rows:1fr}
.af-in{overflow:hidden;margin:0;padding:0;list-style:none;display:grid;gap:6px;visibility:hidden;transition:visibility 0s .28s}
.af-x.on .af-in{visibility:visible;transition-delay:0s;padding-bottom:4px}
.af-in li{display:grid;gap:2px;padding:6px 10px;border-radius:10px;background:var(--track)}
.af-in.fine li{display:block;font-size:12.5px;color:var(--muted)}
.af-in.fine b{color:var(--ink)}
.af-loc{font:500 12px var(--mono);word-break:break-all;color:var(--ink)}
.af-q{font:12px/1.4 var(--mono);color:var(--muted);quotes:none;word-break:break-word}
.af-seg{display:flex;flex-wrap:wrap;gap:8px}
.af-opt{min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink);font:600 13px var(--body);cursor:pointer;transition:background .15s var(--ease),border-color .15s var(--ease)}
.af-opt:hover{border-color:var(--muted)}
.af-opt.sel{border-color:var(--on);background:var(--on-bg)}
.af-opt.sel.prime{background:var(--on);border-color:var(--on);color:#06210f}
.af-ck{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 6px;border:0;border-radius:10px;background:none;color:var(--ink);font:500 13px var(--body);text-align:left;cursor:pointer}
.af-ck.all{font-weight:600}
.af-ck:hover{background:var(--track)}
.af-ck b{font:600 12.5px var(--mono)}
.af-ck span{margin-left:auto;color:var(--muted);font:12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.box{flex:none;display:grid;place-items:center;width:20px;height:20px;border:1.5px solid var(--muted);border-radius:6px;font-style:normal;transition:background .15s,border-color .15s}
.af-ck[aria-checked="true"] .box{background:var(--on);border-color:var(--on);color:#06210f}
.af-souls{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:2px 8px}
.af-park{grid-template-columns:1fr}
.af-sys{display:flex;gap:6px;align-items:center;margin:0;font:600 12.5px var(--body);color:var(--muted)}
.af-cmds{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.af-ct{font:600 12.5px var(--body);color:var(--muted)}
.af-cmd{display:flex;align-items:center;gap:8px;margin-top:4px;padding:6px 6px 6px 10px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.af-cmd code{flex:1;font:12px var(--mono);word-break:break-all;user-select:all}
.af-cp{flex:none;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.af-foot{display:flex;justify-content:space-between;gap:10px;position:sticky;bottom:0;margin:0 -12px;padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px));background:var(--panel-2);border-top:1px solid var(--line)}
.af-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer}
.af-b:disabled{opacity:.35;cursor:default}
.af-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink);justify-self:start}
.af-opt:focus-visible,.af-ev:focus-visible,.af-ck:focus-visible,.af-cp:focus-visible,.af-b:focus-visible{outline:2px solid var(--on);outline-offset:1px}
:global(:root[data-theme="light"] .af-b:not(.ghost)){color:#fff}
:global(:root[data-theme="light"] .af-opt.sel.prime){color:#fff}
:global(:root[data-theme="light"] .af-ck[aria-checked="true"] .box){color:#fff}
@media (max-width:640px){.af-seg{flex-direction:column}.af-opt{width:100%}.af-foot .af-b:not(.ghost){flex:1}}
@media (prefers-reduced-motion:reduce){.af-x,.af-ev .chev,.box,.af-opt{transition:none}}
</style>
