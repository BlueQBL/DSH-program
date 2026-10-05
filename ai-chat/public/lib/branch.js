// 会话分支：从某一轮分出一整个新会话 —— 把「到那一条回答为止」的内容复制过去，
// 原会话一个字节都不动，新会话从此独立生长（参考 ChatGPT 的「在新聊天中分支」）。
//
// ⚠️ 别和「版本分页」搞混，它们是两个层面的东西：
//   · 版本分页（lib/versions.js）在**同一个会话里**给某一个问题多留几页作答 ——
//     编辑重发产生新的一页，旧页永远不覆盖。管的是「这一问换个答法」。
//   · 分支（本文件）是**跨会话**的：从这里换条路走，两条线各自独立。
//   分支**不替代**版本分页：复制过去的那几轮，它们的版本页一起跟着走，
//   所以在新会话里翻回旧页看到的还是原样。
//
// ⚠️ 也别和「会话引用」搞混（那是第二步的事）：分支是把整段对话**搬过去继续聊**，
//   引用只是把另一个会话的内容当**背景材料**带过来。判据是：
//   接下来要接着那条线往下聊 → 分支；只是手边要有它的内容 → 引用。

/** 分支标题的后缀词 */
export const BRANCH_SUFFIX = '分支';

/** 标题长度上限（和 store.js 里那个 60 保持一致） */
export const MAX_TITLE_CHARS = 60;

/**
 * 从标题尾巴上认出「-分支N」里的 N。
 * 认不出来就是 0（用户自己改过名的分支也算认不出来，不碍事）。
 */
export function branchNumber(title) {
  const matched = /-分支(\d+)\s*$/.exec(String(title ?? ''));
  return matched ? Number(matched[1]) : 0;
}

/**
 * 新分支的标题：`原标题-分支N`。
 *
 * N 取「已有兄弟里最大的编号 + 1」，而不是「兄弟数量 + 1」——
 * 不然删掉中间那条分支之后，新建的会和还在的那条**重名**
 * （`-分支1` 没了、还剩 `-分支2`，按数量算出来又是 `-分支2`）。
 *
 * 标题总长有上限时**先砍原标题**：`-分支N` 这个后缀是「这条线从哪儿来」
 * 的唯一线索，不能被砍掉。
 *
 * @param {string} parentTitle 源会话的标题
 * @param {string[]} siblingTitles 同一个源会话下已经存在的分支标题
 */
export function branchTitle(parentTitle, siblingTitles = []) {
  const base = String(parentTitle ?? '').trim() || '新对话';
  const siblings = Array.isArray(siblingTitles) ? siblingTitles : [];
  const next = siblings.reduce((max, title) => Math.max(max, branchNumber(title)), 0) + 1;

  const suffix = `-${BRANCH_SUFFIX}${next}`;
  const room = Math.max(1, MAX_TITLE_CHARS - suffix.length);
  return `${base.slice(0, room)}${suffix}`;
}

/**
 * 这段对话里有几张图。
 *
 * 分支一律不带图（图片是 base64，复制一份等于真的多占一份 localStorage 空间），
 * 所以要如实数出来告诉用户「原会话的 N 张图没有带过来」。
 * 图片挂在**版本**上，按版本数一遍；只看版本、不看那个镜像字段，免得数重。
 */
export function countImages(messages) {
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const version of Array.isArray(message?.versions) ? message.versions : []) {
      total += Array.isArray(version?.attachments) ? version.attachments.length : 0;
    }
  }
  return total;
}

/** 深拷贝一份消息（分支拿到的必须是自己的副本，之后改哪儿都不影响原会话） */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 抹掉「不属于这条新线」的东西：
 *   · **图片**：一律不带（省空间；带过来也会让 localStorage 很快写不下）。
 *     模型看不到图，用户问起时它会说「我没看到图」—— 这和事实一致，
 *     比往历史里塞一句「这里本来有图」要诚实得多（那会让它开始猜图里有什么）。
 *   · **评价**：👍/👎 是对原会话那几页回答的评价，复制过去等于替用户在新会话里表了态。
 */
function stripBranchOnly(messages) {
  return messages.map((message) => ({
    ...message,
    attachments: [],
    feedback: null,
    versions: (Array.isArray(message?.versions) ? message.versions : []).map((version) => ({
      ...version,
      attachments: [],
      feedback: null,
    })),
  }));
}

/**
 * 复制「到 upToMessageId 那一条为止（含）」的消息。
 *
 * 找不到那一条就返回 `null`，让调用方什么都不做 ——
 * **宁可这里报错，也不能悄悄多复制几轮**：那等于把用户没选的内容塞进新会话。
 *
 * @param {Array<object>} messages 源会话的消息
 * @param {string} upToMessageId 分叉点（回答那一条的 id）
 * @returns {Array<object>|null}
 */
export function branchMessages(messages, upToMessageId) {
  const list = Array.isArray(messages) ? messages : [];
  const end = list.findIndex((message) => message?.id === upToMessageId);
  if (end < 0) return null;
  return stripBranchOnly(deepCopy(list.slice(0, end + 1)));
}

/**
 * 从源会话描述里算出新分支要带的东西（纯函数，store 只负责把它插进列表）。
 *
 * 摘要的越界保护值得单独说：`summary.covers` 是**消息数组的下标**。
 * 如果用户从摘要覆盖范围**之内**的某一轮分叉（源会话压过前 10 条，他偏从第 5 条分），
 * 复制出来的只有 6 条，而摘要却声称覆盖 10 条 —— 照抄过去的话，这一轮的请求里
 * 连一条用户消息都不剩（全被摘要顶掉了）。所以越界就丢掉摘要，从头发原文。
 *
 * @param {object} options
 * @param {object} options.source 源会话
 * @param {string} options.messageId 分叉点
 * @returns {{messages: Array<object>, title: string, summary: object|null, images: number}|null}
 */
export function branchPlan({ source, messageId, siblingTitles = [] } = {}) {
  const messages = branchMessages(source?.messages, messageId);
  if (!messages) return null;

  // 图片数要在**原件**上数 —— messages 里的附件已经被抹掉了
  const prefix = (Array.isArray(source?.messages) ? source.messages : []).slice(0, messages.length);

  const sourceSummary = source?.summary;
  const keepsSummary =
    sourceSummary && Number(sourceSummary.covers) < messages.length ? { ...sourceSummary } : null;

  return {
    messages,
    title: branchTitle(source?.title, siblingTitles),
    summary: keepsSummary,
    images: countImages(prefix),
  };
}
