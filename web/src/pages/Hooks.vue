<script setup lang="ts">
// Hooks tab of the Agent network page: every Claude Code hook from ~/.claude/settings.json with a plain description,
// an on/off switch (the server backs up settings.json, validates it and can roll back) and, where a log exists,
// how the hook has been doing (runs, failures, latency, last runs).
import { ref, computed, onMounted, nextTick } from "vue";
import { api, ago, toast } from "../ui/api";
import Icon from "../ui/Icon.vue";
import BentoCard from "../ui/BentoCard.vue";

interface Run { at: number; ms: number | null; ok: boolean; text: string }
interface HookInfo { id: string; event: string; matcher: string | null; command: string; script: string; timeout: number | null; enabled: boolean; name: string; about: string; log: string | null; runs: number; failures: number; avgMs: number | null; p95Ms: number | null; lastAt: number | null; recent: Run[] }
interface Res { hooks: HookInfo[]; backups: string[]; error?: string }

const hooks = ref<HookInfo[]>([]), backups = ref<string[]>([]), err = ref(""), loaded = ref(false), busy = ref<string | null>(null), open = ref<string | null>(null);
const ORDER = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "StopFailure", "SubagentStop", "SessionEnd"];
/** Groups by event: groups with a failing hook first, then the Claude Code event order; failing hooks first inside a group. */
const groups = computed(() => {
  const m = new Map<string, HookInfo[]>();
  for (const h of hooks.value) (m.get(h.event) ?? m.set(h.event, []).get(h.event)!).push(h);
  const rank = (e: string) => (ORDER.indexOf(e) + 99) % 99;
  for (const l of m.values()) l.sort((a, b) => Number(b.failures > 0) - Number(a.failures > 0));
  return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
});
/** Failing events first (open by default, lifecycle order inside), then the rest in lifecycle order. Stable: toggling a card never moves it. */
const ordered = computed(() => [...groups.value.filter(([, l]) => failing(l)), ...groups.value.filter(([, l]) => !failing(l))]);
const failing = (l: HookInfo[]) => l.some((h) => h.failures > 0);
const failCount = computed(() => hooks.value.filter((h) => h.failures > 0).length);
/** A group is open when the owner toggled it, else when it holds a failing hook. */
const toggled = ref<Record<string, boolean>>({});
const isOpen = (ev: string, l: HookInfo[]) => toggled.value[ev] ?? failing(l);
/** Toggle with the grid reflow animated: View Transitions morph every card from its old box to its new one (open grows down only, never wider). */
type VT = { startViewTransition?: (cb: () => Promise<void>) => unknown };
const flip = (ev: string, l: HookInfo[]) => {
  const apply = async () => { toggled.value = { ...toggled.value, [ev]: !isOpen(ev, l) }; await nextTick(); };
  const d = document as Document & VT;
  if (d.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) d.startViewTransition(apply); else void apply();
};
/** The last 5 runs of the event's worst hook (most failures), newest first. */
const worst = (l: HookInfo[]) => [...l].sort((a, b) => b.failures - a.failures || b.runs - a.runs)[0];
const pips = (l: HookInfo[]) => (worst(l)?.recent ?? []).slice(0, 5);
const gmax = (l: HookInfo[]) => Math.max(1, ...l.map((h) => h.p95Ms ?? 0), ...l.map((h) => h.avgMs ?? 0));
function jumpFailing() {
  const g = groups.value.find((x) => failing(x[1])); if (!g) return;
  toggled.value = { ...toggled.value, [g[0]]: true };
  const el = document.getElementById("ev-" + g[0]);
  el?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  el?.querySelector<HTMLElement>(".ah-tog")?.focus({ preventScroll: true });
}
const off = computed(() => hooks.value.filter((h) => !h.enabled).length);
const take = (r: Res) => { hooks.value = r.hooks; backups.value = r.backups; err.value = r.error ?? ""; loaded.value = true; };
async function load() { try { take(await api<Res>("v1/panel/hooks")); } catch (e) { err.value = (e as Error).message; loaded.value = true; } }
async function toggle(h: HookInfo) {
  if (busy.value) return; busy.value = h.id;
  try { take(await api<Res>(`v1/panel/hooks/${h.id}/enabled`, { body: { enabled: !h.enabled } })); toast(`${h.name} ${h.enabled ? "switched on" : "switched off"}`); }
  catch (e) { toast((e as Error).message); } finally { busy.value = null; }
}
async function rollback() {
  if (busy.value) return; busy.value = "rollback";
  try { const r = await api<Res & { restored: string }>("v1/panel/hooks/rollback", { body: {} }); take(r); toast(`Restored ${r.restored}`); }
  catch (e) { toast((e as Error).message); } finally { busy.value = null; }
}
const ms = (n: number | null) => (n == null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
onMounted(load);
</script>

<template>
  <div class="page">
    <header class="ph"><h1>Hooks</h1>
      <button type="button" class="ah-btn" :disabled="!backups.length || !!busy" :title="backups.length ? `Put the newest of ${backups.length} backups of settings.json back` : 'No backup yet'" @click="rollback"><Icon name="history" :size="13" /> Roll back settings</button>
    </header>
    <p class="ah-intro">Hooks run on Claude Code events, before or after Claude acts. Switching one off takes it out of <code>~/.claude/settings.json</code> (a backup is made first); it applies to new sessions.</p>
    <p v-if="err" class="ah-err" role="alert">{{ err }}</p>
    <div class="bento bento-auto bento-2" aria-label="Claude Code hooks">
      <BentoCard size="S" title="Failing" class="ah-t">
        <div class="bv"><b :class="['num', { bad: failCount }]">{{ loaded ? failCount : "–" }}</b><small :class="{ bad: failCount }"><template v-if="failCount">✕ failed a run</template><template v-else>none failed</template></small></div>
        <template #foot><button v-if="failCount" type="button" class="ah-link" @click="jumpFailing">Show the first failing event</button><template v-else>No hook has a failed run in its log</template></template>
      </BentoCard>
      <BentoCard size="S" title="Hooks" class="ah-t">
        <div class="bv"><b class="num">{{ loaded ? hooks.length : "–" }}</b><small>configured</small></div>
        <template #foot>{{ groups.length }} {{ groups.length === 1 ? "event" : "events" }} · {{ off }} switched off</template>
      </BentoCard>

      <p v-if="loaded && !hooks.length && !err" class="ah-empty">No hooks configured.</p>
      <BentoCard v-for="[ev, list] in ordered" :id="'ev-' + ev" :key="ev" size="L" :title="ev" flat head-click :class="{ 'ah-shut': !isOpen(ev, list) }" :style="{ viewTransitionName: 'ev-' + ev }" @head="flip(ev, list)">
        <template #control>
          <span class="ah-pips" role="group" :aria-label="`${list.length} hooks, ${list.filter((h) => h.failures).length} failing`">
            <span class="num ah-cnt">{{ list.length }} {{ list.length === 1 ? "hook" : "hooks" }}</span>
            <span v-if="failing(list)" class="num ah-cnt bad">· ✕ {{ list.filter((h) => h.failures > 0).length }} failing</span>
            <span v-if="pips(list).length" class="ah-pl" :title="`Last 5 runs of ${worst(list)?.name}${pips(list).every((r) => r.ok) ? ': all ok' : ''}`">last 5: {{ worst(list)?.name }}{{ pips(list).every((r) => r.ok) ? ", all ok" : "" }}</span>
            <span v-for="(r, i) in pips(list)" :key="i" :class="['ah-pip', r.ok ? 'ok' : 'bad']" role="img" :aria-label="`${r.ok ? 'run ok' : 'run failed'}, ${ago(r.at / 1000)}, last 5 runs of ${worst(list)?.name}`" :title="`Last 5 runs of ${worst(list)?.name}: ${ago(r.at / 1000)}${r.ok ? '' : ', failed'}`">{{ r.ok ? "" : "×" }}</span>
          </span>
          <button type="button" class="ah-tog" :aria-expanded="isOpen(ev, list)" :aria-controls="'evb-' + ev" :aria-label="`${ev}: ${isOpen(ev, list) ? 'collapse' : 'expand'}`" @click="flip(ev, list)"><Icon name="chevron-down" :size="16" /></button>
        </template>
        <div :id="'evb-' + ev" class="ah-body" :class="{ 'is-open': isOpen(ev, list) }" :inert="!isOpen(ev, list) || undefined">
          <ul class="ah-list">
            <li v-for="h in list" :key="h.id" class="ah-row" :class="{ off: !h.enabled, expanded: open === h.id }">
              <div class="ah-main">
                <button type="button" class="ah-head" :aria-expanded="open === h.id" @click="open = open === h.id ? null : h.id">
                  <span class="ah-name">{{ h.name }}</span>
                  <span v-if="h.matcher" class="ah-tag">on {{ h.matcher }}</span>
                  <span v-if="h.timeout" class="ah-tag num">{{ h.timeout }} s limit</span>
                  <span v-if="h.runs" class="ah-tag num" :class="{ bad: h.failures }">{{ h.runs >= 400 ? "last " : "" }}{{ h.runs }} runs<template v-if="h.failures"> · ✕ {{ h.failures }} failed</template></span>
                </button>
                <p class="ah-about">{{ h.about }}</p>
                <div v-if="h.avgMs != null || h.p95Ms != null" class="ah-lat num" role="img" :aria-label="`Average ${ms(h.avgMs)}, slowest 5 percent ${ms(h.p95Ms)}`">
                  <span class="ah-sc">scale 0 to {{ ms(gmax(list)) }}</span>
                  <span>avg {{ ms(h.avgMs) }}</span><span class="ah-tr"><i :style="{ width: ((h.avgMs ?? 0) / gmax(list)) * 100 + '%' }" /></span>
                  <span>p95 {{ ms(h.p95Ms) }}</span><span class="ah-tr"><i class="p" :style="{ width: ((h.p95Ms ?? 0) / gmax(list)) * 100 + '%' }" /></span>
                </div>
                <div v-if="open === h.id" class="ah-more">
                  <code class="ah-cmd">{{ h.command }}</code>
                  <template v-if="h.log">
                    <dl class="ah-stats num">
                      <div><dt>Runs</dt><dd>{{ h.runs }}</dd></div><div><dt>Failed</dt><dd :class="{ bad: h.failures }">{{ h.failures }}</dd></div>
                      <div><dt>Average</dt><dd>{{ ms(h.avgMs) }}</dd></div><div><dt>Slowest 5%</dt><dd>{{ ms(h.p95Ms) }}</dd></div>
                      <div><dt>Last run</dt><dd>{{ h.lastAt ? ago(h.lastAt / 1000) : "—" }}</dd></div>
                    </dl>
                    <div class="ah-rw"><ol class="ah-runs">
                      <li v-for="r in h.recent" :key="r.at" :class="{ bad: !r.ok }"><span class="num">{{ ago(r.at / 1000) }}</span><span class="num">{{ ms(r.ms) }}</span><span class="ah-txt">{{ r.text || (r.ok ? "ok" : "failed") }}</span></li>
                    </ol></div>
                  </template>
                  <p v-else class="ah-nolog">This hook keeps no log, so there are no run numbers.</p>
                </div>
              </div>
              <button type="button" class="sw" role="switch" :aria-checked="h.enabled" :aria-label="`${h.name}: ${h.enabled ? 'on' : 'off'}`" :class="{ busy: busy === h.id }" :disabled="!!busy" @click="toggle(h)"></button>
            </li>
          </ul>
        </div>
      </BentoCard>
    </div>
  </div>
</template>

<style scoped>
.ah-intro{margin:0;max-width:70ch;color:var(--muted);font:400 13px/1.5 var(--body)}
.ah-intro code,.ah-cmd{font:500 12px var(--mono)}
.ah-btn{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:9px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ah-btn:disabled{opacity:.45;cursor:default}
.ah-btn:focus-visible,.ah-tog:focus-visible,.ah-head:focus-visible,.ah-link:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:8px}
.ah-link{padding:0;min-height:24px;border:0;background:none;color:var(--ink);font:600 12px var(--body);text-decoration:underline;cursor:pointer}
.ah-err{color:var(--warn);margin:0}.ah-empty{grid-column:1/-1;margin:0;color:var(--muted)}
.bad{color:var(--bad)}
.bv .bad{color:var(--bad)}
.ah-pips{display:flex;align-items:center;flex-wrap:wrap;gap:5px}
.ah-cnt{color:var(--muted);font:600 12px var(--mono);margin-right:3px}
.ah-pl{color:var(--muted);font:500 11.5px var(--body);margin:0 2px}
@media(max-width:640px){.ah-pl{display:none}}
.ah-cnt.bad{color:var(--bad)}
.ah-pip{display:inline-grid;place-items:center;width:12px;height:12px;border-radius:50%;font:700 10px/1 var(--mono)}
.ah-pip.ok{background:var(--on)}
.ah-pip.bad{background:var(--bad-bg);color:var(--bad);box-shadow:inset 0 0 0 1.5px var(--bad)}
.ah-tog{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:var(--muted);cursor:pointer}
.ah-tog svg{transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.ah-tog[aria-expanded="true"] svg{transform:rotate(180deg)}
.ah-body{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s var(--ease)}
@media(min-width:1280px){.bc.ah-t{grid-column:span 6}}
.bc.ah-shut{gap:0;padding-bottom:0}
.bc.ah-shut :deep(.bc-hc){padding-bottom:14px}
@media(min-width:1280px){.bc.ah-shut :deep(.bc-hc){padding-bottom:16px}}
.bento-auto > .bc-flat{align-self:start}
.ah-body:not(.is-open){margin-top:-10px}
.ah-body.is-open{grid-template-rows:1fr;opacity:1}
.ah-body > .ah-list{overflow:hidden;min-height:0}
.ah-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ah-row{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--panel-2);transition:opacity .2s,border-color .2s}
.ah-row.expanded{border-color:var(--muted)}
.ah-row.off{opacity:.6}
.ah-main{min-width:0;flex:1}
.ah-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;background:none;border:0;padding:0;color:var(--ink);cursor:pointer;text-align:left;min-height:28px}
.ah-name{font:600 14px var(--body)}
.ah-tag{font:500 11px var(--mono);color:var(--muted);padding:2px 7px;border-radius:999px;border:1px solid var(--line)}
.ah-tag.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,transparent)}
.ah-about{margin:4px 0 0;color:var(--muted);font:400 13px/1.45 var(--body)}
.ah-lat{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:3px 10px;margin-top:8px;max-width:420px;color:var(--muted);font:500 11.5px var(--mono)}
.ah-tr{height:6px;border-radius:3px;background:var(--track);overflow:hidden}
.ah-tr{position:relative}
.ah-sc{grid-column:1/-1;font-size:10.5px}
.ah-tr i{display:block;height:100%;min-width:2px;border-radius:3px;background:var(--chrome)}
.ah-tr i.p{background:var(--ink);opacity:.75}
.ah-more{margin-top:10px;display:flex;flex-direction:column;gap:10px;animation:ahin .2s ease-out}
@keyframes ahin{from{opacity:0;transform:translateY(-4px)}}
.ah-cmd{display:block;padding:8px 10px;border-radius:8px;background:var(--track);overflow-wrap:anywhere;color:var(--muted)}
.ah-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;margin:0}
.ah-stats div{padding:8px 10px;border-radius:10px;background:var(--track)}
.ah-stats dt{font:500 11px var(--body);color:var(--muted)}.ah-stats dd{margin:2px 0 0;font:600 15px var(--body)}
.ah-rw{overflow-x:auto}
.ah-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;min-width:300px}
.ah-runs li{display:grid;grid-template-columns:84px 64px 1fr;gap:10px;font:400 12.5px var(--body);color:var(--muted);padding:3px 0;border-top:1px solid var(--line)}
.ah-runs li.bad{color:var(--bad)}
.ah-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-nolog{margin:0;color:var(--muted);font:400 12.5px var(--body)}
.sw{position:relative;flex:none}
.sw::before{content:"";position:absolute;inset:-8px -2px}
/* Card morph: keep snapshots unstretched (top-left anchored) while the box grows; siblings glide. */
:global(::view-transition-group(*)){animation-duration:.34s;animation-timing-function:cubic-bezier(.2,.8,.2,1);overflow:clip;border-radius:16px}
:global(::view-transition-old(*)){display:none}
:global(::view-transition-new(*)){animation:none;height:100%;width:100%;object-fit:none;object-position:left top}
:global(.bar){view-transition-name:topbar}
:global(::view-transition-group(topbar)){z-index:10;animation:none;border-radius:0}
:global(::view-transition-new(topbar)){object-fit:fill}
:global(::view-transition-old(root)),:global(::view-transition-new(root)){animation:none}
@media (prefers-reduced-motion:reduce){.ah-more{animation:none}.ah-body,.ah-tog svg{transition:none}}
@media (max-width:640px){.ah-runs li{grid-template-columns:70px 54px 1fr}}
</style>
