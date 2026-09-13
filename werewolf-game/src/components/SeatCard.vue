<script setup>
/**
 * 一张席位牌。
 * 木牌 + 火漆印的形制：活着的时候是暖色，出局之后整块木头褪成灰。
 */

import { computed } from 'vue'
import { useGame } from '../composables/useGame.js'
import { ROLE, ROLE_META } from '../game/roles.js'

const props = defineProps({
  player: { type: Object, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  speaker: Boolean,
  votable: Boolean,
  selectable: Boolean,
  dimmed: Boolean,
})

const emit = defineEmits(['pick'])

const { game, me, pending } = useGame()

const p = computed(() => props.player)

/* —— 公开信息标记 —— */
const seerClaim = computed(() =>
  game.value?.claims.find((c) => c.playerId === p.value.id && c.role === ROLE.SEER) || null)

const checkMark = computed(() => {
  const g = game.value
  if (!g) return null
  for (const c of g.claims) {
    for (const chk of c.checks) {
      if (chk.targetId === p.value.id) {
        return { result: chk.result, by: c.playerId }
      }
    }
  }
  return null
})

const isTeammate = computed(() =>
  p.value.role === ROLE.WOLF && me.value?.role === ROLE.WOLF && p.value.id !== me.value.id)

const votesAgainst = computed(() => {
  const g = game.value
  if (!g || g.phase !== 'vote') return 0
  return g.log.filter((e) => e.kind === 'vote' && e.day === g.day && e.targetId === p.value.id).length
})

const myVoteHere = computed(() => {
  const g = game.value
  if (!g || g.phase !== 'vote') return false
  return g.log.some((e) => e.kind === 'vote' && e.day === g.day && e.playerId === g.humanId && e.targetId === p.value.id)
})

const canClick = computed(() => props.selectable && !props.dimmed && p.value.alive)

/* —— 印章：手刻感的不规则圆环 —— */
const sealPath = computed(() => {
  const seed = p.value.hue * 13.7 + p.value.seat * 41
  const pts = []
  const n = 18
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const w = Math.sin(seed + i * 2.399) * 0.035 + Math.cos(seed * 1.7 + i) * 0.02
    const r = 21 * (1 + w)
    pts.push(`${(22 + Math.cos(a) * r).toFixed(2)},${(22 + Math.sin(a) * r).toFixed(2)}`)
  }
  return `M${pts.join('L')}Z`
})

const avatarStyle = computed(() => ({
  '--h': p.value.hue,
  background: p.value.alive
    ? `radial-gradient(circle at 34% 28%, hsl(${p.value.hue} 30% 30%), hsl(${p.value.hue} 26% 15%))`
    : 'radial-gradient(circle at 34% 28%, #1b2029, #0d1117)',
}))

function onClick() {
  if (!canClick.value) return
  emit('pick', p.value.id)
}
</script>

<template>
  <div
    class="seat"
    :class="{
      dead: !p.alive,
      human: p.isHuman,
      speaker,
      votable,
      selectable: canClick,
      dimmed,
      teammate: isTeammate,
    }"
    :style="{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }"
  >
    <button
      class="card cut-sm"
      :disabled="!canClick"
      :aria-label="`${p.seat + 1}号${p.name}${p.alive ? '' : '（已出局）'}`"
      @click="onClick"
    >
      <span class="no num">{{ p.seat + 1 }}</span>

      <span class="avatar" :style="avatarStyle">
        <svg class="ring" viewBox="0 0 44 44" aria-hidden="true">
          <path :d="sealPath" :class="p.alive ? 'stroke-alive' : 'stroke-dead'" />
        </svg>
        <span class="initial">{{ p.name.slice(0, 1) }}</span>
      </span>

      <span class="who">
        <span class="name">{{ p.isHuman ? '你' : p.name }}</span>
        <span class="epithet">{{ p.persona.epithet }}</span>
      </span>

      <span class="marks">
        <span v-if="isTeammate" class="tag tag-blood">同伴</span>
        <span v-if="seerClaim" class="tag tag-brass">预言家</span>
        <span v-if="checkMark && checkMark.result === ROLE.WOLF" class="tag tag-blood">查杀</span>
        <span v-else-if="checkMark" class="tag tag-moss">金水</span>
      </span>

      <span v-if="votesAgainst" class="votes num">{{ votesAgainst }}</span>
      <span v-if="myVoteHere" class="myvote">你的票</span>
    </button>

    <span v-if="!p.alive" class="seal" aria-hidden="true">
      <span class="seal-text">{{ p.deathReason === 'vote' ? '放逐' : '殁' }}</span>
    </span>

    <div v-if="speaker" class="speaking" aria-hidden="true">
      <i></i><i></i><i></i>
    </div>
  </div>
</template>

<style scoped>
.seat {
  position: absolute;
  left: 0;
  top: 0;
  width: 104px;
  will-change: transform;
  transition: opacity 0.4s var(--ease);
}

.card {
  position: relative;
  width: 104px;
  padding: 9px 8px 7px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  background:
    linear-gradient(180deg, rgba(36, 28, 20, 0.72), rgba(14, 18, 24, 0.9));
  box-shadow: var(--shadow-1);
  transition: border-color 0.2s var(--ease), background 0.2s var(--ease),
              box-shadow 0.25s var(--ease), transform 0.2s var(--ease-out);
}

.no {
  position: absolute;
  top: 3px;
  left: 6px;
  font-size: 10px;
  color: var(--paper-3);
  letter-spacing: 0.08em;
}

.avatar {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  overflow: visible;
}

.ring { position: absolute; inset: 0; width: 44px; height: 44px; }
.stroke-alive { fill: none; stroke: rgba(201, 162, 39, 0.5); stroke-width: 1.1; }
.stroke-dead { fill: none; stroke: rgba(120, 130, 148, 0.28); stroke-width: 1.1; }

.initial {
  position: relative;
  z-index: 1;
  font-family: var(--font-brush);
  font-size: 22px;
  line-height: 1;
  color: var(--paper);
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
}

.who { display: flex; flex-direction: column; align-items: center; line-height: 1.25; }

.name {
  font-size: 12.5px;
  letter-spacing: 0.06em;
  color: var(--paper);
}

.epithet {
  font-size: 9.5px;
  color: var(--paper-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 90px;
}

.marks {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 3px;
  min-height: 15px;
}

.marks .tag { font-size: 9px; padding: 0 4px; }

.votes {
  position: absolute;
  top: -8px;
  right: -8px;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--blood);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  box-shadow: 0 3px 10px rgba(155, 34, 38, 0.7);
  animation: pop 0.34s var(--ease-out) both;
}

@keyframes pop {
  from { transform: scale(0.3); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.myvote {
  position: absolute;
  bottom: -17px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--brass-hi);
  white-space: nowrap;
}

/* —— 状态 —— */

.human .card { border-color: rgba(201, 162, 39, 0.42); }
.human .name { color: var(--brass-hi); }

.teammate .card { box-shadow: 0 0 0 1px rgba(155, 34, 38, 0.45), var(--shadow-1); }

.speaker .card {
  border-color: var(--brass);
  background: linear-gradient(180deg, rgba(58, 46, 22, 0.85), rgba(20, 24, 30, 0.94));
  box-shadow: 0 0 0 1px rgba(201, 162, 39, 0.4), 0 0 34px rgba(201, 162, 39, 0.28), var(--shadow-1);
  transform: translateY(-3px);
}

.selectable .card { cursor: pointer; }
.selectable .card:hover {
  border-color: var(--brass-hi);
  transform: translateY(-4px);
  box-shadow: 0 0 0 1px rgba(242, 217, 121, 0.5), 0 10px 26px rgba(0, 0, 0, 0.6);
}

.votable .card { border-color: rgba(196, 60, 60, 0.5); }

.dimmed { opacity: 0.4; }
.dimmed .card { cursor: default; }

.dead .card {
  filter: grayscale(0.85);
  border-color: rgba(120, 130, 148, 0.16);
  background: linear-gradient(180deg, rgba(26, 30, 36, 0.7), rgba(11, 14, 19, 0.92));
}
.dead .name { color: var(--paper-4); text-decoration: line-through; text-decoration-color: rgba(212, 69, 60, 0.5); }
.dead .avatar { opacity: 0.5; }

/* —— 火漆印 —— */

.seal {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.seal-text {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: radial-gradient(circle at 36% 30%, #b3272b, #6d1417);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.14);
  color: #f3dede;
  font-family: var(--font-brush);
  font-size: 17px;
  line-height: 1;
  animation: seal-in 0.5s var(--ease-out) both;
  transform: rotate(-4deg);
}

/* —— 正在说话 —— */

.speaking {
  position: absolute;
  top: -13px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 3px;
}

.speaking i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--brass-hi);
  animation: pulse-soft 1.1s infinite;
}
.speaking i:nth-child(2) { animation-delay: 0.18s; }
.speaking i:nth-child(3) { animation-delay: 0.36s; }
</style>
