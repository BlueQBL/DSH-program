import { ref, watch, onBeforeUnmount } from 'vue'

/**
 * 逐字显现。速度自适应：长句更快，短句从容。
 * 尊重 prefers-reduced-motion —— 那种情况下直接全量显示。
 */
export function useTypewriter(source, { base = 34, min = 14, max = 62 } = {}) {
  const shown = ref('')
  const done = ref(false)
  let timer = null

  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
  }

  function run(text) {
    stop()
    if (!text) { shown.value = ''; done.value = true; return }
    if (reduced) { shown.value = text; done.value = true; return }

    const step = Math.max(min, Math.min(max, Math.round(1400 / Math.max(6, text.length))))
    let i = 0
    shown.value = ''
    done.value = false
    timer = setInterval(() => {
      i += 1
      shown.value = text.slice(0, i)
      if (i >= text.length) { stop(); done.value = true }
    }, step)
  }

  watch(source, (t) => run(t), { immediate: true })
  onBeforeUnmount(stop)

  return { shown, done }
}
