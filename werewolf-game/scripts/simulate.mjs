/**
 * 无头模拟器：不开浏览器，把导演流程跑完一整局。
 *
 * 用途：验证状态机不会卡死、不会抛异常，并统计胜率与平均天数。
 * 人类席位由一个"用同一套 AI 决策"的替身扮演。
 *
 *   node scripts/simulate.mjs [局数]
 */

import { createMatch, createRng } from '../src/game/setup.js'
import { runGame, Aborted } from '../src/game/director.js'
import * as AI from '../src/game/ai.js'
import { compose } from '../src/game/speech.js'
import { ROLE, ROLE_META, TEAM } from '../src/game/roles.js'

const TOTAL = Number(process.argv[2] || 200)

/** 用 AI 的逻辑替人类作答 */
function autoAnswer(state, req, rng) {
  const me = state.players[state.humanId]
  switch (req.kind) {
    case 'pick-one': {
      if (req.role === ROLE.HUNTER) {
        const t = AI.hunterTarget(state, me, rng)
        return { playerId: t }
      }
      if (req.role === ROLE.WOLF) return { playerId: AI.wolfKillTarget(state, rng) }
      if (req.role === ROLE.SEER) {
        const t = AI.seerCheckTarget(state, me, rng)
        return { playerId: t ?? req.candidates[0] }
      }
      return { playerId: req.candidates[Math.floor(rng() * req.candidates.length)] }
    }
    case 'witch': {
      const d = AI.witchDecision(state, me, rng)
      if (d.save && req.canSave) return { save: true, poison: null }
      if (d.poison != null && req.canPoison) return { save: false, poison: d.poison }
      return { save: false, poison: null }
    }
    case 'vote':
      return { playerId: AI.decideVote(state, me, rng) }
    case 'speak': {
      const intent = AI.decideSpeech(state, me, rng)
      return { intent, text: compose(state, me, intent, rng) }
    }
    default:
      return { playerId: null }
  }
}

async function playOne(seed, humanRole) {
  const rng = createRng(seed)
  const state = createMatch({ humanRole, rng })
  let beats = 0
  const LIMIT = 4000

  const host = {
    wait: () => {
      if (++beats > LIMIT) throw new Error('BEAT_LIMIT')
      return Promise.resolve()
    },
    ask: (req) => {
      if (++beats > LIMIT) throw new Error('BEAT_LIMIT')
      return Promise.resolve(autoAnswer(state, req, rng))
    },
    reveal: () => Promise.resolve(),
    sfx: () => {},
  }

  await runGame(state, host)
  return state
}

/* ---------------- 跑 ---------------- */

const winReason = {}

const roles = ['random', ROLE.WOLF, ROLE.SEER, ROLE.WITCH, ROLE.HUNTER, ROLE.VILLAGER]
const tally = { wolf: 0, good: 0 }
const byRole = {}
let daysTotal = 0
let speechTotal = 0
let done = 0
let exilesTotal = 0
let exilesHitWolf = 0
let seerClaimedDay1 = 0
let seerGames = 0
let duels = 0
let duelRight = 0
let duelWrong = 0
let witchActions = 0
let antidoteGames = 0
let poisonGames = 0
let hunterDeaths = 0
let hunterFired = 0
const exileByDay = {}
const problems = []

for (let i = 0; i < TOTAL; i++) {
  const humanRole = roles[i % roles.length]
  let state
  try {
    state = await playOne(1000 + i * 7, humanRole)
  } catch (err) {
    problems.push(`#${i} humanRole=${humanRole} 抛出异常：${err.message}\n${err.stack?.split('\n').slice(1, 4).join('\n')}`)
    continue
  }

  if (!state.winner) {
    problems.push(`#${i} 未决出胜负，停在第 ${state.day} 天`)
    continue
  }

  tally[state.winner] += 1
  const rk = state.winReason.replace(/——.*/, '').replace(/。/, '')
  winReason[rk] = (winReason[rk] || 0) + 1
  daysTotal += state.day
  speechTotal += state.speeches.length
  done += 1

  // 放逐命中率：好人的票有多准
  for (const vh of state.voteHistory) {
    if (vh.exiledId == null) continue
    exilesTotal += 1
    if (state.players.find((p) => p.id === vh.exiledId)?.role === ROLE.WOLF) exilesHitWolf += 1
  }

  // 预言家有没有在第一天报出验人
  const seer = state.players.find((p) => p.role === ROLE.SEER)
  if (seer) {
    seerGames += 1
    if (state.claims.some((c) => c.playerId === seer.id && c.day === 1)) seerClaimedDay1 += 1
  }

  // 对跳时，村庄投票有没有站对边（只看放逐结果，夜间被杀不算村庄选错）
  const seerClaims = state.claims.filter((c) => c.role === ROLE.SEER)
  if (seerClaims.length >= 2 && seer) {
    duels += 1
    const real = seerClaims.find((c) => c.playerId === seer.id)
    const fake = seerClaims.find((c) => c.playerId !== seer.id)
    if (real && fake) {
      const exiled = state.voteHistory.map((v) => v.exiledId).filter((x) => x != null)
      const exiledReal = exiled.includes(real.playerId)
      const exiledFake = exiled.includes(fake.playerId)
      if (exiledFake && !exiledReal) duelRight += 1
      else if (exiledReal && !exiledFake) duelWrong += 1
    }
  }

  // 逐日放逐命中
  for (const vh of state.voteHistory) {
    if (vh.exiledId == null) continue
    const hit = state.players.find((p) => p.id === vh.exiledId)?.role === ROLE.WOLF
    const slot = (exileByDay[vh.day] ||= { n: 0, hit: 0 })
    slot.n += 1
    if (hit) slot.hit += 1
  }

  const key = humanRole === 'random' ? 'random' : ROLE_META[humanRole].name
  byRole[key] ||= { wolf: 0, good: 0, n: 0 }
  byRole[key][state.winner] += 1
  byRole[key].n += 1

  // 规则审计：导演说守住了没用，得看每一次用药、每一次开枪的实际记录
  let antidotes = 0
  let poisons = 0
  let selfSaves = 0
  for (const a of state.audit) {
    if (a.kind === 'witch') {
      witchActions += 1
      if (a.usedAntidote && a.usedPoison) {
        problems.push(`#${i} 第 ${a.day} 夜女巫同夜使用了解药与毒药（规则禁止）`)
      }
      if (a.usedAntidote) antidotes += 1
      if (a.usedPoison) poisons += 1
      if (a.savedId === a.witchId) {
        selfSaves += 1
        if (a.day > 1) problems.push(`#${i} 第 ${a.day} 夜女巫自救（规则禁止）`)
      }
    }
    if (a.kind === 'hunter') {
      hunterDeaths += 1
      if (a.reason === 'poison' && a.targetId != null) {
        problems.push(`#${i} 猎人被女巫毒死却仍然开了枪（规则禁止）`)
      }
      if (a.targetId != null) hunterFired += 1
    }
  }
  if (antidotes > 1) problems.push(`#${i} 解药用了 ${antidotes} 次（只应有一次）`)
  if (poisons > 1) problems.push(`#${i} 毒药用了 ${poisons} 次（只应有一次）`)
  if (selfSaves > 1) problems.push(`#${i} 女巫自救了 ${selfSaves} 次（只应在首夜一次）`)
  if (antidotes) antidoteGames += 1
  if (poisons) poisonGames += 1

  // 一致性自检
  const alive = state.players.filter((p) => p.alive)
  if (state.winner === TEAM.GOOD && alive.some((p) => p.role === ROLE.WOLF)) {
    problems.push(`#${i} 判好人胜但场上还有狼`)
  }
  if (state.winner === TEAM.WOLF && alive.some((p) => p.role !== ROLE.WOLF) && alive.some((p) => p.role === ROLE.WOLF)) {
    const gods = alive.filter((p) => ['seer', 'witch', 'hunter'].includes(p.role)).length
    const vill = alive.filter((p) => p.role === ROLE.VILLAGER).length
    const w = alive.filter((p) => p.role === ROLE.WOLF).length
    const good = alive.length - w
    if (gods > 0 && vill > 0 && w < good) {
      problems.push(`#${i} 判狼人胜但条件未满足（神${gods} 民${vill} 狼${w} 好${good}）`)
    }
  }
  for (const s of state.speeches) {
    if (!s.text || !s.text.trim()) problems.push(`#${i} 出现空发言`)
  }
}

const pct = (n, d = done || 1) => `${((n / d) * 100).toFixed(1)}%`

console.log('─'.repeat(52))
console.log(`完成的局数      ${done} / ${TOTAL}`)
console.log(`狼人胜          ${tally.wolf}  (${pct(tally.wolf)})`)
console.log(`好人胜          ${tally.good}  (${pct(tally.good)})`)
console.log(`平均天数        ${(daysTotal / (done || 1)).toFixed(2)}`)
console.log(`平均发言条数    ${(speechTotal / (done || 1)).toFixed(1)}`)
console.log(`放逐命中狼      ${exilesHitWolf} / ${exilesTotal}  (${pct(exilesHitWolf, exilesTotal || 1)})`)
console.log(`预言家首日跳牌  ${seerClaimedDay1} / ${seerGames}  (${pct(seerClaimedDay1, seerGames || 1)})`)
console.log(`预言家对跳局    ${duels}   村庄站对 ${pct(duelRight, duels || 1)}  站错 ${pct(duelWrong, duels || 1)}`)
console.log('逐日放逐命中：')
for (const d of Object.keys(exileByDay).sort((a, b) => a - b)) {
  const s = exileByDay[d]
  console.log(`  第 ${d} 天  ${String(s.hit).padStart(4)} / ${String(s.n).padStart(4)}  (${pct(s.hit, s.n)})`)
}
console.log('─'.repeat(52))
console.log('规则审计（这些规则都真的被触发过，不是"从没发生过所以没违规"）：')
console.log(`  女巫行动夜数    ${witchActions}`)
console.log(`  用过解药的局    ${antidoteGames}  用过毒药的局 ${poisonGames}`)
console.log(`  猎人出局        ${hunterDeaths}  其中开枪 ${hunterFired}（其余为被毒死或压枪）`)
console.log('─'.repeat(52))
console.log('结束方式：')
for (const [k, v] of Object.entries(winReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${pct(v)}   ${k}`)
}
console.log('─'.repeat(52))
console.log('按人类身份拆分：')
for (const [k, v] of Object.entries(byRole)) {
  console.log(`  ${k.padEnd(8, '　')} ${String(v.n).padStart(4)} 局   狼人胜 ${pct(v.wolf, v.n)}`)
}
console.log('─'.repeat(52))

if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`)
  for (const p of [...new Set(problems)].slice(0, 12)) console.log('  · ' + p)
  process.exitCode = 1
} else {
  console.log('全部对局正常收官，未发现异常。')
}
