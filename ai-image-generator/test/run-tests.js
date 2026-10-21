'use strict';

/**
 * 跑全部测试：每个文件单独起一个进程。
 *
 * 为什么要分开跑：server.test.js 要占用环境变量并真的起服务，
 * models / upstream 会替换 globalThis.fetch —— 混在一个进程里跑会互相串味。
 *
 * 运行：node test/run-tests.js
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const files = fs
  .readdirSync(DIR)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

let failed = 0;
const started = Date.now();

for (const file of files) {
  console.log(`\n=== ${file} ===`);
  const out = spawnSync(process.execPath, [path.join(DIR, file)], {
    stdio: 'inherit',
    cwd: path.join(DIR, '..'),
    env: Object.assign({}, process.env, { AI_FORCE_OFFLINE: '', DEEPSEEK_API_KEY: '', OPENAI_HK_API_KEY: '', OPENAI_API_KEY: '' }),
  });
  if (out.status !== 0) failed += 1;
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n共 ${files.length} 个测试文件，${failed ? `${failed} 个失败` : '全部通过'}（${seconds}s）`);
if (failed) process.exitCode = 1;
