'use strict';

/**
 * 离线改图用到的像素处理（lib/offline.js 里的 decodePng / resizeRgb / applyEdit）。
 *
 * 为什么单独测：解 PNG 是「离线也能改图」的前提，解错了就是一张花屏，
 * 而花屏在界面上看起来像「上游给的图有问题」—— 最难查的那种。
 *
 * 运行：node test/raster.test.js
 */

const zlib = require('node:zlib');
const { eq, ok, not, has, throws, group, report } = require('./harness.js');
const Offline = require('../lib/offline.js');

/** 手搓一张 PNG：可以指定 filter 类型，用来验证我们的解码器真的实现了五种过滤器 */
function makePng(width, height, pixels, filterType) {
  const bpp = 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = filterType;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x];
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      let encoded = value;
      if (filterType === 1) encoded = value - left;
      else if (filterType === 2) encoded = value - up;
      else if (filterType === 3) encoded = value - ((left + up) >> 1);
      else if (filterType === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        encoded = value - pred;
      }
      raw[rowStart + 1 + x] = encoded & 0xff;
    }
  }

  const idat = zlib.deflateSync(raw);
  return pngFromRaw(width, height, idat);
}

/** 用给定的（已过滤的）原始数据组装 PNG */
function pngFromRaw(width, height, idat) {
  const crc = (buf) => Offline.crc32(buf);
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'latin1');
    const body = Buffer.concat([typeBuf, data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

(async function main() {
  console.log('解 PNG');

  await group('自己写出来的图能原样解回来（RGB 逐像素核对）', () => {
    const pixels = Buffer.alloc(4 * 3 * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) % 256;
    const png = Offline.encodePng(4, 3, pixels);
    const decoded = Offline.decodePng(png);
    eq(decoded.width, 4, '宽');
    eq(decoded.height, 3, '高');
    eq(decoded.channels, 3, 'RGB');
    eq(decoded.rgb.equals(pixels), true, '像素一模一样');
  });

  await group('五种行过滤器都能解（不只认我们自己的 filter 0）', () => {
    const width = 4;
    const height = 3;
    const pixels = Buffer.alloc(width * height * 3);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 11 + 5) % 256;
    for (let filter = 0; filter <= 4; filter += 1) {
      const png = makePng(width, height, pixels, filter);
      const decoded = Offline.decodePng(png);
      eq(decoded.rgb.equals(pixels), true, `filter ${filter} 解对了`);
    }
  });

  await group('不是 PNG / 不是 8 位 / 隔行 / 调色板图：明确拒绝，不硬解', () => {
    throws(() => Offline.decodePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])), 'JPEG 拒绝');
    throws(() => Offline.decodePng(Buffer.alloc(0)), '空 buffer 拒绝');
    // 改一位深：把 IHDR 的 bitDepth 改成 16
    const png = Offline.encodePng(2, 2, Buffer.alloc(12, 9));
    const broken = Buffer.from(png);
    broken[24] = 16;
    has(
      (() => {
        try {
          Offline.decodePng(broken);
        } catch (err) {
          return err.message;
        }
        return '';
      })(),
      '8 位',
      '16 位深说清楚'
    );
    // 改隔行标记
    const interlaced = Buffer.from(png);
    interlaced[28] = 1;
    has(
      (() => {
        try {
          Offline.decodePng(interlaced);
        } catch (err) {
          return err.message;
        }
        return '';
      })(),
      '隔行',
      '隔行扫描说清楚'
    );
  });

  console.log('缩放与改图');

  await group('盒式缩放：尺寸对、颜色大致保持', () => {
    const source = Buffer.alloc(4 * 4 * 3, 0);
    // 左上 2×2 红，其余蓝
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const o = (y * 4 + x) * 3;
        const red = x < 2 && y < 2;
        source[o] = red ? 255 : 0;
        source[o + 1] = 0;
        source[o + 2] = red ? 0 : 255;
      }
    }
    const small = Offline.resizeRgb(source, 4, 4, 2, 2);
    eq(small.length, 2 * 2 * 3, '尺寸是 2×2');
    ok(small[0] > 100 && small[2] < 100, '左上角仍是红');
    ok(small[6] < 100 && small[8] > 100, '右下角仍是蓝');
    eq(Offline.resizeRgb(source, 4, 4, 4, 4), source, '同尺寸直接返回原数据');
  });

  await group('离线改图：真的改了原图，尺寸不变', () => {
    const original = Offline.render({ prompt: '一只白猫', styleId: 'photo', size: '128x128' });
    const edited = Offline.applyEdit({ buffer: original.buffer, styleId: 'cyberpunk', prompt: '把夜晚调成霓虹' });
    eq(edited.width, 128, '宽不变');
    eq(edited.height, 128, '高不变');
    eq(edited.mime, 'image/png', '还是 PNG');
    not(edited.buffer.equals(original.buffer), '文件内容变了');
    const a = Offline.decodePng(original.buffer);
    const b = Offline.decodePng(edited.buffer);
    not(a.rgb.equals(b.rgb), '像素变了');
    // 平均色应当朝赛博朋克的霓虹配色偏一些
    const mean = (buf) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      const n = buf.length / 3;
      for (let i = 0; i < buf.length; i += 3) {
        r += buf[i];
        g += buf[i + 1];
        bl += buf[i + 2];
      }
      return [r / n, g / n, bl / n];
    };
    const before = mean(a.rgb);
    const after = mean(b.rgb);
    ok(Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1]) + Math.abs(after[2] - before[2]) > 3, '整体色调有变化');
  });

  await group('改大图会压到上限（离线演示不该卡住）', () => {
    const big = Offline.encodePng(2000, 1000, Buffer.alloc(2000 * 1000 * 3, 40));
    const edited = Offline.applyEdit({ buffer: big, styleId: 'photo', prompt: 'x' });
    eq(Math.max(edited.width, edited.height), Offline.CAP_MAX_SIDE, '最长边压到上限');
    eq(edited.width > edited.height, true, '还是横图');
  });

  await group('改不了的原图给出人话（接上 Key 之后才支持）', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    throws(() => Offline.applyEdit({ buffer: jpeg, styleId: 'photo', prompt: 'x' }), 'JPEG 直接抛错');
  });

  report('raster');
})();
