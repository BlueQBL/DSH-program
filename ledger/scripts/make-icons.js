/* ═══════════════════════════════════════════════════════════════
   流水账 · 图标生成
   ───────────────────────────────────────────────────────────────
   node scripts/make-icons.js

   零依赖：只用 Node 内置的 zlib 手写 PNG。
   别的项目一个图标包几十兆，这里是一张 4×4 超采样的位图，
   和 index.html 里那张 SVG 是同一套设计（小票 + 撕口 + 条码）。
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'icons');
const SS = 4; // 超采样倍数，用来去锯齿

/* ── PNG 编码 ─────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型 RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 过滤器：None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ── 极简画布 ─────────────────────────────────────────────── */

const DESIGN = 512; // 所有图案都按 512×512 的设计坐标写

function hex(c) {
  const s = c.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
}

/** @param {number} pixels 位图边长（含超采样），设计坐标按比例换算过去 */
function makeCanvas(pixels) {
  const px = Buffer.alloc(pixels * pixels * 4, 0); // 全透明起手
  const W = pixels;
  const K = pixels / DESIGN;

  function blend(x, y, rgb) {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    const a = rgb[3] / 255;
    px[i]     = Math.round(px[i]     * (1 - a) + rgb[0] * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + rgb[1] * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + rgb[2] * a);
    px[i + 3] = Math.max(px[i + 3], rgb[3]);
  }

  return {
    px,
    /** rect(x, y, w, h, '#rrggbb') —— 设计坐标，0..512 */
    rect(x, y, w, h, color) {
      const rgb = hex(color);
      const x0 = Math.round(x * K), y0 = Math.round(y * K);
      const x1 = Math.round((x + w) * K), y1 = Math.round((y + h) * K);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(xx, yy, rgb);
    },
    /** poly([[x,y], ...], '#rrggbb') —— 扫描线填充，奇偶规则 */
    poly(points, color) {
      const rgb = hex(color);
      const pts = points.map(([x, y]) => [x * K, y * K]);
      let minY = Infinity, maxY = -Infinity;
      pts.forEach(([, y]) => { if (y < minY) minY = y; if (y > maxY) maxY = y; });
      for (let yy = Math.ceil(minY); yy <= Math.floor(maxY); yy++) {
        const xs = [];
        for (let i = 0, n = pts.length; i < n; i++) {
          const [ax, ay] = pts[i];
          const [bx, by] = pts[(i + 1) % n];
          if ((ay <= yy && by > yy) || (by <= yy && ay > yy)) {
            xs.push(ax + (yy - ay) / (by - ay) * (bx - ax));
          }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const x0 = Math.ceil(xs[i]), x1 = Math.floor(xs[i + 1]);
          for (let xx = x0; xx <= x1; xx++) blend(xx, yy, rgb);
        }
      }
    }
  };
}

/** 超采样后降采样到目标尺寸 */
function resolve(canvas, size) {
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * size * SS + (x * SS + dx)) * 4;
          const al = canvas.px[i + 3] / 255;
          r += canvas.px[i] * al;
          g += canvas.px[i + 1] * al;
          b += canvas.px[i + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o]     = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n * 255);
    }
  }
  return out;
}

/* ── 图案 ─────────────────────────────────────────────────── */

const BLOTTER = '#121813';
const PAPER   = '#f1f1ec';
const INK     = '#23282a';
const FAINT   = '#c9c9c0';
const GREY    = '#8f958f';
const RED     = '#b8322a';

/* 小票的撕口：底边 16 个锯齿 */
function tearPath(x, y, w, tooth, depth) {
  const n = Math.round(w / tooth);
  const step = w / n;
  const pts = [[x, y]];
  let cx = x;
  for (let i = 0; i < n; i++) {
    pts.push([cx + step / 2, y + depth]);
    cx += step;
    pts.push([cx, y]);
  }
  return pts;
}

/**
 * 画一卷小票。
 * @param {object} c 画布
 * @param {boolean} maskable 为 true 时把主体缩进中心安全区（图标会被裁成圆形/圆角）
 */
function drawTape(c, maskable) {
  const S = DESIGN;

  // 底：深墨绿桌垫，满出血
  c.rect(0, 0, S, S, BLOTTER);

  const k = maskable ? 0.74 : 1;          // 安全区缩放
  const cx = S / 2, cy = S / 2;
  const px = (v) => cx + (v - cx) * k;
  const py = (v) => cy + (v - cy) * k;
  const sw = (v) => v * k;

  // 纸
  const x = px(138), w = sw(236), y = py(58), h = sw(340);
  c.rect(x, y, w, h, PAPER);
  c.poly(tearPath(x, y + h, w, sw(29.5), sw(21)), PAPER);

  const bar = (bx, by, bw, bh, color) => c.rect(px(bx), py(by), sw(bw), sw(bh), color);

  // 抬头
  bar(166, 88, 96, 16, INK);
  bar(276, 88, 70, 10, FAINT);       // 右侧的日期
  bar(166, 120, 180, 3, FAINT);      // 虚分隔

  // 三行流水：左侧分类，右侧金额。第三行是红的 —— 那是支出。
  bar(166, 144, 62, 11, GREY);  bar(300, 144, 46, 13, INK);
  bar(166, 174, 78, 11, GREY);  bar(306, 174, 40, 13, INK);
  bar(166, 204, 54, 11, GREY);  bar(294, 204, 52, 15, RED);

  bar(166, 240, 180, 3, FAINT);

  // 条码：和统计页那个「分类条码」是同一个意思
  const widths = [8, 5, 12, 6, 9, 4, 11, 7, 5, 10, 6, 8, 4, 9, 7, 12, 5, 8];
  let bx = 166;
  for (let i = 0; i < widths.length; i++) {
    const bw = widths[i];
    if (bx + bw > 166 + 180) break;
    bar(bx, 262, bw * 0.62, 62, INK);
    bx += bw;
  }

  // 合计
  bar(166, 344, 74, 12, GREY);
  bar(292, 342, 54, 16, INK);
}

/* ── 生成 ─────────────────────────────────────────────────── */

function render(size, maskable) {
  const canvas = makeCanvas(size * SS);
  drawTape(canvas, maskable);
  return encodePNG(size, size, resolve(canvas, size));
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const jobs = [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true]
  ];

  jobs.forEach(([name, size, maskable]) => {
    const buf = render(size, maskable);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, buf);
    console.log(`${name.padEnd(24)} ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
  });
}

main();
