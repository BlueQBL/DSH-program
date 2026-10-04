// 版本功能的变异测试：确认「编辑分页」那批断言真的抓得住缺陷
//
//   node test/version-mutations.mjs
//
// 与 ui-mutations.mjs 同一套思路：临时改坏源码里的一个关键判断，跑一遍
// ci store-tests，看它会不会失败。测试若抓不到自己声称要防的缺陷，就只是装饰。
//
// 沙箱注意：不能靠管道捕获子进程输出（EPERM），所以让 store-tests 把结果写进
// .tmp-mutations/ui-result.json，用退出码与文件内容判断。

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const STORE = 'public/lib/store.js';
const VERSIONS = 'public/lib/versions.js';
const COPY_FEEDBACK = 'public/lib/copy-feedback.js';
const CSS = 'public/styles.css';
const TEMP = '.tmp-mutations';
const FILES = [STORE, VERSIONS, COPY_FEEDBACK, CSS];

if (!existsSync(STORE)) {
  console.error('请在 ai-chat/ 目录下运行：node test/version-mutations.mjs');
  process.exit(2);
}

mkdirSync(TEMP, { recursive: true });
const RESULT = path.join(TEMP, 'ui-result.json');
const SENTINEL = path.join(TEMP, 'in-progress');

// 上一次跑如果没正常结束，源码可能还停在变异状态 —— 这时候绝对不能开工。
// 曾经因为「崩溃 + 备份被污染」，把一份坏掉的 store.js 留在了工作区，
// 后面所有测试都在坏代码上跑，排查了半天。宁可在这里硬停下来。
if (existsSync(SENTINEL)) {
  console.error('检测到 .tmp-mutations/in-progress：上一次变异测试没有正常结束。');
  console.error('请先检查 public/lib/store.js 与 versions.js 是否被改坏，然后删除该目录再重试。');
  console.error(`  rm -r ${TEMP}`);
  process.exit(2);
}

writeFileSync(SENTINEL, String(Date.now()), 'utf8');

/** 本次开工时的干净源码快照（内存里，绝不从可能被污染的文件里再读） */
const pristineSource = new Map();
for (const file of FILES) pristineSource.set(file, readFileSync(file, 'utf8'));

/**
 * 取出「干净的」源码。
 *
 * 关键：每次都从内存快照取，而不是从文件读。文件随时可能正处在变异状态，
 * 拿它当基准会让后续变异的替换全部失配 —— 那就成了「变异无效」的假报告。
 */
function pristine(file) {
  return pristineSource.get(file);
}

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
    const proc = spawnSync(process.execPath, ['test/store-tests.mjs'], { stdio: 'ignore' });

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

    // 被抓到有两种形态，都算成功：
    //  · 测试正常跑完但断言失败（退出码 1，结果文件里有失败项）
    //  · 变异让测试**中途崩溃**（退出码非 0，结果文件根本没写出来）
    // 第二种最容易漏判：拿不到失败清单很容易被当成「没失败」，
    // 其实那是「测试挂了」—— 这本身就是被抓到。
    const crashed = proc.status !== 0 && !resultReadable;
    const caught = failed.length > 0 || crashed;
    if (!caught) allCaught = false;
    console.log(`  ${caught ? '✓ 抓到了' : '✗ 逃过了'}  ${label}`);
    if (crashed) console.log(`      测试中途崩溃（退出码 ${proc.status}）`);
    else if (caught) console.log(`      失败断言：${failed.slice(0, 2).join(' / ')}`);
  } finally {
    // 每个变异之后立刻还原，保证下一个变异面对的是干净源码
    if (!restoreAll()) {
      console.log('  ⚠ 还原失败，请手动检查源码');
      allCaught = false;
    }
  }
}

console.log('版本功能变异测试（每个变异都必须被抓到）\n');

// 这一条对应的正是用户实测报上来的缺陷：
// 「编辑后生成的内容把上一次的内容覆盖了」。
// 只要有人把 reuse 的判断写反（让编辑也走原地替换），这条就会失败。
run('让「编辑重发」退化成原地覆盖（旧内容被吃掉）', STORE, (src) =>
  src.replace('        if (reuse) {', '        if (true) {'),
);

run('「重新生成」也变成追加（会平白多出一页）', STORE, (src) =>
  src.replace('        if (reuse) {', '        if (false) {'),
);

run('pushUser 忽略 edit，永远新建一条消息', STORE, (src) =>
  src.replace('if (edit && Array.isArray(edit.versions) && edit.versions.length) {', 'if (false) {'),
);

run('pushAssistant 不按提问页数补齐（旧页回答会错位）', STORE, (src) =>
  src.replace('while (answer.versions.length < qCount) {', 'while (false) {'),
);

run('page 越界时不回落（可能返回超范围的页）', VERSIONS, (src) =>
  src.replace('  return Math.min(Math.floor(n), total);', '  return Math.floor(n);'),
);

run('只有一页时也生成页码按钮（界面会多出噪音）', VERSIONS, (src) =>
  src.replace('  if (total <= 1) return [];', '  if (false) return [];'),
);

run('buildRequestHistory 丢掉历史版本（模型会看到自问自答）', VERSIONS, (src) =>
  src.replace('      for (let i = 0; i < versions.length - 1; i += 1) {', '      for (let i = 0; i < 0; i += 1) {'),
);

run('buildRequestHistory 丢掉旧版本对应的回答', VERSIONS, (src) =>
  src.replace('        if (oldAnswer && versionText(oldAnswer)) {', '        if (false) {'),
);

run('buildRequestHistory 把图片也塞给历史消息', VERSIONS, (src) =>
  src.replace(
    "    history.push({ role: m.role, content: versionText(current), images: [] });",
    "    history.push({ role: m.role, content: versionText(current), images: versionImages(current) });",
  ),
);

// ---- 复制反馈（用户反馈：点了复制看不出成功）
// 这一块的核心是「按钮必须变」，所以变异都围绕「变不了」来设计。

run('复制成功时按钮文字不变（用户看不出成功）', COPY_FEEDBACK, (src) =>
  src.replace("  copied: '已复制',", '  copied: "",'),
);

run('复制成功时不加成功状态类（样式无从换色）', COPY_FEEDBACK, (src) =>
  src.replace("className: 'is-copied'", 'className: ""'),
);

run('成功与失败用同一个状态类（分不清成败）', COPY_FEEDBACK, (src) =>
  src.replace("className: 'is-copy-failed'", "className: 'is-copied'"),
);

run('把成功色改成红墨（与「问」标的语义混淆）', CSS, (src) =>
  src.replace('--success: #2f6b4f;', '--success: #c2402a;'),
);

run('删掉代码块复制按钮的成功样式（状态类失效）', CSS, (src) =>
  src.replace('.code-copy.is-copied {', '.code-copy-renamed.is-copied {'),
);

run('失败时不给补救提示（用户不知道怎么手动复制）', COPY_FEEDBACK, (src) =>
  src.replace("return ok ? `${label}已复制` : '复制失败，请手动选择';", "return '';"),
);

// 最后再整体还原一次（每个变异之后已经还原过了，这里是双保险）
const restored = restoreAll();
if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
if (existsSync(RESULT)) unlinkSync(RESULT);

console.log('');
console.log(restored ? '已还原源码（内容与开工时快照一致）' : '⚠ 还原后内容与快照不一致，请手动检查');
console.log(allCaught ? '结论：全部变异都被抓到，版本功能的断言有效。' : '结论：有变异逃过测试，断言需要加强。');
process.exit(allCaught && restored ? 0 : 1);
