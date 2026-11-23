<script setup lang="ts">
// Proposal review (mock D, SPEC-step5 section 3). One row per item with a switch, grouped by kind; agents unfold to edit name, model
// and boss. Every change goes to POST /agent-import/decide at once with only the changed items; the server validates the whole staff
// and its errors are shown next to the item. Under 768 px the list is a bottom sheet with a sticky footer.
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import Icon from "../ui/Icon.vue";
import Select from "../ui/Select.vue";
import { api } from "../ui/api";
import { badgeLabels, bossOptions, errorsFor, footerCount, footerLabel, groupAllOn, groupCount, groupItems, KIND_ICON, kindTitle, MODELS, nameError, toggleable, type Group, type ImportItem, type ItemEdits } from "../importView";

const props = defineProps<{ items: ImportItem[]; home?: string | null; liveNames: string[]; busy?: boolean; error?: string }>();
const emit = defineEmits<{ back: []; preview: [] }>();

interface Dec { accept: boolean; edits?: ItemEdits }
const dec = reactive<Record<string, Dec>>({});
for (const i of props.items) dec[i.id] = { accept: i.accept, ...(i.edits ? { edits: { ...i.edits } } : {}) };
const on = (i: ImportItem) => !!dec[i.id]?.accept;
const groups = computed(() => groupItems(props.items, on));
const count = computed(() => footerCount(props.items, on));
const errs = ref<string[]>([]), pending = ref(0), netErr = ref("");
const why = ref<Record<string, boolean>>({}), edit = ref<Record<string, boolean>>({});
const nameDraft = reactive<Record<string, string>>({});
for (const i of props.items) if (i.kind === "agent") nameDraft[i.id] = i.edits?.name ?? "";
const agentNames = computed(() => props.items.filter((i) => i.kind === "agent" && on(i)).map((i) => dec[i.id]?.edits?.name ?? "").filter(Boolean));

/** Send only these items. The server checks the whole staff on every decide, so a success clears every error and a refusal
 *  replaces them. A switch that was refused goes back; a typed edit stays next to its error. */
async function send(ids: string[], before: Record<string, Dec>) {
  pending.value++; netErr.value = "";
  try {
    await api("api/v1/agent-import/decide", { method: "POST", body: { items: ids.map((id) => ({ id, accept: dec[id]!.accept, ...(dec[id]!.edits ? { edits: dec[id]!.edits } : {}) })) } });
    errs.value = [];
  } catch (e) {
    const list = (e as Error & { errors?: string[] }).errors;
    if (list?.length) errs.value = list; else netErr.value = (e as Error).message;
    for (const id of ids) if (before[id] && before[id]!.accept !== dec[id]!.accept) dec[id]!.accept = before[id]!.accept;
  } finally { pending.value--; }
}
const snap = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, structuredClone({ ...dec[id]!, ...(dec[id]!.edits ? { edits: { ...dec[id]!.edits } } : {}) })]));
function toggle(i: ImportItem) { if (!toggleable(i)) return; const b = snap([i.id]); dec[i.id]!.accept = !dec[i.id]!.accept; void send([i.id], b); }
function toggleGroup(g: Group) {
  const all = groupAllOn(g, on), ids = g.rows.filter(toggleable).map((r) => r.id), b = snap(ids);
  for (const id of ids) dec[id]!.accept = !all;
  void send(ids, b);
}
function setEdit(i: ImportItem, k: "model" | "boss", v: string) { const b = snap([i.id]); dec[i.id]!.edits = { ...dec[i.id]!.edits, [k]: v === "" ? null : v }; void send([i.id], b); }
const nameErr = (i: ImportItem) => nameError(nameDraft[i.id] ?? "");
let nt: Record<string, ReturnType<typeof setTimeout>> = {};
function typeName(i: ImportItem, v: string) {
  nameDraft[i.id] = v; clearTimeout(nt[i.id]);
  if (nameError(v)) return;
  nt[i.id] = setTimeout(() => { const b = snap([i.id]); dec[i.id]!.edits = { ...dec[i.id]!.edits, name: v }; void send([i.id], b); }, 400);
}
/** Errors name the item id, or for agents the name it would get (`agent:<new name>`). */
const itemErrs = (i: ImportItem) => [...new Set([...errorsFor(errs.value, i.id), ...(i.kind === "agent" && dec[i.id]?.edits?.name && `agent:${dec[i.id]!.edits!.name}` !== i.id ? errorsFor(errs.value, `agent:${dec[i.id]!.edits!.name}`) : [])])];
const loose = computed(() => errs.value.filter((e) => !props.items.some((i) => itemErrs(i).some((x) => e.endsWith(": " + x)))));
const hasErr = computed(() => errs.value.length > 0 || props.items.some((i) => i.kind === "agent" && on(i) && !!nameErr(i)));
const canPreview = computed(() => !props.busy && pending.value === 0 && !hasErr.value && count.value > 0);
const modelOpts = [{ value: "", label: "Default", hint: "the routing picks one" }, ...MODELS.map((m) => ({ value: m, label: m }))];
const bossOpts = (i: ImportItem) => bossOptions(dec[i.id]?.edits?.name ?? "", agentNames.value, props.liveNames).map((n) => ({ value: n, label: n }));
const title = (i: ImportItem) => (i.kind === "agent" ? `Agent ${dec[i.id]?.edits?.name ?? ""}` : i.kind === "team" ? `Team ${i.edits?.name ?? ""}` : i.summary);
const sub = (i: ImportItem) => (i.kind === "agent" || i.kind === "team" ? i.summary : kindTitle(i.kind) + (i.target ? ` → ${i.target}` : ""));

// ---- phone: bottom sheet ----
const mq = matchMedia("(max-width:767px)"), phone = ref(mq.matches), sheet = ref(false), sheetEl = ref<HTMLElement | null>(null);
const onMq = () => { phone.value = mq.matches; };
onMounted(() => { mq.addEventListener("change", onMq); if (phone.value) openSheet(); });
onUnmounted(() => { mq.removeEventListener("change", onMq); for (const k in nt) clearTimeout(nt[k]); });
function openSheet() { sheet.value = true; nextTick(() => sheetEl.value?.querySelector<HTMLElement>(".rv-sh-h h3")?.focus()); }
function closeSheet() { sheet.value = false; nextTick(() => document.querySelector<HTMLElement>(".rv-open")?.focus()); }
function sheetKey(e: KeyboardEvent) { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } }
const listOn = computed(() => !phone.value || sheet.value);
</script>

<template>
  <div class="rv">
    <p class="rv-sum">The director proposes <b class="num">{{ items.filter(toggleable).length }}</b> {{ items.filter(toggleable).length === 1 ? "item" : "items" }}, <b class="num" aria-live="polite">{{ count }}</b> on. Your files are only read; accepted items are copied into the agentnet folder.</p>
    <p class="rv-t sm"><Icon name="sparkles" :size="13" /> Static scan: the director's suggestions come later.</p>

    <!-- phone: a summary that opens the sheet -->
    <div v-if="phone" class="rv-mini">
      <ul class="rv-mg"><li v-for="g in groups" :key="g.key"><span>{{ g.title }}</span><em class="num">{{ groupCount(g) }}</em></li></ul>
      <button type="button" class="rv-b rv-open" @click="openSheet">Review items</button>
    </div>

    <Transition name="rv-sh">
      <div v-if="listOn" ref="sheetEl" :class="phone ? 'rv-sh' : 'rv-desk'" :role="phone ? 'dialog' : undefined" :aria-modal="phone ? 'false' : undefined" :aria-label="phone ? 'Review the proposal' : undefined" @keydown="phone && sheetKey($event)">
        <header v-if="phone" class="rv-sh-h"><i class="rv-grab" aria-hidden="true" /><h3 tabindex="-1">Review the proposal</h3><button type="button" class="rv-x" aria-label="Close the review" @click="closeSheet"><Icon name="x" :size="18" /></button></header>
        <div class="rv-list">
          <section v-for="g in groups" :key="g.key" class="rv-g" :aria-labelledby="'rvg-' + g.key">
            <div class="rv-gh">
              <h4 :id="'rvg-' + g.key">{{ g.title }}</h4>
              <em class="num" aria-live="polite">{{ groupCount(g) }}</em>
              <button v-if="g.total" type="button" class="sw sm" role="switch" :aria-checked="groupAllOn(g, on)" :aria-label="`All of ${g.title}`" @click="toggleGroup(g)" />
            </div>
            <ul class="rv-rows">
              <li v-for="i in g.rows" :key="i.id" class="rv-r" :class="{ off: toggleable(i) && !on(i) }">
                <div class="rv-main">
                  <i class="rv-ic" aria-hidden="true"><Icon :name="(KIND_ICON[i.kind] as any)" :size="15" /></i>
                  <div class="rv-txt">
                    <b>{{ title(i) }}</b>
                    <small>{{ sub(i) }}</small>
                    <span v-if="badgeLabels(i, home).length" class="rv-chips"><span v-for="c in badgeLabels(i, home)" :key="c.label" class="rv-chip" :class="c.tone">{{ c.label }}</span></span>
                    <span class="rv-acts">
                      <button type="button" class="rv-dis" :aria-expanded="!!why[i.id]" :aria-controls="'why-' + i.id" @click="why[i.id] = !why[i.id]"><Icon name="chevron-down" :size="13" class="chev" /> Why</button>
                      <button v-if="i.kind === 'agent'" type="button" class="rv-dis" :aria-expanded="!!edit[i.id]" :aria-controls="'ed-' + i.id" @click="edit[i.id] = !edit[i.id]"><Icon name="pen" :size="13" /> Edit name, model, boss</button>
                    </span>
                  </div>
                  <button v-if="toggleable(i)" type="button" class="sw sm" role="switch" :aria-checked="on(i)" :aria-label="`Import ${title(i)}`" @click="toggle(i)" />
                  <span v-else class="rv-note">Install again from the panel</span>
                </div>
                <Transition name="rv-fold"><p v-if="why[i.id]" :id="'why-' + i.id" class="rv-why">{{ i.reason }}</p></Transition>
                <Transition name="rv-fold">
                  <div v-if="i.kind === 'agent' && edit[i.id]" :id="'ed-' + i.id" class="rv-ed">
                    <label class="rv-f"><span>Name</span><input :id="'nm-' + i.id" :value="nameDraft[i.id]" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" maxlength="40" :aria-invalid="!!nameErr(i) || !!itemErrs(i).length" :aria-describedby="'nme-' + i.id" @input="typeName(i, ($event.target as HTMLInputElement).value)" /></label>
                    <div class="rv-f"><span :id="'mdl-' + i.id">Model</span><Select :id="'md-' + i.id.replace(/[^a-z0-9-]/gi, '-')" :model-value="dec[i.id]?.edits?.model ?? ''" :options="modelOpts" label="Model" @update:model-value="setEdit(i, 'model', $event)" /></div>
                    <div class="rv-f"><span>Boss</span><Select :id="'bs-' + i.id.replace(/[^a-z0-9-]/gi, '-')" :model-value="dec[i.id]?.edits?.boss ?? 'root'" :options="bossOpts(i)" label="Boss" @update:model-value="setEdit(i, 'boss', $event)" /></div>
                    <p :id="'nme-' + i.id" class="rv-err" role="alert">{{ nameErr(i) || itemErrs(i).join(" ") }}</p>
                  </div>
                </Transition>
                <p v-if="!(i.kind === 'agent' && edit[i.id]) && itemErrs(i).length" class="rv-err" role="alert">{{ itemErrs(i).join(" ") }}</p>
              </li>
            </ul>
          </section>
        </div>
        <p v-if="netErr || error || loose.length" class="rv-err rv-gen" role="alert">{{ [netErr || error, ...loose].filter(Boolean).join(" ") }}</p>
        <div class="rv-foot">
          <button type="button" class="rv-b ghost" :disabled="busy" @click="emit('back')">Back</button>
          <span class="rv-pend" aria-live="polite">{{ pending ? "Saving…" : "" }}</span>
          <button type="button" class="rv-b" :disabled="!canPreview" @click="emit('preview')">{{ busy ? "Building preview…" : footerLabel(count) }}</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.rv{display:grid;gap:12px;min-width:0}.rv *{min-width:0}
.rv-sum{margin:0;font-size:13.5px;line-height:1.45}
.rv-t{margin:0;font-size:13px}.rv-t.sm{display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--muted)}
.rv-desk{display:grid;gap:12px}
.rv-list{display:grid;gap:16px}
.rv-gh{display:flex;align-items:center;gap:10px;padding:0 4px 6px;border-bottom:1px solid var(--line)}
.rv-gh h4{margin:0;flex:1;font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.rv-gh em{font:500 12px var(--mono);font-style:normal;color:var(--muted);min-width:9ch;text-align:right}
.rv-rows{list-style:none;margin:0;padding:0;display:grid}
.rv-r{display:grid;gap:6px;padding:10px 4px;border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent)}
.rv-r.off .rv-txt b,.rv-r.off .rv-ic{opacity:.55}
.rv-main{display:flex;align-items:flex-start;gap:10px}
.rv-ic{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--track);color:var(--muted);font-style:normal;transition:opacity .18s}
.rv-txt{flex:1;display:grid;gap:3px}
.rv-txt b{font:600 13.5px/1.35 var(--body);overflow-wrap:anywhere;transition:opacity .18s}
.rv-txt small{color:var(--muted);font-size:12.5px;line-height:1.4;overflow-wrap:anywhere}
.rv-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}
.rv-chip{padding:1px 8px;border-radius:999px;font:600 11px/1.6 var(--body);border:1px solid}
.rv-chip.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 55%,transparent);background:var(--warn-bg)}
.rv-chip.info{color:var(--muted);border-color:var(--line)}
.rv-acts{display:flex;flex-wrap:wrap;gap:4px 12px}
.rv-dis{display:inline-flex;align-items:center;gap:4px;min-height:32px;padding:0;border:0;background:none;color:var(--muted);font:600 12px var(--body);cursor:pointer}
.rv-dis:hover{color:var(--ink)}
.rv-dis .chev{transition:transform .2s cubic-bezier(.2,.8,.2,1)}.rv-dis[aria-expanded="true"] .chev{transform:rotate(180deg)}
.rv-main>.sw{margin-top:4px}
.rv-note{flex:none;max-width:16ch;color:var(--muted);font-size:12px;text-align:right;line-height:1.35}
.rv-why{margin:0 0 0 40px;padding:8px 10px;border-radius:10px;background:var(--track);font-size:12.5px;line-height:1.45}
.rv-ed{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-left:40px;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.rv-f{display:grid;gap:4px;align-content:start}.rv-ed>.rv-f:first-child{grid-column:1/-1}.rv-f>span{color:var(--muted);font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase}
.rv-f input{min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:12px;background:var(--track);color:var(--ink);font:13px var(--mono)}
.rv-f input[aria-invalid="true"]{border-color:var(--bad)}
.rv-f input:focus-visible,.rv-dis:focus-visible,.rv-b:focus-visible,.rv-x:focus-visible{outline:2px solid var(--on);outline-offset:1px}
.rv-err{grid-column:1/-1;margin:0;color:var(--bad);font-size:12.5px;min-height:1.4em}
.rv-r>.rv-err{margin-left:40px;min-height:0}.rv-ed>.rv-err:empty{display:none}
.rv-gen{padding:8px 12px;border-radius:10px;background:var(--bad-bg);min-height:0}
.rv-foot{position:sticky;bottom:-20px;z-index:2;display:flex;align-items:center;gap:10px;margin:0 -20px -20px;padding:12px 20px;background:var(--panel);border-top:1px solid var(--line)}
.rv-pend{flex:1;color:var(--muted);font-size:12px}
.rv-b{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 18px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer;white-space:nowrap}
.rv-b:disabled{opacity:.35;cursor:default}
.rv-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.rv-mini{display:grid;gap:10px;padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--panel-2)}
.rv-mg{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:13px}.rv-mg li{display:flex;justify-content:space-between;gap:8px}.rv-mg em{font:500 12px var(--mono);font-style:normal;color:var(--muted)}
.rv-mini .rv-b{width:100%}
/* phone sheet: fixed to the bottom of the setup window, inner list scrolls, footer sticks */
.rv-sh{position:fixed;left:0;right:0;bottom:0;z-index:5;display:flex;flex-direction:column;height:min(92dvh,calc(100dvh - 48px));border:1px solid var(--line);border-bottom:0;border-radius:18px 18px 0 0;background:var(--panel);box-shadow:0 -12px 40px rgba(0,0,0,.35)}
.rv-sh-h{position:relative;display:flex;align-items:center;gap:8px;padding:14px 12px 8px 16px;border-bottom:1px solid var(--line)}
.rv-sh-h h3{flex:1;margin:0;font:700 16px var(--body);outline:none}
.rv-grab{position:absolute;top:6px;left:50%;width:36px;height:4px;margin-left:-18px;border-radius:2px;background:var(--line)}
.rv-x{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:12px;background:transparent;color:var(--ink);cursor:pointer}
.rv-sh .rv-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px}
.rv-sh .rv-gen{margin:0 14px 8px}
.rv-sh .rv-foot{position:static;margin:0;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px))}
.rv-sh .rv-foot .rv-b:not(.ghost){flex:1}
.rv-sh .rv-pend{display:none}
.rv-sh-enter-active,.rv-sh-leave-active{transition:transform .24s cubic-bezier(.2,.8,.2,1),opacity .24s cubic-bezier(.2,.8,.2,1)}
.rv-sh-enter-from,.rv-sh-leave-to{transform:translateY(100%);opacity:.6}
.rv-desk.rv-sh-enter-from,.rv-desk.rv-sh-leave-to{transform:none;opacity:0}
.rv-fold-enter-active,.rv-fold-leave-active{transition:opacity .2s cubic-bezier(.2,.8,.2,1),transform .2s cubic-bezier(.2,.8,.2,1)}
.rv-fold-enter-from,.rv-fold-leave-to{opacity:0;transform:translateY(-6px)}
@media (max-width:767px){.rv-ed{grid-template-columns:1fr;margin-left:0}.rv-why,.rv-r>.rv-err{margin-left:0}.rv-note{max-width:12ch}}
:global(:root[data-theme="light"] .rv-b:not(.ghost)){color:#fff}
@media (prefers-reduced-motion:reduce){
  .rv-sh-enter-from,.rv-sh-leave-to,.rv-fold-enter-from,.rv-fold-leave-to{transform:none}
  .rv-sh-enter-active,.rv-sh-leave-active,.rv-fold-enter-active,.rv-fold-leave-active{transition:opacity .15s linear}
  .rv-dis .chev,.rv-ic,.rv-txt b{transition:none}
}
</style>
