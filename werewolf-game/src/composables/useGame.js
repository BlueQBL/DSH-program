/**
 * 全局唯一的对局仓库。
 * 界面只读 game 这个响应式对象，所有动作通过下面的方法发起。
 */

import { ref, reactive, computed, readonly } from 'vue'
import { createMatch, createRng } from '../game/setup.js'
import { runGame, Aborted, speakKinds } from '../game/director.js'
import { ROLE, ROLE_META, TEAM, GOD_ROLES } from '../game/roles.js'
import { compose, seatLabel } from '../game/speech.js'
import { answerAsHuman } from '../game/autopilot.js'
import * as audio from '../game/audio.js'

/* ---------------- 状态 ---------------- */

const game = ref(null)
const screen = ref('lobby')      // lobby | playing | over
const pending = ref(null)        // 人类玩家当前的待办
const reveal = ref(null)         // 全屏揭示卡（验人结果 / 用药结果）
const paused = ref(false)
const speed = ref(1)
const muted = ref(false)
const options = reactive({
  humanRole: 'random',
  voteTimer: true,
  spectate: false,
})

let token = { aborted: false, askReject: null }
let running = false
let askSeq = 0
let revealSeq = 0

/* ---------------- 宿主接口（导演用它来"等"和"问"） ---------------- */

function wait(ms) {
  return new Promise((resolve, reject) => {
    let acc = 0
    let last = performance.now()
    let raf = 0
    const step = () => {
      if (token.aborted) { cancelAnimationFrame(raf); return reject(new Aborted()) }
      const now = performance.now()
      if (!paused.value) acc += (now - last) * speed.value
      last = now
      if (acc >= ms) return resolve()
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  })
}

function ask(request) {
  return new Promise((resolve, reject) => {
    token.askReject = reject
    const req = {
      ...request,
      id: ++askSeq,
      auto: options.spectate,
      timeLimit: request.timeLimit ?? (!options.spectate && request.kind === 'vote' && options.voteTimer ? 45000 : 0),
      submit: (answer) => {
        if (pending.value !== req) return
        token.askReject = null
        pending.value = null
        resolve(answer ?? { playerId: null })
      },
    }
    pending.value = req

    // 观战模式下由托管作答：仍然先把问题显示出来，好看清 AI 在决定什么
    if (options.spectate) {
      const mine = token
      setTimeout(() => {
        if (mine.aborted || pending.value !== req) return
        req.submit(answerAsHuman(game.value, req, game.value?.rng || Math.random))
      }, 850 / Math.max(0.4, speed.value))
    }
  })
}

function showReveal(card) {
  return new Promise((resolve) => {
    const id = ++revealSeq
    reveal.value = { ...card, id }
    const hold = card.hold ?? 1750
    setTimeout(() => {
      if (reveal.value && reveal.value.id === id) reveal.value = null
      resolve()
    }, hold / Math.max(0.4, speed.value))
  })
}

const host = {
  wait,
  ask,
  reveal: showReveal,
  sfx: (name) => { if (!muted.value) audio.play(name) },
}

/* ---------------- 对局控制 ---------------- */

export async function startGame() {
  abort()
  audio.unlock()
  const rng = createRng((Math.random() * 1e9) | 0)
  game.value = createMatch({ humanRole: options.humanRole, rng })
  screen.value = 'playing'
  pending.value = null
  reveal.value = null
  paused.value = false
  running = true
  try {
    await runGame(game.value, host)
  } catch (err) {
    if (!(err instanceof Aborted)) {
      console.error('[狼人杀] 流程异常：', err)
      throw err
    }
  } finally {
    if (running && game.value && !game.value.winner) {
      // 中途 abort，什么都不做
    }
    running = false
    if (game.value?.winner) screen.value = 'over'
  }
}

function abort() {
  token.aborted = true
  token.askReject?.(new Aborted())
  token.askReject = null
  token = { aborted: false, askReject: null }
  pending.value = null
  reveal.value = null
}

export function restart() {
  startGame()
}

export function toLobby() {
  abort()
  running = false
  screen.value = 'lobby'
  game.value = null
}

/* ---------------- 玩家动作 ---------------- */

export function pick(playerId) {
  if (!pending.value) return
  if (!muted.value) audio.play('select')
  pending.value.submit({ playerId })
}

export function skip() {
  if (!pending.value) return
  if (!muted.value) audio.play('reject')
  pending.value.submit({ playerId: null })
}

export function submitWitch({ save = false, poison = null }) {
  if (!pending.value) return
  pending.value.submit({ save, poison })
}

/** 人类玩家的发言：把界面选择翻译成导演能懂的 intent */
export function submitSpeech({ kind, targetId = null, verdict = 'wolf', text = '' }) {
  const t = pending.value
  if (!t) return
  const g = game.value
  const me = g.players[g.humanId]
  const target = targetId != null ? g.players.find((p) => p.id === targetId) : null

  const intent = { kind, target, voteTarget: target }
  if (kind === 'claim-seer') {
    intent.checks = me.role === ROLE.SEER
      ? me.checks.slice()
      : (target ? [{ targetId: target.id, result: verdict, day: g.day - 1, fake: true }] : [])
  }
  if (kind === 'report-check' && me.role === ROLE.SEER) intent.checks = me.checks.slice()

  const spoken = text.trim() ? text.trim() : compose(g, me, intent, g.rng)
  t.submit({ intent, text: spoken })
}

export function submitVote(playerId) {
  if (!pending.value) return
  if (!muted.value) audio.play(playerId == null ? 'reject' : 'select')
  pending.value.submit({ playerId })
}

/* ---------------- 派生数据 ---------------- */

const me = computed(() => {
  if (!game.value) return null
  return game.value.players[game.value.humanId]
})

const myRoleMeta = computed(() => (me.value ? ROLE_META[me.value.role] : null))

const alivePlayers = computed(() => (game.value ? game.value.players.filter((p) => p.alive) : []))
const aliveCount = computed(() => alivePlayers.value.length)
const wolvesAlive = computed(() => alivePlayers.value.filter((p) => p.role === ROLE.WOLF).length)
const myTeammates = computed(() => {
  if (!game.value || !me.value || me.value.role !== ROLE.WOLF) return []
  return game.value.players.filter((p) => p.role === ROLE.WOLF && p.id !== me.value.id)
})

/** 天幕色调：夜 / 拂晓 / 白昼 / 终局 */
const skyTone = computed(() => {
  const g = game.value
  if (!g) return 'dusk'
  if (g.phase === 'over') return g.winner === TEAM.WOLF ? 'blood' : 'dawn'
  if (g.phase === 'night') return g.nightStep === 'witch' ? 'deep' : 'night'
  if (g.phase === 'dawn') return 'dawn'
  return 'day'
})

const canAct = computed(() => !!pending.value)

const humanTurnActive = computed(() => canAct.value)

/* ---------------- 对外 ---------------- */

export function useGame() {
  return {
    game, screen, pending, reveal, paused, speed, muted, options,
    me, myRoleMeta, alivePlayers, aliveCount, wolvesAlive, myTeammates, skyTone,
    canAct, humanTurnActive,
    startGame, restart, toLobby, pick, skip, submitWitch, submitSpeech, submitVote,
    speakKinds, seatLabel, ROLE, ROLE_META, TEAM,
    toggleMute, togglePause,
  }
}

function toggleMute() {
  muted.value = !muted.value
  audio.setMuted(muted.value)
  if (!muted.value) { audio.unlock(); audio.play('select') }
}

function togglePause() {
  paused.value = !paused.value
}
