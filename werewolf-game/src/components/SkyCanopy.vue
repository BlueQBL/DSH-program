<script setup>
/**
 * 天幕
 *
 * 这是整页的签名元素，也是唯一的"装饰性"投入：
 * 一片真实绘制的夜空压在村庄屋脊之上。
 * 它同时是三个东西——
 *   1. 阶段指示器：天色的冷暖告诉你现在是夜、是拂晓还是白天；
 *   2. 人口计：村里每一扇亮着的窗，就是还活着的一名玩家；
 *   3. 情绪发生器：狼人睁眼时天最黑，天亮时屋脊后透出一线暖光。
 */

import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useGame } from '../composables/useGame.js'

const { game, skyTone } = useGame()

const canvas = ref(null)
const wrap = ref(null)

const lit = computed(() => (game.value ? game.value.players.filter((p) => p.alive).length : 9))
const total = computed(() => (game.value ? game.value.players.length : 9))

const nightIndex = computed(() => {
  const g = game.value
  if (!g) return 1
  if (g.phase === 'night') return g.day
  return Math.max(1, g.day - 1)
})

/* ---------------- 天色调色板 ---------------- */

const SKY = {
  dusk:  { top: [14, 20, 36], mid: [26, 28, 45], bot: [62, 44, 44], star: 0.45, moon: 0.85, glow: null },
  night: { top: [4, 8, 16], mid: [8, 14, 26], bot: [18, 27, 40], star: 1, moon: 1, glow: null },
  deep:  { top: [2, 5, 11], mid: [4, 9, 18], bot: [11, 18, 30], star: 1.25, moon: 1.1, glow: null },
  dawn:  { top: [18, 25, 48], mid: [58, 50, 66], bot: [168, 108, 74], star: 0.3, moon: 0.4, glow: [235, 154, 92] },
  day:   { top: [40, 62, 90], mid: [76, 105, 132], bot: [176, 152, 108], star: 0, moon: 0, glow: [246, 208, 148] },
  blood: { top: [10, 6, 10], mid: [32, 10, 14], bot: [86, 22, 22], star: 0.7, moon: 0.5, glow: [192, 64, 58] },
}

/* ---------------- 静态村落（按种子生成一次） ---------------- */

function makeHouses(seed) {
  let s = seed >>> 0 || 1
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const houses = []
  let x = -40
  let i = 0
  while (x < 1500) {
    const w = 54 + rnd() * 62
    const h = 30 + rnd() * 34
    houses.push({ id: i++, x, w, h, peak: rnd() < 0.75, chimney: rnd() < 0.35, tree: 0 })
    x += w + 4 + rnd() * 12
    if (rnd() < 0.22) { houses.push({ id: i++, x, w: 16, h: 44, tree: 1, peak: false }); x += 22 }
  }
  // 一座钟楼，压住节奏
  houses.push({ id: i++, x: 470, w: 26, h: 74, peak: true, chimney: false, tree: 0, steeple: true })
  return houses
}

/** 挑出 9 座"有窗"的房子，尽量均匀分布 */
function pickWindowHouses(houses, count) {
  const sorted = houses.filter((h) => !h.tree).sort((a, b) => a.x - b.x)
  const picks = []
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i + 0.5) * (sorted.length / count))
    picks.push(sorted[Math.min(sorted.length - 1, idx)])
  }
  return picks
}

/* ---------------- 绘制 ---------------- */

let ctx = null
let dpr = 1
let W = 0, H = 0
let raf = 0
let houses = []
let windowHouses = []
let stars = []
let t0 = performance.now()
let lastFrame = 0
let reduced = false
let ro = null

function onResize() { resize() }

function resize() {
  const el = wrap.value
  const cv = canvas.value
  if (!el || !cv) return
  const rect = el.getBoundingClientRect()
  dpr = Math.min(2, window.devicePixelRatio || 1)
  W = Math.max(320, Math.round(rect.width))
  H = Math.max(96, Math.round(rect.height))
  cv.width = Math.round(W * dpr)
  cv.height = Math.round(H * dpr)
  cv.style.width = W + 'px'
  cv.style.height = H + 'px'
  ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  houses = makeHouses(20240917)
  windowHouses = pickWindowHouses(houses, 9)

  stars = Array.from({ length: 86 }, (_, i) => {
    const r = ((i * 9301 + 49297) % 233280) / 233280
    const r2 = ((i * 4523 + 12345) % 199999) / 199999
    const r3 = ((i * 7919 + 104729) % 31337) / 31337
    return { x: r * W, y: r2 * H * 0.72, r: 0.5 + r3 * 1.15, a: 0.28 + r3 * 0.7, ph: r3 * 6.28, sp: 0.06 + r2 * 0.22 }
  })
}

const lerp = (a, b, t) => a + (b - a) * t
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`

function draw(now) {
  if (!ctx) return
  const time = (now - t0) / 1000
  const p = SKY[skyTone.value] || SKY.night

  /* 1 · 天空渐变 */
  const g = ctx.createLinearGradient(0, 0, 0, H)
  g.addColorStop(0, rgb(p.top))
  g.addColorStop(0.55, rgb(p.mid))
  g.addColorStop(1, rgb(p.bot))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)

  /* 2 · 地平线暖光（拂晓 / 白天） */
  if (p.glow) {
    const glow = ctx.createRadialGradient(W * 0.62, H * 1.05, 0, W * 0.62, H * 1.05, H * 1.5)
    glow.addColorStop(0, rgb(p.glow, skyTone.value === 'day' ? 0.5 : 0.42))
    glow.addColorStop(0.45, rgb(p.glow, 0.12))
    glow.addColorStop(1, rgb(p.glow, 0))
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, H)
  }

  /* 3 · 星 */
  if (p.star > 0 && !reduced) {
    for (const s of stars) {
      const tw = 0.72 + 0.28 * Math.sin(time * 1.5 + s.ph)
      const a = s.a * p.star * tw
      if (a <= 0.02) continue
      const x = (s.x + time * s.sp * 8) % W
      ctx.fillStyle = `rgba(226,236,252,${a})`
      ctx.beginPath()
      ctx.arc(x, s.y, s.r, 0, 6.2832)
      ctx.fill()
    }
  } else if (p.star > 0) {
    for (const s of stars) {
      ctx.fillStyle = `rgba(226,236,252,${s.a * p.star})`
      ctx.beginPath()
      ctx.arc(s.x, s.y, s.r, 0, 6.2832)
      ctx.fill()
    }
  }

  /* 4 · 月亮 */
  if (p.moon > 0.05) {
    const progress = nightProgress()
    const mx = lerp(W * 0.16, W * 0.84, progress)
    const my = H * 0.42 - Math.sin(progress * Math.PI) * H * 0.26
    const r = Math.max(13, Math.min(24, H * 0.13))

    const halo = ctx.createRadialGradient(mx, my, 0, mx, my, r * 7)
    halo.addColorStop(0, `rgba(198,216,244,${0.26 * p.moon})`)
    halo.addColorStop(0.35, `rgba(150,178,214,${0.09 * p.moon})`)
    halo.addColorStop(1, 'rgba(150,178,214,0)')
    ctx.fillStyle = halo
    ctx.beginPath(); ctx.arc(mx, my, r * 7, 0, 6.2832); ctx.fill()

    ctx.save()
    ctx.globalAlpha = p.moon
    ctx.fillStyle = '#e8eefb'
    ctx.beginPath(); ctx.arc(mx, my, r, 0, 6.2832); ctx.fill()
    // 用一团"咬掉"的暗影做出月相，随天数变化
    const phase = ((nightIndex.value - 1) % 4) / 4
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.arc(mx - r * (0.25 + phase * 1.15), my - r * 0.12, r * 0.94, 0, 6.2832)
    ctx.fill()
    ctx.restore()
  }

  /* 5 · 白天的日轮 */
  if (skyTone.value === 'day') {
    const sx = W * 0.78, sy = H * 0.3
    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, H * 1.1)
    halo.addColorStop(0, 'rgba(255,238,198,0.55)')
    halo.addColorStop(0.25, 'rgba(246,208,148,0.18)')
    halo.addColorStop(1, 'rgba(246,208,148,0)')
    ctx.fillStyle = halo
    ctx.beginPath(); ctx.arc(sx, sy, H * 1.1, 0, 6.2832); ctx.fill()
  }

  /* 6 · 屋脊 */
  const base = H + 6
  const s = Math.max(0.5, Math.min(1.35, W / 1360))
  ctx.save()
  ctx.translate(W / 2 - 750 * s, 0)
  ctx.scale(s, s)

  // 远景一层（更暗更矮），做出前后关系
  ctx.fillStyle = 'rgba(6,10,16,0.85)'
  for (const h of houses) {
    if (h.tree) continue
    const y = base - h.h * 0.62
    ctx.fillRect(h.x + 6, y + 8, h.w, h.h)
    if (h.peak) {
      ctx.beginPath()
      ctx.moveTo(h.x + 2, y + 8)
      ctx.lineTo(h.x + 6 + h.w / 2, y - h.h * 0.2)
      ctx.lineTo(h.x + 10 + h.w, y + 8)
      ctx.closePath(); ctx.fill()
    }
  }

  // 近景一层
  ctx.fillStyle = '#04070c'
  for (const h of houses) {
    const y = base - h.h
    if (h.tree) {
      ctx.beginPath()
      ctx.moveTo(h.x + h.w / 2, y - 14)
      ctx.lineTo(h.x + h.w, y + h.h * 0.4)
      ctx.lineTo(h.x, y + h.h * 0.4)
      ctx.closePath(); ctx.fill()
      ctx.fillRect(h.x + h.w / 2 - 1.5, y + h.h * 0.3, 3, h.h * 0.7)
      continue
    }
    ctx.fillRect(h.x + 8, y + 6, h.w, h.h)
    if (h.peak) {
      ctx.beginPath()
      ctx.moveTo(h.x + 3, y + 7)
      ctx.lineTo(h.x + 8 + h.w / 2, y - h.h * 0.22)
      ctx.lineTo(h.x + 13 + h.w, y + 7)
      ctx.closePath(); ctx.fill()
    }
    if (h.steeple) {
      ctx.beginPath()
      ctx.moveTo(h.x + 8 + h.w / 2, y - 34)
      ctx.lineTo(h.x + 13 + h.w, y + 8)
      ctx.lineTo(h.x + 3, y + 8)
      ctx.closePath(); ctx.fill()
    }
    if (h.chimney) ctx.fillRect(h.x + 8 + h.w * 0.72, y - 2, 7, 14)
  }

  /* 7 · 窗 —— 每一扇亮着的窗，就是一名活着的玩家 */
  const players = game.value?.players || []
  for (let i = 0; i < 9; i++) {
    const h = windowHouses[i]
    if (!h) continue
    const alive = players[i] ? players[i].alive : true
    const isHuman = players[i]?.isHuman
    const y = base - h.h + 16
    const wx = h.x + 8 + h.w / 2 - 3.5
    const ww = 7, wh = 9

    if (alive) {
      const flick = reduced ? 1 : 0.86 + 0.14 * Math.sin(time * 3.1 + i * 1.7)
      ctx.save()
      ctx.shadowColor = 'rgba(242,217,121,0.85)'
      ctx.shadowBlur = 12 * flick
      ctx.fillStyle = `rgba(246,222,140,${0.94 * flick})`
      ctx.fillRect(wx, y, ww, wh)
      ctx.restore()
      // 窗棂
      ctx.fillStyle = 'rgba(4,7,12,0.75)'
      ctx.fillRect(wx + ww / 2 - 0.5, y, 1, wh)
      ctx.fillRect(wx, y + wh / 2 - 0.5, ww, 1)
      if (isHuman) {
        ctx.strokeStyle = 'rgba(242,217,121,0.9)'
        ctx.lineWidth = 1.2
        ctx.strokeRect(wx - 2.5, y - 2.5, ww + 5, wh + 5)
      }
    } else {
      // 熄灭的窗，只剩一个空洞
      ctx.fillStyle = 'rgba(18,26,38,0.9)'
      ctx.fillRect(wx, y, ww, wh)
      ctx.strokeStyle = 'rgba(120,140,170,0.14)'
      ctx.lineWidth = 0.8
      ctx.strokeRect(wx + 0.4, y + 0.4, ww - 0.8, wh - 0.8)
    }
  }

  ctx.restore()

  /* 8 · 屋脊线的微光，把天与地缝合起来 */
  const seam = ctx.createLinearGradient(0, H - 26, 0, H)
  seam.addColorStop(0, 'rgba(6,10,16,0)')
  seam.addColorStop(1, 'rgba(3,6,10,0.96)')
  ctx.fillStyle = seam
  ctx.fillRect(0, H - 26, W, 26)
}

/** 夜空进度：狼人 → 预言家 → 女巫 → 天亮 */
function nightProgress() {
  const g = game.value
  if (!g) return 0.5
  if (g.phase === 'night') {
    return { wolf: 0.22, seer: 0.46, witch: 0.7 }[g.nightStep] ?? 0.5
  }
  if (g.phase === 'dawn') return 0.93
  if (g.phase === 'over') return 0.5
  return 0.86
}

function loop(now) {
  raf = requestAnimationFrame(loop)
  if (now - lastFrame < 33) return // 稳定 30fps，够用且安静
  lastFrame = now
  draw(now)
}

onMounted(() => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  resize()
  ro = new ResizeObserver(resize)
  ro.observe(wrap.value)
  window.addEventListener('resize', onResize)
  if (reduced) draw(performance.now())
  else raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div ref="wrap" class="canopy">
    <canvas ref="canvas" class="sky" aria-hidden="true" />

    <div class="readout">
      <div class="eyebrow">
        <span v-if="game">第 {{ game.day }} {{ game.phase === 'night' ? '夜' : '天' }}</span>
        <span v-else>九人标准局</span>
      </div>
      <h1 class="phase">{{ game ? game.phaseLabel : '狼人杀' }}</h1>
    </div>

    <div class="census" :title="`村里还亮着 ${lit} 扇窗`">
      <span class="num census-n">{{ lit }}</span>
      <span class="census-d">/ {{ total }} 人</span>
      <span class="census-label">屋里还有灯</span>
    </div>
  </div>
</template>

<style scoped>
.canopy {
  position: relative;
  height: var(--canopy-h);
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: var(--night-1000);
}

.sky {
  position: absolute;
  inset: 0;
  display: block;
}

.readout {
  position: absolute;
  left: clamp(18px, 4vw, 52px);
  bottom: 22px;
  z-index: 2;
  pointer-events: none;
}

.eyebrow { color: rgba(201, 162, 39, 0.75); }

.phase {
  margin: 2px 0 0;
  font-family: var(--font-brush);
  font-size: clamp(26px, 4.2vw, 44px);
  font-weight: 400;
  line-height: 1.1;
  letter-spacing: 0.06em;
  color: var(--paper);
  text-shadow: 0 2px 20px rgba(0, 0, 0, 0.9), 0 0 42px rgba(0, 0, 0, 0.7);
}

.census {
  position: absolute;
  right: clamp(18px, 4vw, 52px);
  bottom: 26px;
  z-index: 2;
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  justify-items: end;
  column-gap: 6px;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
  pointer-events: none;
}

.census-n {
  font-size: 30px;
  line-height: 1;
  color: var(--brass-hi);
}

.census-d {
  font-family: var(--font-num);
  font-size: 12px;
  color: var(--paper-3);
}

.census-label {
  grid-column: 1 / -1;
  font-size: 10px;
  letter-spacing: 0.2em;
  color: rgba(239, 230, 210, 0.34);
}

@media (max-width: 1080px) {
  .readout { bottom: 14px; }
  .census { bottom: 18px; }
  .census-n { font-size: 24px; }
  .census-label { display: none; }
}
</style>
