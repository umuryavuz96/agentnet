<script setup lang="ts">
// "Set up your director": one guided flow, walked in order. Adopt: folder > type > scan > review > preview > apply > director ready (> hooks).
// Clean: folder > type > start > director ready (> hooks). Exactly one step is active; a step is green only when its work is really
// done (a scan that reported, a plan that was applied, a root hello that arrived AFTER this flow started it). A root agent that was
// already live before the flow never turns a step green. The server builds every command and plan; the page never makes one up
// (src/net/director.ts, adopt-*.ts, docs/internal/SPEC-adopt-workspace.md section 7).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetAdoptFindings from "./AgentnetAdoptFindings.vue";
import AgentnetAdoptPreview from "./AgentnetAdoptPreview.vue";
import AgentnetAdoptAfter from "./AgentnetAdoptAfter.vue";
import { net } from "../net";
import { api, toast } from "../ui/api";
import { defaultPicks, type AdoptPlan, type AdoptState, type Launch, type Picks, type Precheck } from "../adopt";
import { adoptApply, adoptCancel, adoptPlan, adoptScan, adoptState } from "../adoptApi";

const emit = defineEmits<{ close: [] }>();
interface Info { home: string; dir: string; dirError: string | null; tools: { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }; root: boolean; session: boolean; sessionName: string; command: string; precheck?: Precheck; launch?: Launch }
type Mode = "clean" | "adopt";
type Key = "folder" | "type" | "scan" | "review" | "preview" | "apply" | "start" | "ready" | "hooks";
const info = ref<Info | null>(null), dir = ref(""), copied = ref(false), busy = ref(false), err = ref(""), started = ref("");
const mode = ref<Mode>("clean"), modeTouched = ref(false);
const ad = ref<AdoptState | null>(null), picks = ref<Picks>({ findings: {}, skipActions: [] }), plan = ref<AdoptPlan | null>(null);
const working = ref(false), reviewErr = ref(""), scanErr = ref(""), undoCopied = ref(false), attachCopied = ref(false), changedOpen = ref(false);
const el = ref<HTMLElement | null>(null);
let resuming = true;
const cur = ref<Key>("folder"), startedAt = ref(0), now = ref(Date.now());

const isAdopt = computed(() => mode.value === "adopt");
const steps = computed<{ k: Key; t: string }[]>(() => [
  { k: "folder", t: "Project folder" }, { k: "type", t: "Setup type" },
  ...(isAdopt.value ? [{ k: "scan" as Key, t: "Scan" }, { k: "review" as Key, t: "Review" }, { k: "preview" as Key, t: "Preview" }, { k: "apply" as Key, t: "Apply" }] : [{ k: "start" as Key, t: "Start the director" }]),
  { k: "ready", t: "Director ready" }, { k: "hooks", t: "Starter hooks" },
]);
const idx = (k: Key) => steps.value.findIndex((x) => x.k === k);
const num = (k: Key) => idx(k) + 1;
const state = (k: Key): "done" | "on" | "todo" => (k === "hooks" ? (cur.value === "hooks" ? "on" : "todo") : idx(k) < idx(cur.value) ? "done" : k === cur.value ? "on" : "todo");
const pct = computed(() => Math.round((Math.min(idx(cur.value), steps.value.length - 2) / (steps.value.length - 2)) * 100));

const root = computed(() => Object.values(net.agents).find((a) => a.name === "root" && a.life === "live"));
const rootLive = computed(() => !!root.value);
const launch = computed<Launch | null>(() => { const l = info.value?.launch ?? (ad.value as (AdoptState & { launch?: Launch }) | null)?.launch ?? null; return l && l.state !== "idle" ? l : null; }); // idle = the server tracks no start: the page falls back to its own clock
const t0 = computed(() => launch.value?.startedAt ?? startedAt.value);
/** Connected means a root hello after THIS flow started the director; a root that was live before never counts. */
const up = computed(() => {
  if (launch.value?.state) return launch.value.state === "connected" && rootLive.value;
  if (!rootLive.value) return false;
  return t0.value ? Number((root.value as { connectedAt?: number } | undefined)?.connectedAt ?? 0) >= t0.value : false;
});
const applied = computed(() => ad.value?.phase === "applied" && ad.value.mode === "adopt");
const toolsOk = computed(() => !!info.value?.tools.tmux && !!info.value?.tools.claude);
const canStart = computed(() => toolsOk.value && !info.value?.session && !info.value?.dirError);
const missing = computed(() => (["claude", "tmux", "python3"] as const).filter((k) => info.value && !info.value.tools[k]));
const session = computed(() => info.value?.sessionName ?? launch.value?.sessionName ?? "agentnet-root");
const attach = computed(() => `tmux attach -t ${session.value}`);
const why = computed(() => {
  const i = info.value; if (!i) return "";
  if (!i.tools.tmux) return "tmux is not installed, so agentnet cannot start it for you. Copy the command instead.";
  if (!i.tools.claude) return "Claude Code is not installed yet. Install it, then copy the command.";
  if (i.session && !t0.value) return `A tmux session ${i.sessionName} already runs. Attach with: ${attach.value}`;
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

// ---- waiting for the director: a real clock, real stages, and an error with a reason when it does not come ----
const WAIT_MS = 90_000;
const deadline = computed(() => launch.value?.deadlineAt ?? (t0.value ? t0.value + WAIT_MS : 0));
const left = computed(() => Math.max(0, Math.ceil((deadline.value - now.value) / 1000)));
const elapsed = computed(() => (t0.value ? Math.max(0, Math.floor((now.value - t0.value) / 1000)) : 0));
const waitPct = computed(() => (deadline.value && t0.value ? Math.min(100, Math.round(((now.value - t0.value) / (deadline.value - t0.value)) * 100)) : 0));
const failedWhy = computed(() => {
  if (up.value) return "";
  if (launch.value?.state === "failed") return launch.value.error || "The director did not start.";
  if (!t0.value || !deadline.value || now.value < deadline.value) return "";
  if (info.value && !info.value.session) return "The tmux session ended before the director connected. Claude Code may have crashed or is not signed in.";
  if (launch.value?.stage === "trust" || !launch.value?.stage) return `The session runs but the director has not said hello. Claude Code is probably waiting at the folder-trust question. Run ${attach.value}, answer Yes, then press Ctrl-b d.`;
  return "The session runs but the director has not connected. Check it with " + attach.value + ".";
});
const stuck = computed(() => (launch.value?.state === "waiting" && !up.value && !failedWhy.value ? launch.value.error ?? "" : ""));
const dialog = computed(() => (up.value ? null : launch.value?.dialog ?? null));
const answering = ref(false), answerErr = ref("");
/** The server sends the keys only when the pane shows exactly this dialog; a 409 means it moved on or is not that dialog. */
const ANSWER: Record<string, { id: string; button: string }> = { trust: { id: "yes", button: "Trust this folder and continue" }, mcp: { id: "use", button: "Approve this MCP server" }, "mcp-multi": { id: "approve", button: "Approve MCP servers" } };
const answerBtn = computed(() => (dialog.value ? ANSWER[dialog.value.kind] : undefined));
async function answer() {
  const d = dialog.value, a = answerBtn.value; if (!d || !a) return;
  answering.value = true; answerErr.value = "";
  try { await api("v1/panel/director/answer", { method: "POST", body: { option: a.id } }); await load(); } catch (e) { answerErr.value = (e as Error).message; await load(); } finally { answering.value = false; }
}
const WSTAGES = ["session", "claude", "trust", "hello"] as const;
const wlabels: Record<string, string> = { session: "tmux session started", claude: "Claude Code is starting", trust: "Claude Code questions answered", hello: "Director said hello" };
const wsteps = computed(() => {
  const l = launch.value, hasStage = !!l?.stage, failed = !!failedWhy.value;
  const list = hasStage ? [...WSTAGES] : (["session", "hello"] as const);
  const at = up.value ? 99 : hasStage ? WSTAGES.indexOf(l!.stage!) : info.value?.session ? 1 : failed ? 1 : 0;
  // A start that ended or timed out still DID start: lines before the one that stopped are done, the stopped line carries the failure.
  return list.map((k, i) => {
    const pos = hasStage ? WSTAGES.indexOf(k) : i;
    return { k, t: wlabels[k], ok: up.value || pos < at, bad: !up.value && failed && pos === at, cur: !up.value && !failed && pos === at };
  });
});


async function load() {
  try {
    const q = [dir.value ? "dir=" + encodeURIComponent(dir.value) : "", "mode=" + mode.value].filter(Boolean).join("&");
    const i = await api<Info>("v1/panel/director?" + q);
    if (!dir.value) dir.value = i.home;
    info.value = i;
    if (!modeTouched.value && i.precheck && cur.value === "folder") mode.value = suggestAdopt.value ? "adopt" : "clean";
  } catch (e) { err.value = (e as Error).message; }
}
async function refreshAd() { try { ad.value = await adoptState(); } catch { /* an older server has no adopt routes: Adopt then shows its error on Scan */ } }
let t: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined, clock: ReturnType<typeof setInterval> | undefined;
const tick = ref(Date.now()), scanAt = ref(0);
watch(dir, (n, o) => {
  clearTimeout(t); t = setTimeout(load, 350);
  if (!resuming && o && ad.value && ["scanning", "reported", "planned"].includes(ad.value.phase)) { void discard(false); } // another folder: the old scan and plan no longer apply
});
watch(mode, () => { if (info.value) void load(); });
watch(() => ad.value?.phase, (p) => {
  clearInterval(poll);
  if (p === "scanning") poll = setInterval(async () => { tick.value = Date.now(); await refreshAd(); }, 1500);
  if (p === "reported" && cur.value === "scan") { picks.value = defaultPicks(ad.value!.report?.findings ?? []); plan.value = null; go("review"); }
});
// while waiting for the director: tick the clock every second, refresh the session state every 2 s
watch(cur, (c) => {
  clearInterval(clock);
  if (c === "ready") { now.value = Date.now(); let n = 0; clock = setInterval(() => { now.value = Date.now(); if (++n % 2 === 0) void Promise.all([load(), refreshAd()]); }, 1000); }
}, { immediate: true });
watch(up, (u) => { if (u && cur.value === "ready") go("hooks"); });
onMounted(async () => {
  await Promise.all([load(), refreshAd()]);
  const a = ad.value;
  if (a && a.workspace && a.phase !== "idle" && (a.mode === "adopt" || a.phase === "applied")) { // window reopened: resume from the server state
    modeTouched.value = true; mode.value = a.mode === "adopt" ? "adopt" : "clean"; dir.value = a.workspace;
    startedAt.value = Date.parse(a.runs?.[0]?.createdAt ?? "") || Date.now(); setTimeout(() => (resuming = false));
    if (a.phase === "scanning") { scanAt.value = Date.now(); cur.value = "scan"; }
    else if (a.phase === "reported" || a.phase === "planned") { picks.value = defaultPicks(a.report?.findings ?? []); cur.value = "review"; }
    else if (a.phase === "applying") cur.value = "apply";
    else if (a.phase === "applied") cur.value = up.value ? "hooks" : "ready";
    return;
  }
  resuming = false;
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
onUnmounted(() => { clearTimeout(t); clearInterval(poll); clearInterval(clock); document.removeEventListener("keydown", onDoc); if (opener?.isConnected) nextTick(() => opener?.focus()); });
/** Move to a step and put focus on its first control, so keyboard and screen-reader users follow the flow. */
function go(k: Key) { cur.value = k; nextTick(() => setTimeout(() => { el.value?.querySelector(".ds-s.on")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); el.value?.querySelector<HTMLElement>(".ds-s.on .ds-in input, .ds-s.on .ds-in [role=radio][aria-checked=true], .ds-s.on .ds-in .ds-b:not([disabled])")?.focus({ preventScroll: true }); }, 300)); }

async function copy(text?: string, flag: "cmd" | "undo" | "attach" = "cmd") {
  const v = text ?? info.value?.command; if (!v) return;
  try { await navigator.clipboard.writeText(v); const r = flag === "cmd" ? copied : flag === "undo" ? undoCopied : attachCopied; r.value = true; setTimeout(() => (r.value = false), 1600); } catch { toast("Copy failed"); }
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
function typeNext() { go(mode.value === "adopt" ? "scan" : "start"); }

/** Drop the scan and plan. `back` = the user pressed Back (return to the scan step); otherwise the folder changed under it. */
async function discard(back = true) { try { await adoptCancel(); } catch { /* nothing running */ } plan.value = null; await refreshAd(); if (back) go("scan"); else if (["scan", "review", "preview"].includes(cur.value)) cur.value = "type"; }
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
const stages = computed(() => [
  { k: 1, t: "Collected facts", s: ad.value?.facts ? `${ad.value.facts.signals} signals` : "" },
  ...(ad.value?.scanner === "static" ? [] : [{ k: 2, t: "Director is reading evidence…", s: "" }]),
  { k: 3, t: "Findings ready", s: "" },
]);

async function preview() {
  if (!ad.value?.scanId) return;
  working.value = true; reviewErr.value = "";
  try { plan.value = await adoptPlan(ad.value.scanId, picks.value); go("preview"); } catch (e) { reviewErr.value = (e as Error).message; } finally { working.value = false; }
}
async function applyPlan(confirmGlobal: boolean) {
  if (!plan.value) return;
  working.value = true; reviewErr.value = ""; go("apply");
  try {
    await adoptApply(plan.value.planId, confirmGlobal);
    startedAt.value = Date.now(); now.value = startedAt.value;
    started.value = "Started in tmux. The first time, Claude Code asks you to trust the folder: run " + attach.value + ", answer Yes, then press Ctrl-b d.";
    await Promise.all([refreshAd(), load()]); go("ready");
  } catch (e) {
    const m = (e as Error).message;
    cur.value = "preview";
    if (/changed since|stale|not the current plan/i.test(m)) { try { plan.value = await adoptPlan(ad.value!.scanId!, picks.value); } catch { /* keeps the old preview */ } reviewErr.value = "A file changed while you were reviewing. Review again."; }
    else reviewErr.value = m;
  } finally { working.value = false; }
}
/** Start (clean) or restart (retry) the director. A retry kills a leftover tmux session first (`restart`). */
async function start(retry = false) {
  busy.value = true; err.value = "";
  try {
    await api("v1/panel/director/start", { method: "POST", body: { dir: dir.value, mode: mode.value, ...(retry ? { restart: true } : {}) } });
    startedAt.value = Date.now(); now.value = startedAt.value;
    started.value = "Started in tmux. The first time, Claude Code asks you to trust the folder: run " + attach.value + ", answer Yes, then press Ctrl-b d.";
    await load(); go("ready");
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

const lead = computed(() => !isAdopt.value || !["scan", "review", "preview", "apply"].includes(cur.value) ? "The director is the one Claude Code session you talk to. It starts the other agents and shows up at the top of the map." : "agentnet reads your workspace first, then asks before it changes anything. Every change is backed up and can be undone.");
const sum = (k: Key) => k === "folder" ? dir.value : k === "type" ? (isAdopt.value ? "Adopt my workspace" : "Clean") : k === "scan" ? (ad.value?.report ? `${ad.value.report.findings.length} findings` : "") : k === "review" ? "choices saved" : k === "preview" ? "plan ready" : k === "apply" ? "applied" : k === "start" ? "started" : k === "ready" ? "connected" : "";
const wide = computed(() => isAdopt.value && ["review", "preview"].includes(cur.value));
</script>

<template>
  <div class="ds-scrim" @click.self="emit('close')">
    <div ref="el" class="ds" :class="{ wide }" role="dialog" aria-modal="true" aria-label="Set up your director" @keydown="trap">
      <div class="ds-h"><h2>Set up your director</h2><span class="ds-cnt num" aria-live="polite">Step {{ Math.min(num(cur), steps.length - 1) }} of {{ steps.length - 1 }}</span><button type="button" class="ds-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="20" /></button></div>
      <div class="ds-rail" role="progressbar" aria-label="Setup progress" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: pct + '%' }" /></div>
      <p class="ds-lead">{{ lead }}</p>
      <p v-if="missing.length" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> Not found on this Mac: {{ missing.join(", ") }}. Run <code>agentnet doctor</code> for the fix.</p>

      <ol class="ds-steps">
        <li v-for="s in steps" :key="s.k" :class="['ds-s', state(s.k), { opt: s.k === 'hooks' }]" :aria-current="state(s.k) === 'on' ? 'step' : undefined">
          <div class="ds-sh"><i class="ds-n"><Icon v-if="state(s.k) === 'done'" name="check" :size="14" class="pop" /><template v-else>{{ s.k === 'hooks' ? '+' : num(s.k) }}</template></i><b>{{ s.t }}</b><span v-if="state(s.k) === 'done'" class="ds-sum">{{ sum(s.k) }}</span><span v-else-if="s.k === 'hooks'" class="ds-opt">optional</span></div>
          <div class="ds-x2"><div class="ds-in">

            <!-- folder -->
            <template v-if="s.k === 'folder'">
              <label class="ds-f"><span>The director works in this folder</span><span class="ds-pick"><input v-model="dir" type="text" spellcheck="false" autocomplete="off" placeholder="/Users/you/project" /><button type="button" class="ds-b ghost" :disabled="picking" @click.prevent="pick"><Icon name="folder-open" :size="15" /> {{ picking ? "Waiting…" : "Choose…" }}</button></span></label>
              <p v-if="pickMsg" class="ds-t sm" role="status">{{ pickMsg }}</p>
              <p v-if="info?.dirError" class="ds-err" role="alert">{{ info.dirError }}</p>
              <p v-if="rootLive && !t0" class="ds-t sm" role="status">A director is already connected. Finishing this setup starts a fresh one in this folder; nothing below counts as done until then.</p>
              <button type="button" class="ds-b" :disabled="!!info?.dirError || !dir" @click="go('type')">Next</button>
            </template>

            <!-- type -->
            <template v-else-if="s.k === 'type'">
              <div class="ds-types" role="radiogroup" aria-label="Setup type" @keydown="modeKey">
                <button type="button" role="radio" class="ds-type" :class="{ sel: !isAdopt }" :aria-checked="!isAdopt" :tabindex="!isAdopt ? 0 : -1" @click="choose('clean')">
                  <i class="ds-dot" /><b>Clean</b><span>Fresh director with its own home. Your project is attached, nothing in it is read or changed.</span>
                </button>
                <button type="button" role="radio" class="ds-type" :class="{ sel: isAdopt }" :aria-checked="isAdopt" :tabindex="isAdopt ? 0 : -1" @click="choose('adopt')">
                  <i class="ds-dot" /><b>Adopt my workspace</b><span>Keep your CLAUDE.md, rules and repo agents. agentnet scans first and asks before it changes anything.</span>
                </button>
              </div>
              <p v-if="hint" class="ds-t sm" role="status">{{ hint }}</p>
              <p class="ds-t sm">{{ isAdopt ? "Next: scan, review, preview, apply, then the director starts." : "Next: start the director. No scan is needed." }}</p>
              <div class="ds-row"><button type="button" class="ds-b ghost" @click="go('folder')">Back</button><button type="button" class="ds-b" @click="typeNext">Next</button></div>
            </template>

            <!-- scan -->
            <template v-else-if="s.k === 'scan'">
              <template v-if="stage === 0">
                <p class="ds-t">Reads your workspace. Read-only: nothing is changed in this step.</p>
                <p class="ds-t sm">The director reads these files through your Claude account, which uses a few model calls. It may read this folder, its repos and ~/.claude (settings, rules). Never .env, keys or tokens.</p>
                <div class="ds-row">
                  <button type="button" class="ds-b ghost" @click="go('type')">Back</button>
                  <button type="button" class="ds-b" :disabled="working || !toolsOk" @click="scan('director')">{{ working ? "Starting…" : "Scan with the director" }}</button>
                  <button type="button" class="ds-link" :disabled="working" @click="scan('static')">Basic scan (no model)</button>
                </div>
                <p v-if="!toolsOk" class="ds-t sm">The director scan needs Claude Code and tmux. Basic scan works without them.</p>
                <p v-if="scanErr" class="ds-err" role="alert">{{ scanErr }}</p>
              </template>
              <template v-else-if="stage === -1">
                <p class="ds-err" role="alert">{{ ad?.failed }}</p>
                <div class="ds-row"><button type="button" class="ds-b" :disabled="working" @click="scan('director')">Retry</button><button type="button" class="ds-link" :disabled="working" @click="scan('static')">Basic scan</button><button type="button" class="ds-link" @click="discard()">Cancel</button></div>
              </template>
              <template v-else>
                <p class="ds-t">Reading your workspace. Read-only: nothing is changed in this step.</p>
                <div role="status" aria-live="polite"><ul class="ds-prog">
                  <li v-for="g in stages" :key="g.k" :class="{ ok: stage > g.k || (stage === 3 && g.k === 3), cur: stage === g.k && stage < 3 }">
                    <i><Icon v-if="stage > g.k || stage === 3" name="check" :size="12" /><Icon v-else-if="stage === g.k" name="loader" :size="12" class="spin" /></i><span>{{ g.t }}</span><em v-if="g.s">{{ g.s }}</em>
                  </li>
                </ul></div>
                <p v-if="slow" class="ds-t sm">Nothing yet. The first time, Claude Code asks you to trust the folder: run {{ attach }}, answer Yes, then press Ctrl-b d.</p>
                <p class="ds-t sm">It may read this folder, its repos and your Claude settings. It never reads secrets.</p>
                <div v-if="scanning" class="ds-row"><button type="button" class="ds-b ghost" @click="cancelScan">Cancel scan</button><button type="button" class="ds-link" @click="scan('static')">Basic scan instead</button></div>
              </template>
            </template>

            <!-- review -->
            <template v-else-if="s.k === 'review'">
              <AgentnetAdoptFindings v-if="ad?.report" :report="ad.report" :picks="picks" :busy="working" :base="ad.report.workspace" @back="discard()" @preview="preview" @rescan="scan(ad?.scanner === 'static' ? 'static' : 'director')" />
              <p v-if="reviewErr" class="ds-err" role="alert">{{ reviewErr }}</p>
            </template>

            <!-- preview -->
            <template v-else-if="s.k === 'preview'">
              <template v-if="ad?.report && plan">
                <AgentnetAdoptAfter :report="ad.report" :picks="picks" :base="ad.report.workspace" />
                <AgentnetAdoptPreview :plan="plan" :findings="ad.report.findings" :busy="working" :error="reviewErr" :base="ad.report.workspace" @back="go('review')" @apply="applyPlan" />
              </template>
            </template>

            <!-- apply -->
            <template v-else-if="s.k === 'apply'">
              <div role="status" aria-live="polite"><ul class="ds-prog">
                <li class="cur"><i><Icon name="loader" :size="12" class="spin" /></i><span>Backing up, changing files, starting the director…</span></li>
              </ul></div>
              <p class="ds-t sm">Every touched file is backed up first. If a step fails, the run rolls itself back.</p>
            </template>

            <!-- clean start -->
            <template v-else-if="s.k === 'start'">
              <p class="ds-t">Run this in a terminal. It starts Claude Code with the agentnet plugin as the director.</p>
              <div class="ds-cmd"><code>{{ info?.command ?? "…" }}</code>
                <button type="button" class="ds-cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy()"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
              <div class="ds-row">
                <button type="button" class="ds-b ghost" @click="go('type')">Back</button>
                <button type="button" class="ds-b" :disabled="!canStart || busy" @click="start()"><Icon name="square-terminal" :size="15" /> {{ busy ? "Starting…" : "Start director for me" }}</button>
                <button v-if="t0" type="button" class="ds-link" @click="go('ready')">Skip, I started it myself</button>
                <span v-else class="ds-or">or paste the command above</span>
              </div>
              <p v-if="why" class="ds-t sm">{{ why }}</p>
              <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
            </template>

            <!-- ready -->
            <template v-else-if="s.k === 'ready'">
              <template v-if="state('ready') === 'done'"><p class="ds-t"><span class="ds-live" /> The director said hello.</p></template>
              <template v-else>
                <div role="status" aria-live="polite">
                  <ul class="ds-prog">
                    <li v-for="w in wsteps" :key="w.k" :class="{ ok: w.ok, cur: w.cur, bad: w.bad }">
                      <i><Icon v-if="w.ok" name="check" :size="12" /><Icon v-else-if="w.cur" name="loader" :size="12" class="spin" /><Icon v-else-if="w.bad" name="x" :size="12" /></i><span>{{ w.t }}</span>
                    </li>
                  </ul>
                  <div v-if="dialog" class="ds-dlg" role="group" aria-label="Claude Code is asking a question">
                      <p class="ds-t"><b>Claude Code is waiting for you.</b> The director cannot connect until this is answered.</p>
                      <p class="ds-t">{{ dialog.title }}</p>
                      <ul v-if="dialog.servers?.length" class="ds-opts" aria-label="MCP servers"><li v-for="v in dialog.servers" :key="v.name" :class="{ pick: v.enable }"><b>{{ v.name }}</b> {{ v.enable ? "will be enabled" : "left off: adopt switched it off" }}</li></ul>
                      <ul v-else class="ds-opts" aria-label="Choices in the terminal"><li v-for="o in dialog.options" :key="o.id" :class="{ pick: o.id === answerBtn?.id }">{{ o.label }}</li></ul>
                      <button v-if="answerBtn" type="button" class="ds-b" :disabled="answering" @click="answer"><Icon name="check" :size="15" /> {{ answering ? "Answering…" : answerBtn.button }}</button>
                      <p v-if="answerErr" class="ds-err" role="alert">{{ answerErr }}</p>
                    </div>
                  <template v-if="!failedWhy">
                    <div class="ds-bar" role="progressbar" aria-label="Waiting for the director" :aria-valuenow="waitPct" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: waitPct + '%' }" /></div>
                    <p v-if="stuck && !dialog" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> {{ stuck }}</p>
                    <pre v-if="launch?.pane && !dialog" class="ds-pane" tabindex="0" aria-label="Last lines of the director terminal">{{ launch.pane }}</pre>
                    <p class="ds-t sm">Waiting {{ elapsed }} s. Gives up in {{ left }} s with the reason. {{ started }}</p>
                  </template>
                </div>
                <div v-if="failedWhy" class="ds-fail" role="alert">
                  <p class="ds-err"><Icon name="triangle-alert" :size="14" /> {{ failedWhy }}</p>
                  <div class="ds-row">
                    <button type="button" class="ds-b" :disabled="busy" @click="start(true)"><Icon name="rotate-ccw" :size="15" /> {{ busy ? "Starting…" : "Retry" }}</button>
                    <button v-if="info?.session" type="button" class="ds-cp" :aria-label="attachCopied ? 'Copied' : 'Copy attach command'" @click="copy(attach, 'attach')"><Icon :name="attachCopied ? 'check' : 'copy'" :size="14" /> {{ attachCopied ? "Copied" : "Copy attach command" }}</button>
                  </div>
                  <pre v-if="launch?.pane" class="ds-pane" tabindex="0" aria-label="Last lines of the director terminal">{{ launch.pane }}</pre>
                  <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
                </div>
              </template>
            </template>

            <!-- hooks -->
            <template v-else>
              <p class="ds-t"><span class="ds-live" /> The director is connected. It is now your live director; talk to it in its terminal.</p>
              <div v-if="applied" class="ds-undo">
                <p class="ds-t">Done. Undo anytime with <code>agentnet adopt rollback</code></p>
                <div class="ds-row">
                  <button type="button" class="ds-cp" :aria-label="undoCopied ? 'Copied' : 'Copy rollback command'" @click="copy('agentnet adopt rollback', 'undo')"><Icon :name="undoCopied ? 'check' : 'copy'" :size="14" /> {{ undoCopied ? "Copied" : "Copy" }}</button>
                  <button v-if="ad?.plan" type="button" class="ds-link" :aria-expanded="changedOpen" @click="changedOpen = !changedOpen">What changed</button>
                </div>
                <div class="ds-chg" :class="{ on: changedOpen }"><ul class="ds-chgin"><li v-for="f in ad?.plan?.willBackup ?? []" :key="f"><code>{{ f }}</code> backed up and changed</li><li v-if="ad?.plan"><code>{{ ad.plan.backupDir }}</code></li></ul></div>
              </div>
              <p class="ds-t">Hooks add guard rails and routing to every agent. The starter set is a good first pick. You can change it later on the Hooks page.</p>
              <a class="ds-b ghost" href="#/hooks?starter=1" @click="emit('close')">Install starter hooks <Icon name="arrow-up-right" :size="15" /></a>
            </template>

          </div></div>
        </li>
      </ol>
      <div class="ds-f2"><button type="button" class="ds-b ghost" @click="emit('close')">{{ up ? "Done" : "Close" }}</button></div>
    </div>
  </div>
</template>

<style scoped>
.ds-scrim{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.55);animation:dsin .2s var(--ease)}
.ds{width:min(560px,100%);max-height:min(90dvh,860px);overflow-y:auto;overscroll-behavior:contain;display:grid;gap:12px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 30px 80px rgba(0,0,0,.6);animation:dsup .28s cubic-bezier(.2,.8,.2,1);transition:width .28s cubic-bezier(.2,.8,.2,1)}
@media (min-width:900px){.ds.wide{width:min(720px,100%)}}
.ds *{min-width:0}
.ds-h{display:flex;align-items:center}
.ds-cnt{margin-left:auto;color:var(--muted);font:500 12px var(--mono)}
.ds-h h2{margin:0;font:700 18px/1.2 var(--body);text-transform:none;color:var(--ink)}
.ds-x{margin:-8px -8px -8px 8px;display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}
.ds-x:hover{background:var(--track)}
.ds-rail{height:3px;border-radius:2px;background:var(--track);overflow:hidden}
.ds-rail i{display:block;height:100%;background:var(--on);border-radius:2px;transition:width .4s cubic-bezier(.2,.8,.2,1)}
.ds-bar{height:4px;margin:8px 0 4px;border-radius:2px;background:var(--track);overflow:hidden}
.ds-bar i{display:block;height:100%;background:var(--on);transition:width 1s linear}
.ds-fail{display:grid;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--bad) 50%,var(--line));border-radius:12px;background:var(--bad-bg)}
.ds-fail .ds-err{display:flex;gap:6px;align-items:flex-start;line-height:1.45}
.ds-prog li.bad{color:var(--bad)}.ds-prog li.bad i{border-color:var(--bad);color:var(--bad)}
.ds-pane{margin:0;max-height:140px;overflow:auto;padding:8px 10px;border-radius:10px;background:var(--track);font:11.5px/1.4 var(--mono);white-space:pre-wrap;word-break:break-word}
.ds-dlg{display:grid;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent)}
.ds-opts{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:12.5px}
.ds-opts li{padding:5px 10px;border-radius:8px;background:var(--track);color:var(--muted)}.ds-opts li.pick{color:var(--ink);outline:1px solid var(--on)}
.pop{animation:dspop .3s cubic-bezier(.2,.8,.2,1)}
@keyframes dspop{from{transform:scale(.3);opacity:0}}
.ds-lead{margin:0;color:var(--muted);font-size:13.5px;line-height:1.45}
.ds-warn{display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent);font-size:13px}
.ds-warn code,.ds-cmd code,.ds-undo code,.ds-chgin code{font-family:var(--mono)}
.ds-steps{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.ds-s{scroll-margin-top:4px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2);transition:border-color .2s var(--ease),opacity .2s}
.ds-s.on{border-color:color-mix(in srgb,var(--ink) 28%,var(--line))}
.ds-s.done{border-color:color-mix(in srgb,var(--on) 45%,var(--line))}
.ds-s.todo{opacity:.55}
.ds-sh{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:8px 12px;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;border-radius:14px}
.ds-sh b{font:650 14.5px/1.2 var(--body)}
.ds input:focus-visible,.ds-b:focus-visible,.ds-cp:focus-visible,.ds-x:focus-visible,.ds-link:focus-visible,.ds-type:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ds-n{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);font:600 12px/1 var(--body);font-style:normal}
.ds-s.done .ds-n{background:var(--on);border-color:var(--on);color:#06210f}
.ds-sum,.ds-opt{margin-left:auto;color:var(--muted);font:500 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.ds-opt{font-family:var(--body)}
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
.ds-f2{display:flex;justify-content:flex-end}
/* the green accent needs white text on the light theme (axe contrast) */
:global(:root[data-theme="light"] .ds-b:not(.ghost)){color:#fff}
:global(:root[data-theme="light"] .ds-s.done .ds-n){color:#fff}
:global(:root[data-theme="light"] .ds-prog li.ok i){color:#fff}
@keyframes dsin{from{opacity:0}}@keyframes dsup{from{opacity:0;transform:translateY(12px) scale(.98)}}@keyframes dsp{50%{opacity:.3}}@keyframes dsspin{to{transform:rotate(360deg)}}
@media (max-width:640px){
  .ds-scrim{place-items:end center;padding:0}
  .ds{width:100%;max-height:100dvh;border-radius:18px 18px 0 0;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));animation:dssheet .3s cubic-bezier(.2,.8,.2,1)}
  .ds-types{grid-template-columns:1fr}
  .ds-b:not(.ghost){justify-self:stretch}
}
@keyframes dssheet{from{transform:translateY(100%)}}
@media (prefers-reduced-motion:reduce){.ds-scrim,.ds,.pop,.spin{animation:none}.ds-x2,.ds,.ds-chg,.ds-type,.ds-rail i,.ds-bar i{transition:none}}
</style>
