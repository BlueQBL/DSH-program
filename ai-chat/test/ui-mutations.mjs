// 变异测试：确认 ui-tests 真的能抓到这些缺陷
//
// 做法：临时把 app.js（或 styles.css）里的关键一步改坏，再跑 ui-tests，
// 看它会不会失败。测试如果抓不到自己声称要防的缺陷，那它就只是装饰。
//
// 四个已经踩过的坑，写在这里免得再犯：
//  1. 不能用管道捕获子进程输出 —— 受限沙箱下带 stdio:'pipe' 的子进程会 EPERM，
//     被 catch 吞掉之后就会误判成「测试通过」。改为让 ui-tests 把结果写进文件。
//  2. 替换字符串必须和源码逐字一致，否则静默不生效。失配和「逃过测试」要分开报：
//     失配是脚本要维护，逃过才是断言不够。
//  3. 这个脚本要在 ai-chat/ 下运行（它要改写 public/ 里的源码）。
//  4. 基准源码取自**开工时的内存快照**，绝不从文件里再读 ——
//     文件随时可能正处在变异状态，拿它当基准会让后面的替换全部失配。
//     并且每次变异后立刻还原、还原后再核对一遍；上一次没正常结束就拒绝开工。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const APP = 'public/app.js';
const CSS = 'public/styles.css';
const FILES = [APP, CSS];

if (!existsSync(APP)) {
  console.error('请在 ai-chat/ 目录下运行：node test/ui-mutations.mjs');
  console.error(`当前找不到 ${path.resolve(APP)}`);
  process.exit(2);
}

const TEMP_DIR = '.tmp-mutations';
mkdirSync(TEMP_DIR, { recursive: true });
const RESULT = path.join(TEMP_DIR, 'ui-result.json');
const SENTINEL = path.join(TEMP_DIR, 'in-progress');

// 上一次跑如果没正常结束，源码可能还停在变异状态 —— 这时候绝对不能开工，
// 否则会在一份坏代码上得出结论。宁可在这里硬停下来。
if (existsSync(SENTINEL)) {
  console.error(`检测到 ${SENTINEL}：上一次变异测试没有正常结束。`);
  console.error('请先检查 public/app.js 与 public/styles.css 是否被改坏，然后删掉该目录再重试。');
  console.error(`  rm -r ${TEMP_DIR}`);
  process.exit(2);
}
writeFileSync(SENTINEL, String(Date.now()), 'utf8');

/** 开工时的干净源码快照 */
const pristineSource = new Map();
for (const file of FILES) pristineSource.set(file, readFileSync(file, 'utf8'));

const pristine = (file) => pristineSource.get(file);

/** 还原所有被改过的文件，并核对确实回到快照内容 */
function restoreAll() {
  let ok = true;
  for (const [file, clean] of pristineSource) {
    if (readFileSync(file, 'utf8') !== clean) writeFileSync(file, clean, 'utf8');
    if (readFileSync(file, 'utf8') !== clean) ok = false;
  }
  return ok;
}

/** 异常退出（Ctrl+C、未捕获异常）也要还原 */
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
let stale = 0;

function run(label, file, mutate) {
  const original = pristine(file);
  const mutated = mutate(original);
  if (mutated === original) {
    stale += 1;
    console.log(`  ~ 变异失配（源码写法变了，需更新模式）：${label}`);
    return;
  }
  writeFileSync(file, mutated, 'utf8');

  try {
    if (existsSync(RESULT)) unlinkSync(RESULT);
    const proc = spawnSync(process.execPath, ['test/ui-tests.mjs'], { stdio: 'ignore' });

    let failed = [];
    if (existsSync(RESULT)) {
      try {
        failed = JSON.parse(readFileSync(RESULT, 'utf8')).failed ?? [];
      } catch {
        /* 文件坏了，下面按「非零退出」判断 */
      }
    }

    if (proc.status === null) {
      allCaught = false;
      console.log(`  ? 子进程没跑起来（沙箱限制？）：${label}`);
      return;
    }

    // 「被抓到」有两种形态：断言失败，或者变异让测试直接崩掉（结果文件根本没写出来）。
    // 第二种最容易漏判 —— 拿不到失败清单很容易被当成「没失败」。
    const crashed = proc.status !== 0 && failed.length === 0;
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

console.log('变异测试（每个生效的变异都必须被测试抓到）\n');

// promptSave 现在分成三条分支（未改动 / 改过预设 / 自定义），每条各自收起面板。
// 下面三条分别打掉一条分支的收起，确认测试覆盖了全部路径 ——
// 早先只有一条通用变异，失效之后暴露了我没覆盖到分支收敛这件事。
run('删掉「未改动就保存」分支的收起面板', APP, (src) =>
  src.replace(
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });\n      setPromptPanelOpen(false);",
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });",
  ),
);

run('删掉「改过预设后保存」分支的收起面板', APP, (src) =>
  src.replace(
    "    renderSessionList();\n    setPromptPanelOpen(false);\n    flashHint('已保存自定义内容，角色仍是'",
    "    renderSessionList();\n    flashHint('已保存自定义内容，角色仍是'",
  ),
);

run('删掉「自定义角色保存」分支的收起面板', APP, (src) =>
  src.replace(
    "  renderSessionList();\n  setPromptPanelOpen(false);\n  flashHint(edited ? '已保存到本对话",
    "  renderSessionList();\n  flashHint(edited ? '已保存到本对话",
  ),
);

run('删掉「还原后收起面板」', APP, (src) =>
  src.replace(/\n  setPromptPanelOpen\(false\);\n(  flashHint\('已还原)/, '\n$1'),
);

run('让 setPromptPanelOpen 只改 aria 不改 hidden', APP, (src) =>
  src.replace(
    'function setPromptPanelOpen(open) {\n  els.promptPanel.hidden = !open;',
    'function setPromptPanelOpen(open) {\n  void open;',
  ),
);

run('删掉「换模型时刷新顶部标签」', APP, (src) =>
  src.replace(
    '  renderSessionList();\n  syncModeChip();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
    '  renderSessionList();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
  ),
);

run('让顶部标签永远显示服务端默认模型（不顾所选）', APP, (src) =>
  src.replace('  const model = currentModelForRequest();', '  const model = runtime.serverDefaultModel;'),
);

// ---- 报头抖动（用户反馈：正文往上滚、快到顶的时候整页一直抖）
//
// 这一块的断言要防住三件事：滞回不能退化成单阈值、状态没变不能写 DOM、
// 报头高度不能带过渡。下面每条分别打掉一件。

run('滞回退化成单阈值（抖动缺陷的原样）', APP, (src) =>
  src.replace(
    'const next = mastheadCompact === true ? y > COMPACT_EXIT_AT : y > COMPACT_ENTER_AT;',
    'const next = y > COMPACT_ENTER_AT;',
  ),
);

run('进入/退出用同一个阈值（缓冲带塌掉）', APP, (src) =>
  src.replace('const COMPACT_EXIT_AT = 8;', 'const COMPACT_EXIT_AT = 48;'),
);

run('每次滚动都重写 data-compact（值没变也写）', APP, (src) =>
  src.replace(
    "  if (next !== mastheadCompact) {\n    mastheadCompact = next;\n    els.masthead.dataset.compact = next ? 'true' : 'false';\n  }",
    "  mastheadCompact = next;\n  els.masthead.dataset.compact = next ? 'true' : 'false';",
  ),
);

run('每次滚动都重写 --masthead-h（会话栏跟着每帧重算）', APP, (src) =>
  src.replace(
    "  if (height !== mastheadHeight) {\n    mastheadHeight = height;\n    document.documentElement.style.setProperty('--masthead-h', `${height}px`);\n  }",
    "  mastheadHeight = height;\n  document.documentElement.style.setProperty('--masthead-h', `${height}px`);",
  ),
);

run('给报头加回内边距过渡（文档高度会连着 180ms 一帧帧变）', CSS, (src) =>
  src.replace(
    '  overflow-anchor: none;\n}',
    '  overflow-anchor: none;\n  transition: padding 0.18s ease;\n}',
  ),
);

run('删掉报头的滚动锚定抑制', CSS, (src) =>
  src.replace('  overflow-anchor: none;\n', ''),
);

// ---- 引用回答（用户提出：回答里的一段可以划出来引用，接着问）
//
// 这条盯的是一个真实浏览器行为：按下浮标按钮本身就会清掉文档选区。
// 所以「引用」必须在浮标出现时就存下来 —— 点的时候再读选区只会读到空字符串，
// 表现是「点了没反应」，而且本地很难想到是这个原因。

run('点引用时重读选区（按钮按下已清空选区，会导致点了没反应）', APP, (src) =>
  src.replace('  const quote = floatQuote;', '  const quote = readSelectionQuote()?.quote ?? null;'),
);

run('把引用只挂进输入区、不随提问发出去', APP, (src) =>
  src.replace(
    "  const asked = store.pushUser(text, { attachments: images, edit, version, reuse, quote });",
    '  const asked = store.pushUser(text, { attachments: images, edit, version, reuse });',
  ),
);

run('点「重新生成」时把输入区挂着的引用一并吃掉', APP, (src) =>
  // 注意：这条不是「引用会串到旧那一问」——那一层由 store 守着（编辑/重生成时它
  // 一律忽略传进来的 quote，store-tests 有断言）。这里守的是**更轻但用户能看见**的一半：
  // 重试不该把用户刚挑好的那段引用顺手清掉。
  src.replace('  const quote = edit ? null : runtime.pendingQuote;', '  const quote = runtime.pendingQuote;'),
);

// 最后再整体还原一次（每个变异之后已经还原过了，这里是双保险）
const restored = restoreAll();
if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
if (existsSync(RESULT)) unlinkSync(RESULT);

// 变异那一轮会把「改坏过的源码跑出来的断言数」写进 .tmp-mutations/counts.json，
// 留着会让 readme-tests 报出「文档写 90，实际 86」这种莫名其妙的失败。
// 所以还原之后再干净地跑一遍。
if (restored) spawnSync(process.execPath, ['test/ui-tests.mjs'], { stdio: 'ignore' });

console.log('');
console.log(restored ? '已还原源码（内容与开工时快照一致）' : '⚠ 还原后内容与快照不一致，请手动检查');
if (stale) console.log(`注意：有 ${stale} 个变异因源码写法变化而失配，需要更新模式（不等于断言有问题）。`);
console.log(allCaught ? '结论：全部生效的变异都被抓到，这组断言有效。' : '结论：有变异逃过测试，断言需要加强。');
process.exit(allCaught && restored ? 0 : 1);
