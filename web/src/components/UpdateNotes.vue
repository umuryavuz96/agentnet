<script setup lang="ts">
// Release notes (GitHub Markdown) as plain nodes. ui/update.ts reads the text; this draws it. Never v-html.
import { computed } from "vue";
import { notes, type NoteBlock } from "../ui/update";

const props = defineProps<{ md: string }>();
type Group = { kind: "ul"; items: NoteBlock[] } | NoteBlock;
const groups = computed<Group[]>(() => {
  const out: Group[] = [];
  for (const b of notes(props.md)) {
    const last = out[out.length - 1];
    if (b.kind === "li") { if (last && last.kind === "ul") last.items.push(b); else out.push({ kind: "ul", items: [b] }); } else out.push(b);
  }
  return out;
});
const tag = (b: NoteBlock) => `h${Math.min(6, (b.level ?? 2) + 2)}`;
</script>

<template>
  <p v-if="!groups.length" class="un-meta">The release has no notes.</p>
  <template v-for="(g, i) in groups" :key="i">
    <ul v-if="g.kind === 'ul'" class="un-ul">
      <li v-for="(li, j) in g.items" :key="j"><template v-for="(x, k) in li.inline" :key="k"><b v-if="x.kind === 'b'">{{ x.text }}</b><em v-else-if="x.kind === 'em'">{{ x.text }}</em><code v-else-if="x.kind === 'code'">{{ x.text }}</code><a v-else-if="x.kind === 'a'" :href="x.href" target="_blank" rel="noopener noreferrer">{{ x.text }}</a><template v-else>{{ x.text }}</template></template></li>
    </ul>
    <component :is="g.kind === 'h' ? tag(g) : 'p'" v-else :class="g.kind === 'h' ? 'un-h' : 'un-p'"><template v-for="(x, k) in g.inline" :key="k"><b v-if="x.kind === 'b'">{{ x.text }}</b><em v-else-if="x.kind === 'em'">{{ x.text }}</em><code v-else-if="x.kind === 'code'">{{ x.text }}</code><a v-else-if="x.kind === 'a'" :href="x.href" target="_blank" rel="noopener noreferrer">{{ x.text }}</a><template v-else>{{ x.text }}</template></template></component>
  </template>
</template>

<style scoped>
.un-meta,.un-p{margin:0;font:400 13px/1.5 var(--body);overflow-wrap:anywhere}.un-meta{color:var(--muted)}
.un-ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font:400 13px/1.5 var(--body);overflow-wrap:anywhere}
.un-h{margin:6px 0 0;font:700 13px var(--body)}
code{padding:1px 5px;border-radius:5px;background:var(--track);font:500 12px var(--mono)}
a{color:var(--ink)}
</style>
