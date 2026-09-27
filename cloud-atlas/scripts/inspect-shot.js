/* 截图体检：把 PNG 降采样成终端字符画，并统计颜色分布
 *
 * 用法：node scripts/inspect-shot.js .screens/desktop.png [列数]
 *
 * 为什么需要它：DOM 测量能证明"元素有面积、不重叠、对比度够"，
 * 但证明不了"这一整屏看着是活的还是死的"——
 * 比如曲线画成了一根直线、大片区域没渲染、强调色根本没出现。
 * 这些在字符画和颜色统计里一眼就能看出来。
 *
 * 字符含义（深色底→空格、浅色→@）：
 *   @ 很亮   O 亮   o 中   : 暗   . 更暗   (空) 最深
 *   彩色像素按色相单独标：R 红  Y 黄/琥珀  G 绿  b 蓝/青  m 紫
 * 云图的强调色是琥珀（fair/clear 基调）或青（雨）等，会在字符画里显成一个色相字母，
 * 所以"曲线有没有画出来"可以直接看那一行有没有连续的 Y 或 b。
 */
'use strict';

const fs = require('node:fs');
const { decodePng, sampleAt } = require('./lib/png.js');

const hex = (c) => c.hex;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * 色彩判定：色相 + 绝对色度（max-min）。
 *
 * 两个坑都踩过了，所以这里写清楚：
 *   1. 不能用 (max-min)/max 当饱和度。深蓝底 #152E44 的 max 也小，
 *      这个式子会算出 0.69 的"高饱和"，把整屏中性灰蓝判成 92% 彩色。
 *   2. 也不能只用 HSL 的饱和度。它虽然修好了上面的问题，
 *      但极暗的底色照样带一点饱和度（#101C29 是 S=0.44），
 *      于是背景又被算成"青蓝系"，统计结果看着像整屏都是强调色。
 * 结论：判"有没有颜色"要看绝对色度。底色的 max-min 只有 25 左右，
 * 真正的强调色（琥珀 #EAA53F 是 171，青 #6FBCD4 是 101）差着一个数量级。
 */
const CHROMA_MIN = 34;

function hsl(r, g, b) {
  const R = r / 255; const G = g / 255; const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const L = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l: L, chroma: 0 };
  const s = d / (1 - Math.abs(2 * L - 1));
  let h;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l: L, chroma: d * 255 };
}

/** 把颜色归到人话上：字符画里一眼能认出"这块是什么颜色" */
function classify(r, g, b, a) {
  if (a < 40) return ' ';
  const L = lum(r, g, b);
  const { h, chroma } = hsl(r, g, b);

  if (chroma < CHROMA_MIN) return L > 200 ? '@' : L > 140 ? 'O' : L > 80 ? 'o' : L > 40 ? ':' : L > 18 ? '.' : ' ';
  // 彩色按色相分：云图的强调色是琥珀（暖天）或青（雨天/夜间），两者都要认出来
  if (h >= 20 && h < 70) return 'Y';    // 琥珀 / 黄
  if (h >= 170 && h < 260) return 'b';  // 青 / 蓝
  if (h >= 260 && h < 320) return 'm';  // 紫
  if (h < 20 || h >= 340) return 'R';   // 红
  if (h >= 70 && h < 170) return 'G';   // 绿
  return 'y';
}

/* 深色底上的深浅差异只有几个数，固定阈值会把画面压成一片。
   所以先统计整幅图的亮度分位，把 [p3, p97] 拉满到 0–255 再分类。 */
function makeStretcher(data, n) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.round(lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]))] += 1;
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

  console.log(`\n${file}　${width}×${height}　→　${cols}×${rows} 字符　${raw ? '原始亮度' : '自动对比度拉伸'}\n`);

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
      // 近灰的像素走亮度拉伸；彩色像素保留原本的色相身份
      if (hsl(R, G, B).chroma < CHROMA_MIN) {
        const L = stretch(lum(R, G, B));
        line += L > 232 ? '@' : L > 186 ? 'O' : L > 132 ? 'o' : L > 78 ? ':' : L > 34 ? '.' : ' ';
      } else {
        line += classify(R, G, B, 255);
      }
    }
    out += line.replace(/\s+$/, '') + '\n';
  }
  console.log(out);
  console.log('图例： @ 很亮  O 亮  o 中  : 暗  . 更暗  (空) 最深　｜　彩色： Y 琥珀/黄  b 青/蓝  m 紫  R 红  G 绿  y 其他彩色');

  /* --- 颜色统计：判断"整屏是不是活的" --- */
  const buckets = new Map();
  let warm = 0;     // 琥珀系（fair / clear 基调的强调色）
  let cool = 0;     // 青蓝系（雨、夜间基调的强调色）
  let gray = 0;
  const step = 4;   // 每 4 个像素取一个，够统计了，也快很多
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const p = at(x, y);
      const { h, chroma } = hsl(p[0], p[1], p[2]);
      if (chroma < CHROMA_MIN) {
        gray++;
      } else if (h >= 20 && h < 70) {
        warm++;
      } else if (h >= 170 && h < 320) {
        cool++;
      }
      const key = `${p[0] >> 4}-${p[1] >> 4}-${p[2] >> 4}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
  }
  const sampled = Math.ceil(width / step) * Math.ceil(height / step);
  console.log(`\n取色统计（每 ${step} 像素取一个，共 ${sampled} 个采样点）`);
  console.log(`　不同颜色数：${buckets.size}`);
  console.log(`　中性灰：${(gray / sampled * 100).toFixed(1)}%　琥珀系：${(warm / sampled * 100).toFixed(2)}%　`
    + `青蓝系：${(cool / sampled * 100).toFixed(2)}%`);
  if (warm / sampled < 0.0005 && cool / sampled < 0.0005) {
    console.log('　⚠ 几乎找不到强调色像素：曲线、量程条、指针可能没画出来，或整屏配色异常');
  }

  const probes = [
    ['页面左上角（底色）', width * 0.02, height * 0.03],
    ['报头中间（搜索框）', width * 0.45, height * 0.03],
    ['左栏（常用城市）', width * 0.12, height * 0.2],
    ['大号气温读数', width * 0.42, height * 0.24],
    ['仪器读数区', width * 0.74, height * 0.26],
    ['曲线中部（应有强调色）', width * 0.55, height * 0.5],
    ['7 日量程条', width * 0.55, height * 0.72],
    ['画面正中', width * 0.5, height * 0.5],
  ];
  console.log('\n关键点取色：');
  for (const [label, x, y] of probes) {
    const c = sampleAt(img, x, y, 2);
    if (c) console.log(`  ${label.padEnd(20, '　')} (${Math.round(x)},${Math.round(y)})  ${hex(c)}  亮度 ${Math.round(c.lum)}`);
  }
  console.log('');
}

main();
