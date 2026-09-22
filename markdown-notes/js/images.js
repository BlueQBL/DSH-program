/*!
 * 校样 · 图片仓库（images.js）
 *
 * 图片来源是浏览器的文件选择 / 粘贴 / 拖放，所以没法真的往磁盘上建目录。
 * 这里的做法是：**每篇笔记一个虚拟目录，目录名就是笔记标题**，
 * 图片以 blob 形式存在 IndexedDB 里，Markdown 里只写相对文件名：
 *
 *     ![截图](截图-1.png)          ← 源码里就长这样，跟普通 Markdown 没区别
 *
 * 于是：
 *   · 界面里按笔记分目录管理（侧栏"图片"页签就是这篇的目录）；
 *   · 导出 ZIP 时目录名落成真目录，相对路径在别的编辑器里直接能看；
 *   · 笔记改标题，目录名跟着变——因为目录名是"算出来的"，不是存下来的。
 *
 * 存储层与业务层分开：backend 可注入，Node 里用内存 backend 就能把逻辑测完，
 * 真正的 IndexedDB 由浏览器探针验证。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DB_NAME = 'markdown-notes';
  const DB_VERSION = 1;
  const STORE = 'images';
  const MAX_NAME = 120;
  const FALLBACK_TITLE = '未命名笔记';

  /* ------------------------------------------------------------ 纯函数层 */

  const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
  };

  /** 文件类型 → 扩展名；认不出来就看原文件名 */
  function extOf(type, name) {
    if (type && IMAGE_EXT[type]) return IMAGE_EXT[type];
    const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
    return m ? m[1].toLowerCase() : 'png';
  }

  function baseOf(name) {
    return String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  }

  /**
   * 文件名清洗：去掉目录部分、去掉会惹麻烦的字符（路径分隔符、控制字符、
   * 冒号星号问号引号尖括号竖线——这些在导出成真文件时会出问题）。
   */
  function sanitizeName(name, type) {
    const raw = String(name || '').split(/[\\/]/).pop() || '';
    const ext = extOf(type, raw);
    let base = baseOf(raw)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[:*?"<>|\\/]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '')
      .trim();
    if (!base) base = '图片';
    const keep = MAX_NAME - ext.length - 1;
    if (base.length > keep) base = base.slice(0, Math.max(1, keep));
    return base + '.' + ext;
  }

  /** 同名就加序号：截图.png → 截图-2.png → 截图-3.png */
  function uniqueName(name, taken) {
    const used = taken instanceof Set ? taken : new Set(taken || []);
    const clean = String(name || '');
    if (!used.has(clean)) return clean;
    const ext = extOf('', clean);
    const base = baseOf(clean) || '图片';
    for (let n = 2; n < 10000; n += 1) {
      const candidate = base + '-' + n + '.' + ext;
      if (!used.has(candidate)) return candidate;
    }
    return base + '-' + Date.now() + '.' + ext;
  }

  /** 剪贴板里的图往往没有名字，按时间给一个能认出来的 */
  function guessName(type, date) {
    const d = date instanceof Date ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return '粘贴图片-' + stamp + '.' + extOf(type);
  }

  /** 目录名 = 笔记标题（清洗掉文件系统不认的字符） */
  function folderName(title) {
    const base = String(title == null ? '' : title)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.\s]+$/, '');
    const name = base || FALLBACK_TITLE;
    return name.length > 60 ? name.slice(0, 60).trim() : name;
  }

  /**
   * 给一批笔记算目录名：同名（或清洗后同名）的往后排 标题 (2)、标题 (3)……
   * 只在导出时需要——平时目录名是现算的，不落盘。
   */
  function folderNames(notes) {
    const used = new Set();
    const map = new Map();
    (notes || []).forEach(function (note) {
      let name = folderName(note && note.title);
      if (used.has(name)) {
        const base = name;
        let n = 2;
        while (used.has(base + ' (' + n + ')')) n += 1;
        name = base + ' (' + n + ')';
      }
      used.add(name);
      if (note && note.id) map.set(note.id, name);
    });
    return map;
  }

  /** Markdown 里写的路径：只写文件名，空格转义成 %20（不然链接语法会被空格截断） */
  function srcFor(name) {
    return String(name || '').replace(/ /g, '%20');
  }

  /** 反过来：把 Markdown 里的路径还原成文件名（去掉 ./ 与目录前缀） */
  function nameFromSrc(src) {
    let s = String(src || '').trim().replace(/^\.\//, '');
    s = s.split('/').pop() || s;
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 解不开就用原样，后面按名字匹配自然会失败并提示 */
    }
    return s;
  }

  /** 图片在 Markdown 里的写法 */
  function markdownFor(name, alt) {
    const text = String(alt == null ? '' : alt).replace(/[\[\]]/g, '');
    return '![' + text + '](' + srcFor(name) + ')';
  }

  /**
   * 导出时把正文里的图片路径补上目录前缀。
   *
   * 正文里写的是**文件名**（`![](图.png)`）——这样改标题不会把引用写坏；
   * 但导出的目录结构是"文档在外、图片在以标题命名的目录里"：
   *
   *     我的笔记.md
   *     我的笔记/图.png
   *
   * 所以导出那一刻要把路径补成 `我的笔记/图.png`，解压后在别的编辑器里才点得开。
   * 只改"确实属于这篇笔记"的图；外链、找不到的图原样留着。
   *
   * @param {string} body Markdown 原文
   * @param {string} folder 目录名（一般就是笔记标题）
   * @param {function(string):boolean} hasImage 判断这张图是不是这篇笔记的
   */
  function rewritePaths(body, folder, hasImage) {
    const dir = String(folder || '').replace(/\/+$/, '');
    if (!dir) return String(body || '');
    return String(body || '').replace(
      /(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
      function (all, head, src, tail) {
        if (/^(?:[a-z][\w+.-]*:)?\/\//i.test(src) || /^data:/i.test(src)) return all;
        const name = nameFromSrc(src);
        if (!name || (hasImage && !hasImage(name))) return all;
        return head + srcFor(dir + '/' + name) + tail;
      }
    );
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* -------------------------------------------------------------- backend */

  /** 内存 backend：没有 IndexedDB（隐私模式、file:// 某些情况）时的退路 */
  function memoryBackend() {
    const map = new Map();
    return {
      persisted: false,
      put(record) { map.set(record.key, record); return Promise.resolve(record.key); },
      get(key) { return Promise.resolve(map.get(key) || null); },
      list(noteId) {
        const out = [];
        map.forEach((rec) => { if (rec.noteId === noteId) out.push(rec); });
        return Promise.resolve(out);
      },
      remove(key) { map.delete(key); return Promise.resolve(true); },
      all() { return Promise.resolve(Array.from(map.values())); },
      clear() { map.clear(); return Promise.resolve(true); },
    };
  }

  function wrapRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 操作失败')); };
    });
  }

  /** IndexedDB backend：图片以 Blob 存，容量上限按浏览器配额走 */
  function indexedDbBackend(db) {
    const store = (mode) => db.transaction([STORE], mode).objectStore(STORE);
    return {
      persisted: true,
      put(record) { return wrapRequest(store('readwrite').put(record)); },
      get(key) { return wrapRequest(store('readonly').get(key)); },
      list(noteId) { return wrapRequest(store('readonly').index('noteId').getAll(noteId)); },
      remove(key) { return wrapRequest(store('readwrite').delete(key)); },
      all() { return wrapRequest(store('readonly').getAll()); },
      clear() { return wrapRequest(store('readwrite').clear()); },
    };
  }

  function openDatabase(factory, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const limit = typeof timeoutMs === 'number' ? timeoutMs : 5000;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('打开本地图片库超时'));
      }, limit);

      function done(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      let request;
      try {
        request = factory.open(DB_NAME, DB_VERSION);
      } catch (err) {
        done(reject, err);
        return;
      }
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('noteId', 'noteId', { unique: false });
        }
      };
      request.onsuccess = function () { done(resolve, request.result); };
      request.onerror = function () { done(reject, request.error || new Error('打不开 IndexedDB')); };
      request.onblocked = function () { done(reject, new Error('IndexedDB 被其他标签页占用')); };
    });
  }

  /* ---------------------------------------------------------------- 仓库 */

  /**
   * @param {{backend?:object, indexedDB?:object, createObjectURL?:function, revokeObjectURL?:function, now?:function}} [options]
   */
  function createStore(options) {
    const opts = options || {};
    const makeUrl = opts.createObjectURL ||
      (typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL.bind(URL) : null);
    const dropUrl = opts.revokeObjectURL ||
      (typeof URL !== 'undefined' && URL.revokeObjectURL ? URL.revokeObjectURL.bind(URL) : null);
    const now = opts.now || (() => Date.now());

    let backend = opts.backend || null;
    let readyPromise = null;
    let reason = '';

    // noteId → Map<name, {record, url}>
    const cache = new Map();

    function cacheOf(noteId) {
      if (!cache.has(noteId)) cache.set(noteId, new Map());
      return cache.get(noteId);
    }

    function makeObjectUrl(record) {
      if (!makeUrl || !record || !record.blob) return '';
      try {
        return makeUrl(record.blob);
      } catch {
        return '';
      }
    }

    function remember(record) {
      const bucket = cacheOf(record.noteId);
      const existing = bucket.get(record.name);
      if (existing && existing.url && dropUrl) {
        try { dropUrl(existing.url); } catch { /* 已经释放过就算了 */ }
      }
      const url = makeObjectUrl(record);
      bucket.set(record.name, { record: record, url: url });
      return url;
    }

    /** 打开存储；打不开就退回内存，并且如实说明（不假装存下来了） */
    function ready() {
      if (readyPromise) return readyPromise;
      readyPromise = (async function () {
        if (backend) return backend;
        const factory = opts.indexedDB !== undefined
          ? opts.indexedDB
          : (typeof indexedDB !== 'undefined' ? indexedDB : null);
        if (!factory) {
          reason = '这个环境没有 IndexedDB';
          backend = memoryBackend();
          return backend;
        }
        try {
          const db = await openDatabase(factory, opts.openTimeout);
          backend = indexedDbBackend(db);
        } catch (err) {
          reason = err && err.message ? err.message : '打不开本地图片库';
          backend = memoryBackend();
        }
        return backend;
      })();
      return readyPromise;
    }

    async function list(noteId) {
      const be = await ready();
      const records = (await be.list(noteId)) || [];
      records.sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
      records.forEach(remember);
      return records.map(function (rec) {
        const hit = cacheOf(noteId).get(rec.name);
        return Object.assign({}, rec, { url: hit ? hit.url : '' });
      });
    }

    /** 加一张图：自动清洗名字、自动去重 */
    async function add(noteId, file, options2) {
      const be = await ready();
      const o = options2 || {};
      const records = (await be.list(noteId)) || [];
      const taken = new Set(records.map((r) => r.name));
      const wanted = sanitizeName(o.name || (file && file.name) || guessName(file && file.type), file && file.type);
      const name = uniqueName(wanted, taken);
      const blob = file && file.blob ? file.blob : file;
      const record = {
        key: noteId + '/' + name,
        noteId: noteId,
        name: name,
        type: (blob && blob.type) || o.type || 'image/png',
        size: (blob && blob.size) || 0,
        addedAt: now(),
        blob: blob,
      };
      await be.put(record);
      const url = remember(record);
      return Object.assign({}, record, { url: url });
    }

    async function remove(noteId, name) {
      const be = await ready();
      const bucket = cacheOf(noteId);
      const hit = bucket.get(name);
      if (hit && hit.url && dropUrl) {
        try { dropUrl(hit.url); } catch { /* 忽略 */ }
      }
      bucket.delete(name);
      await be.remove(noteId + '/' + name);
      return true;
    }

    /** 把一篇笔记的图读进缓存并建好对象地址——渲染是同步的，得先备好 */
    async function preload(noteId) {
      if (!noteId) return [];
      const records = await list(noteId);
      return records;
    }

    /**
     * 同步解析：Markdown 里的相对路径 → 可用的图片地址。
     * 找不到返回 null，由解析层渲染成"图库里没有这张图"。
     */
    function resolve(noteId, src) {
      if (!noteId) return null;
      const bucket = cache.get(noteId);
      if (!bucket) return null;
      const name = nameFromSrc(src);
      const hit = bucket.get(name);
      if (hit && hit.url) return hit.url;
      // 名字对不上时再退一步：忽略大小写、忽略扩展名
      const lower = name.toLowerCase();
      const base = baseOf(lower);
      let found = null;
      bucket.forEach(function (value, key) {
        if (found) return;
        const keyLower = key.toLowerCase();
        if (keyLower === lower || baseOf(keyLower) === base) found = value.url || null;
      });
      return found;
    }

    /** 引用统计：这篇笔记正文里引用了某张图几次 */
    function references(body, name) {
      const text = String(body || '');
      const src = srcFor(name);
      let count = 0;
      let at = text.indexOf(src);
      while (at >= 0) {
        count += 1;
        at = text.indexOf(src, at + src.length);
      }
      return count;
    }

    async function usage() {
      const be = await ready();
      const all = (await be.all()) || [];
      let bytes = 0;
      all.forEach(function (rec) { bytes += rec.size || 0; });
      return { count: all.length, bytes: bytes, persisted: be.persisted };
    }

    /** 笔记删掉之后，它的图片就成了孤儿——启动时清一次，并如实报数 */
    async function cleanup(validNoteIds) {
      const be = await ready();
      const valid = validNoteIds instanceof Set ? validNoteIds : new Set(validNoteIds || []);
      const all = (await be.all()) || [];
      let removed = 0;
      let bytes = 0;
      for (let i = 0; i < all.length; i += 1) {
        const rec = all[i];
        if (valid.has(rec.noteId)) continue;
        removed += 1;
        bytes += rec.size || 0;
        if (rec.blob && rec.url && dropUrl) {
          try { dropUrl(rec.url); } catch { /* 忽略 */ }
        }
        await be.remove(rec.key);
      }
      return { removed: removed, bytes: bytes };
    }

    function releaseAll() {
      if (!dropUrl) return;
      cache.forEach(function (bucket) {
        bucket.forEach(function (value) {
          if (value.url) {
            try { dropUrl(value.url); } catch { /* 忽略 */ }
          }
        });
      });
      cache.clear();
    }

    return {
      ready: ready,
      get available() { return backend ? backend.persisted : false; },
      get reason() { return reason; },
      list: list,
      add: add,
      remove: remove,
      preload: preload,
      resolve: resolve,
      references: references,
      usage: usage,
      cleanup: cleanup,
      releaseAll: releaseAll,
      cacheSize: function () { return cache.size; },
    };
  }

  return {
    DB_NAME: DB_NAME,
    STORE: STORE,
    FALLBACK_TITLE: FALLBACK_TITLE,

    createStore: createStore,
    memoryBackend: memoryBackend,
    indexedDbBackend: indexedDbBackend,

    sanitizeName: sanitizeName,
    uniqueName: uniqueName,
    guessName: guessName,
    extOf: extOf,
    baseOf: baseOf,
    folderName: folderName,
    folderNames: folderNames,
    srcFor: srcFor,
    nameFromSrc: nameFromSrc,
    markdownFor: markdownFor,
    rewritePaths: rewritePaths,
    formatBytes: formatBytes,
  };
});
