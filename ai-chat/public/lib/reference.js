// 会话引用：把**另一个会话**的内容当「背景材料」带进当前会话。
//
// ⚠️ 先划清三条线，别和别的东西搞混：
//   · **会话分支**（lib/branch.js）= 把整段对话**复制过去继续聊**：复制品成为新会话自己的消息，
//     之后两边各聊各的。判据是「接下来要接着那条线往下聊」。
//   · **压缩上文**（lib/compress.js）= 把**本会话**较早的轮次压成一条摘要顶替它们。
//   · **会话引用**（本文件）= 另一个会话的内容**当材料**：它不进本会话的消息、
//     不进导出的正文、不占压缩的下标，随时能换能删。判据是「手边要有那个会话的内容」——
//     **在哪儿用由用户决定**：就地挂在正在聊的这个会话上（**从下一轮开始生效**），
//     或者带着它另开一个新会话。材料是**会话级**的：挂上之后它跟着之后每一轮，直到被移除；
//     已经答过的轮次一个字不变（那些轮次早就落成本会话自己的消息了）。
//
// 判据的另外一半是**上限**：分支没有上限（它就是"全部搬过去"），
// 引用有上限 —— 摘要不限轮数，**原文档最多 3 轮**。超过 3 轮就该去用分支，
// 不然「引用」会慢慢长成一条隐形的引用链（那是被明确否掉的设计）。
//
// 材料是**快照**：建立时把正文抄一份存进当前会话。所以源会话被改、被删、被清空，
// 材料都不受影响，只是标签上写一句「原会话已删除」。

/** 材料形式：`summary` 摘要档 / `turns` 原文档 */
export const REFERENCE_KINDS = ['summary', 'turns'];

/** 原文档最多几轮 —— 这不是随便定的数字，它是「引用」和「分支」的分界线 */
export const MAX_REFERENCE_TURNS = 3;

/** 材料的长度预算：超了**明确拒绝**，绝不静默截断（截断会让用户以为带全了） */
export const MAX_REFERENCE_CHARS = 4000;

/** 每轮正文的截断上限：免得单条超长回答把预算全吃掉 */
export const MAX_TURN_CHARS = 1200;

/**
 * 摘要档要记下「压的是哪几轮」（界面上的「改选轮次」靠它把勾选框还原回来）。
 *
 * 这是**记录**，不是材料上限：摘要本身不限轮数，压过的那些轮次只是用来把界面拨回原样，
 * 所以这里的数字只防脏数据（被手改过的 localStorage 塞一个巨长数组进来）。
 */
export const MAX_RECORDED_TURNS = 200;

function textOf(message) {
  const versions = Array.isArray(message?.versions) ? message.versions : [];
  // 多页时取**最后一页**：页是「同一问被编辑重发过几次」，材料要的是这个会话**现在的样子**
  //（旧页是留着对比看的）。这条规则不藏着 —— 材料里会用 multiPageNote() 写明。
  const latest = versions[versions.length - 1];
  const content = typeof latest?.content === 'string' ? latest.content.trim() : '';
  if (content) return content;
  // 只带图的轮次：图片不进材料（材料是纯文本），但要如实说明，不能装作那一轮不存在
  const images = Array.isArray(latest?.attachments) ? latest.attachments.length : 0;
  return images ? `（这一轮有 ${images} 张图片，图片没有带过来）` : '';
}

/**
 * 一轮有几页：提问和回答各按自己的版本数算，取大的那个。
 *
 * 和 versions.js 里的 `totalPages` 是同一条规则（那边是给版本栏用的）。
 * 这里自己算一遍是为了**不反向依赖**：versions.js 已经 import 了本文件，
 * 再互相 import 就成环了 —— 环在 ESM 里能跑，但状态微妙，不值得为两行代码冒险。
 */
function pairPages(question, answer) {
  const q = Array.isArray(question?.versions) ? question.versions.length : 1;
  const a = Array.isArray(answer?.versions) ? answer.versions.length : 1;
  return Math.max(1, q, a);
}

/**
 * 材料里那句「这一轮原先有几页、给的是哪一页」。
 *
 * 页是「同一问的多版回答」，材料取的是**最后一页**。不写这一句，用户会以为
 * 自己引的是他当时看的那一页，或者以为这一轮本来就只有一页 —— 引用另一个会话时
 * 他甚至看不到那边翻到了第几页。所以这句话是**如实交代**，不是啰嗦。
 */
function multiPageNote(picked) {
  const multi = picked.filter((pair) => pair.pages > 1);
  if (!multi.length) return '';
  const which = multi.map((pair) => `第 ${pair.number} 轮原先有 ${pair.pages} 页`).join('、');
  return `（说明：${which}，这里给的是最后一页）`;
}

function clip(text) {
  const clean = String(text ?? '').trim();
  return clean.length > MAX_TURN_CHARS ? `${clean.slice(0, MAX_TURN_CHARS)}…（后面还有内容，已截断）` : clean;
}

/**
 * 把会话切成「一问一答」的轮次。
 *
 * 只有提问、还没有回答的那一轮也会进来（`answer` 为空），但界面上会把它标出来 ——
 * 用户引用的是「聊过的内容」，没答完的那轮要不要带，得让人自己看见再决定。
 *
 * @param {Array<object>} messages
 * @returns {Array<{number: number, index: number, question: string, answer: string, pages: number}>}
 *   `pages` 是这一轮有几页（>1 就是被编辑重发过，材料取最后一页）
 */
export function turnPairs(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const pairs = [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (message?.role !== 'user') continue;
    const next = list[index + 1];
    const answerMessage = next?.role === 'assistant' ? next : null;
    const answer = answerMessage ? textOf(answerMessage) : '';
    const question = textOf(message);
    if (!question && !answer) continue;
    pairs.push({
      number: pairs.length + 1,
      index,
      question,
      answer,
      pages: pairPages(message, answerMessage),
    });
  }
  return pairs;
}

/** 材料外面那层说明：**必须**让模型知道这是参考资料，而不是「你们聊过的」 */
function frame(title, body, { summary = false, turns = [], picked = [] } = {}) {
  const what = summary
    ? `《${title}》的摘要`
    : turns.length
      ? `《${title}》第 ${turns.join('、')} 轮的一问一答`
      : `《${title}》的一问一答`;
  const lines = [
    `【背景材料】以下是另一个会话${summary ? '' : '里'}的内容：${what}`,
    '（这是用户提供的**背景资料**，供参考用。它不是你和用户现在这段对话的一部分，',
    '  别把它当成「你们已经聊过」，也不要直接接着它往下说 —— 用户接下来会提出新的话题。）',
  ];
  const note = multiPageNote(picked);
  if (note) lines.push(note);
  lines.push('', body, '', '【背景材料结束】');
  return lines.join('\n');
}

function turnsBody(pairs) {
  return pairs
    .map((pair, i) => {
      const lines = [`—— 第 ${pair.number} 轮 ——`];
      if (pair.question) lines.push(`用户：${clip(pair.question)}`);
      if (pair.answer) lines.push(`助手：${clip(pair.answer)}`);
      void i;
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * 组装一份材料（纯函数：校验 + 生成正文，界面和测试都用它）。
 *
 * @param {object} options
 * @param {object} options.source 被引用的会话
 * @param {'summary'|'turns'} [options.kind] 材料形式
 * @param {number[]} [options.numbers] 勾选的轮次号（空 = 整个会话）
 * @param {string} [options.summaryText] 摘要档时，模型给的摘要正文
 * @param {string} [options.mode] 运行模式（`mock` = 离线：摘要档不可用）
 * @returns {{ok: true, reference: object} | {ok: false, reason: string}}
 *   reason: empty | no-model | no-summary | too-many-turns | too-long | bad-source
 */
export function referencePlan({
  source,
  kind = 'summary',
  numbers = [],
  summaryText = '',
  mode = 'model',
} = {}) {
  if (!source || typeof source !== 'object') return { ok: false, reason: 'bad-source' };

  const pairs = turnPairs(source.messages);
  const wanted = Array.isArray(numbers) ? numbers.filter((n) => Number.isFinite(n) && n > 0) : [];
  const picked = wanted.length ? pairs.filter((pair) => wanted.includes(pair.number)) : pairs;
  if (!picked.length) return { ok: false, reason: 'empty' };

  const title = String(source.title ?? '').trim() || '那个会话';

  // ---- 原文档：把选中那几轮的原文照搬（一问一答成对，最多 3 轮）
  //
  // 上限要按**实际带过去的轮数**算，不能只看「勾了几轮」——
  // 「一轮都不勾」表示整个会话，那种情况下也得挡住：否则整段对话就被"引用"搬过去了，
  // 那正是「分支」该干的事（而且它会悄悄长成一条隐形引用链）。
  if (kind === 'turns') {
    if (picked.length > MAX_REFERENCE_TURNS) return { ok: false, reason: 'too-many-turns' };
    const text = frame(title, turnsBody(picked), { turns: picked.map((p) => p.number), picked });
    if (text.length > MAX_REFERENCE_CHARS) return { ok: false, reason: 'too-long' };
    return {
      ok: true,
      reference: {
        kind: 'turns',
        sessionId: String(source.id ?? ''),
        title,
        at: Date.now(),
        text,
        turns: picked.map((p) => p.number),
        covers: 0,
        chars: text.length,
      },
    };
  }

  // ---- 摘要档：要调模型（离线做不了，必须明说，不能装作带上了）
  if (mode === 'mock') return { ok: false, reason: 'no-model' };
  const summary = String(summaryText ?? '').trim();
  if (!summary) return { ok: false, reason: 'no-summary' };
  // 摘要也是从**最后一页**压出来的（送进 /api/summarize 的就是各轮的最新版），
  // 所以那句话照样要写：材料里混着「第 3 页的内容」而用户以为是一整轮，是最容易误解的地方。
  const text = frame(title, summary, { summary: true, picked });
  if (text.length > MAX_REFERENCE_CHARS) return { ok: false, reason: 'too-long' };
  return {
    ok: true,
    reference: {
      kind: 'summary',
      sessionId: String(source.id ?? ''),
      title,
      at: Date.now(),
      text,
      // 记下压的是哪几轮 ——「改选轮次」就是靠它把勾选框还原回去的。
      // 「一轮都不勾」表示整个会话，那就照旧留空（勾选框空着 = 整个会话，语义一致）。
      turns: wanted.length ? picked.map((p) => p.number) : [],
      // 这份摘要盖住了源会话的几条消息（只用于界面说明）
      covers: picked.length,
      chars: text.length,
    },
  };
}

/** 界面上那条标注：写清材料从哪来、是哪一种 */
export function referenceLabel(reference) {
  if (!reference?.text) return '';
  const title = reference.title || '那个会话';
  const turns = Array.isArray(reference.turns) ? reference.turns : [];
  const scope = turns.length ? `第 ${turns.join('、')} 轮` : '';
  if (reference.kind === 'turns') {
    return `背景材料：来自《${title}》${scope}的一问一答`;
  }
  // 摘要档：勾了具体轮次就写清是哪几轮；整段压的就只写覆盖了多少轮
  const covers = Number(reference.covers) || 0;
  return `背景材料：来自《${title}》${scope}的摘要${!scope && covers ? `（覆盖 ${covers} 轮）` : ''}`;
}

/** 材料够不够格发出去（纯校验，服务端不认这段材料，是客户端自己的责任） */
export function isValidReference(reference) {
  return Boolean(reference && typeof reference.text === 'string' && reference.text.trim());
}

/**
 * 失败原因翻成人话（界面直接显示）。
 * 每一条都要给出**下一步怎么办**，不能只说「失败了」。
 */
export const REFERENCE_FAILURES = {
  empty: '这个会话还没有可以引用的内容',
  'bad-source': '找不到那个会话',
  'no-model': '离线模式起不了摘要。可以改成「原文」档，它不需要模型',
  'no-summary': '这次没生成出摘要，可以再试一次，或者改成「原文」档',
  'too-many-turns': `「原文」档最多只能带 ${MAX_REFERENCE_TURNS} 轮 —— 想带更多就用「分出新会话」（那是把整段搬过去继续聊）`,
  'too-long': `材料太长了（超过 ${MAX_REFERENCE_CHARS} 字）。少选几轮，或者改成「摘要」档`,
};

export function referenceFailureText(reason) {
  return REFERENCE_FAILURES[reason] ?? '这份材料没能建立，换一种方式再试试';
}
