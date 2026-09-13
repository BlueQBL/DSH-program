<script setup>
/**
 * 结局。
 * 摊牌：九个人的身份全部亮出来，让玩家回头对一遍自己这一晚的判断。
 */

import { ref, computed, watch } from 'vue'
import { useGame } from '../composables/useGame.js'
import { ROLE, ROLE_META, TEAM } from '../game/roles.js'

const { game, restart, toLobby } = useGame()

const dismissed = ref(false)
watch(() => game.value?.id, () => { dismissed.value = false })

const won = computed(() => game.value?.winner)

const headline = computed(() => (won.value === TEAM.WOLF ? '狼人胜利' : '好人胜利'))

const sub = computed(() => {
  const g = game.value
  if (!g) return ''
  const meP = g.players[g.humanId]
  const mine = meP.team === g.winner
  return mine ? '你站在赢的那一边。' : '你站错了边，下一个村子会更小心。'
})

const REASON_LABEL = {
  wolf: '被狼人杀害',
  poison: '被女巫毒杀',
  vote: '被投票放逐',
  hunter: '被猎人带走',
}

const rows = computed(() => {
  const g = game.value
  if (!g) return []
  return g.players.map((p) => ({
    ...p,
    meta: ROLE_META[p.role],
    ended: p.alive ? '存活' : `第 ${p.deathDay} 天 · ${REASON_LABEL[p.deathReason] || '出局'}`,
  }))
})

const stats = computed(() => {
  const g = game.value
  if (!g) return []
  return [
    { label: '熬过的天数', value: g.day },
    { label: '公开发言', value: g.speeches.length },
    { label: '投票轮次', value: g.voteHistory.length || g.day },
  ]
})
</script>

<template>
  <transition name="end">
    <div v-if="!dismissed" class="end">
      <div class="sheet cut" :class="won">
        <span class="mark">{{ won === TEAM.WOLF ? '狼' : '灯' }}</span>

        <p class="eyebrow">第 {{ game.day }} 天结束</p>
        <h2 class="headline">{{ headline }}</h2>
        <p class="reason">{{ game.winReason }}</p>
        <p class="sub">{{ sub }}</p>

        <div class="stats">
          <div v-for="s in stats" :key="s.label" class="stat">
            <span class="stat-v num">{{ s.value }}</span>
            <span class="stat-l">{{ s.label }}</span>
          </div>
        </div>

        <div class="roster">
          <div class="roster-head">
            <span>席位</span><span>身份</span><span>阵营</span><span>结局</span>
          </div>
          <div
            v-for="r in rows"
            :key="r.id"
            class="roster-row"
            :class="{ me: r.isHuman, dead: !r.alive, wolf: r.team === TEAM.WOLF }"
          >
            <span class="c-seat num">{{ r.seat + 1 }}</span>
            <span class="c-name">
              {{ r.isHuman ? '你' : r.name }}
              <em>{{ r.role === ROLE.SEER && r.claimsMade ? '·曾跳预言家' : '' }}</em>
            </span>
            <span class="c-role">{{ r.meta.name }}</span>
            <span class="c-end">{{ r.ended }}</span>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-primary" @click="restart">再来一局</button>
          <button class="btn btn-ghost" @click="dismissed = true">查看纪要</button>
          <button class="btn btn-ghost" @click="toLobby">换个身份</button>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.end {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 24px;
  background: radial-gradient(ellipse at 50% 45%, rgba(3, 6, 10, 0.82), rgba(3, 6, 10, 0.96));
  backdrop-filter: blur(5px);
  overflow-y: auto;
}

.sheet {
  width: min(600px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 34px 34px 26px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  border: 1px solid var(--line-strong);
  background: linear-gradient(180deg, rgba(20, 27, 37, 0.97), rgba(6, 10, 16, 0.99));
  box-shadow: var(--shadow-2);
  animation: rise 0.55s var(--ease-out) both;
}

.sheet.wolf { border-color: rgba(212, 69, 60, 0.4); }

@keyframes rise {
  from { opacity: 0; transform: translateY(18px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

.mark {
  font-family: var(--font-brush);
  font-size: 52px;
  line-height: 1;
  color: var(--brass-hi);
  margin-bottom: 10px;
  text-shadow: 0 0 44px rgba(201, 162, 39, 0.4);
}

.sheet.wolf .mark { color: var(--blood-hi); text-shadow: 0 0 44px rgba(212, 69, 60, 0.45); }

.headline {
  margin: 4px 0 8px;
  font-family: var(--font-brush);
  font-size: 46px;
  font-weight: 400;
  letter-spacing: 0.14em;
  color: var(--paper);
}

.reason { margin: 0; font-size: 13px; line-height: 1.8; color: var(--paper-2); }
.sub { margin: 8px 0 0; font-size: 11.5px; letter-spacing: 0.06em; color: var(--brass); }

.stats {
  display: flex;
  gap: 30px;
  margin: 22px 0 4px;
  padding: 14px 0;
  width: 100%;
  justify-content: center;
  border-top: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
}

.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.stat-v { font-size: 20px; color: var(--paper); }
.stat-l { font-size: 10px; letter-spacing: 0.16em; color: var(--paper-4); }

/* ─── 名单 ─── */

.roster { width: 100%; margin: 18px 0 4px; text-align: left; }

.roster-head,
.roster-row {
  display: grid;
  grid-template-columns: 42px 1fr 66px 1fr;
  gap: 8px;
  align-items: baseline;
  padding: 6px 4px;
}

.roster-head {
  font-size: 9.5px;
  letter-spacing: 0.2em;
  color: var(--paper-4);
  border-bottom: 1px solid var(--line-soft);
  padding-bottom: 7px;
}

.roster-row {
  font-size: 12px;
  border-bottom: 1px solid rgba(239, 230, 210, 0.04);
  color: var(--paper-2);
}

.roster-row.me { background: rgba(201, 162, 39, 0.08); }
.roster-row.wolf { border-left: 2px solid rgba(212, 69, 60, 0.45); padding-left: 6px; }
.roster-row.dead { opacity: 0.62; }

.c-seat { color: var(--brass); }
.c-name { color: var(--paper); }
.c-name em { font-style: normal; font-size: 10px; color: var(--paper-4); }
.c-role { color: var(--paper-2); letter-spacing: 0.1em; }
.c-end { font-size: 11px; color: var(--paper-4); }

/* ─── 操作 ─── */

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 22px;
}

.end-enter-active, .end-leave-active { transition: opacity 0.4s var(--ease); }
.end-enter-from, .end-leave-to { opacity: 0; }

@media (max-width: 700px) {
  .sheet { padding: 24px 18px 20px; }
  .headline { font-size: 32px; }
  .mark { font-size: 38px; }
  .roster-head, .roster-row { grid-template-columns: 30px 1fr 56px; }
  .roster-head span:last-child, .c-end { display: none; }
  .actions .btn { flex: 1; }
}
</style>
