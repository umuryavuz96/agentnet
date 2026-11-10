<script setup lang="ts">
// The update sheet. It only draws the state machine's phase (ui/update.ts); useUpdate.ts talks to the server.
// Release notes are GitHub Markdown, read by ui/update.ts into plain nodes. Nothing here uses v-html.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "../ui/api";
import BentoCard from "../ui/BentoCard.vue";
import Icon from "../ui/Icon.vue";
import type { IconName } from "../ui/icons";
import { STEP_LABEL, type Model, type Step } from "../ui/update";
import UpdateNotes from "./UpdateNotes.vue";

const props = defineProps<{ open: boolean; m: Model; now: number; canCheck: boolean; checking: boolean }>();
const emit = defineEmits<{ close: []; ask: []; cancel: []; start: []; check: []; dismiss: []; reload: [] }>();

const CLI = "bin/agentnet update";
const sheet = ref<HTMLElement | null>(null);
const newsOpen = ref(true), logOpen = ref(false), doneNewsOpen = ref(true);

const st = computed(() => props.m.status);
const phase = computed(() => props.m.phase);
const from = computed(() => (st.value ? `v${st.value.current}` : props.m.from));
const to = computed(() => (st.value?.latest ? `v${st.value.latest}` : props.m.to));
const published = computed(() => {
  const d = st.value?.published ? new Date(st.value.published) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
});
const releaseUrl = computed(() => (st.value?.releaseUrl?.startsWith("https://") ? st.value.releaseUrl : ""));
const blockedHint = computed(() => (st.value?.web.blocked?.hint ?? (st.value && !st.value.web.enabled ? "Web updates are off on this machine." : "")) || "");

const ICON: Record<Step["state"], IconName> = { pending: "circle", running: "loader", ok: "circle-check", failed: "circle-x", skipped: "minus" };
const took = (ms?: number) => (ms === undefined ? "" : ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const waited = computed(() => (props.m.waitSince === null ? 0 : Math.max(0, Math.floor((props.now - props.m.waitSince) / 1000))));
const showSteps = computed(() => ["running", "restarting", "lost", "rolled-back", "rollback-failed", "done"].includes(phase.value));

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Select the text and copy it by hand"); }
}

// ---- sheet behaviour: focus trap, Esc, scroll lock ----
const prevFocus = ref<HTMLElement | null>(null);
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { emit("close"); return; }
  if (e.key !== "Tab" || !sheet.value) return;
  const f = [...sheet.value.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],summary,[tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0]!, last = f[f.length - 1]!;
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
watch(() => props.open, async (o) => {
  document.documentElement.style.overflow = o ? "hidden" : "";
  if (o) { prevFocus.value = document.activeElement as HTMLElement; await nextTick(); sheet.value?.querySelector<HTMLElement>(".us-x")?.focus(); }
  else prevFocus.value?.focus();
});
onBeforeUnmount(() => { document.documentElement.style.overflow = ""; });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="us-wrap" @keydown="key">
      <div class="us-scrim" @click="emit('close')"></div>
      <aside ref="sheet" class="us" role="dialog" aria-modal="true" aria-label="Update agentnet">
        <header class="us-h">
          <h2>Update agentnet</h2>
          <button type="button" class="us-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="18" /></button>
        </header>
        <div class="us-body" aria-live="polite">
          <p v-if="m.error" class="us-err" role="alert">{{ m.error }}</p>

          <!-- nothing newer -->
          <BentoCard v-if="phase === 'none'" size="F" flat title="You are up to date">
            <p class="us-p">agentnet {{ from }} is the newest release this machine knows about.</p>
            <p v-if="st?.checkedAt" class="us-meta">Last checked {{ new Date(st.checkedAt * 1000).toLocaleString() }}.</p>
            <p v-if="st && !st.checkEnabled" class="us-meta">The release check is off (AGENTNET_UPDATE_CHECK=0).</p>
            <p v-if="st?.error" class="us-meta">Last check failed: {{ st.error }}</p>
            <div v-if="canCheck && st?.checkEnabled" class="us-act"><button type="button" class="us-btn" :disabled="checking" @click="emit('check')">{{ checking ? "Checking…" : "Check now" }}</button></div>
          </BentoCard>

          <!-- available / blocked / confirm -->
          <template v-if="phase === 'available' || phase === 'blocked' || phase === 'confirm'">
            <BentoCard size="F" flat title="New release">
              <div class="us-ver"><b class="num">{{ from }}</b><Icon name="arrow-right" :size="16" /><b class="num us-new">{{ to }}</b></div>
              <p class="us-meta"><template v-if="published">Released {{ published }}. </template><a v-if="releaseUrl" :href="releaseUrl" target="_blank" rel="noopener noreferrer">Release page <Icon name="external-link" :size="12" /></a></p>
            </BentoCard>

            <BentoCard size="F" flat title="What's new" head-click @head="newsOpen = !newsOpen">
              <template #control><button type="button" class="us-tg" :aria-expanded="newsOpen" aria-label="Show or hide what's new" @click="newsOpen = !newsOpen"><Icon name="chevron-down" :size="16" :class="{ up: newsOpen }" /></button></template>
              <div class="us-dw" :class="{ 'is-open': newsOpen }" :inert="!newsOpen || undefined"><div class="us-d">
                <UpdateNotes :md="st?.notes ?? ''" />
              </div></div>
            </BentoCard>

            <BentoCard v-if="phase === 'blocked'" size="F" flat title="Cannot update from this page">
              <p class="us-p">{{ blockedHint }}</p>
              <p class="us-meta">Update from a terminal on the machine instead:</p>
              <div class="us-cmd"><code>{{ CLI }}</code><button type="button" class="us-cp" aria-label="Copy the command" @click="copy(CLI)"><Icon name="copy" :size="14" /></button></div>
              <div class="us-act"><button type="button" class="us-btn pri" disabled>Update now</button><button v-if="canCheck && st?.checkEnabled" type="button" class="us-btn" :disabled="checking" @click="emit('check')">{{ checking ? "Checking…" : "Check now" }}</button></div>
            </BentoCard>

            <BentoCard v-else-if="phase === 'confirm'" size="F" flat :title="`Update to ${to}?`">
              <p v-if="st?.mode === 'foreground'" class="us-meta">Runs in the foreground. Update restarts it in the background; to keep it on after reboots run agentnet install-service.</p>
              <p class="us-p">agentnet restarts. Agents keep running; this page reconnects by itself. If the update fails, agentnet goes back to {{ from }} on its own.</p>
              <div class="us-act"><button type="button" class="us-btn pri" @click="emit('start')">Update</button><button type="button" class="us-btn" @click="emit('cancel')">Cancel</button></div>
            </BentoCard>

            <div v-else class="us-act">
              <p v-if="st?.mode === 'foreground'" class="us-meta us-fg">Runs in the foreground. Update restarts it in the background; to keep it on after reboots run agentnet install-service.</p>
              <button type="button" class="us-btn pri" @click="emit('ask')">Update now</button>
              <button v-if="canCheck && st?.checkEnabled" type="button" class="us-btn" :disabled="checking" @click="emit('check')">{{ checking ? "Checking…" : "Check now" }}</button>
            </div>
          </template>

          <!-- running / restarting / lost -->
          <BentoCard v-if="phase === 'running'" size="F" flat :title="`Updating ${m.from || from} to ${m.to || to}`">
            <p class="us-p">Keep this page open or close it. The update goes on either way.</p>
          </BentoCard>
          <BentoCard v-else-if="phase === 'restarting'" size="F" flat title="Restarting agentnet…">
            <p class="us-p"><Icon name="loader" :size="14" class="us-spin" /> Waiting for the new version to answer ({{ waited }} s). This page reconnects by itself.</p>
          </BentoCard>
          <BentoCard v-else-if="phase === 'lost'" size="F" flat title="agentnet did not come back" class="us-bad">
            <p class="us-p">agentnet did not come back. Check it on the machine:</p>
            <div class="us-cmd"><code>bin/agentnet status</code><button type="button" class="us-cp" aria-label="Copy the command" @click="copy('bin/agentnet status')"><Icon name="copy" :size="14" /></button></div>
            <p class="us-meta">This page keeps trying and picks up again if agentnet answers.</p>
          </BentoCard>

          <!-- done -->
          <template v-if="phase === 'done'">
            <BentoCard size="F" flat :title="`Updated to ${m.to}`" class="us-ok">
              <p class="us-p">agentnet is running {{ m.to }}. Reload the page to load the new web app.</p>
              <div class="us-act"><button type="button" class="us-btn pri" @click="emit('reload')">Reload page</button><button type="button" class="us-btn" @click="emit('dismiss'); emit('close')">Close</button></div>
            </BentoCard>
            <BentoCard v-if="m.result?.changelog" size="F" flat title="What's new" head-click @head="doneNewsOpen = !doneNewsOpen">
              <template #control><button type="button" class="us-tg" :aria-expanded="doneNewsOpen" aria-label="Show or hide what's new" @click="doneNewsOpen = !doneNewsOpen"><Icon name="chevron-down" :size="16" :class="{ up: doneNewsOpen }" /></button></template>
              <div class="us-dw" :class="{ 'is-open': doneNewsOpen }" :inert="!doneNewsOpen || undefined"><div class="us-d">
                <UpdateNotes :md="m.result?.changelog ?? ''" />
              </div></div>
            </BentoCard>
          </template>

          <!-- rolled back -->
          <BentoCard v-if="phase === 'rolled-back'" size="F" flat :title="`Update failed, back on ${m.result?.from ?? from}`" class="us-warn">
            <p class="us-p"><Icon name="rotate-ccw" :size="14" /> {{ m.result?.reason || "The update did not finish." }}</p>
            <p class="us-meta">agentnet runs the version it had before. Automatic updates skip this release until a newer one comes out.</p>
            <button type="button" class="us-lg" :aria-expanded="logOpen" @click="logOpen = !logOpen">Show the step log <Icon name="chevron-down" :size="14" :class="{ up: logOpen }" /></button>
            <div class="us-dw" :class="{ 'is-open': logOpen }" :inert="!logOpen || undefined"><div class="us-d"><pre class="us-pre">{{ m.steps.filter((s) => s.state !== 'pending').map((s) => `${STEP_LABEL[s.id]}: ${s.state}${s.detail ? ' - ' + s.detail : ''}`).join('\n') }}</pre></div></div>
            <div class="us-act"><button type="button" class="us-btn" @click="emit('dismiss'); emit('close')">Close</button></div>
          </BentoCard>

          <!-- rollback failed -->
          <BentoCard v-if="phase === 'rollback-failed'" size="F" flat title="Update failed and rollback failed" class="us-bad">
            <p class="us-p"><Icon name="triangle-alert" :size="14" /> {{ m.result?.reason || "agentnet could not go back to the old version." }} Run these commands on the machine:</p>
            <div v-for="(c, i) in m.result?.manual ?? []" :key="i" class="us-cmd"><code>{{ c }}</code><button type="button" class="us-cp" aria-label="Copy the command" @click="copy(c)"><Icon name="copy" :size="14" /></button></div>
            <div class="us-act"><button v-if="m.result?.manual?.length" type="button" class="us-btn pri" @click="copy((m.result?.manual ?? []).join('\n'))">Copy all</button></div>
          </BentoCard>

          <!-- refused -->
          <BentoCard v-if="phase === 'refused'" size="F" flat title="The update did not start">
            <p class="us-p">{{ m.result?.hint || m.result?.reason }}</p>
            <p class="us-meta">Fix that, or update from a terminal on the machine:</p>
            <div class="us-cmd"><code>{{ CLI }}</code><button type="button" class="us-cp" aria-label="Copy the command" @click="copy(CLI)"><Icon name="copy" :size="14" /></button></div>
            <div class="us-act"><button type="button" class="us-btn" @click="emit('dismiss')">Close</button></div>
          </BentoCard>

          <!-- steps -->
          <BentoCard v-if="showSteps" size="F" flat title="Steps">
            <ol class="us-steps">
              <li v-for="s in m.steps" :key="s.id" :class="'s-' + s.state">
                <Icon :name="ICON[s.state]" :size="16" :class="{ 'us-spin': s.state === 'running' }" />
                <span class="us-sl">{{ STEP_LABEL[s.id] }}
                  <small v-if="s.state === 'running' && m.log" class="us-sd">{{ m.log }}</small>
                  <small v-else-if="s.state === 'failed' && s.detail" class="us-sd">{{ s.detail }}</small>
                </span>
                <span class="us-st num">{{ took(s.ms) }}</span>
              </li>
            </ol>
          </BentoCard>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.us-wrap{position:fixed;inset:0;z-index:60}
.us-scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);animation:usf .2s ease-out}
.us{position:absolute;top:0;right:0;bottom:0;width:min(480px,100%);display:flex;flex-direction:column;background:var(--bg);border-left:1px solid var(--line);color:var(--ink);animation:uss .3s cubic-bezier(.2,.8,.2,1)}
@keyframes usf{from{opacity:0}}@keyframes uss{from{transform:translateX(24px);opacity:0}}
@media(max-width:640px){.us{top:auto;width:100%;height:min(88vh,100%);border-left:0;border-top:1px solid var(--line);border-radius:18px 18px 0 0;animation-name:usb}@keyframes usb{from{transform:translateY(24px);opacity:0}}}
.us-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 6px}.us-h h2{margin:0;font:700 17px var(--body)}
.us-x{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:var(--muted);cursor:pointer}
.us-body{flex:1;min-height:0;overflow-y:auto;padding:10px 16px 24px;display:flex;flex-direction:column;gap:12px}
.us-err{margin:0;padding:8px 10px;border-radius:9px;background:var(--bad-bg);color:var(--bad);font:500 12.5px/1.4 var(--body)}
.us-p{margin:0;font:400 13.5px/1.5 var(--body);overflow-wrap:anywhere}
.us-meta{margin:0;color:var(--muted);font:400 12.5px/1.5 var(--body)}.us-meta a{color:var(--ink)}
.us-ver{display:flex;align-items:center;gap:10px;font:600 20px var(--body)}.us-new{color:var(--on)}
.us-act{display:flex;flex-wrap:wrap;gap:8px}.us-fg{flex:1 0 100%}
.us-btn{min-height:44px;padding:0 16px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:600 13px var(--body);cursor:pointer}
.us-btn.pri{background:var(--ink);color:var(--panel);border-color:var(--ink)}.us-btn:disabled{opacity:.45;cursor:default}
.us-tg{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:var(--muted);cursor:pointer}
.us-tg :deep(.icon),.us-lg :deep(.icon){transition:transform .24s cubic-bezier(.2,.8,.2,1)}.us-tg :deep(.up),.us-lg :deep(.up){transform:rotate(180deg)}
.us-lg{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0;border:0;background:none;color:var(--ink);font:600 12.5px var(--body);cursor:pointer;align-self:flex-start}
.us-dw{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s}
.us-dw.is-open{grid-template-rows:1fr;opacity:1}.us-dw>.us-d{overflow:hidden;min-height:0;display:flex;flex-direction:column;gap:8px}
.us-cmd{display:flex;align-items:center;gap:6px;padding:4px 4px 4px 10px;border-radius:8px;background:var(--track)}
.us-cmd code{flex:1;min-width:0;font:500 12px/1.5 var(--mono);overflow-wrap:anywhere}
.us-cp{display:grid;place-items:center;flex:none;width:44px;height:36px;border:0;border-radius:7px;background:none;color:var(--muted);cursor:pointer}
.us-pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--track);font:500 11.5px/1.5 var(--mono);overflow:auto;max-height:200px;white-space:pre-wrap}
.us-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.us-steps li{display:flex;align-items:flex-start;gap:10px;min-height:36px;padding:8px 0;border-top:1px solid var(--line);color:var(--muted);font:500 13px/1.4 var(--body)}
.us-steps li:first-child{border-top:0}
.us-steps .s-ok{color:var(--ink)}.s-ok :deep(.icon){color:var(--on)}.s-failed{color:var(--bad)!important}.s-running{color:var(--ink)}
.us-sl{flex:1;min-width:0;display:flex;flex-direction:column}.us-sd{color:var(--muted);font:400 11.5px/1.4 var(--mono);overflow-wrap:anywhere}
.us-st{flex:none;color:var(--muted);font:500 12px var(--mono)}
.us-spin{animation:ussp 1s linear infinite}@keyframes ussp{to{transform:rotate(360deg)}}
.us-ok{border-color:color-mix(in srgb,var(--on) 55%,var(--line))}
.us-warn{border-color:color-mix(in srgb,var(--warn) 60%,var(--line))}
.us-bad{border-color:color-mix(in srgb,var(--bad) 60%,var(--line))}
button:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.us,.us-scrim{animation:none}.us-dw,.us-tg :deep(.icon),.us-lg :deep(.icon){transition:none}.us-spin{animation:none}}
</style>
