<script setup lang="ts">
// "After adopt": one summary line, then stacked sections. Hooks and servers are grouped by repo and collapsed by default.
// Built live from the picks by afterPlan() in ../adopt, so a repo you leave on moves from "Switched off" to "Keeps running". Nothing here reads a file.
import { computed, reactive } from "vue";
import Icon from "../ui/Icon.vue";
import { afterPlan, midEllipsis, type AdoptReport, type AfterGroup, type Picks } from "../adopt";

const props = defineProps<{ report: AdoptReport; picks: Picks; base?: string }>();
const a = computed(() => afterPlan(props.report, props.picks, props.base));
const open = reactive<Record<string, boolean>>({});
const k = (sec: string, g: AfterGroup) => sec + ":" + g.key;
const toggle = (key: string) => (open[key] = !open[key]);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
</script>

<template>
  <section class="aa" aria-labelledby="aa-h">
    <h3 id="aa-h"><Icon name="network" :size="15" /> After adopt</h3>
    <p class="aa-sum" aria-live="polite">
      <span>Director: <b class="mono">{{ a.director.name }}</b></span>
      <i aria-hidden="true">·</i><span><b>{{ a.stayCount }}</b> keep running</span>
      <i aria-hidden="true">·</i><span><b>{{ a.offCount }}</b> switched off</span>
    </p>

    <div class="aa-sec">
      <h4>Your team</h4>
      <ul class="aa-rows">
        <li><b class="mono">{{ a.director.name }}</b><span>director<template v-if="a.director.model"> · {{ a.director.model }}</template></span></li>
        <li v-for="g in a.agents" :key="g.name"><b class="mono">{{ g.name }}</b><span>{{ g.role }} · {{ g.source }}</span></li>
      </ul>
      <p v-if="!a.agents.length" class="aa-none">No repo agents are added. The director can still start agents of its own.</p>
    </div>

    <div class="aa-sec off">
      <h4><Icon name="circle-x" :size="13" /> Switched off <small>backed up first, undo brings it back</small></h4>
      <p v-if="!a.off.length" class="aa-none">Nothing is switched off with your current choices.</p>
      <ul v-else class="aa-groups">
        <li v-for="g in a.off" :key="g.key" class="aa-g">
          <button type="button" class="aa-gh" :aria-expanded="!!open[k('off', g)]" @click="toggle(k('off', g))">
            <Icon name="chevron-down" :size="14" class="chev" />
            <b>{{ g.label }}</b><em>{{ plural(g.rows.length, "item") }}</em>
          </button>
          <div class="aa-x" :class="{ on: open[k('off', g)] }"><ul class="aa-items">
            <li v-for="(r, i) in g.rows" :key="i">
              <span class="nm">{{ r.name }}</span>
              <code v-if="r.where" class="wh" :title="r.full ?? r.where">{{ midEllipsis(r.where, 38) }}</code>
              <span v-if="r.note" class="nt">{{ r.note }}</span>
            </li>
          </ul></div>
        </li>
      </ul>
    </div>

    <div class="aa-sec stay">
      <h4><Icon name="check" :size="13" /> Keeps running</h4>
      <p v-if="!a.stay.length" class="aa-none">No hooks or servers are left running next to agentnet.</p>
      <ul v-else class="aa-groups">
        <li v-for="g in a.stay" :key="g.key" class="aa-g">
          <button type="button" class="aa-gh" :aria-expanded="!!open[k('stay', g)]" @click="toggle(k('stay', g))">
            <Icon name="chevron-down" :size="14" class="chev" />
            <b>{{ g.label }}</b><em>{{ plural(g.rows.length, "item") }}</em>
          </button>
          <div class="aa-x" :class="{ on: open[k('stay', g)] }"><ul class="aa-items">
            <li v-for="(r, i) in g.rows" :key="i">
              <span class="nm">{{ r.name }}</span>
              <code v-if="r.where" class="wh" :title="r.full ?? r.where">{{ midEllipsis(r.where, 38) }}</code>
              <span v-if="r.note" class="nt">{{ r.note }}</span>
            </li>
          </ul></div>
        </li>
      </ul>
      <ul class="aa-notes"><li v-for="t in a.notes" :key="t">{{ t }}</li></ul>
    </div>

    <p class="aa-msg"><Icon name="message" :size="14" /> <span><b>Messages:</b> {{ a.messaging }}</span></p>
  </section>
</template>

<style scoped>
.aa{display:grid;gap:12px;padding:14px;border:1px solid color-mix(in srgb,var(--on) 40%,var(--line));border-radius:14px;background:var(--panel);min-width:0}
.aa *{min-width:0}
.aa h3{display:flex;align-items:center;gap:6px;margin:0;font:650 14px var(--body);text-transform:none;letter-spacing:0;color:var(--ink)}
.aa-sum{display:flex;flex-wrap:wrap;gap:4px 10px;margin:0;padding:8px 12px;border-radius:10px;background:var(--track);font-size:13px}
.aa-sum i{font-style:normal;color:var(--muted)}
.aa-sum b{font-weight:650}
.aa-sec{display:grid;gap:6px;align-content:start}
.aa-sec h4{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:0;font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.aa-sec h4 small{font:400 12px var(--body);letter-spacing:0;text-transform:none}
.aa-sec.stay h4{color:color-mix(in srgb,var(--on) 70%,var(--ink))}
.aa-sec.off h4{color:var(--warn)}
.aa-rows,.aa-groups,.aa-items,.aa-notes{list-style:none;margin:0;padding:0}
.aa-rows{display:grid;gap:4px}
.aa-rows li{display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline;font-size:13px}
.aa-rows span{color:var(--muted);font-size:12.5px}
.aa-groups{display:grid;gap:6px}
.aa-g{border:1px solid var(--line);border-radius:12px;background:var(--track);overflow:hidden}
.aa-gh{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:0 12px;border:0;background:none;color:var(--ink);font:500 13px var(--body);text-align:left;cursor:pointer}
.aa-gh b{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aa-gh em{flex:none;font-style:normal;color:var(--muted);font-size:12px}
.aa-gh:hover{background:color-mix(in srgb,var(--ink) 5%,transparent)}
.aa-gh .chev{flex:none;transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.aa-gh[aria-expanded="false"] .chev{transform:rotate(-90deg)}
.aa-x{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1)}
.aa-x.on{grid-template-rows:1fr}
.aa-items{overflow:hidden;display:grid;gap:8px;visibility:hidden;transition:visibility 0s .28s}
.aa-x.on .aa-items{visibility:visible;transition-delay:0s;padding:2px 12px 12px 34px}
.aa-items li{display:grid;gap:1px;font-size:12.5px;line-height:1.4}
.aa-items .nm{font-weight:600;overflow-wrap:anywhere}
.aa-items .wh{font:11.5px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:help}
.aa-items .nt{color:var(--muted);font-size:12px}
.aa-notes{display:grid;gap:2px;color:var(--muted);font-size:12px}
.mono{font-family:var(--mono)}
.aa-none{margin:0;color:var(--muted);font-size:12.5px}
.aa-msg{display:flex;gap:8px;align-items:flex-start;margin:0;font-size:12.5px;line-height:1.45}
.aa-msg svg{flex:none;margin-top:2px}
.aa-gh:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
@media (prefers-reduced-motion:reduce){.aa-x,.aa-gh .chev{transition:none}}
</style>
