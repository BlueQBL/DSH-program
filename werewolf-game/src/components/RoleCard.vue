<script setup>
/**
 * 我的手牌。
 * 是一张实物：木纹底、火漆印、可以翻面看牌背（牌背写着你的私密情报）。
 */

import { ref, computed } from 'vue'
import { useGame } from '../composables/useGame.js'
import { ROLE, ROLE_META, TEAM } from '../game/roles.js'

const { game, me, myRoleMeta, myTeammates } = useGame()
const flipped = ref(false)

const meta = computed(() => myRoleMeta.value)

const tone = computed(() => {
  const t = meta.value?.tone
  return {
    blood: { a: '#d4453c', b: 'rgba(155,34,38,0.5)' },
    moss: { a: '#86ba95', b: 'rgba(79,122,91,0.5)' },
    moon: { a: '#cfdff4', b: 'rgba(143,168,200,0.5)' },
    brass: { a: '#f2d979', b: 'rgba(201,162,39,0.5)' },
    candle: { a: '#efe6d2', b: 'rgba(194,181,155,0.45)' },
  }[t] || { a: '#f2d979', b: 'rgba(201,162,39,0.5)' }
})

const checks = computed(() => (me.value?.checks || []).slice().reverse())

const teammates = computed(() => myTeammates.value)

const isDead = computed(() => me.value && !me.value.alive)
</script>

<template>
  <div v-if="meta" class="hand" :class="{ flipped, dead: isDead }">
    <button class="flip" :aria-pressed="flipped" :aria-label="flipped ? '看牌面' : '看牌背'" @click="flipped = !flipped">
      <span class="inner">
        <!-- 牌面 -->
        <span class="face front cut-sm" :style="{ '--accent': tone.a, '--accent-dim': tone.b }">
          <span class="corner tl num">{{ me.seat + 1 }}</span>
          <span class="corner br num">{{ me.seat + 1 }}</span>
          <span class="sigil">
            <svg viewBox="0 0 68 68" aria-hidden="true"><circle cx="34" cy="34" r="30" /></svg>
            <span class="sigil-ch">{{ meta.sigil }}</span>
          </span>
          <span class="role-name">{{ meta.name }}</span>
          <span class="team" :class="meta.team === TEAM.WOLF ? 'is-wolf' : 'is-good'">
            {{ meta.team === TEAM.WOLF ? '狼人阵营' : '好人阵营' }}
          </span>
        </span>

        <!-- 牌背 -->
        <span class="face back cut-sm">
          <span class="back-title">{{ meta.name }} · 须知</span>
          <span class="back-line">{{ meta.brief }}</span>
          <span class="back-win">胜利条件：{{ meta.win }}</span>

          <span v-if="teammates.length" class="intel">
            <span class="intel-label">同伴</span>
            <span class="intel-value">
              {{ teammates.map((t) => `${t.seat + 1}号${t.name}${t.alive ? '' : '（已出局）'}`).join('、') }}
            </span>
          </span>

          <span v-if="checks.length" class="intel">
            <span class="intel-label">已验</span>
            <span class="intel-value">
              <span v-for="c in checks" :key="c.targetId" class="verdict">
                <span class="num">{{ game.players.find((p) => p.id === c.targetId)?.seat + 1 }}</span>
                <em :class="c.result === ROLE.WOLF ? 'w' : 'g'">{{ c.result === ROLE.WOLF ? '狼' : '好' }}</em>
              </span>
            </span>
          </span>

          <span v-if="me.role === ROLE.WITCH" class="intel">
            <span class="intel-label">药</span>
            <span class="intel-value potions">
              <em :class="me.antidote ? 'on' : 'off'">解药{{ me.antidote ? '在' : '已用' }}</em>
              <em :class="me.poison ? 'on' : 'off'">毒药{{ me.poison ? '在' : '已用' }}</em>
            </span>
          </span>
        </span>
      </span>
    </button>

    <span class="flip-hint">翻面</span>
    <span v-if="isDead" class="dead-seal"><span>你已出局</span></span>
  </div>
</template>

<style scoped>
.hand {
  position: relative;
  width: 158px;
  height: 176px;
  flex: none;
  perspective: 900px;
}

.flip {
  width: 100%;
  height: 100%;
  display: block;
  text-align: left;
}

.inner {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  transition: transform 0.62s var(--ease-out);
}

.flipped .inner { transform: rotateY(180deg); }

.face {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  overflow: hidden;
}

/* —— 牌面 —— */

.front {
  justify-content: center;
  gap: 6px;
  padding: 14px 12px;
  border: 1px solid var(--accent-dim);
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(56, 43, 30, 0.85), rgba(12, 17, 23, 0.96)),
    var(--wood-700);
  box-shadow: inset 0 1px 0 rgba(239, 230, 210, 0.08), var(--shadow-1);
}

.corner {
  position: absolute;
  font-size: 11px;
  color: var(--accent);
  opacity: 0.7;
}
.tl { top: 7px; left: 9px; }
.br { bottom: 7px; right: 9px; transform: rotate(180deg); }

.sigil {
  position: relative;
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
}

.sigil svg { position: absolute; inset: 0; width: 64px; height: 64px; }
.sigil circle {
  fill: rgba(0, 0, 0, 0.28);
  stroke: var(--accent-dim);
  stroke-width: 1.2;
  stroke-dasharray: 4 3;
}

.sigil-ch {
  position: relative;
  font-family: var(--font-brush);
  font-size: 36px;
  line-height: 1;
  color: var(--accent);
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 50%, transparent);
}

.role-name {
  font-family: var(--font-serif);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.24em;
  text-indent: 0.24em;
  color: var(--paper);
}

.team {
  font-size: 10px;
  letter-spacing: 0.2em;
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.is-wolf { color: #e0716a; }
.is-good { color: #8fc4a0; }

/* —— 牌背 —— */

.back {
  transform: rotateY(180deg);
  gap: 6px;
  padding: 13px 12px;
  border: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(30, 34, 40, 0.96), rgba(10, 14, 19, 0.98));
  box-shadow: var(--shadow-1);
  overflow-y: auto;
}

.back-title {
  font-family: var(--font-serif);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--brass);
}

.back-line {
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--paper-2);
}

.back-win {
  font-size: 10px;
  line-height: 1.6;
  color: var(--paper-3);
  padding-top: 5px;
  border-top: 1px solid var(--line-soft);
}

.intel {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 5px;
  border-top: 1px solid var(--line-soft);
}

.intel-label {
  font-size: 9px;
  letter-spacing: 0.2em;
  color: var(--paper-4);
}

.intel-value { font-size: 10.5px; line-height: 1.6; color: var(--paper-2); }

.verdict { display: inline-flex; align-items: baseline; gap: 1px; margin-right: 6px; }
.verdict em { font-style: normal; font-size: 9.5px; margin-left: 1px; }
.verdict .w { color: var(--blood-hi); }
.verdict .g { color: var(--moss-hi); }

.potions { display: flex; gap: 6px; }
.potions em { font-style: normal; padding: 0 5px; border: 1px solid currentColor; border-radius: 2px; font-size: 10px; }
.potions .on { color: var(--moss-hi); }
.potions .off { color: var(--paper-4); text-decoration: line-through; }

/* —— 其他 —— */

.flip-hint {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--paper-4);
  pointer-events: none;
}

.dead-seal {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  background: rgba(4, 7, 12, 0.62);
}

.dead-seal span {
  padding: 5px 14px;
  border: 1.5px solid rgba(212, 69, 60, 0.7);
  border-radius: 2px;
  color: #e58b84;
  font-family: var(--font-brush);
  font-size: 17px;
  letter-spacing: 0.14em;
  transform: rotate(-5deg);
  animation: seal-in 0.6s var(--ease-out) both;
}

.hand:hover .flip-hint { color: var(--brass); }

@media (max-width: 1080px) {
  .hand { width: 118px; height: 148px; }
  .sigil, .sigil svg { width: 50px; height: 50px; }
  .sigil-ch { font-size: 28px; }
  .role-name { font-size: 16px; }
  .back { font-size: 9px; }
}
</style>
