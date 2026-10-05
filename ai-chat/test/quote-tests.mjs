// 引用回答：划中一段、接着问
//
//   node test/quote-tests.mjs
//
// 这条链路有三段容易出错，都要能离线验证：
//   1. 规整：选定的一段里常带多余换行、行尾空格、超长内容
//   2. 存储：引用要跟着「版本」走，刷新后还在，编辑重发时旧版本原样保留
//   3. 发送：引用必须真的出现在发给模型的正文里（这是这个功能的全部意义），
//      同时库里存的仍然是用户自己打的那句话
//
// 模块用 data: URL 加载：store.js 里是相对路径 import，需要先改写成绝对路径。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_LIB = path.resolve(HERE, '../public/lib');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- 环境替身

let pageHideHandlers = [];

function freshEnvironment() {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  pageHideHandlers = [];
  const makeTarget = () => ({
    addEventListener: (type, fn) => {
      if (type === 'pagehide') pageHideHandlers.push(fn);
    },
    visibilityState: 'visible',
  });
  globalThis.document = makeTarget();
  globalThis.window = makeTarget();

  return backing;
}

const moduleCache = new Map();
async function loadModule(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  let source = readFileSync(path.join(PUBLIC_LIB, file), 'utf8');
  source = source.replace(/from\s+'\.\/([\w.-]+)'/g, (_m, dep) => {
    const depPath = path.join(PUBLIC_LIB, dep).replace(/\\/g, '/');
    return `from 'file:///${depPath}'`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const mod = await import(url);
  moduleCache.set(file, mod);
  return mod;
}

const loadStore = () => loadModule('store.js');

// ---------------------------------------------------------------- 规整

group('引用文本的规整');

{
  const { cleanQuoteText, normalizeQuote, hasQuote, quoteFromSelection, MAX_QUOTE_CHARS } =
    await loadModule('quote.js');

  check('Windows 换行统一成 \\n', cleanQuoteText('一\r\n二') === '一\n二');
  check('行尾空白被去掉', cleanQuoteText('一   \n二\t') === '一\n二');
  check('连续空行压成一个', cleanQuoteText('一\n\n\n\n二') === '一\n\n二');
  check('首尾空白被去掉', cleanQuoteText('\n\n  一  \n') === '一');
  check('空字符串规整成空串', cleanQuoteText('') === '');
  check('非字符串不会抛异常', cleanQuoteText(null) === '' && cleanQuoteText(42) === '');

  const long = '字'.repeat(MAX_QUOTE_CHARS + 500);
  check('超长引用被截断到上限', cleanQuoteText(long).length === MAX_QUOTE_CHARS);

  check('空内容不算引用', normalizeQuote('') === null && normalizeQuote('   \n ') === null);
  check('null / undefined 不算引用', normalizeQuote(null) === null && normalizeQuote(undefined) === null);
  check('裸字符串也能当引用', normalizeQuote('一段话')?.text === '一段话');

  const q = normalizeQuote({ text: '  原文  ', page: 3, messageId: 'm1' });
  check('规整后带上出处', q.text === '原文' && q.page === 3 && q.messageId === 'm1');
  check('没有截断时标记为 false', q.truncated === false);

  const truncated = normalizeQuote({ text: long });
  check('截断时打上标记', truncated.truncated === true);
  check('截断后的长度确实在上限内', truncated.text.length <= MAX_QUOTE_CHARS);

  check('页码非法一律落到第 1 页',
    normalizeQuote({ text: 'x', page: 0 }).page === 1 &&
      normalizeQuote({ text: 'x', page: -5 }).page === 1 &&
      normalizeQuote({ text: 'x', page: 'abc' }).page === 1);
  check('messageId 非法时置空', normalizeQuote({ text: 'x', messageId: 7 }).messageId === null);

  check('hasQuote 认得真引用', hasQuote({ text: 'x' }) === true);
  check('hasQuote 否掉空引用', hasQuote(null) === false && hasQuote({ text: '  ' }) === false);

  // 只认回答那一侧：允许引用自己的提问没有意义，还会让「引的是谁」变含糊
  check('选区不在回答里就不给引用',
    quoteFromSelection({ text: '一段话', inAnswer: false }) === null);
  check('选区在回答里才给引用',
    quoteFromSelection({ text: '一段话', inAnswer: true, page: 2 })?.page === 2);
  check('回答里但没选中文字也不给', quoteFromSelection({ text: '   ', inAnswer: true }) === null);
}

// ---------------------------------------------------------------- 显示

group('引用在界面上的说法');

{
  const { quoteLabel, quotePreview } = await loadModule('quote.js');

  check('单页回答说「引用回答」', quoteLabel({ text: 'x', page: 1 }) === '引用回答');
  check('多页时点明第几页', quoteLabel({ text: 'x', page: 3 }) === '引用回答 · 第 3 页');

  check('预览折成一行', quotePreview({ text: '一行\n两行' }) === '一行 两行');
  const preview = quotePreview({ text: '很长的一段话'.repeat(30) }, 20);
  check('预览超长时截断并加省略号', preview.length === 21 && preview.endsWith('…'), preview);
}

// ---------------------------------------------------------------- 发给模型

group('引用怎么发给模型');

{
  const { quoteForRequest, composeUserContent } = await loadModule('quote.js');

  const block = quoteForRequest({ text: '第一行\n\n第三行', page: 2 });
  const lines = block.split('\n');
  check('引用的每一行都带 >，空行也带', lines.every((l) => l.startsWith('>')), JSON.stringify(lines));
  check('引用块开头标出出处', lines[0].includes('第 2 页'), lines[0]);
  check('引用原文一字不动地保留', block.includes('第一行') && block.includes('第三行'));

  const composed = composeUserContent('那第三点呢？', { text: '第一行', page: 1 });
  check('正文在引用之后', composed.endsWith('那第三点呢？'), composed);
  check('引用与正文之间空一行', composed.includes('\n\n那第三点呢？'));
  check('整段引用在前', composed.startsWith('> '), composed);

  check('没有引用时正文原样返回', composeUserContent('就一个问题', null) === '就一个问题');
  check('没有引用时空正文也不会变成 null',
    composeUserContent('', null) === '' && composeUserContent(undefined, null) === '');

  // 只引用、不说话：内容就是引用本身（目前的界面不会这么发，但拼装层不能拼出 undefined）
  const onlyQuote = composeUserContent('', { text: '只有引用' });
  check('只有引用时不会拼出 undefined', onlyQuote.includes('只有引用') && !onlyQuote.includes('undefined'));
}

// ---------------------------------------------------------------- 存储

group('引用存进会话里');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const asked = store.pushUser('那第三点再展开讲讲', {
    quote: { text: '第三，要注意边界情况。', page: 2, messageId: 'a1' },
  });
  const message = asked.message;

  check('提问上带着引用', message.quote?.text === '第三，要注意边界情况。');
  check('引用记下了来自第几页', message.quote?.page === 2);
  check('引用也写进了版本（引用跟着版本走）', message.versions[0].quote?.text === '第三，要注意边界情况。');
  check('库里存的正文仍然只是用户打的那句话',
    message.content === '那第三点再展开讲讲' && !message.content.includes('第三，'));

  // 刷新
  const { createStore: createStore2 } = await loadStore();
  const reloaded = createStore2();
  check('刷新后引用还在', reloaded.messages[0].quote?.text === '第三，要注意边界情况。');
  check('刷新后页号还在', reloaded.messages[0].quote?.page === 2);

  // 脏数据
  const dirty = createStore();
  dirty.pushUser('脏数据', { quote: { text: '   ' } });
  check('空白引用不会被存下来', dirty.messages.at(-1).quote === null);
  dirty.pushUser('脏数据二', { quote: 42 });
  check('非法引用不会被存下来', dirty.messages.at(-1).quote === null);

  // 新提问不带引用时必须是 null，不能沿用上一条的
  const plain = store.pushUser('这条没有引用');
  check('新提问不带引用时是 null', plain.message.quote === null);
}

group('编辑与重新生成时的引用');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const quote = { text: '被引用的那一段', page: 1, messageId: 'a1' };
  const asked = store.pushUser('第一个问题', { quote });
  const question = asked.message;

  // 编辑重发：新增一页，新版本继承引用，旧版本的引用原样保留
  const edited = store.pushUser('改过的问题', { edit: question, version: 1 });
  check('编辑重发新增了一页', question.versions.length === 2);
  check('新的一页继承了引用', edited.message.versions[1].quote?.text === '被引用的那一段');
  check('旧的一页的引用没被动过', question.versions[0].quote?.text === '被引用的那一段');

  // 编辑重发时不接受新引用：它改的是「问什么」，不是「引了哪一段」
  store.pushUser('再改一次', { edit: question, version: 2, quote: { text: '不该生效的引用' } });
  check('编辑时传进来的新引用会被忽略',
    question.versions[2].quote?.text === '被引用的那一段',
    String(question.versions[2].quote?.text));

  // 重新生成（reuse）：原地替换，引用不能丢
  store.pushUser('再改一次', { edit: question, version: 3, reuse: true });
  check('重新生成不新增页', question.versions.length === 3);
  check('重新生成后引用还在', question.versions[2].quote?.text === '被引用的那一段');
}

// ---------------------------------------------------------------- 请求历史

group('请求历史里的引用');

{
  const { buildRequestHistory } = await loadModule('versions.js');

  const v = (content, extra = {}) => ({ content, attachments: [], createdAt: 0, ...extra });

  {
    const q = { role: 'user', versions: [v('那第三点呢？', { quote: { text: '第三，注意边界。', page: 1 } })] };
    const a = { role: 'assistant', versions: [v('第三点是这样的…')] };
    const h = buildRequestHistory([q, a], q, a);

    check('发出去的提问里带了引用块', h[0].content.includes('> 第三，注意边界。'), h[0].content);
    check('引用块里标了出处', h[0].content.includes('引用回答'));
    check('用户自己的问题在引用之后', h[0].content.trimEnd().endsWith('那第三点呢？'));
    check('历史以正在回答的那一问结尾（服务端要求末条是 user）', h.at(-1)?.role === 'user',
      h.map((x) => x.role).join(','));
    // 助手那条永远不带引用（引用只属于提出它的那一次提问）。
    // 拿「前面还有一轮」的形状来验 —— 末尾那一问的回答此刻还没生成，本来就不该在历史里。
    const priorQuestion = { role: 'user', versions: [v('上一条提问')] };
    const priorAnswer = { role: 'assistant', versions: [v('上一条回答')] };
    const answerEntry = buildRequestHistory([priorQuestion, priorAnswer, q, a], q, a)
      .find((x) => x.role === 'assistant');
    check('助手回答不会被塞进引用',
      answerEntry?.content === '上一条回答' && !answerEntry.content.includes('第三，注意边界。'),
      JSON.stringify(answerEntry));
  }

  {
    // 引用了第几页就写第几页：用户可能停在旧的一页上提问
    const q = { role: 'user', versions: [v('这个呢', { quote: { text: '旧页的一段', page: 3 } })] };
    const a = { role: 'assistant', versions: [v('回答')] };
    const h = buildRequestHistory([q, a], q, a);
    check('引用写明了是第几页', h[0].content.includes('第 3 页'), h[0].content);
  }

  {
    // 多版本：每一版各自的引用都要按顺序出现，不能都用最新那版
    const q = {
      role: 'user',
      versions: [
        v('第一版问题', { quote: { text: '第一版引的原文', page: 1 } }),
        v('第二版问题', { quote: { text: '第二版引的原文', page: 2 } }),
      ],
    };
    const a = { role: 'assistant', versions: [v('第一版回答'), v('')] };
    const h = buildRequestHistory([q, a], q, a);

    const users = h.filter((x) => x.role === 'user');
    check('两个版本的提问都在', users.length === 2, String(users.length));
    check('第一版带的是它自己引的那段', users[0].content.includes('第一版引的原文'), users[0].content);
    check('第二版带的是它自己引的那段', users[1].content.includes('第二版引的原文'), users[1].content);
    check('两版之间没有串用引用', !users[0].content.includes('第二版引的原文'));
  }

  {
    // 引用不只影响「最后那一轮」：前面几轮引过的原文同样要在历史里，
    // 否则模型看到的上文会缺一块（改过的引用等于没引）
    const q1 = {
      role: 'user',
      versions: [v('前面那轮的问题', { quote: { text: '前面那轮引的原文', page: 1 } })],
    };
    const a1 = { role: 'assistant', versions: [v('前面那轮的回答')] };
    const q2 = { role: 'user', versions: [v('这一轮的问题')] };
    const a2 = { role: 'assistant', versions: [v('')] };
    const h = buildRequestHistory([q1, a1, q2, a2], q2, a2);

    check('前面几轮引过的原文也在请求里', h[0].content.includes('前面那轮引的原文'), h[0].content);
    check('前面几轮用户自己说的话没丢', h[0].content.trimEnd().endsWith('前面那轮的问题'), h[0].content);
    check('前面几轮的助手回答不会被加引用', h[1].content === '前面那轮的回答', h[1].content);
    check('最后那一轮没有引用就不加', h.at(-1).content === '这一轮的问题', h.at(-1).content);
  }

  {
    // 没引用的轮次：一个 > 都不该多出来
    const q = { role: 'user', versions: [v('普通问题')] };
    const a = { role: 'assistant', versions: [v('普通回答')] };
    const h = buildRequestHistory([q, a], q, a);
    check('没有引用时不加任何引用块', h[0].content === '普通问题', h[0].content);
  }

  {
    // 图片仍然只跟末尾那条提问走，引用不能把它带偏
    const img = { dataUrl: 'data:image/png;base64,AAA', name: 'a.png', mime: 'image/png' };
    const q = {
      role: 'user',
      versions: [v('带图问题', { quote: { text: '引的原文', page: 1 }, attachments: [img] })],
    };
    const a = { role: 'assistant', versions: [v('回答')] };
    const h = buildRequestHistory([q, a], q, a);
    check('图片照常跟着末条提问', h[0].images.length === 1, JSON.stringify(h[0].images));
    check('引用和图片可以同时存在',
      h[0].content.includes('引的原文') && h[0].images.length === 1);
  }
}

// ---------------------------------------------------------------- 导出

group('导出里的引用');

{
  const { toMarkdown, toPlainText, toJson } = await loadModule('exporters.js');

  const session = {
    id: 's_1',
    title: '测试对话',
    createdAt: 0,
    updatedAt: 0,
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: '那第三点呢？',
        createdAt: 0,
        status: 'done',
        attachments: [],
        quote: { text: '第三，注意边界。', page: 2, truncated: false },
      },
      { id: 'a1', role: 'assistant', content: '第三点是这样的…', createdAt: 1, status: 'done', attachments: [] },
    ],
  };

  const md = toMarkdown(session);
  check('Markdown 导出里有引用块', md.includes('> 第三，注意边界。'), md.slice(0, 200));
  check('Markdown 导出里标了出处', md.includes('第 2 页'));
  check('Markdown 导出里用户的话还在', md.includes('那第三点呢？'));

  const txt = toPlainText(session);
  check('纯文本导出里有引用', txt.includes('第三，注意边界。'), txt);
  check('纯文本导出里标了出处', txt.includes('引用回答'));
  check('纯文本导出里用户的话还在', txt.includes('那第三点呢？'));

  const json = JSON.parse(toJson(session));
  const msg = json.sessions[0].messages[0];
  check('JSON 导出把引用放在独立字段里', msg.quote?.text === '第三，注意边界。');
  check('JSON 导出不把引用混进 content', msg.content === '那第三点呢？');
  check('JSON 导出记下了页号', msg.quote?.page === 2);

  const noQuote = JSON.parse(toJson({ ...session, messages: [session.messages[1]] }));
  check('没有引用时不出 quote 字段', noQuote.sessions[0].messages[0].quote === null);
}

// ---------------------------------------------------------------- 汇总

// 把失败项写进文件：变异测试要读它判断「这个缺陷有没有被测到」。
// 不能用管道捕获 stdout —— 受限沙箱下带 stdio:'pipe' 的子进程会直接 EPERM。
try {
  const tempDir = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    path.join(tempDir, 'ui-result.json'),
    JSON.stringify({ passed, failed: [...failures] }, null, 2),
    'utf8',
  );

  // 同时登记真实断言数，供 test/readme-tests.mjs 核对 README 里的数字
  const countsFile = path.join(tempDir, 'counts.json');
  const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  counts['quote-tests'] = { count: passed, failed: failures.length };
  writeFileSync(countsFile, JSON.stringify(counts, null, 2), 'utf8');
} catch {
  /* 写不了不影响正常使用 */
}

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
