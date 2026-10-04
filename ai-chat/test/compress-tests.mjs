// 上下文压缩：什么时候压、压哪一段、压完发什么
//
//   node test/compress-tests.mjs
//
// 这个功能的底线有两条，都在这里钉住：
//  1. **原始消息一条都不删**。压缩只改「发给模型的那一份」——
//     本地记录、界面、导出始终是完整的对话。摘要是加法，不是删除。
//  2. **摘要必须真的顶替掉那几条**。否则就是「压了个寂寞」：
//     界面上说压过了，请求里却还是把全文发出去（或者更糟：什么都没发）。
//
// 模块用 data: URL 加载：store.js 里是相对路径 import。

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

function freshEnvironment() {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear(),
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
  const makeTarget = () => ({ addEventListener: () => {}, visibilityState: 'visible' });
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

/** 造 n 条消息，每条 chars 个字（user/assistant 交替）。
 *  平铺 content 与 versions 都写上：store 里的消息就是这两样都有的（平铺字段镜像最新一版）。 */
function makeMessages(rounds, chars = 500) {
  const messages = [];
  for (let i = 0; i < rounds; i += 1) {
    const question = `第 ${i + 1} 个问题`.padEnd(chars, '问');
    const answer = `第 ${i + 1} 个回答`.padEnd(chars, '答');
    messages.push({ role: 'user', content: question, versions: [{ content: question }] });
    messages.push({ role: 'assistant', content: answer, versions: [{ content: answer }] });
  }
  return messages;
}

// ---------------------------------------------------------------- 体量与切分

group('体量估算与切分');

{
  const {
    estimateChars,
    messageChars,
    coveredCount,
    compressionPlan,
    KEEP_RECENT,
    KEEP_RECENT_MANUAL,
    SOFT_LIMIT_CHARS,
    HARD_LIMIT_CHARS,
    MIN_COMPRESS_CHARS,
    MIN_COMPRESS_CHARS_MANUAL,
  } = await loadModule('compress.js');

  check('单条消息按正文字数算', messageChars({ content: '12345' }) === 5);
  check('引用也算进体量（它是真的发出去的）', messageChars({ content: 'ab', quote: { text: 'cde' } }) === 5);
  check('空消息算 0', messageChars({}) === 0 && messageChars(null) === 0);
  check('整体体量是各条之和', estimateChars([{ content: 'ab' }, { content: 'cde' }]) === 5);

  check('没有摘要时覆盖数为 0', coveredCount(makeMessages(3), null) === 0);
  check('覆盖数会被夹在消息条数之内',
    coveredCount(makeMessages(2), { covers: 999 }) === 4,
    String(coveredCount(makeMessages(2), { covers: 999 })));

  // 短会话：什么都不该做
  const short = makeMessages(2, 100);
  check('短会话不压缩', compressionPlan({ messages: short }).mode === 'none');

  // 中等会话：安排后台压缩（50 条 × 500 字 ≈ 25k，在软线与硬线之间）
  const backgroundFixture = makeMessages(25, 500);
  const mediumPlan = compressionPlan({ messages: backgroundFixture });
  check('过了软线就安排后台压缩', mediumPlan.mode === 'background', `${mediumPlan.mode} / ${mediumPlan.liveChars}`);
  check('后台压缩留出最近几条不压',
    mediumPlan.to === backgroundFixture.length - KEEP_RECENT, String(mediumPlan.to));

  // 很大：发之前就得压（80 条 × 500 字 ≈ 40k，过了硬线）
  const blockingFixture = makeMessages(40, 500);
  const bigPlan = compressionPlan({ messages: blockingFixture });
  check('过了硬线就改成「发之前先压」', bigPlan.mode === 'blocking', `${bigPlan.mode} / ${bigPlan.liveChars}`);
  check('两个阈值确实是软 < 硬', SOFT_LIMIT_CHARS < HARD_LIMIT_CHARS);

  // 阈值量的是「未压缩部分」：已经压过一大半的会话不该再被压
  const mostlyCompressed = compressionPlan({
    messages: makeMessages(40, 500),
    summary: { text: '摘要', covers: 70 },
  });
  check('已经压过的部分不再计入体量', mostlyCompressed.liveChars < SOFT_LIMIT_CHARS, String(mostlyCompressed.liveChars));
  check('剩下的太少就不压', mostlyCompressed.mode === 'none', mostlyCompressed.mode);

  // 手动：忽略阈值、而且留得少（用户自己点的，就是要腾地方）
  check('手动压缩对短会话也能用',
    compressionPlan({ messages: makeMessages(6, 500), force: true }).mode === 'blocking');
  check('手动压缩只留最后一轮（不然会「点了却几乎没压掉什么」）',
    compressionPlan({ messages: makeMessages(6, 500), force: true }).keepRecent === KEEP_RECENT_MANUAL,
    String(compressionPlan({ messages: makeMessages(6, 500), force: true }).keepRecent));
  check('手动压缩能压掉更多',
    compressionPlan({ messages: makeMessages(6, 500), force: true }).chars >
      compressionPlan({ messages: makeMessages(6, 500) }).chars);
  check('手动压缩对太短的会话仍然不动（压完省不下东西）',
    compressionPlan({ messages: makeMessages(2, 100), force: true }).mode === 'none');
  check('手动压缩的下限比自动低', MIN_COMPRESS_CHARS_MANUAL < MIN_COMPRESS_CHARS);

  // 已经压过一次：这一次从「上次覆盖到的位置」开始
  const again = compressionPlan({ messages: makeMessages(60, 500), summary: { text: '上次的摘要', covers: 20 } });
  check('第二次压缩从上次的终点接着压', again.from === 20, String(again.from));
  check('第二次压缩仍然保留最近几条', again.to === makeMessages(60, 500).length - KEEP_RECENT, String(again.to));

  // 不变量：from ≤ to（app.js 直接拿这两个下标去 slice）
  const fullyCompressed = compressionPlan({ messages: makeMessages(10, 500), summary: { text: '摘要', covers: 19 } });
  check('压得只剩几条时，切分区间不会反过来', fullyCompressed.from <= fullyCompressed.to,
    `${fullyCompressed.from} → ${fullyCompressed.to}`);
  check('已经没有新东西可压时不压', fullyCompressed.mode === 'none', fullyCompressed.mode);
}

// ---------------------------------------------------------------- 摘要的规整

group('摘要的规整与显示');

{
  const { normalizeSummary, summaryBlock, summaryLabel, SUMMARY_MAX_CHARS } = await loadModule('compress.js');

  check('正常摘要能过', normalizeSummary({ text: '这是摘要', covers: 12 })?.text === '这是摘要');
  check('空摘要丢掉', normalizeSummary({ text: '   ', covers: 12 }) === null);
  check('没有 text 丢掉', normalizeSummary({ covers: 12 }) === null);
  check('没有覆盖条数丢掉（否则不知道它顶替了哪一段）', normalizeSummary({ text: '摘要' }) === null);
  check('非对象丢掉', normalizeSummary(null) === null && normalizeSummary('摘要') === null);

  check('去掉模型爱写的「以下是摘要：」前缀',
    normalizeSummary({ text: '以下是摘要：闭包与作用域', covers: 4 })?.text === '闭包与作用域',
    normalizeSummary({ text: '以下是摘要：闭包与作用域', covers: 4 })?.text);
  check('去掉「这是…摘要:」这种',
    normalizeSummary({ text: '这是对话摘要: 讲了闭包', covers: 4 })?.text === '讲了闭包');
  check('超长摘要会被截断',
    normalizeSummary({ text: 'x'.repeat(5000), covers: 4 }).text.length === SUMMARY_MAX_CHARS);
  check('首尾空白去掉', normalizeSummary({ text: '\n\n  摘要  \n' , covers: 4 })?.text === '摘要');
  check('带上时间与模型（便于排查）',
    normalizeSummary({ text: '摘要', covers: 4, at: 123, model: 'gpt-4o' })?.at === 123 &&
      normalizeSummary({ text: '摘要', covers: 4, model: 'gpt-4o' })?.model === 'gpt-4o');

  const block = summaryBlock({ text: '讲了闭包', covers: 4 });
  check('发给模型的摘要块标明了这是压缩过的上文', block.includes('较早对话的摘要'), block);
  check('摘要正文在里面', block.includes('讲了闭包'));
  check('还提醒了「细节已省略，可以让用户复述」', block.includes('复述'));
  check('没有摘要时是空串', summaryBlock(null) === '');

  check('界面说明写了压掉多少条与摘要长度',
    summaryLabel({ text: '一二三四五', covers: 12 }) === '以上 12 条已压缩成摘要 · 约 5 字',
    summaryLabel({ text: '一二三四五', covers: 12 }));
}

// ---------------------------------------------------------------- 压缩请求的原料

group('压缩这次请求要发什么');

{
  const { buildSummaryMessages, toTranscript, SUMMARY_SYSTEM_PROMPT } = await loadModule('compress.js');

  const messages = [
    { role: 'user', content: '闭包是什么' },
    { role: 'assistant', content: '闭包是函数记住它出生时的环境。' },
  ];
  const transcript = toTranscript(messages);
  check('对话拼成「用户：/ 助手：」', transcript.includes('用户：闭包是什么') && transcript.includes('助手：闭包是'));
  check('单条超长会截断（本来就是要压小的）', toTranscript([{ role: 'user', content: 'x'.repeat(5000) }]).length < 1600);
  check('空消息不占一行', toTranscript([{ role: 'user', content: '   ' }]) === '');

  const built = buildSummaryMessages({ messages });
  check('两条消息：system + user', built.length === 2);
  check('system 就是那份压缩提示词', built[0].content === SUMMARY_SYSTEM_PROMPT);
  check('提示词要求只输出摘要', /只输出摘要/.test(built[0].content));
  check('提示词要求保留事实与决定',
    /事实与数据/.test(built[0].content) && /已经做出的决定/.test(built[0].content), built[0].content);
  check('提示词要求保留用户的偏好与未解决的问题',
    /用户的偏好与要求/.test(built[0].content) && /尚未解决的问题/.test(built[0].content));
  check('提示词要求代码与专有名词原样保留（改写它们等于毁掉上下文）',
    /代码片段/.test(built[0].content) && /原样保留/.test(built[0].content));
  check('提示词要求可以丢掉寒暄与重复确认', /寒暄/.test(built[0].content));
  check('提示词要求同一种语言', /相同的语言/.test(built[0].content));
  check('用户消息里带上待压缩的对话', built[1].content.includes('闭包是什么'));

  const again = buildSummaryMessages({ messages, previousSummary: { text: '上次压过的内容', covers: 10 } });
  check('再压一次会把上次的摘要一起带上（越压越紧）', again[1].content.includes('上次压过的内容'), again[1].content);
  check('再压一次仍然带上新要压的部分', again[1].content.includes('闭包是什么'));
}

// ---------------------------------------------------------------- 请求历史

group('压进请求历史：摘要顶替掉那几条');

{
  const { buildRequestHistory } = await loadModule('versions.js');
  const v = (content) => ({ content, attachments: [], createdAt: 0 });

  const q1 = { role: 'user', versions: [v('第一个问题')] };
  const a1 = { role: 'assistant', versions: [v('第一个回答')] };
  const q2 = { role: 'user', versions: [v('第二个问题')] };
  const a2 = { role: 'assistant', versions: [v('第二个回答')] };
  const q3 = { role: 'user', versions: [v('第三个问题')] };
  const a3 = { role: 'assistant', versions: [v('')] };
  const messages = [q1, a1, q2, a2, q3, a3];

  const plain = buildRequestHistory(messages, q3, a3);
  check('没压缩时按原样发', plain.length === 5 && plain[0].content === '第一个问题', JSON.stringify(plain.map((m) => m.role)));

  const compressed = buildRequestHistory(messages, q3, a3, { summary: { text: '前面聊了闭包', covers: 4 } });
  check('压缩后最前面是一条 system 摘要', compressed[0].role === 'system', JSON.stringify(compressed[0]));
  check('摘要在正文里', compressed[0].content.includes('前面聊了闭包'));
  check('被覆盖的那 4 条不再逐条发', !compressed.some((m) => m.content === '第一个问题'), JSON.stringify(compressed));
  check('没被覆盖的部分照常发全文',
    compressed.some((m) => m.content === '第三个问题'), JSON.stringify(compressed));
  check('请求仍然以 user 消息结尾（服务端会校验）', compressed.at(-1).role === 'user');
  check('压缩之后消息确实变少了', compressed.length < plain.length, `${plain.length} → ${compressed.length}`);

  // 覆盖范围越界时不能把最后那句提问也吞掉
  const over = buildRequestHistory(messages, q3, a3, { summary: { text: '摘要', covers: 99 } });
  check('覆盖范围越界时不会连提问一起吞掉', over.some((m) => m.role === 'user'), JSON.stringify(over));

  // 空摘要等于没压缩
  const empty = buildRequestHistory(messages, q3, a3, { summary: { text: '', covers: 4 } });
  check('没有摘要正文时按原文发', !empty.some((m) => m.role === 'system'));
}

// ---------------------------------------------------------------- 存储

group('摘要存进会话里');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  store.pushUser('第一个问题');
  const { message: a1 } = store.pushAssistant();
  store.appendDelta(a1, '第一个回答');
  store.finish(a1, 'done');
  store.pushUser('第二个问题');
  const { message: a2 } = store.pushAssistant();
  store.appendDelta(a2, '第二个回答');
  store.finish(a2, 'done');

  check('新会话没有摘要', store.session.summary === null);

  const saved = store.setSummary({ text: '前两条的摘要', covers: 2, model: 'gpt-4o' });
  check('摘要存下来了', saved?.text === '前两条的摘要');
  check('会话上能读到', store.session.summary?.text === '前两条的摘要');
  check('记下了覆盖条数', store.session.summary?.covers === 2);
  check('消息一条都没少（压缩不是删除）', store.messages.length === 4, String(store.messages.length));

  const { createStore: createStore2 } = await loadStore();
  const reloaded = createStore2();
  check('刷新后摘要还在', reloaded.session.summary?.text === '前两条的摘要');
  check('刷新后消息仍然一条不少', reloaded.messages.length === 4);
  check('刷新后覆盖条数还在', reloaded.session.summary?.covers === 2);

  reloaded.setSummary({ text: '更长的摘要', covers: 4 });
  check('覆盖范围等于消息条数时整条丢掉（否则请求里只剩摘要）',
    reloaded.session.summary === null, JSON.stringify(reloaded.session.summary));

  reloaded.setSummary({ text: '摘要', covers: 2 });
  reloaded.clearSummary();
  check('可以取消压缩', reloaded.session.summary === null);

  reloaded.setSummary({ text: '摘要', covers: 2 });
  reloaded.clear();
  check('清空会话时摘要一起作废', reloaded.session.summary === null);
  check('清空后消息也没了', reloaded.messages.length === 0);

  // 脏数据
  const dirty = createStore();
  dirty.setSummary({ text: '摘要', covers: 999 });
  check('覆盖条数越界的摘要在存储层就被丢掉', dirty.session.summary === null);
}

// ---------------------------------------------------------------- 导出

group('导出里的压缩说明');

{
  const { toMarkdown, toPlainText, toJson } = await loadModule('exporters.js');

  const session = {
    id: 's_1',
    title: '测试对话',
    createdAt: 0,
    updatedAt: 0,
    summary: { text: '前面聊了闭包与作用域。', covers: 6, at: 0, model: 'gpt-4o' },
    messages: [
      { id: 'u1', role: 'user', content: '闭包是什么', createdAt: 0, status: 'done', attachments: [] },
      { id: 'a1', role: 'assistant', content: '闭包是函数…', createdAt: 1, status: 'done', attachments: [] },
    ],
  };

  const md = toMarkdown(session);
  check('Markdown 导出交代了压缩过', md.includes('上下文压缩'), md.slice(0, 200));
  check('Markdown 导出带上摘要正文', md.includes('前面聊了闭包与作用域。'));
  check('Markdown 导出里原始消息仍然完整', md.includes('闭包是什么') && md.includes('闭包是函数…'));

  const txt = toPlainText(session);
  check('纯文本导出也交代了压缩', txt.includes('【上下文压缩】'), txt.slice(0, 120));

  const json = JSON.parse(toJson(session)).sessions[0];
  check('JSON 导出把摘要放在独立字段', json.contextSummary?.text === '前面聊了闭包与作用域。');
  check('JSON 导出带上覆盖条数', json.contextSummary?.covers === 6);
  check('JSON 导出不动 messages（记录始终完整）', json.messages.length === 2);

  const none = JSON.parse(toJson({ ...session, summary: null })).sessions[0];
  check('没压缩时不出字段', none.contextSummary === null);
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
  counts['compress-tests'] = { count: passed, failed: failures.length };
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
