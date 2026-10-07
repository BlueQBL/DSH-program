// 文档结构检查
//
//   node test/readme-tests.mjs
//
// 守住三件事：
//  · 章节是否齐全，以及 **README 里不许出现「缺陷修复记录」**（这是明确要求：
//    README 只讲现在是什么样、怎么用、为什么这么设计；排查过程留在代码注释和测试里）
//  · 文件树里提到的文件是否真的存在
//  · 文档写的断言数是否等于实际跑出来的数
//
// 数字一致性刻意不去数字面 `check(` 的调用数：有的断言在条件分支里（只走一条路），
// 有的在循环里（一次调用产生多条断言）—— 静态数出来的和实际执行的对不上。

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const lines = readme.split('\n');

console.log('文档结构');

// ---------------------------------------------------------------- 章节完整性

const REQUIRED_SECTIONS = [
  // 刻意**不带数字**：以前叫「七个主要功能」，功能加到十几个之后那个「七」就成了假话。
  // 会过期的标题不该出现在文档里 —— 这一条也是文档测试自己盯出来的。
  '## 主要功能',
  '## 运行',
  '## 需求对照',
  '## 结构',
  '## 接口',
  '## 测试',
  '## 设计说明',
  '## 已知限制',
  '## 数据与隐私',
];

check('README 存在', readme.length > 2000);
for (const section of REQUIRED_SECTIONS) {
  check(`章节还在：${section.replace('## ', '')}`, readme.includes(section));
}

// README 不承担缺陷史。这条不是洁癖：一旦把「修过什么」写进来，
// 它就会不断生长，最后把「这东西现在怎么用」淹没掉。
// 这条断言同时也是给以后的自己看的 —— 别再往里加。
const forbiddenHeadings = readme.match(/^#{2,3}.*(修掉的问题|修复记录|缺陷修复|踩过的坑)/m);
check('README 不写缺陷修复记录（章节层面）', forbiddenHeadings === null,
  forbiddenHeadings ? `出现了「${forbiddenHeadings[0].trim()}」` : '');
const forbiddenBlocks = readme.match(/^>.*踩过的坑/m);
check('README 不写缺陷修复记录（引用块层面）', forbiddenBlocks === null,
  forbiddenBlocks ? `出现了「${forbiddenBlocks[0].trim()}」` : '');

// ---------------------------------------------------------------- 数字一致性

/**
 * README 里写的断言数，必须等于**实际跑出来的数**。
 *
 * 这里刻意不去数字面 `check(` 的调用数：有的断言在条件分支里（只走一条路），
 * 有的在循环里（一次调用产生多条断言）—— 静态数出来的和实际执行的对不上，
 * 我按那个思路写的第一版就误报了三条。
 *
 * 所以每个套件跑完会把自己的真实数字写进 .tmp-mutations/counts.json，这里读它。
 * 少了哪个套件的记录，就说明那个套件没跑过 —— 也算失败。
 */
const COUNTS_FILE = path.join(ROOT, '.tmp-mutations', 'counts.json');
const docLines = {
  'run-tests': 'node test/run-tests.mjs',
  'store-tests': 'node test/store-tests.mjs',
  'title-tests': 'node test/title-tests.mjs',
  'quote-tests': 'node test/quote-tests.mjs',
  'feedback-tests': 'node test/feedback-tests.mjs',
  'compress-tests': 'node test/compress-tests.mjs',
  'auth-tests': 'node test/auth-tests.mjs',
  'ui-tests': 'node test/ui-tests.mjs',
  'verify-upstream-payload': 'node test/verify-upstream-payload.mjs',
};

let counts = {};
if (existsSync(COUNTS_FILE)) {
  try {
    counts = JSON.parse(readFileSync(COUNTS_FILE, 'utf8'));
  } catch {
    counts = {};
  }
}

check(
  '能读到各套件的真实断言数（先跑一遍 npm test）',
  Object.keys(counts).length > 0,
  `缺少 ${COUNTS_FILE} —— 先运行 node test/run-tests.mjs 等套件`,
);

let documentedTotal = 0;
for (const [suite, command] of Object.entries(docLines)) {
  const actual = counts[suite]?.count;
  const line = lines.find((l) => l.includes(command));
  const documented = Number(line?.match(/(\d+)\s*项/)?.[1] ?? NaN);
  if (Number.isFinite(documented)) documentedTotal += documented;

  check(
    `${suite} 文档记录的断言数与实际一致`,
    Number.isFinite(actual) && actual === documented,
    actual === undefined
      ? '没跑过这个套件（先运行它）'
      : `文档写 ${documented}，实际 ${actual}`,
  );
}

{
  // 文档里的总数 = 四个功能套件之和。
  // readme-tests 自己不算在内 —— 它正是做这个核对的，把自己计进去会绕回来。
  const totalLine = lines.find((l) => l.includes('npm test') && l.includes('项'));
  const documentedSum = Number(totalLine?.match(/(\d+)\s*项/)?.[1] ?? NaN);
  check(
    '文档里的总数等于四个功能套件之和',
    Number.isFinite(documentedSum) && documentedSum === documentedTotal,
    `总数写 ${documentedSum ?? '(未写)'}，四个套件加起来 ${documentedTotal}`,
  );
}

// ---------------------------------------------------------------- 引用的文件存在

const referenced = new Set();
for (const m of readme.matchAll(/`(public\/[\w./-]+|test\/[\w.-]+|server\.mjs)`/g)) {
  referenced.add(m[1]);
}
const missing = [...referenced].filter((rel) => !existsSync(path.join(ROOT, rel)));
check('README 提到的文件都真实存在', missing.length === 0, `缺失：${missing.join(', ')}`);
// 文件树里必须列出这两个「纯函数模块」，它们是可测性的关键
check('文件树列出了 versions.js', /├── versions\.js|versions\.js\s+#/.test(readme));
check('文件树列出了 copy-feedback.js', /copy-feedback\.js\s+#/.test(readme));

// ---------------------------------------------------------------- 关键约定写进了文档

const CONTRACTS = [
  ['编辑重发保留旧页', /编辑一律追加新页|新增一页/],
  ['重新生成不新增页', /不新增页/],
  ['复制有就地反馈', /就地反馈|按钮变成.*已复制/],
  ['新会话角色是通用助手', /通用助手/],
  ['DeepSeek 不支持图片', /DeepSeek 全系不支持图片/],
  ['刷新是开新会话的例外', /刷新是例外/],
  ['顶部固定且滚动时收窄', /固定在页面顶部[\s\S]{0,400}?自动收窄/],
  ['引用一段回答接着问（有独立说明）', /### 引用一段回答，接着问/],
  ['引用只认回答那一侧', /只认回答那一侧/],
  ['引用不混进用户原话', /库里存的仍然只是你打的那句话|引用是单独一个字段/],
  ['会话标题由 AI 起', /\/api\/title|让模型给会话起/],
  ['用户改过的标题不会被 AI 覆盖', /不会覆盖你改过的名字|AI 起的标题永远不会覆盖/],
  ['可以给回答点赞 / 拉踩并补充意见', /👍 有用|点赞（👍）/],
  ['评价点错了能改', /再点一次.{0,6}取消|能改判/],
  ['会话过长会压缩上下文', /压缩|摘要/],
  ['压缩不会删掉本地消息', /原始消息一条都不删|一条不删|不会删掉/],
  ['归档只是收起来，一条数据都没删', /收起来，但一条数据都没删|收起来了，但别删/],
  ['归档和删除不是一回事（搜得到、能还原）', /列表里没有[\s\S]{0,20}和[\s\S]{0,10}搜得到[\s\S]{0,20}同时成立/],
  ['登录是可选的（不登录照样能用）', /不登录照样能用|不登录就是前面那些章节描述的样子/],
  ['密码是哈希存的，不是明文', /scrypt 加随机盐|没有明文密码|\*\*没有明文\*\*/],
  ['改密码会让别处的登录立刻失效', /立刻失效/],
  ['换名字不要密码、也不影响别的设备', /换名字[\s\S]{0,200}(不要密码|不查密码)[\s\S]{0,200}(踢下线|不影响)/],
  ['这套认证不是经过审计的（公网要套 HTTPS）', /不是一套经过审计的身份系统[\s\S]{0,200}HTTPS/],
  ['登录时能点最近登录过的账号', /最近登录过的账号/],
  ['那张名单里没有密码', /只有名字和时间戳[\s\S]{0,140}(没有密码|不存密码)/],
  ['背景是印在纸上的（不影响可读性）', /图是印在纸上的|印在纸上的，不是糊在内容前面/],
  ['背景那一层为什么不能用负 z-index', /负 z-index 的兄弟节点画在[\s\S]{0,80}之前/],
  ['不透明度滑块和数字是联动的', /滑块和数字是\*\*同一件事的两个入口\*\*/],
  ['深色图会自动换成浅色字', /深色图会自动换|深色图：字会自己变成浅色/],
  ['深浅靠亮度算，不是靠"看着像深色"', /相对亮度算[\s\S]{0,200}(看着像深色|纯蓝)/],
  ['深色档只改令牌、不逐个改颜色', /翻一套配色只改 4 个令牌[\s\S]{0,300}派生/],
];
for (const [name, pattern] of CONTRACTS) {
  check(`文档写明了「${name}」`, pattern.test(readme));
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${'─'.repeat(52)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
for (const f of failures) console.log(`  · ${f}`);
process.exit(1);
