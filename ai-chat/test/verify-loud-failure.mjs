// 元验证：注入一个 TDZ 错误，确认测试会大声失败而不是静默退出。
//
// 背景：ui-tests 曾经因为一个 TDZ 错误静默中断（退出码 0、stderr 为空），
// 原因是 process.on('unhandledRejection') 会抑制 Node 的默认行为。
// 这个脚本用来证明那个缺陷已经修好 —— 修好之后同类错误必须报错并非零退出。

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TEST = 'test/ui-tests.mjs';
const BACKUP = 'test/ui-tests.mjs.bak';
const OUT = 'inject-out.txt';
const ERR = 'inject-err.txt';

const original = readFileSync(TEST, 'utf8');
copyFileSync(TEST, BACKUP);

// 在文件靠后的位置插一句对「未声明变量」的赋值 —— 与当初那个 TDZ 错误同类。
// 放在末尾能确保前面的断言都已经跑过，触发的是运行期错误而非语法错误。
const marker = 'console.log(`\\n${';
const idx = original.lastIndexOf(marker);
if (idx < 0) {
  console.error('没找到插入点（测试文件结构变了？）');
  process.exit(2);
}
const injected =
  original.slice(0, idx) +
  "storage.set('probe', JSON.stringify(sessionsNotDeclaredAnywhere));\n\n" +
  original.slice(idx);

writeFileSync(TEST, injected, 'utf8');

let summary;
try {
  // stdio 用 ignore：沙箱里管道会 EPERM；结果从退出码和文件判断
  const proc = spawnSync(process.execPath, [TEST], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  summary = { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
} catch (err) {
  summary = { status: null, stdout: '', stderr: `spawn 失败：${err.message}` };
}

writeFileSync(OUT, summary.stdout, 'utf8');
writeFileSync(ERR, summary.stderr, 'utf8');

console.log('注入后的结果：');
console.log(`  退出码: ${String(summary.status)}（期望非 0）`);
console.log(`  stderr 有内容: ${summary.stderr.trim() ? '是' : '否'}（期望是）`);
const errLine = summary.stderr.split('\n').find((l) => l.includes('sessionsNotDeclaredAnywhere')) ?? '';
console.log(`  stderr 指出原因: ${errLine.trim() ? '是' : '否'}`);
if (errLine) console.log(`    ${errLine.trim().slice(0, 100)}`);

// 还原
writeFileSync(TEST, original, 'utf8');
unlinkSync(BACKUP);

const ok = summary.status !== 0 && summary.stderr.trim().length > 0;
console.log('');
console.log(ok ? '✓ 同类错误会大声失败，静默中断已修复' : '✗ 仍然静默 —— 缺陷没修好');
if (existsSync(OUT)) unlinkSync(OUT);
if (existsSync(ERR)) unlinkSync(ERR);
process.exit(ok ? 0 : 1);
