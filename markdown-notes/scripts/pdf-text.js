'use strict';

/**
 * 开发用：从 PDF 里把文字抽出来（不是应用的一部分）
 *
 *   node scripts/pdf-text.js .screens/print-xxx.pdf
 *
 * 为什么要自己写：Chrome 打印时用的是**子集化字体 + Identity-H 编码**，
 * 内容流里的字节是字形编号不是 Unicode，直接搜字符串什么也搜不到。
 * 要读出字，必须先解 ToUnicode CMap（字形编号 → Unicode）再逐段解码。
 * 有了它，"打印出来到底有什么内容"才是个可以被验证的事实，而不是猜。
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

function inflate(bytes) {
  try {
    return zlib.inflateSync(bytes);
  } catch {
    try {
      return zlib.inflateRawSync(bytes);
    } catch {
      return null;
    }
  }
}

/** 解析 PDF：顶层对象 + 对象流（ObjStm）里包着的对象 */
function parseObjects(raw) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  const heads = [];
  while ((m = re.exec(raw)) !== null) heads.push({ num: Number(m[1]), at: m.index + m[0].length });

  heads.forEach((head, idx) => {
    const end = raw.indexOf('endobj', head.at);
    const body = raw.slice(head.at, end < 0 ? raw.length : end);
    objects.set(head.num, body);
    void idx;
  });

  // 对象流：/Type /ObjStm 里面的对象也要收进来，否则字体、页面字典都找不到
  Array.from(objects.entries()).forEach(([, body]) => {
    if (body.indexOf('/ObjStm') < 0) return;
    const sm = /stream\r?\n/.exec(body);
    if (!sm) return;
    const start = sm.index + sm[0].length;
    const stop = body.indexOf('endstream', start);
    const data = inflate(Buffer.from(body.slice(start, stop < 0 ? body.length : stop), 'latin1'));
    if (!data) return;

    const n = Number((/\/N\s+(\d+)/.exec(body.slice(0, sm.index)) || [])[1] || 0);
    const first = Number((/\/First\s+(\d+)/.exec(body.slice(0, sm.index)) || [])[1] || 0);
    const header = data.subarray(0, first).toString('latin1').trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i += 1) {
      const num = header[i * 2];
      const off = header[i * 2 + 1];
      const nextOff = i + 1 < n ? header[(i + 1) * 2 + 1] : data.length - first;
      if (num === undefined || off === undefined) continue;
      if (!objects.has(num)) objects.set(num, data.subarray(first + off, first + nextOff).toString('latin1'));
    }
  });

  return objects;
}

function objectStreamBytes(body) {
  const sm = /stream\r?\n/.exec(body);
  if (!sm) return null;
  const start = sm.index + sm[0].length;
  const stop = body.indexOf('endstream', start);
  if (stop < 0) return null;
  return Buffer.from(body.slice(start, stop), 'latin1');
}

/** 解析一份 ToUnicode CMap：字形编号 → 字符 */
function parseCMap(text) {
  const map = new Map();
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfchar.exec(text)) !== null) {
    const pairs = m[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || [];
    pairs.forEach((pair) => {
      const mm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(pair);
      if (mm) map.set(parseInt(mm[1], 16), hexToText(mm[2]));
    });
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text)) !== null) {
    const lines = m[1].match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g) || [];
    lines.forEach((line) => {
      const mm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/.exec(line);
      if (!mm) return;
      const lo = parseInt(mm[1], 16);
      const hi = parseInt(mm[2], 16);
      if (mm[4]) {
        const base = hexToText(mm[4]);
        const startCode = base.codePointAt(0) || 0;
        for (let c = lo; c <= hi && c - lo < 65536; c += 1) {
          map.set(c, String.fromCodePoint(startCode + (c - lo)));
        }
      } else if (mm[5]) {
        const items = mm[5].match(/<([0-9A-Fa-f]+)>/g) || [];
        items.forEach((item, i) => {
          map.set(lo + i, hexToText(item.slice(1, -1)));
        });
      }
    });
  }
  return map;
}

function hexToText(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const unit = hex.slice(i, i + 4);
    if (unit.length < 4) break;
    out += String.fromCharCode(parseInt(unit, 16));
  }
  return out;
}

/** 字体名（/F1）→ 字形表 */
function buildFontMaps(objects) {
  const maps = new Map();
  objects.forEach((body) => {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(body);
    if (!fontDict) return;
    const entries = fontDict[1].match(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g) || [];
    entries.forEach((entry) => {
      const mm = /\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/.exec(entry);
      if (!mm) return;
      const fontBody = objects.get(Number(mm[2]));
      if (!fontBody) return;
      const toUni = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontBody);
      if (!toUni) return;
      const cmapBody = objects.get(Number(toUni[1]));
      if (!cmapBody) return;
      const bytes = objectStreamBytes(cmapBody);
      if (!bytes) return;
      const data = inflate(bytes);
      if (!data) return;
      if (!maps.has(mm[1])) maps.set(mm[1], parseCMap(data.toString('latin1')));
    });
  });
  return maps;
}

const PDF_UNESCAPE = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };

function decodeString(raw, fontMap, twoByte) {
  let glyphs = [];
  // 先解 PDF 的转义
  let text = '';
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') { text += raw[i]; continue; }
    const next = raw[i + 1];
    if (PDF_UNESCAPE[next] !== undefined) { text += PDF_UNESCAPE[next]; i += 1; continue; }
    const oct = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
    if (oct) { text += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length; continue; }
    text += next;
    i += 1;
  }
  if (twoByte) {
    for (let i = 0; i + 1 < text.length; i += 2) {
      glyphs.push((text.charCodeAt(i) << 8) | text.charCodeAt(i + 1));
    }
  } else {
    glyphs = Array.from(text).map((c) => c.charCodeAt(0));
  }
  if (!fontMap) return glyphs.map((g) => (g >= 32 && g < 127 ? String.fromCharCode(g) : '·')).join('');
  return glyphs.map((g) => fontMap.get(g) || '').join('');
}

function extractText(buffer) {
  const raw = buffer.toString('latin1');
  const objects = parseObjects(raw);
  const fontMaps = buildFontMaps(objects);
  const pages = [];

  objects.forEach((body) => {
    const bytes = objectStreamBytes(body);
    if (!bytes) return;
    const data = inflate(bytes);
    if (!data) return;
    const chunk = data.toString('latin1');
    if (chunk.indexOf('BT') < 0 || !/\/[A-Za-z0-9]+\s+[\d.]+\s+Tf/.test(chunk)) return;

    let current = null;
    let twoByte = true;
    let out = '';
    const tokenRe = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>|\bTd\b|\bTD\b|\bT\*|\bTj\b|\bTJ\b|\bET\b/g;
    let m;
    while ((m = tokenRe.exec(chunk)) !== null) {
      const token = m[0];
      if (m[1]) {
        current = fontMaps.get(m[1]) || null;
        twoByte = true;
        continue;
      }
      if (m[2] !== undefined) {
        const hex = m[2].replace(/\s/g, '');
        out += decodeString(hex.replace(/(..)/g, (pair) => String.fromCharCode(parseInt(pair, 16))), current, twoByte);
        continue;
      }
      if (token[0] === '(') {
        out += decodeString(token.slice(1, -1), current, twoByte);
        continue;
      }
      if (token === 'Td' || token === 'TD' || token === 'T*') out += '\n';
      if (token === 'ET') out += '\n';
    }
    pages.push(out.replace(/\n{3,}/g, '\n\n').trim());
  });

  return { pages, fontMaps: fontMaps.size };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node scripts/pdf-text.js 某个.pdf');
    process.exit(1);
  }
  const result = extractText(fs.readFileSync(file));
  console.log('字体表 ' + result.fontMaps + ' 份 · 页面内容流 ' + result.pages.length + ' 段');
  result.pages.forEach((text, i) => {
    console.log('\n—— 第 ' + (i + 1) + ' 段（' + text.replace(/\s/g, '').length + ' 字）——');
    console.log(text.slice(0, 800));
  });
}

module.exports = { extractText };
