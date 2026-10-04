// 会话标题的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/title-mutations.mjs
//
// 与另外三个变异脚本同一套思路：临时改坏源码里的一个关键判断，
// 跑一遍 title-tests，看它会不会失败。测试若抓不到自己声称要防的缺陷，就只是装饰。
//
// 这里最要紧的一条是「用户改过的名字不能被自动改名覆盖」——
// 它是这个功能的伦理底线：系统可以自动起名，但不能擅自改掉用户起的名字。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TITLE = 'public/lib/title.js';
const STORE = 'public/lib/store.js';
const FILES = [TITLE, STORE];

if (!existsSync(TITLE)) {
  console.error('请在 ai-chat/ 目录下运行：node test/title-mutations.mjs');
  process.exit(2);
}

const TEMP = '.tmp-mutations';
mkdirSync(TEMP, { recursive: true });
const RESULT = path.join(TEMP, 'ui-result.json');
const SENTINEL = path.join(TEMP, 'in-progress');

if (existsSync(SENTINEL)) {
  console.error('检测到 .tmp-mutations/in-progress：上一次变异测试没有正常结束。');
  console.error('请先检查 public/lib/ 下与标题相关的文件是否被改坏，再删掉该目录重试。');
  process.exit(2);
}
writeFileSync(SENTINEL, String(Date.now()), 'utf8');

const pristineSource = new Map();
for (const file of FILES) pristineSource.set(file, readFileSync(file, 'utf8'));
const pristine = (file) => pristineSource.get(file);

function restoreAll() {
  let ok = true;
  for (const [file, clean] of pristineSource) {
    if (readFileSync(file, 'utf8') !== clean) writeFileSync(file, clean, 'utf8');
    if (readFileSync(file, 'utf8') !== clean) ok = false;
  }
  return ok;
}

const bail = (code) => {
  const restored = restoreAll();
  if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
  if (!restored) console.error('⚠ 还原失败，请手动检查源码');
  process.exit(code);
};
process.on('SIGINT', () => bail(130));
process.on('SIGTERM', () => bail(143));
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err?.message ?? err);
  bail(1);
});

let allCaught = true;

function run(label, file, mutate) {
  const original = pristine(file);
  const mutated = mutate(original);
  if (mutated === original) {
    console.log(`  ? 变异没生效（替换没匹配上源码）：${label}`);
    allCaught = false;
    return;
  }
  writeFileSync(file, mutated, 'utf8');

  try {
    if (existsSync(RESULT)) unlinkSync(RESULT);
    const proc = spawnSync(process.execPath, ['test/title-tests.mjs'], { stdio: 'ignore' });

    let failed = [];
    let resultReadable = false;
    if (existsSync(RESULT)) {
      try {
        failed = JSON.parse(readFileSync(RESULT, 'utf8')).failed ?? [];
        resultReadable = true;
      } catch {
        /* 文件坏了，下面按「非零退出」判断 */
      }
    }

    if (proc.status === null) {
      console.log(`  ? 子进程没跑起来（沙箱限制？）：${label}`);
      allCaught = false;
      return;
    }

    const crashed = proc.status !== 0 && !resultReadable;
    const caught = failed.length > 0 || crashed;
    if (!caught) allCaught = false;
    console.log(`  ${caught ? '✓ 抓到了' : '✗ 逃过了'}  ${label}`);
    if (crashed) console.log(`      测试中途崩溃（退出码 ${proc.status}）`);
    else if (caught) console.log(`      失败断言：${failed.slice(0, 2).join(' / ')}`);
  } finally {
    if (!restoreAll()) {
      console.log('  ⚠ 还原失败，请手动检查源码');
      allCaught = false;
    }
  }
}

console.log('会话标题变异测试（每个变异都必须被抓到）\n');

// ---- 最要紧的一条：用户的名字不能被自动改名动到

run('自动改名不再区分来源（会把用户改过的名字覆盖掉）', STORE, (src) =>
  src.replace('      if (!force && source !== \'fallback\') return false;', '      if (false) return false;'),
);

run('用户改名时不标记来源（下次就会被当成兜底标题替换）', STORE, (src) =>
  src.replace("      session.titleSource = 'manual';", "      session.titleSource = 'fallback';"),
);

run('老数据一律当成兜底标题（用户起的名字会被改掉）', TITLE, (src) =>
  src.replace('  return first && title === fallbackTitle(first) ? \'fallback\' : \'manual\';', "  return 'fallback';"),
);

run('已经有模型标题的会话还会被重复改名', TITLE, (src) =>
  src.replace("  if (inferTitleSource(session) !== 'fallback') return false;", '  if (false) return false;'),
);

run('还没答案就急着起标题（用半截对话起出来的名字更差）', TITLE, (src) =>
  src.replace('  return hasQuestion && hasAnswer;', '  return hasQuestion;'),
);

// ---- 清洗：模型吐出来的东西不能直接上屏

run('不清洗模型输出（引号、句号都会显示在列表里）', TITLE, (src) =>
  src.replace('  text = stripWrappers(text.replace(/\\s+/g, \' \').trim());', '  text = text.trim();'),
);

run('不限制标题长度（列表里会被省略号截掉，等于白让模型多说）', TITLE, (src) =>
  src.replace(
    '  if (title.length > TITLE_MAX_CHARS) {',
    '  if (false) {',
  ),
);

run('空话也当成标题（会出现叫「对话」的会话）', TITLE, (src) =>
  src.replace('  if (!clean || DEGENERATE.test(clean)) return null;', '  if (!clean) return null;'),
);

run('过短的结果也接受（会留下一个字的名字）', TITLE, (src) =>
  src.replace('  return title.length >= 2 ? title : null;', '  return title;'),
);

// ---- 本地兜底标题：客套话与请求动词

run('兜底标题不剥客套话（「帮我看看…」会原样出现在列表里）', TITLE, (src) =>
  src.replace('    const match = rest.match(POLITE_PREFIX);', '    const match = null;'),
);

run('兜底标题不留情面地剥请求动词（「介绍一下你自己」会变成「你自己」）', TITLE, (src) =>
  src.replace('    if (next.length >= 4) rest = next;', '    rest = next;'),
);

// ---- 起标题的原料

run('起标题时不带回答（很多话题要看到回答才说得清）', TITLE, (src) =>
  src.replace('  if (String(answer ?? \'\').trim()) lines.push(`助手：${cut(answer, 600)}`);', ''),
);

run('起标题时不带后来问过的事（标题只会描述开头）', TITLE, (src) =>
  src.replace('  if (later.length) {', '  if (false) {'),
);

const restored = restoreAll();
if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
if (existsSync(RESULT)) unlinkSync(RESULT);

// 变异那一轮会把「改坏过的源码跑出来的断言数」写进 counts.json，
// 留着会让 readme-tests 报出莫名其妙的失败；还原之后再干净地跑一遍。
if (restored) spawnSync(process.execPath, ['test/title-tests.mjs'], { stdio: 'ignore' });

console.log('');
console.log(restored ? '已还原源码（内容与开工时快照一致）' : '⚠ 还原后内容与快照不一致，请手动检查');
console.log(allCaught ? '结论：全部变异都被抓到，会话标题的断言有效。' : '结论：有变异逃过测试，断言需要加强。');
process.exit(allCaught && restored ? 0 : 1);
