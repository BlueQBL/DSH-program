// 会话标题：怎么起、怎么洗、什么时候该换
//
//   node test/title-tests.mjs
//
// 标题看着是小事，但它决定了「以后能不能翻回这段对话」，而且有两条硬规则必须守住：
//   · 用户自己改过的名字**永远不许被自动覆盖**；
//   · 模型吐出来的东西不能直接上屏（引号、句号、「标题：」前缀、整段解释都得洗掉）。
//
// 这两条都在这里被钉住。模块用 data: URL 加载：store.js 里是相对路径 import。

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

function freshEnvironment() {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  const makeTarget = () => ({
    addEventListener: () => {},
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

// ---------------------------------------------------------------- 本地兜底标题

group('本地兜底标题：模型标题回来之前，列表里也得有个能认的名字');

{
  const { fallbackTitle, TITLE_MAX_CHARS } = await loadModule('title.js');

  check('空内容给出占位标题', fallbackTitle('') === '新对话');
  check('纯空白也给出占位标题', fallbackTitle('   \n  ') === '新对话');
  check('普通提问原样用', fallbackTitle('闭包是什么') === '闭包是什么');
  // 「帮我」「你好」「麻烦你」这类客套话对标题没有信息量，直接去掉
  check('去掉开头的「帮我」', fallbackTitle('帮我看看这段代码为什么报错') === '这段代码为什么报错',
    fallbackTitle('帮我看看这段代码为什么报错'));
  check('礼貌用语可以叠着剥', fallbackTitle('你好，麻烦你帮我看下这个报错') === '这个报错',
    fallbackTitle('你好，麻烦你帮我看下这个报错'));
  check('连请求动词一起去掉',
    fallbackTitle('解释一下什么是闭包') === '什么是闭包', fallbackTitle('解释一下什么是闭包'));
  check('削完只剩一两个字时就不削（别把内容当客套话扔掉）',
    fallbackTitle('介绍一下你自己') === '介绍一下你自己', fallbackTitle('介绍一下你自己'));
  check('只取第一句', fallbackTitle('这段代码为什么报错。另外顺便看下风格') === '这段代码为什么报错',
    fallbackTitle('这段代码为什么报错。另外顺便看下风格'));
  check('抹掉句末标点', fallbackTitle('闭包是什么？') === '闭包是什么');
  check('去掉结尾的语气词', fallbackTitle('帮我看看这个吧') === '看看这个', fallbackTitle('帮我看看这个吧'));
  check('粘一大段代码时取第一行（那通常就是问题本身）',
    fallbackTitle('这段代码有什么问题\nfunction f() { return 1 }\nconsole.log(f())') === '这段代码有什么问题',
    fallbackTitle('这段代码有什么问题\nfunction f() { return 1 }\nconsole.log(f())'));
  check('代码围栏那一行不算内容',
    fallbackTitle('```js\n这段报错是什么原因呢') === '这段报错是什么原因',
    fallbackTitle('```js\n这段报错是什么原因呢'));
  check('第一行太短就退回整段',
    fallbackTitle('看下\n这段报错到底是什么原因引起的') === '这段报错到底是什么原因引起的',
    fallbackTitle('看下\n这段报错到底是什么原因引起的'));
  check('去掉包裹的引号', fallbackTitle('  「你好 世界」  ') === '你好 世界', fallbackTitle('  「你好 世界」  '));

  const long = fallbackTitle('这段代码在循环里会一直卡住不动而且没有任何报错信息');
  check('过长时截断并加省略号', long.length === TITLE_MAX_CHARS + 1 && long.endsWith('…'), long);
}

// ---------------------------------------------------------------- 清洗模型输出

group('清洗模型输出：模型爱加的包装都要去掉');

{
  const { cleanTitle, titleFromModel } = await loadModule('title.js');

  check('去掉两头的引号', cleanTitle('"闭包是什么"') === '闭包是什么');
  check('去掉书名号', cleanTitle('《闭包是什么》') === '闭包是什么');
  check('去掉中文引号', cleanTitle('「闭包是什么」') === '闭包是什么');
  check('去掉 Markdown 加粗', cleanTitle('**闭包是什么**') === '闭包是什么');
  check('去掉句末标点', cleanTitle('闭包是什么。') === '闭包是什么');
  check('去掉「标题：」前缀', cleanTitle('标题：闭包是什么') === '闭包是什么');
  check('去掉英文 Title 前缀', cleanTitle('Title: What is a closure') === 'What is a closure');
  check('只取第一行（后面的解释不要）',
    cleanTitle('闭包是什么\n\n这段对话讨论了…') === '闭包是什么', cleanTitle('闭包是什么\n\n这段对话讨论了…'));
  check('多层包装也能剥', cleanTitle('「"闭包是什么"」') === '闭包是什么');

  check('句子作为标题可用', titleFromModel('"闭包是什么？"') === '闭包是什么');
  check('过短的结果放弃（宁可留着兜底标题）', titleFromModel('好') === null);
  check('空输出放弃', titleFromModel('') === null && titleFromModel('   ') === null);
  check('非字符串输入不会抛异常', titleFromModel(null) === null && titleFromModel(undefined) === null);
  check('退化的空词放弃', titleFromModel('对话') === null && titleFromModel('标题') === null);
  check('英文退化词也放弃', titleFromModel('New chat') === null && titleFromModel('Untitled') === null);

  const longTitle = titleFromModel('这是一个特别特别特别特别特别特别长的标题名称');
  check('过长时裁到上限以内', longTitle.length <= 18, `${longTitle} (${longTitle.length})`);
  check('裁完不留句末标点', !/[。，、：]$/.test(longTitle), longTitle);
}

// ---------------------------------------------------------------- 这批原料怎么拼

group('起标题那次请求的内容');

{
  const { buildTitleMessages, TITLE_SYSTEM_PROMPT } = await loadModule('title.js');

  const messages = buildTitleMessages({ question: '闭包是什么', answer: '闭包是函数记住它出生时的环境。' });
  check('两条消息：system + user', messages.length === 2);
  check('system 就是那份起标题提示词', messages[0].content === TITLE_SYSTEM_PROMPT);
  check('system 要求只输出标题', /只输出标题/.test(messages[0].content));
  check('system 要求同一语言', /相同的语言/.test(messages[0].content));
  check('用户消息里带上问题', messages[1].content.includes('闭包是什么'));
  check('用户消息里带上回答（很多话题要看到回答才说得清）',
    messages[1].content.includes('闭包是函数记住它出生时的环境。'));

  const withLater = buildTitleMessages({
    question: '第一问',
    answer: '第一答',
    laterQuestions: ['后来又问了这个', '还有这个'],
  });
  check('后来问过的事也带上（避免标题只描述开头）',
    withLater[1].content.includes('后来又问了这个') && withLater[1].content.includes('还有这个'));
  check('后面问的只取最近几条', buildTitleMessages({
    question: 'q',
    answer: 'a',
    laterQuestions: ['1', '2', '3', '4', '5', '6'],
  })[1].content.includes('- 6'));

  const huge = buildTitleMessages({ question: 'x'.repeat(5000), answer: 'y'.repeat(5000) });
  check('超长输入会被裁掉（起标题不该烧掉一整篇正文）', huge[1].content.length < 2000, String(huge[1].content.length));
  check('没有回答时也照样能起', buildTitleMessages({ question: '只有问题' })[1].content.includes('只有问题'));
}

// ---------------------------------------------------------------- 谁起的名字

group('titleSource：用户改过的名字永远不许被覆盖');

{
  const { inferTitleSource, needsAutoTitle, fallbackTitle } = await loadModule('title.js');

  const session = (over = {}) => ({
    title: '新对话',
    messages: [],
    ...over,
  });

  check('空会话是「还没起名」', inferTitleSource(session()) === 'none');
  check('显式声明的来源优先', inferTitleSource(session({ titleSource: 'manual', title: 'x' })) === 'manual');

  const firstQuestion = '帮我看看这段代码为什么报错';
  const autoTitle = fallbackTitle(firstQuestion);
  const messages = [
    { role: 'user', content: firstQuestion },
    { role: 'assistant', content: '报错是因为…' },
  ];
  check('老数据：标题等于本地兜底算出来的 → 判定为机器起的',
    inferTitleSource(session({ title: autoTitle, messages })) === 'fallback');
  check('老数据：标题对不上 → 判定为用户自己改的',
    inferTitleSource(session({ title: '我自己起的名字', messages })) === 'manual');

  check('兜底标题的会话可以升级成模型标题',
    needsAutoTitle(session({ title: autoTitle, titleSource: 'fallback', messages })) === true);
  check('用户改过的会话不再自动改名',
    needsAutoTitle(session({ title: '我起的', titleSource: 'manual', messages })) === false);
  check('已经有模型标题的会话不重复起',
    needsAutoTitle(session({ title: '模型起的', titleSource: 'auto', messages })) === false);
  check('还没答案时不急着起标题',
    needsAutoTitle(session({ title: autoTitle, titleSource: 'fallback', messages: [messages[0]] })) === false);
  check('空会话不起标题', needsAutoTitle(session()) === false);
}

// ---------------------------------------------------------------- 存进会话里

group('标题怎么落进会话');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  check('新会话还没有名字', store.session.title === '新对话' && store.session.titleSource === 'none');

  store.pushUser('帮我看看这段代码为什么报错');
  check('第一句话就有一个能认的兜底标题', store.session.title === '这段代码为什么报错', store.session.title);
  check('来源标成兜底', store.session.titleSource === 'fallback');

  const { message: answer } = store.pushAssistant();
  store.appendDelta(answer, '报错是因为变量没声明。');
  store.finish(answer, 'done');

  check('有答案之后才该去要模型标题', store.needsAutoTitle(store.session.id) === true);

  check('模型标题能换上', store.applyTitle(store.session.id, '变量未声明的报错') === true);
  check('换上之后标题是模型给的', store.session.title === '变量未声明的报错');
  check('来源标成模型', store.session.titleSource === 'auto');

  check('同一个会话不再重复要标题', store.needsAutoTitle(store.session.id) === false);
  check('模型标题不会覆盖模型标题', store.applyTitle(store.session.id, '另一个名字') === false);

  // 最要紧的一条：用户改过的名字
  store.renameSession(store.session.id, '我的调试记录');
  check('用户改名后来源标成用户', store.session.titleSource === 'manual');
  check('自动改名动不了用户的名字', store.applyTitle(store.session.id, '模型想改的名字') === false);
  check('用户的名字还在', store.session.title === '我的调试记录');

  check('用户明确点「起名」时可以换（force）',
    store.applyTitle(store.session.id, '变量未声明的报错', { force: true }) === true);
  check('force 之后标题更新了', store.session.title === '变量未声明的报错');

  check('模型给了空话时不改标题', store.applyTitle(store.session.id, '对话', { force: true }) === false);
  check('空话之后标题仍是上一个', store.session.title === '变量未声明的报错');

  // 后续提问不能把标题改回首条提问的截断版
  store.pushUser('再问一个别的问题');
  check('第二问不会把标题改回去', store.session.title === '变量未声明的报错', store.session.title);

  // 刷新之后要记得是谁起的名字
  const { createStore: createStore2 } = await loadStore();
  const reloaded = createStore2();
  check('刷新后标题还在', reloaded.session.title === '变量未声明的报错');
  check('刷新后来源还在（否则会被当成兜底标题重新起名）',
    reloaded.session.titleSource === 'auto', String(reloaded.session.titleSource));

  reloaded.renameSession(reloaded.session.id, '手写的');
  const { createStore: createStore3 } = await loadStore();
  check('刷新后用户改的名字仍是「用户起的」', createStore3().session.titleSource === 'manual');

  // 清空会话 = 名字作废，下一轮重新起
  store.clear();
  check('清空后标题回到占位', store.session.title === '新对话');
  check('清空后来源回到 none', store.session.titleSource === 'none');
}

group('老数据：标题来源靠内容反推');

{
  const { createStore } = await loadStore();
  const { fallbackTitle } = await loadModule('title.js');
  const KEY = 'duitanlu.sessions.v2';

  // 造一份「旧版本写的」数据：没有 titleSource 字段
  const legacy = (title) => ({
    version: 2,
    activeId: 's_legacy_1',
    sessions: [
      {
        id: 's_legacy_1',
        title,
        createdAt: 1,
        updatedAt: 2,
        personaId: 'default',
        systemPrompt: '',
        model: '',
        messages: [
          { role: 'user', content: '帮我看看这段代码为什么报错' },
          { role: 'assistant', content: '报错是因为…', status: 'done' },
        ],
      },
    ],
  });

  // 老数据里由本地兜底算出来的标题 —— 用它来验证「认得出这是机器起的」
  const derived = fallbackTitle('帮我看看这段代码为什么报错');

  freshEnvironment();
  globalThis.localStorage.setItem(KEY, JSON.stringify(legacy(derived)));
  const auto = createStore();
  check('老数据里由本地算出来的标题 → 判定为机器起的',
    auto.session.titleSource === 'fallback', String(auto.session.titleSource));

  freshEnvironment();
  globalThis.localStorage.setItem(KEY, JSON.stringify(legacy('我自己起的名字')));
  const manual = createStore();
  check('老数据里用户改过的标题 → 判定为用户起的',
    manual.session.titleSource === 'manual', String(manual.session.titleSource));
  check('用户起的名字不会被自动改名动到',
    manual.applyTitle('s_legacy_1', '模型想改的名字') === false);
}

// ---------------------------------------------------------------- 汇总

try {
  const tempDir = path.resolve(HERE, '../.tmp-mutations');
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(
    path.join(tempDir, 'ui-result.json'),
    JSON.stringify({ passed, failed: [...failures] }, null, 2),
    'utf8',
  );
  const countsFile = path.join(tempDir, 'counts.json');
  const counts = existsSync(countsFile) ? JSON.parse(readFileSync(countsFile, 'utf8')) : {};
  counts['title-tests'] = { count: passed, failed: failures.length };
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
