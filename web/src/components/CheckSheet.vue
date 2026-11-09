<script setup lang="ts">
// Owner checks sheet. Opened from a map chip (one check) or the "N waiting for you" pill (the list). The buttons are the ones
// the asking agent wrote, in order, coloured by tone. A note is optional and inline: no browser dialogs.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { net, checkUi, pendingChecks, answerCheck, type Check } from "../net";

const sheet = ref<HTMLElement | null>(null);
const note = ref(""), noteOpen = ref(false), busy = ref(""), err = ref("");
const open = computed(() => checkUi.list || checkUi.id > 0);
const one = computed<Check | null>(() => (checkUi.id ? net.checks[checkUi.id] ?? null : null));
const age = (t: number) => { const s = Math.max(0, Math.round((net.now - t) / 1000)); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const gone = (k: Check) => !Object.values(net.agents).some((a) => a.name === k.agent);

function close() { checkUi.id = 0; checkUi.list = false; }
function back() { if (pendingChecks.value.length > 1) { checkUi.id = 0; checkUi.list = true; } else close(); }
watch(() => checkUi.id, () => { note.value = ""; noteOpen.value = false; busy.value = ""; err.value = ""; });
// A check answered elsewhere (or one that left) while the sheet shows it: step back.
watch(one, (k) => { if (checkUi.id && (!k || (k.state === "answered" && !busy.value))) back(); });
watch(() => [open.value, pendingChecks.value.length], () => { if (checkUi.list && !pendingChecks.value.length) close(); });

async function pick(k: Check, label: string) {
  if (busy.value) return;
  busy.value = label; err.value = "";
  const e = await answerCheck(k.id, label, note.value);
  busy.value = "";
  if (e) { err.value = e; return; }
  back();
}

let prev: HTMLElement | null = null;
watch(open, (o) => {
  document.documentElement.style.overflow = o ? "hidden" : "";
  if (o) { prev = document.activeElement as HTMLElement | null; nextTick(() => sheet.value?.focus({ preventScroll: true })); }
  else if (prev?.isConnected) { prev.focus({ preventScroll: true }); prev = null; }
});
const onKey = (e: KeyboardEvent) => {
  if (!open.value) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab" || !sheet.value) return;
  const f = [...sheet.value.querySelectorAll<HTMLElement>("button:not(:disabled),textarea")]; if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.value)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
};
addEventListener("keydown", onKey, true);
onBeforeUnmount(() => { removeEventListener("keydown", onKey, true); document.documentElement.style.overflow = ""; });
</script>

<template>
  <Teleport to="body">
    <Transition name="cs-scrim"><div v-if="open" class="cs-scrim" @click="close" /></Transition>
    <Transition name="cs">
      <div v-if="open" ref="sheet" class="cs" role="dialog" aria-modal="true" :aria-label="one ? 'Question for you' : 'Waiting for you'" tabindex="-1">
        <template v-if="one && one.state === 'pending'">
          <button v-if="pendingChecks.length > 1" type="button" class="cs-back" @click="back">All waiting ({{ pendingChecks.length }})</button>
          <p class="cs-tag"><i /> Waiting for you</p>
          <h2 class="cs-q">{{ one.question }}</h2>
          <p v-if="one.detail" class="cs-d">{{ one.detail }}</p>
          <p class="cs-m">Asked by <b>{{ one.agent }}</b><template v-if="gone(one)"> (closed)</template> · {{ age(one.createdAt) }}<template v-if="one.team"> · team {{ one.team }}</template></p>
          <div class="cs-opts">
            <button v-for="o in one.options" :key="o.label" type="button" class="cs-o" :class="[o.tone, { busy: busy === o.label }]" :disabled="!!busy" @click="pick(one, o.label)">{{ o.label }}</button>
          </div>
          <button v-if="!noteOpen" type="button" class="cs-n" @click="noteOpen = true; nextTick(() => sheet?.querySelector('textarea')?.focus())">Add a note</button>
          <label v-else class="cs-note"><span class="sr-only">Note</span><textarea v-model="note" rows="2" maxlength="500" placeholder="Optional note for root" /></label>
          <p v-if="err" class="cs-e" role="alert">{{ err }}</p>
        </template>
        <template v-else>
          <p class="cs-tag"><i /> Waiting for you</p>
          <h2 class="cs-q">{{ pendingChecks.length }} {{ pendingChecks.length === 1 ? "question" : "questions" }}</h2>
          <ul class="cs-l">
            <li v-for="k in pendingChecks" :key="k.id"><button type="button" @click="checkUi.id = k.id; checkUi.list = false"><span>{{ k.question }}</span><small>{{ k.agent }}{{ gone(k) ? " (closed)" : "" }} · {{ age(k.createdAt) }}</small></button></li>
          </ul>
        </template>
        <button type="button" class="cs-x" @click="close">Close</button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cs-scrim{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.5)}
.cs{position:fixed;z-index:71;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow-y:auto;padding:20px;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--ink);box-shadow:0 20px 60px rgba(0,0,0,.45);outline:none}
.cs-tag{margin:0 0 8px;display:flex;align-items:center;gap:7px;color:var(--pend-ink);font:700 12px var(--body);letter-spacing:.06em;text-transform:uppercase}
.cs-tag i{width:8px;height:8px;border-radius:50%;background:var(--pend);animation:csp 1.6s ease-in-out infinite}
@keyframes csp{50%{opacity:.35}}
.cs-q{margin:0 0 8px;font:700 20px/1.25 var(--body);overflow-wrap:anywhere}
.cs-d{margin:0 0 8px;color:var(--muted);font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}
.cs-m{margin:0 0 16px;color:var(--muted);font-size:12.5px}
.cs-m b{color:var(--ink);font-weight:600}
.cs-opts{display:grid;gap:10px}
.cs-o{min-height:48px;padding:10px 14px;border-radius:12px;border:1.5px solid var(--line);background:var(--panel-2);color:var(--ink);font:700 15px var(--body);cursor:pointer;transition:background .15s var(--ease),transform .15s var(--ease),opacity .15s}
.cs-o.good{border-color:var(--on);background:var(--on-bg);color:var(--on)}
.cs-o.bad{border-color:var(--bad);background:var(--bad-bg);color:var(--bad)}
.cs-o.neutral{color:var(--ink)}
.cs-o:hover:not(:disabled){transform:translateY(-1px)}
.cs-o:active:not(:disabled){transform:scale(.98)}
.cs-o:disabled{opacity:.55;cursor:progress}
.cs-o.busy{opacity:1}
.cs-o:focus-visible,.cs-n:focus-visible,.cs-x:focus-visible,.cs-back:focus-visible,.cs-l button:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.cs-n,.cs-x,.cs-back{min-height:44px;padding:0 4px;border:0;background:none;color:var(--muted);font:600 13px var(--body);cursor:pointer}
.cs-n{margin-top:6px}
.cs-x{display:block;margin:6px auto 0}
.cs-back{display:block;margin:-8px 0 4px -4px}
.cs-note{display:block;margin-top:10px}
.cs-note textarea{width:100%;resize:vertical;min-height:64px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);color:var(--ink);font:14px var(--body)}
.cs-e{margin:10px 0 0;padding:8px 10px;border-radius:9px;background:var(--bad-bg);color:var(--bad);font-weight:600;font-size:13px}
.cs-l{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.cs-l button{width:100%;min-height:56px;display:grid;gap:2px;text-align:left;padding:10px 12px;border:1px solid color-mix(in srgb,var(--pend) 55%,var(--line));border-radius:12px;background:var(--pend-bg);color:var(--ink);font:600 14px var(--body);cursor:pointer}
.cs-l small{color:var(--muted);font-weight:500;font-size:12px}
.cs-scrim-enter-active,.cs-scrim-leave-active{transition:opacity .22s var(--ease)}
.cs-scrim-enter-from,.cs-scrim-leave-to{opacity:0}
.cs-enter-active,.cs-leave-active{transition:transform .3s cubic-bezier(.2,.8,.2,1),opacity .22s var(--ease)}
.cs-enter-from,.cs-leave-to{opacity:0;transform:translate(-50%,-46%)}
@media (max-width:760px){
  .cs{left:0;right:0;top:auto;bottom:0;width:auto;transform:none;border-radius:18px 18px 0 0;padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))}
  .cs-enter-from,.cs-leave-to{transform:translateY(100%)}
}
@media (prefers-reduced-motion:reduce){.cs-tag i{animation:none}.cs-enter-active,.cs-leave-active{transition:opacity .15s}.cs-enter-from,.cs-leave-to{transform:translate(-50%,-50%)}@media (max-width:760px){.cs-enter-from,.cs-leave-to{transform:none}}.cs-o{transition:none}}
</style>
