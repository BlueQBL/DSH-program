/*!
 * 蓝晒 · AI 图片生成器 —— 图片落盘前的处理（image.js，仅服务端）
 *
 * 上游可能给 base64（有的还带 data: 前缀），也可能给一个会过期的 URL。
 * 两种都要变成「自己的一个文件」——历史记录和下载都指着它。
 */
'use strict';

const path = require('node:path');

const MAX_BYTES = 32 * 1024 * 1024;

const SIGNATURES = [
  { mime: 'image/png', ext: '.png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: '.jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    ext: '.webp',
    test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'image/gif', ext: '.gif', test: (b) => b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
  { mime: 'image/avif', ext: '.avif', test: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' },
  {
    mime: 'image/svg+xml',
    ext: '.svg',
    test: (b) => b.length > 20 && /^\s*(<\?xml|<svg)/i.test(b.subarray(0, 200).toString('utf8')),
  },
];

/** 认图片格式：先看魔术字节，认不出来再看上游声明的 content-type */
function sniffImage(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return { mime: sig.mime, ext: sig.ext };
  }
  const declared = String(contentType || '').toLowerCase();
  if (declared.includes('png')) return { mime: 'image/png', ext: '.png' };
  if (declared.includes('jpeg') || declared.includes('jpg')) return { mime: 'image/jpeg', ext: '.jpg' };
  if (declared.includes('webp')) return { mime: 'image/webp', ext: '.webp' };
  if (declared.includes('svg')) return { mime: 'image/svg+xml', ext: '.svg' };
  return null;
}

/** 把上游给的 b64（可能带 data:image/png;base64, 前缀）解成 Buffer */
function decodeBase64Image(b64) {
  let text = String(b64 == null ? '' : b64).trim();
  if (!text) throw new Error('上游返回的 base64 是空的');
  let declared = '';
  const dataUrl = /^data:([^;,]+)?(;base64)?,/i.exec(text);
  if (dataUrl) {
    declared = dataUrl[1] || '';
    text = text.slice(dataUrl[0].length);
  }
  text = text.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) throw new Error('上游返回的图片数据不是合法 base64');
  // base64url 变体（- _）也认
  if (text.includes('-') || text.includes('_')) text = text.replace(/-/g, '+').replace(/_/g, '/');
  const buffer = Buffer.from(text, 'base64');
  if (!buffer.length) throw new Error('上游返回的图片数据解出来是空的');
  if (buffer.length > MAX_BYTES) throw new Error('上游返回的图片太大，已放弃保存');
  return { buffer, declaredType: declared };
}

/**
 * 把一张图变成「要落盘的东西」：Buffer + 扩展名 + 尺寸说明。
 * 认不出格式不硬存（存下来的坏文件会让界面显示裂图，比报错更难排查）。
 */
function toStoredImage(buffer, options) {
  const o = options || {};
  const format = sniffImage(buffer, o.contentType);
  if (!format) throw new Error('上游返回的数据不是可识别的图片格式');
  return { buffer, mime: format.mime, ext: format.ext };
}

/**
 * 读图片的像素尺寸（只认 PNG / JPEG / WebP / GIF 这几个最常见的头）。
 * 为什么要它：从链接导入的图没有上游的 size 参数可抄，尺寸只能从图本身读出来。
 */
function dimensionsOf(buffer) {
  if (!buffer || buffer.length < 24) return null;

  // PNG：IHDR 紧跟在签名后面
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF：逻辑屏幕宽高（小端）
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // WebP：VP8X / VP8 / VP8L 三种块
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buffer.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  // JPEG：一路找 SOFn 段
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < buffer.length) {
      if (buffer[pos] !== 0xff) {
        pos += 1;
        continue;
      }
      const marker = buffer[pos + 1];
      const length = buffer.readUInt16BE(pos + 2);
      // SOF0~SOF15（除了 DHT/JPG/DAC 那几个）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(pos + 7), height: buffer.readUInt16BE(pos + 5) };
      }
      if (length < 2) break;
      pos += 2 + length;
    }
    return null;
  }

  return null;
}

/** 下载时用的文件名：保留一点描述，去掉非法字符，长度收口 */
function downloadName(record) {
  const prompt = String((record && record.prompt) || 'image')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  const id = String((record && record.id) || 'image').slice(-6);
  const ext = path.extname(String((record && record.file) || '')) || '.png';
  return `lan-shai-${prompt || 'image'}-${id}${ext}`.replace(/--+/g, '-');
}

module.exports = {
  MAX_BYTES,
  sniffImage,
  decodeBase64Image,
  toStoredImage,
  dimensionsOf,
  downloadName,
};
