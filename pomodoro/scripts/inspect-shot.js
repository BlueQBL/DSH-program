/* 截图检查器：把 PNG 截图降采样成终端里的灰度图，并采样若干关键点的真实颜色。
 *
 * 用法：
 *   node scripts/inspect-shot.js .screens/desktop-idle.png [列数]
 *
 * 为什么需要它：跑完截图如果没法"看"，版面错位、元素重叠、配色跑偏都发现不了。
 * 这里直接解 PNG 像素，降采样成字符画（深色→空格，浅色→@），
 * 再按色相把像素归成几类，就能看出"哪里有块亮的东西、它是什么颜色"。
 */
'use strict';

const fs = require('node:fs');
const { decodePng } = require('./lib/png.js');

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** 把颜色归到人话上，字符画里一眼能认出"这块是什么" */
function classify(r, g, b, a = 255) {
  if (a < 40) return ' ';
  const L = lum(r, g, b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;

  if (sat < 0.16) return L > 200 ? '@' : L > 140 ? 'O' : L > 70 ? 'o' : L > 30 ? '.' : ' ';
  if (r > g && r > b) return L > 150 ? 'R' : 'r'; // 番茄红
  if (g >= r && g >= b) return L > 110 ? 'G' : 'g'; // 叶绿
  if (r > 150 && g > 120) return 'Y'; // 黄铜
  return 'b';
}

/* 深绿底上的深绿卡片，固有亮度差只有几个数，固定阈值会把它们压成一片。
   所以先统计整幅图的亮度分位，再把 [p3, p97] 拉满到 0–255 再分类。 */
function makeStretcher(data, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    hist[Math.round(lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]))] += 1;
  }
  const pick = (frac) => {
    let acc = 0;
    const target = n * frac;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  };
  const lo = pick(0.03);
  const hi = Math.max(lo + 8, pick(0.97));
  return (L) => ((L - lo) / (hi - lo)) * 255;
}

function main() {
  const file = process.argv[2];
  const cols = Number(process.argv[3] || 108);
  const raw = process.argv.includes('--raw');
  if (!file) {
    console.error('用法：node scripts/inspect-shot.js <png> [列数] [--raw]');
    process.exit(2);
  }

  const img = decodePng(fs.readFileSync(file));
  const { width, height, data } = img;
  const cellW = width / cols;
  // 字符是竖高的，一格按 2:1 取样，画面才不会被拉长
  const rows = Math.max(1, Math.round(height / (cellW * 2.05)));
  const cellH = height / rows;
  const stretch = raw ? (v) => v : makeStretcher(data, width * height);

  const at = (x, y) => {
    const i = (Math.min(height - 1, Math.max(0, y | 0)) * width + Math.min(width - 1, Math.max(0, x | 0))) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  console.log(`\n${file}   ${width}×${height}   →   ${cols}×${rows} 字符   ${raw ? '原始亮度' : '自动对比度拉伸'}\n`);

  let out = '';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let R = 0; let G = 0; let B = 0; let n = 0;
      for (let y = r * cellH; y < (r + 1) * cellH; y += 1.5) {
        for (let x = c * cellW; x < (c + 1) * cellW; x += 1.5) {
          const p = at(x, y);
          R += p[0]; G += p[1]; B += p[2]; n += 1;
        }
      }
      R /= n; G /= n; B /= n;
      // 拉伸只作用在"近灰"的像素上，彩色像素保留原本的红/绿/黄身份
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.16) {
        const L = stretch(lum(R, G, B));
        line += L > 232 ? '@' : L > 186 ? 'O' : L > 132 ? 'o' : L > 78 ? ':' : L > 34 ? '.' : ' ';
      } else {
        line += classify(R, G, B);
      }
    }
    out += line.replace(/\s+$/, '') + '\n';
  }
  console.log(out);
  console.log('图例： @ 搪瓷/白  O 浅  o 中  : 暗  . 更暗  (空) 最深   R/r 番茄红   G/g 叶绿   Y 黄铜\n');

  // 关键点取色
  const probes = [
    ['页面左上角（桌面底色）', width * 0.02, height * 0.03],
    ['左侧面板上方', width * 0.2, height * 0.12],
    ['表盘正中心', width * 0.2, height * 0.42],
    ['表盘正上方（刻度区）', width * 0.2, height * 0.2],
    ['右栏底部', width * 0.8, height * 0.95],
    ['画面正中', width * 0.5, height * 0.5],
  ];
  console.log('关键点取色：');
  for (const [label, x, y] of probes) {
    const p = at(x, y);
    console.log(`  ${label.padEnd(22, '　')} (${Math.round(x)},${Math.round(y)})  ${hex(p[0], p[1], p[2])}  alpha=${p[3]}`);
  }
  console.log('');
}

main();
