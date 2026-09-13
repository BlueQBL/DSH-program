/**
 * 公平性审计：机器人到底有没有偷看底牌？
 *
 * 这是本项目唯一一个"证明"性质的测试，思路很简单：
 *
 *   如果一名玩家真的只能看到公开信息，那么把**他不可能知道的那部分信息换掉**，
 *   他的决定必须一字不变。
 *
 * 具体做法：在一局进行中的真实局面里，把所有"该玩家无从得知身份的其他人"
 * 的角色随机重排一遍——公开事实（谁跳了什么、谁投了谁、谁死了、谁说了什么）
 * 全部保持不动——然后分别调用同一个决策函数，比较输出。
 *
 *   输出不一致 → 这个决策读了它不该读的东西，即作弊。
 *
 * 排除项（这些是玩家**有权知道**的，重排时必须钉住）：
 *   · 自己
 *   · 狼人同伴（狼人本来就认识）
 *   · 预言家验过的人（虽然身份变了，但"验出来的结果"是他自己的记忆）
 *
 *   npm run fairness
 */

import { createMatch, createRng, createRng as mk } from '../src/game/setup.js'
import { runGame } from '../src/game/director.js'
import { answerAsHuman } from '../src/game/autopilot.js'
import * as AI from '../src/game/ai.js'
import { ROLE, ROLE_META } from '../src/game/roles.js'

const GAMES = Number(process.argv[2] || 60)
const SEED = 0x5eed

const clone = (o) => JSON.parse(JSON.stringify(o))

/** 把这个局面里"观察者无从得知"的角色重排一遍 */
function permuteUnknown(viewerId, state, rng) {
  const s = clone(state)
  const v = s.players.find((p) => p.id === viewerId)
  if (!v) return null

  const pinned = new Set([v.id])
  if (v.role === ROLE.WOLF) {
    for (const p of s.players) if (p.role === ROLE.WOLF) pinned.add(p.id)
  }
  if (v.role === ROLE.SEER) {
    for (const c of v.checks || []) pinned.add(c.targetId)
  }

  const movable = s.players.filter((p) => !pinned.has(p.id))
  if (movable.length < 2) return null

  const roles = movable.map((p) => p.role)
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[roles[i], roles[j]] = [roles[j], roles[i]]
  }
  movable.forEach((p, i) => { p.role = roles[i] })
  return s
}

/** 把决策结果压成可比较的形状 */
function norm(x) {
  if (x == null) return null
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x
  if (Array.isArray(x)) return x.map(norm)
  if (typeof x === 'object') {
    if (typeof x.id === 'number' && x.seat !== undefined) return { player: x.id } // 玩家对象 → 只比 id
    const out = {}
    for (const k of Object.keys(x).sort()) out[k] = norm(x[k])
    return out
  }
  return String(x)
}

/** 对某个玩家跑一遍所有决策，返回可比对的字符串 */
function decisionsOf(state, viewerId, over = {}) {
  const v = state.players.find((p) => p.id === viewerId)
  if (!v || !v.alive) return null
  const R = () => createRng(SEED)
  const out = {}

  try {
    const susp = AI.computeSuspicion(state, v, R())
    out.suspicion = Object.keys(susp).sort((a, b) => a - b).map((k) => `${k}:${susp[k].toFixed(6)}`).join(',')
  } catch (e) { out.suspicion = 'ERR:' + e.message }

  const wrap = (name, fn) => {
    try { out[name] = JSON.stringify(norm(fn())) } catch (e) { out[name] = 'ERR:' + e.message }
  }

  wrap('vote', () => (over.vote || AI.decideVote)(state, v, R()))
  wrap('speech', () => {
    const it = AI.decideSpeech(state, v, R())
    return { kind: it.kind, target: it.target?.id ?? null, voteTarget: it.voteTarget?.id ?? null }
  })
  if (v.role === ROLE.SEER) wrap('seerCheck', () => AI.seerCheckTarget(state, v, R()))
  if (v.role === ROLE.HUNTER) wrap('hunterShot', () => AI.hunterTarget(state, v, R()))
  if (v.role === ROLE.WITCH) {
    wrap('witch', () => {
      const d = AI.witchDecision(state, v, R())
      return { save: d.save, poison: d.poison }
    })
  }
  if (v.role === ROLE.WOLF) wrap('wolfKill', () => AI.wolfKillTarget(state, R()))

  return out
}

/* ================================================================
 * 跑
 * ================================================================ */

const SELFTEST = process.argv.includes('--selftest')

/**
 * 故意作弊的投票函数：直接翻底牌，专挑活着的狼投票。
 * 这是用来验证"审计本身有效"的对照组——如果连它都抓不出来，
 * 那上面的 ✅ 就没有任何意义。
 */
const cheatingVote = (state, v) => {
  const alive = state.players.filter((p) => p.alive && p.id !== v.id)
  const wolf = alive.find((p) => p.role === ROLE.WOLF)
  return wolf ? wolf.id : alive[0]?.id ?? null
}

const overrides = SELFTEST && process.argv.includes('--cheat-vote') ? { vote: cheatingVote } : {}

async function collectStates() {
  const states = []
  for (let g = 0; g < GAMES; g++) {
    const rng = createRng(9001 + g * 131)
    const state = createMatch({ humanRole: 'random', rng })
    let beats = 0
    const snaps = []
    const host = {
      wait: () => {
        beats++
        // 隔一段时间抓一张快照，覆盖夜晚与白天各种局面
        if (beats % 5 === 0 && snaps.length < 14 && state.day <= 4) {
          try { snaps.push(clone(state)) } catch { /* 忽略 */ }
        }
        return Promise.resolve()
      },
      ask: (req) => Promise.resolve(answerAsHuman(state, req, rng)),
      reveal: () => Promise.resolve(),
      sfx: () => {},
    }
    await runGame(state, host)
    states.push(...snaps)
  }
  return states
}

console.log(`公平性审计：${GAMES} 局中抓取局面快照，逐个玩家重排未知身份后比对决策`)
if (Object.keys(overrides).length) console.log('⚠ 自检模式：已植入一个偷看底牌的投票函数作为对照组')
const states = await collectStates()
console.log(`快照 ${states.length} 张`)

let checked = 0
let skipped = 0
const violations = []
const perRole = {}

for (const snap of states) {
  for (const player of snap.players) {
    if (!player.alive) continue
    const before = decisionsOf(snap, player.id, overrides)
    if (!before) { skipped++; continue }

    const after = (() => {
      const p = permuteUnknown(player.id, snap, createRng(SEED ^ (player.id * 7919)))
      return p ? decisionsOf(p, player.id, overrides) : null
    })()
    if (!after) { skipped++; continue }

    checked++
    const rn = ROLE_META[player.role].name
    perRole[rn] = (perRole[rn] || 0) + 1

    for (const key of Object.keys(before)) {
      if (before[key] !== after[key]) {
        violations.push(
          `局面 day=${snap.day} ${player.seat + 1}号（${rn}）的决策 "${key}" 依赖了隐藏身份：\n` +
          `      原局面 → ${before[key]}\n      重排后 → ${after[key]}`,
        )
      }
    }
  }
}

console.log('─'.repeat(60))
console.log(`参与比对的（局面 × 玩家）组合：${checked}    跳过：${skipped}`)
console.log('按身份分布：')
for (const [k, v] of Object.entries(perRole)) console.log(`  ${k.padEnd(8, '　')} ${v}`)
console.log('─'.repeat(60))

/* 自检：植入的作弊必须被抓到，否则说明这套审计是瞎的 */
if (Object.keys(overrides).length) {
  if (violations.length > 0) {
    console.log(`✅ 自检通过：植入的作弊被抓出 ${violations.length} 处，审计有效。`)
    console.log(`   （示例）${violations[0].split('\n')[0]}`)
  } else {
    console.log('❌ 自检失败：植入的作弊没有被抓出来，这套审计不可信。')
    process.exitCode = 1
  }
} else if (violations.length) {
  console.log(`❌ 发现 ${violations.length} 处作弊：`)
  for (const v of [...new Set(violations)].slice(0, 10)) console.log('  · ' + v)
  process.exitCode = 1
} else {
  console.log('✅ 全部决策在隐藏身份重排后完全不变 —— 没有任何机器人偷看底牌。')
}
