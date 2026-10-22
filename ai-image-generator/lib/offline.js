/*!
 * 蓝晒 · AI 图片生成器 —— 离线显影引擎（offline.js，仅服务端）
 *
 * 没有 API Key 时，界面不能只剩一个红叉：这里用纯 Node（zlib 手写 PNG）
 * 按提示词的哈希画一张**真的 PNG**——同一句描述永远得到同一张图。
 *
 * 它不是"假图占位"：有渐变天空、有太阳、有山脊剪影和水面反光、有胶片颗粒，
 * 配色取自当前风格（styles.js 里的 palette）。用途是让整条链路
 * （出图 → 落盘 → 历史 → 下载）在没有 Key 的情况下也能被真的走一遍。
 *
 * 上限：离线演示最长边压到 1280，算得快、内存也稳；真实尺寸由上游模型决定。
 */
'use strict';

const zlib = require('node:zlib');
const Styles = require('./styles.js');

const CAP_MAX_SIDE = 1280;

/* ── PNG 编码 ─────────────────────────────────────────────── */

let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

function crc32(buffer) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把 RGB 像素装成 PNG。
 * filter 一律 0（不做行预测）—— 这里的图没有大片纯色，预测收益很小，代码简单更值。
 */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 2; // 颜色类型 2 = truecolor RGB
  header[10] = 0; // 压缩方法
  header[11] = 0; // 过滤方法
  header[12] = 0; // 隔行扫描：无

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // 过滤类型 0
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 确定性随机与配色 ─────────────────────────────────────── */

/** FNV-1a：同一句话 → 同一个种子 */
function hashSeed(text) {
  let h = 0x811c9dc5;
  const str = String(text == null ? '' : text);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const text = String(hex || '').replace('#', '');
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [60, 90, 130];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function scale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/* ── 解 PNG：离线「改图」要用 ─────────────────────────────── */

/**
 * 解一张 PNG（8 位的 RGB / RGBA、非隔行、filter 0~4）。
 *
 * 为什么只支持这些：这是我们自己写出去的格式，也是绝大多数工具导出的默认格式；
 * JPEG / WebP / 隔行 PNG 一律明确拒绝 —— 宁可说「离线改不了，接上 Key 再改」，
 * 也别解出一张花屏。
 *
 * @returns {{width:number, height:number, channels:number, rgb:Buffer}}
 */
function decodePng(buffer) {
  if (!buffer || buffer.length < 24) throw new Error('这不是一张 PNG');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('这不是一张 PNG');

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.subarray(pos + 4, pos + 8).toString('latin1');
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (!width || !height) throw new Error('PNG 头信息读不出来');
  if (bitDepth !== 8) throw new Error(`只支持 8 位深的 PNG（这张是 ${bitDepth} 位）`);
  if (interlace) throw new Error('不支持隔行扫描的 PNG');
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`只支持 RGB / RGBA 的 PNG（这张的颜色类型是 ${colorType}）`);
  if (!idat.length) throw new Error('PNG 里没有图像数据');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整');

  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[dst + x - channels] : 0;
      const up = y > 0 ? out[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[dst - stride + x - channels] : 0;
      const value = raw[src + x];
      let next = value;
      if (filter === 1) next = value + left;
      else if (filter === 2) next = value + up;
      else if (filter === 3) next = value + ((left + up) >> 1);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        next = value + pred;
      } else if (filter !== 0) {
        throw new Error(`PNG 用了不认识的过滤方式（${filter}）`);
      }
      out[dst + x] = next & 0xff;
    }
  }

  // 统一成 RGB（丢掉 alpha）
  if (channels === 3) return { width, height, channels: 3, rgb: out };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = out[i * 4];
    rgb[i * 3 + 1] = out[i * 4 + 1];
    rgb[i * 3 + 2] = out[i * 4 + 2];
  }
  return { width, height, channels: 4, rgb };
}

/** 盒式缩放（离线图不需要多好的重采样，够用且快） */
function resizeRgb(rgb, width, height, targetWidth, targetHeight) {
  if (width === targetWidth && height === targetHeight) return rgb;
  const out = Buffer.alloc(targetWidth * targetHeight * 3);
  const xRatio = width / targetWidth;
  const yRatio = height / targetHeight;
  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < width; sx += 1) {
          const o = (sy * width + sx) * 3;
          r += rgb[o];
          g += rgb[o + 1];
          b += rgb[o + 2];
          count += 1;
        }
      }
      const o = (y * targetWidth + x) * 3;
      const n = count || 1;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

/**
 * 离线「改图」：真的在原来那张图上动手（不是另画一张）。
 *
 * 做三件事：把画面往所选风格的配色上拉一点 → 四角压暗 → 加一点颗粒。
 * 幅度都收着点，因为这是离线演示：接上 Key 之后改图是上游按提示词重画。
 */
function applyEdit(input) {
  const i = input || {};
  const style = Styles.findStyle(i.styleId);
  const palette = (style.palette || ['#0d1f33', '#3d6b88', '#e9c46a']).map(hexToRgb);
  const tint = mix(palette[1], palette[2], 0.35);

  const decoded = decodePng(i.buffer);
  const target = sizeFor(`${decoded.width}x${decoded.height}`);
  const rgb = resizeRgb(decoded.rgb, decoded.width, decoded.height, target.width, target.height);
  const { width, height } = target;
  const seed = hashSeed(`${i.prompt || ''}|${style.id}|${width}x${height}`);
  const amount = typeof i.strength === 'number' ? Math.max(0, Math.min(1, i.strength)) : 0.22;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3;
      const vx = (x / width - 0.5) * 2;
      const vy = (y / height - 0.5) * 2;
      const vignette = 1 - 0.18 * Math.min(1, (vx * vx + vy * vy) * 0.55);
      const noise = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ seed) >>> 0) % 9;
      const grain = (noise - 4) * 0.8;
      for (let c = 0; c < 3; c += 1) {
        const shifted = rgb[o + c] + (tint[c] - rgb[o + c]) * amount;
        rgb[o + c] = Math.max(0, Math.min(255, Math.round(shifted * vignette + grain)));
      }
    }
  }

  return {
    buffer: encodePng(width, height, rgb),
    mime: 'image/png',
    ext: '.png',
    width,
    height,
    capped: target.capped,
    styleId: style.id,
  };
}

/* ── 画一张 ───────────────────────────────────────────────── */

/** 请求的尺寸太大就等比压到 1280，返回实际要画的尺寸 */
function sizeFor(size) {
  const parsed = Styles.parseSize(size) || { width: 1024, height: 1024 };
  const maxSide = Math.max(parsed.width, parsed.height);
  if (maxSide <= CAP_MAX_SIDE) return { width: parsed.width, height: parsed.height, capped: false };
  const k = CAP_MAX_SIDE / maxSide;
  const width = Math.max(16, Math.round((parsed.width * k) / 2) * 2);
  const height = Math.max(16, Math.round((parsed.height * k) / 2) * 2);
  return { width, height, capped: true };
}

/**
 * 画一张「蓝晒风景」。
 * @param {object} input { prompt, styleId, size }
 */
function render(input) {
  const i = input || {};
  const style = Styles.findStyle(i.styleId);
  const palette = (style.palette || ['#0d1f33', '#3d6b88', '#e9c46a']).map(hexToRgb);
  const [back, mid, light] = [palette[0], palette[1], palette[2]];

  const { width, height, capped } = sizeFor(i.size);
  // 种子只由「描述 + 风格 + 尺寸」决定：同一句描述永远画出同一张图（可复现，测试好写）
  const seed = hashSeed(`${i.prompt || ''}|${style.id}|${width}x${height}`);
  const rand = mulberry32(seed);

  // 天空顶端一律往深色收一点：不管这套配色本身多亮，画面都要有「上面暗、地平线亮」的层次，
  // 否则亮色调（水彩、极简）会糊成一整片浅色
  const deep = [10, 18, 26];
  const skyTop = mix(scale(back, 0.95), deep, 0.45);
  const skyBottom = mix(mid, light, 0.42);
  // 水面：靠近地平线的一头更亮（天光落下来），靠近观众的一头暗下去，画面才立得住
  const waterFar = mix(back, mid, 0.66);
  const waterNear = mix(mix(back, mid, 0.15), deep, 0.35);

  const horizon = Math.round(height * (0.56 + rand() * 0.06));
  const sunX = width * (0.24 + rand() * 0.52);
  const sunY = horizon * (0.32 + rand() * 0.3);
  const sunR = Math.max(6, Math.min(width, height) * (0.05 + rand() * 0.05));

  // 山脊：用几条正弦叠出剪影，两条山脊一前一后
  const ridges = [0, 1].map((layer) => {
    const coeffs = Array.from({ length: 4 }, () => ({
      amp: (0.02 + rand() * 0.09) * height * (layer ? 1.4 : 1),
      freq: (0.4 + rand() * 2.6) / width,
      phase: rand() * Math.PI * 2,
    }));
    const base = horizon - height * (layer ? 0.02 : 0.06);
    // 远山被雾托着（更淡），近山是实心的剪影（更暗）
    const color = layer
      ? mix(mix(back, mid, 0.3), skyBottom, 0.05)
      : mix(mix(back, mid, 0.5), skyBottom, 0.14);
    const heights = new Int32Array(width);
    for (let x = 0; x < width; x += 1) {
      let v = 0;
      for (const c of coeffs) v += c.amp * Math.sin(x * c.freq + c.phase);
      heights[x] = Math.round(base - Math.abs(v) * (layer ? 0.5 : 1));
    }
    return { heights, color };
  });

  // 水面 / 地面的横向波纹
  const wavePhase = rand() * Math.PI * 2;
  const waveFreq = 0.06 + rand() * 0.12;

  // 空气中的颗粒（像逆光里的浮尘）
  const motes = Array.from({ length: 70 }, () => ({
    x: rand() * width,
    y: rand() * horizon,
    r: 0.6 + rand() * 2.2,
    a: 0.1 + rand() * 0.45,
  }));

  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const inSky = y < horizon;
    for (let x = 0; x < width; x += 1) {
      let color;
      if (inSky) {
        const t = y / Math.max(1, horizon);
        color = mix(skyTop, skyBottom, Math.pow(t, 1.5));
      } else {
        const t = (y - horizon) / Math.max(1, height - horizon);
        color = mix(waterFar, waterNear, Math.pow(t, 0.85));
        // 太阳在水面上拖出的一道亮路，越靠近观众越散
        const lane = Math.exp(-((x - sunX) * (x - sunX)) / (sunR * sunR * 7));
        const wave = (Math.sin(y * waveFreq + wavePhase) * 0.5 + 0.5) * (Math.sin(x * 0.021 + wavePhase * 0.5) * 0.5 + 0.5);
        color = mix(color, mix(light, [255, 248, 232], 0.32), lane * (1 - t * 0.55) * (0.26 + 0.4 * wave));
        color = mix(color, mix(mid, light, 0.5), 0.06 * wave);
      }

      // 地平线上的一道光：把天和水分开，画面不至于糊成一块
      const hz = Math.exp(-((y - horizon) * (y - horizon)) / (2 * Math.pow(Math.max(3, height * 0.011), 2)));
      color = mix(color, mix(light, [255, 250, 236], 0.55), hz * 0.3);

      // 太阳与光晕
      const dx = x - sunX;
      const dy = y - sunY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < sunR) {
        color = mix(light, [255, 248, 232], 1 - dist / sunR * 0.45);
      } else {
        const glow = Math.exp(-((dist - sunR) * (dist - sunR)) / (sunR * sunR * 14));
        color = mix(color, light, glow * (inSky ? 0.5 : 0.22));
      }

      // 山脊剪影（远山先画，近山盖在上面）。只画到地平线为止 —— 下面就是水面
      for (const ridge of ridges) {
        if (y >= ridge.heights[x] && y < horizon) {
          const edge = Math.min(1, (y - ridge.heights[x]) / Math.max(8, height * 0.12));
          color = mix(ridge.color, mix(ridge.color, skyBottom, 0.18), 1 - edge);
        }
      }

      // 边角压暗
      const vx = (x / width - 0.5) * 2;
      const vy = (y / height - 0.5) * 2;
      const vignette = 1 - 0.22 * Math.min(1, (vx * vx + vy * vy) * 0.55);
      color = scale(color, vignette);

      // 胶片颗粒：确定性哈希，不用 rand()（保证逐像素可重复）
      const noise = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663) ^ seed) >>> 0) % 13;
      const grain = (noise - 6) * 0.9;

      const offset = (y * width + x) * 3;
      rgb[offset] = Math.max(0, Math.min(255, Math.round(color[0] + grain)));
      rgb[offset + 1] = Math.max(0, Math.min(255, Math.round(color[1] + grain)));
      rgb[offset + 2] = Math.max(0, Math.min(255, Math.round(color[2] + grain)));
    }
  }

  // 浮尘单独一遍：只在它自己的包围盒里画，别放进逐像素循环（那会慢几十倍）
  for (const mote of motes) {
    const r = Math.max(1, Math.ceil(mote.r));
    for (let y = Math.max(0, Math.floor(mote.y - r)); y <= Math.min(height - 1, Math.ceil(mote.y + r)); y += 1) {
      for (let x = Math.max(0, Math.floor(mote.x - r)); x <= Math.min(width - 1, Math.ceil(mote.x + r)); x += 1) {
        const mx = x - mote.x;
        const my = y - mote.y;
        const d = Math.sqrt(mx * mx + my * my);
        if (d >= mote.r) continue;
        const k = 1 - d / mote.r;
        const offset = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          const target = [255, 250, 236][c];
          rgb[offset + c] = Math.round(rgb[offset + c] + (target - rgb[offset + c]) * mote.a * k);
        }
      }
    }
  }

  return {
    buffer: encodePng(width, height, rgb),
    mime: 'image/png',
    ext: '.png',
    width,
    height,
    capped,
    styleId: style.id,
    styleLabel: style.label,
    seed,
  };
}

module.exports = {
  CAP_MAX_SIDE,
  encodePng,
  decodePng,
  resizeRgb,
  applyEdit,
  hashSeed,
  mulberry32,
  render,
  sizeFor,
  crc32,
};
