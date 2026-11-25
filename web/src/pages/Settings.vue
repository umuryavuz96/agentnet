<script setup lang="ts">
// Settings. Two sections: Updates (versions, last check, a "Check now" button, the same sheet as the header pill)
// and the Danger zone, with "Reset director": stop the director, forget its folder and session,
// and show the first-run setup again. Two-step inline confirm (the Close agent pattern), never a browser confirm().
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { themePref, setThemePref, type ThemePref } from "../theme";
import { officeBlur, setOfficeBlur } from "../office3d/prefs";
import UpdateSheet from "../components/UpdateSheet.vue";
import AgentnetImportAccount from "../components/AgentnetImportAccount.vue";
import Icon from "../ui/Icon.vue";
import { api, toast } from "../ui/api";
import { useUpdate } from "../ui/useUpdate";

const u = useUpdate();
interface Health { home?: string; version?: string; api?: number; minClientApi?: number; features?: string[] }
interface Dir { home?: string; tools?: Record<string, boolean>; triage?: string; sessionName?: string; session?: boolean; precheck?: { repos?: number } }
const health = ref<Health | null>(null), dir = ref<Dir | null>(null);
onMounted(async () => {
  try { health.value = await api<Health>("v1/health"); } catch { /* card shows unknown */ }
  try { dir.value = await api<Dir>("v1/panel/director"); } catch { /* card shows unknown */ }
});
const host = location.host;
const THEMES: ThemePref[] = ["system", "light", "dark"];
const TRIAGE: Record<string, string> = { ok: "Working", off: "Off" };
const published = computed(() => { const t = st.value?.published; return t ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""; });
const sheetOpen = ref(false), clock = ref(Date.now());
const tick = setInterval(() => { clock.value = Date.now(); }, 30_000);
onBeforeUnmount(() => clearInterval(tick));
const st = computed(() => u.m.value.status);
const available = computed(() => !!st.value?.available);
const ago = computed(() => {
  const t = st.value?.checkedAt; if (!t) return "never";
  const s = Math.max(0, Math.floor(clock.value / 1000 - t));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
});
/** Why the button is off, or "" when it works. */
const whyNoCheck = computed(() => (!u.canCheck.value ? "Checking works only from the machine agentnet runs on, or from the root agent." : st.value && !st.value.checkEnabled ? "The release check is off (AGENTNET_UPDATE_CHECK=0)." : ""));
interface Device { id: string; name: string; created: number; last_used: number | null }
const devices = ref<Device[] | null>(null), revoking = ref("");
async function loadDevices() { try { devices.value = (await api<{ devices: Device[] }>("v1/panel/devices")).devices; } catch { devices.value = devices.value ?? []; } }
onMounted(loadDevices);
const when = (t: number | null) => { if (!t) return "never"; const s = Math.max(0, Math.floor((clock.value - t) / 1000)); return s < 120 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
async function revoke(d: Device) {
  if (revoking.value !== d.id) { revoking.value = d.id; return; } // second press confirms
  try { await api(`v1/panel/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" }); toast(`${d.name} is signed out`); } catch (e) { toast((e as Error).message); }
  revoking.value = ""; await loadDevices();
}
function reload() { u.dispatch({ type: "dismiss" }); location.reload(); }
function openSheet() { sheetOpen.value = true; void u.refresh(); }

const confirming = ref(false), busy = ref(false), cancelBtn = ref<HTMLButtonElement | null>(null), askBtn = ref<HTMLButtonElement | null>(null);
const ask = () => { confirming.value = true; nextTick(() => cancelBtn.value?.focus()); };
const cancel = () => { confirming.value = false; nextTick(() => askBtn.value?.focus()); };
async function reset() {
  if (busy.value) return; busy.value = true;
  try { await api("v1/panel/director/reset", { method: "POST" }); confirming.value = false; toast("Director reset. Set it up again on the Agents page."); location.hash = "#/agents"; }
  catch (e) { toast((e as Error).message || "Could not reset the director"); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="st" aria-labelledby="st-h">
    <header class="st-top"><h1 id="st-h">Settings</h1><span v-if="st" class="st-sub num">v{{ st.current }} · {{ available ? "update ready" : "up to date" }}</span></header>
    <div class="st-cols">
      <div class="st-col">
        <section class="sc" aria-label="Updates">
          <h2><Icon name="rotate-ccw" :size="15" /> Updates <span class="sc-r">checked {{ ago }}</span></h2>
          <div class="sc-big"><b class="num">{{ st ? `v${st.current}` : "…" }}</b><span class="up-pill" :class="{ new: available }">{{ available ? `v${st?.latest} is out` : "Up to date" }}</span><span v-if="published && !available" class="sc-m">released {{ published }}</span></div>
          <p v-if="st?.error" class="sc-note">Last check failed: {{ st.error }}</p>
          <p v-if="whyNoCheck" class="sc-note">{{ whyNoCheck }}</p>
          <dl class="kv">
            <div><dt>Check for new releases<small>AGENTNET_UPDATE_CHECK</small></dt><dd class="mono">{{ st?.checkEnabled ? "On" : "Off" }}</dd></div>
            <div><dt>Update by itself<small>AGENTNET_AUTO_UPDATE{{ st?.auto?.enabled ? `, at ${String(st.auto.hour).padStart(2, "0")}:00` : "" }}</small></dt><dd class="mono">{{ st?.auto?.enabled ? "On" : "Off" }}</dd></div>
            <div v-if="st?.mode"><dt>Runs as<small>how agentnet restarts after an update</small></dt><dd class="mono">{{ st.mode }}</dd></div>
          </dl>
          <p class="sc-note">These come from the service's environment; changing them needs a restart.</p>
          <div class="up-act">
            <button type="button" class="btn sm" :disabled="u.checking.value || !!whyNoCheck" @click="u.check()"><Icon :name="u.checking.value ? 'loader' : 'rotate-ccw'" :size="15" :class="{ spin: u.checking.value }" />{{ u.checking.value ? "Checking…" : "Check now" }}</button>
            <button type="button" class="btn sm" :class="{ 'up-go': available }" @click="openSheet"><Icon :name="available ? 'circle-arrow-up' : 'file-text'" :size="15" />{{ available ? `Update to v${st?.latest}` : "Release notes" }}</button>
          </div>
        </section>
        <section class="sc" aria-label="Appearance">
          <h2><Icon name="sliders" :size="15" /> Appearance</h2>
          <dl class="kv">
            <div><dt>Theme<small>System follows the Mac or phone setting; saved on this device</small></dt>
              <dd><div class="seg" role="radiogroup" aria-label="Theme"><button v-for="t in THEMES" :key="t" type="button" role="radio" :aria-checked="themePref === t" @click="setThemePref(t)">{{ t[0].toUpperCase() + t.slice(1) }}</button></div></dd></div>
            <div><dt>3D office blur<small>Soft blur at the top and bottom of the 3D office, like a photo of a miniature; saved on this device</small></dt>
              <dd><div class="seg" role="radiogroup" aria-label="3D office blur"><button type="button" role="radio" :aria-checked="officeBlur" @click="setOfficeBlur(true)">On</button><button type="button" role="radio" :aria-checked="!officeBlur" @click="setOfficeBlur(false)">Off</button></div></dd></div>
            <div><dt>Motion<small>Follows Reduce Motion in the system settings</small></dt><dd class="mono">System</dd></div>
          </dl>
        </section>
      </div>
      <div class="st-col">
        <section class="sc" aria-label="Service">
          <h2><Icon name="cpu" :size="15" /> Service <span v-if="health?.features" class="sc-r">{{ health.features.length }} features on</span></h2>
          <dl class="kv">
            <div><dt>Version<small>API {{ health?.api ?? "unknown" }}, works with clients from API {{ health?.minClientApi ?? "unknown" }}</small></dt><dd class="mono">{{ health?.version ? `v${health.version}` : "unknown" }}</dd></div>
            <div><dt>Address<small>The host this page is served from</small></dt><dd class="mono">{{ host }}</dd></div>
            <div><dt>Data folder<small>Database, settings, logs. AGENTNET_HOME</small></dt><dd class="mono path"><template v-if="health?.home"><template v-for="(part, i) in health.home.split('/')" :key="i"><wbr v-if="i">{{ i ? "/" : "" }}{{ part }}</template></template><template v-else>unknown</template></dd></div>
            <div v-if="health?.features"><dt>Features</dt><dd class="chips"><span v-for="f in health.features" :key="f" class="chip mono">{{ f }}</span></dd></div>
          </dl>
          <p class="sc-note">Read only. Nothing secret is shown here.</p>
        </section>
        <section class="sc" aria-label="Devices">
          <h2><Icon name="lock" :size="15" /> Devices <span class="sc-r">{{ devices ? `${devices.length} paired` : "" }}</span></h2>
          <dl v-if="devices?.length" class="kv">
            <div v-for="d in devices" :key="d.id"><dt>{{ d.name }}<small>last used {{ when(d.last_used) }}</small></dt>
              <dd><button type="button" class="btn sm danger-ghost" @click="revoke(d)" @blur="revoking === d.id && (revoking = '')">{{ revoking === d.id ? "Revoke now" : "Revoke" }}</button></dd></div>
          </dl>
          <p class="sc-note">{{ devices?.length ? "Revoke signs that app out at once; it asks to pair again." : "No paired apps. An app asks to pair by itself; you approve it under Asks." }}</p>
        </section>
      </div>
      <div class="st-col">
        <section class="sc" aria-label="Director">
          <h2><Icon name="user" :size="15" /> Director <span class="sc-r">{{ dir?.session ? "connected" : dir ? "not running" : "" }}</span></h2>
          <dl class="kv">
            <div><dt>Runs in<small>{{ dir?.sessionName ? `tmux session ${dir.sessionName}` : "no session" }}</small></dt><dd class="mono">{{ dir?.home ? "~ (home)" : "unknown" }}</dd></div>
            <div><dt>Prompt triage<small>Sorts each request before work starts</small></dt><dd class="mono">{{ dir?.triage ? (TRIAGE[dir.triage] ?? dir.triage) : "unknown" }}</dd></div>
            <div v-if="dir?.tools"><dt>Tools on this machine</dt><dd class="chips"><span v-for="(ok, k) in dir.tools" :key="k" class="chip mono" :class="{ no: !ok }"><i />{{ k }}</span></dd></div>
            <div v-if="dir?.precheck?.repos != null"><dt>Repos it can see<small>Folders with a git repo under its folder</small></dt><dd class="mono num">{{ dir.precheck.repos }}</dd></div>
          </dl>
          <div class="up-act"><a class="btn sm" href="#/agents"><Icon name="layout-grid" :size="15" />Open its window</a><a class="btn sm ghost" href="#/agents?setup=1"><Icon name="settings" :size="15" />Setup again</a></div>
        </section>
        <section class="sc" aria-label="Claude account">
          <h2><Icon name="lock" :size="15" /> Claude account</h2>
          <AgentnetImportAccount />
        </section>
        <section class="sc dz" aria-label="Danger zone">
          <h2 class="dz-h"><Icon name="triangle-alert" :size="15" /> Danger zone</h2>
          <p class="sc-note">Reset director stops the director if it runs, forgets its folder and session, and shows the first-run setup again. Agents, teams, tasks and scores are kept. Conversation files stay on disk.</p>
          <div><button ref="askBtn" type="button" class="btn sm danger-ghost" :disabled="busy || confirming" :aria-expanded="confirming" @click="ask"><Icon name="trash" :size="15" /> Reset director…</button></div>
          <Transition name="cf">
        <div v-if="confirming" class="cf" role="alertdialog" aria-label="Reset the director?" @keydown.esc.stop="cancel">
          <div class="cf-clip"><div class="cf-in">
            <span class="cf-ic"><Icon name="triangle-alert" :size="18" /></span>
            <div class="cf-tx">
              <b>Reset the director?</b>
              <p>The director stops now and its folder and session are forgotten. Kept: agents, teams, tasks, scores and conversation files. You set it up again from the Agents page.</p>
            </div>
            <div class="cf-act">
              <button ref="cancelBtn" type="button" class="btn sm ghost" :disabled="busy" @click="cancel">Cancel</button>
              <button type="button" class="btn sm solid-danger" :disabled="busy" @click="reset"><Icon :name="busy ? 'loader' : 'trash'" :size="14" :class="{ spin: busy }" />Reset director</button>
            </div>
          </div></div>
        </div>
      </Transition>
        </section>
      </div>
    </div>
    <UpdateSheet :open="sheetOpen" :m="u.m.value" :now="clock" :can-check="u.canCheck.value" :checking="u.checking.value"
      @close="sheetOpen = false" @ask="u.dispatch({ type: 'ask' })" @cancel="u.dispatch({ type: 'cancel' })" @start="u.start()" @check="u.check()"
      @dismiss="u.dispatch({ type: 'dismiss' })" @reload="reload" />
  </section>
</template>

<style scoped>
.st{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;width:100%}
.st-top{display:flex;align-items:baseline;gap:12px}.st-top h1{margin:0;font:700 22px/1.2 var(--body)}.st-sub{color:var(--muted);font-size:13px}
.st-cols{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}
.st-col{display:grid;gap:12px;min-width:0}
.sc{display:grid;gap:10px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--panel);min-width:0}
.sc h2{margin:0;display:flex;align-items:center;gap:8px;font:650 14px var(--body)}.sc-r{margin-left:auto;color:var(--muted);font:400 12px var(--body)}
.sc-big{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.sc-big b{font:700 26px/1.1 var(--body)}.sc-m{color:var(--muted);font-size:12.5px}
.up-pill{padding:2px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg);color:var(--on);font:600 11.5px var(--body)}
.up-pill.new{border-color:var(--warn);color:var(--warn);background:transparent}
.sc-note{margin:0;font-size:12.5px;line-height:1.45;color:var(--muted)}
.kv{margin:0;display:grid}.kv>div{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid var(--line)}
.kv dt{display:grid;gap:2px;min-width:0;font:500 13px var(--body);overflow-wrap:anywhere}.kv dt small{color:var(--muted);font:400 12px/1.35 var(--body)}
.kv dt:not(:has(small)){flex:none}
.kv dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere}.kv dd.path{overflow-wrap:normal}.mono{font:500 13px var(--mono)}
.kv dd.chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:6px;background:var(--track);font-size:12px}
.chip i{width:7px;height:7px;border-radius:50%;background:var(--on)}.chip.no i{background:var(--bad)}
.seg{display:inline-flex;padding:2px;border-radius:10px;background:var(--track)}
.kv dd:has(.seg){flex:none}.sc a.btn{text-decoration:none}
.seg button{white-space:nowrap;min-height:34px;padding:0 12px;border:0;border-radius:8px;background:none;color:var(--muted);font:600 12.5px var(--body);cursor:pointer}
.seg button[aria-checked="true"]{background:color-mix(in srgb,var(--ink) 16%,transparent);color:var(--ink)}
.seg button:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.sc.dz{border-color:color-mix(in srgb,var(--bad) 40%,var(--line))}
.sc .btn{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding-inline:14px}
@media (max-width:1100px){.st-cols{grid-template-columns:minmax(0,1fr);overflow-y:auto;align-content:start}}
@media (max-width:1280px) and (min-width:1101px){.st-cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
.up-newx{padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg);color:var(--on);font:600 11.5px var(--body)}
.up-note{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.up-act{display:flex;flex-wrap:wrap;gap:8px}
.up .btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding-inline:14px}
.up-go{color:var(--on);border-color:color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg)}
.dz-h{margin:8px 0 0;color:var(--bad);font:600 13px/1.2 var(--body)}
.dz{display:grid;gap:10px;padding:14px;border:1px solid color-mix(in srgb,var(--bad) 40%,var(--line));border-radius:16px;background:var(--panel)}
.dz-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.dz-tx{display:grid;gap:4px;flex:1 1 280px;min-width:0}
.dz-tx b{font:600 14.5px/1.3 var(--body)}
.dz-tx p{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.dz .btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding-inline:14px}
.cf{display:grid;grid-template-rows:1fr;overflow:hidden}
.cf-clip{min-height:0;overflow:hidden}
.cf-in{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;padding:14px;border:1px solid color-mix(in srgb,var(--bad) 40%,transparent);border-radius:14px;background:color-mix(in srgb,var(--bad) 9%,var(--panel))}
.cf-ic{grid-row:1 / 3;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;color:var(--bad);background:color-mix(in srgb,var(--bad) 16%,transparent)}
.cf-tx{display:grid;gap:4px;min-width:0}
.cf-tx b{font:600 14.5px/1.3 var(--body)}
.cf-tx p{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.cf-act{grid-column:2;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:8px}
.btn.solid-danger{color:#fff;background:var(--bad);border-color:var(--bad)}
.btn.solid-danger:hover:not(:disabled){filter:brightness(1.08)}
.cf-enter-active,.cf-leave-active{transition:grid-template-rows .26s var(--ease,cubic-bezier(.2,.8,.2,1)),opacity .2s}
.cf-enter-from,.cf-leave-to{grid-template-rows:0fr;opacity:0}
.spin{animation:spin 1.1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:480px){.up-kv{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.up-kv div:last-child{grid-column:1 / -1}}
@media (max-width:420px){.cf-in{grid-template-columns:minmax(0,1fr)}.cf-ic{display:none}.cf-act{grid-column:1}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.cf-enter-active,.cf-leave-active{transition:opacity .15s}}
</style>
