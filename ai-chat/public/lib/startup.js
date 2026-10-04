// 进入页面时该停在哪个会话
//
// 单独成模块的理由：这段判断是纯逻辑（输入是「当前会话状态 + 导航类型」，
// 输出是「做什么决定」），很容易退化 —— 比如一不小心又变回「永远打开上次的会话」。
// 剥离出来才能在 Node 里直接测。
//
// 需求原话：「网页刚进来默认是上次聊天会话，正常应该是新的会话。」
// 但「刷新」是例外：刷新时如果换会话，上一轮没写完的半截回答就看不见了，
// 「流式中断后仍能看到写到哪、并能重新生成」这个能力会被一起干掉。

/**
 * @param {{reload?: boolean, messageCount?: number, hasInterrupted?: boolean}} state
 * @returns {'reload'|'recover'|'empty'|'fresh'}
 *   reload  刷新当前页 → 留在原会话
 *   recover 上次有回答没写完 → 留在原会话，让用户看到那半截内容
 *   empty   当前会话本来就是空的 → 不用再建一个
 *   fresh   其余情况 → 开新会话（沿用角色与模型）
 */
export function resolveStartingSession({ reload = false, messageCount = 0, hasInterrupted = false } = {}) {
  if (reload) return 'reload';
  if (hasInterrupted) return 'recover';
  if (messageCount === 0) return 'empty';
  return 'fresh';
}

/** 这个决定要不要新建会话 */
export function shouldCreateSession(reason) {
  return reason === 'fresh';
}

/** 要不要给用户一句提示 */
export function startNotice(reason) {
  if (reason === 'fresh') return '已开一个新会话，上次的对话在左边列表里';
  if (reason === 'recover') return '上次有一轮没写完，已停在那个会话';
  return '';
}

/**
 * 会话列表一开始是收起还是展开。
 *
 * 规则：**用户选过就听用户的**；没选过才按屏幕宽度猜（窄屏默认收起 ——
 * 一栏列表挤在手机上说不上话，正文才是主角）。
 * 之前是「窄屏一律强制收起」、而且不记用户的选择，于是在宽屏上把列表收起来之后，
 * 刷一次页面它又自己弹出来，得反复去收 —— 那是把偏好当成了临时状态。
 *
 * @param {{stored?: string, narrow?: boolean}} state
 * @returns {boolean} 是否展开
 */
export function resolveRailVisible({ stored = '', narrow = false } = {}) {
  if (stored === 'shown') return true;
  if (stored === 'hidden') return false;
  return !narrow;
}
