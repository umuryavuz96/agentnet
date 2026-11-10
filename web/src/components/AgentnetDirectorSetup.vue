<script setup lang="ts">
// "Set up your director" sheet: seven steps that expand downward one at a time.
// 1 project folder · 2 setup type (Clean or Adopt my workspace) · 3 scan (Adopt only) · 4 review the findings, then the change
// preview (Adopt only) · 5 start Claude Code as the director · 6 live check · 7 optional starter hooks.
// The server builds every command and every plan (src/net/director.ts, adopt-*.ts); the page never makes one up. See
// docs/internal/SPEC-adopt-workspace.md section 7.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetAdoptFindings from "./AgentnetAdoptFindings.vue";
import AgentnetAdoptPreview from "./AgentnetAdoptPreview.vue";
import { net } from "../net";
import { api, toast } from "../ui/api";
import { defaultPicks, type AdoptPlan, type AdoptState, type Picks, type Precheck } from "../adopt";
import { adoptApply, adoptCancel, adoptPlan, adoptScan, adoptState } from "../adoptApi";

const emit = defineEmits<{ close: [] }>();
interface Info { home: string; dir: string; dirError: string | null; tools: { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }; root: boolean; session: boolean; sessionName: string; command: string; precheck?: Precheck }
type Mode = "clean" | "adopt";
const info = ref<Info | null>(null), dir = ref(""), open = ref(1), copied = ref(false), busy = ref(false), err = ref(""), started = ref("");
const mode = ref<Mode>("clean"), modeTouched = ref(false);
const ad = ref<AdoptState | null>(null), picks = ref<Picks>({ findings: {}, skipActions: [] }), plan = ref<AdoptPlan | null>(null);
const view = ref<"findings" | "preview">("findings"), working = ref(false), reviewErr = ref(""), scanErr = ref(""), undoCopied = ref(false), changedOpen = ref(false);
const el = ref<HTMLElement | null>(null);

const connected = computed(() => Object.values(net.agents).some((a) => a.name === "root" && a.life === "live"));
const applied = computed(() => ad.value?.phase === "applied" && ad.value.mode === "adopt");
const toolsOk = computed(() => !!info.value?.tools.tmux && !!info.value?.tools.claude);
const canStart = computed(() => toolsOk.value && !info.value?.session && !info.value?.dirError);
const missing = computed(() => (["claude", "tmux", "python3"] as const).filter((k) => info.value && !info.value.tools[k]));
const why = computed(() => {
  const i = info.value; if (!i) return "";
  if (!i.tools.tmux) return "tmux is not installed, so agentnet cannot start it for you. Copy the command instead.";
  if (!i.tools.claude) return "Claude Code is not installed yet. Install it, then copy the command.";
  if (i.session) return `A tmux session ${i.sessionName} already runs. Attach with: tmux attach -t ${i.sessionName}`;
  return "";
});
const pc = computed(() => info.value?.precheck);
const hint = computed(() => {
  const p = pc.value; if (!p) return "";
  const bits = [p.instructions ? "Claude instructions" : "", p.repos ? `${p.repos} ${p.repos === 1 ? "repo" : "repos"}${p.agentDefs ? " with agents" : ""}` : ""].filter(Boolean);
  if (!bits.length && !p.claudeDir) return "Nothing agent-related found in this folder. Clean is suggested.";
  return `This folder has ${bits.length ? bits.join(" and ") : "a .claude folder"}. ${mode.value === "adopt" ? "Adopt is suggested." : "You chose Clean."}`;
});
const suggestAdopt = computed(() => !!pc.value && (pc.value.instructions || pc.value.claudeDir || pc.value.repos > 0));

async function load() {
  try {
    const q = [dir.value ? "dir=" + encodeURIComponent(dir.value) : "", "mode=" + mode.value].filter(Boolean).join("&");
    const i = await api<Info>("v1/panel/director?" + q);
    if (!dir.value) dir.value = i.home;
    info.value = i;
    if (!modeTouched.value && i.precheck) mode.value = suggestAdopt.value ? "adopt" : "clean";
  } catch (e) { err.value = (e as Error).message; }
}
async function refreshAd() { try { ad.value = await adoptState(); } catch { /* an older server has no adopt routes: Adopt then shows its error on Scan */ } }
let t: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined;
const tick = ref(Date.now()), scanAt = ref(0);
watch(dir, (n, o) => {
  clearTimeout(t); t = setTimeout(load, 350);
  if (o && ad.value && ["scanning", "reported", "planned"].includes(ad.value.phase)) { void discard(); } // another folder: the old scan and plan no longer apply
});
watch(mode, () => { if (info.value) void load(); });
watch(() => ad.value?.phase, (p) => {
  clearInterval(poll);
  if (p === "scanning") poll = setInterval(async () => { tick.value = Date.now(); await refreshAd(); }, 1500);
  if (p === "reported" && open.value === 3) { picks.value = defaultPicks(ad.value!.report?.findings ?? []); view.value = "findings"; plan.value = null; open.value = 4; }
});
onMounted(async () => {
  await Promise.all([load(), refreshAd()]);
  const a = ad.value;
  if (a && a.workspace && a.mode === "adopt" && a.phase !== "idle") { // window reopened: resume from the server state
    modeTouched.value = true; mode.value = "adopt"; dir.value = a.workspace;
    if (a.phase === "scanning") { scanAt.value = Date.now(); open.value = 3; }
    else if (a.phase === "reported" || a.phase === "planned") { picks.value = defaultPicks(a.report?.findings ?? []); open.value = 4; }
    else if (a.phase === "applied") open.value = 5;
    return;
  }
  nextTick(() => el.value?.querySelector<HTMLInputElement>("input")?.focus());
});
/** Focus can fall to <body> when the button that had it leaves (Scan, Preview): Escape and Tab must still act on the open sheet. */
function onDoc(e: KeyboardEvent) {
  if (!el.value || el.value.contains(document.activeElement)) return;
  if (e.key === "Escape") emit("close");
  else if (e.key === "Tab") { e.preventDefault(); el.value.querySelector<HTMLElement>("button:not([disabled])")?.focus(); }
}
/** The button that opened the window gets focus back when it closes (keyboard users must not land on <body>). */
let opener: HTMLElement | null = null;
onMounted(() => { opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null; document.addEventListener("keydown", onDoc); });
onUnmounted(() => { clearTimeout(t); clearInterval(poll); document.removeEventListener("keydown", onDoc); if (opener?.isConnected) nextTick(() => opener?.focus()); });
watch(connected, (c) => { if (c) open.value = 6; }, { immediate: true });

async function copy(text?: string, flag: "cmd" | "undo" = "cmd") {
  const v = text ?? info.value?.command; if (!v) return;
  try { await navigator.clipboard.writeText(v); const r = flag === "cmd" ? copied : undoCopied; r.value = true; setTimeout(() => (r.value = false), 1600); } catch { toast("Copy failed"); }
}
const picking = ref(false), pickMsg = ref("");
/** Native folder dialog on the server Mac. Cancel keeps the field; no dialog available leaves the typed path as the way. */
async function pick() {
  picking.value = true; pickMsg.value = "";
  try {
    const r = await api<{ dir: string | null }>("v1/panel/director/pick-folder", { method: "POST", body: {} });
    if (r.dir) dir.value = r.dir;
  } catch (e) { pickMsg.value = (e as Error).message; } finally { picking.value = false; }
}
function choose(m: Mode) { modeTouched.value = true; mode.value = m; }
const MODES: Mode[] = ["clean", "adopt"];
function modeKey(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d) return;
  e.preventDefault(); choose(MODES[(MODES.indexOf(mode.value) + d + 2) % 2]);
  nextTick(() => el.value?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus());
}
function typeNext() { open.value = mode.value === "adopt" ? 3 : 5; }

async function discard() { try { await adoptCancel(); } catch { /* nothing running */ } plan.value = null; view.value = "findings"; await refreshAd(); if (open.value === 4 || open.value === 3) open.value = 2; }
async function scan(m: "director" | "static") {
  scanErr.value = ""; working.value = true;
  try { await adoptScan(dir.value, m); scanAt.value = Date.now(); await refreshAd(); } catch (e) { scanErr.value = (e as Error).message; } finally { working.value = false; }
}
async function cancelScan() { await adoptCancel().catch(() => {}); await refreshAd(); }
const scanning = computed(() => ad.value?.phase === "scanning" && !ad.value.failed);
const slow = computed(() => scanning.value && !ad.value?.facts && tick.value - scanAt.value > 15000);
const stage = computed(() => {
  const a = ad.value; if (!a || a.phase === "idle") return 0;
  if (a.failed) return -1;
  if (a.phase !== "scanning") return 3;
  return a.facts ? (a.scanner === "static" ? 3 : 2) : 1;
});

async function preview() {
  if (!ad.value?.scanId) return;
  working.value = true; reviewErr.value = "";
  try { plan.value = await adoptPlan(ad.value.scanId, picks.value); view.value = "preview"; } catch (e) { reviewErr.value = (e as Error).message; } finally { working.value = false; }
}
async function applyPlan(confirmGlobal: boolean) {
  if (!plan.value) return;
  working.value = true; reviewErr.value = "";
  try {
    await adoptApply(plan.value.planId, confirmGlobal);
    started.value = "Started in tmux. The first time, Claude Code asks you to trust the folder: run tmux attach -t " + (info.value?.sessionName ?? "agentnet-root") + ", answer Yes, then press Ctrl-b d.";
    await Promise.all([refreshAd(), load()]); open.value = 5;
  } catch (e) {
    const m = (e as Error).message;
    if (/changed since|stale|not the current plan/i.test(m)) { try { plan.value = await adoptPlan(ad.value!.scanId!, picks.value); } catch { /* keeps the old preview */ } reviewErr.value = "A file changed while you were reviewing. Review again."; }
    else reviewErr.value = m;
  } finally { working.value = false; }
}
async function start() {
  busy.value = true; err.value = "";
  try {
    await api("v1/panel/director/start", { method: "POST", body: { dir: dir.value, mode: mode.value } });
    started.value = "Started in tmux. The first time, Claude Code asks you to trust the folder: run tmux attach -t " + (info.value?.sessionName ?? "agentnet-director") + ", answer Yes, then press Ctrl-b d.";
    open.value = 6; load();
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
function trap(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); emit("close"); return; }
  if (e.key !== "Tab" || !el.value) return;
  const f = [...el.value.querySelectorAll<HTMLElement>('button:not([disabled]),input,a[href],[tabindex="0"]')].filter((x) => x.offsetParent && getComputedStyle(x).visibility !== "hidden" && !(x.getAttribute("role") === "radio" && x.tabIndex < 0));
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

const isAdopt = computed(() => mode.value === "adopt");
const skip = (n: number) => !isAdopt.value && (n === 3 || n === 4);
const locked = (n: number) => skip(n) || (n === 4 && !ad.value?.report) || (n === 5 && isAdopt.value && !applied.value && !connected.value);
const done = (n: number) => {
  switch (n) {
    case 1: return open.value > 1 || connected.value;
    case 2: return open.value > 2 || connected.value;
    case 3: return isAdopt.value && (stage.value === 3 || applied.value) && open.value !== 3;
    case 4: return applied.value;
    case 5: return !!started.value || applied.value || connected.value;
    case 6: return connected.value;
    default: return false;
  }
};
const lead = computed(() => !isAdopt.value || open.value < 3 || open.value > 4 ? "The director is the one Claude Code session you talk to. It starts the other agents and shows up at the top of the map." : "agentnet reads your workspace first, then asks before it changes anything. Every change is backed up and can be undone.");
const stages = computed(() => [
  { k: 1, t: "Collected facts", s: ad.value?.facts ? `${ad.value.facts.signals} signals` : "" },
  ...(ad.value?.scanner === "static" ? [] : [{ k: 2, t: "Director is reading evidence…", s: "" }]),
  { k: 3, t: "Findings ready", s: "" },
]);
</script>

<template>
  <div class="ds-scrim" @click.self="emit('close')">
    <div ref="el" class="ds" :class="{ wide: isAdopt && open >= 3 && open <= 4 }" role="dialog" aria-modal="true" aria-label="Set up your director" @keydown="trap">
      <div class="ds-h"><h2>Set up your director</h2><button type="button" class="ds-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="20" /></button></div>
      <p class="ds-lead">{{ lead }}</p>
      <p v-if="missing.length" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> Not found on this Mac: {{ missing.join(", ") }}. Run <code>agentnet doctor</code> for the fix.</p>

      <ol class="ds-steps">
        <!-- 1 folder -->
        <li :class="['ds-s', { on: open === 1, ok: done(1) }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 1" @click="open = open === 1 ? 0 : 1"><i class="ds-n"><Icon v-if="done(1)" name="check" :size="14" /><template v-else>1</template></i><b>Project folder</b><span v-if="open !== 1" class="ds-sum">{{ dir }}</span></button>
          <div class="ds-x2"><div class="ds-in">
            <label class="ds-f"><span>The director works in this folder</span><span class="ds-pick"><input v-model="dir" type="text" spellcheck="false" autocomplete="off" placeholder="/Users/you/project" /><button type="button" class="ds-b ghost" :disabled="picking" @click.prevent="pick"><Icon name="folder-open" :size="15" /> {{ picking ? "Waiting…" : "Choose…" }}</button></span></label>
            <p v-if="pickMsg" class="ds-t sm" role="status">{{ pickMsg }}</p>
            <p v-if="info?.dirError" class="ds-err" role="alert">{{ info.dirError }}</p>
            <button type="button" class="ds-b" :disabled="!!info?.dirError || !dir" @click="open = 2">Next</button>
          </div></div>
        </li>

        <!-- 2 setup type -->
        <li :class="['ds-s', { on: open === 2, ok: done(2) }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 2" @click="open = open === 2 ? 0 : 2"><i class="ds-n"><Icon v-if="done(2)" name="check" :size="14" /><template v-else>2</template></i><b>Setup type</b><span v-if="open !== 2 && open > 2" class="ds-sum">{{ isAdopt ? "Adopt my workspace" : "Clean" }}</span></button>
          <div class="ds-x2"><div class="ds-in">
            <div class="ds-types" role="radiogroup" aria-label="Setup type" @keydown="modeKey">
              <button type="button" role="radio" class="ds-type" :class="{ sel: !isAdopt }" :aria-checked="!isAdopt" :tabindex="!isAdopt ? 0 : -1" @click="choose('clean')">
                <i class="ds-dot" /><b>Clean</b><span>Fresh director with its own home. Your project is attached, nothing in it is read or changed.</span>
              </button>
              <button type="button" role="radio" class="ds-type" :class="{ sel: isAdopt }" :aria-checked="isAdopt" :tabindex="isAdopt ? 0 : -1" @click="choose('adopt')">
                <i class="ds-dot" /><b>Adopt my workspace</b><span>Keep your CLAUDE.md, rules and repo agents. agentnet scans first and asks before it changes anything.</span>
              </button>
            </div>
            <p v-if="hint" class="ds-t sm" role="status">{{ hint }}</p>
            <button type="button" class="ds-b" @click="typeNext">Next</button>
          </div></div>
        </li>

        <!-- 3 scan -->
        <li :class="['ds-s', { on: open === 3, ok: done(3), skip: skip(3) }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 3" :disabled="locked(3)" @click="open = open === 3 ? 0 : 3"><i class="ds-n"><Icon v-if="done(3)" name="check" :size="14" /><template v-else>3</template></i><b>Scan</b><span v-if="skip(3)" class="ds-opt">Not needed for Clean</span></button>
          <div class="ds-x2"><div class="ds-in">
            <template v-if="stage === 0">
              <p class="ds-t">Reads your workspace. Read-only: nothing is changed in this step.</p>
              <p class="ds-t sm">The director reads these files through your Claude account, which uses a few model calls. It may read this folder, its repos and ~/.claude (settings, rules). Never .env, keys or tokens.</p>
              <div class="ds-row">
                <button type="button" class="ds-b" :disabled="working || !toolsOk" @click="scan('director')">{{ working ? "Starting…" : "Scan with the director" }}</button>
                <button type="button" class="ds-link" :disabled="working" @click="scan('static')">Basic scan (no model)</button>
              </div>
              <p v-if="!toolsOk" class="ds-t sm">The director scan needs Claude Code and tmux. Basic scan works without them.</p>
              <p v-if="scanErr" class="ds-err" role="alert">{{ scanErr }}</p>
            </template>
            <template v-else-if="stage === -1">
              <p class="ds-err" role="alert">{{ ad?.failed }}</p>
              <div class="ds-row"><button type="button" class="ds-b" :disabled="working" @click="scan('director')">Retry</button><button type="button" class="ds-link" :disabled="working" @click="scan('static')">Basic scan</button></div>
            </template>
            <template v-else>
              <p class="ds-t">Reading your workspace. Read-only: nothing is changed in this step.</p>
              <div role="status" aria-live="polite"><ul class="ds-prog">
                <li v-for="s in stages" :key="s.k" :class="{ ok: stage > s.k || (stage === 3 && s.k === 3), cur: stage === s.k && stage < 3 }">
                  <i><Icon v-if="stage > s.k || stage === 3" name="check" :size="12" /><Icon v-else-if="stage === s.k" name="loader" :size="12" class="spin" /></i><span>{{ s.t }}</span><em v-if="s.s">{{ s.s }}</em>
                </li>
              </ul></div>
              <p v-if="slow" class="ds-t sm">Nothing yet. The first time, Claude Code asks you to trust the folder: run tmux attach -t {{ info?.sessionName ?? "agentnet-root" }}, answer Yes, then press Ctrl-b d.</p>
              <p class="ds-t sm">It may read this folder, its repos and your Claude settings. It never reads secrets.</p>
              <div v-if="scanning" class="ds-row"><button type="button" class="ds-b ghost" @click="cancelScan">Cancel scan</button><button type="button" class="ds-link" @click="scan('static')">Basic scan instead</button></div>
            </template>
          </div></div>
        </li>

        <!-- 4 review -->
        <li :class="['ds-s', { on: open === 4, ok: done(4), skip: skip(4) }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 4" :disabled="locked(4)" @click="open = open === 4 ? 0 : 4"><i class="ds-n"><Icon v-if="done(4)" name="check" :size="14" /><template v-else>4</template></i><b>Review<template v-if="open === 4 && view === 'preview'"> &rsaquo; Preview</template></b><span v-if="skip(4)" class="ds-opt">Not needed for Clean</span></button>
          <div class="ds-x2"><div class="ds-in">
            <AgentnetAdoptFindings v-if="ad?.report && view === 'findings'" :report="ad.report" :picks="picks" :busy="working" :base="ad.report.workspace" @back="open = 3" @preview="preview" @rescan="scan(ad?.scanner === 'static' ? 'static' : 'director')" />
            <AgentnetAdoptPreview v-else-if="ad?.report && plan" :plan="plan" :findings="ad.report.findings" :busy="working" :error="reviewErr" :base="ad.report.workspace" @back="view = 'findings'" @apply="applyPlan" />
            <p v-if="reviewErr && view === 'findings'" class="ds-err" role="alert">{{ reviewErr }}</p>
          </div></div>
        </li>

        <!-- 5 start -->
        <li :class="['ds-s', { on: open === 5, ok: done(5) }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 5" :disabled="locked(5)" @click="open = open === 5 ? 0 : 5"><i class="ds-n"><Icon v-if="done(5)" name="check" :size="14" /><template v-else>5</template></i><b>Start the director</b></button>
          <div class="ds-x2"><div class="ds-in">
            <template v-if="applied">
              <p class="ds-t">Your changes are applied and the director is starting in tmux.</p>
              <p v-if="started" class="ds-t sm">{{ started }}</p>
              <button type="button" class="ds-b" @click="open = 6">Next</button>
            </template>
            <template v-else>
              <p class="ds-t">Run this in a terminal. It starts Claude Code with the agentnet plugin as the director.</p>
              <div class="ds-cmd"><code>{{ info?.command ?? "…" }}</code>
                <button type="button" class="ds-cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy()"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
              <div class="ds-row">
                <button type="button" class="ds-b" :disabled="!canStart || busy" @click="start"><Icon name="square-terminal" :size="15" /> {{ busy ? "Starting…" : "Start director for me" }}</button>
                <span class="ds-or">or paste the command above</span>
              </div>
              <p v-if="why" class="ds-t sm">{{ why }}</p>
              <p v-if="started" class="ds-t sm">{{ started }}</p>
              <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
            </template>
          </div></div>
        </li>

        <!-- 6 wait -->
        <li :class="['ds-s', { on: open === 6, ok: connected }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 6" @click="open = open === 6 ? 0 : 6"><i class="ds-n"><Icon v-if="connected" name="check" :size="14" /><template v-else>6</template></i><b>Wait for the director</b><span class="ds-pill" :class="connected ? 'g' : 'w'" role="status">{{ connected ? "Connected" : "Waiting" }}</span></button>
          <div class="ds-x2"><div class="ds-in">
            <p v-if="connected" class="ds-t"><span class="ds-live" /> The director said hello. This card is now your live director. You can talk to it in its terminal.</p>
            <p v-else class="ds-t"><span class="ds-live wait" /> Nothing yet. This turns green the moment the director connects, so you can leave this open while you start it.</p>
            <div v-if="connected && applied" class="ds-undo">
              <p class="ds-t">Done. Undo anytime with <code>agentnet adopt rollback</code></p>
              <div class="ds-row">
                <button type="button" class="ds-cp" :aria-label="undoCopied ? 'Copied' : 'Copy rollback command'" @click="copy('agentnet adopt rollback', 'undo')"><Icon :name="undoCopied ? 'check' : 'copy'" :size="14" /> {{ undoCopied ? "Copied" : "Copy" }}</button>
                <button v-if="ad?.plan" type="button" class="ds-link" :aria-expanded="changedOpen" @click="changedOpen = !changedOpen">What changed</button>
              </div>
              <div class="ds-chg" :class="{ on: changedOpen }"><ul class="ds-chgin"><li v-for="f in ad?.plan?.willBackup ?? []" :key="f"><code>{{ f }}</code> backed up and changed</li><li v-if="ad?.plan"><code>{{ ad.plan.backupDir }}</code></li></ul></div>
            </div>
            <button v-if="connected" type="button" class="ds-b" @click="open = 7">Next</button>
          </div></div>
        </li>

        <!-- 7 hooks -->
        <li :class="['ds-s', { on: open === 7 }]">
          <button type="button" class="ds-sh" :aria-expanded="open === 7" @click="open = open === 7 ? 0 : 7"><i class="ds-n">7</i><b>Starter hooks</b><span class="ds-opt">optional</span></button>
          <div class="ds-x2"><div class="ds-in">
            <p class="ds-t">Hooks add guard rails and routing to every agent. The starter set is a good first pick. You can change it later on the Hooks page.</p>
            <a class="ds-b ghost" href="#/hooks?starter=1" @click="emit('close')">Install starter hooks <Icon name="arrow-up-right" :size="15" /></a>
          </div></div>
        </li>
      </ol>
      <div class="ds-f2"><button type="button" class="ds-b ghost" @click="emit('close')">{{ connected ? "Done" : "Close" }}</button></div>
    </div>
  </div>
</template>

<style scoped>
.ds-scrim{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55);animation:dsin .2s var(--ease)}
.ds{width:min(560px,100%);max-height:min(90dvh,860px);overflow-y:auto;overscroll-behavior:contain;display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 30px 80px rgba(0,0,0,.6);animation:dsup .28s cubic-bezier(.2,.8,.2,1);transition:width .28s cubic-bezier(.2,.8,.2,1)}
@media (min-width:900px){.ds.wide{width:min(720px,100%)}}
.ds *{min-width:0}
.ds-h{display:flex;align-items:center}
.ds-h h2{margin:0;font:700 18px/1.2 var(--body);text-transform:none;color:var(--ink)}
.ds-x{margin:-8px -8px -8px auto;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}
.ds-x:hover{background:var(--track)}
.ds-lead{margin:0;color:var(--muted);font-size:13.5px;line-height:1.45}
.ds-warn{display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent);font-size:13px}
.ds-warn code,.ds-cmd code,.ds-undo code,.ds-chgin code{font-family:var(--mono)}
.ds-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.ds-s{border:1px solid var(--line);border-radius:14px;background:var(--panel-2);transition:border-color .2s var(--ease),opacity .2s}
.ds-s.on{border-color:color-mix(in srgb,var(--ink) 28%,var(--line))}
.ds-s.ok{border-color:color-mix(in srgb,var(--on) 45%,var(--line))}
.ds-s.skip{opacity:.5}
.ds-sh{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:8px 12px;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer;border-radius:14px}
.ds-sh:disabled{cursor:default}
.ds-sh b{font:650 14.5px/1.2 var(--body)}
.ds-sh:focus-visible,.ds input:focus-visible,.ds-b:focus-visible,.ds-cp:focus-visible,.ds-x:focus-visible,.ds-link:focus-visible,.ds-type:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ds-n{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);font:600 12px/1 var(--body);font-style:normal}
.ds-s.ok .ds-n{background:var(--on);border-color:var(--on);color:#06210f}
.ds-sum,.ds-opt{margin-left:auto;color:var(--muted);font:500 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.ds-opt{font-family:var(--body)}
.ds-pill{margin-left:auto;padding:2px 9px;border-radius:999px;font:600 11.5px/1.5 var(--body)}
.ds-pill.g{background:var(--on-bg);color:color-mix(in srgb,var(--on) 70%,var(--ink))}.ds-pill.w{background:var(--track);color:var(--muted)}
.ds-x2{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1)}
.ds-s.on .ds-x2{grid-template-rows:1fr}
/* overflow:clip (not hidden) keeps position:sticky of the review footers bound to the sheet's scroll */
.ds-in{min-height:0;overflow:hidden;overflow:clip;display:grid;gap:10px;padding:0 12px;visibility:hidden;transition:visibility 0s .28s}
.ds-s.on .ds-in{padding-bottom:12px;visibility:visible;transition-delay:0s}
.ds-pick{display:flex;gap:8px;align-items:stretch}.ds-pick input{flex:1;min-width:0}.ds-pick .ds-b{flex:none;text-transform:none;letter-spacing:0}
.ds-f{display:grid;gap:6px}.ds-f span{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ds input{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:13px var(--mono)}
.ds-t{margin:0;font-size:13.5px;line-height:1.45}.ds-t.sm{font-size:12.5px;color:var(--muted)}
.ds-types{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ds-type{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-content:start;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);text-align:left;cursor:pointer;transition:border-color .15s var(--ease),background .15s var(--ease)}
.ds-type:hover{border-color:var(--muted)}
.ds-type.sel{border-color:var(--on);background:var(--on-bg)}
.ds-type b{font:650 14px/1.3 var(--body);align-self:center}
.ds-type span{grid-column:1/-1;color:var(--muted);font-size:12.5px;line-height:1.45}
.ds-dot{width:18px;height:18px;border:1.5px solid var(--muted);border-radius:50%;display:grid;place-items:center;font-style:normal}
.ds-type.sel .ds-dot{border-color:var(--on)}
.ds-type.sel .ds-dot::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--on)}
.ds-prog{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ds-prog li{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13.5px}
.ds-prog li i{flex:none;display:grid;place-items:center;width:20px;height:20px;border:1.5px solid var(--line);border-radius:50%;font-style:normal}
.ds-prog li.ok{color:var(--ink)}.ds-prog li.ok i{background:var(--on);border-color:var(--on);color:#06210f}
.ds-prog li.cur{color:var(--ink)}
.ds-prog em{margin-left:auto;font:500 12px var(--mono);font-style:normal;color:var(--muted)}
.spin{animation:dsspin 1s linear infinite}
.ds-cmd{display:grid;gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--track)}
.ds-cmd code{font-size:12px;line-height:1.5;word-break:break-all;user-select:all}
.ds-cp{justify-self:end;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ds-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ds-or{color:var(--muted);font-size:12.5px}
.ds-link{min-height:44px;padding:0 6px;border:0;background:none;color:var(--muted);font:600 12.5px var(--body);text-decoration:underline;text-underline-offset:3px;cursor:pointer;justify-self:start}
.ds-link:hover{color:var(--ink)}.ds-link:disabled{opacity:.4;cursor:default}
.ds-undo{display:grid;gap:8px;justify-items:start;padding:10px 12px;border:1px solid color-mix(in srgb,var(--on) 40%,var(--line));border-radius:12px;background:var(--on-bg)}
.ds-undo .ds-cp{justify-self:start}.ds-undo .ds-row{gap:6px}
.ds-chg{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1);width:100%}
.ds-chg.on{grid-template-rows:1fr}
.ds-chgin{overflow:hidden;margin:0;padding:0;list-style:none;font-size:12.5px;display:grid;gap:4px;word-break:break-all}
.ds-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;justify-self:start;min-height:44px;padding:0 16px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer;text-decoration:none}
.ds-b:disabled{opacity:.35;cursor:default}
.ds-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.ds-err{margin:0;color:var(--bad);font-size:12.5px}
.ds-live{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%;background:var(--on)}
.ds-live.wait{background:var(--muted);animation:dsp 1.6s ease-in-out infinite}
.ds-f2{display:flex;justify-content:flex-end}
/* the green accent needs white text on the light theme (axe contrast) */
:global(:root[data-theme="light"] .ds-b:not(.ghost)){color:#fff}
:global(:root[data-theme="light"] .ds-s.ok .ds-n){color:#fff}
:global(:root[data-theme="light"] .ds-prog li.ok i){color:#fff}
@keyframes dsin{from{opacity:0}}@keyframes dsup{from{opacity:0;transform:translateY(12px) scale(.98)}}@keyframes dsp{50%{opacity:.3}}@keyframes dsspin{to{transform:rotate(360deg)}}
@media (max-width:640px){
  .ds-scrim{place-items:end center;padding:0}
  .ds{width:100%;max-height:100dvh;border-radius:18px 18px 0 0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));animation:dssheet .3s cubic-bezier(.2,.8,.2,1)}
  .ds-types{grid-template-columns:1fr}
  .ds-b:not(.ghost){justify-self:stretch}
}
@keyframes dssheet{from{transform:translateY(100%)}}
@media (prefers-reduced-motion:reduce){.ds-scrim,.ds,.ds-live.wait,.spin{animation:none}.ds-x2,.ds,.ds-chg,.ds-type{transition:none}}
</style>
