<script setup lang="ts">
// One bento tile. size: S 3x1 (one number), M 4x2, L 6x2, W 8x2, F 12x1 (full row), H 6x1 (hero). Grid CSS lives in tokens.css (.bento).
// headClick: the whole header is a click target (emits "head"); clicks on buttons inside it keep their own action.
withDefaults(defineProps<{ size?: "S" | "M" | "L" | "W" | "F" | "H"; title?: string; tall?: boolean; flat?: boolean; headClick?: boolean }>(), { size: "M" });
const emit = defineEmits<{ head: [] }>();
const onHead = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("button,a,input")) emit("head"); };
</script>

<template>
  <section :class="['bc', 'bc-' + size, { 'bc-tall': tall, 'bc-flat': flat }]" :aria-label="title">
    <header v-if="title || $slots.control" :class="['bc-h', { 'bc-hc': headClick }]" @click="headClick && onHead($event)">
      <h2>{{ title }}</h2>
      <div v-if="$slots.control" class="bc-c"><slot name="control" /></div>
    </header>
    <div class="bc-b"><slot /></div>
    <footer v-if="$slots.foot" class="bc-f"><slot name="foot" /></footer>
  </section>
</template>
