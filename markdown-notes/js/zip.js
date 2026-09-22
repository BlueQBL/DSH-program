/*!
 * 校样 · 零依赖 ZIP 打包（zip.js）
 *
 * 用途：把一篇笔记连同它的图片目录打成一个压缩包——
 *   ├── 我的笔记/
 *   │   ├── 我的笔记.md
 *   │   ├── 截图-1.png
 *   │   └── 流程图.png
 * 这样"图片放在以标题命名的目录里"这件事在导出后就变成了真的目录，
 * Markdown 里的相对路径（![](截图-1.png)）也就能在别的编辑器里直接用。
 *
 * 只做 store（不压缩）：图片本来就是压缩格式，Markdown 也没多大，
 * 换来的是不到 200 行、没有依赖、出错也看得懂的实现。
 * 文件名一律按 UTF-8 写并置 0x0800 标志位，中文目录名才不会变乱码。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- CRC32 */

  let CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  function crc32(bytes) {
    const table = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------------------------------------------ 小工具 */

  const encoder = new TextEncoder();

  function utf8(text) {
    return encoder.encode(String(text));
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return utf8(data);
    if (data && typeof data.byteLength === 'number') return new Uint8Array(data);
    return new Uint8Array(0);
  }

  /** JavaScript 的 Date → DOS 时间/日期（ZIP 用的是 1980 纪元的打包格式） */
  function dosDateTime(date) {
    const d = date instanceof Date ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  function sanitizePath(path) {
    return String(path || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/')
      .replace(/[\u0000-\u001f]/g, '');
  }

  /* -------------------------------------------------------------- 组装 */

  function Writer(size) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.at = 0;
  }

  Writer.prototype.u16 = function (value) {
    this.view.setUint16(this.at, value & 0xFFFF, true);
    this.at += 2;
  };

  Writer.prototype.u32 = function (value) {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
  };

  Writer.prototype.bytes = function (data) {
    this.buf.set(data, this.at);
    this.at += data.length;
  };

  /**
   * 打包。纯函数：入参是字节，出参也是字节。
   * @param {Array<{path:string, bytes:Uint8Array, date?:Date, dir?:boolean}>} files
   * @returns {Uint8Array}
   */
  function build(files) {
    const entries = [];
    const seen = new Set();

    (files || []).forEach(function (file) {
      const path = sanitizePath(file.path);
      if (!path || seen.has(path)) return;
      seen.add(path);
      const isDir = Boolean(file.dir) || path.endsWith('/');
      entries.push({
        path: isDir ? (path.endsWith('/') ? path : path + '/') : path,
        data: isDir ? new Uint8Array(0) : toBytes(file.bytes),
        dir: isDir,
        date: file.date,
      });
    });

    // 有文件的目录自动补上目录项，解压出来才是完整的树
    const dirs = new Set();
    entries.forEach(function (entry) {
      if (entry.dir) { dirs.add(entry.path); return; }
      const parts = entry.path.split('/');
      parts.pop();
      let prefix = '';
      parts.forEach(function (part) {
        prefix += part + '/';
        dirs.add(prefix);
      });
    });
    dirs.forEach(function (dir) {
      if (!seen.has(dir)) {
        seen.add(dir);
        entries.push({ path: dir, data: new Uint8Array(0), dir: true, date: undefined });
      }
    });

    // 目录项排在它里面的文件前面，解压顺序好看一点
    entries.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });

    const prepared = entries.map(function (entry) {
      const nameBytes = utf8(entry.path);
      const stamp = dosDateTime(entry.date);
      return {
        name: nameBytes,
        data: entry.data,
        crc: entry.dir ? 0 : crc32(entry.data),
        time: stamp.time,
        date: stamp.date,
        offset: 0,
        dir: entry.dir,
      };
    });

    let localSize = 0;
    let centralSize = 0;
    prepared.forEach(function (item) {
      localSize += 30 + item.name.length + item.data.length;
      centralSize += 46 + item.name.length;
    });
    const total = localSize + centralSize + 22;

    const writer = new Writer(total);
    const FLAGS = 0x0800; // 文件名是 UTF-8

    prepared.forEach(function (item) {
      item.offset = writer.at;
      writer.u32(0x04034b50);
      writer.u16(20);
      writer.u16(FLAGS);
      writer.u16(0); // store
      writer.u16(item.time);
      writer.u16(item.date);
      writer.u32(item.crc);
      writer.u32(item.data.length);
      writer.u32(item.data.length);
      writer.u16(item.name.length);
      writer.u16(0);
      writer.bytes(item.name);
      if (!item.dir) writer.bytes(item.data);
    });

    const centralStart = writer.at;
    prepared.forEach(function (item) {
      writer.u32(0x02014b50);
      writer.u16(20);
      writer.u16(20);
      writer.u16(FLAGS);
      writer.u16(0);
      writer.u16(item.time);
      writer.u16(item.date);
      writer.u32(item.crc);
      writer.u32(item.data.length);
      writer.u32(item.data.length);
      writer.u16(item.name.length);
      writer.u16(0);
      writer.u16(0);
      writer.u16(0);
      writer.u16(0);
      writer.u32(item.dir ? 0x10 : 0); // 目录属性位
      writer.u32(item.offset);
      writer.bytes(item.name);
    });
    const centralEnd = writer.at;

    writer.u32(0x06054b50);
    writer.u16(0);
    writer.u16(0);
    writer.u16(prepared.length);
    writer.u16(prepared.length);
    writer.u32(centralEnd - centralStart);
    writer.u32(centralStart);
    writer.u16(0);

    return writer.buf;
  }

  /**
   * 浏览器里用这个：接受 Blob / 字符串 / 字节，返回 Blob。
   * @param {Array<{path:string, blob?:Blob, text?:string, bytes?:Uint8Array, date?:Date}>} files
   */
  async function pack(files) {
    const prepared = [];
    for (let i = 0; i < (files || []).length; i++) {
      const file = files[i];
      let bytes;
      if (file.bytes) bytes = toBytes(file.bytes);
      else if (file.blob) bytes = new Uint8Array(await file.blob.arrayBuffer());
      else if (typeof file.text === 'string') bytes = utf8(file.text);
      else bytes = new Uint8Array(0);
      prepared.push({ path: file.path, bytes: bytes, date: file.date, dir: file.dir });
    }
    const out = build(prepared);
    return new Blob([out], { type: 'application/zip' });
  }

  return {
    crc32: crc32,
    utf8: utf8,
    sanitizePath: sanitizePath,
    build: build,
    pack: pack,
  };
});
