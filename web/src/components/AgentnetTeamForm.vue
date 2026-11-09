<script setup lang="ts">
// "New team" dialog (Agents page, root only: the panel acts as root). Name, goal, lead and members are picked from the live agents as chips
// (no free text for known sets), project is optional. POST /agentnet-panel/teams, then the page opens the new team's panel.
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { net, loadTeams } from "../net";
import { api } from "../ui/api";

const emit = defineEmits<{ close: []; created: [id: string] }>();
const name = ref(""), goal = ref(""), project = ref(""), lead = ref(""), picked = ref(new Set<string>()), busy = ref(false), err = ref("");
const el = ref<HTMLElement | null>(null);
const agents = computed(() => Object.values(net.agents).filter((a) => a.name !== "root" && a.life !== "gone" && a.life !== "failed").map((a) => a.name).sort());
const toggle = (n: string) => { const s = new Set(picked.value); s.has(n) ? s.delete(n) : s.add(n); picked.value = s; };
const setLead = (n: string) => { lead.value = lead.value === n ? "" : n; if (lead.value) picked.value = new Set(picked.value).add(n); };
const can = computed(() => name.value.trim().length > 1 && !busy.value);
async function submit() {
  if (!can.value) return;
  busy.value = true; err.value = "";
  try {
    const r = await api<{ team: { id: string } }>("v1/panel/teams", { method: "POST", body: { name: name.value.trim(), goal: goal.value.trim() || undefined, lead: lead.value || undefined, members: [...picked.value], project: project.value.trim() || undefined } });
    await loadTeams(); emit("created", r.team.id); emit("close");
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
onMounted(() => nextTick(() => el.value?.querySelector<HTMLInputElement>("input")?.focus()));
function trap(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); emit("close"); return; }
  if (e.key !== "Tab" || !el.value) return;
  const f = [...el.value.querySelectorAll<HTMLElement>("button:not([disabled]),input,textarea")].filter((x) => x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
</script>

<template>
  <div class="tf-scrim" @click.self="emit('close')">
    <form ref="el" class="tf glass-strong" role="dialog" aria-modal="true" aria-label="New team" @submit.prevent="submit" @keydown="trap">
      <header class="tf-h"><h2>New team</h2><button type="button" class="tf-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="20" /></button></header>
      <label class="tf-f"><span>Name</span><input v-model="name" type="text" maxlength="60" placeholder="e.g. Turntable" autocomplete="off" /></label>
      <label class="tf-f"><span>Goal</span><textarea v-model="goal" rows="2" maxlength="500" placeholder="One line the whole team can read" /></label>
      <div class="tf-f" role="group" aria-label="Lead"><span>Lead</span>
        <div class="tf-chips"><button v-for="n in agents" :key="n" type="button" :class="{ on: lead === n }" :aria-pressed="lead === n" @click="setLead(n)">{{ n }}</button><em v-if="!agents.length">No live agents</em></div>
      </div>
      <div class="tf-f" role="group" aria-label="Members"><span>Members <i>{{ picked.size }}</i></span>
        <div class="tf-chips"><button v-for="n in agents" :key="n" type="button" :class="{ on: picked.has(n) }" :aria-pressed="picked.has(n)" @click="toggle(n)">{{ n }}</button></div>
      </div>
      <label class="tf-f"><span>Project <small>optional</small></span><input v-model="project" type="text" placeholder="/path/to/project" autocomplete="off" /></label>
      <p v-if="err" class="tf-err" role="alert">{{ err }}</p>
      <footer class="tf-b"><button type="button" class="tf-c" @click="emit('close')">Cancel</button><button type="submit" class="tf-ok" :disabled="!can">{{ busy ? "Creating…" : "Create team" }}</button></footer>
    </form>
  </div>
</template>

<style scoped>
.tf-scrim{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55);animation:tfin .2s var(--ease)}
.tf{width:min(480px,100%);max-height:min(88dvh,640px);overflow-y:auto;display:grid;gap:14px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 30px 80px rgba(0,0,0,.6);animation:tfup .28s cubic-bezier(.2,.8,.2,1)}
.tf *{min-width:0}
.tf-h{display:flex;align-items:center}
.tf-h h2{margin:0;font:700 18px/1.2 var(--body);text-transform:none;color:var(--ink)}
.tf-x{margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}
.tf-x:hover{background:var(--track)}
.tf-f{display:grid;gap:6px;border:0;padding:0;margin:0}
.tf-f > span{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.tf-f > span i{font-style:normal;letter-spacing:0;color:var(--ink);opacity:.8}
.tf-f small{letter-spacing:0;text-transform:none;font-weight:500;opacity:.7}
.tf input,.tf textarea{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:inherit;font-size:14px;line-height:1.4;resize:none}
.tf input:focus-visible,.tf textarea:focus-visible,.tf-chips button:focus-visible,.tf-b button:focus-visible,.tf-x:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.tf-chips{display:flex;flex-wrap:wrap;gap:6px}
.tf-chips button{min-height:36px;padding:0 12px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);font:600 12.5px/1 var(--body);cursor:pointer;transition:background-color .2s var(--ease),color .2s var(--ease),border-color .2s var(--ease)}
.tf-chips button.on{background:color-mix(in srgb,var(--on) 16%,transparent);border-color:color-mix(in srgb,var(--on) 55%,var(--line));color:var(--ink)}
.tf-chips em{color:var(--muted);font-size:12.5px}
.tf-err{margin:0;color:var(--bad);font-size:12.5px}
.tf-b{display:flex;justify-content:flex-end;gap:8px}
.tf-b button{min-height:40px;padding:0 16px;border-radius:12px;font:600 13.5px/1 var(--body);cursor:pointer}
.tf-c{border:1px solid var(--line);background:transparent;color:var(--ink)}
.tf-ok{border:0;background:var(--on);color:#06210f}
.tf-ok:disabled{opacity:.35;cursor:default}
@keyframes tfin{from{opacity:0}}
@keyframes tfup{from{opacity:0;transform:translateY(12px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.tf-scrim,.tf{animation:none}.tf-chips button{transition:none}}
</style>
