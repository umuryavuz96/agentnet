<script setup lang="ts">
// "Set up your director" sheet: four steps that expand downward one at a time. 1 pick the project folder, 2 start Claude Code
// as the director (copy the command, or let agentnet start it in tmux), 3 live check (turns green when root says hello through
// the shared stream), 4 optional starter hooks. The server (src/net/director.ts) builds the command; the page never makes one up.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import { net } from "../net";
import { api, toast } from "../ui/api";

const emit = defineEmits<{ close: [] }>();
interface Info { home: string; dir: string; dirError: string | null; tools: { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }; root: boolean; session: boolean; sessionName: string; command: string }
const info = ref<Info | null>(null), dir = ref(""), open = ref(1), copied = ref(false), busy = ref(false), err = ref(""), started = ref("");
const el = ref<HTMLElement | null>(null);

const connected = computed(() => Object.values(net.agents).some((a) => a.name === "root" && a.life === "live"));
const canStart = computed(() => !!info.value?.tools.tmux && !!info.value?.tools.claude && !info.value?.session && !info.value?.dirError);
const missing = computed(() => (["claude", "tmux", "python3"] as const).filter((k) => info.value && !info.value.tools[k]));
const why = computed(() => {
  const i = info.value; if (!i) return "";
  if (!i.tools.tmux) return "tmux is not installed, so agentnet cannot start it for you. Copy the command instead.";
  if (!i.tools.claude) return "Claude Code is not installed yet. Install it, then copy the command.";
  if (i.session) return `A tmux session ${i.sessionName} already runs. Attach with: tmux attach -t ${i.sessionName}`;
  return "";
});

async function load() {
  try {
    const i = await api<Info>("v1/panel/director" + (dir.value ? "?dir=" + encodeURIComponent(dir.value) : ""));
    if (!dir.value) dir.value = i.home;
    info.value = i;
  } catch (e) { err.value = (e as Error).message; }
}
let t: ReturnType<typeof setTimeout> | undefined;
watch(dir, () => { clearTimeout(t); t = setTimeout(load, 350); });
onMounted(() => { load(); nextTick(() => el.value?.querySelector<HTMLInputElement>("input")?.focus()); });
onUnmounted(() => clearTimeout(t));
watch(connected, (c) => { if (c) open.value = 3; }, { immediate: true });

async function copy() {
  if (!info.value) return;
  try { await navigator.clipboard.writeText(info.value.command); copied.value = true; setTimeout(() => (copied.value = false), 1600); } catch { toast("Copy failed"); }
}
async function start() {
  busy.value = true; err.value = "";
  try {
    await api("v1/panel/director/start", { method: "POST", body: { dir: dir.value } });
    started.value = "Started in tmux. The first time, Claude Code asks you to trust the folder: run tmux attach -t " + (info.value?.sessionName ?? "agentnet-director") + ", answer Yes, then press Ctrl-b d.";
    open.value = 3; load();
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
function trap(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); emit("close"); return; }
  if (e.key !== "Tab" || !el.value) return;
  const f = [...el.value.querySelectorAll<HTMLElement>("button:not([disabled]),input,a[href]")].filter((x) => x.offsetParent);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
const state = (n: number) => (n < 3 ? (connected.value || open.value > n ? "done" : "") : n === 3 ? (connected.value ? "done" : "") : "");
</script>

<template>
  <div class="ds-scrim" @click.self="emit('close')">
    <div ref="el" class="ds" role="dialog" aria-modal="true" aria-label="Set up your director" @keydown="trap">
      <header class="ds-h"><h2>Set up your director</h2><button type="button" class="ds-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="20" /></button></header>
      <p class="ds-lead">The director is the one Claude Code session you talk to. It starts the other agents and shows up at the top of the map.</p>
      <p v-if="missing.length" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> Not found on this Mac: {{ missing.join(", ") }}. Run <code>agentnet doctor</code> for the fix.</p>

      <ol class="ds-steps">
        <li :class="['ds-s', { on: open === 1, ok: state(1) === 'done' }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 1" @click="open = open === 1 ? 0 : 1"><i class="ds-n"><Icon v-if="state(1) === 'done'" name="check" :size="14" /><template v-else>1</template></i><b>Project folder</b><span v-if="open !== 1" class="ds-sum">{{ dir }}</span></button>
          <div class="ds-x2"><div class="ds-in">
            <label class="ds-f"><span>The director works in this folder</span><input v-model="dir" type="text" spellcheck="false" autocomplete="off" placeholder="/Users/you/project" /></label>
            <p v-if="info?.dirError" class="ds-err" role="alert">{{ info.dirError }}</p>
            <button type="button" class="ds-b" :disabled="!!info?.dirError || !dir" @click="open = 2">Next</button>
          </div></div>
        </li>

        <li :class="['ds-s', { on: open === 2, ok: state(2) === 'done' }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 2" @click="open = open === 2 ? 0 : 2"><i class="ds-n"><Icon v-if="state(2) === 'done'" name="check" :size="14" /><template v-else>2</template></i><b>Start the director</b></button>
          <div class="ds-x2"><div class="ds-in">
            <p class="ds-t">Run this in a terminal. It starts Claude Code with the agentnet plugin as the director.</p>
            <div class="ds-cmd"><code>{{ info?.command ?? "…" }}</code>
              <button type="button" class="ds-cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
            <div class="ds-row">
              <button type="button" class="ds-b" :disabled="!canStart || busy" @click="start"><Icon name="square-terminal" :size="15" /> {{ busy ? "Starting…" : "Start director for me" }}</button>
              <span class="ds-or">or paste the command above</span>
            </div>
            <p v-if="why" class="ds-t sm">{{ why }}</p>
            <p v-if="started" class="ds-t sm">{{ started }}</p>
            <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
          </div></div>
        </li>

        <li :class="['ds-s', { on: open === 3, ok: connected }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 3" @click="open = open === 3 ? 0 : 3"><i class="ds-n"><Icon v-if="connected" name="check" :size="14" /><template v-else>3</template></i><b>Wait for the director</b><span class="ds-pill" :class="connected ? 'g' : 'w'" role="status">{{ connected ? "Connected" : "Waiting" }}</span></button>
          <div class="ds-x2"><div class="ds-in">
            <p v-if="connected" class="ds-t"><span class="ds-live" /> The director said hello. This card is now your live director. You can talk to it in its terminal.</p>
            <p v-else class="ds-t"><span class="ds-live wait" /> Nothing yet. This turns green the moment the director connects, so you can leave this open while you start it.</p>
            <button v-if="connected" type="button" class="ds-b" @click="open = 4">Next</button>
          </div></div>
        </li>

        <li :class="['ds-s', { on: open === 4 }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 4" @click="open = open === 4 ? 0 : 4"><i class="ds-n">4</i><b>Starter hooks</b><span class="ds-opt">optional</span></button>
          <div class="ds-x2"><div class="ds-in">
            <p class="ds-t">Hooks add guard rails and routing to every agent. The starter set is a good first pick. You can change it later on the Hooks page.</p>
            <a class="ds-b ghost" href="#/hooks?starter=1" @click="emit('close')">Install starter hooks <Icon name="arrow-up-right" :size="15" /></a>
          </div></div>
        </li>
      </ol>
      <footer class="ds-f2"><button type="button" class="ds-b ghost" @click="emit('close')">{{ connected ? "Done" : "Close" }}</button></footer>
    </div>
  </div>
</template>

<style scoped>
.ds-scrim{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55);animation:dsin .2s var(--ease)}
.ds{width:min(560px,100%);max-height:min(90dvh,760px);overflow-y:auto;display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 30px 80px rgba(0,0,0,.6);animation:dsup .28s cubic-bezier(.2,.8,.2,1)}
.ds *{min-width:0}
.ds-h{display:flex;align-items:center}
.ds-h h2{margin:0;font:700 18px/1.2 var(--body);text-transform:none;color:var(--ink)}
.ds-x{margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}
.ds-x:hover{background:var(--track)}
.ds-lead{margin:0;color:var(--muted);font-size:13.5px;line-height:1.45}
.ds-warn{display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent);font-size:13px}
.ds-warn code,.ds-cmd code{font-family:var(--mono)}
.ds-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.ds-s{border:1px solid var(--line);border-radius:14px;background:var(--panel-2);transition:border-color .2s var(--ease)}
.ds-s.on{border-color:color-mix(in srgb,var(--ink) 28%,var(--line))}
.ds-s.ok{border-color:color-mix(in srgb,var(--on) 45%,var(--line))}
.ds-sh{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:8px 12px;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer;border-radius:14px}
.ds-sh b{font:650 14.5px/1.2 var(--body)}
.ds-sh:focus-visible,.ds input:focus-visible,.ds-b:focus-visible,.ds-cp:focus-visible,.ds-x:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ds-n{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);font:600 12px/1 var(--body);font-style:normal}
.ds-s.ok .ds-n{background:var(--on);border-color:var(--on);color:#06210f}
.ds-sum,.ds-opt{margin-left:auto;color:var(--muted);font:500 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.ds-opt{font-family:var(--body)}
.ds-pill{margin-left:auto;padding:2px 9px;border-radius:999px;font:600 11.5px/1.5 var(--body)}
.ds-pill.g{background:var(--on-bg);color:var(--on)}.ds-pill.w{background:var(--track);color:var(--muted)}
.ds-x2{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1)}
.ds-s.on .ds-x2{grid-template-rows:1fr}
.ds-in{overflow:hidden;display:grid;gap:10px;padding:0 12px;visibility:hidden;transition:visibility 0s .28s}
.ds-s.on .ds-in{padding-bottom:12px;visibility:visible;transition-delay:0s}
.ds-f{display:grid;gap:6px}.ds-f span{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ds input{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:13px var(--mono)}
.ds-t{margin:0;font-size:13.5px;line-height:1.45}.ds-t.sm{font-size:12.5px;color:var(--muted)}
.ds-cmd{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.ds-cmd code{font-size:12px;line-height:1.5;word-break:break-all;user-select:all}
.ds-cp{justify-self:end;display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ds-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ds-or{color:var(--muted);font-size:12.5px}
.ds-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;justify-self:start;min-height:40px;padding:0 16px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer;text-decoration:none}
.ds-b:disabled{opacity:.35;cursor:default}
.ds-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.ds-err{margin:0;color:var(--bad);font-size:12.5px}
.ds-live{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%;background:var(--on)}
.ds-live.wait{background:var(--muted);animation:dsp 1.6s ease-in-out infinite}
.ds-f2{display:flex;justify-content:flex-end}
@keyframes dsin{from{opacity:0}}@keyframes dsup{from{opacity:0;transform:translateY(12px) scale(.98)}}@keyframes dsp{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.ds-scrim,.ds,.ds-live.wait{animation:none}.ds-x2{transition:none}}
</style>
