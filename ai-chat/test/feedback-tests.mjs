// 对回答的评价：赞 / 踩 + 意见反馈
//
//   node test/feedback-tests.mjs
//
// 三条要守住的东西：
//  1. **评价跟着「页」走**：一条回答可以有多页，第 1 页的赞不该跑到第 2 页去；
//  2. **点错了能改**：再点一次取消、点另一边改判 —— 这是 ChatGPT 被抱怨最多的点；
//  3. **脏数据不许上屏**：localStorage 是可以手改的，认不出来的原因 id 一律丢掉。
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

// ---------------------------------------------------------------- 规整与显示

group('评价的规整与显示');

{
  const {
    normalizeFeedback,
    ratingInfo,
    reasonsFor,
    feedbackLabel,
    reasonLabels,
    feedbackSummary,
    sameFeedback,
    DOWN_REASONS,
    MAX_NOTE_CHARS,
    MAX_REASONS,
  } = await loadModule('feedback.js');

  check('两档按钮都有名字', ratingInfo('up').label === '有用' && ratingInfo('down').label === '没用');
  check('未知档位回落到第一档（界面不会白屏）', ratingInfo('sideways').id === 'up');

  check('拉踩给出一排原因', reasonsFor('down').length >= 4);
  check('点赞不再多问一层（跟 ChatGPT 一样）', reasonsFor('up').length === 0);

  const up = normalizeFeedback({ rating: 'up' });
  check('只点赞也算一条完整评价', up?.rating === 'up' && up.reasons.length === 0 && up.note === '');
  check('点赞能带一句补充', normalizeFeedback({ rating: 'up', note: '讲得很清楚' })?.note === '讲得很清楚');

  const down = normalizeFeedback({ rating: 'down', reasons: ['wrong', 'verbose'], note: '  第三条不对  ' });
  check('拉踩能带原因和说明', down.reasons.join() === 'wrong,verbose' && down.note === '第三条不对');
  check('说明会去掉首尾空白', down.note === '第三条不对');

  check('没有 rating 就不是评价', normalizeFeedback({}) === null && normalizeFeedback(null) === null);
  check('rating 非法也当没有评价', normalizeFeedback({ rating: 'maybe' }) === null);

  check('认不出来的原因 id 被丢掉（手改的 localStorage 不许上屏）',
    normalizeFeedback({ rating: 'down', reasons: ['wrong', 'hacked', 'wrong'] })?.reasons.join() === 'wrong',
    JSON.stringify(normalizeFeedback({ rating: 'down', reasons: ['wrong', 'hacked', 'wrong'] })?.reasons));
  check('点赞不吃原因（那一档没有选项）',
    normalizeFeedback({ rating: 'up', reasons: ['wrong'] })?.reasons.length === 0);
  check('原因最多留几条', normalizeFeedback({
    rating: 'down',
    reasons: DOWN_REASONS.map((r) => r.id),
  }).reasons.length === MAX_REASONS);
  check('说明超长会被截断',
    normalizeFeedback({ rating: 'down', note: 'x'.repeat(2000) }).note.length === MAX_NOTE_CHARS);

  check('「👍 有用」这种短标签', feedbackLabel(up) === '👍 有用' && feedbackLabel(down) === '👎 没用');
  check('原因转成中文标签', reasonLabels(down).join('、') === '事实有错、太啰嗦');
  check('一行摘要含标签、原因与说明',
    feedbackSummary(down) === '👎 没用 · 事实有错、太啰嗦 · 补充：第三条不对', feedbackSummary(down));
  check('没有评价时摘要为空', feedbackSummary(null) === '');

  check('内容一样的两条评价算同一条', sameFeedback(up, normalizeFeedback({ rating: 'up' })) === true);
  check('原因不同就不是同一条',
    sameFeedback(down, normalizeFeedback({ rating: 'down', reasons: ['wrong'] })) === false);
  check('null 与 null 相同、null 与非 null 不同', sameFeedback(null, null) === true && sameFeedback(up, null) === false);
}

group('点错了要能改');

{
  const { toggleRating, toggleReason } = await loadModule('feedback.js');

  check('没评过 → 点赞', toggleRating(null, 'up') === 'up');
  check('点同一档 → 取消', toggleRating('up', 'up') === null);
  check('点赞改拉踩 → 改判', toggleRating('up', 'down') === 'down');
  check('拉踩改点赞 → 改判', toggleRating('down', 'up') === 'up');
  check('非法档位不动它', toggleRating('up', 'nope') === null);

  check('原因可以多选', toggleReason(['wrong'], 'verbose').join() === 'wrong,verbose');
  check('再点一次取消这一项', toggleReason(['wrong', 'verbose'], 'wrong').join() === 'verbose');
  check('原因最多三条（再多也问不出更多信息）',
    toggleReason(['wrong', 'verbose', 'incomplete'], 'other').length === 3);
  check('脏数据不会让原因变成非数组', Array.isArray(toggleReason(undefined, 'wrong')));
}

group('发给服务端的那一条');

{
  const { feedbackPayload, normalizeFeedback } = await loadModule('feedback.js');

  const feedback = normalizeFeedback({ rating: 'down', reasons: ['wrong'], note: '不对' });
  const payload = feedbackPayload({
    feedback,
    sessionId: 's_1',
    messageId: 'm_2',
    version: 2,
    model: 'deepseek-v3.2',
    mode: 'model',
    question: '闭包是什么',
    answer: '答'.repeat(1000),
  });

  check('带上评价本身', payload.rating === 'down' && payload.reasons.join() === 'wrong');
  check('带上是谁在哪儿评的', payload.sessionId === 's_1' && payload.messageId === 'm_2' && payload.version === 2);
  check('带上模型与模式（不然这条日志没法归因）', payload.model === 'deepseek-v3.2' && payload.mode === 'model');
  check('带上问题与答案的开头', payload.questionExcerpt === '闭包是什么' && payload.answerExcerpt.startsWith('答答'));
  check('答案只留一小段（不把整篇回答写进日志）', payload.answerExcerpt.length <= 301, String(payload.answerExcerpt.length));
  check('默认动作是「记下」', payload.action === 'set');
  check('没有评价就没有 payload', feedbackPayload({ feedback: null }) === null);

  // 撤回也要能发出去：日志是追加写的，不记这一笔就推不出「最后到底是赞还是踩」
  const cleared = feedbackPayload({ feedback: null, action: 'clear', sessionId: 's_1', messageId: 'm_2', version: 2 });
  check('撤回评价也会发一条出去', cleared?.action === 'clear');
  check('撤回那一条不带档位', cleared?.rating === null && cleared?.reasons.length === 0);
  check('撤回那一条仍然带上是谁评的', cleared?.sessionId === 's_1' && cleared?.version === 2);
}

// ---------------------------------------------------------------- 存进会话

group('评价怎么落进会话');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  store.pushUser('闭包是什么');
  const { message: answer } = store.pushAssistant();
  store.appendDelta(answer, '闭包是函数记住它出生时的环境。');
  store.finish(answer, 'done');

  check('新回答还没有评价', answer.feedback === null);

  const saved = store.setFeedback(answer, 1, { rating: 'up' });
  check('点赞存下来了', saved?.rating === 'up');
  check('消息上的平铺字段也同步了', answer.feedback?.rating === 'up');
  check('版本上也有（评价跟着页走）', answer.versions[0].feedback?.rating === 'up');

  store.setFeedback(answer, 1, { rating: 'down', reasons: ['wrong'], note: '第二条不对' });
  check('改判会覆盖上一档', answer.versions[0].feedback.rating === 'down');
  check('改判后原因与说明也更新', answer.versions[0].feedback.reasons.join() === 'wrong');

  store.setFeedback(answer, 1, null);
  check('取消评价会清干净', answer.versions[0].feedback === null);
  check('取消后平铺字段也清干净', answer.feedback === null);

  store.setFeedback(answer, 1, { rating: 'down', reasons: ['hacked'] });
  check('脏原因存不进来', answer.versions[0].feedback.reasons.length === 0);

  // 刷新
  store.setFeedback(answer, 1, { rating: 'up', note: '很有帮助' });
  const { createStore: createStore2 } = await loadStore();
  const reloaded = createStore2();
  const reloadedAnswer = reloaded.messages.find((m) => m.role === 'assistant');
  check('刷新后评价还在', reloadedAnswer.feedback?.rating === 'up');
  check('刷新后补充说明还在', reloadedAnswer.feedback?.note === '很有帮助');
  check('刷新后在版本上也在', reloadedAnswer.versions[0].feedback?.rating === 'up');
}

group('多页回答：评价跟着页走');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const { message: question } = store.pushUser('第一版问题');
  const { message: answer } = store.pushAssistant({ question, version: 1 });
  store.appendDelta(answer, '第一版回答');
  store.finish(answer, 'done');

  // 编辑重发 → 第 2 页
  store.pushUser('第二版问题', { edit: question, version: 1 });
  store.pushAssistant({ question, version: 2 });
  const second = answer.versions[1];
  second.content = '第二版回答';
  second.status = 'done';

  store.setFeedback(answer, 1, { rating: 'up', note: '第一页不错' });
  check('第 1 页的评价落在第 1 版上', answer.versions[0].feedback?.note === '第一页不错');
  check('第 2 页没有被带上评价', answer.versions[1].feedback == null, JSON.stringify(answer.versions[1].feedback));

  store.setFeedback(answer, 2, { rating: 'down', reasons: ['incomplete'] });
  check('两页可以各有各的评价',
    answer.versions[0].feedback.rating === 'up' && answer.versions[1].feedback.rating === 'down');

  const { createStore: createStore2 } = await loadStore();
  const reloaded = createStore2();
  const reloadedAnswer = reloaded.messages.find((m) => m.role === 'assistant');
  check('刷新后两页的评价都还在',
    reloadedAnswer.versions[0].feedback?.rating === 'up' && reloadedAnswer.versions[1].feedback?.rating === 'down');

  check('对用户消息不能评价', store.setFeedback(question, 1, { rating: 'up' }) === null);
  check('页码越界时回落到最后一页', store.setFeedback(answer, 99, { rating: 'up' })?.rating === 'up');
}

group('重新生成会把旧评价清掉');

{
  freshEnvironment();
  const { createStore } = await loadStore();
  const store = createStore();

  const { message: question } = store.pushUser('闭包是什么');
  const { message: answer } = store.pushAssistant({ question, version: 1 });
  store.appendDelta(answer, '第一版回答');
  store.finish(answer, 'done');
  store.setFeedback(answer, 1, { rating: 'up', note: '这条不错' });
  check('先给这一页打了个赞', answer.versions[0].feedback?.rating === 'up');

  // 重新生成：同一页重写回答。旧评价评的是**已经不存在的文字**，不能留着
  store.pushAssistant({ question, version: 1 });
  check('重新生成后旧评价被清掉', answer.versions[0].feedback === null, JSON.stringify(answer.versions[0].feedback));
  check('平铺字段也清了', answer.feedback === null);
}

// ---------------------------------------------------------------- 导出

group('导出里的评价');

{
  const { toMarkdown, toPlainText, toJson } = await loadModule('exporters.js');

  const session = {
    id: 's_1',
    title: '测试对话',
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { id: 'u1', role: 'user', content: '闭包是什么', createdAt: 0, status: 'done', attachments: [] },
      {
        id: 'a1',
        role: 'assistant',
        content: '闭包是函数记住它出生时的环境。',
        createdAt: 1,
        status: 'done',
        attachments: [],
        feedback: { rating: 'down', reasons: ['wrong', 'verbose'], note: '第二条不对', at: 0 },
      },
    ],
  };

  const md = toMarkdown(session);
  check('Markdown 导出里有评价', md.includes('评价：👎 没用'), md.slice(-160));
  check('导出里带上原因与说明', md.includes('事实有错、太啰嗦') && md.includes('第二条不对'));

  const txt = toPlainText(session);
  check('纯文本导出里有评价', txt.includes('（评价：👎 没用'), txt);

  const json = JSON.parse(toJson(session)).sessions[0].messages[1];
  check('JSON 导出把评价放在独立字段', json.feedback?.rating === 'down');
  check('JSON 导出带上原因与时间', json.feedback.reasons.join() === 'wrong,verbose' && typeof json.feedback.at === 'string');
  check('JSON 导出不把评价混进正文', json.content === '闭包是函数记住它出生时的环境。');

  const noFeedback = JSON.parse(toJson({
    ...session,
    messages: [session.messages[0], { ...session.messages[1], feedback: null }],
  })).sessions[0].messages[1];
  check('没有评价时不出 feedback 字段', noFeedback.feedback === null);
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
  counts['feedback-tests'] = { count: passed, failed: failures.length };
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
