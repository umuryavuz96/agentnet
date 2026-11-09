<script setup lang="ts">
// Add a hook: a sheet with a gallery of premade templates and a custom form. Nothing is written until "Add hook".
// The server backs up settings.json first, refuses a duplicate (409) and can roll back; this sheet only shows the change.
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { api } from "../ui/api";
import Icon from "../ui/Icon.vue";

interface Tpl { id: string; name: string; about: string; category: string; event: string; matcher: string | null; command: string; timeout: number; risk: "blocks" | "writes" | "network" | "read-only"; requirements: string[]; source: { name: string; url: string }; starter: boolean; own: boolean; state: "available" | "installed" | "switched-off"; missing: string[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Installed { installed: string; backup: string | null; fragment: unknown; hooks: any[]; backups: string[] }

const props = defineProps<{ open: boolean; starter?: boolean; template?: string }>();
const emit = defineEmits<{ close: []; added: [res: Installed, name: string]; switchOn: [id: string]; show: [id: string] }>();

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "StopFailure", "SubagentStop", "PreCompact", "SessionEnd"];
const MATCHER_EVENTS = ["PreToolUse", "PostToolUse", "PermissionRequest"];
const EVENT_ABOUT: Record<string, string> = { SessionStart: "when a session starts", UserPromptSubmit: "on every prompt you send", PreToolUse: "before a tool call", PermissionRequest: "when Claude asks for permission", PostToolUse: "after a tool call", Notification: "when Claude raises a notification", Stop: "when Claude finishes a turn", StopFailure: "when a turn ends in an error", SubagentStop: "when a sub-agent finishes", PreCompact: "before the context is compacted", SessionEnd: "when a session ends" };
const RISK_COST: Record<Tpl["risk"], string> = { blocks: "Can stop Claude's tool calls or prompts. Cannot change files.", writes: "Writes to files on this machine.", network: "Talks to the network.", "read-only": "Only reads. Changes nothing." };
const SEVERITY = ["network", "writes", "blocks", "read-only"];

const tab = ref<"gallery" | "custom">("gallery"), tpls = ref<Tpl[]>([]), loaded = ref(false), err = ref(""), busy = ref(false), sel = ref<string | null>(null);
const frag = ref<Record<string, string>>({});
const sheet = ref<HTMLElement | null>(null);

/** Hooks that ship with agentnet come first, in their own group; the rest by category. */
const grouped = computed(() => {
  const m = new Map<string, Tpl[]>([["From agentnet", []]]);
  for (const t of tpls.value) { const k = t.own ? "From agentnet" : t.category; (m.get(k) ?? m.set(k, []).get(k)!).push(t); }
  return [...m.entries()].filter(([, l]) => l.length);
});

// ---- starter set: one dry run shows every command, one confirm adds them all with one backup ----
interface SetRes extends Omit<Installed, "installed"> { added: string[]; skipped: { id: string; reason: string }[] }
const starterList = computed(() => tpls.value.filter((t) => t.starter));
const starterLeft = computed(() => starterList.value.filter((t) => t.state === "available"));
const plan = ref<SetRes | null>(null), planOpen = ref(false);
const byId = (id: string) => tpls.value.find((t) => t.id === id);
async function reviewStarter() {
  if (planOpen.value) { planOpen.value = false; return; }
  err.value = "";
  try { plan.value = await api<SetRes>("v1/panel/hooks/install-set", { body: { dryRun: true } }); planOpen.value = true; } catch (e) { err.value = (e as Error).message; }
}
async function addStarter() {
  if (busy.value || !plan.value?.added.length) return; busy.value = true; err.value = "";
  try {
    const r = await api<SetRes>("v1/panel/hooks/install-set", { body: { ids: plan.value.added } });
    const first = r.hooks.find((h) => h.command === byId(r.added[0])?.command);
    emit("added", { ...r, installed: first?.id ?? "" }, `Starter set (${r.added.length} hooks)`); emit("close");
  } catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
async function load() {
  loaded.value = false; err.value = "";
  try { tpls.value = (await api<{ templates: Tpl[] }>("v1/panel/hooks/templates")).templates; } catch (e) { err.value = (e as Error).message; }
  loaded.value = true;
}
/** Expand one card (vertical only) and fetch the exact settings.json change for it, without writing. */
async function pick(t: Tpl) {
  sel.value = sel.value === t.id ? null : t.id; err.value = "";
  if (sel.value && t.state === "available" && !frag.value[t.id]) {
    try { frag.value[t.id] = JSON.stringify((await api<{ fragment: unknown }>("v1/panel/hooks/install", { body: { templateId: t.id, dryRun: true } })).fragment, null, 2); } catch (e) { err.value = (e as Error).message; }
  }
}
async function add(t: Tpl) {
  if (busy.value) return; busy.value = true; err.value = "";
  try { const r = await api<Installed>("v1/panel/hooks/install", { body: { templateId: t.id } }); emit("added", r, t.name); emit("close"); }
  catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
const idle = (t: Tpl) => t.state === "available" && !t.missing.length;

// ---- custom ----
const c = ref({ event: "PreToolUse", matcher: "", command: "", timeout: 10 }), evOpen = ref(false), review = ref(""), cErr = ref<Record<string, string>>({});
const hasMatcher = computed(() => MATCHER_EVENTS.includes(c.value.event));
function check(): boolean {
  const e: Record<string, string> = {}, v = c.value;
  if (!v.command.trim()) e.command = "Command is empty."; else if (v.command.length > 4096) e.command = "Command is longer than 4096 characters.";
  if (hasMatcher.value && v.matcher.trim()) { try { new RegExp(v.matcher.trim()); } catch { e.matcher = "That is not a valid regular expression."; } }
  if (!Number.isInteger(v.timeout) || v.timeout < 1 || v.timeout > 600) e.timeout = "Use a whole number from 1 to 600 seconds.";
  cErr.value = e; return !Object.keys(e).length;
}
const body = () => ({ custom: { event: c.value.event, matcher: hasMatcher.value ? c.value.matcher.trim() || null : null, command: c.value.command, timeout: c.value.timeout } });
const sentence = computed(() => `Runs ${c.value.command.trim().split("\n")[0].slice(0, 60) || "your command"} ${EVENT_ABOUT[c.value.event]}${hasMatcher.value && c.value.matcher.trim() ? ` for ${c.value.matcher.trim()}` : ""}.`);
async function reviewIt() {
  if (!check() || busy.value) return; busy.value = true; err.value = "";
  try { review.value = JSON.stringify((await api<{ fragment: unknown }>("v1/panel/hooks/install", { body: { ...body(), dryRun: true } })).fragment, null, 2); }
  catch (e) { err.value = (e as Error).message; } finally { busy.value = false; }
}
async function addCustom() {
  if (busy.value) return; busy.value = true; err.value = "";
  try { const r = await api<Installed>("v1/panel/hooks/install", { body: body() }); emit("added", r, "Custom hook"); emit("close"); c.value.command = ""; c.value.matcher = ""; review.value = ""; }
  catch (e) { err.value = (e as Error).message; review.value = ""; } finally { busy.value = false; }
}
watch(() => [c.value.event, c.value.matcher, c.value.command, c.value.timeout], () => { review.value = ""; });

// ---- sheet behaviour: focus trap, Esc, scroll lock ----
const prevFocus = ref<HTMLElement | null>(null);
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { if (evOpen.value) evOpen.value = false; else emit("close"); return; }
  if (e.key !== "Tab" || !sheet.value) return;
  const f = [...sheet.value.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input,textarea,[tabindex]:not([tabindex='-1'])")].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
watch(() => props.open, async (o) => {
  document.documentElement.style.overflow = o ? "hidden" : "";
  if (o) {
    prevFocus.value = document.activeElement as HTMLElement; sel.value = null; err.value = ""; review.value = ""; frag.value = {}; plan.value = null; planOpen.value = false; tab.value = "gallery";
    await load(); await nextTick(); sheet.value?.querySelector<HTMLElement>("button")?.focus();
    if (props.starter && starterLeft.value.length) await reviewStarter();
    else if (props.template) { const t = byId(props.template); if (t) await pick(t); } // deep open on one template: its review and Add button
  }
  else prevFocus.value?.focus();
}, { immediate: true }); // immediate: a deep link (#/hooks?starter=1) mounts the sheet already open, and must still load the gallery
onBeforeUnmount(() => { document.documentElement.style.overflow = ""; });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="hs-wrap" @keydown="key">
      <div class="hs-scrim" @click="emit('close')"></div>
      <aside ref="sheet" class="hs" role="dialog" aria-modal="true" aria-label="Add a hook">
        <header class="hs-h">
          <h2>Add a hook</h2>
          <button type="button" class="hs-x" aria-label="Close" @click="emit('close')"><Icon name="x" :size="18" /></button>
        </header>
        <div class="hs-seg" role="tablist" aria-label="Where the hook comes from">
          <button type="button" role="tab" :aria-selected="tab === 'gallery'" :class="{ on: tab === 'gallery' }" @click="tab = 'gallery'">Gallery</button>
          <button type="button" role="tab" :aria-selected="tab === 'custom'" :class="{ on: tab === 'custom' }" @click="tab = 'custom'">Custom</button>
        </div>
        <div class="hs-body">
          <p v-if="err" class="hs-err" role="alert">{{ err }}</p>

          <template v-if="tab === 'gallery'">
            <p class="hs-note">Ready-made hooks from the Claude Code hooks guide and popular open-source hook collections (each one links its source). You see the exact command before anything is written; settings.json is backed up first.</p>
            <p v-if="loaded && !tpls.length && !err" class="hs-note">No templates found.</p>
            <section v-if="starterList.length" :class="['hs-card', 'hs-starter', { open: planOpen }]" aria-labelledby="hs-st-h">
              <div class="hs-ch hs-sth">
                <span class="hs-top"><b id="hs-st-h">Starter set</b><span class="hs-risk">{{ starterList.length }} hooks</span></span>
                <span class="hs-ab">Recommended for a fresh install: safety blockers, prompt triage, usage guard, task-list reminder and context warning. You see every command first; one confirm adds them all with one backup of settings.json.</span>
                <div class="hs-act">
                  <button v-if="starterLeft.length" type="button" class="hs-btn pri" :aria-expanded="planOpen" aria-controls="hs-st-plan" @click="reviewStarter">{{ planOpen ? "Hide" : `Review ${starterLeft.length} of ${starterList.length}` }}</button>
                  <span v-else class="hs-st">All starter hooks are added ✓</span>
                </div>
              </div>
              <div id="hs-st-plan" class="hs-dw" :class="{ 'is-open': planOpen }" :inert="!planOpen || undefined">
                <div class="hs-d">
                  <template v-if="plan">
                    <p class="hs-cost">{{ plan.added.length ? `Adds ${plan.added.length} ${plan.added.length === 1 ? "entry" : "entries"} to settings.json:` : "Nothing to add." }}</p>
                    <ol class="hs-plan">
                      <li v-for="id in plan.added" :key="id">
                        <span class="hs-top"><b>{{ byId(id)?.name ?? id }}</b><span :class="['hs-risk', byId(id)?.risk]">{{ byId(id)?.risk }}</span></span>
                        <span class="hs-ev">{{ byId(id)?.event }}<template v-if="byId(id)?.matcher"> · {{ byId(id)?.matcher }}</template></span>
                        <code class="hs-code">{{ byId(id)?.command }}</code>
                      </li>
                    </ol>
                    <template v-if="plan.skipped.length">
                      <p class="hs-meta">Skipped:</p>
                      <ul class="hs-skip"><li v-for="k in plan.skipped" :key="k.id">{{ byId(k.id)?.name ?? k.id }}: {{ k.reason }}</li></ul>
                    </template>
                    <details class="hs-js"><summary>Show settings.json change</summary><pre>{{ JSON.stringify(plan.fragment, null, 2) }}</pre></details>
                    <div class="hs-act">
                      <button type="button" class="hs-btn pri" :disabled="busy || !plan.added.length" @click="addStarter">Add {{ plan.added.length }} hooks</button>
                      <button type="button" class="hs-btn" @click="planOpen = false">Cancel</button>
                    </div>
                  </template>
                </div>
              </div>
            </section>
            <section v-for="[cat, list] in grouped" :key="cat" class="hs-grp">
              <h3>{{ cat }}</h3>
              <article v-for="t in list" :key="t.id" :class="['hs-card', { open: sel === t.id, dim: t.state !== 'available' }]">
                <button type="button" class="hs-ch" :aria-expanded="sel === t.id" @click="pick(t)">
                  <span class="hs-top"><b>{{ t.name }}</b><span :class="['hs-risk', t.risk]">{{ t.risk }}</span></span>
                  <span class="hs-ev">{{ t.event }}<template v-if="t.matcher"> · {{ t.matcher }}</template></span>
                  <span class="hs-ab">{{ t.about }}</span>
                  <span v-if="t.state !== 'available'" class="hs-st">{{ t.state === "installed" ? "Installed" : "Installed, switched off" }}</span>
                  <span v-else-if="t.missing.length" class="hs-miss">Needs {{ t.missing.join(", ") }}. Not found on this machine.</span>
                </button>
                <div class="hs-dw" :class="{ 'is-open': sel === t.id }" :inert="sel !== t.id || undefined">
                  <div class="hs-d">
                    <p class="hs-cost">{{ RISK_COST[t.risk] }}</p>
                    <code class="hs-code">{{ t.command }}</code>
                    <p class="hs-meta num">Time limit {{ t.timeout }} s<template v-if="t.requirements.length"> · needs {{ t.requirements.join(", ") }}</template> · <a :href="t.source.url" target="_blank" rel="noopener noreferrer">{{ t.source.name }}</a></p>
                    <p class="hs-meta">Adds 1 entry under hooks.{{ t.event }}. A backup of settings.json is made first.</p>
                    <details v-if="frag[t.id]" class="hs-js"><summary>Show settings.json change</summary><pre>{{ frag[t.id] }}</pre></details>
                    <div class="hs-act">
                      <button v-if="t.state === 'available'" type="button" class="hs-btn pri" :disabled="!idle(t) || busy" @click="add(t)">Add hook</button>
                      <button v-else-if="t.state === 'switched-off'" type="button" class="hs-btn pri" @click="emit('switchOn', t.id); emit('close')">Switch on</button>
                      <button v-else type="button" class="hs-btn" disabled>Installed ✓</button>
                      <button v-if="t.state === 'available'" type="button" class="hs-btn" @click="c = { event: t.event, matcher: t.matcher ?? '', command: t.command, timeout: t.timeout }; tab = 'custom'">Edit before adding</button>
                      <button v-if="t.state !== 'available'" type="button" class="hs-btn" @click="emit('show', t.id); emit('close')">Show in list</button>
                    </div>
                    <p v-if="t.missing.length" class="hs-miss">Needs {{ t.missing.join(", ") }}. Not found on this machine.</p>
                  </div>
                </div>
              </article>
            </section>
          </template>

          <form v-else class="hs-form" novalidate @submit.prevent="review ? addCustom() : reviewIt()">
            <fieldset class="hs-fs"><legend>When</legend>
              <div class="hs-f"><label id="hs-evl">Event</label>
                <div class="hs-dd">
                  <button type="button" class="hs-sel" aria-haspopup="listbox" :aria-expanded="evOpen" aria-labelledby="hs-evl" @click="evOpen = !evOpen">{{ c.event }}<Icon name="chevron-down" :size="14" /></button>
                  <ul v-if="evOpen" class="hs-opts" role="listbox" aria-labelledby="hs-evl">
                    <li v-for="e in EVENTS" :key="e" role="option" :aria-selected="e === c.event"><button type="button" :class="{ on: e === c.event }" @click="c.event = e; evOpen = false">{{ e }}<small>{{ EVENT_ABOUT[e] }}</small></button></li>
                  </ul>
                </div>
              </div>
              <div v-if="hasMatcher" class="hs-f"><label for="hs-m">Matcher</label>
                <input id="hs-m" v-model="c.matcher" type="text" placeholder="Bash or Edit|Write (empty = every tool)" autocomplete="off" spellcheck="false" :aria-invalid="!!cErr.matcher" aria-describedby="hs-m-e" />
                <p id="hs-m-e" class="hs-fe" v-if="cErr.matcher">{{ cErr.matcher }}</p>
              </div>
              <p v-else class="hs-hint">Runs for every occurrence.</p>
            </fieldset>
            <fieldset class="hs-fs"><legend>What</legend>
              <div class="hs-f"><label for="hs-c">Command</label>
                <textarea id="hs-c" v-model="c.command" rows="4" spellcheck="false" placeholder="jq -r '.tool_input.command' >> /tmp/log" :aria-invalid="!!cErr.command" aria-describedby="hs-c-e"></textarea>
                <p id="hs-c-e" class="hs-fe" v-if="cErr.command">{{ cErr.command }}</p>
              </div>
              <div class="hs-f"><label for="hs-t">Time limit (seconds)</label>
                <input id="hs-t" v-model.number="c.timeout" type="number" min="1" max="600" inputmode="numeric" :aria-invalid="!!cErr.timeout" aria-describedby="hs-t-e" />
                <p id="hs-t-e" class="hs-fe" v-if="cErr.timeout">{{ cErr.timeout }}</p>
              </div>
            </fieldset>
            <p class="hs-live">{{ sentence }}</p>
            <div v-if="review" class="hs-rev">
              <p class="hs-meta">Adds 1 entry under hooks.{{ c.event }}. A backup of settings.json is made first.</p>
              <details class="hs-js"><summary>Show settings.json change</summary><pre>{{ review }}</pre></details>
            </div>
            <div class="hs-act">
              <button v-if="!review" type="submit" class="hs-btn pri" :disabled="busy">Review</button>
              <template v-else><button type="submit" class="hs-btn pri" :disabled="busy">Add hook</button><button type="button" class="hs-btn" @click="review = ''">Back</button></template>
            </div>
          </form>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.hs-wrap{position:fixed;inset:0;z-index:60}
.hs-scrim{position:absolute;inset:0;background:rgba(0,0,0,.45);animation:hsf .2s ease-out}
.hs{position:absolute;top:0;right:0;bottom:0;width:min(480px,100%);display:flex;flex-direction:column;background:var(--panel);border-left:1px solid var(--line);color:var(--ink);animation:hss .3s cubic-bezier(.2,.8,.2,1)}
@keyframes hsf{from{opacity:0}}@keyframes hss{from{transform:translateX(24px);opacity:0}}
@media(max-width:640px){.hs{top:auto;width:100%;height:min(88vh,100%);border-left:0;border-top:1px solid var(--line);border-radius:18px 18px 0 0;animation-name:hsb}@keyframes hsb{from{transform:translateY(24px);opacity:0}}}
.hs-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 6px}.hs-h h2{margin:0;font:700 17px var(--body)}
.hs-x{display:grid;place-items:center;width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:var(--muted);cursor:pointer}
.hs-seg{display:flex;gap:4px;margin:6px 16px 0;padding:3px;border-radius:11px;background:var(--track)}
.hs-seg button{flex:1;min-height:40px;border:0;border-radius:9px;background:none;color:var(--muted);font:600 13px var(--body);cursor:pointer;transition:background .2s,color .2s}
.hs-seg button.on{background:var(--panel-2);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.hs-body{flex:1;min-height:0;overflow-y:auto;padding:12px 16px 24px;display:flex;flex-direction:column;gap:12px}
.hs-note,.hs-hint{margin:0;color:var(--muted);font:400 12.5px/1.5 var(--body)}
.hs-err{margin:0;padding:8px 10px;border-radius:9px;background:var(--bad-bg);color:var(--bad);font:500 12.5px/1.4 var(--body)}
.hs-grp{display:flex;flex-direction:column;gap:6px}.hs-grp h3{margin:6px 0 0;color:var(--muted);font:600 11.5px var(--body);text-transform:uppercase;letter-spacing:.04em}
.hs-card{border:1px solid var(--line);border-radius:13px;background:var(--panel-2);transition:border-color .2s,opacity .2s}
.hs-card.open{border-color:var(--muted)}.hs-card.dim .hs-ch{opacity:.65}
.hs-ch{display:flex;flex-direction:column;gap:3px;width:100%;min-height:44px;padding:11px 13px;border:0;background:none;color:var(--ink);text-align:left;cursor:pointer;border-radius:13px}
.hs-top{display:flex;align-items:center;justify-content:space-between;gap:8px}.hs-top b{font:600 14px var(--body)}
.hs-ev{font:500 11px var(--mono);color:var(--muted)}.hs-ab{color:var(--muted);font:400 12.5px/1.45 var(--body)}
.hs-risk{flex:none;padding:2px 8px;border-radius:999px;border:1px solid var(--line);font:600 11px var(--mono)}
.hs-risk.network,.hs-risk.writes{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,transparent)}
.hs-st{font:600 12px var(--body);color:var(--on)}.hs-miss{margin:0;font:500 12px var(--body);color:var(--warn)}
.hs-dw{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .3s cubic-bezier(.2,.8,.2,1),opacity .24s}
.hs-dw.is-open{grid-template-rows:1fr;opacity:1}.hs-dw>.hs-d{overflow:hidden;min-height:0}
.hs-d{display:flex;flex-direction:column;gap:8px;padding:0 13px}.hs-dw.is-open>.hs-d{padding-bottom:13px}
.hs-cost{margin:0;font:600 12.5px var(--body)}
.hs-code{display:block;max-height:180px;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--track);color:var(--muted);font:500 12px/1.5 var(--mono);overflow-wrap:anywhere;white-space:pre-wrap}
.hs-meta{margin:0;color:var(--muted);font:400 12px/1.5 var(--body)}.hs-meta a{color:var(--ink)}
.hs-js summary{cursor:pointer;color:var(--ink);font:600 12px var(--body);min-height:28px;display:flex;align-items:center}
.hs-js pre{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:var(--track);font:500 11.5px/1.5 var(--mono);overflow:auto;max-height:200px}
.hs-act{display:flex;flex-wrap:wrap;gap:8px}
.hs-btn{min-height:44px;padding:0 14px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:600 13px var(--body);cursor:pointer}
.hs-btn.pri{background:var(--ink);color:var(--panel);border-color:var(--ink)}.hs-btn:disabled{opacity:.45;cursor:default}
.hs-form{display:flex;flex-direction:column;gap:14px}
.hs-fs{margin:0;padding:0;border:0;display:flex;flex-direction:column;gap:10px}.hs-fs legend{padding:0;margin-bottom:6px;color:var(--muted);font:600 11.5px var(--body);text-transform:uppercase;letter-spacing:.04em}
.hs-f{display:flex;flex-direction:column;gap:4px}.hs-f label{font:600 12.5px var(--body)}
.hs-f input,.hs-f textarea,.hs-sel{width:100%;min-height:44px;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);font:500 13px var(--mono);box-sizing:border-box}
.hs-f textarea{resize:vertical;line-height:1.5}
.hs-f [aria-invalid="true"]{border-color:var(--bad)}
.hs-fe{margin:0;color:var(--bad);font:500 12px var(--body)}
.hs-dd{position:relative}.hs-sel{display:flex;align-items:center;justify-content:space-between;cursor:pointer;text-align:left}
.hs-opts{position:absolute;z-index:2;left:0;right:0;top:calc(100% + 4px);margin:0;padding:4px;list-style:none;max-height:280px;overflow:auto;border-radius:11px;border:1px solid var(--line);background:var(--panel);box-shadow:0 10px 30px rgba(0,0,0,.25);animation:hsf .15s}
.hs-opts button{display:flex;flex-direction:column;align-items:flex-start;width:100%;min-height:44px;padding:6px 10px;border:0;border-radius:8px;background:none;color:var(--ink);font:600 13px var(--mono);cursor:pointer;text-align:left}
.hs-opts button small{color:var(--muted);font:400 11.5px var(--body)}.hs-opts button.on,.hs-opts button:hover{background:var(--track)}
.hs-live{margin:0;padding:8px 10px;border-radius:9px;background:var(--track);color:var(--muted);font:500 12.5px/1.45 var(--body);overflow-wrap:anywhere}
.hs-rev{display:flex;flex-direction:column;gap:6px}
.hs-starter{border-color:color-mix(in srgb,var(--ink) 28%,var(--line))}.hs-sth{cursor:default;gap:6px}.hs-sth .hs-act{margin-top:4px}
.hs-plan{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;max-height:min(46vh,420px);overflow-y:auto}
.hs-plan li{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
.hs-plan .hs-top b{font:600 13px var(--body)}.hs-plan .hs-code{max-height:90px}
.hs-skip{margin:0;padding-left:18px;color:var(--muted);font:400 12px/1.5 var(--body)}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.hs,.hs-scrim,.hs-opts{animation:none}.hs-dw{transition:none}}
</style>
