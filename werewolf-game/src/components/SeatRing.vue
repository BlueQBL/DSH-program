<script setup>
/**
 * 圆桌。九个席位按等角分布在椭圆上，人类固定在正下方。
 * 投票时，票会画成弧线从投票人飞向他投的人——一局狼人杀的票型，
 * 天生就是一张图，没必要用表格去表达。
 */

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import SeatCard from './SeatCard.vue'
import TableHub from './TableHub.vue'
import { useGame } from '../composables/useGame.js'
import { ROLE } from '../game/roles.js'

const { game, pending, pick, me } = useGame()

const el = ref(null)
const box = ref({ w: 1100, h: 520 })
let ro = null
let raf = 0

const CARD_W = 104
const CARD_H = 118

function measure() {
  if (!el.value) return
  const r = el.value.getBoundingClientRect()
  box.value = { w: Math.max(360, r.width), h: Math.max(280, r.height) }
}

const layout = computed(() => {
  const { w, h } = box.value
  const rx = Math.max(120, Math.min(w * 0.5 - CARD_W * 0.72, 368))
  const ry = Math.max(84, Math.min(h * 0.5 - CARD_H * 0.72, 166))
  const cx = w / 2
  const cy = h / 2
  const seats = (game.value?.players || []).map((p, i) => {
    const a = ((90 + i * 40) * Math.PI) / 180
    return { p, x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), angle: a }
  })
  return { rx, ry, cx, cy, seats }
})

/* —— 可选目标 —— */
const candidates = computed(() => {
  const c = pending.value?.candidates
  return c ? new Set(c) : null
})

function selectable(id) {
  const g = game.value
  const p = g?.players.find((x) => x.id === id)
  if (!p?.alive) return false
  if (!pending.value) return false
  if (pending.value.kind === 'vote') {
    return id !== g.humanId
  }
  return candidates.value ? candidates.value.has(id) : false
}

function dimmed(id) {
  if (!pending.value) return false
  if (pending.value.kind === 'vote') return id === game.value.humanId
  return !candidates.value?.has(id) || !game.value.players.find((x) => x.id === id)?.alive
}

/* —— 票型弧线 —— */
const arrows = computed(() => {
  const g = game.value
  if (!g || g.phase !== 'vote') return []
  const pos = Object.fromEntries(layout.value.seats.map((s) => [s.p.id, s]))
  const out = []
  let i = 0
  for (const e of g.log) {
    if (e.kind !== 'vote' || e.day !== g.day || e.targetId == null) continue
    const a = pos[e.playerId]
    const b = pos[e.targetId]
    if (!a || !b || e.playerId === e.targetId) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.hypot(dx, dy) || 1
    const off = CARD_W * 0.5 + 4
    const sx = a.x + (dx / d) * off
    const sy = a.y + (dy / d) * off
    const ex = b.x - (dx / d) * (off - 6)
    const ey = b.y - (dy / d) * (off - 6)
    const nx = -dy / d
    const ny = dx / d
    const bow = d * 0.13
    const qx = (sx + ex) / 2 + nx * bow
    const qy = (sy + ey) / 2 + ny * bow
    out.push({
      key: `${e.playerId}-${e.targetId}-${i++}`,
      d: `M${sx.toFixed(1)},${sy.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`,
    })
  }
  return out
})

const tableStyle = computed(() => {
  const { rx, ry } = layout.value
  return {
    width: `${(rx + CARD_W * 0.62) * 2}px`,
    height: `${(ry + CARD_H * 0.6) * 2}px`,
  }
})

onMounted(() => {
  measure()
  ro = new ResizeObserver(measure)
  ro.observe(el.value)
  window.addEventListener('resize', measure)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <div ref="el" class="ring">
    <!-- 桌面 -->
    <div class="table" :style="tableStyle" aria-hidden="true">
      <div class="table-inner"></div>
      <div class="table-rim"></div>
    </div>

    <!-- 票型弧线 -->
    <svg class="arrows" :viewBox="`0 0 ${box.w} ${box.h}`" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill="rgba(212,69,60,0.85)" />
        </marker>
      </defs>
      <path
        v-for="a in arrows"
        :key="a.key"
        :d="a.d"
        class="arrow"
        pathLength="1"
        marker-end="url(#ah)"
      />
    </svg>

    <!-- 席位 -->
    <SeatCard
      v-for="s in layout.seats"
      :key="s.p.id"
      :player="s.p"
      :x="s.x"
      :y="s.y"
      :speaker="game?.turn === s.p.id"
      :votable="game?.phase === 'vote' && s.p.alive"
      :selectable="selectable(s.p.id)"
      :dimmed="dimmed(s.p.id)"
      @pick="pick"
    />

    <TableHub />
  </div>
</template>

<style scoped>
.ring {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 300px;
}

.table {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  pointer-events: none;
}

.table-inner {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background:
    radial-gradient(ellipse at 50% 42%, rgba(38, 52, 66, 0.55) 0%, rgba(16, 26, 37, 0.5) 46%, rgba(6, 11, 18, 0) 71%);
}

.table-rim {
  position: absolute;
  inset: 4%;
  border-radius: 50%;
  border: 1px solid rgba(201, 162, 39, 0.09);
  box-shadow: inset 0 0 90px rgba(0, 0, 0, 0.5);
}

/* 桌面上的木纹刻痕：一圈虚线，像桌子被刻了一圈刀口 */
.table-rim::after {
  content: "";
  position: absolute;
  inset: 6%;
  border-radius: 50%;
  border: 1px dashed rgba(201, 162, 39, 0.08);
}

.arrows {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
  overflow: visible;
}

.arrow {
  fill: none;
  stroke: rgba(212, 69, 60, 0.72);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw 0.55s var(--ease-out) forwards;
}

@keyframes draw {
  to { stroke-dashoffset: 0; }
}
</style>
