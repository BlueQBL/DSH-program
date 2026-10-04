// 文档结构检查
//
//   node test/readme-tests.mjs
//
// 为什么文档也要测：README 里「开发过程中修掉的几个真问题」这一节
// **被我的大段文本替换失手弄丢过两次**。它载着整个项目的排查记录，
// 丢了以后光靠肉眼很难发现（README 本身还是完整的、也还能读）。
//
// 顺带守住几条「文档说的和代码做的是否一致」：
//  · 测试数字与真实断言数是否对得上
//  · 文件树里提到的文件是否真的存在
//  · 关键行为约定有没有被写进文档

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
  '## 六个主要功能',
  '## 运行',
  '## 需求对照',
  '## 结构',
  '## 接口',
  '## 测试',
  '## 设计说明',
  '## 已知限制',
  '## 数据与隐私',
  '## 开发过程中修掉的几个真问题',
];

check('README 存在', readme.length > 2000);
for (const section of REQUIRED_SECTIONS) {
  check(`章节还在：${section.replace('## ', '')}`, readme.includes(section));
}

// 这一节被弄丢过两次，单独钉死
const fixesIdx = readme.indexOf('## 开发过程中修掉的几个真问题');
check('「修掉的问题」章节在文件末尾区域', fixesIdx > readme.length * 0.6,
  `位置 ${fixesIdx} / ${readme.length}`);
const fixEntries = (readme.slice(fixesIdx).match(/^\d+\. \*\*/gm) ?? []).length;
check('「修掉的问题」条目足够多（≥ 25）', fixEntries >= 25, `实际 ${fixEntries} 条`);
check('没有重复编号', (() => {
  const nums = [...readme.slice(fixesIdx).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
  return new Set(nums).size === nums.length;
})());

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
