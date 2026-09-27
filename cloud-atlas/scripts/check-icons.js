/* 符号自检：不渲染页面也能确认天象图标是完整的
 *
 * 用法：node scripts/check-icons.js
 *
 * 检查三件事，都是"错了但页面看着正常"的类型：
 *   1. 生成出来的 SVG 里没有 NaN / undefined 漏进属性——一处就会让整条路径消失；
 *   2. 每个 <use href="#..."> 引用的 id 都真的定义在 DEFS 里，否则符号渲染成空白；
 *   3. 各基调都能拿到图案（尤其是夜间变体，最容易漏）。
 */
'use strict';

const Icons = require('../js/icons.js');
const Core = require('../js/core.js');

const CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 82, 85, 86, 95, 96, 99, null, 1234];
const DAYS = [true, false, undefined];

let problems = 0;

for (const code of CODES) {
  for (const isDay of DAYS) {
    const svg = Icons.svg(code, isDay, { size: 30 });
    const where = `code=${code} isDay=${String(isDay)}`;

    if (/NaN|undefined|null/.test(svg)) {
      console.log(`× ${where}：SVG 里出现了无效值`);
      console.log(svg.slice(0, 400));
      problems++;
    }

    for (const m of svg.matchAll(/href="#([\w-]+)"/g)) {
      if (!Icons.DEFS.includes(`id="${m[1]}"`)) {
        console.log(`× ${where}：引用了未定义的 ${m[1]}`);
        problems++;
      }
    }

    // 图形元素必须至少有一个，否则符号渲染出来就是一片空白
    if (!/<(use|line|path|circle|rect)\b/.test(svg)) {
      console.log(`× ${where}：符号里没有任何图形元素`);
      problems++;
    }
  }
}

/* 每个基调都必须有对应的排线图案，否则那个天气一出现就是一片空白 */
for (const tone of ['clear', 'fair', 'cloud', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'storm', 'night']) {
  if (!Icons.DEFS.includes(`id="ct-${tone}"`)) {
    console.log(`× 缺少图案 ct-${tone}`);
    problems++;
  }
}

/* 夜间必须走夜间形体。
   晴夜是实心月亮（不填排线），雨夜是云 + ct-night 排线，两者都要落到夜间代码路径上。 */
const clearNight = Icons.svg(0, false, { size: 30 });
if (!clearNight.includes('a20 20 0 1 0')) {      // 月牙的弧线
  console.log('× 夜间晴天没有画月亮');
  problems++;
}
if (clearNight.includes('#ct-clear')) {
  console.log('× 夜间晴天不该出现白天的排线');
  problems++;
}
const rainNight = Icons.svg(65, false, { size: 30 });
if (!rainNight.includes('#ct-night')) {
  console.log('× 夜间下雨没有使用 ct-night 排线');
  problems++;
}
if (!Icons.svg(65, true, { size: 30 }).includes('#ct-rain')) {
  console.log('× 白天大雨没有使用 ct-rain 排线');
  problems++;
}

/* 图标和 core 对昼夜的判断必须一致，否则会出现"夜空配太阳" */
const pairs = [
  [0, true, '#ct-clear'],      // 白天晴：太阳盘用 ct-clear
  [0, false, '#ct-night'],     // 夜间晴：月亮虽不填图案，但代码路径必须走夜间
  [95, true, '#ct-storm'],     // 白天雷暴：云填 ct-storm
  [95, false, '#ct-night'],    // 雷暴夜：云改填 ct-night
  [71, false, '#ct-night'],    // 雪夜
  [2, true, '#ct-cloud'],
];
for (const [code, isDay, expect] of pairs) {
  const tone = Core.sky(code, isDay);
  const svg = Icons.svg(code, isDay, {});
  // 夜间符号的排线一律是 ct-night；白天必须用自己基调的排线
  const wantHatch = isDay ? expect : '#ct-night';
  const shape = Icons.baseTone(tone);
  const isDiscOnly = (shape === 'clear' || shape === 'fair') && !isDay;
  if (!isDiscOnly && !svg.includes(`fill="${wantHatch}"`)) {
    console.log(`× code=${code} isDay=${isDay}：基调 ${tone} 的云/盘没有填 ${wantHatch}`);
    problems++;
  }
  if (isDay && Core.sky(code, true) !== Icons.baseTone(tone)) {
    console.log(`× code=${code}：core 给 ${Core.sky(code, true)}，图标当作 ${Icons.baseTone(tone)}`);
    problems++;
  }
}

console.log(problems === 0
  ? `符号自检通过：${CODES.length} 个天气码 × ${DAYS.length} 种昼夜组合都能生成完整图形。`
  : `符号自检失败：${problems} 处问题。`);
process.exit(problems === 0 ? 0 : 1);
