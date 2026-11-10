<script setup lang="ts">
// Step 4b of the adopt flow: the saved plan (spec 7.5). One row per changed file with a real diff behind it, the files that
// are created, the backup and undo command. Apply is bound to plan.planId on the server; a global file needs its own checkbox.
import { computed, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { toast } from "../ui/api";
import { changedOps, diffStat, opLabel, parseDiff, planHasGlobal, planSummary, shortPath, type AdoptPlan, type Finding } from "../adopt";

const props = defineProps<{ plan: AdoptPlan; findings: Finding[]; busy?: boolean; error?: string; base?: string }>();
const emit = defineEmits<{ apply: [confirmGlobal: boolean]; back: [] }>();

const changed = computed(() => changedOps(props.plan));
const created = computed(() => props.plan.ops.filter((o) => o.create?.length));
const hasGlobal = computed(() => planHasGlobal(props.plan));
const confirmGlobal = ref(false);
const open = ref<Record<number, boolean>>({});
const sp = (p: string) => shortPath(p, props.base);
const canApply = computed(() => !props.busy && (!hasGlobal.value || confirmGlobal.value));
const title = (op: string) => (op === "register-souls" ? "Workspace souls" : op === "write-director-prompt" ? "Director prompt" : op);
async function copy() { try { await navigator.clipboard.writeText(props.plan.rollbackCommand.replace(/\s+run-[\w-]+$/, "")); toast("Copied"); } catch { toast("Copy failed"); } }
</script>

<template>
  <div class="ap">
    <p class="ap-sum">{{ planSummary(plan) }} Nothing is written until you press Apply.</p>
    <p v-if="error" class="ap-err" role="alert">{{ error }}</p>

    <section v-if="changed.length" aria-labelledby="ap-ch">
      <h3 id="ap-ch">Changes</h3>
      <ul class="ap-files">
        <li v-for="(o, i) in changed" :key="o.id ?? i" class="ap-file" :class="{ glob: o.global }">
          <button type="button" class="ap-row" :aria-expanded="!!open[i]" :aria-controls="'diff-' + i" @click="open[i] = !open[i]">
            <code class="ap-path">{{ sp(o.file!) }}</code>
            <span v-if="o.global" class="ap-g">Global</span>
            <span class="ap-lab">{{ opLabel(o, findings) }}</span>
            <span class="ap-stat num"><b class="a">+{{ diffStat(o.diff).add }}</b> <b class="d">-{{ diffStat(o.diff).del }}</b></span>
            <Icon name="chevron-down" :size="15" class="chev" />
          </button>
          <div :id="'diff-' + i" class="ap-x" :class="{ on: open[i] }"><div class="ap-in">
            <pre class="ap-diff" tabindex="0" :aria-label="'Diff of ' + o.file"><span v-for="(l, j) in parseDiff(o.diff)" :key="j" :class="l.t">{{ l.s || " " }}
</span></pre>
          </div></div>
        </li>
      </ul>
    </section>

    <section v-if="created.length" aria-labelledby="ap-new">
      <h3 id="ap-new">New files <span>nothing existing is changed</span></h3>
      <ul class="ap-new">
        <li v-for="(o, i) in created" :key="i">
          <b>{{ title(o.op) }}</b>
          <code v-for="c in o.create" :key="c">{{ c.split("/").pop() }}</code>
          <p v-if="o.preview" class="ap-prev">{{ o.preview }}</p>
        </li>
      </ul>
    </section>

    <section class="ap-safe" aria-labelledby="ap-sf">
      <h3 id="ap-sf"><Icon name="shield-check" :size="15" /> Safety</h3>
      <p>Backup first: <code>{{ plan.backupDir }}</code></p>
      <div class="ap-undo"><span>Undo any time</span><code>agentnet adopt rollback</code><button type="button" class="ap-cp" aria-label="Copy rollback command" @click="copy"><Icon name="copy" :size="14" /> Copy</button></div>
      <p class="ap-never">Never touched: .env files, keys, processes, cron, launchd, git.</p>
    </section>

    <p v-for="w in plan.warnings" :key="w" class="ap-warn"><Icon name="triangle-alert" :size="14" /> {{ w }}</p>
    <button v-if="hasGlobal" type="button" role="checkbox" class="ap-ck" :aria-checked="confirmGlobal" @click="confirmGlobal = !confirmGlobal">
      <i class="box"><Icon v-if="confirmGlobal" name="check" :size="13" /></i> I understand a global file (~/.claude) changes for all my Claude Code sessions
    </button>

    <div class="ap-foot">
      <button type="button" class="ap-b ghost" :disabled="busy" @click="emit('back')">Back to findings</button>
      <button type="button" class="ap-b" :disabled="!canApply" @click="emit('apply', confirmGlobal)">{{ busy ? "Applying…" : "Apply and continue" }}</button>
    </div>
  </div>
</template>

<style scoped>
.ap{display:grid;gap:14px;min-width:0}
.ap *{min-width:0}
.ap-sum{margin:0;font-size:13.5px;line-height:1.45}
.ap-err{margin:0;padding:8px 12px;border-radius:10px;background:var(--bad-bg);color:var(--bad);font:600 13px var(--body)}
.ap h3{display:flex;align-items:center;gap:6px;margin:0 0 6px;color:var(--muted);font:600 11px/1.2 var(--body);letter-spacing:.06em;text-transform:uppercase}
.ap h3 span{text-transform:none;letter-spacing:0;font-weight:500}
.ap-files,.ap-new{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.ap-file{border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.ap-file.glob{border-color:color-mix(in srgb,var(--bad) 55%,var(--line))}
.ap-row{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 12px;border:0;border-radius:12px;background:none;color:var(--ink);font:inherit;text-align:left;cursor:pointer}
.ap-path{flex:1;font:500 12.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-g{flex:none;padding:1px 8px;border-radius:999px;background:var(--bad-bg);color:var(--bad);font:600 11px var(--body)}
.ap-lab{flex:none;color:var(--muted);font:500 12.5px var(--body)}
.ap-stat{flex:none;font-size:12px}.ap-stat .a{color:var(--on)}.ap-stat .d{color:var(--bad)}
.ap-row .chev{flex:none;color:var(--muted);transition:transform .28s cubic-bezier(.2,.8,.2,1)}
.ap-row[aria-expanded="true"] .chev{transform:rotate(180deg)}
.ap-x{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.2,.8,.2,1)}
.ap-x.on{grid-template-rows:1fr}
.ap-in{overflow:hidden;visibility:hidden;transition:visibility 0s .28s}
.ap-x.on .ap-in{visibility:visible;transition-delay:0s}
.ap-diff{margin:0 8px 8px;padding:8px 0;max-height:280px;overflow:auto;border-radius:10px;background:var(--track);font:12px/1.5 var(--mono)}
.ap-diff span{display:block;width:max-content;min-width:100%;padding:0 10px;white-space:pre}
.ap-diff .add{background:var(--on-bg);color:color-mix(in srgb,var(--on) 60%,var(--ink))}
.ap-diff .del{background:var(--bad-bg);color:color-mix(in srgb,var(--bad) 60%,var(--ink))}
.ap-diff .hunk{color:var(--lock)}
.ap-diff .meta{color:var(--muted)}
.ap-new li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;border:1px solid var(--line);border-radius:12px;font-size:13px}
.ap-new code{padding:1px 8px;border-radius:8px;background:var(--track);font:12px var(--mono)}
.ap-prev{flex-basis:100%;margin:2px 0 0;color:var(--muted);font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}
.ap-safe{display:grid;gap:6px;padding:12px;border:1px solid color-mix(in srgb,var(--on) 35%,var(--line));border-radius:14px;background:var(--panel-2)}
.ap-safe p{margin:0;font-size:13px}
.ap-safe code,.ap-undo code{font:12px var(--mono);word-break:break-all}
.ap-undo{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ap-undo span{font-size:13px}
.ap-never{color:var(--muted)}
.ap-cp{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ap-warn{display:flex;gap:6px;align-items:center;margin:0;color:var(--warn);font:600 12.5px var(--body)}
.ap-ck{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 4px;border:0;border-radius:10px;background:none;color:var(--ink);font:500 13px var(--body);text-align:left;cursor:pointer}
.box{flex:none;display:grid;place-items:center;width:20px;height:20px;border:1.5px solid var(--muted);border-radius:6px;font-style:normal}
.ap-ck[aria-checked="true"] .box{background:var(--on);border-color:var(--on);color:#06210f}
.ap-foot{display:flex;justify-content:space-between;gap:10px;position:sticky;bottom:0;margin:0 -12px;padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px));background:var(--panel-2);border-top:1px solid var(--line)}
.ap-b{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border:0;border-radius:12px;background:var(--on);color:#06210f;font:600 13.5px/1 var(--body);cursor:pointer}
.ap-b:disabled{opacity:.35;cursor:default}
.ap-b.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
.ap-row:focus-visible,.ap-cp:focus-visible,.ap-ck:focus-visible,.ap-b:focus-visible,.ap-diff:focus-visible{outline:2px solid var(--on);outline-offset:1px}
@media (max-width:640px){.ap-lab{display:none}.ap-foot .ap-b:not(.ghost){flex:1}}
@media (max-width:380px){.ap-foot{flex-direction:column-reverse}.ap-b{white-space:nowrap}}

:global(:root[data-theme="light"] .ap-b:not(.ghost)){color:#fff}
:global(:root[data-theme="light"] .ap-ck[aria-checked="true"] .box){color:#fff}
@media (prefers-reduced-motion:reduce){.ap-x,.ap-row .chev{transition:none}}
</style>
