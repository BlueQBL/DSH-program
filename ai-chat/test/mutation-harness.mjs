// 变异测试的公共骨架
//
// 这套「临时改坏源码 → 跑对应套件 → 看它会不会失败 → 立刻还原」的机器，
// 写第四遍的时候抽出来的。每个脚本各维护一份的后果已经出现了：有的脚本
// 把「测试中途崩溃」算成抓到了，有的没判；有的跑完会把变异那一轮的断言数
// 留在 counts.json 里，让 readme-tests 报出莫名其妙的数字。
//
// 用法：
//   import { createMutationRunner } from './mutation-harness.mjs';
//   const runner = createMutationRunner({
//     label: '引用回答',
//     suite: 'test/quote-tests.mjs',
//     files: ['public/lib/quote.js', 'public/lib/store.js'],
//   });
//   runner.run('变异说明', 'public/lib/quote.js', (src) => src.replace('a', 'b'));
//   runner.finish();
//
// 沙箱注意：不能靠管道捕获子进程输出（EPERM），所以让套件把结果写进文件再来读。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const TEMP = '.tmp-mutations';
const RESULT = path.join(TEMP, 'ui-result.json');
const SENTINEL = path.join(TEMP, 'in-progress');

/**
 * @param {object} options
 * @param {string} options.label 这套变异的主题（用于输出与提示）
 * @param {string} options.suite 要跑的套件，例如 'test/quote-tests.mjs'
 * @param {string[]} options.files 可能被改坏、需要快照与还原的文件
 * @param {string} [options.tempDir] 临时目录（默认 .tmp-mutations）
 */
export function createMutationRunner({ label, suite, files, tempDir = TEMP }) {
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`请在 ai-chat/ 目录下运行本脚本：找不到 ${file}`);
      process.exit(2);
    }
  }
  if (!existsSync(suite)) {
    console.error(`找不到要跑的套件：${suite}`);
    process.exit(2);
  }

  mkdirSync(tempDir, { recursive: true });
  const resultFile = path.join(tempDir, 'ui-result.json');
  const sentinel = path.join(tempDir, 'in-progress');

  // 上一次跑如果没正常结束，源码可能还停在变异状态 —— 这时候绝对不能开工，
  // 否则会在一份坏代码上得出结论。宁可在这里硬停下来。
  if (existsSync(sentinel)) {
    console.error(`检测到 ${sentinel}：上一次变异测试没有正常结束。`);
    console.error(`请先检查这几个文件是否被改坏，然后删掉 ${tempDir} 再重试：`);
    for (const file of files) console.error(`  ${file}`);
    process.exit(2);
  }
  writeFileSync(sentinel, String(Date.now()), 'utf8');

  /** 开工时的干净源码快照（内存里，绝不从可能被污染的文件里再读） */
  const pristine = new Map();
  for (const file of files) pristine.set(file, readFileSync(file, 'utf8'));

  /** 还原所有被改过的文件，并核对确实回到快照内容 */
  function restoreAll() {
    let ok = true;
    for (const [file, clean] of pristine) {
      if (readFileSync(file, 'utf8') !== clean) writeFileSync(file, clean, 'utf8');
      if (readFileSync(file, 'utf8') !== clean) ok = false;
    }
    return ok;
  }

  function finish(code) {
    const restored = restoreAll();
    if (existsSync(sentinel)) unlinkSync(sentinel);
    if (!restored) console.error('⚠ 还原失败，请手动检查源码');
    process.exit(code);
  }

  // 异常退出（Ctrl+C、未捕获异常）也要还原
  process.on('SIGINT', () => finish(130));
  process.on('SIGTERM', () => finish(143));
  process.on('uncaughtException', (err) => {
    console.error('未捕获异常：', err?.message ?? err);
    finish(1);
  });

  let allCaught = true;

  console.log(`${label}变异测试（每个变异都必须被抓到）\n`);

  return {
    /**
     * 施加一个变异并看它会不会被测出来。
     * @param {string} title 变异说明（用中文写清「改坏了什么」）
     * @param {string} file 要改的文件
     * @param {(source: string) => string} mutate 替换函数；没改动源码就报告失配
     */
    run(title, file, mutate) {
      const original = pristine.get(file);
      if (original === undefined) {
        console.log(`  ? 变异指向了未纳入快照的文件：${title}（${file}）`);
        allCaught = false;
        return;
      }
      const mutated = mutate(original);
      if (mutated === original) {
        console.log(`  ? 变异没生效（替换没匹配上源码，需更新模式）：${title}`);
        allCaught = false;
        return;
      }
      writeFileSync(file, mutated, 'utf8');

      try {
        if (existsSync(resultFile)) unlinkSync(resultFile);
        const proc = spawnSync(process.execPath, [suite], { stdio: 'ignore' });

        let failed = [];
        let resultReadable = false;
        if (existsSync(resultFile)) {
          try {
            failed = JSON.parse(readFileSync(resultFile, 'utf8')).failed ?? [];
            resultReadable = true;
          } catch {
            /* 文件坏了，下面按「非零退出」判断 */
          }
        }

        if (proc.status === null) {
          console.log(`  ? 子进程没跑起来（沙箱限制？）：${title}`);
          allCaught = false;
          return;
        }

        // 「被抓到」有两种形态，都算成功：
        //  · 套件正常跑完但断言失败（结果文件里有失败项）
        //  · 变异让套件**中途崩溃**（退出码非 0，结果文件根本没写出来）
        // 第二种最容易漏判：拿不到失败清单很容易被当成「没失败」，其实那是「测试挂了」。
        const crashed = proc.status !== 0 && !resultReadable;
        const caught = failed.length > 0 || crashed;
        if (!caught) allCaught = false;
        console.log(`  ${caught ? '✓ 抓到了' : '✗ 逃过了'}  ${title}`);
        if (crashed) console.log(`      套件中途崩溃（退出码 ${proc.status}）`);
        else if (caught) console.log(`      失败断言：${failed.slice(0, 2).join(' / ')}`);
      } finally {
        // 每个变异之后立刻还原，保证下一个变异面对的是干净源码
        if (!restoreAll()) {
          console.log('  ⚠ 还原失败，请手动检查源码');
          allCaught = false;
        }
      }
    },

    /** 收尾：还原、清临时文件、干净地再跑一遍套件、给结论 */
    finish() {
      const restored = restoreAll();
      if (existsSync(sentinel)) unlinkSync(sentinel);
      if (existsSync(resultFile)) unlinkSync(resultFile);

      // 变异那一轮会把「改坏过的源码跑出来的断言数」写进 counts.json，
      // 留着会让 readme-tests 报出「文档写 90，实际 86」这种看不懂的失败。
      // 所以还原之后再干净地跑一遍。
      if (restored) spawnSync(process.execPath, [suite], { stdio: 'ignore' });

      console.log('');
      console.log(restored ? '已还原源码（内容与开工时快照一致）' : '⚠ 还原后内容与快照不一致，请手动检查');
      console.log(allCaught ? `结论：全部变异都被抓到，${label}的断言有效。` : '结论：有变异逃过测试，断言需要加强。');
      process.exit(allCaught && restored ? 0 : 1);
    },
  };
}
