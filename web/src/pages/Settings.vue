<script setup lang="ts">
// Settings. Two sections: Updates (versions, last check, a "Check now" button, the same sheet as the header pill)
// and the Danger zone, with "Reset director": stop the director, forget its folder and session,
// and show the first-run setup again. Two-step inline confirm (the Close agent pattern), never a browser confirm().
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import UpdateSheet from "../components/UpdateSheet.vue";
import Icon from "../ui/Icon.vue";
import { api, toast } from "../ui/api";
import { useUpdate } from "../ui/useUpdate";

const u = useUpdate();
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
    <h1 id="st-h">Settings</h1>
    <h2 class="up-h">Updates</h2>
    <div class="up">
      <dl class="up-kv">
        <div><dt>Current</dt><dd>{{ st ? `v${st.current}` : "…" }}</dd></div>
        <div><dt>Latest known</dt><dd>{{ st?.latest ? `v${st.latest}` : "unknown" }}<span v-if="available" class="up-new">newer</span></dd></div>
        <div><dt>Last checked</dt><dd>{{ ago }}</dd></div>
      </dl>
      <p v-if="st?.error" class="up-note">Last check failed: {{ st.error }}</p>
      <p v-if="whyNoCheck" class="up-note">{{ whyNoCheck }}</p>
      <div class="up-act">
        <button type="button" class="btn sm" :disabled="u.checking.value || !!whyNoCheck" @click="u.check()"><Icon :name="u.checking.value ? 'loader' : 'rotate-ccw'" :size="15" :class="{ spin: u.checking.value }" />{{ u.checking.value ? "Checking…" : "Check now" }}</button>
        <button v-if="available" type="button" class="btn sm up-go" @click="openSheet"><Icon name="circle-arrow-up" :size="15" />Update now</button>
      </div>
    </div>
    <UpdateSheet :open="sheetOpen" :m="u.m.value" :now="clock" :can-check="u.canCheck.value" :checking="u.checking.value"
      @close="sheetOpen = false" @ask="u.dispatch({ type: 'ask' })" @cancel="u.dispatch({ type: 'cancel' })" @start="u.start()" @check="u.check()"
      @dismiss="u.dispatch({ type: 'dismiss' })" @reload="reload" />
    <h2 class="dz-h">Danger zone</h2>
    <div class="dz">
      <div class="dz-row">
        <div class="dz-tx">
          <b>Reset director</b>
          <p>Stops the director if it runs, forgets its folder and session, and shows the first-run setup again. Agents, teams, tasks and scores are kept. Conversation files stay on disk.</p>
        </div>
        <button ref="askBtn" type="button" class="btn sm danger-ghost" :disabled="busy || confirming" :aria-expanded="confirming" @click="ask"><Icon name="trash" :size="15" /> Reset director</button>
      </div>
      <Transition name="cf">
        <div v-if="confirming" class="cf" role="alertdialog" aria-label="Reset the director?" @keydown.esc.stop="cancel">
          <div class="cf-clip"><div class="cf-in">
            <span class="cf-ic"><Icon name="triangle-alert" :size="18" /></span>
            <div class="cf-tx">
              <b>Reset the director?</b>
              <p>The director stops now and is forgotten. You will set it up again from the Agents page.</p>
            </div>
            <div class="cf-act">
              <button ref="cancelBtn" type="button" class="btn sm ghost" :disabled="busy" @click="cancel">Cancel</button>
              <button type="button" class="btn sm solid-danger" :disabled="busy" @click="reset"><Icon :name="busy ? 'loader' : 'trash'" :size="14" :class="{ spin: busy }" />Reset director</button>
            </div>
          </div></div>
        </div>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.st{display:grid;gap:14px;align-content:start;max-width:760px;width:100%;margin:0 auto}
.st h1{margin:0;font:700 22px/1.2 var(--body)}
.up-h{margin:8px 0 0;color:var(--muted);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.up{display:grid;gap:12px;padding:14px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
.up-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0}
.up-kv div{display:grid;gap:3px;min-width:0}
.up-kv dt{font-size:12px;color:var(--muted)}
.up-kv dd{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font:600 14.5px/1.3 var(--body)}
.up-new{padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg);color:var(--on);font:600 11.5px var(--body)}
.up-note{margin:0;font-size:13px;line-height:1.45;color:var(--muted)}
.up-act{display:flex;flex-wrap:wrap;gap:8px}
.up .btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding-inline:14px}
.up-go{color:var(--on);border-color:color-mix(in srgb,var(--on) 55%,transparent);background:var(--on-bg)}
.dz-h{margin:8px 0 0;color:var(--bad);font:600 12px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
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
