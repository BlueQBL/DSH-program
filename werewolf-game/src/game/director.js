/**
 * 导演：一局狼人杀的完整流程
 *
 * 用 async/await 写成一条线性剧本，人类玩家的操作通过 host.ask() 挂起等待。
 * 每一个 await 都是一个"节拍"，host.wait 负责节奏与倍速，host.ask 负责交互。
 */

import { ROLE, ROLE_META, TEAM, GOD_ROLES } from './roles.js'
import * as AI from './ai.js'
import { compose, seatLabel, fullLabel } from './speech.js'
import { checkWin, killPlayer, logEntry } from './setup.js'

const BEAT = {
  nightFall: 2200,
  step: 1300,
  reveal: 1900,
  speak: 700,
  between: 700,
  vote: 800,
  dawn: 1700,
  result: 2200,
  over: 900,
}

export class Aborted extends Error {}

/* ================================================================
 * 工具
 * ================================================================ */

const aliveList = (state) => state.players.filter((p) => p.alive)
const aliveOthers = (state, id) => aliveList(state).filter((p) => p.id !== id)
const P = (state, id) => state.players.find((p) => p.id === id)
const mark = (p) => (p.isHuman ? '你' : `${p.seat + 1}号${p.name}`)

function recordSpeech(state, p, text, intent) {
  state.speeches.push({
    id: state.speeches.length + 1,
    playerId: p.id,
    day: state.day,
    text,
    kind: intent.kind,
    targetId: intent.target?.id ?? null,
  })
  p.spokeToday = true
  state.influence[p.id] = (state.influence[p.id] || 0) + 0.7
  if (intent.target) {
    ;(state.attacked[p.id] ||= []).push(intent.target.id)
  }
  if (intent.kind === 'support' && intent.target) {
    ;(state.supported[p.id] ||= []).push(intent.target.id)
    state.influence[intent.target.id] = (state.influence[intent.target.id] || 0) + 0.9
  }
  // 站边会让被支持的人更有话语权；被指认则会掉一点
  if (intent.kind === 'accuse' && intent.target) {
    state.influence[intent.target.id] = (state.influence[intent.target.id] || 0) - 0.3
  }
}

/** 把预言家声明登记到公开面板 */
function publishSeerClaim(state, p, checks, fake = false) {
  let claim = state.claims.find((c) => c.playerId === p.id && c.role === ROLE.SEER)
  if (!claim) {
    claim = { playerId: p.id, role: ROLE.SEER, day: state.day, checks: [], fake }
    state.claims.push(claim)
  }
  claim.checks = checks.map((c) => ({ ...c, fake }))
  claim.day = Math.min(claim.day, state.day)
  state.publicClaimsRole[p.id] = ROLE.SEER
  p.claimsMade = (p.claimsMade || 0) + 1
  // 起跳会让人成为焦点
  state.influence[p.id] = (state.influence[p.id] || 0) + 1.6
}

/* ================================================================
 * 主循环
 * ================================================================ */

export async function runGame(state, host) {
  try {
    logEntry(state, 'system', `第 ${state.day} 天。9 人标准局：3 狼人、预言家、女巫、猎人、3 平民。`)

    while (!state.winner) {
      if (state.day > 40) {
        // 兜底：正常对局不可能走到这里
        state.winner = TEAM.GOOD
        state.winReason = '对局超过了天数上限，判定好人获胜。'
        state.phase = 'over'
        state.phaseLabel = '好人胜利'
        state.revealAll = true
        break
      }
      await night(state, host)
      if (await finishIfOver(state, host)) return
      await dawn(state, host)
      if (await finishIfOver(state, host)) return
      await dayPhase(state, host)
      if (await finishIfOver(state, host)) return
      state.day += 1
      resetDaily(state)
    }
  } catch (err) {
    if (err instanceof Aborted) return
    throw err
  }
}

function resetDaily(state) {
  state.players.forEach((p) => { p.spokeToday = false; p.votedToday = false })
  // 注意：voteHistory 要一直留着。票型是好人最重要的线索，
  // 清掉它等于让所有人失忆——swing 票、跟票、保人全都看不出来了。
  state.wolfPush = null
}

async function finishIfOver(state, host) {
  const result = checkWin(state)
  if (!result) return false
  state.winner = result.winner
  state.winReason = result.reason
  state.phase = 'over'
  state.phaseLabel = result.winner === TEAM.WOLF ? '狼人胜利' : '好人胜利'
  state.endedAt = Date.now()
  state.revealAll = true
  state.awaiting = null
  state.turn = null
  logEntry(state, 'system', `${result.reason}`, { highlight: true })
  host.sfx?.(result.winner === TEAM.WOLF ? 'wolf-win' : 'good-win')
  await host.wait(BEAT.over)
  return true
}

/* ================================================================
 * 夜
 * ================================================================ */

async function night(state, host) {
  state.phase = 'night'
  state.phaseLabel = `第 ${state.day} 夜 · 天黑请闭眼`
  state.nightKill = null
  state.poisonTarget = null
  state.turn = null
  logEntry(state, 'phase', `天黑请闭眼。`)
  host.sfx?.('night')
  await host.wait(BEAT.nightFall)

  /* ---- 狼人 ---- */
  state.nightStep = 'wolf'
  state.phaseLabel = '狼人行动'
  logEntry(state, 'night', '狼人睁眼，互相确认身份，商量今晚要杀的人。')
  const wolves = AI.aliveWolves(state)
  const humanWolf = wolves.find((w) => w.isHuman)
  const nonWolfPool = aliveList(state).filter((p) => p.role !== ROLE.WOLF).map((p) => p.id)

  let killId = null
  if (humanWolf && nonWolfPool.length) {
    const mates = wolves.filter((w) => !w.isHuman)
    const suggestion = AI.wolfKillTarget(state, state.rng)
    const ans = await host.ask({
      kind: 'pick-one',
      role: ROLE.WOLF,
      title: '今晚猎杀谁？',
      hint: mates.length
        ? `同伴：${mates.map((m) => mark(m)).join('、')}`
        : '你是唯一的狼。',
      suggestion: suggestion != null ? `${seatLabel(P(state, suggestion))}（同伴倾向）` : '',
      candidates: nonWolfPool,
      allowSkip: false,
    })
    killId = ans.playerId
    state.turn = humanWolf.id
    logEntry(state, 'night', `狼队商定：今晚击杀 ${seatLabel(P(state, killId))}。`, { secret: true, actorId: humanWolf.id })
    await host.wait(BEAT.step)
  } else if (wolves.length) {
    killId = AI.wolfKillTarget(state, state.rng)
    state.turn = wolves[0].id
    await host.wait(BEAT.step)
  } else {
    await host.wait(BEAT.step)
  }
  state.nightKill = killId
  state.turn = null

  /* ---- 预言家 ---- */
  state.nightStep = 'seer'
  state.phaseLabel = '预言家行动'
  const seer = aliveList(state).find((p) => p.role === ROLE.SEER)
  if (seer) {
    logEntry(state, 'night', '预言家睁眼，选择一人查验。')
    const checked = new Set((seer.checks || []).map((c) => c.targetId))
    const pool = aliveOthers(state, seer.id).filter((p) => !checked.has(p.id)).map((p) => p.id)
    let checkId = null
    if (pool.length) {
      if (seer.isHuman) {
        state.turn = seer.id
        const ans = await host.ask({
          kind: 'pick-one',
          role: ROLE.SEER,
          title: '今晚查验谁？',
          hint: checked.size ? `已验过：${[...checked].map((i) => seatLabel(P(state, i))).join('、')}` : '这是你的第一次查验。',
          candidates: pool,
          allowSkip: false,
        })
        checkId = ans.playerId
      } else {
        checkId = AI.seerCheckTarget(state, seer, state.rng)
      }
      if (checkId != null) {
        const target = P(state, checkId)
        const result = target.role === ROLE.WOLF ? ROLE.WOLF : ROLE.GOOD
        seer.checks.push({ targetId: checkId, result, day: state.day })
        if (seer.isHuman) {
          await host.reveal({
            tone: result === ROLE.WOLF ? 'blood' : 'moss',
            title: `${seatLabel(target)} · ${result === ROLE.WOLF ? '狼人' : '好人'}`,
            subtitle: result === ROLE.WOLF ? '查杀' : '金水',
          })
        }
      }
    }
    state.turn = null
    await host.wait(BEAT.step)
  } else {
    await host.wait(BEAT.step / 2)
  }

  /* ---- 女巫 ---- */
  state.nightStep = 'witch'
  state.phaseLabel = '女巫行动'
  const witch = aliveList(state).find((p) => p.role === ROLE.WITCH)
  if (witch) {
    logEntry(state, 'night', '女巫睁眼。')
    const victim = killId != null ? P(state, killId) : null
    const canSelfSave = state.day === 1
    let save = false
    let poison = null

    if (witch.isHuman) {
      state.turn = witch.id
      const canSave = witch.antidote && !!victim && (victim.id !== witch.id || canSelfSave)
      const canPoison = witch.poison
      if (!victim && !canPoison) {
        logEntry(state, 'night', '今晚无人倒牌，你手上的药还在。', { secret: true, actorId: witch.id })
      } else {
        const ans = await host.ask({
          kind: 'witch',
          role: ROLE.WITCH,
          title: '今晚，你要用药吗？',
          hint: victim
            ? `今晚倒牌的是 ${seatLabel(victim)}${victim.id === witch.id ? '（你自己）' : ''}。`
            : '今晚没人被刀。',
          antidote: witch.antidote,
          poison: witch.poison,
          canSave,
          canPoison,
          saveBlockedReason: !witch.antidote
            ? '解药已经用掉了'
            : victim && victim.id === witch.id && !canSelfSave
              ? '女巫从第二夜起不能自救'
              : '',
          candidates: canPoison ? aliveOthers(state, witch.id).map((p) => p.id) : [],
        })
        save = !!ans.save
        poison = ans.poison ?? null
      }
      state.turn = null
    } else {
      const d = AI.witchDecision(state, witch, state.rng)
      save = d.save
      poison = d.poison
    }

    let savedId = null
    let poisonedId = null
    if (save && witch.antidote && victim) {
      witch.antidote = false
      state.nightKill = null
      savedId = victim.id
      logEntry(state, 'night', `女巫用了解药，${seatLabel(victim)}活了下来。`, {
        secret: true, actorId: witch.id,
      })
      if (witch.isHuman) await host.reveal({ tone: 'moss', title: '解药已用', subtitle: `${seatLabel(victim)} 被救回` })
    }
    if (poison != null && witch.poison) {
      witch.poison = false
      state.poisonTarget = poison
      poisonedId = poison
      logEntry(state, 'night', `女巫用了毒药，目标是 ${seatLabel(P(state, poison))}。`, {
        secret: true, actorId: witch.id,
      })
      if (witch.isHuman) await host.reveal({ tone: 'blood', title: '毒药已用', subtitle: `${seatLabel(P(state, poison))} 中毒` })
    }
    // 留底，供 npm run verify 审计规则是否被守住
    state.audit.push({
      day: state.day, kind: 'witch', witchId: witch.id,
      savedId, poisonedId,
      usedAntidote: savedId != null, usedPoison: poisonedId != null,
    })
    await host.wait(BEAT.step)
  } else {
    await host.wait(BEAT.step / 2)
  }

  state.nightStep = null
}

/* ================================================================
 * 天亮
 * ================================================================ */

async function dawn(state, host) {
  state.phase = 'dawn'
  state.phaseLabel = `第 ${state.day} 天 · 天亮了`
  host.sfx?.('dawn')
  logEntry(state, 'phase', '天亮了。')
  await host.wait(BEAT.dawn)

  const dead = []
  if (state.nightKill != null) {
    const p = killPlayer(state, state.nightKill, 'wolf', '夜间被狼人击杀')
    if (p) dead.push({ player: p, reason: 'wolf' })
  }
  if (state.poisonTarget != null) {
    const p = killPlayer(state, state.poisonTarget, 'poison', '被女巫毒杀')
    if (p) dead.push({ player: p, reason: 'poison' })
  }

  if (!dead.length) {
    state.phaseLabel = '平安夜'
    logEntry(state, 'dawn', '昨晚是平安夜，没有人出局。', { highlight: true })
  } else {
    for (const d of dead) {
      logEntry(state, 'death', `${fullLabel(d.player)} 倒牌了。`, { playerId: d.player.id, highlight: true })
    }
    if (dead.length === 1) {
      state.phaseLabel = `昨晚，${seatLabel(dead[0].player)} 倒牌`
    } else {
      state.phaseLabel = `昨晚倒了 ${dead.map((d) => seatLabel(d.player)).join('、')}`
    }
  }
  host.sfx?.(dead.length ? 'death' : 'calm')
  await host.wait(BEAT.reveal)

  // 猎人开枪（被毒死不能开枪）
  for (const d of dead) {
    if (d.player.role === ROLE.HUNTER && d.reason !== 'poison') {
      await hunterShot(state, host, d.player)
      if (state.winner) return
    }
  }

  // 遗言（首日出局者）
  for (const d of dead) {
    if (state.day === 1) await lastWords(state, host, d.player)
  }
}

/* ================================================================
 * 猎人开枪
 * ================================================================ */

async function hunterShot(state, host, hunter) {
  state.phaseLabel = '猎人开枪'
  state.currentSpeech = null
  logEntry(state, 'system', `${mark(hunter)} 是猎人，枪口还能响一次。`, { highlight: true })
  host.sfx?.('gun')
  await host.wait(BEAT.reveal)

  const pool = aliveList(state).filter((p) => p.id !== hunter.id).map((p) => p.id)
  if (!pool.length) return

  let targetId = null
  if (hunter.isHuman) {
    state.turn = hunter.id
    const ans = await host.ask({
      kind: 'pick-one',
      role: ROLE.HUNTER,
      title: '开枪带走谁？',
      hint: '你可以压枪，把机会留给下一轮——但你已经出局了。',
      candidates: pool,
      allowSkip: true,
      skipLabel: '不开枪',
    })
    targetId = ans.playerId
    state.turn = null
  } else {
    targetId = AI.hunterTarget(state, hunter, state.rng)
  }

  if (targetId != null) {
    const t = killPlayer(state, targetId, 'hunter', '被猎人开枪带走')
    logEntry(state, 'death', `砰——${fullLabel(t)} 被猎人带走了。`, { playerId: t.id, highlight: true })
    host.sfx?.('death')
    await host.wait(BEAT.reveal)
  } else {
    logEntry(state, 'system', '猎人压枪，没有开火。')
    await host.wait(BEAT.step)
  }
  state.audit.push({ day: state.day, kind: 'hunter', shooterId: hunter.id, targetId, reason: hunter.deathReason })
}

/* ================================================================
 * 遗言
 * ================================================================ */

async function lastWords(state, host, who) {
  let text
  if (who.isHuman) {
    const ans = await host.ask({
      kind: 'speak',
      role: who.role,
      title: '你的遗言',
      hint: '说给活着的人听。',
      targets: aliveList(state).filter((p) => p.id !== who.id).map((p) => p.id),
      kinds: speakKinds(who.role),
      lastWords: true,
    })
    text = ans.text || compose(state, who, { kind: 'last-words' }, state.rng)
  } else {
    const checks = who.role === ROLE.SEER ? who.checks : null
    text = compose(state, who, { kind: 'last-words', checks }, state.rng)
  }
  recordSpeech(state, who, text, { kind: 'last-words' })
  state.currentSpeech = { playerId: who.id, text, kind: 'last-words', day: state.day, seq: Date.now() }
  logEntry(state, 'speech', `${mark(who)}：${text}`, { playerId: who.id, speech: true })
  await host.wait(BEAT.speak + text.length * 26)
  state.currentSpeech = null
}

/* ================================================================
 * 白天
 * ================================================================ */

async function dayPhase(state, host) {
  state.phase = 'day'
  state.phaseLabel = `第 ${state.day} 天 · 发言`
  logEntry(state, 'phase', '白天，开始发言。')
  await host.wait(BEAT.step)

  /* 狼队今天集中票型 */
  state.wolfPush = AI.chooseWolfPush(state, state.rng)

  /* 发言顺序：从上一个倒牌的人的下一位开始 */
  const lastDeath = state.deaths[state.deaths.length - 1]
  const startSeat = lastDeath ? (lastDeath.playerId + 1) % 9 : 0
  const order = []
  for (let i = 0; i < 9; i++) {
    const p = state.players[(startSeat + i) % 9]
    if (p.alive) order.push(p)
  }

  for (const p of order) {
    await speak(state, host, p)
    if (state.winner) return
  }

  await votePhase(state, host)
}

async function speak(state, host, p) {
  state.turn = p.id
  state.phaseLabel = `第 ${state.day} 天 · ${mark(p)} 发言`
  let text, intent

  if (p.isHuman) {
    const ans = await host.ask({
      kind: 'speak',
      role: p.role,
      title: '轮到你发言',
      hint: '挑一个立场，机器人才听得懂；也可以自己写一段话。',
      targets: aliveList(state).filter((x) => x.id !== p.id).map((x) => x.id),
      kinds: speakKinds(p.role, state, p),
      allowSkip: true,
    })
    intent = ans.intent
    text = ans.text
  } else {
    intent = AI.decideSpeech(state, p, state.rng)
    text = compose(state, p, intent, state.rng)
  }

  if (intent.kind === 'claim-seer' || intent.kind === 'counter-claim' || intent.kind === 'report-check') {
    if (p.role === ROLE.SEER) {
      publishSeerClaim(state, p, p.checks.length ? p.checks : (intent.checks || []), false)
    } else {
      const base = state.claims.find((c) => c.playerId === p.id)?.checks || []
      const merged = [...base, ...(intent.checks || [])]
      publishSeerClaim(state, p, merged.length ? merged : (intent.checks || []), true)
    }
  }

  recordSpeech(state, p, text, intent)
  state.currentSpeech = { playerId: p.id, text, kind: intent.kind, day: state.day, seq: Date.now() }
  logEntry(state, 'speech', `${mark(p)}：${text}`, { playerId: p.id, speech: true })
  host.sfx?.('speak')

  const dwell = Math.max(BEAT.speak, Math.min(5200, 420 + text.length * 34))
  await host.wait(dwell)
  state.turn = null
}

/* ================================================================
 * 投票
 * ================================================================ */

async function votePhase(state, host) {
  state.phase = 'vote'
  state.phaseLabel = `第 ${state.day} 天 · 投票放逐`
  state.currentSpeech = null
  logEntry(state, 'phase', '发言结束，开始投票。')
  host.sfx?.('vote')
  await host.wait(BEAT.vote)

  const voters = aliveList(state)
  const votes = {}
  const order = []
  const lastDeath = state.deaths[state.deaths.length - 1]
  const startSeat = lastDeath ? (lastDeath.playerId + 1) % 9 : 0
  for (let i = 0; i < 9; i++) {
    const p = state.players[(startSeat + i) % 9]
    if (p.alive) order.push(p)
  }

  for (const p of order) {
    state.turn = p.id
    let targetId = null
    if (p.isHuman) {
      const pool = voters.filter((x) => x.id !== p.id).map((x) => x.id)
      const ans = await host.ask({
        kind: 'vote',
        role: p.role,
        title: '你要投谁？',
        hint: `场上还有 ${voters.length} 人。多数票出局，平票则本轮不放逐。`,
        candidates: pool,
        allowSkip: true,
        skipLabel: '弃票',
      })
      targetId = ans.playerId
    } else {
      targetId = AI.decideVote(state, p, state.rng)
    }
    votes[p.id] = targetId
    p.votedToday = true
    const label = targetId == null ? '弃票' : `→ ${seatLabel(P(state, targetId))}`
    logEntry(state, 'vote', `${mark(p)} 投票 ${label}`, { playerId: p.id, targetId })
    await host.wait(Math.max(160, BEAT.vote * 0.42))
  }
  state.turn = null

  /* 计票 */
  const tally = {}
  for (const [, t] of Object.entries(votes)) {
    if (t == null) continue
    tally[t] = (tally[t] || 0) + 1
  }
  const entries = Object.entries(tally).map(([id, n]) => ({ id: Number(id), n }))
  entries.sort((a, b) => b.n - a.n)
  const top = entries[0]
  const tie = entries.length > 1 && entries[1].n === top?.n

  state.lastTally = entries.map((e) => ({ playerId: e.id, count: e.n }))
  state.voteHistory.push({ day: state.day, votes: { ...votes }, exiledId: null })

  if (!top || tie) {
    state.phaseLabel = '平票 · 无人出局'
    logEntry(state, 'result', tie ? '票型平了，本轮没有人被放逐。' : '全场弃票，本轮没有人被放逐。', { highlight: true })
    host.sfx?.('calm')
    await host.wait(BEAT.result)
    return
  }

  const exiled = P(state, top.id)
  state.voteHistory[state.voteHistory.length - 1].exiledId = exiled.id
  exile(state, exiled, `${top.n} 票`, 'vote')
  state.phaseLabel = `${seatLabel(exiled)} 被放逐`
  logEntry(state, 'result', `${fullLabel(exiled)} 以 ${top.n} 票被放逐出村。`, {
    playerId: exiled.id, highlight: true,
  })
  host.sfx?.('exile')
  await host.wait(BEAT.result)

  if (exiled.role === ROLE.HUNTER) {
    await hunterShot(state, host, exiled)
  } else {
    await lastWords(state, host, exiled)
  }

  if (exiled.role === ROLE.WOLF) {
    logEntry(state, 'system', '（狼人出局，好人阵营向前一步。）')
  }
}

/** 统一放逐入口，便于扩展 */
function exile(state, player, note, reason) {
  killPlayer(state, player.id, reason, `被投票放逐（${note}）`)
}

/* ================================================================
 * 人类发言选项
 * ================================================================ */

export function speakKinds(role, state = null, me = null) {
  const base = [
    { id: 'villager-read', name: '盘逻辑', blurb: '讲讲你的观察，不指名道姓' },
    { id: 'accuse', name: '指认', blurb: '点名一个人，说出理由', needsTarget: true },
    { id: 'support', name: '站边', blurb: '表态信谁，跟他的票', needsTarget: true },
    { id: 'defend-self', name: '辩解', blurb: '回应别人对你的怀疑' },
  ]
  const seerish = [
    { id: 'claim-seer', name: '跳预言家', blurb: '公布身份与验人结果', risky: true },
  ]
  if (role === ROLE.WOLF) {
    return [...seerish, ...base, { id: 'wolf-cover', name: '伪装', blurb: '装作平民，把水搅浑', needsTarget: true }]
  }
  if (role === ROLE.SEER) {
    return [
      { id: 'claim-seer', name: '亮身份 + 报验人', blurb: '把你的验人结果全部公布' },
      ...base,
    ]
  }
  return [...base, { id: 'claim-seer', name: '跳预言家', blurb: '假装预言家（风险极高）', risky: true }]
}
