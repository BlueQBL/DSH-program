/**
 * 音效：全部用 WebAudio 现场合成，不依赖任何音频文件。
 * 狼人杀需要的是"钟、木、枪、夜风"这类材质声，合成比采样更贴。
 */

let ctx = null
let master = null

function ensure() {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

/** 一段噪声缓冲，用于风声与枪声 */
function noiseBuffer(seconds = 1) {
  const n = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, n, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    d[i] = last * 3.2
  }
  return buf
}

function tone({ freq, type = 'sine', at = 0, dur = 0.4, gain = 0.2, glide = null }) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, ctx.currentTime + at)
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, ctx.currentTime + at + dur)
  g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur)
  o.connect(g); g.connect(master)
  o.start(ctx.currentTime + at)
  o.stop(ctx.currentTime + at + dur + 0.05)
}

function noise({ at = 0, dur = 1, gain = 0.15, filter = 800, q = 0.7, type = 'lowpass' }) {
  const src = ctx.createBufferSource()
  src.buffer = noiseBuffer(Math.max(0.4, dur + 0.2))
  const f = ctx.createBiquadFilter()
  f.type = type; f.frequency.value = filter; f.Q.value = q
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
  g.gain.exponentialRampToValueAtTime(gain, ctx.currentTime + at + 0.03)
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur)
  src.connect(f); f.connect(g); g.connect(master)
  src.start(ctx.currentTime + at)
  src.stop(ctx.currentTime + at + dur + 0.1)
}

const RECIPES = {
  night: () => { noise({ dur: 2.4, gain: 0.1, filter: 420 }); tone({ freq: 78, type: 'sine', dur: 2.6, gain: 0.1, glide: 55 }) },
  dawn: () => { tone({ freq: 392, type: 'triangle', dur: 1.6, gain: 0.1 }); tone({ freq: 587.3, type: 'triangle', at: 0.22, dur: 1.8, gain: 0.07 }) },
  death: () => { tone({ freq: 110, type: 'sine', dur: 1.1, gain: 0.22, glide: 62 }); noise({ dur: 0.5, gain: 0.08, filter: 300 }) },
  calm: () => { tone({ freq: 523.25, type: 'sine', dur: 0.9, gain: 0.06 }) },
  gun: () => { noise({ dur: 0.34, gain: 0.5, filter: 2400, type: 'highpass' }); tone({ freq: 90, type: 'square', dur: 0.22, gain: 0.2, glide: 45 }) },
  exile: () => { tone({ freq: 196, type: 'sawtooth', dur: 0.7, gain: 0.12, glide: 130 }); noise({ dur: 0.7, gain: 0.09, filter: 600 }) },
  vote: () => { tone({ freq: 660, type: 'square', dur: 0.09, gain: 0.05 }) },
  speak: () => { tone({ freq: 880, type: 'sine', dur: 0.05, gain: 0.03 }) },
  'wolf-win': () => { tone({ freq: 146.8, type: 'sawtooth', dur: 2.4, gain: 0.16, glide: 92 }); noise({ dur: 2.4, gain: 0.1, filter: 500 }) },
  'good-win': () => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, type: 'triangle', at: i * 0.13, dur: 1.4, gain: 0.1 })) },
  select: () => { tone({ freq: 1320, type: 'sine', dur: 0.06, gain: 0.035 }) },
  reject: () => { tone({ freq: 220, type: 'square', dur: 0.16, gain: 0.07, glide: 160 }) },
}

let muted = false

export function setMuted(v) { muted = v }
export function isMuted() { return muted }

export function play(name) {
  if (muted) return
  const c = ensure()
  if (!c) return
  const recipe = RECIPES[name]
  if (!recipe) return
  try { recipe() } catch { /* 音频不可用时静默失败，不影响游戏 */ }
}

export function unlock() { ensure() }
