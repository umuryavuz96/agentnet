<script setup lang="ts">
// Claude account card (mock C, SPEC-step5 section 2). The token goes to POST /api/v1/accounts once and is never shown again:
// the field is cleared right after the call, success or not, and the value never reaches a toast, a log, the URL or storage.
// Used in the setup window (Import path, `setup` prop: Continue and Skip) and on the Settings page.
import { onMounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { api, toast } from "../ui/api";

const props = defineProps<{ setup?: boolean }>();
const emit = defineEmits<{ next: []; skip: []; back: [] }>();
interface Account { id: string; kind: string; added: number; agents: number }
const list = ref<Account[] | null>(null), loadErr = ref(""), err = ref(""), saving = ref(false), removing = ref(""), copied = ref(false);
const field = ref<HTMLInputElement | null>(null);
const main = () => list.value?.find((a) => a.id === "main") ?? null;

async function load() { try { list.value = (await api<{ accounts: Account[] }>("api/v1/accounts")).accounts; loadErr.value = ""; } catch (e) { loadErr.value = (e as Error).message; list.value = list.value ?? []; } }
onMounted(load);
async function save() {
  const el = field.value; if (!el) return;
  const token = el.value; el.value = ""; // cleared before the call returns: nothing keeps the value
  if (!token.trim()) { err.value = "Paste the token first."; el.focus(); return; }
  saving.value = true; err.value = "";
  try { await api("api/v1/accounts", { method: "POST", body: { id: "main", token } }); await load(); }
  catch (e) { err.value = (e as Error).message; el.focus(); }
  finally { saving.value = false; }
}
async function remove(id: string) {
  removing.value = id; err.value = "";
  try { await api("api/v1/accounts/" + encodeURIComponent(id), { method: "DELETE" }); await load(); } catch (e) { err.value = (e as Error).message; } finally { removing.value = ""; }
}
async function copy() { try { await navigator.clipboard.writeText("claude setup-token"); copied.value = true; setTimeout(() => (copied.value = false), 1600); } catch { toast("Copy failed"); } }
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
defineExpose({ hasAccount: () => !!main() });
</script>

<template>
  <div class="ac">
    <p class="ac-t">Every agent gets its own Claude settings inside the agentnet folder. They all sign in with this one token.</p>
    <template v-if="list === null"><p class="ac-t sm" role="status"><Icon name="loader" :size="13" class="spin" /> Checking for a saved account…</p></template>
    <template v-else-if="main()">
      <div class="ac-on" role="status">
        <span class="ac-dot" aria-hidden="true" />
        <div class="ac-who"><b>Connected</b><small>Account <code>{{ main()!.id }}</code>, added {{ when(main()!.added) }}<template v-if="main()!.agents">, used by {{ main()!.agents }} {{ main()!.agents === 1 ? "agent" : "agents" }}</template></small></div>
        <button type="button" class="ac-b ghost" :disabled="removing === 'main'" @click="remove('main')"><Icon name="trash" :size="14" /> {{ removing === "main" ? "Removing…" : "Remove" }}</button>
      </div>
      <ul v-if="list.length > 1" class="ac-more" aria-label="Other accounts">
        <li v-for="a in list.filter((x) => x.id !== 'main')" :key="a.id"><code>{{ a.id }}</code><small>added {{ when(a.added) }}</small>
          <button type="button" class="ac-b ghost sm" :disabled="removing === a.id" @click="remove(a.id)">Remove</button></li>
      </ul>
    </template>
    <template v-else>
      <ol class="ac-steps">
        <li><span>Run this in a terminal on any machine signed in to Claude:</span>
          <div class="ac-cmd"><code>claude setup-token</code><button type="button" class="ac-cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div></li>
        <li><label for="ac-token">Paste the token it prints</label>
          <form class="ac-form" autocomplete="off" @submit.prevent="save">
            <input id="ac-token" ref="field" type="password" name="ac-token" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste the token here" :aria-invalid="!!err" aria-describedby="ac-note ac-err" />
            <button type="submit" class="ac-b" :disabled="saving">{{ saving ? "Saving…" : "Save" }}</button>
          </form></li>
      </ol>
      <p id="ac-note" class="ac-t sm"><Icon name="lock" :size="13" /> Stored in the folder, readable only by you. It is never shown again.</p>
    </template>
    <p id="ac-err" class="ac-err" role="alert">{{ err || loadErr }}</p>
    <div v-if="props.setup" class="ac-row">
      <button type="button" class="ac-b ghost" @click="emit('back')">Back</button>
      <button v-if="main()" type="button" class="ac-b" @click="emit('next')">Continue</button>
      <button v-else type="button" class="ac-link" @click="emit('skip')">Skip, agents use this machine's Claude login</button>
    </div>
    <p v-if="props.setup && list !== null && !main()" class="ac-t sm">Without an account, agents share this machine's Claude login and get no config folder of their own.</p>
  </div>
</template>

<style scoped>
.ac{display:grid;gap:12px;min-width:0}.ac *{min-width:0}
.ac-t{margin:0;font-size:13.5px;line-height:1.45}.ac-t.sm{display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted)}
.ac-steps{margin:0;padding:0 0 0 20px;display:grid;gap:12px;font-size:13.5px}.ac-steps li{display:grid;gap:6px}.ac-steps label{font-weight:600}
.ac-cmd{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.ac-cmd code{flex:1;font:13px var(--mono);user-select:all;overflow-wrap:anywhere}
.ac-form{display:flex;gap:8px}
.ac-form input{flex:1;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:13px var(--mono)}
.ac-form input[aria-invalid="true"]{border-color:var(--bad)}
.ac-form input:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ac-on{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid color-mix(in srgb,var(--on) 40%,var(--line));border-radius:14px;background:var(--on-bg)}
.ac-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--on)}
.ac-who{flex:1;display:grid;gap:2px}.ac-who b{font:650 14px var(--body)}.ac-who small{color:var(--muted);font-size:12.5px;line-height:1.4}.ac-who code,.ac-more code{font:12px var(--mono)}
.ac-more{list-style:none;margin:0;padding:0;display:grid;gap:6px}.ac-more li{display:flex;align-items:center;gap:10px;font-size:12.5px}.ac-more small{color:var(--muted);flex:1}
.ac-err{margin:0;min-height:0;color:var(--bad);font-size:12.5px}.ac-err:empty{display:none}
.ac-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ac-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer}
.ac-b.sm{min-height:36px;padding:0 10px;font-size:12.5px}
.ac-b:disabled{opacity:.4;cursor:default}
.ac-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.ac-cp{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 10px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ac-link{min-height:44px;padding:0 6px;border:0;background:none;color:var(--muted);font:600 12.5px var(--body);text-decoration:underline;text-underline-offset:3px;cursor:pointer;text-align:left}
.ac-link:hover{color:var(--ink)}
.ac-b:focus-visible,.ac-cp:focus-visible,.ac-link:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.spin{animation:acspin 1s linear infinite}@keyframes acspin{to{transform:rotate(360deg)}}
:global(:root[data-theme="light"] .ac-b:not(.ghost)){color:#fff}
@media (max-width:480px){.ac-form{flex-direction:column}.ac-form .ac-b{width:100%}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
