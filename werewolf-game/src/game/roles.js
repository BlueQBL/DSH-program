/**
 * 角色定义 · 9 人标准局
 * 3 狼人 / 预言家 / 女巫 / 猎人 / 3 平民
 *
 * 本文件只描述"角色是什么"，不含任何流程逻辑。
 */

export const ROLE = {
  WOLF: 'wolf',
  SEER: 'seer',
  WITCH: 'witch',
  HUNTER: 'hunter',
  VILLAGER: 'villager',
}

export const TEAM = {
  WOLF: 'wolf',
  GOOD: 'good',
}

/** 9 人局牌堆 */
export const DECK_9 = [
  ROLE.WOLF, ROLE.WOLF, ROLE.WOLF,
  ROLE.SEER, ROLE.WITCH, ROLE.HUNTER,
  ROLE.VILLAGER, ROLE.VILLAGER, ROLE.VILLAGER,
]

export const GOD_ROLES = [ROLE.SEER, ROLE.WITCH, ROLE.HUNTER]

export const ROLE_META = {
  [ROLE.WOLF]: {
    id: ROLE.WOLF,
    name: '狼人',
    team: TEAM.WOLF,
    tone: 'blood',
    sigil: '狼',
    tagline: '夜里睁眼，与同伴共刀一人',
    brief: '白天伪装成好人，夜里和同伴一起猎杀。你可以悍跳预言家，也可以藏到最后一轮。',
    win: '杀光三名神职，或杀光三名平民，即屠边获胜。',
    nightHint: '与同伴商定今晚要杀的人。',
  },
  [ROLE.SEER]: {
    id: ROLE.SEER,
    name: '预言家',
    team: TEAM.GOOD,
    tone: 'moon',
    sigil: '验',
    tagline: '夜里查验一人，是狼是好人',
    brief: '你是好人唯一的眼睛。第一晚就要开始验人，白天适时起跳报验人结果。',
    win: '放逐或杀死全部三只狼人。',
    nightHint: '选择一名玩家查验身份。',
  },
  [ROLE.WITCH]: {
    id: ROLE.WITCH,
    name: '女巫',
    team: TEAM.GOOD,
    tone: 'moss',
    sigil: '药',
    tagline: '一瓶解药，一瓶毒药，各只能用一次',
    brief: '你知道每晚谁被狼刀。解药可救回一人，毒药可毒杀一人，同夜不可双药齐发。',
    win: '放逐或杀死全部三只狼人。',
    nightHint: '决定今晚是否用药。',
  },
  [ROLE.HUNTER]: {
    id: ROLE.HUNTER,
    name: '猎人',
    team: TEAM.GOOD,
    tone: 'brass',
    sigil: '枪',
    tagline: '出局时可开枪带走一人',
    brief: '你掌握着最后一击。被投票放逐或被狼刀时可开枪，但被女巫毒死则无法开枪。',
    win: '放逐或杀死全部三只狼人。',
    nightHint: '你没有夜间技能，闭眼等待天亮。',
  },
  [ROLE.VILLAGER]: {
    id: ROLE.VILLAGER,
    name: '平民',
    team: TEAM.GOOD,
    tone: 'candle',
    sigil: '民',
    tagline: '没有技能，只有一双眼睛',
    brief: '你没有夜晚技能，全部筹码就是白天的推理与投票。听发言，盘逻辑，别被人带偏。',
    win: '放逐或杀死全部三只狼人。',
    nightHint: '你没有夜间技能，闭眼等待天亮。',
  },
}

/**
 * 九位村民。每人一句性格底色，用来让 AI 的发言口吻彼此区分。
 * tone 决定了发言模板的语气池。
 */
export const PERSONAS = [
  { name: '老陈',   epithet: '沉默的看门人', tone: 'steady',  hue: 28  },
  { name: '阿蛮',   epithet: '急了就拍桌',   tone: 'brash',   hue: 358 },
  { name: '小满',   epithet: '记账一样记发言', tone: 'careful', hue: 152 },
  { name: '铁柱',   epithet: '话少，票不软', tone: 'blunt',   hue: 22  },
  { name: '白露',   epithet: '眼神很冷',     tone: 'cold',    hue: 205 },
  { name: '阿七',   epithet: '从不把话说死', tone: 'sly',     hue: 275 },
  { name: '长庚',   epithet: '话里带旧理',   tone: 'elder',   hue: 42  },
  { name: '青禾',   epithet: '温和，但记仇', tone: 'gentle',  hue: 168 },
  { name: '半仙',   epithet: '信命也信逻辑', tone: 'mystic',  hue: 320 },
]

/** 人类玩家的固定席位（正下方，最顺手的位置） */
export const HUMAN_SEAT = 0

export function roleOf(player) {
  return ROLE_META[player.role]
}

export function isWolf(player) {
  return player.role === ROLE.WOLF
}
