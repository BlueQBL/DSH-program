// 引用回答：选中回答里的一段，带着它接着问
//
// 用途（参考 ChatGPT 的引用）：在回答里划一段字 → 点「引用这段」→
// 那段话挂在输入框上方 → 你补一句问题发出去。
// 模型收到的这一轮消息里就带着被引用的原文，回答自然落在这一段上，
// 不必让用户自己复制粘贴，也不必重新解释「我说的那段是哪里」。
//
// 这里只放**纯决策**：怎么把一段选区规整成引用、引用怎么显示、
// 发给模型时怎么拼。它不碰 DOM，所以能在 Node 里直接跑测试。
//
// 数据形状：{ text, page, messageId, truncated }
//   text       规整过的引用正文
//   page       引用的是那一页的回答（1 起）—— 回答有多页时才有意义
//   messageId  来自哪条消息，用于显示与去重（可以为 null）
//   truncated  是否因为过长被截断

/**
 * 引用正文的长度上限。
 *
 * 引用是**整段重复发送**的：它既进这一轮的请求体，也会留在历史里跟之后每一轮走。
 * 不设上限的话，随手划中一整篇长回答就等于把上下文翻倍，
 * 几千字之后每一轮都在为同一段文字付钱。
 */
export const MAX_QUOTE_CHARS = 1200;

/** 规整引用正文：统一换行、去掉行尾空白、压缩空行、裁剪长度 */
export function cleanQuoteText(raw, max = MAX_QUOTE_CHARS) {
  if (typeof raw !== 'string') return '';
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    // 划选时经常把段落之间的空行也带进来，连续空行压成一个
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trimEnd();
}

/**
 * 把一段选区（或已存的引用）规整成可用的引用对象。
 * 空内容、纯空白一律返回 null —— 调用方据此决定「不显示引用条」。
 *
 * @param {{text?: string, page?: unknown, messageId?: unknown}|string} input
 * @returns {{text: string, page: number, messageId: string|null, truncated: boolean}|null}
 */
export function normalizeQuote(input) {
  const raw = typeof input === 'string' ? { text: input } : input;
  if (!raw || typeof raw !== 'object') return null;

  // 先按「不限长」规整一遍，才知道究竟有没有被截断
  const full = cleanQuoteText(raw.text, Number.MAX_SAFE_INTEGER);
  if (!full) return null;
  const text = full.length > MAX_QUOTE_CHARS ? full.slice(0, MAX_QUOTE_CHARS).trimEnd() : full;

  const page = Math.max(1, Math.floor(Number(raw.page)) || 1);

  return {
    text,
    page,
    messageId: typeof raw.messageId === 'string' && raw.messageId ? raw.messageId : null,
    truncated: text.length < full.length,
  };
}

/** 有没有可用的引用 */
export function hasQuote(quote) {
  return Boolean(quote && typeof quote.text === 'string' && quote.text.trim());
}

/**
 * 一次选区该不该变成引用。
 *
 * `inAnswer` 由调用方判断（选中的文字是否落在回答正文里）—— 那是 DOM 的事，
 * 这里只守住「必须有字」和「必须来自回答」两条规则。
 */
export function quoteFromSelection({ text, inAnswer = false, page = 1, messageId = null } = {}) {
  if (!inAnswer) return null;
  return normalizeQuote({ text, page, messageId });
}

/** 引用在界面上的名字：多页时点明是第几页，免得用户以为引错了地方 */
export function quoteLabel(quote) {
  const page = Math.max(1, Math.floor(Number(quote?.page)) || 1);
  return page > 1 ? `引用回答 · 第 ${page} 页` : '引用回答';
}

/** 折成一行给 title / aria-label 用 */
export function quotePreview(quote, max = 60) {
  const one = (quote?.text ?? '').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}

/**
 * 引用拼进请求体的样子。
 *
 * 用 Markdown 引用块（`>`）而不是自定义标记：这是模型最熟悉的「这是转引的原文」
 * 写法，不容易被当成用户自己说的话。前面再加一行说明引自哪一轮，
 * 因为模型看到的历史里这一轮可能不是最后一条。
 */
export function quoteForRequest(quote) {
  if (!hasQuote(quote)) return '';
  const body = quote.text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `> 【${quoteLabel(quote)}】\n${body}`;
}

/**
 * 这一轮真正发给模型的用户消息内容。
 *
 * 库里存的 content 是**用户自己打的那句话**（干净、不带引用），
 * 引用只在发请求时拼上去 —— 这样界面上、导出里读到的都是原话，
 * 而模型看到的是带上下文的完整一轮。
 */
export function composeUserContent(text, quote) {
  const question = typeof text === 'string' ? text : '';
  const block = quoteForRequest(quote);
  if (!block) return question;
  return question ? `${block}\n\n${question}` : block;
}
