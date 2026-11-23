<script setup lang="ts">
// "Set up your director": one guided flow, walked in order. Import: folder > type > Claude account > review > preview and import >
// director (> hooks). Clean: folder > type > start > director ready (> hooks). Exactly one step is active; a step is green only when its
// work is really done (an import that applied, a root hello that arrived AFTER this flow started it). A root agent that was already
// live before the flow never turns a step green. The server builds every command, proposal and plan; the page never makes one up
// (src/net/director.ts, src/net/agent-import.ts, docs/internal/one-folder/SPEC-step5-import-ui.md).
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import AgentnetImportAccount from "./AgentnetImportAccount.vue";
import AgentnetImportReview from "./AgentnetImportReview.vue";
import AgentnetImportRun from "./AgentnetImportRun.vue";
import { net } from "../net";
import { api } from "../ui/api";
import type { Launch, Precheck } from "../adopt";
import type { ImportItem, ImportPlan, ImportState, Proposal } from "../importView";

const emit = defineEmits<{ close: [] }>();
interface Info { home: string; dir: string; dirError: string | null; tools: { bun: boolean; claude: boolean; tmux: boolean; python3: boolean }; root: boolean; session: boolean; sessionName: string; command: string; precheck?: Precheck; launch?: Launch }
type Mode = "clean" | "import";
type Key = "folder" | "account" | "review" | "preview" | "start" | "ready" | "hooks";
type RunStage = "preview" | "running" | "done" | "failed" | "rolledback";
const info = ref<Info | null>(null), dir = ref(""), copied = ref(false), busy = ref(false), err = ref(""), started = ref("");
const mode = ref<Mode>("clean"), modeTouched = ref(false);
const imp = ref<ImportState | null>(null), items = ref<ImportItem[] | null>(null), plan = ref<ImportPlan | null>(null), runStage = ref<RunStage>("preview");
const working = ref(false), reviewErr = ref(""), scanErr = ref(""), importedDir = ref<string | null>(null), runKey = ref(0);
const el = ref<HTMLElement | null>(null);
const cur = ref<Key>("folder"), startedAt = ref(0), now = ref(Date.now());

const isImport = computed(() => mode.value === "import");
// A fixed count per path. Import 6 (folder and type, account, review, preview and import, director, ready), Clean 3 (folder and type, start, ready).
type G = "folder" | "account" | "review" | "apply" | "start" | "ready";
const GROUP: Record<Key, G> = { folder: "folder", account: "account", review: "review", preview: "apply", start: "start", ready: "start", hooks: "ready" };
const steps = computed<{ k: G; t: string; h: string }[]>(() => [
  { k: "folder", t: "Folder and type", h: "Where it works, Clean or Import" },
  ...(isImport.value ? [{ k: "account" as G, t: "Claude account", h: "One token for every agent, optional" }, { k: "review" as G, t: "Review", h: "Read-only scan, you pick per item" }, { k: "apply" as G, t: "Preview and import", h: "Every op listed first, undo any time" }] : []),
  { k: "start", t: "Start the director", h: importedDir.value ? "Started by the import" : "tmux, Claude Code, hello" }, { k: "ready", t: "Ready", h: "Optional: starter hooks" },
]);
const gcur = computed(() => GROUP[cur.value]);
const idx = (k: G) => steps.value.findIndex((x) => x.k === k);
const state = (k: G): "done" | "on" | "todo" => (idx(k) < idx(gcur.value) ? "done" : k === gcur.value ? "on" : "todo");
const stepNo = computed(() => idx(gcur.value) + 1);
const pct = computed(() => Math.round((idx(gcur.value) / (steps.value.length - 1)) * 100));

const root = computed(() => Object.values(net.agents).find((a) => a.name === "root" && a.life === "live"));
const rootLive = computed(() => !!root.value);
const liveNames = computed(() => Object.values(net.agents).filter((a) => a.life === "live").map((a) => a.name));
const launch = computed<Launch | null>(() => { const l = info.value?.launch ?? null; return l && l.state !== "idle" ? l : null; }); // idle = the server tracks no start: the page falls back to its own clock
const t0 = computed(() => launch.value?.startedAt ?? startedAt.value);
/** Connected means a root hello after THIS flow started the director; a root that was live before never counts. */
const up = computed(() => {
  if (launch.value?.state) return launch.value.state === "connected" && rootLive.value;
  if (!rootLive.value) return false;
  return t0.value ? Number((root.value as { connectedAt?: number } | undefined)?.connectedAt ?? 0) >= t0.value : false;
});
const imported = computed(() => imp.value?.phase === "applied");
const toolsOk = computed(() => !!info.value?.tools.tmux && !!info.value?.tools.claude);
const canStart = computed(() => toolsOk.value && !info.value?.session && !info.value?.dirError);
const missing = computed(() => (["claude", "tmux", "python3"] as const).filter((k) => info.value && !info.value.tools[k]));
const why = computed(() => {
  const i = info.value; if (!i) return "";
  if (!i.tools.tmux) return "tmux is not installed, so agentnet cannot start it for you. Copy the command instead.";
  if (!i.tools.claude) return "Claude Code is not installed yet. Install it, then copy the command.";
  if (i.session && !t0.value) return "A director session is already running. Reset the director on the Agents page to start a new one.";
  return "";
});
const pc = computed(() => info.value?.precheck);
const hint = computed(() => {
  const p = pc.value; if (!p) return "";
  const bits = [p.instructions ? "Claude instructions" : "", p.repos ? `${p.repos} ${p.repos === 1 ? "repo" : "repos"}${p.agentDefs ? " with agents" : ""}` : ""].filter(Boolean);
  if (!bits.length && !p.claudeDir) return "Nothing agent-related found in this folder. Clean is suggested.";
  return `This folder has ${bits.length ? bits.join(" and ") : "a .claude folder"}. ${isImport.value ? "Import is suggested." : "You chose Clean."}`;
});
const suggestImport = computed(() => !!pc.value && (pc.value.instructions || pc.value.claudeDir || pc.value.repos > 0));

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
  return "The session runs but the director has not connected. The last screen of Claude Code is shown below.";
});
const stuck = computed(() => (launch.value?.state === "waiting" && !up.value && !failedWhy.value ? launch.value.error ?? "" : ""));
const dialog = computed(() => (up.value ? null : launch.value?.dialog ?? null));
const answering = ref(false), answerErr = ref("");
/** The server sends the keys only when the pane shows exactly this dialog; a 409 means it moved on or is not that dialog. */
const ANSWER: Record<string, { id: string; button: string }> = { trust: { id: "yes", button: "Trust this folder and continue" }, mcp: { id: "use", button: "Approve this MCP server" }, "mcp-multi": { id: "approve", button: "Approve MCP servers" } };
const answerBtn = computed(() => (dialog.value ? ANSWER[dialog.value.kind] : undefined));
async function answer(option?: string) {
  const d = dialog.value, a = answerBtn.value; if (!d || (!a && !option)) return;
  answering.value = true; answerErr.value = "";
  try { await api("v1/panel/director/answer", { method: "POST", body: { option: option ?? a!.id } }); await load(); } catch (e) { answerErr.value = (e as Error).message; await load(); } finally { answering.value = false; }
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

/** The director start and info routes know clean and adopt; an import starts the clean director (its own home, the imported base). */
const apiMode = "clean";
async function load() {
  try {
    const q = [dir.value ? "dir=" + encodeURIComponent(dir.value) : "", "mode=" + apiMode].filter(Boolean).join("&");
    const i = await api<Info>("v1/panel/director?" + q);
    if (!dir.value) dir.value = i.home;
    info.value = i;
    if (!modeTouched.value && i.precheck && cur.value === "folder") mode.value = suggestImport.value ? "import" : "clean";
  } catch (e) { err.value = (e as Error).message; }
}
async function refreshImp() { try { imp.value = await api<ImportState>("api/v1/agent-import"); } catch { imp.value = null; } }
let t: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined, clock: ReturnType<typeof setInterval> | undefined;
watch(dir, () => { clearTimeout(t); t = setTimeout(load, 350); });
// while waiting for the director: tick the clock every second, refresh the session state every 2 s
watch(cur, (c) => {
  clearInterval(clock);
  if (c === "ready") { now.value = Date.now(); let n = 0; clock = setInterval(() => { now.value = Date.now(); if (++n % 2 === 0) void load(); }, 1000); }
}, { immediate: true });
watch(up, (u) => { if (u && cur.value === "ready") go("hooks"); });
onMounted(async () => {
  await Promise.all([load(), refreshImp()]);
  const a = imp.value;
  if (a && a.runId && ["proposed", "previewed", "applying", "applied", "failed"].includes(a.phase)) { // window reopened: resume from the server state
    modeTouched.value = true; mode.value = "import"; if (a.project) dir.value = a.project;
    await resume(a);
    return;
  }
  nextTick(() => el.value?.querySelector<HTMLInputElement>("input")?.focus());
});
/** Pick the step that matches the run on the server. GET /agent-import carries the plan with each op's status after an apply. */
async function resume(a: ImportState) {
  if (a.phase === "proposed") { await loadProposal(); cur.value = "review"; return; }
  if (a.phase === "previewed") { try { plan.value = await api<ImportPlan>("api/v1/agent-import/preview", { method: "POST", body: {} }); runStage.value = "preview"; cur.value = "preview"; } catch { await loadProposal(); cur.value = "review"; } return; }
  plan.value = a.plan ?? { planId: a.planId ?? "", runId: a.runId!, ops: [], files: [], warnings: [] };
  cur.value = "preview";
  if (a.phase === "applying") {
    runStage.value = "running"; clearInterval(poll);
    poll = setInterval(async () => { await refreshImp(); const n = imp.value; if (n?.phase !== "applying") { clearInterval(poll); if (n?.plan) plan.value = n.plan; runStage.value = n?.phase === "applied" ? "done" : "failed"; runKey.value++; } }, 1500);
    return;
  }
  runStage.value = a.phase === "applied" ? "done" : "failed"; runKey.value++;
}
/** Focus can fall to <body> when the button that had it leaves (Scan, Preview): Escape and Tab must still act on the open sheet. */
function onDoc(e: KeyboardEvent) {
  if (!el.value || el.value.contains(document.activeElement)) return;
  if (e.key === "Escape") emit("close");
}
/** The button that opened the window gets focus back when it closes (keyboard users must not land on <body>). */
let opener: HTMLElement | null = null;
onMounted(() => { opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null; document.addEventListener("keydown", onDoc); });
onUnmounted(() => { clearTimeout(t); clearInterval(poll); clearInterval(clock); document.removeEventListener("keydown", onDoc); if (opener?.isConnected) nextTick(() => opener?.focus()); });
/** Move to a step and put focus on its first control, so keyboard and screen-reader users follow the flow. */
function go(k: Key) { cur.value = k; nextTick(() => setTimeout(() => { el.value?.querySelector(".ds-s.on")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); el.value?.querySelector<HTMLElement>(".ds-in input, .ds-in [role=radio][aria-checked=true], .ds-in .ds-b:not([disabled])")?.focus({ preventScroll: true }); }, 300)); }

async function copy(text?: string) {
  const v = text ?? info.value?.command; if (!v) return;
  try { await navigator.clipboard.writeText(v); copied.value = true; setTimeout(() => (copied.value = false), 1600); } catch { err.value = "Copy failed"; }
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
const MODES: Mode[] = ["clean", "import"];
function modeKey(e: KeyboardEvent) {
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d) return;
  e.preventDefault(); choose(MODES[(MODES.indexOf(mode.value) + d + 2) % 2]);
  nextTick(() => el.value?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus());
}
function typeNext() { go(isImport.value ? "account" : "start"); }
const TOOLS = computed(() => (info.value ? (["bun", "claude", "tmux", "python3"] as const).map((k) => ({ k, ok: info.value!.tools[k] })) : []));

// ---- import ----
async function loadProposal() { const p = await api<Proposal>("api/v1/agent-import/proposal"); items.value = p.items; }
/** Scan the folder (read-only, static: llm off) and show the proposal. An open run from before is cancelled first. */
async function scan() {
  scanErr.value = ""; reviewErr.value = ""; working.value = true; items.value = null; plan.value = null; importedDir.value = null; go("review");
  try {
    await refreshImp();
    if (imp.value?.runId && ["proposed", "previewed"].includes(imp.value.phase)) await api("api/v1/agent-import/cancel", { method: "POST", body: {} }).catch(() => {});
    await api("api/v1/agent-import/scan", { method: "POST", body: { dir: dir.value } });
    await Promise.all([loadProposal(), refreshImp()]);
  } catch (e) { scanErr.value = (e as Error).message; } finally { working.value = false; }
}
async function backToAccount() { if (imp.value?.runId && ["proposed", "previewed"].includes(imp.value.phase)) await api("api/v1/agent-import/cancel", { method: "POST", body: {} }).catch(() => {}); items.value = null; await refreshImp(); go("account"); }
async function preview() {
  working.value = true; reviewErr.value = "";
  try { plan.value = await api<ImportPlan>("api/v1/agent-import/preview", { method: "POST", body: {} }); runStage.value = "preview"; runKey.value++; go("preview"); }
  catch (e) { reviewErr.value = (e as Error).message; } finally { working.value = false; }
}
async function backToReview() { try { await loadProposal(); } catch { /* keep the old list */ } go("review"); }
function afterImport(director: string | null) { importedDir.value = director; void refreshImp(); go(director ? "hooks" : "start"); }

/** Start (clean or after an import) or restart (retry) the director. A retry kills a leftover tmux session first (`restart`). */
async function start(retry = false) {
  busy.value = true; err.value = "";
  try {
    await api("v1/panel/director/start", { method: "POST", body: { dir: dir.value, mode: apiMode, ...(retry ? { restart: true } : {}) } });
    startedAt.value = Date.now(); now.value = startedAt.value;
    started.value = "agentnet answers Claude Code's first-run questions for you.";
    await load(); go("ready");
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}

const sumKey = (g: G): Key => ({ folder: "folder", account: "account", review: "review", apply: "preview", start: "ready", ready: "hooks" } as Record<G, Key>)[g];
const sum = (k: Key) => k === "folder" ? (dir.value + " · ") + (isImport.value ? "Import" : "Clean") : k === "account" ? "done" : k === "review" ? (items.value ? `${items.value.filter((i) => i.kind !== "plugin").length} items reviewed` : "choices saved") : k === "preview" ? (imported.value ? "imported" : "planned") : k === "ready" ? (importedDir.value ? `${importedDir.value}, started by the import` : "connected") : "";

const SIDE: Record<G, { reads: string; changes: string; shows: string }> = {
  folder: { reads: "Only the folder you pick: CLAUDE.md, ~/.claude, git repos, agent definitions, tmux, tools. Read-only.", changes: "Nothing.", shows: "What the check found, and which path fits." },
  account: { reads: "Nothing. You paste a token from `claude setup-token`.", changes: "Stores the token in the agentnet folder (accounts/main, readable only by you). It is never shown again.", shows: "Connected, with the date it was added. Skip keeps this machine's Claude login." },
  review: { reads: "~/.claude, ~/.claude.json and this folder's agent definitions. Never .env files, keys or token values.", changes: "Nothing until you import. Each switch is saved as your choice.", shows: "One row per item, grouped, with the reason and badges." },
  apply: { reads: "The plan you previewed. Each source is checked again before it is copied.", changes: "Only the files in the preview, all inside the agentnet folder. Your ~/.claude is never written.", shows: "Every step as it runs, and Undo import." },
  start: { reads: "The terminal of the director session.", changes: "Starts a tmux session with Claude Code and the agentnet plugin. Answers Claude Code's first-run questions you approved.", shows: "Real stages and the last terminal lines. Waits up to 90 s, then shows what went wrong." },
  ready: { reads: "Nothing.", changes: "Nothing. Starter hooks are optional.", shows: "Your director is live. Talk to it in its terminal." },
};
const small = matchMedia("(max-width:760px)").matches;
/** Esc closes like the X. */
function onEsc() { emit("close"); } // a running import keeps running on the server; reopening the window resumes it
const side = computed(() => SIDE[gcur.value]);
</script>

<template>
  <div ref="el" class="ds" role="region" aria-label="Set up your director" @keydown.esc.stop="onEsc">
    <header class="ds-h">
      <h2>Set up your director</h2>
      <span class="ds-cnt num" aria-live="polite">Step {{ stepNo }} of {{ steps.length }} · {{ isImport ? "Import" : "Clean" }}</span>
      <button type="button" class="ds-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="20" /></button>
    </header>
    <div class="ds-seg" role="progressbar" aria-label="Setup progress" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100"><i v-for="(g, i) in steps" :key="g.k" :class="{ on: i <= idx(gcur) }" /></div>
    <p v-if="missing.length" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> Not found on this Mac: {{ missing.join(", ") }}. Run <code>agentnet doctor</code> for the fix.</p>
    <div class="ds-grid">
      <nav class="ds-rail" aria-label="Setup steps">
        <ol>
          <li v-for="(g, i) in steps" :key="g.k" :class="['rs', state(g.k)]" :aria-current="state(g.k) === 'on' ? 'step' : undefined">
            <i class="ds-n"><Icon v-if="state(g.k) === 'done'" name="check" :size="14" class="pop" /><template v-else>{{ i + 1 }}</template></i>
            <span class="rt"><b>{{ g.t }}</b><small>{{ state(g.k) === "done" ? sum(sumKey(g.k)) : g.h }}</small></span>
          </li>
        </ol>
        <p class="ds-t sm">{{ isImport ? "Clean is 3 steps." : "Import is 6 steps." }}</p>
      </nav>
      <main class="ds-main">
        <Transition name="stp" mode="out-in">
          <div :key="gcur" class="ds-in">
            <h3>{{ steps[idx(gcur)].t }}</h3>
            <!-- folder and type -->
            <template v-if="cur === 'folder'">
              <label class="ds-f"><span>The director works in this folder</span><span class="ds-pick"><input v-model="dir" type="text" spellcheck="false" autocomplete="off" placeholder="/Users/you/project" /><button type="button" class="ds-b ghost" :disabled="picking" @click.prevent="pick"><Icon name="folder-open" :size="15" /> {{ picking ? "Waiting…" : "Choose…" }}</button></span></label>
              <p v-if="pickMsg" class="ds-t sm" role="status">{{ pickMsg }}</p>
              <p v-if="info?.dirError" class="ds-err" role="alert">{{ info.dirError }}</p>
              <p v-if="rootLive && !t0" class="ds-t sm" role="status">A director is already connected. Finishing this setup starts a fresh one in this folder; nothing below counts as done until then.</p>
              <ul v-if="pc" class="ds-chk" aria-label="Folder check">
                <li><i :class="pc.instructions ? 'y' : 'n'" />CLAUDE.md <em>{{ pc.instructions ? "found" : "none" }}</em></li>
                <li><i :class="pc.claudeDir ? 'y' : 'n'" />~/.claude <em>{{ pc.claudeDir ? "found" : "none" }}</em></li>
                <li><i :class="pc.repos ? 'y' : 'n'" />Git repos <em class="num">{{ pc.repos }}</em></li>
                <li><i :class="pc.agentDefs ? 'y' : 'n'" />Agent definitions <em class="num">{{ pc.agentDefs }}</em></li>
                <li><i :class="pc.tmuxAgents ? 'y' : 'n'" />Agents already in tmux <em class="num">{{ pc.tmuxAgents }}</em></li>
                <li v-for="t in TOOLS" :key="t.k"><i :class="t.ok ? 'y' : 'n'" />{{ t.k }} <em>{{ t.ok ? "found" : "missing" }}</em></li>
              </ul>
              <p v-if="hint" class="ds-t sm" role="status">{{ hint }}</p>
              <div class="ds-types" role="radiogroup" aria-label="Setup type" @keydown="modeKey">
                <button type="button" role="radio" class="ds-type" :class="{ sel: !isImport }" :aria-checked="!isImport" :tabindex="!isImport ? 0 : -1" @click="choose('clean')">
                  <i class="ds-dot" /><b>Clean</b><em>3 steps</em><span>Fresh director with its own home. Your project is attached, nothing in it is read or changed.</span>
                </button>
                <button type="button" role="radio" class="ds-type" :class="{ sel: isImport }" :aria-checked="isImport" :tabindex="isImport ? 0 : -1" @click="choose('import')">
                  <i class="ds-dot" /><b>Import from existing workspace</b><em>6 steps</em><span>The director reads your Claude setup and proposes agents, teams and hooks. You accept each one.</span>
                </button>
              </div>
              <p v-if="isImport" class="ds-t sm">Your files are only read. Accepted items are copied into the agentnet folder.</p>
              <div class="ds-row"><button type="button" class="ds-b" :disabled="!!info?.dirError || !dir" @click="typeNext">Next</button></div>
            </template>

            <!-- Claude account -->
            <template v-else-if="cur === 'account'">
              <AgentnetImportAccount setup @back="go('folder')" @next="scan" @skip="scan" />
            </template>

            <!-- review -->
            <template v-else-if="cur === 'review'">
              <div v-if="working && !items" role="status" aria-live="polite"><ul class="ds-prog"><li class="cur"><i><Icon name="loader" :size="12" class="spin" /></i><span>Reading your Claude setup. Read-only: nothing is changed.</span></li></ul></div>
              <template v-else-if="scanErr">
                <p class="ds-err" role="alert">The scan failed: {{ scanErr }}</p>
                <div class="ds-row"><button type="button" class="ds-b ghost" @click="go('account')">Back</button><button type="button" class="ds-b" @click="scan">Retry</button></div>
              </template>
              <template v-else-if="items && !items.length">
                <div class="ds-empty" role="status"><Icon name="shield-check" :size="18" /><div><b>Nothing to import here</b><p class="ds-t sm">No CLAUDE.md, rules, skills, hooks, settings or MCP servers were found in ~/.claude, and no agent definitions in this folder. A clean director is the way to start.</p></div></div>
                <div class="ds-row"><button type="button" class="ds-b ghost" @click="backToAccount">Back</button><button type="button" class="ds-b" @click="choose('clean'); go('start')">Start clean instead</button></div>
              </template>
              <AgentnetImportReview v-else-if="items" :key="imp?.runId ?? 'r'" :items="items" :home="info?.home" :live-names="liveNames" :busy="working" :error="reviewErr" @back="backToAccount" @preview="preview" />
            </template>

            <!-- preview and import -->
            <template v-else-if="cur === 'preview'">
              <AgentnetImportRun v-if="plan" :key="runKey" :plan="plan" :stage="runStage" :manifest="imp?.manifest" :error="imp?.error" @back="backToReview" @rescan="scan" @next="afterImport" @phase="runStage = $event" />
            </template>

            <!-- clean start -->
            <template v-else-if="cur === 'start'">
              <p class="ds-t">Run this in a terminal. It starts Claude Code with the agentnet plugin as the director.</p>
              <div class="ds-cmd"><code>{{ info?.command ?? "…" }}</code>
                <button type="button" class="ds-cp" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy()"><Icon :name="copied ? 'check' : 'copy'" :size="14" /> {{ copied ? "Copied" : "Copy" }}</button></div>
              <div class="ds-row">
                <button type="button" class="ds-b ghost" @click="go('folder')">Back</button>
                <button type="button" class="ds-b" :disabled="!canStart || busy" @click="start()"><Icon name="square-terminal" :size="15" /> {{ busy ? "Starting…" : "Start director for me" }}</button>
                <button v-if="t0" type="button" class="ds-link" @click="go('ready')">Skip, I started it myself</button>
                <span v-else class="ds-or">or paste the command above</span>
              </div>
              <p v-if="why" class="ds-t sm">{{ why }}</p>
              <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
            </template>

            <!-- ready -->
            <template v-else-if="cur === 'ready'">
              <template v-if="up"><p class="ds-t"><span class="ds-live" /> The director said hello.</p></template>
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
                      <ul v-else-if="dialog.kind !== 'pane'" class="ds-opts" aria-label="Choices in the terminal"><li v-for="o in dialog.options" :key="o.id" :class="{ pick: o.id === answerBtn?.id }">{{ o.label }}</li></ul>
                      <button v-if="answerBtn" type="button" class="ds-b" :disabled="answering" @click="answer()"><Icon name="check" :size="15" /> {{ answering ? "Answering…" : answerBtn.button }}</button>
                      <template v-else-if="dialog.kind === 'pane'">
                        <pre v-if="launch?.pane" class="ds-pane" tabindex="0" aria-label="Last lines of the director terminal">{{ launch.pane }}</pre>
                        <div class="ds-row"><button v-for="o in dialog.options" :key="o.id" type="button" class="ds-b" :class="{ ghost: o.id === 'esc' }" :disabled="answering" @click="answer(o.id)">{{ o.label }}</button></div>
                      </template>
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
                  </div>
                  <p v-if="launch?.hint" class="ds-warn" role="status"><Icon name="triangle-alert" :size="15" /> {{ launch.hint }}</p>
                  <pre v-if="launch?.pane" class="ds-pane" tabindex="0" aria-label="Last lines of the director terminal">{{ launch.pane }}</pre>
                  <p v-if="launch?.exitCode != null" class="ds-t sm">exit code {{ launch.exitCode }}</p>
                  <p v-if="err" class="ds-err" role="alert">{{ err }}</p>
                </div>
              </template>
            </template>

            <!-- hooks -->
            <template v-else-if="cur === 'hooks'">
              <p v-if="importedDir" class="ds-t"><span class="ds-live" /> Director <b>{{ importedDir }}</b> was started by the import.</p>
              <p v-else class="ds-t"><span class="ds-live" /> The director is connected. It is now your live director; talk to it in its terminal.</p>
              <div v-if="imported" class="ds-undo">
                <p class="ds-t">Imported into the agentnet folder. Undo removes everything the import created.</p>
                <button type="button" class="ds-link" @click="go('preview')">Back to the import (Undo)</button>
              </div>
              <p class="ds-t">Hooks add guard rails and routing to every agent. The starter set is a good first pick. You can change it later on the Hooks page.</p>
              <a class="ds-b ghost" href="#/hooks?starter=1" @click="emit('close')">Install starter hooks <Icon name="arrow-up-right" :size="15" /></a>
            </template>

          </div>
        </Transition>
      </main>
      <aside class="ds-side" aria-label="About this step">
        <details :open="!small">
          <summary>What this step</summary>
          <dl><dt>Reads</dt><dd>{{ side.reads }}</dd><dt>Changes</dt><dd>{{ side.changes }}</dd><dt>Shows</dt><dd>{{ side.shows }}</dd></dl>
          <p v-if="isImport && gcur === 'apply'" class="ds-t sm">Undo any time from the import step: it removes what the import created. Your ~/.claude is never written.</p>
        </details>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.ds{position:fixed;inset:0;z-index:70;display:flex;flex-direction:column;gap:12px;padding:16px 20px;background:var(--bg);color:var(--ink);overflow:hidden;animation:dsin .2s var(--ease)}
@media (min-width:761px){.ds{left:232px}}
.ds *{min-width:0}
.ds-h{display:flex;align-items:center;gap:12px;flex:none}
.ds-h h2{margin:0;font:700 20px/1.2 var(--body);text-transform:none}
.ds-cnt{margin-left:auto;color:var(--muted);font:500 12px var(--mono)}
.ds-x{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}.ds-x:hover{background:var(--track)}
.ds-seg{display:none;gap:4px;flex:none}.ds-seg i{flex:1;height:4px;border-radius:2px;background:var(--track)}.ds-seg i.on{background:var(--on)}
.ds-grid{flex:1;min-height:0;display:grid;grid-template-columns:clamp(190px,18vw,280px) minmax(0,1fr) clamp(260px,24vw,380px);gap:16px}
.ds-rail,.ds-main,.ds-side{min-height:0;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:16px}
.ds-rail ol{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:4px}
.rs{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:12px}
.rs.on{background:var(--track)}.rs.todo{opacity:.55}
.rt{display:grid;gap:2px}.rt b{font:650 14px/1.3 var(--body)}.rt small{color:var(--muted);font-size:12px;line-height:1.35;overflow-wrap:anywhere}
.ds-n{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--muted);color:var(--muted);font:600 12px/1 var(--body);font-style:normal}
.rs.on .ds-n{border-color:var(--ink);color:var(--ink)}
.rs.done .ds-n{background:var(--on);border-color:var(--on);color:#06210f}
.ds-main{padding:20px}
.ds-main :deep(.af-foot),.ds-main :deep(.ap-foot){bottom:-20px;margin:0 -20px -20px;padding-inline:20px;background:var(--panel)}
.ds-in{display:grid;gap:14px;align-content:start;max-width:none}
.ds-in h3{margin:0;font:700 17px/1.2 var(--body);text-transform:none}
.stp-enter-active,.stp-leave-active{transition:opacity .2s var(--ease),transform .2s var(--ease)}
.stp-enter-from{opacity:0;transform:translateX(16px)}.stp-leave-to{opacity:0;transform:translateX(-16px)}
.ds-side summary{font:650 13px var(--body);cursor:pointer;margin-bottom:8px;list-style:none}
.ds-side dl{margin:0;display:grid;gap:4px}.ds-side dt{font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:8px}.ds-side dd{margin:0;font-size:13px;line-height:1.45}
.ds-types{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.ds-type{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-content:start;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);text-align:left;cursor:pointer;transition:border-color .15s var(--ease),background .15s var(--ease)}
.ds-type b{font:650 14px/1.3 var(--body);align-self:center}
.ds-type em{font:500 12px var(--mono);font-style:normal;color:var(--muted);align-self:center}
.ds-type span{grid-column:1/-1;color:var(--muted);font-size:12.5px;line-height:1.45}
.ds-chk{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px 16px;font-size:13px}
.ds-chk li{display:flex;align-items:center;gap:8px}.ds-chk em{margin-left:auto;font:500 12px var(--mono);font-style:normal;color:var(--muted)}
.ds-chk i{flex:none;width:8px;height:8px;border-radius:50%;background:var(--muted);opacity:.5}.ds-chk i.y{background:var(--on);opacity:1}
.ds-fl{list-style:none;margin:6px 0;padding:0;display:grid;gap:4px}.ds-fl code{font:12px var(--mono);word-break:break-all}.ds-fl .mut{color:var(--muted);font-size:12.5px}.fl{font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:12px}
@media (max-width:1100px){.ds-grid{grid-template-columns:clamp(180px,22vw,240px) minmax(0,1fr)}.ds-side{grid-column:1/-1;max-height:30%}}
@media (max-width:760px){
  .ds{padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px))}
  .ds-seg{display:flex}.ds-rail{display:none}
  .ds-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
  .ds-h h2{font-size:16px}.ds-cnt{font-size:11px}.ds-chk{grid-template-columns:1fr 1fr}
  .ds-side{grid-column:auto;max-height:none;padding:10px 12px}.ds-side summary{margin:0}.ds-side details:not([open]) dl{display:none}
  .ds-main{padding:14px}.ds-main :deep(.af-foot),.ds-main :deep(.ap-foot){bottom:-14px;margin:0 -14px -14px;padding-inline:14px}.ds-types{grid-template-columns:1fr}
  .ds-b:not(.ghost){justify-self:stretch}
}

.ds *{min-width:0}
.ds-bar{height:4px;margin:8px 0 4px;border-radius:2px;background:var(--track);overflow:hidden}
.ds-bar i{display:block;height:100%;background:var(--on);transition:width 1s linear}
.ds-fail{display:grid;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--bad) 50%,var(--line));border-radius:12px;background:var(--bad-bg)}
.ds-fail .ds-err{display:flex;gap:6px;align-items:flex-start;line-height:1.45}
.ds-prog li.bad{color:var(--bad)}.ds-prog li.bad i{border-color:var(--bad);color:var(--bad)}
.ds-pane{margin:0;max-height:178px;overflow:auto;padding:8px 10px;border-radius:10px;background:var(--track);font:11.5px/1.4 var(--mono);white-space:pre-wrap;word-break:break-word}
.ds-dlg{display:grid;gap:8px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent)}
.ds-opts{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:12.5px}
.ds-opts li{padding:5px 10px;border-radius:8px;background:var(--track);color:var(--muted)}.ds-opts li.pick{color:var(--ink);outline:1px solid var(--on)}
.pop{animation:dspop .3s cubic-bezier(.2,.8,.2,1)}
@keyframes dspop{from{transform:scale(.3);opacity:0}}
.ds-warn{display:flex;gap:8px;align-items:flex-start;margin:0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 50%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--warn) 9%,transparent);font-size:13px}
.ds-warn code,.ds-cmd code,.ds-undo code,.ds-chgin code{font-family:var(--mono)}
.ds input:focus-visible,.ds-b:focus-visible,.ds-cp:focus-visible,.ds-x:focus-visible,.ds-link:focus-visible,.ds-type:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.ds-pick{display:flex;gap:8px;align-items:stretch}.ds-pick input{flex:1;min-width:0}.ds-pick .ds-b{flex:none;text-transform:none;letter-spacing:0}
.ds-f{display:grid;gap:6px}.ds-f span{color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ds input{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:13px var(--mono)}
.ds-t{margin:0;font-size:13.5px;line-height:1.45}.ds-t.sm{font-size:12.5px;color:var(--muted)}
.ds-type:hover{border-color:var(--muted)}
.ds-type.sel{border-color:var(--on);background:var(--on-bg)}
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
.ds-empty{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2)}.ds-empty b{font:650 14px var(--body)}.ds-empty p{margin-top:4px}.ds-empty>svg{flex:none;color:var(--on);margin-top:2px}
.ds-live{display:inline-block;width:9px;height:9px;margin-right:6px;border-radius:50%;background:var(--on)}
/* the green accent needs white text on the light theme (axe contrast) */
:global(:root[data-theme="light"] .ds-b:not(.ghost)){color:#fff}
:global(:root[data-theme="light"] .ds-prog li.ok i){color:#fff}
@keyframes dsin{from{opacity:0}}@keyframes dsup{from{opacity:0;transform:translateY(12px) scale(.98)}}@keyframes dsp{50%{opacity:.3}}@keyframes dsspin{to{transform:rotate(360deg)}}
@media (max-width:640px){
  .ds-b:not(.ghost){justify-self:stretch}
}
@media (prefers-reduced-motion:reduce){.pop,.spin{animation:none}.stp-enter-from,.stp-leave-to{transform:none !important}.stp-enter-active,.stp-leave-active{transition:opacity .15s linear}.ds-chg,.ds-type,.ds-bar i{transition:none}}
</style>
