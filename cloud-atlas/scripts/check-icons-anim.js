/* 天象符号自检（动画版）
 *
 * 用法：node scripts/check-icons-anim.js
 *
 * 设计前提：动画全部由 CSS 触发，符号本身的几何完全不参与。
 * 所以这里验的是两件在这种设计下才会出错的事：
 *
 *   1. 开动画与不开动画生成的符号，几何必须**逐字节相同**，只差一个包装类。
 *      这一点错了不容易发现：同一个天气在 7 日条带（静态）和主读数（动）里
 *      长得不一样，用户会以为是两个不同的图标。
 *
 *   2. 如果 CSS 里没有为某个结构写动画规则，那个天气就永远不动——
 *      几何检查是发现不了"没写规则"的，所以要反过来核对样式表：
 *      符号里出现的每个结构标记（wx-fall / wx-bolt / wx-rays / wx-moon / wx-body），
 *      样式表里都得有对应的 .wx-icon--animate 规则。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Icons = require('../js/icons.js');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');
const CODES = [0, 1, 2, 3, 45, 51, 61, 65, 71, 75, 80, 85, 95, 99, null];
let problems = 0;

/** 归一化成"纯几何"：只留标签与数值属性，丢掉类名、id、无障碍属性和尺寸 */
function geometry(svg) {
  return svg
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\s(focusable|aria-[a-z]+|role|width|height)="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* --- 1. 几何一致 + 包装类正确 --- */

for (const code of CODES) {
  for (const isDay of [true, false]) {
    const still = Icons.svg(code, isDay, { size: 30 });
    const moving = Icons.svg(code, isDay, { size: 30, animate: true });
    const where = `code=${code} isDay=${isDay}`;

    if (geometry(still) !== geometry(moving)) {
      console.log(`× ${where}：静态与动画版本几何不同`);
      problems++;
    }
    if (/wx-icon--animate/.test(still)) {
      console.log(`× ${where}：静态版本带了 wx-icon--animate`);
      problems++;
    }
    if (!/wx-icon--animate/.test(moving)) {
      console.log(`× ${where}：动画版本缺少 wx-icon--animate`);
      problems++;
    }
  }
}

/* --- 2. 符号里出现的每个结构标记，样式表都要有动画规则 --- */

const MARKERS = ['wx-fall', 'wx-bolt', 'wx-rays', 'wx-moon', 'wx-body'];
const seen = new Set();
for (const code of CODES) {
  for (const isDay of [true, false]) {
    const svg = Icons.svg(code, isDay, { size: 64, animate: true });
    for (const m of MARKERS) if (svg.includes(`class="${m}"`)) seen.add(m);
  }
}
for (const m of seen) {
  const rule = new RegExp(`\\.wx-icon--animate[^{]*\\.${m}[^{]*\\{`);
  if (!rule.test(CSS)) {
    console.log(`× 样式表里没有 .wx-icon--animate .${m} 的动画规则，这类天气不会动`);
    problems++;
  }
}

/* 反向：样式表里写了规则，但符号里根本没这个结构 —— 那是死规则 */
for (const m of MARKERS) {
  if (seen.has(m)) continue;
  const rule = new RegExp(`\\.wx-icon--animate[^{]*\\.${m}[^{]*\\{`);
  if (rule.test(CSS)) {
    console.log(`× 样式表为 .${m} 写了动画规则，但没有符号用到它`);
    problems++;
  }
}

/* --- 3. 关键帧必须存在，别写了 animation 名却没定义 --- */
const used = Array.from(CSS.matchAll(/animation(?:-name)?:\s*([a-z-]+)/g)).map((m) => m[1]);
const defined = new Set(Array.from(CSS.matchAll(/@keyframes\s+([a-z-]+)/g)).map((m) => m[1]));
for (const name of new Set(used)) {
  if (name === 'none' || name === 'inherit') continue;
  if (!defined.has(name)) {
    console.log(`× 用了动画 ${name}，但没有定义 @keyframes ${name}`);
    problems++;
  }
}

/* --- 4. 减少动态效果时必须全部关掉 --- */
const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
if (!/\.wx-icon--animate/.test(reduce)) {
  console.log('× prefers-reduced-motion 里没有关掉天象动画');
  problems++;
}

console.log(problems === 0
  ? `动画符号自检通过：${CODES.length} 个天气码 × 2 种昼夜几何一致；`
    + `${seen.size} 种结构标记都有动画规则；关键帧与减少动效设置齐备。`
  : `动画符号自检失败：${problems} 处。`);
process.exit(problems === 0 ? 0 : 1);
