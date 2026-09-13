<script setup>
/**
 * 揭示卡：验人结果、用药结果这类"只有你知道"的瞬间，
 * 值得用一整块屏幕单独说一次。
 */

import { useGame } from '../composables/useGame.js'

const { reveal } = useGame()

const TONE = {
  blood: { a: '#d4453c', sigil: '狼' },
  moss: { a: '#86ba95', sigil: '善' },
  moon: { a: '#cfdff4', sigil: '验' },
  brass: { a: '#f2d979', sigil: '灯' },
}
</script>

<template>
  <transition name="veil">
    <div v-if="reveal" class="veil" role="status" aria-live="assertive">
      <div class="card cut" :style="{ '--a': (TONE[reveal.tone] || TONE.brass).a }">
        <span class="sigil">{{ (TONE[reveal.tone] || TONE.brass).sigil }}</span>
        <span class="subtitle">{{ reveal.subtitle }}</span>
        <span class="title">{{ reveal.title }}</span>
        <span class="hint">只有你能看见这一行</span>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.veil {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  background: radial-gradient(ellipse at 50% 50%, rgba(3, 6, 10, 0.72), rgba(3, 6, 10, 0.94));
  backdrop-filter: blur(3px);
  pointer-events: none;
}

.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 30px 54px 26px;
  border: 1px solid color-mix(in srgb, var(--a) 45%, transparent);
  background:
    radial-gradient(120% 130% at 50% 0%, color-mix(in srgb, var(--a) 14%, transparent), transparent 62%),
    linear-gradient(180deg, rgba(18, 26, 36, 0.96), rgba(6, 10, 16, 0.98));
  box-shadow: 0 0 90px color-mix(in srgb, var(--a) 22%, transparent), var(--shadow-2);
  animation: rise 0.5s var(--ease-out) both;
}

@keyframes rise {
  from { opacity: 0; transform: translateY(14px) scale(0.97); }
  to { opacity: 1; transform: none; }
}

.sigil {
  font-family: var(--font-brush);
  font-size: 40px;
  line-height: 1;
  color: var(--a);
  margin-bottom: 6px;
  text-shadow: 0 0 32px color-mix(in srgb, var(--a) 60%, transparent);
}

.subtitle {
  font-size: 10.5px;
  letter-spacing: 0.34em;
  text-indent: 0.34em;
  color: color-mix(in srgb, var(--a) 80%, #ffffff);
}

.title {
  font-family: var(--font-serif);
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--paper);
}

.hint {
  margin-top: 8px;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--paper-4);
}

.veil-enter-active, .veil-leave-active { transition: opacity 0.3s var(--ease); }
.veil-enter-from, .veil-leave-to { opacity: 0; }

@media (max-width: 700px) {
  .card { padding: 22px 26px; }
  .title { font-size: 20px; }
  .sigil { font-size: 30px; }
}
</style>
