/**
 * 开局：发牌、建席位、初始化面板
 */

import { DECK_9, PERSONAS, ROLE, ROLE_META, TEAM, GOD_ROLES } from './roles.js'

let uid = 0

export function createRng(seed) {
  let s = seed >>> 0 || (Date.now() >>> 0)
  return function rng() {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function shuffle(list, rng) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * @param {object} opts
 *  - humanRole: ROLE.* | 'random'
 *  - rng: ()=>number
 */
export function createMatch({ humanRole = 'random', rng = Math.random } = {}) {
  const deck = shuffle(DECK_9, rng)

  const roles = deck.slice()
  if (humanRole && humanRole !== 'random') {
    const at = roles.indexOf(humanRole)
    if (at >= 0) {
      // 把想要的牌换到第 0 位（人类席位）
      ;[roles[0], roles[at]] = [roles[at], roles[0]]
    }
  }

  const personas = shuffle(PERSONAS, rng)

  const players = Array.from({ length: 9 }, (_, i) => {
    const isHuman = i === 0
    const persona = isHuman
      ? { name: '你', epithet: '坐在正下方', tone: 'steady', hue: 190 }
      : personas[i - 1]
    return {
      id: i,
      seat: i,
      name: persona.name,
      persona,
      hue: persona.hue,
      role: roles[i],
      team: ROLE_META[roles[i]].team,
      alive: true,
      isHuman,
      deathDay: null,
      deathReason: null,
      deathNote: '',
      /* 私密状态 */
      checks: [],                 // 预言家：验人记录
      antidote: true,             // 女巫
      poison: true,               // 女巫
      /* 公开行为 */
      claimsMade: 0,
      spokeToday: false,
      votedToday: false,
      swayed: 0,
    }
  })

  return {
    id: `m${++uid}`,
    seed: Math.floor(rng() * 1e9),
    rng,
    day: 1,
    phase: 'lobby',        // lobby | night | dawn | day | vote | over
    phaseLabel: '等待开局',
    nightStep: null,       // wolf | seer | witch
    nightKill: null,
    poisonTarget: null,
    players,
    humanId: 0,
    log: [],
    claims: [],            // { playerId, role, day, checks:[{targetId,result,day,fake}] }
    speeches: [],          // { id, playerId, day, text, kind, at }
    voteHistory: [],       // { day, votes:{voterId:targetId|null}, exiledId, tally }
    deaths: [],            // { playerId, day, reason }
    supported: {},         // supporterId -> [被支持的 targetId]
    attacked: {},          // attackerId  -> [被指认的 targetId]
    influence: {},         // playerId -> 场上话语权
    publicClaimsRole: {},  // playerId -> 公开宣称的身份
    wolfPush: null,        // 狼队本日统一票型
    winner: null,          // 'wolf' | 'good'
    winReason: '',
    revealAll: false,
    startedAt: Date.now(),
    endedAt: null,
    turn: null,            // 当前行动者 id
    awaiting: null,        // 人类玩家的待办
    currentSpeech: null,   // 正在被说出口的那句话
    lastTally: null,       // 最近一次投票统计
    audit: [],             // 规则审计：每一次用药、每一次开枪都留底
  }
}

export function logEntry(state, kind, text, extra = {}) {
  const entry = { id: state.log.length + 1, day: state.day, phase: state.phase, kind, text, ...extra }
  state.log.push(entry)
  return entry
}

export function claimOf(state, playerId) {
  return state.claims.find((c) => c.playerId === playerId) || null
}

export function seerClaims(state) {
  return state.claims.filter((c) => c.role === ROLE.SEER)
}

/* ================================================================
 * 胜负判定
 * ================================================================ */

export function checkWin(state) {
  const alive = state.players.filter((p) => p.alive)
  const aliveWolves = alive.filter((p) => p.role === ROLE.WOLF)
  const aliveGods = alive.filter((p) => GOD_ROLES.includes(p.role))
  const aliveVillagers = alive.filter((p) => p.role === ROLE.VILLAGER)

  if (aliveWolves.length === 0) {
    return { winner: TEAM.GOOD, reason: '三只狼全部出局，村子活下来了。' }
  }
  if (aliveGods.length === 0) {
    return { winner: TEAM.WOLF, reason: '神职全部出局——狼人屠神成功。' }
  }
  if (aliveVillagers.length === 0) {
    return { winner: TEAM.WOLF, reason: '平民全部出局——狼人屠民成功。' }
  }
  if (aliveWolves.length >= alive.length - aliveWolves.length) {
    return { winner: TEAM.WOLF, reason: '狼人数量已不少于好人，投票再也拦不住他们了。' }
  }
  return null
}

/** 死亡结算（唯一入口，负责记日志与胜负） */
export function killPlayer(state, playerId, reason, note = '') {
  const p = state.players.find((x) => x.id === playerId)
  if (!p || !p.alive) return null
  p.alive = false
  p.deathDay = state.day
  p.deathReason = reason
  p.deathNote = note
  state.deaths.push({ playerId, day: state.day, reason, note })
  return p
}
