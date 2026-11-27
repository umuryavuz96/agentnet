<script setup lang="ts">
/** The sidebar, drawn like the Mac app's (agentnet-mac Sidebar.swift, canvas Side.dc.html): grown it is one floating
 *  glass panel with the account column and the page list; folded it is round glass icons with no panel behind them,
 *  each growing into a pill with its name on hover. The Usage icon carries a ring that follows the pill. */
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import Icon from "../ui/Icon.vue";
import type { IconName } from "../ui/icons";
import type { Page } from "../router";
import { accountInitial, capsulePath, ringColor } from "../sidebar";
import BrandLockup from "../brand/BrandLockup.vue";
import UpdatePill from "./UpdatePill.vue";

const props = defineProps<{
  page: Page; folded: boolean; /** too narrow to grow: the icons only, no toggle */ compact: boolean;
  nav: Record<Page, [string, IconName]>; groups: { title: string; pages: Page[] }[];
  counts: Partial<Record<Page, string | number>>; usagePct: number | null; health: { ok: boolean; title: string; ver?: string };
}>();
const emit = defineEmits<{ find: []; toggle: [] }>();

/** Counts that wait for the owner are filled (and badged on the folded icon); figures are quiet. */
const HOT: Page[] = ["asks", "hooks"];
const rail = computed(() => props.groups.flatMap((g) => g.pages.map((p, i) => ({ p, first: i === 0 }))));
const label = (p: Page) => props.nav[p][0] + (props.counts[p] ? ` ${props.counts[p]}` : "");
const status = computed(() => (props.health.ok ? "Service up" : "Not answering"));

const host = location.hostname || "agentnet", initial = accountInitial(host);

// ---- the account tile's menu: this web app is served by one agentnet, so it lists that one ----
const menu = ref<{ left: number; top: number } | null>(null);
let opener: HTMLElement | null = null;
function openMenu(e: MouseEvent) {
  if (menu.value) return closeMenu();
  opener = e.currentTarget as HTMLElement;
  const r = opener.getBoundingClientRect();
  menu.value = { left: r.right + 10, top: r.top };
  addEventListener("pointerdown", outside, true); addEventListener("keydown", esc);
}
function closeMenu() { menu.value = null; removeEventListener("pointerdown", outside, true); removeEventListener("keydown", esc); }
const outside = (e: Event) => { const t = e.target as Element; if (!t.closest(".amenu") && !opener?.contains(t)) closeMenu(); };
const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { closeMenu(); opener?.focus(); } };
watch(() => [props.page, props.folded], closeMenu);

// ---- the usage ring's outline follows the item's box, every frame while the pill grows ----
const ring = ref({ w: 40, h: 40 });
let watched: HTMLElement | null = null;
const ro = new ResizeObserver(() => { if (watched?.offsetWidth) ring.value = { w: watched.offsetWidth + 6, h: watched.offsetHeight + 6 }; });
const ringHost = (el: Element | ComponentPublicInstance | null) => {
  if (el === watched) return;
  ro.disconnect(); watched = el as HTMLElement | null;
  if (watched) ro.observe(watched, { box: "border-box" });
};
onBeforeUnmount(() => { ro.disconnect(); closeMenu(); });
</script>

<template>
  <aside v-if="!folded" class="side" aria-label="agentnet">
    <div class="accts">
      <button type="button" class="acct" :title="host" :aria-label="`Account ${host}, current`" aria-haspopup="menu" :aria-expanded="!!menu" @click="openMenu">{{ initial }}</button>
    </div>
    <div class="snav">
      <div class="head">
        <a class="brand" href="#/agents" aria-label="agentnet home"><BrandLockup :height="22" /></a>
        <button type="button" class="colbtn" title="Collapse the sidebar (⌃⌘S)" aria-label="Collapse sidebar" aria-keyshortcuts="Control+Meta+S" @click="emit('toggle')"><Icon name="panel-left" :size="16" /></button>
      </div>
      <button type="button" class="find" aria-label="Find or run, Command K" @click="emit('find')"><Icon name="search" :size="15" /><span>Find or run</span><kbd>⌘K</kbd></button>
      <nav class="list" aria-label="Pages">
        <template v-for="g in groups" :key="g.title">
          <h6>{{ g.title }}</h6>
          <a v-for="p in g.pages" :key="p" class="ni" :class="{ on: page === p }" :href="'#/' + p" :aria-current="page === p ? 'page' : undefined">
            <Icon :name="nav[p][1]" :size="16" /><span>{{ nav[p][0] }}</span><i v-if="counts[p]" class="cnt" :class="{ hot: HOT.includes(p) }">{{ counts[p] }}</i>
          </a>
        </template>
      </nav>
      <a class="ni" :class="{ on: page === 'settings' }" href="#/settings" :aria-current="page === 'settings' ? 'page' : undefined"><Icon :name="nav.settings[1]" :size="16" /><span>{{ nav.settings[0] }}</span></a>
      <UpdatePill />
      <div class="svc" role="status" :title="health.title"><i class="dot" :class="health.ok ? 'ok' : 'bad'" /><span>{{ status }}</span><small v-if="health.ok && health.ver">{{ health.ver }}</small></div>
    </div>
  </aside>

  <nav v-else class="crail" aria-label="Pages">
    <button v-if="!compact" type="button" class="ci" :style="{ '--i': 0 }" aria-label="Expand sidebar" aria-keyshortcuts="Control+Meta+S" @click="emit('toggle')">
      <span class="cap"><span class="ic"><Icon name="panel-left" :size="16" /></span><span class="lbl">Expand sidebar<span class="mono">⌃⌘S</span></span></span>
    </button>
    <button type="button" class="ci me" :style="{ '--i': 1 }" :aria-label="`Account ${host}, current`" aria-haspopup="menu" :aria-expanded="!!menu" @click="openMenu">
      <span class="cap"><span class="ic">{{ initial }}</span><span class="lbl">{{ host }}</span></span>
    </button>
    <span class="csep" :style="{ '--i': 1.7 }" aria-hidden="true" />
    <button type="button" class="ci" :style="{ '--i': 2 }" aria-label="Find or run, Command K" @click="emit('find')">
      <span class="cap"><span class="ic"><Icon name="search" :size="16" /></span><span class="lbl">Find or run<span class="mono">⌘K</span></span></span>
    </button>
    <a v-for="(r, k) in rail" :key="r.p" class="ci" :class="{ on: page === r.p, gap: r.first }" :style="{ '--i': 3 + k }" :href="'#/' + r.p" :data-page="r.p" :aria-label="label(r.p)" :aria-current="page === r.p ? 'page' : undefined">
      <span :ref="r.p === 'usage' ? ringHost : undefined" class="cap">
        <span class="ic"><Icon :name="nav[r.p][1]" :size="16" /><i v-if="HOT.includes(r.p) && counts[r.p]" class="bdg">{{ counts[r.p] }}</i></span>
        <span class="lbl">{{ nav[r.p][0] }}<span v-if="counts[r.p]" class="mono">{{ counts[r.p] }}</span></span>
        <svg v-if="r.p === 'usage' && usagePct != null" class="ring" :width="ring.w" :height="ring.h" aria-hidden="true">
          <path class="tk" :d="capsulePath(ring.w, ring.h)" />
          <path v-if="usagePct > 0" class="vl" :d="capsulePath(ring.w, ring.h)" pathLength="100" :stroke-dasharray="`${Math.min(100, usagePct)} 100`" :style="{ stroke: ringColor(usagePct) }" />
        </svg>
      </span>
    </a>
    <a class="ci gap" :class="{ on: page === 'settings' }" :style="{ '--i': 3 + rail.length }" href="#/settings" data-page="settings" :aria-label="nav.settings[0]" :aria-current="page === 'settings' ? 'page' : undefined">
      <span class="cap"><span class="ic"><Icon :name="nav.settings[1]" :size="16" /></span><span class="lbl">{{ nav.settings[0] }}</span></span>
    </a>
    <div class="cfoot" :style="{ '--i': 4 + rail.length }">
      <UpdatePill />
      <span class="cdot" role="status" :title="`${status}${health.ok && health.ver ? ' ' + health.ver : ''}`" :aria-label="status"><i class="dot" :class="health.ok ? 'ok' : 'bad'" /></span>
    </div>
  </nav>

  <Transition name="am">
    <div v-if="menu" class="amenu" role="menu" aria-label="Account" :style="{ left: menu.left + 'px', top: menu.top + 'px' }">
      <div class="arow" role="menuitem" aria-current="true"><b class="acct">{{ initial }}</b><span><strong>{{ host }}</strong><small>{{ health.ok ? `agentnet ${health.ver ?? ''}` : status }}</small></span><Icon name="check" :size="15" label="current" /></div>
      <a class="alink" role="menuitem" href="#/settings" @click="closeMenu"><Icon :name="nav.settings[1]" :size="15" /> Settings</a>
    </div>
  </Transition>
</template>

<style scoped>
/* grown: the floating glass panel (mac.css .side): 296 wide, 8 from the window, radius 20 */
.side,.amenu{background:linear-gradient(135deg,color-mix(in srgb,var(--glass-hi) 70%,transparent),transparent 45%),var(--glass);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);box-shadow:inset 0 0 0 .75px var(--glass-b),inset 0 1px 0 var(--glass-hi),var(--glass-sh)}
.side{position:fixed;left:8px;top:8px;bottom:8px;width:296px;display:flex;border-radius:20px;overflow:hidden;z-index:50}
.accts{width:60px;flex:none;display:flex;flex-direction:column;align-items:center;padding-top:50px;border-right:1px solid var(--glass-b)}
.acct{display:grid;place-items:center;flex:none;width:38px;height:38px;border:0;border-radius:11px;background:var(--ink);color:var(--bg);font:700 15px var(--body)}
button.acct{position:relative;cursor:pointer}
.accts .acct::before{content:"";position:absolute;left:-11px;top:9px;width:3px;height:20px;border-radius:2px;background:var(--ink)}
.snav{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:10px}
.head{display:flex;align-items:center;justify-content:space-between;height:36px;margin-bottom:4px;padding-left:10px}
.brand{display:inline-flex;color:var(--ink);border-radius:6px}
.colbtn{all:unset;box-sizing:border-box;display:grid;place-items:center;width:36px;height:36px;border-radius:9px;color:var(--muted);cursor:pointer}
.find{all:unset;box-sizing:border-box;display:flex;flex:none;align-items:center;gap:8px;height:38px;margin-bottom:6px;padding:0 10px;border-radius:10px;background:color-mix(in srgb,var(--ink) 7%,transparent);color:var(--muted);font:500 13.5px var(--body);cursor:pointer}
.find span{flex:1}
.find kbd{font:600 11px/1 var(--mono);padding:3px 5px;border-radius:5px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ink) 14%,transparent)}
.colbtn:hover,.find:hover{color:var(--ink)}
/* the groups scroll inside only when the window is shorter than the list */
.list{flex:1;min-height:0;display:flex;flex-direction:column;gap:2px;overflow-y:auto;scrollbar-width:none}
h6{margin:0;padding:12px 10px 5px;font:600 12px/1.2 var(--body);color:var(--muted)}
.ni{display:flex;flex:none;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:9px;color:var(--muted);font:600 14px var(--body);text-decoration:none;white-space:nowrap;transition:background-color .15s ease-out,color .15s ease-out}
.ni .icon{width:18px}
.ni:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}
.ni.on{background:color-mix(in srgb,var(--ink) 11%,transparent);color:var(--ink)}
.cnt{margin-left:auto;min-width:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--ink) 9%,transparent);color:var(--muted);font:600 11px/18px var(--mono);font-style:normal;text-align:center}
.cnt.hot{background:var(--ink);color:var(--bg)}
.side :deep(.up){margin:4px 0 0;justify-content:center}
.svc{display:flex;align-items:center;gap:8px;padding:8px 10px 2px;color:var(--muted);font:500 12.5px var(--body);white-space:nowrap}
.svc small{margin-left:auto;font:500 11.5px var(--mono)}
.dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--bad)}
.dot.ok{background:var(--on)}
.ni:focus-visible,.find:focus-visible,.colbtn:focus-visible,.brand:focus-visible,.acct:focus-visible,.alink:focus-visible{outline:2px solid var(--on);outline-offset:1px}

/* folded (Side.dc.html .crail): no panel, the page shows between and behind the icons */
.crail{--d:34px;--g:6px;--grp:8px;position:fixed;left:0;top:0;bottom:0;width:64px;z-index:50;display:flex;flex-direction:column;align-items:flex-start;gap:var(--g);padding:24px 0 22px 15px;pointer-events:none}
.ci{all:unset;position:relative;flex:none;width:var(--d);height:var(--d);cursor:pointer;pointer-events:auto}
.ci:hover,.ci:focus-visible{z-index:3}
/* a 40 px hit area round the 34 px circle */
.ci::before{content:"";position:absolute;inset:-3px}
.ci.gap{margin-top:var(--grp)}
.cap{position:absolute;left:0;top:0;display:flex;align-items:center;height:var(--d);min-width:var(--d);border-radius:999px;background:var(--glass);-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);box-shadow:inset 0 0 0 .75px var(--glass-b),inset 0 1px 0 var(--glass-hi),var(--glass-sh);color:var(--muted)}
.ci:hover .cap,.ci:focus-visible .cap,.ci.on .cap{color:var(--ink)}
.ci.on .cap{background:linear-gradient(color-mix(in srgb,var(--ink) 14%,transparent),color-mix(in srgb,var(--ink) 14%,transparent)),var(--glass)}
.ci:focus-visible .cap{outline:2px solid var(--on);outline-offset:4px}
.me .cap{background:var(--ink);color:var(--bg)!important;font:700 13.5px var(--body)}
.ic{position:relative;display:grid;place-items:center;flex:none;width:var(--d);height:var(--d)}
.lbl{display:flex;align-items:center;gap:8px;max-width:0;overflow:hidden;opacity:0;white-space:nowrap;font:600 13px/var(--d) var(--body);color:var(--ink);transition:max-width .55s cubic-bezier(.34,1.35,.5,1),padding .55s cubic-bezier(.34,1.35,.5,1),opacity .22s ease-out}
.me .lbl{color:var(--bg)}
.lbl .mono{display:inline-block;font:500 11px var(--mono);color:var(--muted);opacity:0;transform:translateY(9px);transition:transform .6s cubic-bezier(.34,1.5,.5,1) .08s,opacity .25s ease-out .08s}
.ci:hover .lbl,.ci:focus-visible .lbl{max-width:200px;padding-right:14px;opacity:1}
.ci:hover .mono,.ci:focus-visible .mono{opacity:1;transform:none}
.bdg{position:absolute;right:-5px;top:-4px;min-width:16px;padding:0 4px;border-radius:999px;background:var(--pend);box-shadow:0 0 0 2px var(--bg);color:#1a1200;font:700 10px/16px var(--mono);font-style:normal;text-align:center;z-index:1}
:global(:root[data-theme="light"] .crail .bdg){color:#fff}
.ring{position:absolute;left:-3px;top:-3px;overflow:visible;pointer-events:none}
.ring path{fill:none;stroke-width:2.5;stroke-linecap:round}
.ring .tk{stroke:color-mix(in srgb,var(--ink) 12%,transparent)}
.ring .vl{transition:stroke-dasharray .6s cubic-bezier(.34,1.35,.5,1),stroke .3s}
.csep{flex:none;width:18px;height:1.5px;border-radius:2px;margin:calc(var(--grp) / 2) calc((var(--d) - 18px) / 2);background:color-mix(in srgb,var(--ink) 20%,transparent)}
.cfoot{display:flex;flex-direction:column;align-items:center;gap:var(--g);width:var(--d);margin-top:auto;pointer-events:auto}
.cfoot :deep(.up){justify-content:center;width:var(--d);height:var(--d);min-height:0;padding:0}
.cfoot :deep(.up span){display:none}
.cdot{display:grid;place-items:center;width:var(--d);height:14px}

.amenu{position:fixed;z-index:60;min-width:230px;padding:6px;border-radius:14px;background-color:var(--panel)}
.arow{display:flex;align-items:center;gap:10px;padding:6px 8px;color:var(--ink)}
.arow .acct{width:30px;height:30px;border-radius:9px;font-size:13px}
.arow span{display:flex;flex-direction:column;flex:1;min-width:0}
.arow strong{font:600 13px var(--body)}
.arow small{color:var(--muted);font:500 11.5px var(--mono)}
.alink{display:flex;align-items:center;gap:10px;min-height:40px;padding:0 15px;border-radius:9px;color:var(--ink);font:600 13px var(--body);text-decoration:none}
.alink:hover{background:color-mix(in srgb,var(--ink) 7%,transparent)}
.am-enter-active,.am-leave-active{transition:opacity .14s ease-out,transform .18s cubic-bezier(.2,.8,.2,1)}
.am-enter-from,.am-leave-to{opacity:0;transform:translateX(-6px)}

@media (max-height:780px){.crail{--d:32px;--g:3px;--grp:5px;padding-top:10px}}
@media (max-height:660px){.crail{--d:28px;--g:2px;--grp:3px;padding-top:6px}}
/* shorter still: the column scrolls, wide enough that a grown pill is not clipped */
@media (max-height:560px){.crail{width:260px;overflow-y:auto;scrollbar-width:none}}
@media (max-width:760px){.side,.crail,.amenu{display:none}}
@media (prefers-reduced-motion:reduce){.lbl,.lbl .mono,.ring .vl{transition:none}.am-enter-active,.am-leave-active{transition:opacity .12s}.am-enter-from,.am-leave-to{transform:none}}
</style>

<style>
/* the width the sidebar takes, for fixed layers beside it */
:root{--side-w:304px}
:root[data-side="folded"]{--side-w:64px}
:root[data-side="none"]{--side-w:0px}

/* Fold and grow (sidebar.ts foldTransition): a view transition, so only transforms and opacity move. The page box takes
   its new size at once and slides from its old left edge while old and new cross-fade; the panel slides out left as the
   icons come in 35 ms apart, and back. */
html[data-side-anim="fold"]{--side-d:240px}
html[data-side-anim="grow"]{--side-d:-240px}
html[data-side-anim="fold"]{--side-full:240px}
html[data-side-anim="grow"]{--side-full:-240px}
/* the map is centred, so its picture moves half as far */
html[data-side-anim="fold"]:has(.shell .fm){--side-d:120px}
html[data-side-anim="grow"]:has(.shell .fm){--side-d:-120px}
html[data-side-anim] .shell > .body{view-transition-name:side-page}
html[data-side-anim] .side{view-transition-name:side-panel}
html[data-side-anim] .crail{view-transition-name:side-rail}
html[data-side-anim]::view-transition-old(root){display:none}
/* the browser copies the glass blur onto a picture's box, which stands still while the picture slides: off while it moves */
html[data-side-anim]::view-transition-group(*){backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
html[data-side-anim]::view-transition-new(root){animation:none}
html[data-side-anim]::view-transition-group(side-page),html[data-side-anim]::view-transition-group(side-panel),html[data-side-anim]::view-transition-group(side-rail){animation:none}
html[data-side-anim]::view-transition-old(side-page),html[data-side-anim]::view-transition-new(side-page){width:auto;height:auto}
/* both pictures move together: the old one leaves for the new place, the new one arrives from the old place. They add up
   (plus-lighter), so the cross-fade never dims the page half way. */
html[data-side-anim]::view-transition-image-pair(side-page){isolation:isolate}
html[data-side-anim]::view-transition-old(side-page),html[data-side-anim]::view-transition-new(side-page){mix-blend-mode:plus-lighter}
html[data-side-anim]::view-transition-old(side-page){animation:side-leave .45s cubic-bezier(.2,.8,.2,1) both,side-out .45s cubic-bezier(.2,.8,.2,1) both}
html[data-side-anim]::view-transition-new(side-page){animation:side-slide .45s cubic-bezier(.2,.8,.2,1) both,side-in .45s cubic-bezier(.2,.8,.2,1) both}
/* The 3D office never slides or cross-fades: two pictures of it do not line up. The live new one stands still and covers
   the old one, and the office moves its own camera from the old place (office.ts resize). The old picture only shows
   beside the new box (growing: the strip the arriving panel takes), where it fades out. There it follows the camera,
   so the two meet at the box edge: 143 px is the camera's way in .45 s (160 px, eased by 1 - e^-5t). */
html[data-side-anim]:has(.shell .o3)::view-transition-old(side-page){animation:side-out .45s cubic-bezier(.2,.8,.2,1) both;mix-blend-mode:normal}
html[data-side-anim]:has(.shell .o3)::view-transition-new(side-page){animation:none;mix-blend-mode:normal}
html[data-side-anim="grow"]:has(.shell .o3)::view-transition-old(side-page){animation:side-follow .45s linear(0,.247,.44,.59,.706,.797,.868,.923,.966,1) both,side-out .45s cubic-bezier(.2,.8,.2,1) both}
html[data-side-anim="fold"]::view-transition-old(side-panel){animation:side-away .45s cubic-bezier(.2,.8,.2,1) both}
html[data-side-anim="grow"]::view-transition-new(side-panel){animation:side-away .45s cubic-bezier(.2,.8,.2,1) reverse both}
html[data-side-anim="grow"]::view-transition-old(side-rail){animation:side-icon .25s cubic-bezier(.2,.8,.2,1) reverse both}
/* the arriving icons are live: each runs its own slide below */
html[data-side-anim="fold"]::view-transition-new(side-rail){animation:none}
html[data-side-anim="fold"] .crail > *{animation:side-icon .45s cubic-bezier(.2,.8,.2,1) both;animation-delay:calc(var(--i,0) * 35ms)}
/* the map's floating controls move on their own: the left ones travel the full width, the right ones stay put */
html[data-side-anim] .anv-h.ov > .anv-pill{view-transition-name:side-pill}
html[data-side-anim] .anv-h.ov > .anv-wait{view-transition-name:side-wait}
html[data-side-anim] .anv-h.ov > .seg[aria-label="View"]{view-transition-name:side-view}
html[data-side-anim] .anv-h.ov > .seg[aria-label="Map dimension"]{view-transition-name:side-dim}
html[data-side-anim] .anv-h.ov > .nt{view-transition-name:side-new}
html[data-side-anim] .anv-h.ov > .cl{view-transition-name:side-close}
html[data-side-anim] :is(.fm .fit,.o3-fit){view-transition-name:side-fit}
html[data-side-anim] .anv-h.ov > *,html[data-side-anim] :is(.fm .fit,.o3-fit){view-transition-class:side-ctl}
html[data-side-anim]::view-transition-group(*.side-ctl){animation-duration:.45s;animation-timing-function:cubic-bezier(.2,.8,.2,1)}
html[data-side-anim] .fm .fstrip{view-transition-name:side-strip}
html[data-side-anim]::view-transition-group(side-strip){animation:none}
html[data-side-anim]::view-transition-image-pair(side-strip){isolation:isolate}
html[data-side-anim]::view-transition-old(side-strip){--side-d:var(--side-full);width:auto;height:auto;mix-blend-mode:plus-lighter;animation:side-slide .45s cubic-bezier(.2,.8,.2,1) both,side-out .45s cubic-bezier(.2,.8,.2,1) both}
html[data-side-anim]::view-transition-new(side-strip){--side-d:var(--side-full);width:auto;height:auto;mix-blend-mode:plus-lighter;animation:side-slide .45s cubic-bezier(.2,.8,.2,1) both,side-in .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes side-slide{from{transform:translateX(var(--side-d))}to{transform:none}}
@keyframes side-leave{from{transform:none}to{transform:translateX(calc(-1 * var(--side-d)))}}
@keyframes side-out{from{opacity:1}to{opacity:0}}
@keyframes side-follow{from{transform:none}to{transform:translateX(143px)}}
@keyframes side-in{from{opacity:0}to{opacity:1}}
@keyframes side-away{from{transform:none;opacity:1}to{transform:translateX(-320px);opacity:.6}}
@keyframes side-icon{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:none}}
</style>
