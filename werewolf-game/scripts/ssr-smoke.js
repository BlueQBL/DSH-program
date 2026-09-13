/**
 * 渲染冒烟测试。
 *
 * 构建期只能保证模板编译通过；这里把界面真正渲染一遍（Vue 服务端渲染），
 * 覆盖开局页、对局中（含各类待办面板）、结算页三条分支，
 * 任何 setup() 里的取值错误都会当场抛出来。
 *
 *   npm run smoke
 */

import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import App from '../src/App.vue'
import { useGame } from '../src/composables/useGame.js'
import { createMatch, createRng, logEntry } from '../src/game/setup.js'
import { ROLE, ROLE_META } from '../src/game/roles.js'

const store = useGame()

const failures = []

async function scenario(name, prepare) {
  prepare()
  const app = createSSRApp(App)
  app.config.warnHandler = (msg) => { failures.push(`[${name}] Vue 警告：${msg}`) }
  try {
    const html = await renderToString(app)
    if (!html || html.length < 200) throw new Error(`输出过短（${html?.length ?? 0} 字节）`)
    console.log(`  ✓ ${name.padEnd(16, '　')} ${String(html.length).padStart(6)} 字节`)
  } catch (err) {
    failures.push(`[${name}] 渲染失败：${err.message}\n${err.stack?.split('\n').slice(1, 5).join('\n')}`)
    console.log(`  ✗ ${name}`)
  }
}

/** 造一局进行到一半的真实对局 */
function midGame(humanRole = ROLE.SEER) {
  const rng = createRng(20240917)
  const g = createMatch({ humanRole, rng })
  g.phase = 'day'
  g.day = 2
  g.phaseLabel = '第 2 天 · 发言'
  g.turn = 3

  // 一个预言家（人类）已经跳了，狼队有人悍跳
  const seer = g.players[g.humanId]
  seer.checks.push({ targetId: 4, result: ROLE.WOLF, day: 1 })
  seer.checks.push({ targetId: 7, result: ROLE.GOOD, day: 2 })
  g.claims.push({ playerId: seer.id, role: ROLE.SEER, day: 1, checks: seer.checks.slice() })
  const wolf = g.players.find((p) => p.role === ROLE.WOLF && p.id !== seer.id)
  g.claims.push({
    playerId: wolf.id, role: ROLE.SEER, day: 1, fake: true,
    checks: [{ targetId: seer.id, result: ROLE.WOLF, day: 1, fake: true }],
  })
  g.publicClaimsRole[seer.id] = ROLE.SEER
  g.publicClaimsRole[wolf.id] = ROLE.SEER

  // 已有的死亡与投票记录
  g.players[5].alive = false
  g.players[5].deathDay = 2
  g.players[5].deathReason = 'wolf'
  g.deaths.push({ playerId: 5, day: 2, reason: 'wolf' })
  g.speeches.push({ id: 1, playerId: seer.id, day: 1, text: '我是预言家，昨晚验的5号，查杀。', kind: 'claim-seer', targetId: 4 })
  g.speeches.push({ id: 2, playerId: wolf.id, day: 1, text: '我才是预言家，1号是悍跳的狼。', kind: 'counter-claim', targetId: 0 })
  g.speeches.push({ id: 3, playerId: 8, day: 2, text: '我站1号预言家，今天先出5号。', kind: 'support', targetId: seer.id })
  g.attacked[seer.id] = [4]
  g.attacked[wolf.id] = [0]
  g.supported[8] = [seer.id]
  g.influence[seer.id] = 3.2
  g.influence[wolf.id] = 2.1
  g.log.push(
    { id: 1, day: 1, phase: 'night', kind: 'phase', text: '天黑请闭眼。' },
    { id: 2, day: 1, phase: 'night', kind: 'night', text: '狼人睁眼。', secret: true },
    { id: 3, day: 1, phase: 'dawn', kind: 'dawn', text: '昨晚是平安夜，没有人出局。' },
    { id: 4, day: 1, phase: 'day', kind: 'speech', text: '1号：我是预言家，昨晚验的5号，查杀。', playerId: seer.id, speech: true },
    { id: 5, day: 1, phase: 'day', kind: 'speech', text: '3号：我才是预言家。', playerId: wolf.id, speech: true },
    { id: 6, day: 1, phase: 'vote', kind: 'vote', text: '2号 投票 → 5号', playerId: 1, targetId: 5 },
    { id: 7, day: 1, phase: 'vote', kind: 'vote', text: '4号 投票 → 1号', playerId: 3, targetId: 0 },
    { id: 8, day: 1, phase: 'result', kind: 'result', text: '5号白露 以 4 票被放逐出村。' },
    { id: 9, day: 2, phase: 'dawn', kind: 'death', text: '6号阿七 倒牌了。', playerId: 5 },
  )
  g.lastTally = [{ playerId: 4, count: 4 }, { playerId: 0, count: 3 }]
  return g
}

console.log('渲染冒烟测试：')

await scenario('开局页', () => {
  store.screen.value = 'lobby'
  store.game.value = null
  store.pending.value = null
})

await scenario('对局·空闲', () => {
  store.game.value = midGame()
  store.screen.value = 'playing'
  store.pending.value = null
})

await scenario('对局·正在发言', () => {
  store.game.value.currentSpeech = { playerId: 3, text: '我盘一下，两个预言家里必有一狼，今天必须处理一个。', kind: 'accuse' }
})

await scenario('待办·选人', () => {
  store.game.value.currentSpeech = null
  store.pending.value = { id: 1, kind: 'pick-one', title: '今晚猎杀谁？', hint: '同伴：3号铁柱', suggestion: '5号（同伴倾向）', candidates: [1, 2, 3, 4, 6, 7, 8], allowSkip: false, submit() {} }
})

await scenario('待办·女巫', () => {
  store.game.value.nightKill = 2
  store.game.value.phase = 'night'
  store.pending.value = {
    id: 2, kind: 'witch', title: '今晚，你要用药吗？', hint: '今晚倒牌的是 3号铁柱。',
    antidote: true, poison: true, canSave: true, canPoison: true, saveBlockedReason: '',
    candidates: [1, 3, 4, 6, 7, 8], submit() {},
  }
})

await scenario('待办·投票', () => {
  store.game.value.phase = 'vote'
  store.pending.value = {
    id: 3, kind: 'vote', title: '你要投谁？', hint: '场上还有 8 人。',
    candidates: [1, 2, 3, 4, 6, 7, 8], allowSkip: true, skipLabel: '弃票', timeLimit: 45000, submit() {},
  }
})

await scenario('待办·发言', () => {
  store.pending.value = {
    id: 4, kind: 'speak', title: '轮到你发言', hint: '挑一个立场。',
    targets: [1, 2, 3, 4, 6, 7, 8], allowSkip: true,
    kinds: store.speakKinds(ROLE.SEER), submit() {},
  }
})

await scenario('观战·托管面板', () => {
  store.options.spectate = true
  store.pending.value = {
    id: 5, kind: 'vote', title: '你要投谁？', hint: '场上还有 8 人。',
    candidates: [1, 2, 3, 4, 6, 7, 8], allowSkip: true, auto: true, timeLimit: 0, submit() {},
  }
})

await scenario('揭示卡', () => {
  store.options.spectate = false
  store.pending.value = null
  store.reveal.value = { id: 9, tone: 'blood', title: '4号白露 · 狼人', subtitle: '查杀' }
})

await scenario('结算页', () => {
  store.reveal.value = null
  const g = store.game.value
  g.winner = 'good'
  g.winReason = '三只狼全部出局，村子活下来了。'
  g.phase = 'over'
  g.phaseLabel = '好人胜利'
  g.revealAll = true
  g.players[4].alive = false
  g.players[4].deathDay = 2
  g.players[4].deathReason = 'vote'
  store.screen.value = 'over'
})

console.log('')
if (failures.length) {
  console.log(`发现 ${failures.length} 个问题：`)
  for (const f of failures) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('全部场景渲染通过，无 Vue 警告。')
}
