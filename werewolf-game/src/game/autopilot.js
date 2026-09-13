/**
 * 托管：用同一套 AI 逻辑替人类席位作答。
 *
 * 两个地方共用它——
 *   1. 观战模式：你不动手，看看这八个人自己会打成什么样；
 *   2. 无头模拟器：一秒跑一千局，用来验证流程和平衡。
 *
 * 因为共用同一份代码，观战时看到的行为就是统计里那个行为，
 * 不存在"演示版"和"真实版"两套 AI。
 */

import * as AI from './ai.js'
import { compose } from './speech.js'
import { ROLE } from './roles.js'

/**
 * @param {object} state  全局面板
 * @param {object} req    导演发来的提问（kind / candidates / canSave / targets …）
 * @param {function} rng
 */
export function answerAsHuman(state, req, rng = Math.random) {
  const me = state.players[state.humanId]
  if (!me) return { playerId: null }

  switch (req.kind) {
    case 'pick-one': {
      // 猎人开枪
      if (req.role === ROLE.HUNTER) return { playerId: AI.hunterTarget(state, me, rng) }
      // 狼人选刀口
      if (req.role === ROLE.WOLF) return { playerId: AI.wolfKillTarget(state, rng) }
      // 预言家选查验对象
      if (req.role === ROLE.SEER) {
        const t = AI.seerCheckTarget(state, me, rng)
        return { playerId: t ?? req.candidates?.[0] ?? null }
      }
      return { playerId: req.candidates?.[Math.floor(rng() * (req.candidates?.length || 1))] ?? null }
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
