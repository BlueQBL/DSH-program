// 会话标题：怎么起、怎么洗、什么时候该换
//
// 做法对齐 ChatGPT：**标题不由「首条提问截断」凑出来，而是让模型读一遍开头的一问一答，
// 起一个短标题**。它是一次独立的、非流式的小请求，等回答写完之后才发，
// 所以既不拖慢正文，也不会让用户干等。
//
// 和 ChatGPT 的两处差别（都是刻意的）：
//  1. **本地先给一个名字**。ChatGPT 在模型标题回来之前，侧栏里是「New chat」；
//     我们先用首条提问算一个兜底标题（`fallbackTitle`），列表任何时候都不会是空的，
//     模型标题回来后再替换。
//  2. **用户改过的名字不会被覆盖**。用 `titleSource` 记住这个名字是谁起的
//     （用户 / 模型 / 本地兜底），自动改名只允许动「本地兜底」那一种。
//
// 这个文件是纯函数，**服务端也 import 它**（server.mjs 用它拼提示词）：
// 提示词和清洗规则只有一份，前后端不会各写一套然后慢慢分叉。

/**
 * 标题长度上限。
 *
 * 中文 18 字：会话列表一行放得下，也足够说清「这段在解决什么」。
 * 太长会被列表用省略号截掉，等于白让模型多说。
 */
export const TITLE_MAX_CHARS = 18;

/** 英文标题的词数上限（中文按字数算） */
export const TITLE_MAX_WORDS = 6;

/**
 * 起标题时的系统提示词。
 *
 * 每一条都是针对真实输出里出现过的毛病写的：
 *  · 「只输出标题」—— 否则模型爱写「这段对话主要讨论的是…」；
 *  · 「不要引号」—— 否则标题会变成「"闭包是什么"」，列表里看着别扭；
 *  · 「同一语言」—— 中文提问被起成英文标题是最常见的跑偏；
 *  · 「不要复述原话」+「6–14 字」—— 对齐 ChatGPT 那种短名词短语的观感；
 *  · 禁掉「对话/标题/关于」这类空词 —— 它们不含任何信息，却特别爱被模型吐出来。
 */
export const TITLE_SYSTEM_PROMPT = [
  '你负责给一段对话起标题，供侧栏列表使用。',
  '只输出标题本身：不要解释、不要引号、不要书名号、不要句末标点、不要换行。',
  '用与用户提问相同的语言。中文 6–14 个字；英文不超过 6 个词。',
  '抓住「这段对话在做什么」，用名词短语，不要复述用户的整句话。',
  '不要出现「对话」「标题」「关于」「讨论」这类空词。',
].join('\n');

/** 模型偶尔吐出来的退化标题：不含任何信息，一律不要 */
const DEGENERATE = /^(新对话|对话|标题|未命名|无标题|untitled|new chat|chat|conversation|title)$/i;

/** 成对的包装符号：模型很爱给标题套一层 */
const WRAPPERS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['【', '】'],
  ['（', '）'],
  ['(', ')'],
  ['**', '**'],
  ['__', '__'],
  ['`', '`'],
];

/** 结尾要抹掉的标点：标题不该以句号或逗号收尾 */
const TRAILING = /[。．.！!？?，,；;：:、…~～\-—\s]+$/;

/** 开头的礼貌用语 —— 兜底标题里它们只是噪音 */
const POLITE_PREFIX = /^(你好|您好|谢谢|麻烦你|麻烦|请你|请|帮我|帮忙|能不能|能否|可不可以|可以|我想|我要|我需要|想要|请问|想问一下|想问)/;

/**
 * 开头的「请求动词」。只有在剩下的内容还够长时才去掉 ——
 * 否则「介绍一下你自己」会被削成「你自己」，反而更难认。
 */
const REQUEST_VERB = /^(看看|看下|看一下|瞧瞧|讲讲|说说|讲一下|说一下|解释一下|解释下|介绍一下|介绍下|分析一下|分析下|总结一下|总结下|翻译一下|写一个|写个|写一段|写一下|改一下|改改|优化一下)/;

/** 结尾的语气词 */
const TAIL_PARTICLE = /(谢谢|多谢|吧|好吗|可以吗|行吗|好吗？|呢|啊|哈)+$/;

function firstNonEmptyLine(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim()) return line;
  }
  return '';
}

/** 剥掉标题外面套的成对符号（最多两层） */
function stripWrappers(text) {
  let out = text;
  for (let round = 0; round < 2; round += 1) {
    let changed = false;
    for (const [open, close] of WRAPPERS) {
      if (out.length > open.length + close.length && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(open.length, out.length - close.length).trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * 把模型的原始输出洗成「可以直接显示的标题」。
 *
 * 只做去包装，不管长度 —— 长度判断在 `titleFromModel` 里，
 * 因为「太短/太长该不该放弃」和「怎么去包装」是两件事。
 */
export function cleanTitle(raw) {
  let text = String(raw ?? '').replace(/\r\n?/g, '\n');
  // 只取第一行：模型有时会先给标题、再补一段解释
  text = firstNonEmptyLine(text);
  // 「标题：xxx」这种前缀
  text = text.replace(/^\s*(标题|题目|title)\s*[:：\-—]\s*/i, '');
  text = stripWrappers(text.replace(/\s+/g, ' ').trim());
  return text.replace(TRAILING, '').trim();
}

/**
 * 模型输出 → 可用标题；不可用返回 null（调用方据此保留本地兜底标题）。
 */
export function titleFromModel(raw) {
  const clean = cleanTitle(raw);
  if (!clean || DEGENERATE.test(clean)) return null;

  let title = clean;
  if (title.length > TITLE_MAX_CHARS) {
    // 优先在标点/空格处断开，别把词切一半
    const head = title.slice(0, TITLE_MAX_CHARS);
    const cut = Math.max(
      head.lastIndexOf(' '),
      head.lastIndexOf('，'),
      head.lastIndexOf('、'),
      head.lastIndexOf('：'),
      head.lastIndexOf(' '),
    );
    title = (cut >= 4 ? head.slice(0, cut) : head).replace(TRAILING, '').trim();
  }
  return title.length >= 2 ? title : null;
}

/**
 * 本地兜底标题：从首条提问里挤出一个能认的名字。
 *
 * 它只需要「够用几秒」—— 模型标题回来就把它换掉；上游挂了或离线模式时，
 * 它就是最终标题，所以也不能太难看：去掉礼貌用语与请求动词、只取第一句、抹掉句末标点。
 *
 * 取词范围先试**第一行**：用户粘一大段东西过来时（一句问题 + 后面跟一坨代码或报错），
 * 第一行往往正是问题本身。第一行太短才退回「整段折成一行」。
 */
export function fallbackTitle(text, max = TITLE_MAX_CHARS) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  // 代码围栏那一行本身不是内容：粘代码时它常常正好落在第一行
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```'));
  const firstLine = lines[0] ?? '';
  let rest = firstLine.length >= 6 ? firstLine : lines.join(' ').trim();
  if (!rest) return '新对话';

  rest = stripWrappers(rest);

  // 礼貌用语可以叠着来（「你好，麻烦你帮我…」），所以循环剥。
  // 但剥完只剩一两个字就别剥了 —— 否则「你好 世界」会被削成「世界」，
  // 那是把用户真正的内容当成客套话扔掉了。
  for (let i = 0; i < 4; i += 1) {
    const match = rest.match(POLITE_PREFIX);
    if (!match) break;
    const next = rest.slice(match[0].length).replace(/^[，,、。\s]+/, '').trim();
    if (next.length < 4) break;
    rest = next;
  }

  // 请求动词同理：削完还剩得下四个字才削
  const verb = rest.match(REQUEST_VERB);
  if (verb) {
    const next = rest.slice(verb[0].length).replace(/^[，,、。\s]+/, '').trim();
    if (next.length >= 4) rest = next;
  }

  // 只取第一句：后面的往往是补充说明
  const sentence = rest.split(/[。！!？?\n]/)[0]?.trim();
  if (sentence) rest = sentence;

  rest = stripWrappers(rest).replace(TAIL_PARTICLE, '').replace(TRAILING, '').trim();
  if (!rest) return '新对话';
  return rest.length <= max ? rest : `${rest.slice(0, max)}…`;
}

/** 会话里第一条用户提问的正文（老数据没有 versions，也要认） */
export function firstUserText(session) {
  const message = (session?.messages ?? []).find((m) => m?.role === 'user');
  if (!message) return '';
  const versions = Array.isArray(message.versions) ? message.versions : [];
  const current = versions[0] ?? message;
  return typeof current?.content === 'string' ? current.content : '';
}

/**
 * 这个名字是谁起的。
 *
 * `titleSource` 是这个功能的地基：自动改名**只**允许动 `fallback`，
 * 用户自己改过的（`manual`）永远不会被模型标题覆盖。
 *
 * 老数据没有这个字段，就用「标题是不是本地兜底算出来的」反推：
 * 对得上 → 机器起的，可以升级；对不上 → 用户改过的，不许动。
 */
export function inferTitleSource(session) {
  const declared = session?.titleSource;
  if (declared === 'none' || declared === 'fallback' || declared === 'auto' || declared === 'manual') {
    return declared;
  }
  const title = typeof session?.title === 'string' ? session.title.trim() : '';
  if (!title || title === '新对话') return 'none';
  const first = firstUserText(session);
  return first && title === fallbackTitle(first) ? 'fallback' : 'manual';
}

/** 该不该给这个会话请求一个模型标题 */
export function needsAutoTitle(session) {
  if (inferTitleSource(session) !== 'fallback') return false;
  const messages = session?.messages ?? [];
  const hasQuestion = messages.some((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
  const hasAnswer = messages.some(
    (m) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim(),
  );
  return hasQuestion && hasAnswer;
}

function cut(text, max) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/**
 * 起标题那次请求要发的内容。
 *
 * 开头的一问一答是主料（很多话题要等看到回答才说得清，比如「这是怎么回事」）；
 * `laterQuestions` 用来处理「标题只描述开头、后来早就跑偏了」这个已知毛病 ——
 * 用户手动点「起名」时会把后面问过的几件事也带上。
 */
export function buildTitleMessages({ question = '', answer = '', laterQuestions = [] } = {}) {
  const lines = ['对话的开头：', `用户：${cut(question, 600)}`];
  if (String(answer ?? '').trim()) lines.push(`助手：${cut(answer, 600)}`);

  const later = (laterQuestions ?? []).map((q) => cut(q, 120)).filter(Boolean);
  if (later.length) {
    lines.push('', '后来又问到：');
    for (const q of later.slice(-4)) lines.push(`- ${q}`);
  }

  lines.push('', '请给这段对话起一个标题。');
  return [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}
