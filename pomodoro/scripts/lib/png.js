/* 极简 PNG 解码器：只处理 Chrome 截图会产出的 8 位非隔行真彩 PNG。
 * 供 inspect-shot.js（降采样成字符画）和 verify-layout.js（采样像素验证指针位置）共用。
 */
'use strict';

const zlib = require('node:zlib');

/** @returns {{width:number,height:number,data:Buffer}} data 为 RGBA */
function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('不是 PNG 文件');

  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('不支持隔行扫描的 PNG');
      if (depth !== 8) throw new Error(`不支持 ${depth} 位深`);
      if (colorType !== 2 && colorType !== 6) throw new Error(`不支持颜色类型 ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));

    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    prev = line;

    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = bpp === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, data: out };
}

const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/** 以 (x,y) 为中心取一小块的平均色，避开单个噪点 */
function sampleAt(img, x, y, radius = 2) {
  let R = 0; let G = 0; let B = 0; let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      R += img.data[i]; G += img.data[i + 1]; B += img.data[i + 2]; n += 1;
    }
  }
  if (!n) return null;
  R = Math.round(R / n); G = Math.round(G / n); B = Math.round(B / n);
  return { r: R, g: G, b: B, hex: toHex(R, G, B), lum: 0.2126 * R + 0.7152 * G + 0.0722 * B };
}

const isWarm = (c) => c && c.r > c.g + 40 && c.r > c.b + 40; // 番茄红 / 黄铜这类暖色

module.exports = { decodePng, sampleAt, toHex, isWarm };
