'use strict';

/**
 * 打包层测试：自己写的 ZIP 生成器，自己写个读取器把它读回来验。
 * 运行：node test/zip.test.js
 */

const assert = require('assert');
const zip = require('../js/zip.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function group(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`[${name}] 抛错：${err && err.stack ? err.stack : err}`);
  }
}

const decoder = new TextDecoder();

/** 极简 ZIP 读取器：走中央目录，够验证写出来的包能不能被正常解开 */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');

  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const files = [];
  let at = centralOffset;

  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('中央目录签名不对');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    // 本地头
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('本地头签名不对');
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;
    const data = bytes.subarray(dataAt, dataAt + size);

    files.push({
      name: name,
      method: method,
      utf8Flag: Boolean(flags & 0x0800),
      crc: crc,
      size: size,
      data: data,
      text: decoder.decode(data),
      isDir: name.endsWith('/'),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ------------------------------------------------------------------ CRC32 */

group('CRC32', () => {
  const enc = new TextEncoder();
  eq(zip.crc32(enc.encode('hello')), 0x3610a686, 'hello 的 CRC32 是已知值');
  eq(zip.crc32(enc.encode('')), 0, '空数据的 CRC 是 0');
  eq(zip.crc32(enc.encode('a')), 0xE8B7BE43, 'a 的 CRC32');
  eq(zip.crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414FA339, '经典例句的 CRC32');
});

/* ------------------------------------------------------------ 打包与回读 */

group('打包结构', () => {
  const enc = new TextEncoder();
  const bytes = zip.build([
    { path: '我的笔记/我的笔记.md', bytes: enc.encode('# 标题\n\n正文') },
    { path: '我的笔记/截图.png', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
  ]);

  ok(bytes.length > 0, '产出了字节');
  eq(bytes[0], 0x50, '开头是 PK');
  eq(bytes[1], 0x4b, '开头是 PK（第二字节）');

  const files = readZip(bytes);
  const names = files.map((f) => f.name);

  ok(names.indexOf('我的笔记/') >= 0, '自动补上了目录项');
  ok(names.indexOf('我的笔记/我的笔记.md') >= 0, 'Markdown 在里面');
  ok(names.indexOf('我的笔记/截图.png') >= 0, '图片在里面');

  const md = files.find((f) => f.name.endsWith('.md'));
  eq(md.text, '# 标题\n\n正文', 'Markdown 内容一字不差');
  eq(md.method, 0, '用 store 方式（不压缩）');
  eq(md.utf8Flag, true, '置了 UTF-8 文件名标志位，中文才不会乱码');
  eq(Array.from(files.find((f) => f.name.endsWith('.png')).data), [1, 2, 3, 4, 5], '二进制内容原样');

  eq(md.crc, zip.crc32(enc.encode('# 标题\n\n正文')), 'CRC 与内容对得上');

  const dir = files.find((f) => f.name === '我的笔记/');
  eq(dir.isDir, true, '目录项以 / 结尾');
  eq(dir.size, 0, '目录项没有数据');
});

group('边界与规范', () => {
  const enc = new TextEncoder();

  eq(zip.build([]).length, 22, '空包只有 EOCD');
  eq(readZip(zip.build([])).length, 0, '空包读回来是空的');

  const nested = readZip(zip.build([{ path: 'a/b/c/d.txt', bytes: enc.encode('x') }]));
  const names = nested.map((f) => f.name);
  eq(names.indexOf('a/'), 0, '多级目录逐层补上（排序后 a/ 在最前）');
  ok(names.indexOf('a/b/') >= 0 && names.indexOf('a/b/c/') >= 0, '中间层也有目录项');

  // 重名只保留第一份，避免解压时互相覆盖
  const dup = readZip(zip.build([
    { path: 'x.txt', bytes: enc.encode('第一') },
    { path: 'x.txt', bytes: enc.encode('第二') },
  ]));
  eq(dup.length, 1, '重名去重');
  eq(dup[0].text, '第一', '保留先出现的那份');

  // 路径清洗：反斜杠、开头的斜杠、多余斜杠、控制字符
  const messy = readZip(zip.build([{ path: '\\\\目录//子//文件.txt', bytes: enc.encode('y') }]));
  ok(messy.some((f) => f.name === '目录/子/文件.txt'), '路径被规整成干净的正斜杠形式');
  eq(zip.sanitizePath('/a//b\\c'), 'a/b/c', 'sanitizePath 组合清理');
  eq(zip.sanitizePath('a\u0000b'), 'ab', '控制字符被剔除');

  // 空文件
  const empty = readZip(zip.build([{ path: '空.txt', bytes: new Uint8Array(0) }]));
  eq(empty[0].size, 0, '空文件');
  eq(empty[0].crc, 0, '空文件 CRC 是 0');

  // 中文内容 + 中文文件名
  const cn = readZip(zip.build([{ path: '笔记/说明.txt', bytes: enc.encode('中文内容，标点也要对。') }]));
  eq(cn.find((f) => f.name.endsWith('说明.txt')).text, '中文内容，标点也要对。', 'UTF-8 内容往返一致');
});

group('pack（浏览器路径）', () => {
  ok(typeof zip.pack === 'function', '导出 pack');
  ok(typeof zip.build === 'function', '导出 build');
});

/* ------------------------------------------------------------------ 汇总 */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ 打包层：${pass}/${total} 通过，${failures.length} 个失败\n`);
  failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`✓ 打包层：${pass}/${total} 全部通过`);
