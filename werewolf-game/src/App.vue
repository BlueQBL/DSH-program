<script setup>
/**
 * 舞台。
 *
 * 版面就是一张桌子：
 *   上面  天幕   —— 天色 = 阶段，亮着的窗 = 活着的人
 *   中间  圆桌   —— 九个席位，票型画成弧线
 *   右下  纪要   —— 这一晚的卷宗
 *   下面  行动坞 —— 我的手牌 + 此刻唯一要做的那件事
 */

import { computed, watch, onMounted } from 'vue'
import SkyCanopy from './components/SkyCanopy.vue'
import SeatRing from './components/SeatRing.vue'
import ActionDock from './components/ActionDock.vue'
import LogRail from './components/LogRail.vue'
import RevealOverlay from './components/RevealOverlay.vue'
import LobbyScreen from './components/LobbyScreen.vue'
import EndScreen from './components/EndScreen.vue'
import { useGame } from './composables/useGame.js'
import * as audio from './game/audio.js'

const { game, screen, skyTone } = useGame()

/* 天幕色调挂到根元素上，让整套令牌跟着昼夜走 */
watch(
  skyTone,
  (t) => {
    if (typeof document !== 'undefined') document.documentElement.dataset.tone = t
  },
  { immediate: true },
)

/* 键盘：空格暂停，方便看牌 */
function onKey(e) {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  // 浏览器要求一次用户手势才能起音频
  const unlock = () => { audio.unlock(); window.removeEventListener('pointerdown', unlock) }
  window.addEventListener('pointerdown', unlock, { once: true })
})

const playing = computed(() => screen.value === 'playing' || screen.value === 'over')
</script>

<template>
  <div class="app">
    <SkyCanopy />

    <LobbyScreen v-if="screen === 'lobby'" />

    <div v-else-if="playing" class="play">
      <main class="stage">
        <SeatRing />
      </main>
      <ActionDock class="dock" />
      <LogRail class="rail" />
    </div>

    <RevealOverlay />
    <EndScreen v-if="screen === 'over'" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background:
    radial-gradient(140% 80% at 50% 0%, rgba(24, 38, 52, 0.5), transparent 58%),
    var(--night-1000);
}

.play {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--rail-w);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "stage rail"
    "dock  rail";
}

.stage {
  grid-area: stage;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.dock { grid-area: dock; min-width: 0; }

.rail {
  grid-area: rail;
  min-height: 0;
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
  box-shadow: none;
  background: linear-gradient(180deg, rgba(12, 19, 27, 0.92), rgba(5, 9, 14, 0.96));
}

@media (max-width: 1080px) {
  .play {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(280px, 1fr) auto minmax(180px, 34vh);
    grid-template-areas:
      "stage"
      "dock"
      "rail";
  }

  .rail {
    border-left: none;
    border-top: 1px solid var(--line);
  }
}
</style>
