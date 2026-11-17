<script setup lang="ts">
/** Waiting for you (board page 01): owner checks and reports sent to root, list left, item right. Reports are "read" per device. */
import { computed, onUnmounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import { answerCheck, net, pendingChecks, useAgentnet } from "../net";
import type { Check, Msg } from "../net";
import { markRead, waitingItems as items } from "../waiting";
import { toast } from "../ui/api";

const stop = useAgentnet(); onUnmounted(stop);
const picked = ref("");
const cur = computed(() => items.value.find((i) => i.key === picked.value) ?? (phoneDetail.value ? undefined : items.value[0]));
const phoneDetail = ref(false);
const pick = (k: string) => { picked.value = k; phoneDetail.value = true; };
const ago = (t: number) => { const m = Math.max(0, Math.round((net.now - t) / 60000)); return m < 1 ? "now" : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
const note = ref("");
async function answer(c: Check, label: string) { const e = await answerCheck(c.id, label, note.value); note.value = ""; toast(e || "Answered"); }
const done = (m: Msg) => { if (m.id != null) markRead(m.id); phoneDetail.value = false; picked.value = ""; };
</script>

<template>
  <div class="wt">
    <header class="ph"><h1>Waiting for you</h1><span class="meta">{{ pendingChecks.length }} checks · {{ items.length - pendingChecks.length }} reports</span></header>
    <p v-if="!items.length" class="empty">Nothing is waiting for you.</p>
    <div v-else class="wl" :class="{ det: phoneDetail }">
      <ul class="list" aria-label="Waiting items">
        <li v-for="i in items" :key="i.key"><button type="button" class="it" :class="{ on: cur?.key === i.key }" @click="pick(i.key)">
          <span class="top"><Icon :name="i.kind === 'check' ? 'circle-arrow-up' : 'message'" :size="16" /><b>{{ i.who }}</b><span class="sp" /><span class="mut num">{{ ago(i.at) }}</span></span>
          <span class="t">{{ i.title }}</span>
        </button></li>
      </ul>
      <section v-if="cur" class="dt" aria-live="polite">
        <button type="button" class="back" @click="phoneDetail = false"><Icon name="arrow-right" :size="16" style="transform:rotate(180deg)" /> Back</button>
        <p class="kind">{{ cur.kind === "check" ? "Question for you" : "Report, not yet marked read" }}</p>
        <h2>{{ cur.title }}</h2>
        <p class="mut">{{ cur.who }} · {{ ago(cur.at) }} ago</p>
        <template v-if="cur.check">
          <p v-if="cur.check.detail" class="msg">{{ cur.check.detail }}</p>
          <input v-model="note" class="nt" type="text" placeholder="Add a note (optional)" aria-label="Note" />
          <div class="acts"><button v-for="o in cur.check.options" :key="o.label" type="button" class="btn" :class="o.tone" @click="answer(cur.check!, o.label)">{{ o.label }}</button><a class="btn ghost" :href="'#/agents?agent=' + encodeURIComponent(cur.who)">Open {{ cur.who }}</a></div>
        </template>
        <template v-else-if="cur.msg">
          <p class="msg">{{ cur.msg.body }}</p>
          <div class="acts"><button type="button" class="btn pri" @click="done(cur.msg!)"><Icon name="check" :size="15" /> Mark read</button><a class="btn ghost" :href="'#/agents?agent=' + encodeURIComponent(cur.who)">Open {{ cur.who }}</a></div>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.wt{display:flex;flex-direction:column;min-height:0;flex:1}
.ph{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}.ph h1{margin:0}
.meta,.mut{color:var(--muted);font-size:13px}
.empty{color:var(--muted);margin:24px 0}
.wl{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);flex:1;min-height:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.list{list-style:none;margin:0;padding:0;overflow-y:auto;border-right:1px solid var(--line)}
.it{all:unset;box-sizing:border-box;display:grid;gap:4px;width:100%;padding:14px 20px;border-bottom:1px solid var(--line);cursor:pointer}
.it.on{background:var(--track);box-shadow:inset 2px 0 0 var(--ink)}
.it:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.top{display:flex;align-items:center;gap:8px;font-size:13px}.sp{flex:1}
.t{font-size:14px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dt{padding:24px 28px;display:grid;gap:14px;align-content:start;overflow-y:auto;min-width:0}
.dt h2{margin:0;font:700 20px/1.25 var(--body);overflow-wrap:anywhere}
.kind{margin:0;font:600 13px var(--body);color:var(--muted)}
.msg{margin:0;padding:14px 16px;border-radius:12px;background:var(--panel-2);box-shadow:inset 0 0 0 1px var(--line);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.nt{min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:500 14px var(--body)}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 16px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);font:600 14px var(--body);color:var(--ink);cursor:pointer;text-decoration:none}
.btn.pri,.btn.good{background:var(--ink);color:var(--bg);box-shadow:none}
.btn.bad{color:var(--bad)}
.btn:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.back{display:none}
@media (max-width:760px){
  .wl{grid-template-columns:minmax(0,1fr)}
  .wl .dt{display:none}.wl.det .list{display:none}.wl.det .dt{display:grid;padding:16px}
  .back{all:unset;display:inline-flex;align-items:center;gap:6px;min-height:44px;color:var(--muted);font:600 14px var(--body);cursor:pointer}
  .list{border-right:0}
}
</style>
