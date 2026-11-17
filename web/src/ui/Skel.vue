<script setup lang="ts">
// Shared loading placeholder (board page 14): grey bars where text will land, so a card never flashes empty. Opacity pulse only; still under Reduce Motion.
defineProps<{ lines?: number }>();
</script>

<template>
  <div class="sk" role="status" aria-label="Loading"><i v-for="n in lines ?? 2" :key="n" :style="{ width: n === (lines ?? 2) && n > 1 ? '60%' : '100%' }" /></div>
</template>

<style scoped>
.sk{display:grid;gap:8px}
.sk i{display:block;height:12px;border-radius:6px;background:var(--track);animation:skp 1.4s ease-in-out infinite}
@keyframes skp{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.sk i{animation:none}}
</style>
