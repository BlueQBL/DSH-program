<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Back,
  Delete,
  Download,
  RefreshLeft,
  RefreshRight,
} from '@element-plus/icons-vue'

/* ============================================================
   仿真电子黑板
   亮点：真实粉笔质感（粉尘颗粒描边而非干净矢量线）、木质黑板框
   与粉笔槽、可撤销重做、可高清导出 PNG。
   ============================================================ */

const router = useRouter()

// —— 画板 refs ——
const holderEl = ref(null)
const surfaceEl = ref(null)
const baseCanvas = ref(null) // 已提交内容：黑板纹理 + 全部笔迹
const liveCanvas = ref(null) // 当前正在画的一笔（半透明叠加层）

// —— 工具状态 ——
const CHALK_COLORS = [
  { name: '白垩', hex: '#f6f3ea' },
  { name: '鹅黄', hex: '#ecd982' },
  { name: '粉红', hex: '#f0a9a1' },
  { name: '天蓝', hex: '#89bfe8' },
  { name: '青绿', hex: '#8fd0a4' },
  { name: '橙红', hex: '#e79c66' },
]
const SIZES = [
  { label: '细', value: 9 },
  { label: '中', value: 16 },
  { label: '粗', value: 30 },
]
const ERASER_SIZE = 46
// 黑板底色（与纹理主色一致，橡皮擦回填用）
const BOARD_GREEN = '#2c443d'

const currentColor = ref(CHALK_COLORS[0].hex)
const currentSize = ref(16)
const isEraser = ref(false)

// —— 笔迹历史（撤销 / 重做用）——
// stroke = { color, size, eraser, points: [[x,y], …] }
const done = ref([]) // 已完成的笔划
const undone = ref([]) // 被撤销、可重做的笔划

// —— 画布逻辑尺寸与渲染上下文 ——
let boardW = 0
let boardH = 0
let dpr = 1
let baseCtx = null
let liveCtx = null

// —— 画板纹理瓦片（离屏生成一次）——
let textureTile = null
function makeTextureTile() {
  const t = document.createElement('canvas')
  t.width = 200
  t.height = 200
  const c = t.getContext('2d')
  c.fillStyle = BOARD_GREEN
  c.fillRect(0, 0, 200, 200)
  // 深浅不一的木质颗粒
  for (let i = 0; i < 1500; i++) {
    c.globalAlpha = 0.08 + Math.random() * 0.22
    c.fillStyle = Math.random() < 0.5 ? '#3a5a50' : '#21352f'
    c.fillRect(Math.random() * 200, Math.random() * 200, 1.5, 1.6)
  }
  // 极淡的白色粉尘
  for (let i = 0; i < 240; i++) {
    c.globalAlpha = 0.03 + Math.random() * 0.08
    c.fillStyle = '#ffffff'
    c.beginPath()
    c.arc(Math.random() * 200, Math.random() * 200, 0.6 + Math.random() * 1.2, 0, 6.283)
    c.fill()
  }
  c.globalAlpha = 1
  return t
}

// 用纹理瓦片平铺整块黑板（含导出画布共用）
function paintTexture(ctx, w, h) {
  const p = ctx.createPattern(textureTile, 'repeat')
  if (!p) {
    ctx.fillStyle = BOARD_GREEN
    ctx.fillRect(0, 0, w, h)
    return
  }
  ctx.fillStyle = p
  ctx.fillRect(0, 0, w, h)
}

// 四角压暗，更具真实黑板氛围
function drawVignette(ctx, w, h) {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) * 0.62)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.30)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/* —— 粉笔笔触：沿线段撒粉尘颗粒，制造磨砂质感 —— */
function chalkSegment(ctx, x1, y1, x2, y2, color, size) {
  const d = Math.hypot(x2 - x1, y2 - y1)
  const step = Math.max(1, size * 0.32)
  const n = Math.max(1, Math.ceil(d / step))
  const half = size / 2
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const px = x1 + (x2 - x1) * t
    const py = y1 + (y2 - y1) * t
    const grains = Math.max(2, Math.round(half * 1.35))
    for (let g = 0; g < grains; g++) {
      const ang = Math.random() * 6.283
      const r = (0.15 + Math.random()) * half * 0.92
      ctx.globalAlpha = 0.07 + Math.random() * 0.34
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(px + Math.cos(ang) * r, py + Math.sin(ang) * r, 0.5 + Math.random() * 0.95, 0, 6.283)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}

// 单个点（单击画出的墨点）
function chalkDot(ctx, x, y, color, size) {
  const grains = Math.max(6, Math.round(size * 2.2))
  for (let g = 0; g < grains; g++) {
    const ang = Math.random() * 6.283
    const r = Math.random() * size * 0.55
    ctx.globalAlpha = 0.08 + Math.random() * 0.36
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x + Math.cos(ang) * r, y + Math.sin(ang) * r, 0.5 + Math.random() * 1.05, 0, 6.283)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

// 橡皮：用黑板底色画粗线段，回填盖住粉笔
function eraserSegment(ctx, x1, y1, x2, y2, size) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = BOARD_GREEN
  ctx.lineWidth = size
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function drawChalkStroke(ctx, s) {
  if (s.eraser) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = BOARD_GREEN
    ctx.lineWidth = ERASER_SIZE
    ctx.beginPath()
    s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.stroke()
    return
  }
  if (s.points.length < 2) {
    chalkDot(ctx, s.points[0][0], s.points[0][1], s.color, s.size)
    return
  }
  for (let i = 1; i < s.points.length; i++) {
    const [x1, y1] = s.points[i - 1]
    const [x2, y2] = s.points[i]
    chalkSegment(ctx, x1, y1, x2, y2, s.color, s.size)
  }
}

// 全量重绘已提交内容
function redrawBase() {
  if (!baseCtx) return
  baseCtx.clearRect(0, 0, boardW, boardH)
  paintTexture(baseCtx, boardW, boardH)
  done.value.forEach(drawChalkStroke)
  drawVignette(baseCtx, boardW, boardH)
}

// —— 尺寸适配（含 dpr，保证清晰）——
function resizeTo(clientW, clientH) {
  if (!clientW || !clientH) return
  boardW = clientW
  boardH = clientH
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  for (const [cv, ctx] of [
    [baseCanvas.value, 'base'],
    [liveCanvas.value, 'live'],
  ]) {
    cv.width = Math.round(boardW * dpr)
    cv.height = Math.round(boardH * dpr)
  }
  baseCtx = baseCanvas.value.getContext('2d')
  liveCtx = liveCanvas.value.getContext('2d')
  baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  redrawBase()
}

// —— 指针交互 ——
let drawing = false
let lastPt = null
let currentStroke = null

function toPos(e) {
  const rect = liveCanvas.value.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e) {
  e.preventDefault()
  const p = toPos(e)
  drawing = true
  lastPt = p
  currentStroke = { color: currentColor.value, size: isEraser.value ? ERASER_SIZE : currentSize.value, eraser: isEraser.value, points: [[p.x, p.y]] }
  liveCanvas.value.setPointerCapture(e.pointerId)
}

function onPointerMove(e) {
  if (!drawing) return
  e.preventDefault()
  const p = toPos(e)
  if (lastPt && Math.hypot(p.x - lastPt.x, p.y - lastPt.y) >= 1.2) {
    if (currentStroke.eraser) eraserSegment(liveCtx, lastPt.x, lastPt.y, p.x, p.y, currentStroke.size)
    else chalkSegment(liveCtx, lastPt.x, lastPt.y, p.x, p.y, currentStroke.color, currentStroke.size)
    currentStroke.points.push([p.x, p.y])
    lastPt = p
  }
}

function onPointerUp(e) {
  if (!drawing) return
  drawing = false
  if (currentStroke && currentStroke.points.length > 0) {
    done.value.push(currentStroke)
    undone.value = []
    // 直接把这笔“烘焙”到黑板底色上，立即可见；
    // 不再依赖松手后的全量重放（重放只在撤销/重做/清空时用）。
    drawChalkStroke(baseCtx, currentStroke)
  }
  currentStroke = null
  lastPt = null
  liveCtx.clearRect(0, 0, boardW, boardH)
}

// —— 工具动作 ——
function pickColor(hex) {
  currentColor.value = hex
  isEraser.value = false
}
function pickSize(v) {
  currentSize.value = v
}
function useEraser() {
  isEraser.value = true
}
function undo() {
  if (!done.value.length) return
  undone.value.push(done.value.pop())
  redrawBase()
}
function redo() {
  if (!undone.value.length) return
  done.value.push(undone.value.pop())
  redrawBase()
}
function clearBoard() {
  if (!done.value.length && !undone.value.length) return
  done.value = []
  undone.value = []
  redrawBase()
}

// —— 导出 PNG（高清离线画布重放整块黑板）——
function exportPNG() {
  if (!boardW || !boardH) {
    ElMessage.warning('黑板尚未就绪，无法导出')
    return
  }
  try {
    const scale = 2
    const EW = Math.round(boardW * scale)
    const EH = Math.round(boardH * scale)
    const off = document.createElement('canvas')
    off.width = EW
    off.height = EH
    const ctx = off.getContext('2d')
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    paintTexture(ctx, boardW, boardH)
    done.value.forEach(drawChalkStroke)
    drawVignette(ctx, boardW, boardH)

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `电子黑板-${ts}.png`
    const doneMsg = () => ElMessage.success(`已导出 ${EW}×${EH} PNG`)

    // 触发下载：把 <a> 挂到 DOM 再点击，兼容性最好
    const triggerDownload = (url) => {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }

    // 优先 Blob + 对象 URL；失败则回退 data URL
    off.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        triggerDownload(url)
        setTimeout(() => URL.revokeObjectURL(url), 1500)
        doneMsg()
      } else {
        triggerDownload(off.toDataURL('image/png'))
        doneMsg()
      }
    }, 'image/png')
  } catch (err) {
    ElMessage.error('导出失败：' + (err && err.message ? err.message : String(err)))
  }
}

// —— 快捷键 ——
function onKeydown(e) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
    e.preventDefault()
    redo()
  }
}

let ro = null
onMounted(() => {
  textureTile = makeTextureTile()
  const measure = () => {
    const surface = surfaceEl.value
    if (!surface) return
    const r = surface.getBoundingClientRect()
    resizeTo(r.width, r.height)
  }
  measure()
  ro = new ResizeObserver(measure)
  ro.observe(holderEl.value)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  if (ro) ro.disconnect()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="board-page">
    <!-- 顶部：回工作台 -->
    <header class="board-top">
      <el-button link :icon="Back" @click="router.push('/')">返回工作台</el-button>
      <div class="board-brand">
        <span class="brand-caret">›</span>
        <span>blackboard / 电子黑板</span>
        <span class="board-tag">CHALK</span>
      </div>
      <div class="board-title">仿真黑板</div>
    </header>

    <main class="stage">
      <!-- 黑板（木质外框 + 粉笔槽） -->
      <div ref="holderEl" class="board-wood">
        <!-- 工具栏：粉笔色 / 粗细 / 橡皮 -->
        <ul class="toolbar">
          <li class="tool-group" aria-label="粉笔颜色">
            <span class="tool-label">粉笔</span>
            <button
              v-for="c in CHALK_COLORS"
              :key="c.hex"
              class="chalk-dot"
              :class="{ active: !isEraser && currentColor === c.hex }"
              :title="c.name"
              :style="{ background: c.hex }"
              @click="pickColor(c.hex)"
            />
          </li>
          <li class="tool-group" aria-label="笔触粗细">
            <span class="tool-label">粗细</span>
            <button
              v-for="s in SIZES"
              :key="s.value"
              class="size-btn"
              :class="{ active: !isEraser && currentSize === s.value }"
              @click="pickSize(s.value)"
            >
              {{ s.label }}
            </button>
          </li>
          <li class="tool-group">
            <span class="tool-label">工具</span>
            <button class="tool-btn" :class="{ active: isEraser }" @click="useEraser">橡皮</button>
          </li>
        </ul>

        <!-- 黑板面 -->
        <div ref="surfaceEl" class="board-surface">
          <canvas ref="baseCanvas" class="base" />
          <canvas
            ref="liveCanvas"
            class="live"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
            @contextmenu.prevent
          />
        </div>

        <!-- 粉笔槽：一截截粉笔 + 橡皮擦 -->
        <div class="chalk-tray" aria-hidden="true">
          <span class="tray-front"></span>
          <span
            v-for="c in CHALK_COLORS"
            :key="c.hex"
            class="chalk-stick"
            :style="{
              background: `linear-gradient(90deg, ${c.hex}, ${c.hex}cc 40%, ${c.hex}55)`,
              boxShadow: '0 2px 3px rgba(0,0,0,.5)',
            }"
          />
          <span class="tray-eraser"></span>
          <span class="tray-front"></span>
        </div>
      </div>

      <!-- 底部操作条 -->
      <footer class="board-actions">
        <el-button :icon="RefreshLeft" :disabled="!done.length" @click="undo">撤销</el-button>
        <el-button :icon="RefreshRight" :disabled="!undone.length" @click="redo">重做</el-button>
        <el-button :icon="Delete" :disabled="!done.length && !undone.length" @click="clearBoard">清空</el-button>
        <div class="actions-grow"></div>
        <el-button type="primary" :icon="Download" @click="exportPNG">导出图片</el-button>
      </footer>

      <div class="board-hint">
        <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Z</kbd> 撤销 ·
        <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">Y</kbd> 重做 · 支持触屏与鼠标
      </div>
    </main>
  </div>
</template>

<style scoped>
/* —— 黑板专属：教室木质氛围 —— */
.board-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(900px 500px at 50% -10%, rgba(229, 171, 78, 0.10), transparent 60%),
    radial-gradient(700px 480px at 10% 110%, rgba(122, 162, 247, 0.07), transparent 60%),
    #0a0f1e;
}

.board-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px clamp(18px, 4vw, 40px);
  border-bottom: 1px solid var(--gate-line);
}

.board-brand {
  font-family: var(--gate-mono);
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gate-text);
}
.brand-caret {
  color: var(--gate-accent);
  font-weight: 700;
}
.board-tag {
  font-size: 10px;
  letter-spacing: 0.26em;
  color: var(--gate-faint);
  border: 1px solid var(--gate-line);
  border-radius: 4px;
  padding: 2px 7px;
}
.board-title {
  font-weight: 700;
  letter-spacing: 0.04em;
}

.stage {
  flex: 1;
  width: min(1180px, 100% - clamp(0px, 6vw, 72px));
  margin: 0 auto;
  padding: 26px 0 30px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* —— 木质黑板外框 —— */
.board-wood {
  position: relative;
  padding: clamp(14px, 2.4vw, 26px);
  background:
    linear-gradient(120deg, #8a5a33, #b9814e 18%, #8a5a33 40%, #6b421f 62%, #9a6c3f 82%, #6b421f);
  border-radius: 18px;
  box-shadow:
    0 26px 60px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -2px 6px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* —— 顶部工具栏（卧式，浮在框内） —— */
.toolbar {
  list-style: none;
  margin: 0;
  padding: 10px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: center;
  background: rgba(20, 15, 8, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
}
.tool-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tool-label {
  font-size: 12px;
  letter-spacing: 0.14em;
  color: #cfb79a;
}
.chalk-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid rgba(0, 0, 0, 0.35);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.chalk-dot:hover {
  transform: translateY(-2px);
}
.chalk-dot.active {
  box-shadow: 0 0 0 3px rgba(246, 243, 234, 0.75);
}
.size-btn,
.tool-btn {
  font-family: var(--gate-font);
  font-size: 12.5px;
  color: #e8ddca;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
}
.size-btn:hover,
.tool-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
.size-btn.active,
.tool-btn.active {
  background: var(--gate-accent);
  color: var(--gate-accent-ink);
  border-color: var(--gate-accent);
  font-weight: 700;
}

/* —— 黑板面 —— */
.board-surface {
  position: relative;
  flex: 1;
  min-height: 420px;
  border-radius: 8px;
  overflow: hidden;
  background: #2c443d; /* 兜底色（纹理之上） */
  box-shadow:
    inset 0 2px 10px rgba(0, 0, 0, 0.55),
    inset 0 -1px 6px rgba(0, 0, 0, 0.4);
}
.board-surface canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.board-surface .live {
  touch-action: none;
  cursor: crosshair;
}

/* —— 粉笔槽 —— */
.chalk-tray {
  position: relative;
  height: 34px;
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 0 6px 4px;
}
.tray-front {
  flex: 1;
  height: 12px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0.5));
  border-radius: 4px;
}
.chalk-stick {
  height: 24px;
  width: 14px;
  border-radius: 3px;
  transform: rotate(-3deg) translateY(2px);
}
.tray-eraser {
  height: 20px;
  width: 46px;
  border-radius: 4px;
  transform: rotate(2deg) translateY(1px);
  background: linear-gradient(180deg, #caa56b, #8a6a3a);
  box-shadow: 0 2px 3px rgba(0, 0, 0, 0.5);
}

/* —— 底部操作条 —— */
.board-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.actions-grow {
  flex: 1;
}

.board-hint {
  margin-top: 2px;
  font-size: 12px;
  color: var(--gate-faint);
  display: flex;
  align-items: center;
  gap: 6px;
}
.board-hint .kbd {
  color: var(--gate-muted);
}

@media (max-width: 640px) {
  .board-wood {
    padding: 10px;
  }
  .board-surface {
    min-height: 300px;
  }
  .board-top .board-brand {
    display: none;
  }
}
</style>
