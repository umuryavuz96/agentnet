<script setup lang="ts">
// The one agent card: the 2D map, the Cards view and the director (running, not running, first set-up) all draw this.
// Anatomy: a tile with the agent's dot mark whose edge shows the state (an arc turns round it while the agent works);
// name over the state word, context figure over model on the right; the line it works on; plan progress; the context window
// as a fill along the card's bottom edge. A working card carries a soft wash of its colour. A state change cross-fades the wash
// and the tile's edge, sweeps one band of light up the card and rolls the word. Nothing changes size on a state, selection or hover change:
// every effect is a layer whose transform or opacity moves.
// Hover: every part reads one class (`hot`) and one token pair (--hv-d, --hv-e), so they start and end on the same frame.
import { computed, ref, watch } from "vue";
import Icon from "../ui/Icon.vue";
import TrailLine from "./TrailLine.vue";
import { agentSlot, hueForSlot, nameHash } from "./chat/agentHue";
import { net, windows, humanDoing, ctxView, bgVisible, bgShown, type AgentRow } from "../net";
import { curJob, endedText, planCount, planLine } from "../plan";
import { short } from "../trailView";
import { brk, crewState, modelShort } from "../crewTree";

const props = withDefaults(defineProps<{
  row: AgentRow | null; name: string; id?: string; dir?: boolean; lead?: boolean; sel?: boolean;
  /** Set by a parent that owns hover (the map lights the card with its lines and peek); left out, the card lights itself. */
  hot?: boolean; near?: boolean;
  /** Show the Terminal window buttons. */
  acts?: boolean; hadRoot?: boolean; last?: { dir: string | null; at: number } | null;
}>(), { hot: undefined, lead: undefined });
const emit = defineEmits<{ pick: []; details: []; hover: [on: boolean, el: HTMLElement]; open: []; close: []; resume: []; fresh: [] }>();

const now = () => net.now || Date.now();
const gone = computed(() => !!props.row && (props.row.life === "gone" || props.row.life === "failed"));
const isRoot = computed(() => props.dir || props.row?.name === "root");
type St = "setup" | "notrunning" | "starting" | "stopping" | "working" | "idle" | "waiting" | "blocked";
const st = computed<St>(() => {
  const r = props.row;
  if (!r) return props.hadRoot ? "notrunning" : "setup";
  if (isRoot.value && gone.value) return "notrunning";
  if (r.life === "starting") return "starting";
  if (r.life === "stopping" || gone.value) return "stopping";
  const s = crewState(r);
  return s === "working" || s === "waiting" || s === "blocked" ? s : "idle";
});
const WORD: Record<St, string> = { setup: "Not set up", notrunning: "Not running", starting: "Starting", stopping: "Stopping", working: "Working", idle: "Idle", waiting: "Needs you", blocked: "Blocked" };
const word = computed(() => WORD[st.value]);
// one ripple per state change, none on first paint
const rip = ref(0);
watch(st, () => { rip.value++; });

const ctxv = computed(() => ctxView(props.row));
const ctx = computed(() => (ctxv.value ? Math.round(ctxv.value.pct) : null));
const tok = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.round(n / 1e3) + "k");
const win = computed(() => (ctxv.value ? tok(ctxv.value.window) : null));
// the monogram: initials and number from the name (designer-3: D3), so an agent reads the same everywhere. Its colour is the
// team's on the map (the card, its lines and its team node share it) and one from the name elsewhere.
const hash = computed(() => nameHash(props.name));
// each agent its own colour (owner msg 8240: "all agents are in same color"): the shared rule in chat/agentHue.ts, so the chat
// shows the same hue as this card. slot: the agent's place among live agents (root 0, the rest from 1 in name order).
const slot = computed(() => (isRoot.value ? 0 : agentSlot(props.name)));
const hue = computed(() => hueForSlot(slot.value));
// the dot mark (owner msg 8232 liked it): a 3x3 pattern from the name, so an agent looks the same everywhere; it waves while it works
// and its own wave (owner msg 8239: "those animated illustrations are all the same"): its place picks one of six orders the dots
// light in and a speed, so two working agents never pulse alike.
const SPIRAL = [0, 1, 2, 7, 8, 3, 6, 5, 4];
const waveKind = computed(() => slot.value % 6);
const waveDur = computed(() => 1.1 + ((slot.value * 3) % 5) * 0.2);
const dotDelay = (i: number) => {
  const r = Math.floor(i / 3), c = i % 3, h = hash.value;
  const step = [(r + c) * 120, r * 200, c * 200, (Math.abs(r - 1) + Math.abs(c - 1)) * 180, SPIRAL[i] * 95, ((h >>> (i * 3)) & 7) * 120][waveKind.value];
  return step + "ms";
};
const mark = computed(() => { let b = (hash.value >>> 3) & 511; if ([...b.toString(2)].filter((x) => x === "1").length < 4) b ^= 0b101110101; return Array.from({ length: 9 }, (_, i) => !!((b >> i) & 1)); });
const ctxTip = computed(() => (ctxv.value ? `${tok(ctxv.value.tokens)} of ${tok(ctxv.value.window)} context used` : word.value));
const isLead = computed(() => props.lead ?? Object.values(net.agents).some((a) => a.boss === props.name && a.name !== props.name));
const winOpen = computed(() => (props.row?.window as { open?: boolean } | undefined)?.open === true);

// the line under the head: why it is blocked, else the plan step in work (with its number), else how the job ended, else what it does
const blockedOn = computed(() => props.row?.reported?.blockedOn ?? null);
const pl = computed(() => (props.row && st.value !== "notrunning" && !blockedOn.value ? planLine(props.row) : null));
const doing = computed(() => { const t = props.row ? humanDoing(props.row.doing) ?? "" : ""; return t && t.toLowerCase() !== word.value.toLowerCase() && t.toLowerCase() !== st.value ? t : ""; });
const grew = computed(() => { const j = props.row ? curJob(props.row) : null; return !!j && !j.legacy && planCount(j).grew; });

// background work (subagents, shells, monitors) the agent started itself
const KIND: Record<string, string> = { subagent: "Subagent", shell: "Shell", monitor: "Monitor" };
const bg = computed(() => bgVisible(props.row?.bg, now()).filter((b) => b.state === "running").slice(0, 2));
const dur = (b: { startedAt: number; endedAt: number | null; state: string }) => { const s = Math.max(0, Math.round(((b.state === "running" ? now() : b.endedAt ?? Date.now()) - b.startedAt) / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; };

// a director that ran before and is gone: where it ran and when
const folder = computed(() => props.last?.dir?.replace(/^\/Users\/[^/]+/, "~") ?? null);
const ago = computed(() => {
  const t = props.last?.at; if (!t) return null;
  const m = Math.max(0, Math.round((now() - t) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
});

const TIP = "Opens a Terminal window on the server Mac";
const btnOff = computed(() => (gone.value && !isRoot.value) || !windows.available || !!windows.busy);
const btnTip = computed(() => (isRoot.value && gone.value ? "Start director" : gone.value ? "Agent is gone" : !windows.available ? `${TIP} (arrives with M8)` : TIP));

// hover: the parent's `hot` when it gives one, else the card's own
const hov = ref(false), el = ref<HTMLElement | null>(null);
const isHot = computed(() => props.hot ?? hov.value);
const onEnter = (e: PointerEvent) => { if (e.pointerType !== "mouse") return; hov.value = true; emit("hover", true, e.currentTarget as HTMLElement); };
const onLeave = (e: PointerEvent) => { if (e.pointerType !== "mouse") return; hov.value = false; emit("hover", false, e.currentTarget as HTMLElement); };
/** The sheen follows the pointer (paint only; nothing depends on it). */
const onMove = (e: PointerEvent) => { const c = el.value; if (!c || e.pointerType !== "mouse") return; const r = c.getBoundingClientRect(); c.style.setProperty("--px", ((e.clientX - r.left) / r.width) * 100 + "%"); c.style.setProperty("--py", ((e.clientY - r.top) / r.height) * 100 + "%"); };
</script>

<template>
  <div ref="el" :class="['fcard', 'anc', 's-' + st, { dir: isRoot, sel, hot: isHot, near, norow: !row }]" :data-id="id ?? row?.id ?? name" :data-s="st" :style="{ '--ah': hue, '--md': waveDur + 's' }" role="button" tabindex="0" :aria-pressed="sel ? 'true' : 'false'"
    @click="emit('pick')" @keydown.enter.self.prevent="emit('pick')" @keydown.space.self.prevent="emit('pick')" @pointerenter="onEnter" @pointerleave="onLeave" @pointermove="onMove">
    <i class="fsh" aria-hidden="true" />
    <span class="ffx" aria-hidden="true">
      <Transition name="xf"><i :key="st" class="faura" :data-s="st" /></Transition>
      <i v-if="rip" :key="rip" class="frip" :data-s="st" />
      <i class="fspot" />
    </span>
    <i class="fsheen" aria-hidden="true" />
    <span v-if="ctx != null" :class="['fbar', { hi: ctx >= 80 }]" aria-hidden="true"><i :style="{ transform: `scaleX(${Math.max(0.02, Math.min(1, ctx / 100))})` }" /></span>

    <span class="fhd">
      <span class="fav" aria-hidden="true"><Transition name="xf"><i :key="st" class="fring" :data-s="st"><i class="frot" /></i></Transition><span class="fmk"><i v-for="(on, i) in mark" :key="i" :class="{ on }" :style="{ animationDelay: dotDelay(i) }" /></span></span>
      <span class="fid">
        <span class="fr">
          <span class="fch">
            <b class="fnm">{{ row ? brk(name) : hadRoot ? "Director" : "Set up your director" }}</b>
            <span v-if="row && isRoot" class="fchip role">Director</span><span v-else-if="row && isLead" class="fchip role">Lead</span>
            <span v-if="row && winOpen" class="fchip win" title="Its Terminal window is open on the server Mac"><Icon name="square-terminal" :size="11" /> open</span>
            <span v-if="row && grew" class="fchip grew" title="The plan grew by more than half of the brief's steps">Scope grew</span>
          </span>
          <span v-if="ctx != null" :class="['fbn', { hi: ctx >= 80 }]" :title="ctxTip"><b class="fctx">{{ ctx }}%</b><template v-if="win"> of {{ win }}</template></span>
          <!-- the card opens the chat; this small button opens the details panel instead (owner 8362) -->
          <button v-if="row" type="button" class="fdet" aria-label="Details" :title="`Details: ${name}`" @click.stop="emit('details')" @keydown.stop @pointerdown.stop><Icon name="panel-right" :size="14" /></button>
        </span>
        <span class="fr">
          <span class="fslot" role="img" :aria-label="ctx != null ? `${word}, context ${ctx}% used` : word">
            <Transition name="roll">
              <span :key="st" class="fpill" :data-s="st">
                <svg v-if="st === 'waiting'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5" /><path d="M12 7v5l3 2" /></svg>
                <svg v-else-if="st === 'blocked'" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5" /><path d="M5.5 5.5l13 13" /></svg>
                <i v-else class="fpd" />
                <span class="fstw">{{ word }}</span>
              </span>
            </Transition>
          </span>
          <span v-if="row && modelShort(row.model)" class="fmd" :title="row.model ?? undefined">{{ modelShort(row.model) }}</span>
        </span>
      </span>
    </span>

    <template v-if="row">
      <span v-if="blockedOn" :key="'b' + blockedOn" class="fline bad fx" :title="blockedOn">Blocked: {{ blockedOn }}</span>
      <span v-else-if="pl && 'no' in pl" :key="pl.no" class="fline fx" :title="pl.text"><span class="fno">{{ pl.no }}</span>{{ pl.text }}</span>
      <span v-else-if="pl" :key="'job' + pl.ended.id" class="fline fx">{{ endedText(pl, short(net.now - pl.ended.closedAt!)) }}</span>
      <span v-else-if="doing" :key="doing" class="fline fx" :title="doing">{{ doing }}</span>

      <TransitionGroup v-if="bg.length" tag="ul" name="bgr" class="bgl" aria-label="Background work">
        <li v-for="b in bg" :key="b.id" :class="['bgi', bgShown(b, now())]" :title="`${KIND[b.kind]}: ${b.label} · ${b.state}`"><i class="bgd" /><span class="bgk">{{ KIND[b.kind] }}</span><span class="bgt">{{ b.label }}</span><span class="bgs">{{ bgShown(b, now()) === "stale" ? "stale" : b.state === "running" ? dur(b) : b.state + " · " + dur(b) }}</span></li>
      </TransitionGroup>

      <TrailLine :row="row" />
      <span v-if="acts" class="acts" @click.stop @keydown.stop>
        <button type="button" class="btn sm" :disabled="btnOff" :title="btnTip" :aria-label="`Open ${name} in Terminal`" @click="emit('open')"><Icon name="square-terminal" :size="14" /> Open</button>
        <button type="button" class="btn sm ghost" :disabled="btnOff" :title="gone ? 'Agent is gone' : 'Closes its Terminal window; the agent keeps running'" :aria-label="`Close ${name} window`" @click="emit('close')"><Icon name="x" :size="14" /> Close</button>
      </span>
    </template>
    <template v-else>
      <span class="fline">{{ hadRoot ? "The director ran before and is not running now." : "No director connected yet." }}</span>
      <span v-if="hadRoot && folder" class="flast" :title="last?.dir ?? undefined"><span class="mono">{{ folder }}</span><span v-if="ago">last active {{ ago }}</span></span>
      <span v-if="hadRoot" class="acts" @click.stop @keydown.stop>
        <button type="button" class="cta" @click="emit('resume')">Resume director <Icon name="arrow-up-right" :size="14" /></button>
        <button type="button" class="fresh" @click="emit('fresh')">Start fresh</button>
      </span>
      <span v-else class="acts"><span class="cta">Set up now <Icon name="arrow-up-right" :size="14" /></span></span>
    </template>
  </div>
</template>

<style scoped>
.fcard{--bg:#1e1e21;--hair:rgba(255,255,255,.1);--shl:rgba(255,255,255,.55);--she:rgba(255,255,255,.16);--spot:rgba(255,255,255,.04);--trk:rgba(255,255,255,.1);--drop:0 1px 2px rgba(0,0,0,.35),0 4px 10px -6px rgba(0,0,0,.5);--lift:0 14px 28px -14px rgba(0,0,0,.8);--acl:62%;--wash:26%;
  --hd:var(--hv-d,.22s);--he:var(--hv-e,cubic-bezier(.2,.8,.2,1));--sc:var(--off);--ac:hsl(var(--ah,212) 78% var(--acl));
  position:relative;isolation:isolate;box-sizing:border-box;width:100%;min-width:0;display:flex;flex-direction:column;gap:8px;padding:12px 14px 15px;border-radius:16px;
  background:var(--bg);color:var(--ink);text-align:left;font:inherit;font-size:13px;cursor:pointer;transition:opacity var(--hd) var(--he)}
:root[data-theme="light"] .fcard{--bg:#ffffff;--hair:rgba(0,0,0,.08);--shl:rgba(20,22,40,.5);--she:rgba(20,22,40,.2);--spot:rgba(20,22,40,.025);--trk:rgba(0,0,0,.08);--drop:0 1px 1px -1px rgba(0,0,0,.1),0 1px 3px rgba(0,0,0,.06);--lift:0 12px 24px -12px rgba(20,22,40,.28);--acl:52%;--wash:20%}
[data-s="working"]{--sc:var(--on)}[data-s="waiting"]{--sc:var(--warn)}[data-s="blocked"]{--sc:var(--bad)}[data-s="setup"]{--sc:var(--on)}
[data-s="idle"],[data-s="starting"],[data-s="stopping"],[data-s="notrunning"]{--sc:var(--off)}
.fcard:focus-visible{outline:2px solid var(--sel);outline-offset:3px}
/* idle agents step back; a stopping one too */
.fcard.s-idle:not(.sel):not(.hot):not(:focus-visible){opacity:.55}
.fcard.s-stopping:not(.sel):not(.hot){opacity:.6}
/* rings: selection (::before), needs you and the message glow (::after; the map animates its opacity) */
.fcard::before,.fcard::after{content:"";position:absolute;inset:-2px;border-radius:18px;pointer-events:none;opacity:0;z-index:3}
.fcard::before{box-shadow:0 0 0 2px var(--sel);transition:opacity .16s ease}
.fcard.sel::before{opacity:1}
.fcard::after{box-shadow:0 0 0 1.5px var(--warn),0 0 18px color-mix(in srgb,var(--warn) 26%,transparent);transition:opacity .45s ease}
.fcard.s-waiting::after{opacity:1}
.fcard[data-glow]::after{box-shadow:0 0 0 1.5px var(--gk),0 0 22px color-mix(in srgb,var(--gk) 45%,transparent)}
/* depth: a hairline and a small soft shadow; a deeper one fades in on hover */
.fsh{position:absolute;inset:0;border-radius:inherit;z-index:-1;pointer-events:none;box-shadow:0 0 0 .75px var(--hair),var(--drop);transition:opacity var(--hd) var(--he)}
.fsh::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:var(--lift);opacity:0;transition:opacity var(--hd) var(--he)}
.fcard.hot .fsh::after{opacity:1}
/* a soft glow of the agent's colour round a working card; it breathes on the line pulse clock (3.2 s), opacity only */
.fsh::before{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:0 0 0 1px color-mix(in srgb,var(--ac) 40%,transparent),0 0 26px -2px color-mix(in srgb,var(--ac) 45%,transparent);opacity:0;transition:opacity .45s ease}
.fcard.s-working .fsh::before{opacity:.75;animation:ac-glow 3.2s cubic-bezier(.65,0,.35,1) infinite}
@keyframes ac-glow{0%,100%{opacity:.5}50%{opacity:1}}
.fcard.s-starting .fsh,.fcard.s-notrunning .fsh,.fcard.s-setup .fsh{box-shadow:none;border:1px dashed color-mix(in srgb,var(--muted) 60%,transparent)}
/* light inside the card: a wash of the agent's colour while it works (amber or red when it needs you or is blocked),
   one band of light per state change, the pointer spot */
.ffx{position:absolute;inset:0;border-radius:inherit;overflow:hidden;pointer-events:none;z-index:0}
.faura{position:absolute;inset:0;--wc:var(--ac)}
.faura[data-s="waiting"],.faura[data-s="blocked"]{--wc:var(--sc)}
.faura[data-s="working"],.faura[data-s="waiting"],.faura[data-s="blocked"]{background:radial-gradient(130% 95% at 0% 100%,color-mix(in srgb,var(--wc) var(--wash),transparent),transparent 62%),linear-gradient(180deg,color-mix(in srgb,var(--wc) 7%,transparent),transparent 60%)}
.faura[data-s="working"]{animation:ac-breathe 3.2s ease-in-out infinite}
@keyframes ac-breathe{50%{opacity:.6}}
.frip{position:absolute;left:-10%;right:-10%;top:0;height:100%;--wc:var(--ac);background:linear-gradient(8deg,transparent 22%,color-mix(in srgb,var(--wc) 30%,transparent) 48%,color-mix(in srgb,#fff 16%,transparent) 54%,transparent 76%);animation:ac-rip .95s cubic-bezier(.3,.6,.2,1) forwards}
.frip[data-s="waiting"],.frip[data-s="blocked"]{--wc:var(--sc)}
.frip[data-s="idle"],.frip[data-s="stopping"],.frip[data-s="notrunning"]{--wc:var(--muted)}
@keyframes ac-rip{0%{transform:translateY(85%);opacity:0}30%{opacity:1}100%{transform:translateY(-85%);opacity:0}}
.fspot{position:absolute;inset:0;background:radial-gradient(220px circle at var(--px,50%) var(--py,0%),var(--spot),transparent 62%);opacity:0;transition:opacity var(--hd) var(--he)}
.fcard.hot .fspot{opacity:1}
/* edge light: a ring one pixel wide, brighter under the pointer; neighbours of a hovered card get a quieter one */
.fsheen{position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;z-index:2;background:radial-gradient(200px circle at var(--px,50%) var(--py,0%),var(--shl),transparent 62%),linear-gradient(var(--she),var(--she));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);opacity:0;transition:opacity var(--hd) var(--he)}
.fcard.hot .fsheen{opacity:1}
.fcard.near:not(.hot) .fsheen{opacity:.5}
/* content sits over the light */
.fhd,.fline,.flast,.bgl,.trl,.acts{position:relative;z-index:1}
.fhd{display:flex;align-items:flex-start;gap:10px;min-width:0}
.fdet{flex:none;display:grid;place-items:center;width:26px;height:26px;margin:-4px -6px -4px 0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;transition:background-color .15s var(--he),color .15s var(--he)}
.fdet:hover{background:var(--trk);color:var(--ink)}
.fdet:focus-visible{outline:2px solid var(--sel);outline-offset:1px}
.fid{display:flex;flex-direction:column;gap:0;min-width:0;flex:1}
.fr{display:flex;align-items:flex-start;gap:10px;min-width:0;min-height:16px}
.fch{display:flex;align-items:center;gap:3px 6px;min-width:0;flex:1;flex-wrap:wrap}
.fnm{font-weight:600;font-size:14px;line-height:18px;letter-spacing:-.005em;overflow-wrap:anywhere;min-width:0}
.fmd{flex:none;font-size:12px;line-height:16px;color:var(--muted)}
/* the monogram tile: initials in the agent's colour. Its edge is the state: an arc turns round it while the agent works, a
   still amber or red edge when it needs you or is blocked, a dashed edge that turns slowly while it starts */
.fav{position:relative;flex:none;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--ac) 10%,var(--bg));box-shadow:inset 0 0 0 .75px var(--hair)}
.fmk{position:relative;display:grid;grid-template-columns:repeat(3,4px);gap:2.5px}
.fmk i{width:4px;height:4px;border-radius:1.2px;background:var(--ac);opacity:.16}
.fmk i.on{opacity:1}
.s-working .fmk i{animation:ac-dot var(--md,1.5s) ease-in-out infinite}
.s-working .fmk i.on{animation-name:ac-dot-on}
@keyframes ac-dot{0%,100%{opacity:.12}45%{opacity:.45}}
@keyframes ac-dot-on{0%,100%{opacity:.35;transform:scale(.8)}45%{opacity:1;transform:scale(1.1)}}
.s-idle .fmk i.on,.s-stopping .fmk i.on,.s-notrunning .fmk i.on{opacity:.55}
.fring{position:absolute;inset:0;border-radius:inherit;padding:1.5px;overflow:hidden;pointer-events:none;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.fring[data-s="working"]{background:color-mix(in srgb,var(--sc) 26%,transparent)}
.fring[data-s="waiting"],.fring[data-s="blocked"]{background:var(--sc)}
.frot{position:absolute;inset:-45%}
.fring[data-s="working"] .frot{background:conic-gradient(transparent 0 58%,color-mix(in srgb,var(--sc) 40%,transparent) 80%,var(--sc) 100%);animation:ac-spin 1.6s linear infinite}
.fring[data-s="starting"] .frot{background:repeating-conic-gradient(var(--muted) 0 6%,transparent 0 12.5%);animation:ac-spin 4s linear infinite}
@keyframes ac-spin{to{transform:rotate(1turn)}}
/* the state word: rolls in a slot of fixed height that takes the row's free width, so nothing beside it moves */
.fslot{position:relative;flex:1;min-width:0;height:16px}
.fpill{position:absolute;left:0;top:0;display:inline-flex;align-items:center;gap:5px;height:16px;font-weight:600;font-size:12px;line-height:16px;white-space:nowrap;color:var(--pc,var(--muted))}
.fpill[data-s="working"],.fpill[data-s="setup"]{--pc:var(--on)}.fpill[data-s="waiting"]{--pc:var(--warn)}.fpill[data-s="blocked"]{--pc:var(--bad)}
.fpd{width:6px;height:6px;margin:0 2.5px;border-radius:50%;background:currentColor}
.roll-enter-active,.roll-leave-active{transition:opacity .3s cubic-bezier(.23,1,.32,1),transform .3s cubic-bezier(.23,1,.32,1)}
.roll-enter-from{opacity:0;transform:translateY(60%)}
.roll-leave-to{opacity:0;transform:translateY(-60%)}
.xf-enter-active,.xf-leave-active{transition:opacity .45s ease}
.xf-enter-from,.xf-leave-to{opacity:0}
.fchip{display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 5px;border-radius:5px;font-weight:550;font-size:10.5px;line-height:16px;color:var(--muted);background:color-mix(in srgb,var(--ink) 7%,transparent);white-space:nowrap}
.fchip.grew{color:var(--pend);background:color-mix(in srgb,var(--pend) 13%,transparent)}
.fchip.win{color:var(--on);background:var(--on-bg)}
/* what it works on: two lines at most; the whole text is in the tooltip and the peek */
.fline{color:color-mix(in srgb,var(--ink) 86%,var(--muted));font-size:13px;line-height:18px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
.norow .fline{display:block;color:var(--muted)}
.fline.bad{color:var(--bad)}
.s-waiting .fline{color:var(--warn)}
.fno{margin-right:6px;font:500 11.5px/18px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted)}
.fx{animation:ac-in .3s ease}
@keyframes ac-in{from{opacity:0}to{opacity:1}}
/* context: the card's bottom edge fills in the agent's colour (amber from 80%); the figure sits top right */
.fbar{position:absolute;left:0;right:0;bottom:0;height:16px;border-radius:0 0 16px 16px;overflow:hidden;pointer-events:none;z-index:1}
.fbar::before,.fbar i{content:"";position:absolute;left:0;right:0;bottom:0;height:3px}
.fbar::before{background:var(--trk)}
.fbar i{border-radius:0 2px 2px 0;background:var(--ac);transform-origin:0 50%;transition:transform .7s cubic-bezier(.23,1,.32,1)}
.fbar.hi i{background:var(--warn)}
.fbn{flex:none;font:500 11.5px/18px var(--mono);font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.fbn b{font-weight:500}
.fbn.hi b{color:var(--warn)}
/* plan progress: thin beads; the bead in work shimmers while the agent works */
.fcard :deep(.tr-segs:not(.none)){height:3px;gap:3px}
.fcard :deep(.tr-seg){border-radius:2px}
.fcard.s-working :deep(.tr-seg.cur .sw){animation:ac-shim 2.3s cubic-bezier(.65,0,.35,1) infinite}
@keyframes ac-shim{0%{opacity:.9;transform:translateX(-100%)}60%,100%{opacity:0;transform:translateX(260%)}}
/* background work */
.bgl{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.bgi{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;line-height:15px;min-width:0;color:var(--muted)}
.bgd{width:6px;height:6px;margin-top:4.5px;border-radius:50%;flex:none;background:var(--off)}
.bgi.running .bgd{background:var(--on);animation:ac-breathe 1.6s ease-in-out infinite}
.bgi.stale{opacity:.5}.bgi.done .bgd{background:var(--on)}.bgi.failed .bgd{background:var(--bad)}
.bgk{flex:none;color:color-mix(in srgb,var(--ink) 70%,var(--muted))}
.bgt{flex:1;min-width:0;overflow-wrap:anywhere}
.bgs{flex:none;font-variant-numeric:tabular-nums}
.bgr-enter-active,.bgr-leave-active{transition:opacity .35s,transform .35s}
.bgr-enter-from,.bgr-leave-to{opacity:0;transform:translateY(-4px)}
/* actions */
.acts{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;margin-top:auto;padding-top:2px}
.acts .btn{display:inline-flex;align-items:center;gap:5px;min-height:30px;border-radius:8px;padding:0 11px;font-size:12.5px}
.acts .btn.ghost{background:transparent}
.cta{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 13px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font:600 13px/32px var(--body);cursor:pointer}
.fresh{border:0;border-radius:8px;background:color-mix(in srgb,var(--ink) 7%,transparent);color:var(--ink);font:550 13px var(--body);min-height:32px;padding:0 13px;cursor:pointer;transition:background-color var(--hd) var(--he)}
.fresh:hover{background:color-mix(in srgb,var(--ink) 12%,transparent)}
.acts button:focus-visible{outline:2px solid var(--sel);outline-offset:2px}
.flast{display:grid;gap:2px;min-width:0;color:var(--muted);font-size:12px;line-height:1.35}
.flast .mono{font-family:var(--mono);overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){
  .frot,.faura,.bgi.running .bgd,.fx,.frip,.fmk i,.fsh::before{animation:none!important}
  .frip{display:none}
  .fcard.s-working :deep(.tr-seg.cur .sw){animation:none}
  .roll-enter-from,.roll-leave-to{transform:none}
  .fbar i,.bgr-enter-active,.bgr-leave-active{transition:none}
}
</style>
