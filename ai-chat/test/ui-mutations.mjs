// 变异测试：确认 ui-tests 真的能抓到这些缺陷
//
// 做法：临时把 app.js 里的关键一步删掉，再跑 ui-tests，看它会不会失败。
// 测试如果抓不到自己声称要防的缺陷，那它就只是装饰。
//
// 三个已经踩过的坑，写在这里免得再犯：
//  1. 不能用管道捕获子进程输出 —— 受限沙箱下带 stdio:'pipe' 的子进程会 EPERM，
//     被 catch 吞掉之后就会误判成「测试通过」。改为让 ui-tests 把结果写进文件。
//  2. 替换字符串必须和源码逐字一致，否则静默不生效。失配和「逃过测试」要分开报：
//     失配是脚本要维护，逃过才是断言不够。
//  3. 这个脚本要在 ai-chat/ 下运行（它要改写 public/app.js）。

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const APP = 'public/app.js';
if (!existsSync(APP)) {
  console.error('请在 ai-chat/ 目录下运行：node test/ui-mutations.mjs');
  console.error(`当前找不到 ${path.resolve(APP)}`);
  process.exit(2);
}

const TEMP_DIR = '.tmp-mutations';
mkdirSync(TEMP_DIR, { recursive: true });
const BACKUP = path.join(TEMP_DIR, 'app.js.bak');
const RESULT = path.join(TEMP_DIR, 'ui-result.json');

const original = readFileSync(APP, 'utf8');
copyFileSync(APP, BACKUP);

let allCaught = true;
let stale = 0;

function run(label, mutate) {
  const mutated = mutate(original);
  if (mutated === original) {
    stale += 1;
    console.log(`  ~ 变异失配（源码写法变了，需更新模式）：${label}`);
    return;
  }
  writeFileSync(APP, mutated, 'utf8');

  if (existsSync(RESULT)) unlinkSync(RESULT);
  const proc = spawnSync(process.execPath, ['test/ui-tests.mjs'], { stdio: 'ignore' });

  let failed = [];
  if (existsSync(RESULT)) {
    try {
      failed = JSON.parse(readFileSync(RESULT, 'utf8')).failed ?? [];
    } catch {
      /* 忽略 */
    }
  }

  if (proc.status === null) {
    allCaught = false;
    console.log(`  ? 子进程没跑起来（沙箱限制？）：${label}`);
    return;
  }

  const caught = failed.length > 0;
  if (!caught) allCaught = false;
  console.log(`  ${caught ? '✓ 抓到了' : '✗ 逃过了'}  ${label}`);
  if (caught) console.log(`      失败断言：${failed.slice(0, 2).join(' / ')}`);
}

console.log('变异测试（每个生效的变异都必须被测试抓到）\n');

// promptSave 现在分成三条分支（未改动 / 改过预设 / 自定义），每条各自收起面板。
// 下面三条分别打掉一条分支的收起，确认测试覆盖了全部路径 ——
// 早先只有一条通用变异，失效之后暴露了我没覆盖到分支收敛这件事。
run('删掉「未改动就保存」分支的收起面板', (src) =>
  src.replace(
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });\n      setPromptPanelOpen(false);",
    "      if (session.systemPrompt) store.updateSessionSettings({ systemPrompt: '' });",
  ),
);

run('删掉「改过预设后保存」分支的收起面板', (src) =>
  src.replace(
    "    renderSessionList();\n    setPromptPanelOpen(false);\n    flashHint('已保存自定义内容，角色仍是'",
    "    renderSessionList();\n    flashHint('已保存自定义内容，角色仍是'",
  ),
);

run('删掉「自定义角色保存」分支的收起面板', (src) =>
  src.replace(
    "  renderSessionList();\n  setPromptPanelOpen(false);\n  flashHint(edited ? '已保存到本对话",
    "  renderSessionList();\n  flashHint(edited ? '已保存到本对话",
  ),
);

run('删掉「还原后收起面板」', (src) =>
  src.replace(/\n  setPromptPanelOpen\(false\);\n(  flashHint\('已还原)/, '\n$1'),
);

run('让 setPromptPanelOpen 只改 aria 不改 hidden', (src) =>
  src.replace(
    'function setPromptPanelOpen(open) {\n  els.promptPanel.hidden = !open;',
    'function setPromptPanelOpen(open) {\n  void open;',
  ),
);

run('删掉「换模型时刷新顶部标签」', (src) =>
  src.replace(
    '  renderSessionList();\n  syncModeChip();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
    '  renderSessionList();\n  flashHint(`下一轮对话改用 ${model}`, 2600);',
  ),
);

run('让顶部标签永远显示服务端默认模型（不顾所选）', (src) =>
  src.replace('  const model = currentModelForRequest();', '  const model = runtime.serverDefaultModel;'),
);

writeFileSync(APP, original, 'utf8');
unlinkSync(BACKUP);
if (existsSync(RESULT)) unlinkSync(RESULT);

console.log('\n已还原 app.js');
if (stale) console.log(`注意：有 ${stale} 个变异因源码写法变化而失配，需要更新模式（不等于断言有问题）。`);
console.log(allCaught ? '结论：全部生效的变异都被抓到，这组断言有效。' : '结论：有变异逃过测试，断言需要加强。');
process.exit(allCaught ? 0 : 1);
