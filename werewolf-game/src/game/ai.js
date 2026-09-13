/**
 * 机器人决策
 *
 * 设计原则：机器人不"作弊"。每个决策只看它身份允许它知道的东西：
 *   · 狼人知道同伴是谁
 *   · 预言家知道自己验过谁
 *   · 其余人只能看公开信息：谁跳了身份、谁验了谁、谁给谁上票、谁死了
 * 怀疑度模型（computeSuspicion）是好人阵营所有推理的共同底座，
 * 它从真实的狼人杀经验法则出发，而不是随机数。
 */

import { ROLE, TEAM, GOD_ROLES } from './roles.js'
import { compose } from './speech.js'

export const wolvesOf = (state) => state.players.filter((p) => p.role === ROLE.WOLF)
export const aliveOf = (state) => state.players.filter((p) => p.alive)
export const aliveWolves = (state) => wolvesOf(state).filter((p) => p.alive)
export const byId = (state, id) => state.players.find((p) => p.id === id) || null

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const pickFrom = (rng, arr) => arr[Math.floor(rng() * arr.length)]

/* ================================================================
 * 怀疑度模型 —— 好人阵营的"盘逻辑"
 * ================================================================ */

/**
 * 从 viewer 的视角给每个存活玩家打怀疑分。
 * 分数越高越像狼。
 */
export function computeSuspicion(state, viewer, rng = Math.random) {
  const score = {}
  for (const p of state.players) score[p.id] = 0

  const iAmWolf = viewer.role === ROLE.WOLF
  const iAmSeer = viewer.role === ROLE.SEER
  const myTeam = iAmWolf ? wolvesOf(state).map((p) => p.id) : []

  /* --- 视角内的"铁好人"与"铁狼" --- */
  const trusted = new Set([viewer.id])
  const known = new Set()
  if (iAmWolf) myTeam.forEach((id) => trusted.add(id))
  if (iAmSeer) {
    for (const c of viewer.checks || []) {
      if (c.result === ROLE.WOLF) known.add(c.targetId)
      else trusted.add(c.targetId)
    }
  }
  for (const id of known) score[id] += 12

  /* --- 预言家对跳分析 --- */
  const claims = state.claims.filter((c) => c.role === ROLE.SEER)

  /**
   * 信任块：如果场上有一个明显更可信的预言家，好人会结成票块——
   * 信他的金水，出他的查杀。这是好人阵营唯一能对抗"三狼同票"的东西，
   * 也是真实牌局里村庄的运作方式。
   */
  if (!iAmWolf) {
    const ranked = claims
      .map((c) => ({ c, cred: claimCredibility(state, c) }))
      .sort((a, b) => b.cred - a.cred)
    const best = ranked[0]
    const runnerUp = ranked[1]
    if (best) {
      const mine = best.c.playerId === viewer.id
      const margin = runnerUp ? best.cred - runnerUp.cred : 99
      // 只有当我不是预言家本人、且这个声明足够领先时才结块
      if (!iAmSeer && best.cred > 0 && margin >= 0.25) {
        /**
         * 结块不是无条件的。真实牌局里永远有一两个人不认这个预言家，
         * 村庄的纪律性是"大致一致"，不是"全体一致"。
         * 这一条 dissent 是狼人唯一的翻盘空间，也是好人偶尔翻车的原因。
         */
        const belief = clamp(0.6 + best.cred * 0.12, 0.6, 0.94)
        if (rng() < belief) {
          for (const chk of best.c.checks) {
            if (chk.result === ROLE.WOLF) score[chk.targetId] += 8
            else { trusted.add(chk.targetId); score[chk.targetId] -= 3 }
          }
        }
      } else if (mine && runnerUp && claimCredibility(state, runnerUp.c) < 0.4) {
        // 我跳了，对跳的人站不住脚
        score[runnerUp.c.playerId] += 6
      }
    }
  }

  if (claims.length >= 2) {
    // 场上不止一个预言家：至少一个是狼。用行为一致性排序。
    const ranked = claims
      .map((c) => ({ c, cred: claimCredibility(state, c) }))
      .sort((a, b) => b.cred - a.cred)
    ranked.forEach((r, i) => {
      // 可信度最低的那位被重压
      const penalty = i === 0 ? -2.5 : i === ranked.length - 1 ? 7 : 3.5
      score[r.c.playerId] += iAmSeer && r.c.playerId !== viewer.id ? 12 : penalty
    })
    // 谁把票投给了最可信的预言家，谁就脏
    const best = ranked[0].c.playerId
    for (const vh of state.voteHistory) {
      for (const [voter, target] of Object.entries(vh.votes)) {
        if (target === best && Number(voter) !== best && !trusted.has(Number(voter))) {
          score[Number(voter)] += 2.2
        }
      }
    }
  } else if (claims.length === 1) {
    const c = claims[0]
    const claimer = byId(state, c.playerId)
    if (iAmSeer && c.playerId !== viewer.id) {
      score[c.playerId] += 14 // 我是真预言家，跳的那个必是狼
    } else if (claimer && claimer.alive) {
      const nightsOut = state.day - c.day
      // 真预言家跳出来通常活不过两晚；活得越久越可疑
      if (nightsOut >= 2) score[c.playerId] += clamp(nightsOut - 1, 0, 3) * 1.4
      // 他报的金水被夜里刀了，说明狼认这条线是真的
      for (const chk of c.checks) {
        if (chk.result === ROLE.GOOD && !byId(state, chk.targetId)?.alive) {
          score[c.playerId] -= 1.8
        }
      }
    }
    if (!iAmSeer) {
      // 全场只有一个人跳预言家：给他报的查杀加压
      for (const chk of c.checks) {
        if (chk.result === ROLE.WOLF) score[chk.targetId] += 5
      }
    }
  }

  /* --- 投票行为分析（越近的票越说明问题） --- */
  for (const vh of state.voteHistory) {
    const recency = 1 / (1 + Math.max(0, state.day - vh.day - 1) * 0.5)
    for (const [voter, target] of Object.entries(vh.votes)) {
      const v = Number(voter), t = Number(target)
      if (t == null || v === t) continue
      if (trusted.has(t) && !trusted.has(v)) score[v] += 1.6 * recency // 咬了铁好人
      if (known.has(t) && !trusted.has(v)) score[v] += 1.2 * recency // 咬了铁狼
      if (known.has(t) && trusted.has(v)) score[v] -= 1.5 * recency // 投过铁狼，加分
    }
    // 跟票：跟在一个高怀疑的人后面投票，自己也脏
    const entries = Object.entries(vh.votes)
    for (const [a, ta] of entries) {
      for (const [b, tb] of entries) {
        if (a !== b && ta != null && ta === tb && score[Number(a)] > 4) score[Number(b)] += 0.5 * recency
      }
    }
  }

  /* --- 今天的火力集中在哪里 ---
     村子要赢，靠的是多数票落在同一个人身上。
     好人会根据"今天被几个人指认"来收敛目标；被有话语权的人指认，分量更重。 */
  const accusedToday = {}
  for (const s of state.speeches) {
    if (s.day !== state.day || s.targetId == null) continue
    if (s.kind !== 'accuse' && s.kind !== 'wolf-cover') continue
    const weight = 1 + Math.min(1.4, (state.influence[s.playerId] || 0) * 0.25)
    accusedToday[s.targetId] = (accusedToday[s.targetId] || 0) + weight
  }
  for (const [id, w] of Object.entries(accusedToday)) {
    if (trusted.has(Number(id))) continue
    score[Number(id)] += Math.min(4.2, w * 0.85)
  }

  /* --- 发言质量 --- */
  for (const p of state.players) {
    if (!p.alive || p.id === viewer.id) continue
    const mine = state.speeches.filter((s) => s.playerId === p.id)
    if (state.day >= 2 && mine.length <= 1) score[p.id] += 0.9 // 一直划水
    const blessed = state.supported[p.id] || []
    if (blessed.some((d) => score[d] > 5)) score[p.id] += 1.1 // 一直在保一只狼
    const attacking = state.attacked[p.id] || []
    if (attacking.some((d) => trusted.has(d))) score[p.id] += 1.3 // 一直在咬好人
  }

  /* --- 狼人视角：把好人推上去 --- */
  if (iAmWolf) {
    const realSeer = state.claims.find(
      (c) => c.role === ROLE.SEER && !myTeam.includes(c.playerId),
    )
    if (realSeer) score[realSeer.playerId] += 20
    for (const id of trusted) score[id] = -99 // 绝不动自己人
  }

  /* --- 人格噪音：让每个人判断略有差异 --- */
  for (const p of state.players) {
    if (p.id === viewer.id) continue
    score[p.id] += (rng() - 0.5) * 1.6
  }

  return score
}

/**
 * 一个预言家声明的可信度（0 分以下 = 很可疑）。
 *
 * 这里只用公开信息，所以同一时刻全场算出来的分数是一致的——
 * 这正是村庄能收敛到同一个答案的原因。最关键的一条经验法则是：
 * 真预言家验的是"可疑的人"，悍跳狼咬的往往是"村里的好人"。
 */
function claimCredibility(state, claim) {
  let cred = 1
  const claimer = byId(state, claim.playerId)
  if (!claimer) return cred
  const nightsOut = state.day - claim.day
  if (claimer.alive && nightsOut >= 2) cred -= clamp(nightsOut - 1, 0, 3) * 1.5 // 狼不杀自家人
  if (!claimer.alive && claimer.deathReason === 'wolf') cred += 1.5 // 被狼刀，多半是真的
  for (const chk of claim.checks) {
    const t = byId(state, chk.targetId)
    if (!t) continue
    if (chk.result === ROLE.GOOD && !t.alive && t.deathReason === 'wolf') cred += 1.8
    if (chk.result === ROLE.WOLF && !t.alive && t.deathReason === 'vote') cred += 1.2
    if (chk.result === ROLE.WOLF) {
      // 咬一个在村里有信誉的人 → 破绽
      cred -= Math.min(2.8, (state.influence[chk.targetId] || 0) * 0.5)
    } else {
      cred += 0.35 // 真预言家更常给金水
    }
  }
  if (claim.checks.length === 0) cred -= 1
  return cred
}

/* ================================================================
 * 夜间行动
 * ================================================================ */

/** 狼队今晚刀谁 */
export function wolfKillTarget(state, rng = Math.random) {
  const pack = aliveWolves(state)
  const packIds = pack.map((p) => p.id)
  const candidates = aliveOf(state).filter((p) => !packIds.includes(p.id))
  if (!candidates.length) return null

  const scored = candidates.map((p) => {
    let s = rng() * 2
    // 跳预言家的外人 = 真预言家，必刀
    const claim = state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER)
    if (claim) s += 24
    // 被我们查杀过的人暂时留着当靶子
    const pushedAt = state.claims.some(
      (c) => c.playerId !== p.id && c.checks.some((k) => k.targetId === p.id && k.result === ROLE.WOLF),
    )
    if (pushedAt) s -= 4
    // 影响力：发言多、被好人信任的人先处理
    s += state.speeches.filter((sp) => sp.playerId === p.id).length * 0.8
    s += (state.influence[p.id] || 0) * 1.2
    // 威胁大的神职
    if (state.publicClaimsRole[p.id] && GOD_ROLES.includes(state.publicClaimsRole[p.id])) s += 3
    // 上一轮冲我们同伴的人
    const attackedUs = (state.attacked[p.id] || []).some((t) => packIds.includes(t))
    if (attackedUs) s += 4.5
    // 别刀自己
    s -= p.id === pack[0].id ? 0 : 0
    return { p, s }
  })

  scored.sort((a, b) => b.s - a.s)
  return scored[0].p.id
}

/** 预言家今晚验谁 */
export function seerCheckTarget(state, me, rng = Math.random) {
  const checked = new Set((me.checks || []).map((c) => c.targetId))
  const pool = aliveOf(state).filter((p) => p.id !== me.id && !checked.has(p.id))
  if (!pool.length) return null

  const susp = computeSuspicion(state, me, rng)
  const scored = pool.map((p) => {
    let s = susp[p.id] + rng() * 2
    // 对跳的预言家优先验
    const claim = state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER)
    if (claim) s += 10
    return { p, s }
  })
  scored.sort((a, b) => b.s - a.s)
  // 偶尔不按最优来，避免机器人行为过于机械
  const idx = rng() < 0.78 ? 0 : Math.min(scored.length - 1, 1 + Math.floor(rng() * 2))
  return scored[idx].p.id
}

/** 女巫的用药决策 */
export function witchDecision(state, me, rng = Math.random) {
  const victimId = state.nightKill
  const victim = victimId != null ? byId(state, victimId) : null
  const out = { save: false, poison: null, reason: '' }

  const firstNight = state.day === 1

  /* 解药 */
  if (me.antidote && victim) {
    let want = 0
    if (victim.id === me.id) {
      // 首夜可自救，之后不可
      want = firstNight ? 0.95 : 0
      out.reason = 'self'
    } else {
      const claim = state.claims.find((c) => c.playerId === victim.id && c.role === ROLE.SEER)
      if (claim) { want = 0.9; out.reason = 'seer' }
      else if (firstNight) { want = 0.35; out.reason = 'first' }
      else { want = 0.45; out.reason = 'value' }
      // 首夜就死一个无名氏，女巫常常留药
      if (firstNight && rng() < 0.55) want -= 0.5
    }
    out.save = rng() < want
  }

  /* 毒药（同夜不可与解药同用） */
  if (me.poison && !out.save) {
    const susp = computeSuspicion(state, me, rng)
    const alive = aliveOf(state).filter((p) => p.id !== me.id)
    const target = alive.sort((a, b) => susp[b.id] - susp[a.id])[0]
    if (target) {
      const top = susp[target.id]
      const second = alive[1] ? susp[alive[1].id] : -99
      // 有人被公开查杀，或怀疑度明显拉开，才值得动毒
      const flagged = state.claims.some(
        (c) => c.role === ROLE.SEER && c.checks.some((k) => k.result === ROLE.WOLF && k.targetId === target.id),
      )
      const confident = flagged || top - second > 1.2 || top > 8
      if (!firstNight && confident && rng() < 0.68) {
        out.poison = target.id
        out.reason = 'poison'
      }
    }
  }
  return out
}

/** 猎人开枪目标 */
export function hunterTarget(state, me, rng = Math.random) {
  const susp = computeSuspicion(state, me, rng)
  const alive = aliveOf(state).filter((p) => p.id !== me.id)
  if (!alive.length) return null
  alive.sort((a, b) => susp[b.id] - susp[a.id])
  if (susp[alive[0].id] < 2 && rng() < 0.5) return null // 没把握时压枪
  return alive[0].id
}

/* ================================================================
 * 白天决策
 * ================================================================ */

/**
 * 预言家（自称者）今天要不要起跳 / 报验人
 * @returns {null | {check}}
 */
export function seerAnnouncement(state, me, rng = Math.random) {
  const checks = me.checks || []
  if (!checks.length) return null
  const myChecks = state.claims.find((c) => c.playerId === me.id)?.checks?.length || 0
  const pending = checks.slice(myChecks)
  if (!pending.length) return null

  const rivals = state.claims.filter((c) => c.role === ROLE.SEER && c.playerId !== me.id)
  const hasWolf = pending.some((c) => c.result === ROLE.WOLF)

  // 已经跳了 → 每次都报新验人
  if (myChecks > 0) return { check: pending[pending.length - 1] }
  // 有对跳 → 必须出来
  if (rivals.length) return { check: pending[pending.length - 1], counter: rivals[0].playerId }
  // 查到狼 → 一定出来
  if (hasWolf) return { check: pending[pending.length - 1] }
  // 首夜金水也要出来：九人局里预言家默认活不过第二晚，藏着等于把牌带进棺材
  if (state.day === 1) return rng() < 0.9 ? { check: pending[pending.length - 1] } : null
  return { check: pending[pending.length - 1] }
}

/**
 * 狼人是否悍跳预言家
 * @returns {null | {targetId, result}}
 */
export function wolfFakeClaim(state, me, rng = Math.random) {
  const pack = aliveWolves(state)
  // 全队只跳一个
  if (state.claims.some((c) => c.role === ROLE.SEER && pack.some((w) => w.id === c.playerId))) return null
  // 已经有人跳了，看情况对跳
  const rivals = state.claims.filter((c) => c.role === ROLE.SEER)
  const alreadyClaimedMyself = state.claims.some((c) => c.playerId === me.id)
  if (alreadyClaimedMyself) return null

  const base = rivals.length ? 0.8 : state.day === 1 ? 0.5 : 0.25
  // 队伍里谁最像"会跳"的人：发言积极、人格外放
  const naturalLeader = pack.slice().sort((a, b) => {
    const ta = a.persona.tone === 'brash' || a.persona.tone === 'sly' ? 1 : 0
    const tb = b.persona.tone === 'brash' || b.persona.tone === 'sly' ? 1 : 0
    return tb - ta
  })[0]
  if (naturalLeader && naturalLeader.id !== me.id && rng() < 0.6) return null
  if (rng() > base) return null

  const meIds = pack.map((p) => p.id)
  const pool = aliveOf(state).filter((p) => !meIds.includes(p.id))
  if (!pool.length) return null

  const realSeer = rivals.find((c) => !meIds.includes(c.playerId))
  // 有人先跳了 → 对跳互咬，把水搅到最浑
  if (realSeer && rng() < 0.65) {
    return { targetId: realSeer.playerId, result: ROLE.WOLF }
  }
  // 给同伴发金水：悍跳狼最经典的一手，把一个狼塞进好人的信任圈
  const mates = pack.filter((w) => w.id !== me.id)
  if (mates.length && rng() < 0.35) {
    return { targetId: mates[Math.floor(rng() * mates.length)].id, result: ROLE.GOOD }
  }
  // 独自抢先跳 → 咬一个存在感最低的人。
  // 咬村里公认的好人是新手破绽，老练的悍跳狼专挑没人替他说话的下手。
  pool.sort((a, b) => (state.influence[a.id] || 0) - (state.influence[b.id] || 0))
  const weak = pool.slice(0, Math.max(1, Math.ceil(pool.length / 2)))
  return { targetId: weak[Math.floor(rng() * weak.length)].id, result: ROLE.WOLF }
}

/**
 * 悍跳狼第二天起的续跳：继续编造验人结果，维持预言家人设。
 * @returns {null | {check}}
 */
export function wolfFollowUpClaim(state, me, rng = Math.random) {
  const myClaim = state.claims.find((c) => c.playerId === me.id && c.role === ROLE.SEER)
  if (!myClaim) return null
  if (myClaim.day === state.day) return null       // 今天已经报过
  if (state.day - myClaim.day > 3) return null      // 编不下去了
  if (rng() < 0.18) return null
  const packIds = aliveWolves(state).map((p) => p.id)
  const told = new Set(myClaim.checks.map((c) => c.targetId))
  // 同伴也可以被"金水"，这是悍跳狼最值钱的一手
  const pool = aliveOf(state).filter((p) => p.id !== me.id && !told.has(p.id))
  if (!pool.length) return null
  const mates = pool.filter((p) => packIds.includes(p.id))
  if (mates.length && rng() < 0.3) {
    return { check: { targetId: mates[Math.floor(rng() * mates.length)].id, result: ROLE.GOOD, day: state.day - 1, fake: true } }
  }
  const outsiders = pool.filter((p) => !packIds.includes(p.id))
  const good = outsiders.filter((p) => !state.claims.some((c) => c.playerId === p.id && c.role === ROLE.SEER))
  const target = (good.length ? good : outsiders)[0]
  const result = good.length && rng() < 0.7 ? ROLE.GOOD : ROLE.WOLF
  return { check: { targetId: target.id, result, day: state.day - 1, fake: true } }
}

/**
 * 生成一次白天的发言意图
 */
export function decideSpeech(state, me, rng = Math.random) {
  const intent = { kind: 'villager-read' }

  if (me.role === ROLE.SEER) {
    const already = state.claims.some((c) => c.playerId === me.id)
    const ann = seerAnnouncement(state, me, rng)
    if (ann) {
      return ann.counter
        ? { kind: 'counter-claim', rival: byId(state, ann.counter), checks: me.checks }
        : { kind: already ? 'report-check' : 'claim-seer', check: ann.check, checks: me.checks }
    }
  }

  if (me.role === ROLE.WOLF) {
    const followUp = wolfFollowUpClaim(state, me, rng)
    if (followUp) return { kind: 'report-check', check: followUp.check, checks: [followUp.check], fake: true }
    const fake = wolfFakeClaim(state, me, rng)
    if (fake) {
      const checks = [{ targetId: fake.targetId, result: fake.result, day: state.day - 1, fake: true }]
      return { kind: 'claim-seer', checks, fake: true }
    }
    const susp = computeSuspicion(state, me, rng)
    const alive = aliveOf(state).filter((p) => p.id !== me.id && p.role !== ROLE.WOLF)
    alive.sort((a, b) => susp[b.id] - susp[a.id])
    const push = alive[0]
    const kind = rng() < 0.55 ? 'accuse' : 'wolf-cover'
    return { kind, target: push, voteTarget: push }
  }

  /* 好人阵营：先看自己有没有被查杀，再决定站边 */
  const accuser = state.claims.find(
    (c) => c.role === ROLE.SEER && c.checks.some((k) => k.targetId === me.id && k.result === ROLE.WOLF),
  )
  if (accuser && byId(state, accuser.playerId)?.alive) {
    return { kind: 'defend-self', accuser: byId(state, accuser.playerId) }
  }

  const susp = computeSuspicion(state, me, rng)
  const alive = aliveOf(state).filter((p) => p.id !== me.id)
  alive.sort((a, b) => susp[b.id] - susp[a.id])
  const top = alive[0]

  // 站边一个可信的预言家
  const claims = state.claims.filter((c) => c.role === ROLE.SEER)
  if (claims.length) {
    const ranked = claims
      .map((c) => ({ c, cred: claimCredibility(state, c) }))
      .sort((a, b) => b.cred - a.cred)
    const best = byId(state, ranked[0].c.playerId)
    if (best && best.alive && susp[best.id] < 2 && rng() < 0.4) {
      return { kind: 'support', target: best, voteTarget: top }
    }
  }
  return { kind: top && susp[top.id] > 3 ? 'accuse' : 'villager-read', target: top, voteTarget: top }
}

/** 白天投票 */
export function decideVote(state, me, rng = Math.random) {
  const alive = aliveOf(state).filter((p) => p.id !== me.id)
  if (!alive.length) return null

  if (me.role === ROLE.WOLF) {
    const packIds = aliveWolves(state).map((p) => p.id)
    const pool = alive.filter((p) => !packIds.includes(p.id))
    if (!pool.length) return null
    // 全队集中票型，但真狼也会有自己的判断，不会每一票都像复制粘贴
    if (state.wolfPush && pool.some((p) => p.id === state.wolfPush) && rng() > 0.2) return state.wolfPush
    const susp = computeSuspicion(state, me, rng)
    pool.sort((a, b) => susp[b.id] - susp[a.id])
    return pool[0].id
  }

  const susp = computeSuspicion(state, me, rng)

  /* 好人的票最该有纪律：信了哪个预言家，就出他给的查杀。 */
  if (me.role !== ROLE.SEER) {
    const claims = state.claims.filter((c) => c.role === ROLE.SEER)
    if (claims.length) {
      const ranked = claims
        .map((c) => ({ c, cred: claimCredibility(state, c) }))
        .sort((a, b) => b.cred - a.cred)
      const best = ranked[0]
      const margin = ranked[1] ? best.cred - ranked[1].cred : 99
      if (best.cred > 0 && margin >= 0.25) {
        const kill = best.c.checks.find(
          (k) => k.result === ROLE.WOLF && alive.some((p) => p.id === k.targetId),
        )
        if (kill && rng() < 0.74) return kill.targetId
      }
    }
  }

  const sorted = alive.slice().sort((a, b) => susp[b.id] - susp[a.id])
  // 首轮信息少，允许一点随机性
  if (state.day === 1 && rng() < 0.2 && sorted.length > 1) return sorted[1].id
  return sorted[0].id
}

/** 狼队今天集中票给谁 */
export function chooseWolfPush(state, rng = Math.random) {
  const pack = aliveWolves(state)
  const packIds = pack.map((p) => p.id)
  const pool = aliveOf(state).filter((p) => !packIds.includes(p.id))
  if (!pool.length || !pack.length) return null

  const fake = state.claims.find((c) => c.role === ROLE.SEER && packIds.includes(c.playerId))
  const realSeer = state.claims.find((c) => c.role === ROLE.SEER && !packIds.includes(c.playerId))

  // 队里有人悍跳 → 把真预言家顶出去，逼全村站队
  if (fake && realSeer && byId(state, realSeer.playerId)?.alive) return realSeer.playerId

  // 没人悍跳 → 顺着村里的火力投票，让放逐落在好人身上，
  // 而不是把三票浪费在一个全村都信的预言家身上
  const susp = computeSuspicion(state, pack[0], rng)
  pool.sort(
    (a, b) =>
      (susp[b.id] || 0) - (susp[a.id] || 0) ||
      (state.influence[b.id] || 0) - (state.influence[a.id] || 0),
  )
  return pool[0].id
}

/* ================================================================
 * 辅助
 * ================================================================ */

export function buildSpeech(state, me, intent, rng = Math.random) {
  return compose(state, me, intent, rng)
}
