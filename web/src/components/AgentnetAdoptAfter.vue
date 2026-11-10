<script setup lang="ts">
// "After adopt": the team and what keeps running once the choices are applied (spec 7.4/7.5). Built live from the picks by
// afterAdopt() in ../adopt; the server may send report.after, which then wins. Nothing here reads a file.
import { computed } from "vue";
import Icon from "../ui/Icon.vue";
import { afterAdopt, type AdoptReport, type Picks } from "../adopt";

const props = defineProps<{ report: AdoptReport; picks: Picks; base?: string }>();
const a = computed(() => afterAdopt(props.report, props.picks, props.base));
const kind = (k: string) => (k === "hook" ? "hook" : k === "mcp-server" ? "MCP server" : k === "coordination-system" ? "message system" : k === "workspace-instructions" ? "instructions" : k === "agent-definitions" ? "agents" : k === "identity-claim" ? "identity" : k);
</script>

<template>
  <section class="aa" aria-labelledby="aa-h">
    <h3 id="aa-h"><Icon name="network" :size="15" /> After adopt</h3>
    <div class="aa-grid">
      <div class="aa-col team">
        <h4>Your team</h4>
        <ul>
          <li><b class="mono">{{ a.director.name }}</b><span>director<template v-if="a.director.model"> · {{ a.director.model }}</template></span></li>
          <li v-for="g in a.agents" :key="g.name"><b class="mono">{{ g.name }}</b><span>{{ g.role }} · {{ g.source }}</span></li>
        </ul>
        <p v-if="!a.agents.length" class="aa-none">No agents from your repo are added. The director can still start agents of its own.</p>
      </div>
      <div class="aa-col stay">
        <h4><Icon name="check" :size="13" /> Keeps running</h4>
        <ul>
          <li v-for="(s, i) in a.stay" :key="i"><b>{{ s.label }}</b><span>{{ kind(s.kind) }}<template v-if="s.file"> · <code>{{ s.file }}</code></template></span></li>
          <li v-for="t in a.instructions" :key="t" class="plain">{{ t }}</li>
        </ul>
      </div>
      <div class="aa-col off">
        <h4><Icon name="circle-x" :size="13" /> Switched off (backed up)</h4>
        <ul v-if="a.off.length">
          <li v-for="(s, i) in a.off" :key="i"><b>{{ s.label }}</b><span>{{ kind(s.kind) }}<template v-if="s.file"> · <code>{{ s.file }}</code></template></span></li>
        </ul>
        <p v-else class="aa-none">Nothing is switched off with your current choices.</p>
      </div>
    </div>
    <p class="aa-msg"><Icon name="message" :size="14" /> <span><b>Messages:</b> {{ a.messaging }}</span></p>
  </section>
</template>

<style scoped>
.aa{display:grid;gap:10px;padding:12px;border:1px solid color-mix(in srgb,var(--on) 40%,var(--line));border-radius:14px;background:var(--panel);min-width:0}
.aa *{min-width:0}
.aa h3{display:flex;align-items:center;gap:6px;margin:0;font:650 14px var(--body);text-transform:none;letter-spacing:0;color:var(--ink)}
.aa-grid{display:grid;gap:10px;grid-template-columns:1fr}
@media (min-width:900px){.aa-grid{grid-template-columns:repeat(3,1fr)}}
.aa-col{display:grid;gap:6px;align-content:start;padding:10px;border-radius:12px;background:var(--track)}
.aa-col h4{display:flex;align-items:center;gap:6px;margin:0;font:600 11px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.aa-col.stay h4{color:color-mix(in srgb,var(--on) 70%,var(--ink))}
.aa-col.off h4{color:var(--warn)}
.aa ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.aa li{display:grid;gap:1px;font-size:12.5px;line-height:1.4}
.aa li b{font-weight:600;word-break:break-word}
.aa li span{color:var(--muted);font-size:12px;word-break:break-word}
.aa li.plain{color:var(--muted);font-size:12px}
.aa code{font:11.5px var(--mono)}
.mono{font-family:var(--mono)}
.aa-none{margin:0;color:var(--muted);font-size:12px}
.aa-msg{display:flex;gap:8px;align-items:flex-start;margin:0;font-size:12.5px;line-height:1.45}
.aa-msg svg{flex:none;margin-top:2px}
</style>
