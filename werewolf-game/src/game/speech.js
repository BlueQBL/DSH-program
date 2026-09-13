/**
 * 发言生成
 *
 * 目标：让机器人说的话"内容是真的"——每一句都引用本局真实发生过的事
 * （谁跳了预言家、谁验了谁、谁上票给了谁、谁死了），而不是随机套话。
 * 句式随人格（PERSONAS.tone）与局势变化，避免全场一个腔调。
 */

import { ROLE, ROLE_META } from './roles.js'

/* ---------- 称呼 ---------- */

export const seatLabel = (p) => (p ? `${p.seat + 1}号` : '某位')
export const fullLabel = (p) => (p ? `${p.seat + 1}号${p.name}` : '某位')

export function listLabels(players) {
  return players.map(seatLabel).join('、')
}

/* ---------- 人格语气池 ---------- */

const TONE = {
  steady: {
    open: ['我说一下。', '我按顺序讲。', '先听我把话讲完。', '我这里有一条线，讲给大家听。'],
    close: ['就这些。', '我说完了。', '剩下的你们自己盘。', '我票已经定了。'],
    hedge: ['我不敢把话说死', '我保留一点余地', '这话可能不好听'],
  },
  brash: {
    open: ['我直接说了！', '别绕圈子，我讲重点。', '今天我把话讲难听点。', '我先开团。'],
    close: ['不服就来投我。', '我就这个态度。', '出他，错了算我的。', '别磨叽，上票。'],
    hedge: ['我不管别的', '我懒得听解释', '反正我认定了'],
  },
  careful: {
    open: ['我把发言记了一下。', '我按时间线捋一遍。', '我这边有几条记录。', '我不急，先说观察到的东西。'],
    close: ['我的票先放这儿。', '以上是我的复盘。', '我说得慢，但都是真的。', '大家核对一下时间线。'],
    hedge: ['我倾向于', '从记录上看', '我不能百分百确定'],
  },
  blunt: {
    open: ['话不多。', '我说三句。', '我讲结论。', '不铺垫了。'],
    close: ['就这样。', '票给他。', '完事。'],
    hedge: ['差不离', '大概率', '我心里有数'],
  },
  cold: {
    open: ['我只讲逻辑。', '情绪没有意义，听推论。', '我不评价人，只评价行为。', '让我把话说完。'],
    close: ['逻辑到此。', '结论你们自己下。', '我说完了。'],
    hedge: ['概率上', '按现有信息', '除非我漏了什么'],
  },
  sly: {
    open: ['我不急着站边。', '先说个有意思的地方。', '我给大家留个钩子。', '我话不说满。'],
    close: ['票我先捏着。', '看后面谁露马脚。', '我先到这。'],
    hedge: ['有意思的是', '我不好说，但', '你们注意到没有'],
  },
  elder: {
    open: ['老理儿是这样。', '我讲个老规矩。', '这局我看了很久了。', '我年纪大，话慢。'],
    close: ['话尽于此。', '听不听在你们。', '我这一票不轻。'],
    hedge: ['照常理讲', '以我这点经验', '我不敢托大'],
  },
  gentle: {
    open: ['我轻声说两句。', '我不太会吵架，但我有想法。', '我说得慢，别打断我。', '我把我知道的讲出来。'],
    close: ['我说完了，谢谢。', '希望大家投得准。', '以上。'],
    hedge: ['我可能想错了', '我个人感觉', '我有点犹豫'],
  },
  mystic: {
    open: ['我先看个气口。', '这局的味道不太对。', '我掐了一下，讲给你们。', '我不说玄的，我说实的——但实里也有玄。'],
    close: ['信不信由你。', '天意如此，票在我手。', '我说完了。'],
    hedge: ['我算不准', '这局气场乱', '我半信半疑'],
  },
}

function tone(p) {
  return TONE[p?.persona?.tone] || TONE.steady
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]

/* ---------- 局势摘要工具 ---------- */

function aliveOf(state) {
  return state.players.filter((p) => p.alive)
}

function claimersOf(state, role) {
  return state.claims.filter((c) => c.role === role)
}

function checksOf(state, playerId) {
  const rows = []
  for (const c of state.claims) {
    if (c.playerId !== playerId) continue
    for (const chk of c.checks) rows.push(chk)
  }
  return rows
}

/** 某人最后一轮把票投给了谁 */
function lastVoteOf(state, playerId) {
  for (let i = state.voteHistory.length - 1; i >= 0; i--) {
    const v = state.voteHistory[i].votes[playerId]
    if (v !== undefined && v !== null) return v
  }
  return null
}

function byId(state, id) {
  return state.players.find((p) => p.id === id) || null
}

/** 谁在上一轮上票给了"我" */
function whoVotedAgainst(state, id) {
  const last = state.voteHistory[state.voteHistory.length - 1]
  if (!last) return []
  return Object.entries(last.votes)
    .filter(([, t]) => t === id)
    .map(([voter]) => byId(state, Number(voter)))
    .filter(Boolean)
}

/* ================================================================
 * 主入口
 * ================================================================ */

/**
 * @param {object} state   全局面板（只读使用）
 * @param {object} me      发言者
 * @param {object} intent  { kind, ... } 发言意图
 * @param {function} rng
 * @returns {string}
 */
export function compose(state, me, intent, rng = Math.random) {
  const t = tone(me)
  const parts = []

  if (rng() < 0.72) parts.push(pick(rng, t.open))

  switch (intent.kind) {
    case 'claim-seer': parts.push(claimSeer(state, me, intent, rng)); break
    case 'report-check': parts.push(reportCheck(state, me, intent, rng)); break
    case 'counter-claim': parts.push(counterClaim(state, me, intent, rng)); break
    case 'defend-self': parts.push(defendSelf(state, me, intent, rng)); break
    case 'accuse': parts.push(accuse(state, me, intent, rng)); break
    case 'support': parts.push(support(state, me, intent, rng)); break
    case 'villager-read': parts.push(villagerRead(state, me, intent, rng)); break
    case 'wolf-cover': parts.push(wolfCover(state, me, intent, rng)); break
    case 'last-words': parts.push(lastWords(state, me, intent, rng)); break
    default: parts.push(villagerRead(state, me, intent, rng))
  }

  if (intent.voteTarget && intent.kind !== 'last-words' && rng() < 0.8) {
    parts.push(pick(rng, [
      `我的票投${seatLabel(intent.voteTarget)}。`,
      `先上${seatLabel(intent.voteTarget)}一票。`,
      `票给${seatLabel(intent.voteTarget)}，不动摇。`,
      `这轮我跟${seatLabel(intent.voteTarget)}。`,
    ]))
  }

  if (rng() < 0.62) parts.push(pick(rng, t.close))

  return parts.filter(Boolean).join('')
}

/* ---------- 各类发言 ---------- */

function claimSeer(state, me, intent, rng) {
  const checks = intent.checks || []
  const head = pick(rng, [
    '我是预言家。',
    '我跳预言家。',
    '预言家在这儿，别找错人。',
    '我不藏了，我是预言家。',
  ])
  if (!checks.length) return `${head}今晚的验人我会报出来。`

  const lines = checks.map((c) => {
    const target = byId(state, c.targetId)
    const verdict = c.result === ROLE.WOLF ? '查杀' : '金水'
    return `第${c.day}晚验的${seatLabel(target)}，${verdict}`
  })

  const tail = checks.some((c) => c.result === ROLE.WOLF)
    ? pick(rng, [
        '。查杀优先，今天先把他送出去。',
        '。有查杀先出查杀，这是死规矩。',
        '。狼已经露头了，别再散票。',
      ])
    : pick(rng, [
        '。后面我还会继续验，你们跟我的票。',
        '。金水就先记着，我明晚会接着验。',
        '。我这条线是干净的，信我的跟我走。',
      ])

  return `${head}${lines.join('，')}${tail}`
}

function reportCheck(state, me, intent, rng) {
  const c = intent.check
  if (!c) return '我今晚验的人手上有结果，一会儿报。'
  const target = byId(state, c.targetId)
  const wolf = c.result === ROLE.WOLF
  const head = pick(rng, [
    `我接着报验人。`,
    `预言家的第二条信息。`,
    `昨晚的结果出来了。`,
  ])
  const body = wolf
    ? `${seatLabel(target)}是查杀。`
    : `${seatLabel(target)}是金水。`
  const tail = wolf
    ? pick(rng, ['他必须今天走。', '谁保他，谁就有问题。', '这只狼藏得挺深，但我验到了。'])
    : pick(rng, ['这个人可以放心。', '他是干净的，别浪费票。', '谁咬他，我就盯谁。'])
  return `${head}${body}${tail}`
}

function counterClaim(state, me, intent, rng) {
  const rival = intent.rival
  const checks = intent.checks || []
  const lines = checks.map((c) => {
    const target = byId(state, c.targetId)
    return `我验的是${seatLabel(target)}，${c.result === ROLE.WOLF ? '查杀' : '金水'}`
  })
  return pick(rng, [
    `我是真预言家。${seatLabel(rival)}是悍跳的狼，${lines.join('，')}。好人别跟他走。`,
    `${seatLabel(rival)}跳预言家，那我必须出来。我才是真的，${lines.join('，')}。`,
    `对跳了。我是真预言家，${seatLabel(rival)}是狼。${lines.join('，')}。今天先出他。`,
  ])
}

function defendSelf(state, me, intent, rng) {
  const accuser = intent.accuser
  const vs = whoVotedAgainst(state, me.id)
  const bits = []

  if (accuser) {
    bits.push(pick(rng, [
      `${seatLabel(accuser)}给我扣了个查杀，理由站不住。`,
      `${seatLabel(accuser)}咬我，可他自己一句话都没验清。`,
      `${seatLabel(accuser)}今天突然冲我来，太急了。`,
    ]))
  }
  if (vs.length) {
    bits.push(`${listLabels(vs)}上的票，我记着。`)
  }
  bits.push(pick(rng, [
    '我是好人，出我等于白送一只狼。',
    '你们今天把我推出去，明天狼就多一刀。',
    '我没什么可辩的，我本来就干净。',
    '狼最喜欢看好人自己咬自己。',
  ]))
  return bits.join('')
}

function accuse(state, me, intent, rng) {
  const target = intent.target
  const reasons = []

  const lastVote = lastVoteOf(state, target.id)
  if (lastVote !== null && lastVote !== me.id) {
    const lp = byId(state, lastVote)
    reasons.push(pick(rng, [
      `他上一轮把票挂在${seatLabel(lp)}身上，那票很脏。`,
      `他给${seatLabel(lp)}上票的时机太怪。`,
    ]))
  }

  const speechCount = state.speeches.filter((s) => s.playerId === target.id).length
  if (speechCount <= 1) reasons.push('他发言一直在划水，不表态、不担责。')

  const defs = state.supported[target.id] || []
  if (defs.length) {
    const d = byId(state, defs[defs.length - 1])
    if (d && d.alive) reasons.push(pick(rng, [
      `他一直在保${seatLabel(d)}，两个人像一伙的。`,
      `他替${seatLabel(d)}说话，这不像好人干的事。`,
    ]))
  }

  if (!reasons.length) {
    reasons.push(pick(rng, [
      '他整场没有给过任何有效信息。',
      '他的每句话都在两边讨好。',
      '我找不到他做过一件对好人有帮助的事。',
    ]))
  }

  return pick(rng, [
    `我怀疑${seatLabel(target)}。`,
    `今天我的目标是${seatLabel(target)}。`,
    `我把焦点放在${seatLabel(target)}身上。`,
  ]) + reasons.slice(0, 2).join('')
}

function support(state, me, intent, rng) {
  const target = intent.target
  return pick(rng, [
    `我站${seatLabel(target)}，他的逻辑是通的。`,
    `我认${seatLabel(target)}是好人，我跟他票。`,
    `${seatLabel(target)}发言干净，我愿意压他。`,
  ])
}

function villagerRead(state, me, intent, rng) {
  const alive = aliveOf(state).filter((p) => p.id !== me.id)
  const claimers = claimersOf(state, ROLE.SEER)
  const bits = []

  if (claimers.length >= 2) {
    const names = claimers.map((c) => seatLabel(byId(state, c.playerId))).join('和')
    bits.push(pick(rng, [
      `${names}对跳预言家，里面至少有一只狼。`,
      `两个预言家里必有一狼，今天必须处理一个。`,
    ]))
  } else if (claimers.length === 1) {
    const c = byId(state, claimers[0].playerId)
    bits.push(pick(rng, [
      `场上只有${seatLabel(c)}跳预言家，暂时没对跳。`,
      `${seatLabel(c)}是唯一预言家，我暂且听他的。`,
    ]))
  }

  const deaths = state.deaths.filter((d) => d.day >= state.day - 1)
  if (deaths.length) {
    bits.push(`昨晚倒了${listLabels(deaths.map((d) => byId(state, d.playerId)))}，这刀有讲究。`)
  }

  if (!bits.length) {
    bits.push(pick(rng, [
      `现在信息太少，我只能从发言里挑刺。`,
      `第一轮没什么实锤，我先听你们说。`,
    ]))
  }

  // 用一句真实观察收尾
  const suspect = intent.target
  if (suspect) {
    bits.push(pick(rng, [
      `${seatLabel(suspect)}让我最不舒服。`,
      `${seatLabel(suspect)}的发言我过不去。`,
    ]))
  }
  return bits.join('')
}

function wolfCover(state, me, intent, rng) {
  const target = intent.target
  return pick(rng, [
    `我是平民，我谈感受。${target ? seatLabel(target) + '今天很急，我觉得有问题。' : '场上有人一直在带节奏。'}`,
    `我不跳任何身份，我说逻辑。${target ? seatLabel(target) + '的投票很不干净。' : '我盯着几个不说话的人。'}`,
    `以我的位置，我只能盘票型。${target ? seatLabel(target) + '那票说不通。' : '有人在保人。'}`,
  ])
}

function lastWords(state, me, intent, rng) {
  const meta = ROLE_META[me.role]
  const isWolf = me.role === ROLE.WOLF
  if (isWolf) {
    return pick(rng, [
      '我是平民，你们出错了，狼还在场上。',
      '行，我走了。但我提醒一句，你们今天票型很散，狼在笑。',
      '我不是狼。你们回头看看是谁把我推上去的。',
    ])
  }
  if (me.role === ROLE.SEER && intent.checks?.length) {
    const lines = intent.checks.map((c) => `${seatLabel(byId(state, c.targetId))}${c.result === ROLE.WOLF ? '查杀' : '金水'}`)
    return `我是真预言家。把验人留给你们：${lines.join('，')}。好人别走错路。`
  }
  return pick(rng, [
    `我是${meta.name}，你们今天送错了人。好好看看票型。`,
    '我走了。剩下的局，别被带偏。',
    '记住我说的话，明天你们会想起来的。',
  ])
}

/* ---------- 短句：投票理由 / 遗言 / 系统播报 ---------- */

export function voteReason(state, me, target, rng = Math.random) {
  const t = tone(me)
  return pick(rng, [
    `${pick(rng, t.hedge)}，我投${seatLabel(target)}。`,
    `${seatLabel(target)}今天最像狼。`,
    `跟逻辑走，票给${seatLabel(target)}。`,
  ])
}
