<script setup>
/**
 * 桌心。
 * 发言时这里是字幕，等待时这里是局势提示。
 */

import { computed } from 'vue'
import { useGame } from '../composables/useGame.js'
import { useTypewriter } from '../composables/useTypewriter.js'
import { ROLE } from '../game/roles.js'

const { game, pending, me, aliveCount } = useGame()

const speakerId = computed(() => game.value?.currentSpeech?.playerId ?? null)
const rawText = computed(() => game.value?.currentSpeech?.text ?? '')
const { shown, done } = useTypewriter(rawText)

const speaker = computed(() => {
  const g = game.value
  if (!g || speakerId.value == null) return null
  return g.players.find((p) => p.id === speakerId.value)
})

const quiet = computed(() => !rawText.value)

/** 安静的时候，说一句应景的话 */
const hint = computed(() => {
  const g = game.value
  if (!g) return { text: '', note: '' }
  if (g.phase === 'over') return { text: g.winReason, note: '本局结束' }

  if (g.phase === 'night') {
    if (g.nightStep === 'wolf') {
      return me.value?.role === ROLE.WOLF
        ? { text: '同伴在等你定刀口。', note: '狼人行动' }
        : { text: '狼人正在睁眼，商量今晚要杀谁。', note: '狼人行动' }
    }
    if (g.nightStep === 'seer') {
      return me.value?.role === ROLE.SEER
        ? { text: '挑一个你最想看清的人。', note: '预言家行动' }
        : { text: '预言家正在查验一个人。', note: '预言家行动' }
    }
    if (g.nightStep === 'witch') {
      return { text: '女巫手上还有药。', note: '女巫行动' }
    }
    return { text: '所有人闭眼。村子安静得能听见风。', note: `第 ${g.day} 夜` }
  }
  if (g.phase === 'dawn') return { text: '天亮了。先看看昨晚谁没能起来。', note: '天亮' }
  if (g.phase === 'day') return { text: '按顺序发言。听清楚谁在保谁，谁在推谁。', note: '白天发言' }
  if (g.phase === 'vote') return { text: '投票放逐。多数票出局，平票则谁也不走。', note: '投票' }
  return { text: '', note: '' }
})

const tally = computed(() => {
  const g = game.value
  if (!g || g.phase !== 'vote' || !g.lastTally) return []
  return g.lastTally.map((t) => ({
    ...t,
    player: g.players.find((p) => p.id === t.playerId),
  }))
})
</script>

<template>
  <div class="hub">
    <transition name="swap" mode="out-in">
      <div v-if="!quiet" key="speech" class="speech">
        <div class="line">
          <span class="dot" :style="{ background: `hsl(${speaker?.hue} 45% 55%)` }"></span>
          <span class="who">{{ speaker?.isHuman ? '你' : `${speaker?.seat + 1}号${speaker?.name}` }}</span>
          <span class="role-note">{{ speaker?.isHuman ? '' : speaker?.persona?.epithet }}</span>
        </div>
        <p class="text">
          {{ shown }}<span v-if="!done" class="caret"></span>
        </p>
      </div>

      <div v-else key="hint" class="hint">
        <div class="eyebrow hint-note">{{ hint.note }}</div>
        <p class="hint-text">{{ hint.text }}</p>
        <div v-if="tally.length" class="tally">
          <span v-for="t in tally" :key="t.playerId" class="tally-item">
            <span class="num">{{ t.player?.seat + 1 }}</span>
            <span class="num tally-n">{{ t.count }}</span>
          </span>
        </div>
        <div v-else-if="pending" class="waiting">
          <i></i><i></i><i></i>
          <span>等你决定</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.hub {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(46%, 470px);
  min-height: 128px;
  display: grid;
  place-items: center;
  padding: 18px 26px;
  text-align: center;
  pointer-events: none;
  z-index: 2;
}

.speech { animation: fade-up 0.35s var(--ease-out) both; }

.line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-bottom: 8px;
}

.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }

.who {
  font-family: var(--font-serif);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--brass-hi);
}

.role-note { font-size: 10.5px; color: var(--paper-4); }

.text {
  margin: 0;
  font-size: 15.5px;
  line-height: 1.85;
  color: var(--paper);
  letter-spacing: 0.02em;
}

.caret {
  display: inline-block;
  width: 7px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -0.16em;
  background: var(--brass);
  animation: pulse-soft 0.9s steps(2) infinite;
}

.hint-note { margin-bottom: 6px; color: rgba(201, 162, 39, 0.6); }

.hint-text {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.8;
  color: var(--paper-2);
}

.tally {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.tally-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 2px;
  background: rgba(155, 34, 38, 0.12);
  color: var(--paper-2);
  font-size: 11px;
}

.tally-n { color: var(--blood-hi); font-weight: 700; }

.waiting {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--brass);
}

.waiting i {
  width: 3px; height: 3px; border-radius: 50%;
  background: var(--brass);
  animation: pulse-soft 1s infinite;
}
.waiting i:nth-child(2) { animation-delay: 0.15s; }
.waiting i:nth-child(3) { animation-delay: 0.3s; margin-right: 2px; }

.swap-enter-active, .swap-leave-active { transition: opacity 0.22s var(--ease); }
.swap-enter-from, .swap-leave-to { opacity: 0; }

@media (max-width: 1080px) {
  .hub { width: 74%; padding: 12px 14px; min-height: 96px; }
  .text { font-size: 13.5px; line-height: 1.7; }
  .hint-text { font-size: 12.5px; }
}
</style>
