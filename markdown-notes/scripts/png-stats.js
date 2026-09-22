/**
 * 开发用：不靠眼睛也能判断"画面有没有画出来"（不是应用的一部分）
 *
 *   node scripts/png-stats.js .screens/desktop.png
 *   node scripts/png-stats.js .screens/desktop.png 280 936 943
 *
 * 自己解 PNG（Node 自带 zlib），然后按区域统计：
 * 底色对不对、字有没有画出来、红笔有没有出现在该出现的地方、
 * 墨色代码卡片是不是真的落在浅色纸面里。
 * 这不是审美判断，是"别把白字画在白底上"这种事故的体检。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const chunks = [];

  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      chunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只解得了 RGB / RGBA 的 PNG（colorType=' + colorType + '）');
  if (bitDepth !== 8) throw new Error('只解得了 8 位色深（bitDepth=' + bitDepth + '）');
  if (interlace !== 0) throw new Error('解不了隔行扫描的 PNG');

  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) {
        throw new Error('未知行过滤器 ' + filter);
      }
      cur[x] = v;
    }
    cur.copy(data, y * stride);
    prev = cur;
  }

  return { width, height, channels, data };
}

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function regionStats(img, x0, x1, y0, y1) {
  const { data, channels, width } = img;
  const total = Math.max(1, (x1 - x0) * (y1 - y0));
  const hist = new Map();
  let sum = 0;
  let ink = 0;      // 明显比底色暗的像素（当作"有字"）
  let red = 0;      // 红笔
  let dark = 0;     // 深色（墨色卡片）
  let light = 0;    // 浅色（纸面）

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = lum(r, g, b);
      sum += l;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist.set(key, (hist.get(key) || 0) + 1);
      if (l < 0.2) dark++;
      if (l > 0.8) light++;
      if (r > 140 && g < 110 && b < 100 && r - g > 60) red++;
    }
  }

  // 底色 = 出现最多的那个颜色
  let bestKey = 0;
  let bestCount = -1;
  hist.forEach((count, key) => {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  });
  const bg = { r: ((bestKey >> 10) & 31) << 3, g: ((bestKey >> 5) & 31) << 3, b: (bestKey & 31) << 3 };
  const bgLum = lum(bg.r, bg.g, bg.b);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      if (Math.abs(lum(data[i], data[i + 1], data[i + 2]) - bgLum) > 0.18) ink++;
    }
  }

  return {
    size: (x1 - x0) + '×' + (y1 - y0),
    bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')',
    meanLum: (sum / total).toFixed(3),
    inkPct: ((ink / total) * 100).toFixed(1) + '%',
    redPx: red,
    darkPct: ((dark / total) * 100).toFixed(1) + '%',
    lightPct: ((light / total) * 100).toFixed(1) + '%',
  };
}

/** 找出某一竖条里"深色横带"的区间：用来确认墨色代码卡片确实印在纸面上 */
function darkBands(img, x0, x1, y0, y1) {
  const { data, channels, width } = img;
  const bands = [];
  let start = -1;
  for (let y = y0; y < y1; y++) {
    let darkRun = 0;
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      if (lum(data[i], data[i + 1], data[i + 2]) < 0.25) darkRun++;
    }
    const isBand = darkRun > (x1 - x0) * 0.6;
    if (isBand && start < 0) start = y;
    if (!isBand && start >= 0) { bands.push([start, y - 1]); start = -1; }
  }
  if (start >= 0) bands.push([start, y1 - 1]);
  return bands.filter((b) => b[1] - b[0] > 4);
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '..', '.screens', 'desktop.png');
  const img = decodePng(fs.readFileSync(file));
  console.log(file + '  ' + img.width + '×' + img.height + '  ' + img.channels + ' 通道\n');

  const numeric = process.argv.slice(3).map(Number).filter((n) => Number.isFinite(n));
  const cut = numeric.length >= 3 ? numeric : null;
  const railEnd = cut ? cut[0] : Math.round(img.width * 0.175);
  const srcEnd = cut ? cut[1] : Math.round(img.width * 0.585);
  const proofStart = cut ? cut[2] : Math.round(img.width * 0.59);

  const rows = [
    ['目录栏', 0, railEnd, 60, img.height],
    ['稿纸栏', railEnd, srcEnd, 60, img.height],
    ['印张栏', proofStart, img.width, 40, img.height],
  ];

  rows.forEach(([name, x0, x1, y0, y1]) => {
    console.log(name + '  ' + JSON.stringify(regionStats(img, x0, x1, y0, y1)));
  });

  console.log('\n印张栏里的墨色横带（代码卡片）：');
  const bands = darkBands(img, proofStart + 20, img.width - 20, 40, img.height);
  if (!bands.length) console.log('  （没有找到）');
  bands.forEach((b) => console.log('  y ' + b[0] + '–' + b[1] + '（高 ' + (b[1] - b[0] + 1) + 'px）'));

  console.log('\n目录栏里的红笔像素（选中项的左边线 / 标记）：');
  const rail = regionStats(img, 0, railEnd, 60, img.height);
  console.log('  ' + rail.redPx + ' px');
}

main();
