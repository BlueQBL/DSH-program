<script setup>
/**
 * 纪要。
 * 一整局狼人杀本质上就是一份不断生长的卷宗：谁说了什么、谁投了谁、谁没起来。
 * 这里按时间顺序记录，并把"只有你能看见"的私密信息单独标出来。
 */

import { ref, computed, watch, nextTick } from 'vue'
import { useGame } from '../composables/useGame.js'
import { ROLE } from '../game/roles.js'

const { game, me } = useGame()

const onlySpeech = ref(false)
const scroller = ref(null)

const entries = computed(() => {
  const g = game.value
  if (!g) return []
  const all = g.log
  return onlySpeech.value ? all.filter((e) => e.kind === 'speech') : all
})

const claims = computed(() => {
  const g = game.value
  if (!g) return []
  return g.claims.map((c) => ({ ...c, player: g.players.find((p) => p.id === c.playerId) }))
})

const graves = computed(() => {
  const g = game.value
  if (!g) return []
  return g.players.filter((p) => !p.alive)
})

const toneOf = (p) => `hsl(${p?.hue ?? 200} 45% 58%)`

/* 新条目进来时贴到底部 */
watch(
  () => entries.value.length,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function jumpTo(playerId) {
  const el = scroller.value?.querySelector(`[data-p="${playerId}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
</script>

<template>
  <aside class="rail panel">
    <header class="panel-head">
      <span class="panel-title">纪要</span>
      <span class="head-right">
        <button class="chip" :class="{ on: onlySpeech }" @click="onlySpeech = !onlySpeech">
          {{ onlySpeech ? '只看发言' : '全部' }}
        </button>
      </span>
    </header>

    <!-- 场上明牌 -->
    <div v-if="claims.length || graves.length" class="dossier">
      <div v-if="claims.length" class="row">
        <span class="row-label">跳身份</span>
        <span class="row-body">
          <button
            v-for="c in claims"
            :key="c.playerId"
            class="pill brass"
            @click="jumpTo(c.playerId)"
          >
            <span class="num">{{ c.player.seat + 1 }}</span>{{ c.player.name }}·预言家
          </button>
        </span>
      </div>
      <div v-if="graves.length" class="row">
        <span class="row-label">已出局</span>
        <span class="row-body">
          <span v-for="p in graves" :key="p.id" class="pill blood">
            <span class="num">{{ p.seat + 1 }}</span>{{ p.name }}
          </span>
        </span>
      </div>
    </div>

    <!-- 卷宗 -->
    <div ref="scroller" class="stream">
      <template v-for="e in entries" :key="e.id">
        <div v-if="e.kind === 'phase'" class="phase-line">
          <span class="phase-rule"></span>
          <span class="phase-text">{{ e.text }}</span>
          <span class="phase-rule"></span>
        </div>

        <div
          v-else-if="e.kind === 'speech'"
          class="ev speech"
          :data-p="e.playerId"
          :class="{ mine: e.playerId === game.humanId }"
        >
          <span class="ev-dot" :style="{ background: toneOf(game.players.find((p) => p.id === e.playerId)) }"></span>
          <div class="ev-body">
            <span class="ev-who">
              {{ game.players.find((p) => p.id === e.playerId)?.isHuman ? '你' : `${game.players.find((p) => p.id === e.playerId)?.seat + 1}号${game.players.find((p) => p.id === e.playerId)?.name}` }}
            </span>
            <span class="ev-text">{{ e.text }}</span>
          </div>
        </div>

        <div v-else-if="e.kind === 'vote'" class="ev vote" :data-p="e.targetId ?? undefined">
          <span class="vote-tag">票</span>
          <span class="vote-text">
            {{ game.players.find((p) => p.id === e.playerId)?.isHuman ? '你' : `${game.players.find((p) => p.id === e.playerId)?.seat + 1}号` }}
            <em>→</em>
            {{ e.targetId == null ? '弃票' : `${game.players.find((p) => p.id === e.targetId)?.seat + 1}号${game.players.find((p) => p.id === e.targetId)?.name}` }}
          </span>
        </div>

        <div
          v-else-if="e.kind === 'death'"
          class="ev death"
          :data-p="e.playerId"
        >
          <span class="death-mark">✝</span>
          <span class="death-text">{{ e.text }}</span>
        </div>

        <div v-else-if="e.kind === 'result'" class="ev result">
          <span class="result-text">{{ e.text }}</span>
        </div>

        <div v-else-if="e.kind === 'night'" class="ev night" :class="{ secret: e.secret }">
          <span v-if="e.secret" class="tag tag-brass">密</span>
          <span class="night-text">{{ e.text }}</span>
        </div>

        <div v-else-if="e.kind === 'dawn'" class="ev dawn">
          <span class="dawn-text">{{ e.text }}</span>
        </div>

        <div v-else class="ev system">
          <span class="system-text">{{ e.text }}</span>
        </div>
      </template>

      <div v-if="!entries.length" class="empty">
        <p>牌还没发。</p>
        <p class="empty-sub">开一局，这里会长出一整晚的证词。</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.head-right { display: flex; gap: 6px; }

.chip {
  padding: 2px 9px;
  border: 1px solid var(--line-soft);
  border-radius: 2px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--paper-4);
  transition: all 0.16s var(--ease);
}
.chip:hover { color: var(--paper-2); border-color: var(--line); }
.chip.on { color: #17120a; background: var(--brass); border-color: var(--brass); }

/* ─── 案卷 ─── */

.dossier {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line-soft);
  background: rgba(0, 0, 0, 0.16);
}

.row { display: flex; gap: 8px; align-items: flex-start; }

.row-label {
  flex: none;
  width: 42px;
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--paper-4);
  padding-top: 2px;
}

.row-body { display: flex; flex-wrap: wrap; gap: 4px; }

.pill {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  padding: 1px 7px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 10.5px;
  opacity: 0.9;
}
.pill.brass { color: var(--brass-hi); background: rgba(201, 162, 39, 0.1); }
.pill.brass:hover { background: rgba(201, 162, 39, 0.22); }
.pill.blood { color: #cf8d88; background: rgba(155, 34, 38, 0.1); text-decoration: line-through; }

/* ─── 卷宗流 ─── */

.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.phase-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 13px 0 7px;
}

.phase-rule { flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--line)); }
.phase-line .phase-rule:last-child { background: linear-gradient(90deg, var(--line), transparent); }

.phase-text {
  font-family: var(--font-serif);
  font-size: 10.5px;
  letter-spacing: 0.2em;
  color: var(--brass);
  white-space: nowrap;
}

.ev { padding: 4px 0; animation: fade-up 0.34s var(--ease-out) both; }

/* 发言 */

.ev.speech { display: flex; gap: 8px; padding: 6px 0; }

.ev.speech.mine .ev-text { color: var(--paper); }
.ev.speech.mine .ev-who { color: var(--brass-hi); }

.ev-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; flex: none; }
.ev-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }

.ev-who { font-size: 10.5px; letter-spacing: 0.08em; color: var(--moon-hi); }

.ev-text {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--paper-2);
  word-break: break-word;
}

/* 投票 */

.ev.vote { display: flex; gap: 7px; align-items: baseline; font-size: 11px; }

.vote-tag {
  font-size: 9px;
  padding: 0 4px;
  border: 1px solid rgba(212, 69, 60, 0.4);
  border-radius: 2px;
  color: #b56a64;
  flex: none;
}

.vote-text { color: var(--paper-4); }
.vote-text em { font-style: normal; color: var(--blood-hi); margin: 0 2px; }

/* 死亡 */

.ev.death { display: flex; gap: 7px; align-items: baseline; padding: 7px 0; }

.death-mark { color: var(--blood-hi); font-size: 12px; }

.death-text {
  font-size: 12.5px;
  color: #e7a49d;
  letter-spacing: 0.04em;
}

/* 结果 */

.ev.result {
  margin: 5px 0;
  padding: 7px 10px;
  border-left: 2px solid var(--blood);
  background: rgba(155, 34, 38, 0.09);
}

.result-text { font-size: 12.5px; color: #efb3ad; line-height: 1.7; }

/* 夜间 */

.ev.night { display: flex; gap: 6px; align-items: baseline; }

.night-text { font-size: 11.5px; color: var(--moon); line-height: 1.7; opacity: 0.85; }

.ev.night.secret .night-text {
  color: var(--brass-hi);
  border-left: 1px dashed rgba(201, 162, 39, 0.35);
  padding-left: 8px;
}

/* 天亮 */

.ev.dawn {
  padding: 6px 10px;
  border-left: 2px solid rgba(235, 154, 92, 0.5);
  background: rgba(235, 154, 92, 0.06);
}

.dawn-text { font-size: 12px; color: #dfb08c; }

/* 系统 */

.system-text { font-size: 11px; color: var(--paper-4); line-height: 1.7; }

/* 空 */

.empty { margin: auto 0; text-align: center; color: var(--paper-4); }
.empty p { margin: 0; font-size: 12.5px; }
.empty-sub { margin-top: 4px !important; font-size: 11px !important; opacity: 0.7; }
</style>
