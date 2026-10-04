// 离线降级回答器
//
// 没有配置 API Key 时用它顶上。它必须让「多轮对话」这件事看起来是真的，
// 所以它不是随机吐一段固定文本，而是真的会翻看前文：
//   · 从历史里抽取用户告诉过它的事实（例如「我叫小林」「我在学 Rust」）
//   · 用户问「我叫什么 / 我刚才说了什么 / 记住…」时，回到历史里找并原样引用
//   · 用当前问题和事实做关键词匹配，让回答看起来扣题
// 它明确承认自己是离线模板，不冒充真实模型。

import { sleep } from './http-utils.mjs';

// ---------------------------------------------------------------- 记忆抽取

// 值里出现这些词，说明用户是在「问」而不是在「告诉」，不能当事实存下来。
// 例：「我叫什么名字」里的「什么名字」如果被存成称呼，后面回答就会很尴尬。
const INTERROGATIVE = /[什么谁哪咋几多]|吗|呢/;

// 抽取时的通用值形状：不含标点与空白的短语
const VALUE = '([^\\s，。,.！!？?、；;：:]{1,24})';

/**
 * 抽一句里的「学什么」。
 *
 * 刻意不用复杂正则：中文里「学习」=「学」+「习」，一旦把动词写成 (?:学习|学) 这样的交替，
 * 引擎在 学习 失败后会退一步只匹配「学」，把「习」当成学的内容（抽出 "习" 这种垃圾）。
 * 这里先按动词切开句子，再从右往左取一个像名词的片段，行为直观、可读、不会回溯出错。
 */
const LEARN_VERBS = ['学习', '学', '研究'];

function extractLearningObject(text) {
  let rest = null;
  let matchedVerb = '';
  for (const verb of LEARN_VERBS) {
    const index = text.indexOf(verb);
    if (index === -1) continue;
    // 取最靠前的动词；同一个位置优先较长的那个
    if (rest === null || index < rest.index || (index === rest.index && verb.length > matchedVerb.length)) {
      rest = { index, tail: text.slice(index + verb.length) };
      matchedVerb = verb;
    }
  }
  if (!rest) return null;

  const candidate = rest.tail.trim().replace(/^[了过]/, '').trim();
  if (!candidate) return null;

  // 英文/技术名词：取开头一个词
  const latin = candidate.match(/^[A-Za-z][A-Za-z0-9+#._-]*/);
  if (latin) return latin[0];

  // 中文：取以名词后缀结尾的片段
  const cjk = candidate.match(/^[\u4e00-\u9fa5]{1,8}?(?:语言|框架|技术|课程|算法|体系|工具|方向|方法|模型|编程|开发|架构|协议|库|栈|课|书)/);
  return cjk ? cjk[0] : null;
}

const FACT_PATTERNS = [
  { key: 'name', label: '称呼', re: new RegExp(`(?:我(?:的名字)?叫|叫我)\\s*${VALUE}`) },
  {
    key: 'job',
    label: '职业',
    re: new RegExp(`我(?:是|在|做的?是)\\s*${VALUE}(?:工程师|程序员|老师|学生|设计师|产品经理|运维|测试)`),
  },
  { key: 'like', label: '喜欢', re: new RegExp(`我(?:很)?(?:喜欢|爱|偏好)\\s*${VALUE}`) },
  { key: 'build', label: '在做', re: new RegExp(`我(?:正在|在|最近在)?(?:做|写|开发|搞)\\s*${VALUE}`) },
];

/** 抽出来的值必须像「事实」，否则丢弃 */
function isFactual(value) {
  if (!value) return false;
  if (value.length < 2) return false; // 单个字多半是「个」「一」这类量词
  if (INTERROGATIVE.test(value)) return false;
  return true;
}

/**
 * 把消息内容统一成纯文本。
 *
 * 服务端在带图片时会把 content 转成多模态数组（[{type:'text'}, {type:'image_url'}]），
 * 而离线回答器只认字符串。这里做一次归一 —— 否则带图消息会让后面所有抽取逻辑读到
 * undefined，静默退化成空回答。
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
  return '';
}

/** 这条消息里带了几张图 */
function contentImageCount(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && part.type === 'image_url').length;
}

/** 从历史里抽出「用户告诉过我什么」，后面的覆盖前面的 */
function extractFacts(history) {
  const facts = new Map();
  for (const msg of history) {
    if (msg.role !== 'user') continue;
    const text = contentText(msg.content);
    if (!text) continue;
    for (const { key, label, re } of FACT_PATTERNS) {
      const hit = text.match(re);
      const value = hit?.[1]?.trim();
      if (isFactual(value)) facts.set(key, { label, value });
    }
    // 「正在学什么」走专用解析：直接字符串定位动词，不用交替正则
    if (text.includes('我')) {
      const learned = extractLearningObject(text);
      if (isFactual(learned)) facts.set('learn', { label: '正在学', value: learned });
    }
  }
  return facts;
}

/** 历史里的用户发言，最近的在前，去掉重复与过短噪声 */
function priorUserLines(history, { excludeLast = true } = {}) {
  const lines = history
    .filter((m) => m.role === 'user')
    .map((m) => contentText(m.content))
    .filter((t) => t.length >= 2);
  if (excludeLast) lines.pop();
  const seen = new Set();
  return lines
    .reverse()
    .filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
}

/** 粗粒度分词：中文取双字片段，英文/数字取整词，用于词面相关性排序 */
function keywords(text) {
  const tokens = new Set();
  const cjk = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
  }
  for (const word of text.toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) ?? []) tokens.add(word);
  return tokens;
}

const STOPWORDS = new Set([
  '什么', '怎么', '为什么', '可以', '这个', '那个', '我们', '你们', '一下', '现在',
  '还有', '就是', '如果', '然后', '但是', '因为', '所以', '请问', '帮我', '告诉',
]);

/** 在当前问题与前文之间找最相关的旧发言 */
function mostRelevantLine(question, history) {
  const qTokens = new Set([...keywords(question)].filter((t) => !STOPWORDS.has(t)));
  if (!qTokens.size) return null;
  let best = null;
  for (const line of priorUserLines(history)) {
    const lTokens = new Set([...keywords(line)].filter((t) => !STOPWORDS.has(t)));
    let score = 0;
    for (const token of qTokens) if (lTokens.has(token)) score += 1;
    const ratio = score / Math.max(4, qTokens.size);
    if (score > 0 && (!best || ratio > best.score)) best = { line, score: ratio };
  }
  return best && best.score >= 0.2 ? best.line : null;
}

// ---------------------------------------------------------------- 意图识别

const INTENTS = [
  { id: 'recall_name', test: /(我(叫什么|的名字)|还记得我叫|我叫什么名字)/ },
  { id: 'recall_what', test: /(我刚才|我刚刚|之前|上面|前面|刚刚)[^。！？?]{0,6}(说|问|提|聊)/ },
  { id: 'recall_memory', test: /^记忆|^(你(都)?记得|记住了?什么|你知道了什么)/ },
  { id: 'remember', test: /^(记住|记下|请记住|牢记)/ },
  { id: 'cando', test: /(你会什么|你能做什么|你有什么功能|你是谁|介绍一下你自己|你是什么模型)/ },
  { id: 'mockmode', test: /(为什么|怎么)[^。！？?]{0,8}(离线|降级|本地)|离线模式|降级模式/ },
  { id: 'compose', test: /(帮我写|写一段|生成一段|写个|写一个)[^。！？?]{0,20}(文案|介绍|简介|说明|总结)/ },
  { id: 'continue', test: /^(继续|接着说|还有吗|然后呢)/ },
  { id: 'time', test: /(现在|今天|当前)[^。！？?]{0,4}(几点|时间|日期|是几号|星期几)/ },
  { id: 'weather', test: /(天气|气温|下雨|温度|空气质量)/ },
  { id: 'stock', test: /(股票|股价|基金|汇率|比特币|大盘)/ },
  { id: 'news', test: /(新闻|热点|最新进展|今天发生了什么)/ },
  { id: 'greet', test: /^(你好|您好|hi|hello|嗨|哈喽)[\s！!。.]*$/i },
  { id: 'thanks', test: /(谢谢|多谢|感谢|辛苦)/ },
  { id: 'bye', test: /(再见|拜拜|结束了|先这样)/ },
  { id: 'clear_intent', test: /(清空|清除|删除)[^。！？?]{0,4}(对话|记录|历史)/ },
];

function detectIntent(text) {
  for (const { id, test } of INTENTS) if (test.test(text)) return id;
  return 'general';
}

// ---------------------------------------------------------------- 知识小抄

const CHEATSHEET = [
  {
    match: /(闭包|closure)/i,
    body: [
      '**闭包**指的是函数记住了它定义时所在的作用域，即使那个作用域已经执行结束。',
      '',
      '三个要点：',
      '- 闭包捕获的是**变量本身**，不是当时的值的快照；',
      '- 只要闭包还活着，被捕获的变量就不会被回收，这也是内存泄漏的常见来源；',
      '- 循环里用 `var` 声明变量时，所有回调共享同一个变量，所以要用 `let` 或立即执行函数隔离。',
      '',
      '```js',
      'function counter() {',
      '  let n = 0;            // 被下面两个函数共同捕获',
      '  return { inc: () => ++n, get: () => n };',
      '}',
      'const c = counter();',
      'c.inc();                // 1',
      '```',
    ].join('\n'),
  },
  {
    match: /(事件循环|event\s*loop|宏任务|微任务)/i,
    body: [
      '**事件循环**是 JS 在单线程上实现并发的机制：一个调用栈 + 一个任务队列，栈空了就去队列里取下一个任务。',
      '',
      '执行顺序可以记成一句话：**同步代码 → 微任务队列清空 → 取一个宏任务 → 再清空微任务**。',
      '',
      '- 微任务：`Promise.then`、`queueMicrotask`、`MutationObserver`；',
      '- 宏任务：`setTimeout`、`setInterval`、I/O、UI 渲染。',
      '',
      '所以 `setTimeout(fn, 0)` 不会插队到 `Promise.then` 前面。',
    ].join('\n'),
  },
  {
    match: /(流式输出|sse|server[- ]sent|打字机|逐字)/i,
    body: [
      '聊天界面里的**流式输出**通常走 SSE（Server-Sent Events）：',
      '',
      '1. 前端 `fetch` 一个 `POST` 接口，响应的 `Content-Type` 是 `text/event-stream`；',
      '2. 服务端每产出一小段文本就写一帧 `data: {...}\\n\\n`；',
      '3. 前端用 `response.body.getReader()` 逐块读，按空行切帧，解析出增量拼到同一条消息上；',
      '4. 上游是 OpenAI 兼容接口时，服务端只是二次转发——把它的 `delta.content` 转成自己的帧。',
      '',
      '关键点：**不要**用 `EventSource`，它只支持 GET、没法带请求体；用 `fetch` + `ReadableStream` 才能发 POST。',
    ].join('\n'),
  },
  {
    match: /(localstorage|本地存储|刷新.{0,4}丢失|持久化)/i,
    body: [
      '浏览器端保存对话，`localStorage` 就够用：',
      '',
      '- 它是同步的、按域隔离、容量约 5MB，放纯文本对话绰绰有余；',
      '- 写入用 `JSON.stringify`，读取时**一定要 try/catch**——旧版本数据结构或手改过的值会让 `JSON.parse` 抛错，整个应用白屏；',
      '- 每次消息变化后写一份，并带上 `schemaVersion`，以后改结构可以据此迁移；',
      '- 想要跨标签页同步，监听 `window` 的 `storage` 事件即可。',
    ].join('\n'),
  },
  {
    match: /(防抖|节流|debounce|throttle)/i,
    body: [
      '**防抖（debounce）**：连续触发时只在停止后执行一次——适合搜索框输入。',
      '**节流（throttle）**：固定间隔最多执行一次——适合滚动、拖拽。',
      '',
      '判断用哪个：问「用户停下来了才有意义吗」。是，用防抖；否则用节流。',
      '',
      '```js',
      'const debounce = (fn, wait = 300) => {',
      '  let timer;',
      '  return (...args) => {',
      '    clearTimeout(timer);',
      '    timer = setTimeout(() => fn(...args), wait);',
      '  };',
      '};',
      '```',
    ].join('\n'),
  },
  {
    match: /(markdown|渲染|排版)/i,
    body: [
      '在流式场景里渲染 Markdown，有一个容易被忽略的坑：**半截语法**。',
      '',
      '比如流刚好停在 `**加粗` 或者 ```` ```js ```` 之后，这时按完整文档解析会吃掉后面的内容。',
      '稳妥做法是容错解析：未闭合的行内标记当普通文本，未闭合的代码围栏按「仍在书写中」渲染，等下一帧补全后自然恢复。',
    ].join('\n'),
  },
];

function cheatsheetFor(question) {
  return CHEATSHEET.find((item) => item.match.test(question)) ?? null;
}

// ---------------------------------------------------------------- 回答组装

function memoryLines(facts) {
  return [...facts.values()].map((f) => `${f.label}「${f.value}」`);
}

function generalAnswer(question, history, facts) {
  const sheet = cheatsheetFor(question);
  if (sheet) {
    const parts = [sheet.body, '', '---', offlineFooter()];
    return parts.join('\n');
  }

  const related = mostRelevantLine(question, history);
  const parts = [];
  parts.push(`离线回答模式无法真正推理，所以这个问题我不编造答案。能确定的是：你问的是「${truncate(question, 40)}」。`);
  parts.push('');
  if (related) {
    parts.push(`关联到你前文提到的内容——${related.startsWith('我') ? `「${truncate(related, 50)}」` : `「${truncate(related, 50)}」`}。如果你是在追问那件事，补充一点细节我就能顺着聊下去（在离线模式下我会引用它，但不会假装做过深度推理）。`);
    parts.push('');
  }
  const names = memoryLines(facts);
  if (names.length) {
    parts.push(`本轮上下文里我记住的：${names.join('、')}。需要我忘掉某一条，直接说「忘掉我的${[...facts.values()][0].label}」即可。`);
    parts.push('');
  }
  parts.push('离线模式真正能演示的是**机制**：多轮上下文、逐字流式输出、刷新后不丢、随时清空。');
  parts.push('');
  parts.push('---');
  parts.push(offlineFooter());
  return parts.join('\n');
}

function offlineFooter() {
  return '> 当前是**本地离线回答**（没有配置 API Key）。接入真实模型：设置环境变量 `DEEPSEEK_API_KEY` 后重启服务即可，其余代码不用改。';
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * 根据当前问题 + 完整历史，产出一段离线回答文本。
 * @param {{role:string, content:string}[]} history 末条为当前提问
 */
function composeReply(history) {
  const last = history.at(-1);
  const rawQuestion = contentText(last?.content);
  const imageCount = contentImageCount(last?.content);

  // 带图时离线回答唯一的诚实做法：说清楚我看不了图，而不是假装看懂了
  if (imageCount > 0 && !rawQuestion) {
    return [
      `你发了 ${imageCount} 张图，但**离线回答模式看不了图片** —— 我没有视觉能力。`,
      '',
      '要真正识别图片内容，需要在页面顶部把模型换成支持看图的（例如 `gpt-4o`、`gemini-3-flash`、`claude-sonnet-4-5`），并配置好 API Key。',
      '',
      '顺便说一句：**DeepSeek 全系都不支持图片**，选了它们发图会被上游直接拒绝。',
      '',
      '---',
      offlineFooter(),
    ].join('\n');
  }

  const question = imageCount > 0 ? `${rawQuestion}（另外还附了 ${imageCount} 张图）` : rawQuestion;
  const facts = extractFacts(history);
  const intent = imageCount > 0 ? 'general' : detectIntent(question);
  const name = facts.get('name')?.value;
  const related = mostRelevantLine(rawQuestion, history);
  const sheet = cheatsheetFor(question);

  switch (intent) {
    case 'recall_name':
      return name
        ? `你之前告诉我你叫**${name}**${facts.get('job') ? `，${facts.get('job').label}是${facts.get('job').value}` : ''}。这条来自本轮对话的上文，不是我猜的。`
        : '这轮对话里你还没说过名字。你现在告诉我，后面我会一直用它称呼你。';

    case 'recall_what': {
      const lines = priorUserLines(history).slice(0, 3);
      if (!related && !lines.length) return '这轮对话里你还没说过别的，所以没有「刚才」可以回溯。';
      const body = related ? [related] : lines;
      return [
        '翻了下这轮对话的上文，你说的几句是：',
        '',
        ...body.map((line) => `- ${truncate(line, 60)}`),
        '',
        related
          ? '和现在这个问题词面上最接近的是上面第一条，如果你指的是它，我们接着聊。'
          : '你要追问哪一条，把它再点一下即可。',
      ].join('\n');
    }

    case 'recall_memory': {
      const entries = [...facts.values()];
      if (!entries.length) return '这轮对话里你还没给过我需要记住的信息——比如名字、正在学的东西、正在做的项目。说一句我就会记着。';
      return [
        '这轮对话里我记下的是：',
        '',
        ...entries.map((f) => `- **${f.label}**：${f.value}`),
        '',
        '这些都是从你的原话里抽出来的。清空对话后，它们会一起消失。',
      ].join('\n');
    }

    case 'remember': {
      const fact = question.replace(/^(记住|记下|请记住|牢记)[，,：:\s]*/, '').trim();
      if (!fact) return '要记住什么？把内容接着说一句，我就存进本轮上下文。';
      const hint = /^我/.test(fact) ? '' : `（原话是「${truncate(fact, 40)}」）`;
      return `记下了：**${truncate(fact, 60)}**${hint}。这轮对话里我不会丢，你随时可以问「我刚才说了什么」来抽查。`;
    }

    case 'cando':
      return [
        '我是「对谈录」里的助手。有一点必须先说清楚：**现在跑的是本地离线回答**，不是真实大模型，所以我不会假装自己能推理或查资料。',
        '',
        '离线模式下我确实能做到的：',
        '- **多轮记忆**：从你的原话里抽名字、职业、在学什么、在做哪个项目，后面顺着用；',
        '- **回溯上文**：你问「我刚才说了什么」时，我回到历史里找并原样引用；',
        '- **逐字流式**：回答是一个字一个字写出来的，不是一次性出现；',
        '- **刷新不丢**：对话存在浏览器本地，刷新、关掉再打开都还在。',
        '',
        '配置 `DEEPSEEK_API_KEY` 重启后，同一套界面就会换成真实模型的回答。',
      ].join('\n');

    case 'mockmode':
      return [
        '因为这个服务启动时**没有找到 API Key**，所以自动降级成了本地离线回答。',
        '',
        '降级是刻意的：宁可给一个诚实的模板回答，也不要整个功能开箱即报错。判定逻辑在 `server.mjs` 里：',
        '',
        '```js',
        "const HAS_MODEL = Boolean(API_KEY) && !FORCE_MOCK;",
        "const MODE = HAS_MODEL ? 'model' : 'mock';",
        '```',
        '',
        '想切到真实模型：设置 `DEEPSEEK_API_KEY` 后重启；想强制留在离线模式演示，设 `AI_FORCE_MOCK=1`。',
      ].join('\n');

    case 'compose': {
      const topic = question.replace(/^.*?(?:帮我|请)?(?:写|生成)(?:一段|一个|个)?/, '').replace(/(文案|介绍|简介|说明|总结)$/, '').trim();
      const subject = topic || facts.get('build')?.value || '这个项目';
      return [
        `以「${truncate(subject, 24)}」为主题，给你一版可以直接改的短文案：`,
        '',
        `> ${truncate(subject, 24)}：把反复做的事，做一次就够。`,
        '',
        '离线模式下我只能给出这类占位措辞，谈不上真正的创作。接上真实模型后，把同样的要求再发一次，质量会完全不同。',
        '',
        '---',
        offlineFooter(),
      ].join('\n');
    }

    case 'continue': {
      const lines = priorUserLines(history);
      if (!lines.length) return '前面还没有聊过什么，所以没有「接着」可以接。先问我一个问题吧。';
      const opener = truncate(lines[0], 40);
      return [
        `接着「${opener}」往下说：`,
        '',
        '- 这条线在离线模式下只能展开一层，因为我没有真正的知识库；',
        '- 更实际的下一步是把这个问题拆成两三个更小的子问题，逐个问。',
        '',
        '---',
        offlineFooter(),
      ].join('\n');
    }

    case 'time':
      return `现在的时间是 **${new Date().toLocaleString('zh-CN', { hour12: false })}**。这条是本地时钟直接读的，跟模型没关系。`;

    case 'weather':
      return [
        '天气需要外部数据源，离线模式拿不到，我不编。',
        '',
        '两个可行做法：',
        '- 在本项目里加一个 `/api/weather` 代理，转发到气象服务（本仓库的 `cloud-atlas/` 就是这么做的，可以直接参考）；',
        '- 或者配置 API Key，让真实模型答复，但它同样无法查实时天气，只会在有联网工具时才行。',
      ].join('\n');

    case 'stock':
      return '股价、汇率这类实时行情，离线模式没有数据，也不应该靠记忆回答——那是编造。需要的话得接一个行情接口。';

    case 'news':
      return '训练数据之外的新消息我拿不到。离线模式只能承认这一点，不会假装知道「今天发生了什么」。';

    case 'greet': {
      const who = name ? `${name}，` : '';
      return `${who}你好。直接问就行——技术问题、代码、或者只是想试验一下这个界面的多轮记忆和流式输出都可以。`;
    }

    case 'thanks':
      return '不客气。想继续就接着问，想换话题点右上角的「清空对话」。';

    case 'bye':
      return '好，这轮就到这里。对话已经存在本地，关掉页面再回来还在。';

    case 'clear_intent':
      return '清空需要你自己点右上角的**清空对话**按钮——我不替你做这个决定，那一按之后就找不回来了。';

    default: {
      if (sheet) return [sheet.body, '', '---', offlineFooter()].join('\n');
      if (related) {
        return [
          `你前面提过「${truncate(related, 50)}」，这条我还记着。`,
          '',
          `关于现在这个问题「${truncate(question, 40)}」：离线模式没有能力真正推理，所以我给不了可靠答案。`,
          '',
          '想验证这个界面的对话能力，可以试试这几句：',
          '- 「我叫小林，在做记账工具」→ 我抽事实并记住',
          '- 「我叫什么」→ 我回到上文回答',
          '- 「我刚才说了什么」→ 我列出你之前的原话',
          '',
          '---',
          offlineFooter(),
        ].join('\n');
      }
      return generalAnswer(question, history, facts);
    }
  }
}

// ---------------------------------------------------------------- 流式产出

/**
 * 把回答文本切成有节奏的增量块。
 *
 * 契约（与 streamModel 一致，不要改成裸字符串 —— 消费端按 piece.text / piece.error 取用）：
 *   { text }  一段增量
 *   { error } 出错
 *
 * 按标点决定停顿：句末停得久一点，逗号次之，其余几乎不停——
 * 这样「逐字写出」看起来像人在写，而不是机器在刷屏。
 */
async function* typewrite(text, { signal } = {}) {
  const CHUNK = 2;
  for (let i = 0; i < text.length; i += CHUNK) {
    const piece = text.slice(i, i + CHUNK);
    yield { text: piece };
    const tail = piece.at(-1);
    let wait = 16;
    if (tail === '\n') wait = 70;
    else if ('。！？!?；;'.includes(tail)) wait = 130;
    else if ('，,、：:'.includes(tail)) wait = 65;
    else if (tail === '`' || tail === '*') wait = 26;
    await sleep(wait, signal);
  }
}

/**
 * 生成离线回答的增量流。
 * @param {{role:string,content:string}[]} history
 * @param {{signal?: AbortSignal}} options
 * @returns {AsyncGenerator<{text?:string, error?:string}>}
 */
export async function* createMockReply(history, { signal } = {}) {
  const text = composeReply(history);
  // 真实模型有一段「思考」延迟，这里补上，界面的加载态才有意义
  await sleep(240, signal);
  yield* typewrite(text, { signal });
}

export { composeReply, extractFacts };
