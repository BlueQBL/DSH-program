// 上下文压缩（会话太长时把前面部分压成摘要）
//
// 现状与做法，先说清楚：
//  · **ChatGPT 没有用户能看见的压缩**。它是静默把最老的几轮挤出去 —— 对话还在，
//    模型已经忘了开头，而且不告诉你（社区里那条「ChatGPT never tells you a
//    conversation has gotten too long」说的就是这个，官方论坛上也一直有人提「自动摘要」的需求）。
//  · **Claude 有，而且是看得见的**：快满时它会说「Compacting our conversation…」，
//    Claude Code 里还有手动的 `/compact`。
//  这份实现按后者的路子来：**自动 + 手动、看得见、不动你本地的记录**。
//
// 三条硬规则：
//  1. **原始消息一条都不删**。压缩只改变「发给模型的那一份」，界面上、导出里、
//     localStorage 里始终是完整的对话。摘要是加法，不是删除。
//  2. **看得见**。压缩之后正文里会留下一道标记（以上多少条压成了摘要），
//     摘要原文随时能展开看 —— 用户必须知道模型到底看到了什么。
//  3. **能再压**。下一次压缩会把「上一次的摘要 + 新变老的那些消息」一起交给模型，
//     所以越压越紧，而不是把上一次的摘要丢掉重来。
//
// 这个文件是纯函数：阈值、切分、提示词、摘要的规整与显示都在这里，能在 Node 里直接测。

/** 自动压缩时，最近这几条永远原样保留（压缩只动更早的部分） */
export const KEEP_RECENT = 6;

/**
 * **手动**压缩时保留几条。
 *
 * 比自动少得多（只留最后一轮）：用户是自己点的，说明他就是要腾地方 ——
 * 这时候还硬留着最近 6 条，会出现「点了压缩却几乎没压掉什么」的怪异体验，
 * 而且会话短一点的时候压根没有可压的部分（按钮都不出现，看起来像功能坏了）。
 */
export const KEEP_RECENT_MANUAL = 2;

/**
 * 超过这个体量就安排一次后台压缩（答完这一轮之后悄悄做）。
 *
 * 用「字符数」而不是「条数」：一条长回答能顶十几条短问答。16000 字符大约 5k token，
 * 对常见的 128k 上下文模型来说只占很小一块 —— 这也符合「别等快满了才压」的经验：
 * 上下文塞得太满，模型反而更容易忘事、抓不住重点。
 */
export const SOFT_LIMIT_CHARS = 16000;

/** 超过这个体量就得**发之前先压**（这一轮会等它一下，界面上会说明） */
export const HARD_LIMIT_CHARS = 32000;

/** 待压缩的部分少于这个体量就不值得压（压完省不下多少，白花一次调用） */
export const MIN_COMPRESS_CHARS = 2000;

/** 手动压缩的下限低得多：用户都点了，只要压完确实能省下东西就干 */
export const MIN_COMPRESS_CHARS_MANUAL = 1200;

/** 摘要长度上限 */
export const SUMMARY_MAX_CHARS = 1200;

/** 拼给模型看的对话文本里，单条消息最多留多少字 */
export const TRANSCRIPT_MESSAGE_CHARS = 1500;

/**
 * 压缩用的系统提示词。
 *
 * 每一条都对着「压完就不好用」的常见毛病：
 *  · 只输出摘要 —— 否则模型会写「好的，以下是我为您整理的摘要：」这种废话；
 *  · 保留事实/决定/偏好/未解决的问题 —— 这些正是后面还要用到的；
 *  · 保留代码与专有名词原样 —— 把它们「改写」成自然语言等于毁掉上下文；
 *  · 同一种语言，压到 800 字以内 —— 太长就失去压缩的意义。
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '你负责把一段对话的**前半部分**压缩成一份简短摘要，供之后继续对话时使用。',
  '只输出摘要正文：不要开场白、不要「以下是摘要」、不要复述这段要求。',
  '必须保留：事实与数据、已经做出的决定、用户的偏好与要求、尚未解决的问题、',
  '以及代码片段、命令、文件名、接口名、专有名词 —— 这些原样保留，不要改写。',
  '可以丢弃：寒暄、重复确认、已经解决的中间过程。',
  '用与对话相同的语言，控制在 800 字以内。',
].join('\n');

/**
 * 单条消息折算多少字（正文 + 引用；图片不算 —— 历史里的图片本来就不发）。
 *
 * 平铺字段 content 是「最新一版」的镜像，正常情况下读它就够了；
 * 但它缺失时要回落到 versions —— 消息的真身是版本数组，
 * 拿一份只有 versions 的数据（比如外部导入、或者别处构造的消息）来估算时不能算成 0。
 */
export function messageChars(message) {
  const flat = typeof message?.content === 'string' ? message.content : '';
  const versions = Array.isArray(message?.versions) ? message.versions : [];
  const latest = versions[versions.length - 1];
  const content = flat || (typeof latest?.content === 'string' ? latest.content : '');
  const quote = message?.quote?.text ?? latest?.quote?.text;
  return content.length + (typeof quote === 'string' ? quote.length : 0);
}

/** 这些消息一共多少字 */
export function estimateChars(messages) {
  return (messages ?? []).reduce((sum, m) => sum + messageChars(m), 0);
}

/** 摘要已经覆盖了前面多少条（越界时夹回消息条数） */
export function coveredCount(messages, summary) {
  if (!summary) return 0;
  const total = (messages ?? []).length;
  return Math.max(0, Math.min(Math.floor(Number(summary.covers) || 0), total));
}

/**
 * 现在该不该压缩，以及要压哪一段。
 *
 * @param {{messages?: Array, summary?: object|null, force?: boolean}} options
 *   force 给手动按钮用：忽略体量阈值、只留最后一轮（KEEP_RECENT_MANUAL），
 *   但仍然要求「压完确实省得下东西」—— 否则就是白花一次调用。
 * @returns {{mode: 'none'|'background'|'blocking', from: number, to: number,
 *            chars: number, liveChars: number, keepRecent: number}}
 *   from/to 是消息数组的下标区间（左闭右开），即这一次要交给模型压缩的部分。
 */
export function compressionPlan({ messages = [], summary = null, force = false } = {}) {
  const covered = coveredCount(messages, summary);
  // 保留最近若干条：压缩的意义是留住「开头讲过的」，不是把眼前的话也抽走。
  // 手动触发时留得少（见 KEEP_RECENT_MANUAL 的说明）。
  const keepRecent = force ? KEEP_RECENT_MANUAL : KEEP_RECENT;
  const to = Math.max(covered, messages.length - keepRecent);
  const slice = messages.slice(covered, to);
  const chars = estimateChars(slice);
  const liveChars = estimateChars(messages.slice(covered));
  const floor = force ? MIN_COMPRESS_CHARS_MANUAL : MIN_COMPRESS_CHARS;

  const nothingToDo = { mode: 'none', from: covered, to, chars, liveChars, keepRecent };
  if (chars < floor) return nothingToDo;
  if (force) return { mode: 'blocking', from: covered, to, chars, liveChars, keepRecent };
  if (liveChars > HARD_LIMIT_CHARS) return { mode: 'blocking', from: covered, to, chars, liveChars, keepRecent };
  if (liveChars > SOFT_LIMIT_CHARS) return { mode: 'background', from: covered, to, chars, liveChars, keepRecent };
  return nothingToDo;
}

/** 把消息拼成给模型看的对话文本（单条超长会截断，本来就是要压小的） */
export function toTranscript(messages, maxPerMessage = TRANSCRIPT_MESSAGE_CHARS) {
  const lines = [];
  for (const message of messages ?? []) {
    const role = message.role === 'user' ? '用户' : '助手';
    const body = String(message.content ?? '').replace(/\s+\n/g, '\n').trim();
    if (!body) continue;
    const cut = body.length <= maxPerMessage ? body : `${body.slice(0, maxPerMessage)}…`;
    lines.push(`${role}：${cut}`);
  }
  return lines.join('\n\n');
}

/**
 * 压缩这次请求要发的内容。
 *
 * 传了 previousSummary 就把它一起带上：新摘要会覆盖「上一次的摘要 + 这一段」，
 * 所以覆盖范围是累加的（covers 从 from 开始算到 to）。
 */
export function buildSummaryMessages({ messages = [], previousSummary = null } = {}) {
  const parts = [];
  if (previousSummary?.text) {
    parts.push(`【此前已经压缩过的部分】\n${previousSummary.text}`, '');
  }
  parts.push('【这次要压缩的对话】', toTranscript(messages));
  parts.push('', '请把以上内容压缩成一份摘要。');
  return [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') },
  ];
}

/**
 * 规整模型吐出来的摘要。
 * 认不出（空、或者没说要覆盖多少条）就返回 null —— 调用方据此放弃这次压缩，
 * 继续用原文发，不做「压了个空的」这种事。
 */
export function normalizeSummary(raw) {
  if (!raw || typeof raw.text !== 'string') return null;
  const text = String(raw.text)
    .replace(/\r\n?/g, '\n')
    // 模型很爱先来一句「以下是摘要：」
    .replace(/^\s*(以下是|这是)?[^\n]{0,10}摘要[：:]\s*/u, '')
    .trim()
    .slice(0, SUMMARY_MAX_CHARS)
    .trim();
  if (!text) return null;

  const covers = Math.floor(Number(raw.covers) || 0);
  if (covers < 1) return null;

  return {
    text,
    covers,
    at: Number(raw.at) || Date.now(),
    model: typeof raw.model === 'string' && raw.model ? raw.model : null,
  };
}

/** 发给模型时，摘要在消息里的样子：放在最前面，明确标出它是压缩过的上文 */
export function summaryBlock(summary) {
  if (!summary?.text) return '';
  return [
    '【较早对话的摘要】',
    '（这是本次对话前面部分的压缩摘要，细节已省略。需要时可以请用户复述。）',
    summary.text,
  ].join('\n');
}

/** 界面上那句说明：以上多少条被压掉了、摘要多长 */
export function summaryLabel(summary) {
  if (!summary?.text) return '';
  const covers = Math.floor(Number(summary.covers) || 0);
  return `以上 ${covers} 条已压缩成摘要 · 约 ${summary.text.length} 字`;
}

/** 压缩前后大概省了多少字（给提示语用） */
export function compressionSaving({ chars = 0, summaryChars = 0 } = {}) {
  return Math.max(0, chars - summaryChars);
}
