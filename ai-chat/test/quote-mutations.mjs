// 引用回答的变异测试：确认那批断言真的抓得住缺陷
//
//   node test/quote-mutations.mjs
//
// 与另外两个变异脚本同一套思路：临时改坏源码里的一个关键判断，
// 跑一遍 quote-tests，看它会不会失败。测试若抓不到自己声称要防的缺陷，就只是装饰。
//
// 三个沙箱/工程上的注意（前两个脚本都踩过）：
//  · 不能靠管道捕获子进程输出（EPERM），所以让 quote-tests 把结果写进文件；
//  · 基准源码取自开工时的内存快照，绝不从文件里再读（文件随时可能正处在变异状态）；
//  · 每次变异后立刻还原、还原后再核对一遍；上次没正常结束就拒绝开工。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const QUOTE = 'public/lib/quote.js';
const STORE = 'public/lib/store.js';
const VERSIONS = 'public/lib/versions.js';
const EXPORTERS = 'public/lib/exporters.js';
const FILES = [QUOTE, STORE, VERSIONS, EXPORTERS];

if (!existsSync(QUOTE)) {
  console.error('请在 ai-chat/ 目录下运行：node test/quote-mutations.mjs');
  process.exit(2);
}

const TEMP = '.tmp-mutations';
mkdirSync(TEMP, { recursive: true });
const RESULT = path.join(TEMP, 'ui-result.json');
const SENTINEL = path.join(TEMP, 'in-progress');

if (existsSync(SENTINEL)) {
  console.error('检测到 .tmp-mutations/in-progress：上一次变异测试没有正常结束。');
  console.error('请先检查 public/lib/ 下的引用相关文件是否被改坏，再删掉该目录重试。');
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
    const proc = spawnSync(process.execPath, ['test/quote-tests.mjs'], { stdio: 'ignore' });

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

    // 「被抓到」有两种形态：断言失败，或者变异让测试直接崩掉（结果文件根本没写出来）
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

console.log('引用回答变异测试（每个变异都必须被抓到）\n');

// ---- 拼装：引用必须真的进请求体，且不能把用户的话弄丢

run('引用不拼进请求体（等于功能没做）', VERSIONS, (src) =>
  src.replace("  if (role !== 'user') return versionText(version);", '  return versionText(version);'),
);

run('引用只拼给最后一轮，历史里的引用被丢掉', VERSIONS, (src) =>
  src.replace(
    "    history.push({ role: m.role, content: outboundContent(m.role, current), images });",
    '    history.push({ role: m.role, content: versionText(current), images });',
  ),
);

run('拼装时把用户自己说的话丢了', QUOTE, (src) =>
  src.replace("  const question = typeof text === 'string' ? text : '';", "  const question = '';"),
);

run('引用块不用 Markdown 引用符（模型分不清是转引还是用户在说话）', QUOTE, (src) =>
  src.replace(
    "    .map((line) => (line ? `> ${line}` : '>'))",
    "    .map((line) => line)",
  ),
);

run('引用不带出处（多页时不知道引的是哪一页）', QUOTE, (src) =>
  src.replace('  return `> 【${quoteLabel(quote)}】\\n${body}`;', '  return body;'),
);

// ---- 规整：空白与超长是真实选区里最常见的两种脏数据

run('空白选区也算引用（会挂上一条空的引用条）', QUOTE, (src) =>
  src.replace('  if (!full) return null;', '  if (false) return null;'),
);

run('不截断超长引用（上下文会被一段长回答翻倍）', QUOTE, (src) =>
  src.replace(
    '  const text = full.length > MAX_QUOTE_CHARS ? full.slice(0, MAX_QUOTE_CHARS).trimEnd() : full;',
    '  const text = full;',
  ),
);

run('引用自己的提问也允许（「引用」的语义就散了）', QUOTE, (src) =>
  src.replace('  if (!inAnswer) return null;', '  if (false) return null;'),
);

// ---- 存储：引用要跟着版本走，不能串页

run('新提问沿用上一条的引用（引用会串到下一轮）', STORE, (src) =>
  src.replace('            quote: cleanQuote,', '            quote: null ?? session.messages.at(-1)?.quote ?? null,'),
);

run('编辑重发时不继承引用（新一页会把引用弄丢）', STORE, (src) =>
  src.replace(
    '          quote: edit.versions[target - 1]?.quote ?? null,',
    '          quote: null,',
  ),
);

run('存储时不规整引用（脏数据会被原样落盘）', STORE, (src) =>
  src.replace('      const cleanQuote = normalizeQuote(quote);', '      const cleanQuote = quote ?? null;'),
);

// ---- 导出：引用丢了，「这句话在问什么」就读不出来

run('Markdown 导出丢掉引用', EXPORTERS, (src) =>
  src.replace('        lines.push(...quoteLines(msg.quote));', '        lines.push(...[]);'),
);

run('JSON 导出把引用混进 content（导入方再也分不开）', EXPORTERS, (src) =>
  src.replace(
    '          content: m.content,\n          // 引用单独一个字段',
    '          content: [m.quote?.text, m.content].filter(Boolean).join("\\n"),\n          // 引用单独一个字段',
  ),
);

const restored = restoreAll();
if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
if (existsSync(RESULT)) unlinkSync(RESULT);

// 变异跑的每一轮都会把「这次的断言数」写进 .tmp-mutations/counts.json ——
// 那是**改坏过的**源码跑出来的数字，留着会让 readme-tests 报出
// 「文档写 71，实际 70」这种看不懂的失败。所以还原之后再干净地跑一遍。
if (restored) spawnSync(process.execPath, ['test/quote-tests.mjs'], { stdio: 'ignore' });

console.log('');
console.log(restored ? '已还原源码（内容与开工时快照一致）' : '⚠ 还原后内容与快照不一致，请手动检查');
console.log(allCaught ? '结论：全部变异都被抓到，引用功能的断言有效。' : '结论：有变异逃过测试，断言需要加强。');
process.exit(allCaught && restored ? 0 : 1);
