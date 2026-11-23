<script setup lang="ts">
/** Asks, in plain words. Three groups: what needs the owner's answer (questions agents asked, with their answer buttons, plus reports
 *  root has not answered), what the owner asked that an agent still works on, and what is done. List left, detail right.
 *  Each row says who asks, what they want in one sentence and since when; the detail says what every button does.
 *  The owner's own goals come from the asks ledger (SPEC-asks-ledger); questions and reports come from the live stream. */
import { computed, onMounted, onUnmounted, ref } from "vue";
import Icon from "../ui/Icon.vue";
import Skel from "../ui/Skel.vue";
import { api, toast } from "../ui/api";
import type { IconName } from "../ui/icons";
import { route } from "../router";
import { answerCheck, net, useAgentnet } from "../net";
import type { Check, Msg } from "../net";
import { markRead, waitingItems } from "../waiting";

interface Item { id: number; origin: "owner" | "brief"; text: string; agent: string | null; step_n: number | null; status: string; proof: string | null; mark: string | null; done_at: number | null; drop_reason: string | null }
interface Goal { id: number; source: string; msg_id: string; text: string; status: "open" | "doing" | "stuck" | "done"; created_at: number; updated_at: number; done_at: number | null; note: string | null; coverage: string[]; items: Item[]; links: { agent: string; how: string }[] }
/** One row of the list: a question an agent asked you, a report waiting for you, or something you asked for. */
interface Row { key: string; group: "answer" | "agent" | "done"; at: number; who: string; line: string; tag: string; check?: Check; msg?: Msg; goal?: Goal }

const stop = useAgentnet(); onUnmounted(stop);
const goals = ref<Goal[] | null>(null), on = ref(true), err = ref(""), picked = ref(""), phoneDetail = ref(false), missing = ref(""), note = ref(""), now = ref(Date.now());
async function load() {
  try { const r = await api<{ on: boolean; goals: Goal[] }>("v1/panel/goals"); goals.value = r.goals; on.value = r.on; err.value = ""; }
  catch (e) { err.value = (e as Error).message; goals.value = goals.value ?? []; }
  now.value = Date.now();
}
let t: ReturnType<typeof setInterval> | undefined;
onMounted(() => { const q = Number(route.value.query.goal); if (q) { picked.value = "g" + q; phoneDetail.value = true; } void load(); t = setInterval(load, 30_000); });
onUnmounted(() => clearInterval(t));

const GROUPS: { id: Row["group"]; title: string; hint: string; icon: IconName }[] = [
  { id: "answer", title: "Needs your answer", hint: "Questions from agents, and reports waiting to be read.", icon: "circle-arrow-up" },
  { id: "agent", title: "Waiting on an agent", hint: "You asked for this. An agent is on it.", icon: "loader" },
  { id: "done", title: "Done", hint: "Finished. Nothing to do.", icon: "circle-check" },
];
const STATUS: Record<Goal["status"], string> = { stuck: "Stuck", doing: "In work", open: "Not started", done: "Done" };
const STATUS_WORDS: Record<Goal["status"], string> = { stuck: "Stuck: an agent hit a block and needs help.", doing: "An agent is working on it.", open: "No agent has picked it up yet.", done: "Done." };
const ORDER: Record<Goal["status"], number> = { stuck: 0, doing: 1, open: 2, done: 3 };
const one = (s: string) => { const l = s.replace(/\s+/g, " ").trim(); return l.length > 140 ? l.slice(0, 139).trimEnd() + "…" : l; };

const rows = computed<Row[]>(() => {
  const out: Row[] = [];
  for (const w of [...waitingItems.value].sort((a, b) => Number(!!b.check) - Number(!!a.check))) { // questions first, then reports; each newest first
    if (w.check) out.push({ key: w.key, group: "answer", at: w.at, who: w.who, line: one(w.check.question), tag: "Question", check: w.check });
    else if (w.msg) out.push({ key: w.key, group: "answer", at: w.at, who: w.who, line: one(w.title), tag: "Report", msg: w.msg });
  }
  for (const g of [...(goals.value ?? [])].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.created_at - a.created_at)) {
    out.push({ key: "g" + g.id, group: g.status === "done" ? "done" : "agent", at: g.created_at, who: "You", line: one(g.text), tag: STATUS[g.status], goal: g });
  }
  return out;
});
const groups = computed(() => GROUPS.map((g) => ({ ...g, rows: rows.value.filter((r) => r.group === g.id) })).filter((g) => g.rows.length));
const cur = computed(() => rows.value.find((r) => r.key === picked.value) ?? (phoneDetail.value ? undefined : groups.value[0]?.rows[0]));
const pick = (k: string) => { picked.value = k; phoneDetail.value = true; missing.value = ""; note.value = ""; };
const live = (g: Goal) => g.items.filter((i) => i.status !== "dropped");
const count = (g: Goal) => `${live(g).filter((i) => i.status === "done").length} of ${live(g).length} steps done`;
const ago = (at: number) => { const m = Math.max(0, Math.round((Math.max(now.value, net.now) - at) / 60000)); return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const since = (at: number) => { const a = ago(at); return a === "just now" ? a : a + " ago"; };
const ITEM: Record<string, [IconName, string]> = { done: ["circle-check", "Done"], doing: ["loader", "In work"], open: ["circle", "No step yet"], dropped: ["minus", "Dropped"] };
/** Where the owner said it: the Telegram message number, or the clock time of a voice turn (its id is a long uuid). */
const from = (g: Goal) => /^\d+$/.test(g.msg_id) ? `${g.source} message ${g.msg_id}` : `${g.source} at ${new Date(g.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
const who = (i: Item) => i.agent ? `${i.agent}, step ${i.step_n}` : i.origin === "owner" ? "From your message" : "";

async function post(path: string, body: unknown, ok: string) {
  try { await api(path, { method: "POST", body }); toast(ok); await load(); } catch (e) { toast((e as Error).message); }
}
async function answer(c: Check, label: string) { const e = await answerCheck(c.id, label, note.value); note.value = ""; phoneDetail.value = false; picked.value = ""; toast(e || "Answered"); }
const done = (m: Msg) => { if (m.id != null) markRead(m.id); phoneDetail.value = false; picked.value = ""; };
const mark = (i: Item, m: string) => post(`v1/panel/items/${i.id}/mark`, { mark: m }, m === "clear" ? "Mark removed" : "Root is told");
const sendMissing = (g: Goal) => { if (missing.value.trim()) void post(`v1/panel/goals/${g.id}/missing`, { text: missing.value }, "Added, root is told").then(() => { missing.value = ""; }); };
const heart = (g: Goal) => post(`v1/panel/goals/${g.id}/heart`, {}, "Saved as liked");
const meta = computed(() => GROUPS.map((x) => `${rows.value.filter((r) => r.group === x.id).length} ${x.title.toLowerCase()}`).join(" · "));
</script>

<template>
  <div class="ak">
    <header class="ph"><h1>Asks</h1><span v-if="goals" class="meta">{{ meta }}</span></header>
    <p v-if="goals" class="lede">Questions agents have for you, and what you asked them to do.</p>
    <div v-if="!goals" class="wl"><div class="list pad"><Skel :lines="3" /><Skel :lines="3" /></div></div>
    <p v-else-if="!rows.length" class="empty">
      <template v-if="err">Could not load your requests: {{ err }}. <button type="button" class="lnk" @click="load">Try again</button></template>
      <template v-else-if="!on">Nothing needs you right now. Your own requests are not tracked here yet: the ledger is off on this server (it starts when owner-sources.json is set and AGENTNET_OWNER_ASKS=1).</template>
      <template v-else>Nothing needs you right now. Your next Telegram or voice request shows up here within a minute.</template>
    </p>
    <div v-else class="wl" :class="{ det: phoneDetail }">
      <nav class="list" aria-label="Asks">
        <section v-for="gr in groups" :key="gr.id">
          <h2 class="gh"><Icon :name="gr.icon" :size="15" />{{ gr.title }} <span class="mut num">{{ gr.rows.length }}</span></h2>
          <p class="gs">{{ gr.hint }}</p>
          <button v-for="r in gr.rows" :key="r.key" type="button" class="it" :class="[{ on: cur?.key === r.key }, r.goal?.status]" :aria-current="cur?.key === r.key" @click="pick(r.key)">
            <span class="top"><b>{{ r.check ? r.who + " asks" : r.msg ? r.who + " reported" : "You asked" }}</b><span class="sp" /><span class="mut num">{{ since(r.at) }}</span></span>
            <span class="t">{{ r.line }}</span>
            <span class="tag" :class="r.goal?.status ?? 'ask'">{{ r.tag }}</span>
          </button>
        </section>
      </nav>
      <section v-if="cur" class="dt" aria-live="polite">
        <button type="button" class="back" @click="phoneDetail = false"><Icon name="arrow-right" :size="16" style="transform:rotate(180deg)" /> Back</button>

        <template v-if="cur.check">
          <p class="kind"><Icon name="circle-arrow-up" :size="15" /> {{ cur.who }} asks you · {{ since(cur.at) }}</p>
          <blockquote class="quote">{{ cur.check.question }}</blockquote>
          <p v-if="cur.check.detail" class="more">{{ cur.check.detail }}</p>
          <input v-model="note" class="nt" type="text" placeholder="Add a note (optional)" aria-label="Note" />
          <div class="acts"><button v-for="o in cur.check.options" :key="o.label" type="button" class="btn" :class="o.tone" @click="answer(cur.check!, o.label)">{{ o.label }}</button></div>
          <ul class="what" aria-label="What each button does">
            <li v-for="o in cur.check.options" :key="o.label"><b>{{ o.label }}</b> sends this answer to {{ cur.who }} and closes the question.</li>
            <li>Your note, if you write one, goes with the answer.</li>
          </ul>
          <a class="btn ghost" :href="'#/agents?agent=' + encodeURIComponent(cur.who)">Open {{ cur.who }}</a>
        </template>

        <template v-else-if="cur.msg">
          <p class="kind"><Icon name="message" :size="15" /> Report from {{ cur.who }} · {{ since(cur.at) }}</p>
          <blockquote class="quote">{{ cur.line }}</blockquote>
          <p class="mut">{{ cur.who }} reported to root and root has not replied yet.</p>
          <div class="acts"><button type="button" class="btn pri" @click="done(cur.msg!)"><Icon name="check" :size="15" /> Mark as read</button><a class="btn ghost" :href="'#/agents?agent=' + encodeURIComponent(cur.who)">Open {{ cur.who }}</a></div>
          <ul class="what" aria-label="What each button does">
            <li><b>Mark as read</b> takes this report off the list on this device. Nothing is sent.</li>
            <li><b>Open {{ cur.who }}</b> shows that agent's page. Nothing is sent.</li>
          </ul>
          <p class="more">{{ cur.msg.body }}</p>
        </template>

        <template v-else-if="cur.goal">
          <p class="kind" :class="cur.goal.status"><Icon :name="cur.goal.status === 'done' ? 'circle-check' : cur.goal.status === 'stuck' ? 'triangle-alert' : cur.goal.status === 'doing' ? 'loader' : 'circle'" :size="15" /> {{ STATUS_WORDS[cur.goal.status] }}</p>
          <blockquote class="quote">{{ cur.goal.text }}</blockquote>
          <p class="mut">You asked this in {{ from(cur.goal) }}, {{ since(cur.goal.created_at) }}<template v-if="cur.goal.links.length"> · worked on by {{ cur.goal.links.map((l) => l.agent).join(", ") }}</template> · {{ count(cur.goal) }}</p>
          <div v-if="cur.goal.coverage.length" class="cov" role="note"><Icon name="triangle-alert" :size="16" /><span>No step covers: <b v-for="(w, i) in cur.goal.coverage" :key="w">{{ i ? ", " : "" }}"{{ w }}"</b>. Root was told.</span></div>
          <ul class="items" aria-label="Steps">
            <li v-for="i in cur.goal.items" :key="i.id" :class="i.status">
              <Icon class="si" :name="ITEM[i.status]?.[0] ?? 'circle'" :size="18" :label="ITEM[i.status]?.[1]" />
              <div class="ib">
                <span class="itx">{{ i.text }}</span>
                <span class="mut">{{ who(i) }}<template v-if="i.mark"> · you marked it {{ i.mark === "unwanted" ? "not wanted" : i.mark }}</template><template v-if="i.drop_reason"> · {{ i.drop_reason }}</template></span>
                <code v-if="i.proof" class="pf">{{ i.proof }}</code>
              </div>
              <div class="ia">
                <template v-if="!i.mark && i.status !== 'dropped'"><button type="button" class="sm" @click="mark(i, 'wrong')">Wrong</button><button type="button" class="sm" @click="mark(i, 'unwanted')">Not wanted</button></template>
                <button v-else-if="i.mark && i.mark !== 'missing'" type="button" class="sm" @click="mark(i, 'clear')">Undo</button>
              </div>
            </li>
            <li v-if="!cur.goal.items.length" class="none mut">No steps yet: no agent has picked this up.</li>
          </ul>
          <form class="miss" @submit.prevent="sendMissing(cur.goal)">
            <input v-model="missing" type="text" maxlength="200" placeholder="Something missing? Say what" aria-label="What is missing" />
            <button type="submit" class="btn" :disabled="!missing.trim()"><Icon name="plus" :size="15" /> Add</button>
          </form>
          <div class="acts"><button type="button" class="btn" :aria-pressed="!!cur.goal.note?.includes('♥')" @click="heart(cur.goal)"><Icon name="sparkles" :size="15" /> {{ cur.goal.note?.includes("♥") ? "Liked" : "I like this work" }}</button></div>
          <ul class="what" aria-label="What each button does">
            <li><b>Wrong</b> tells root this step is not right.</li>
            <li><b>Not wanted</b> tells root to drop this step.</li>
            <li><b>Add</b> tells root what is missing from this request.</li>
            <li><b>I like this work</b> saves a thumbs-up on this request.</li>
          </ul>
          <p v-if="cur.goal.note" class="mut nt">{{ cur.goal.note }}</p>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ak{display:flex;flex-direction:column;min-height:0;flex:1}
.ph{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}.ph h1{margin:0}
.meta,.mut{color:var(--muted);font-size:13px}
.empty{color:var(--muted);margin:24px 0}
.lede{margin:-6px 0 12px;color:var(--muted);font-size:14px}
.gs{margin:0;padding:0 20px 6px;color:var(--muted);font-size:12.5px;background:var(--panel)}
.tag{justify-self:start;padding:2px 8px;border-radius:999px;box-shadow:inset 0 0 0 1px var(--line);font:600 12px var(--body);color:var(--muted)}
.tag.stuck{color:var(--bad)}.tag.ask{color:var(--ink)}
.more{margin:0;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.nt{min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:500 14px var(--body)}
.what{margin:0;padding:12px 14px;list-style:none;display:grid;gap:6px;border-radius:12px;background:var(--panel-2);font-size:13px;color:var(--muted)}.what b{color:var(--ink)}
.btn.pri,.btn.good{background:var(--ink);color:var(--bg);box-shadow:none}.btn.bad{color:var(--bad)}
a.btn{text-decoration:none;justify-self:start}
.lnk{all:unset;color:var(--ink);text-decoration:underline;cursor:pointer}
.wl{display:grid;grid-template-columns:minmax(320px,440px) minmax(0,1fr);flex:1;min-height:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);overflow:hidden}
.list{overflow-y:auto;border-right:1px solid var(--line)}.pad{padding:20px;display:grid;gap:20px;align-content:start}
.gh{display:flex;align-items:center;gap:8px;margin:0;padding:14px 20px 6px;font:600 13px var(--body);color:var(--muted);position:sticky;top:0;background:var(--panel);z-index:1}
.it{all:unset;box-sizing:border-box;display:grid;gap:4px;width:100%;padding:12px 20px;border-bottom:1px solid var(--line);cursor:pointer}
.it.on{background:var(--track);box-shadow:inset 2px 0 0 var(--ink)}
.it.stuck .top b{color:var(--bad)}
.it:focus-visible{outline:2px solid var(--on);outline-offset:-2px}
.top{display:flex;align-items:center;gap:8px;font-size:13px}.sp{flex:1}
.t{font-size:14px;overflow-wrap:anywhere}
.dt{padding:24px 28px;display:grid;gap:14px;align-content:start;overflow-y:auto;min-width:0}
.kind{margin:0;display:flex;align-items:center;gap:6px;font:600 13px var(--body);color:var(--muted)}.kind.stuck{color:var(--bad)}
.quote{margin:0;padding:14px 16px;border-radius:12px;background:var(--panel-2);box-shadow:inset 0 0 0 1px var(--line);font:500 16px/1.45 var(--body);white-space:pre-wrap;overflow-wrap:anywhere}
.cov{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line);font-size:14px}
.items{list-style:none;margin:0;padding:0;display:grid;border-top:1px solid var(--line)}
.items li{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:10px;align-items:start;padding:12px 0;border-bottom:1px solid var(--line)}
.items li.none{display:block}
.items li.dropped .itx{text-decoration:line-through;color:var(--muted)}
.items li.done .si{color:var(--ink)}.items li:not(.done) .si{color:var(--muted)}
.ib{display:grid;gap:3px;min-width:0}.itx{font-size:14px;overflow-wrap:anywhere}
.pf{font:500 12px var(--mono, ui-monospace, monospace);overflow-wrap:anywhere;color:var(--ink)}
.ia{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.sm{all:unset;box-sizing:border-box;min-height:44px;padding:0 12px;border-radius:9px;box-shadow:inset 0 0 0 1px var(--line);font:600 13px var(--body);color:var(--muted);cursor:pointer;display:inline-flex;align-items:center}
.sm:hover{color:var(--ink)}
.miss{display:flex;gap:8px}
.miss input{flex:1;min-width:0;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);font:500 14px var(--body)}
.acts{display:flex;flex-wrap:wrap;gap:8px}
.btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 16px;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);font:600 14px var(--body);color:var(--ink);cursor:pointer}
.btn[aria-pressed=true]{background:var(--ink);color:var(--bg);box-shadow:none}
.btn:disabled{opacity:.5;cursor:default}
.btn:focus-visible,.sm:focus-visible{outline:2px solid var(--on);outline-offset:2px}
p.nt{margin:0;min-height:0;padding:0;border:0}
.back{display:none}
@media (max-width:760px){
  .wl{grid-template-columns:minmax(0,1fr)}
  .wl .dt{display:none}.wl.det .list{display:none}.wl.det .dt{display:grid;padding:16px}
  .back{all:unset;display:inline-flex;align-items:center;gap:6px;min-height:44px;color:var(--muted);font:600 14px var(--body);cursor:pointer}
  .list{border-right:0}
  .items li{grid-template-columns:24px minmax(0,1fr)}.ia{grid-column:2;justify-content:flex-start}
}
</style>
