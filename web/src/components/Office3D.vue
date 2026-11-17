<script setup lang="ts">
// The live 3D office on the Agents map. three.js and the office module load only when this component mounts (3D picked).
// Real data: net.agents (who, state), teams (rooms, parked plots), team tasks (whiteboard notes), net.messages (couriers).
// Selection is shared with the 2D map and the side panel.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { route } from "../router";
import { modelShort } from "../crewTree";
import { net, teams, layoutKey, teamsKey, placing } from "../net";
import { api } from "../ui/api";
import { officeBlur } from "../office3d/prefs";
import type { Plan, PState } from "../office3d/plan";

const props = defineProps<{ selected: string | null; cover: number; half?: boolean }>();
const emit = defineEmits<{ (e: "select", id: string): void; (e: "fail", why: string): void }>();
const host = ref<HTMLElement | null>(null), labels = ref<HTMLElement | null>(null);
const status = ref<"loading" | "ready" | "fail">("loading");
const reduce = typeof matchMedia === "function" && (matchMedia("(prefers-reduced-motion: reduce)").matches);
type Notes = Record<string, string[]>;
type Office = { setSel(n: string): void; resetView(): void; setPlan(p: Plan): void; setDark(d: boolean): void; setTilt(on: boolean): void; setNotes(n: Notes): void; setState(r: Record<string, { state: string; model: string | null }>): void; pushMsg(m: Record<string, unknown>): void; dispose(): void; perf: Record<string, unknown>; bench(n?: number): number[] };
let office: Office | null = null, building = 0, makePlanFn: typeof import("../office3d/plan").makePlan | null = null, cleanFn: (s: string | null | undefined) => string = String;
let rooms: string[] = [], notes: Notes = {}, notesKey = "";
const strip = (n: string) => n.replace(/#\d+$/, "");
const live = () => Object.values(net.agents).filter((a) => a.life === "live" && !placing.has(a.name));
const stateOf = (a: (typeof net.agents)[string]): PState => (a.state === "blocked" || a.reported?.blockedOn ? "blocked" : a.state === "working" ? "working" : "idle");
const nameOfId = (id: string | null) => (!id ? "" : id === "root" ? "root" : id.startsWith("team:") ? id : net.agents[id]?.name ?? "");
const idOfName = (n: string) => (n === "root" ? "root" : Object.values(net.agents).find((a) => a.name === n)?.id ?? "");
const dark = () => document.documentElement.dataset.theme !== "light";
const sim = () => Number(route.value.query.sim) || 0;

function plan(): Plan {
  const el = host.value!;
  const tl = teams.list.filter((t) => t.state === "active").map((t) => ({ id: t.id, name: t.name, lead: t.lead, members: t.members.map(strip), goal: cleanFn(t.goal) }));
  const agents: { name: string; model: string | null; state: PState; boss: string | null; doing: string; idleSince?: number }[] = live().map((a) => ({ name: strip(a.name), model: modelShort(a.model), state: stateOf(a), boss: a.boss ? strip(a.boss) : null, doing: cleanFn(a.doing), idleSince: a.stateSince }));
  // #/agents?sim=20 pads the office with sample people (measuring only, never in normal use)
  for (let i = 0, n = sim(); agents.length < n; i++) { const t = tl[i % Math.max(1, tl.length)]; const name = `sample-${i + 1}`; t?.members.push(name); agents.push({ name, model: "sonnet", state: (["working", "idle", "blocked"] as const)[i % 3], boss: null, doing: "sample" }); }
  const p = makePlanFn!({ agents, teams: tl, aspect: el.clientWidth / Math.max(1, el.clientHeight) });
  rooms = p.rooms.filter((r) => r.t).map((r) => r.id);
  return p;
}
// whiteboard: one note per open team task, read from the team board
async function loadNotes() {
  const out: Notes = {};
  await Promise.all(rooms.map(async (id, i) => {
    try { const r = await api<{ tasks?: { status: string }[] }>(`v1/panel/teams/${encodeURIComponent(id)}`); out[id] = (r.tasks ?? []).filter((t) => t.status !== "done").map((t) => t.status); } catch { out[id] = notes[id] ?? []; }
    if (sim() && !out[id].length) out[id] = Array.from({ length: 5 + i * 3 }, (_, k) => (k % 3 ? "pending" : "in_progress")); // sample notes, only with ?sim
  }));
  const key = JSON.stringify(out); if (key === notesKey) return;
  notesKey = key; notes = out; office?.setNotes(out);
}

async function build() {
  const my = ++building;
  const el = host.value, lab = labels.value; if (!el || !lab) return;
  try {
    const mod = await import("../office3d/office");
    const pm = await import("../office3d/plan");
    if (my !== building) return;
    makePlanFn = pm.makePlan; cleanFn = pm.clean;
    const o = mod.createOffice({ host: el, labels: lab, plan: plan(), dark: dark(), tilt: officeBlur.value, notes, RM: reduce, sel: nameOfId(props.selected), onPick: (n: string) => emit("select", n.startsWith("team:") ? n : idOfName(n)) }) as unknown as Office;
    office = o; status.value = "ready";
    (window as unknown as { __office?: Office }).__office = office;
    loadNotes(); poll = window.setInterval(loadNotes, 12_000);
  } catch (e) { if (my === building) { status.value = "fail"; emit("fail", (e as Error).message || "3D failed"); } }
}
let timer = 0, poll = 0;
// someone joined or left, a team changed: the office changes in place (new people fade in and rise, rooms grow)
const replan = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (office) { office.setPlan(plan()); loadNotes(); } }, 350); };
watch([layoutKey, teamsKey], replan);
const stateKey = computed(() => live().map((a) => `${strip(a.name)}:${stateOf(a)}:${a.model ?? ""}`).join("|"));
watch(stateKey, () => { if (office) office.setState(Object.fromEntries(live().map((a) => [strip(a.name), { state: stateOf(a), model: modelShort(a.model) }]))); });
watch(() => props.selected, (s) => office?.setSel(nameOfId(s)));
watch(officeBlur, (on) => office?.setTilt(on));
// real messages: one courier per new message; a backlog after a reconnect is history, not traffic
let lastMsg: number | null = net.messages.reduce<number | null>((mx, m) => (m.id != null && (mx == null || m.id > mx) ? m.id : mx), null);
watch(() => net.messages.length, () => {
  const fresh = net.messages.filter((m) => m.id != null && (lastMsg == null || m.id > lastMsg)); if (!fresh.length) return;
  lastMsg = Math.max(...fresh.map((m) => m.id!));
  for (const m of fresh) if (Date.now() - m.at < 10_000) office?.pushMsg({ from: strip(m.from), to: strip(m.to), kind: m.kind });
});
let mo: MutationObserver | null = null;
onMounted(() => { build(); mo = new MutationObserver(() => office?.setDark(dark())); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); });
onBeforeUnmount(() => { building++; clearTimeout(timer); clearInterval(poll); mo?.disconnect(); office?.dispose(); office = null; delete (window as unknown as { __office?: Office }).__office; });
</script>

<template>
  <section class="o3" aria-label="3D office: live agents at their desks" :style="{ marginBottom: half ? '46dvh' : undefined, '--cover': cover + 'px' }">
    <div ref="host" class="o3-s" />
    <div ref="labels" class="o3-l" />
    <button v-if="status === 'ready'" type="button" class="o3-fit" aria-label="Fit office to view" @click="office?.resetView()">Fit</button>
    <p v-if="status === 'loading'" class="o3-st" role="status">Loading the office…</p>
    <p v-else-if="status === 'fail'" class="o3-st" role="alert">3D is not available here. Use 2D.</p>
  </section>
</template>

<style>
.o3{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--panel-2)}
.o3-s{position:absolute;inset:0}.o3-s canvas{display:block}
.o3-l{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.o3-fit{position:absolute;right:calc(10px + var(--cover,0px));top:10px;z-index:4;height:32px;padding:0 12px;border:0;border-radius:10px;background:var(--panel);box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);font:600 12px/1 var(--body);cursor:pointer}
.o3-fit:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.o3-st{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:var(--muted);font:600 13px var(--body)}
.o3 .lbl{position:absolute;left:0;top:0;will-change:transform;display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:10px;background:color-mix(in srgb,var(--panel) 90%,transparent);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line);font:600 12px/1.1 var(--body);white-space:nowrap}
.o3 .lbl em{font-style:normal;font-weight:500;color:var(--muted)}
.o3 .lbl.room{font-size:13px;margin-top:-34px}
.o3 .lbl.room.pick,.o3 .lbl.fig{pointer-events:auto;cursor:pointer}
.o3 .lbl.fig{flex-direction:column;align-items:flex-start;gap:3px}
.o3 .lbl.fig span{display:flex;align-items:center;gap:6px}
.o3 .lbl.fig em{font-size:11px;padding-left:15px}
.o3 .lbl.fig::after{content:"";position:absolute;left:50%;top:100%;width:8px;height:5px;margin-left:-4px;background:color-mix(in srgb,var(--panel) 90%,transparent);clip-path:polygon(0 0,100% 0,50% 100%)}
.o3 .lbl.plot{flex-direction:column;gap:3px;align-items:center}
.o3 .lbl.sel{box-shadow:0 0 0 2px var(--sel)}
.o3 .lbl.dir b{font-weight:700}
.o3 .sm .lbl{font-size:11px;padding:4px 7px}
.o3 .lbl.fig.hi::after{width:2px;height:var(--stem,30px);margin-left:-1px;clip-path:none;background:var(--line)}
.o3 .sm .lbl.fig em{display:none}
.o3 .sm .lbl.alt{margin-top:-20px}
.o3 .sm .lbl.alt::after{width:2px;height:22px;margin-left:-1px;clip-path:none;background:var(--line)}
.o3 .g{flex:none;width:9px;height:9px}
.o3 .g-working{border-radius:50%;background:var(--on)}
.o3 .g-idle{border-radius:50%;box-shadow:inset 0 0 0 2px var(--muted)}
.o3 .g-away{border-radius:50%;box-shadow:inset 0 0 0 2px var(--pend)}
.o3 .g-blocked{width:10px;background:var(--pend);clip-path:polygon(50% 0,100% 100%,0 100%)}
.o3 .g-talk{background:#6aa8ff;border-radius:2px}
.o3 .hud{position:absolute;right:12px;top:52px;padding:5px 9px;border-radius:8px;background:var(--panel);box-shadow:0 0 0 1px var(--line);font:600 12px/1.2 var(--mono);color:var(--ink)}
</style>
