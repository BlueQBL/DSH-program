/*!
 * 校样 · 数据层（store.js）
 *
 * 纯逻辑 + 一个极薄的 LocalStorage 适配器：浏览器挂到 window.MDStore，Node 走 module.exports。
 * 不碰 DOM，方便在 Node 里直接跑测试。
 *
 * 存储分两个键：笔记数据（可导出/导入）与界面偏好（宽度、窗格），互不干扰。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY_NOTES = 'markdown-notes/v1';
  const KEY_UI = 'markdown-notes/ui/v1';
  const SCHEMA_VERSION = 1;
  const APP_TAG = 'markdown-notes';

  const MAX_TITLE = 120;
  const MAX_BODY = 200000;
  const MAX_NOTES = 800;
  const SNIPPET_PAD = 34; // 搜索摘要左右各留多少字

  const SORTS = [
    { value: 'updated', label: '最近修改' },
    { value: 'created', label: '创建时间' },
    { value: 'title', label: '标题' },
  ];

  /* ------------------------------------------------------------ 小工具 */

  function nowMs() {
    return Date.now();
  }

  function uid() {
    return 'n' + nowMs().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clampText(value, max) {
    const text = value == null ? '' : String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  /** UTF-8 字节数，用于如实告诉用户占了多少 LocalStorage */
  function byteSize(text) {
    const s = String(text == null ? '' : text);
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1; }
      else bytes += 3;
    }
    return bytes;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 相对时间：列表里"3 分钟前"比时间戳好读，隔天再退回日期 */
  function relativeTime(ts, now) {
    const base = typeof now === 'number' ? now : nowMs();
    const diff = base - ts;
    if (!ts || diff < 0 || diff < 60000) return '刚刚';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + ' 分钟前';
    const hours = Math.floor(minutes / 60);
    if (hours < 24 && startOfDay(base) - startOfDay(ts) < 86400000) return hours + ' 小时前';
    const days = Math.round((startOfDay(base) - startOfDay(ts)) / 86400000);
    const d = new Date(ts);
    if (days === 1) return '昨天 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    const sameYear = new Date(base).getFullYear() === d.getFullYear();
    const md = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return sameYear ? md : d.getFullYear() + ' 年 ' + md;
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ------------------------------------------------------------ 数据规整 */

  function normalizeNote(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const created = Number(src.createdAt);
    const updated = Number(src.updatedAt);
    const body = clampText(src.body, MAX_BODY);
    return {
      id: typeof src.id === 'string' && src.id ? src.id : uid(),
      title: clampText(src.title, MAX_TITLE),
      body: body,
      createdAt: Number.isFinite(created) && created > 0 ? created : nowMs(),
      updatedAt: Number.isFinite(updated) && updated > 0 ? updated : nowMs(),
    };
  }

  function normalizeState(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const list = Array.isArray(src.notes) ? src.notes : [];
    const seen = new Set();
    const notes = [];
    list.slice(0, MAX_NOTES).forEach(function (item) {
      const note = normalizeNote(item);
      if (seen.has(note.id)) note.id = uid();
      seen.add(note.id);
      notes.push(note);
    });
    let activeId = typeof src.activeId === 'string' ? src.activeId : '';
    if (!notes.some(function (n) { return n.id === activeId; })) {
      activeId = notes.length ? sortNotes(notes, 'updated')[0].id : '';
    }
    return { v: SCHEMA_VERSION, notes: notes, activeId: activeId };
  }

  /* -------------------------------------------------------------- 增删改 */

  function createNote(patch) {
    const src = patch && typeof patch === 'object' ? patch : {};
    const ts = nowMs();
    return normalizeNote({
      id: src.id || uid(),
      title: src.title || '',
      body: src.body || '',
      createdAt: ts,
      updatedAt: ts,
    });
  }

  function findNote(state, id) {
    return state.notes.find(function (n) { return n.id === id; }) || null;
  }

  /** 返回 { note, changed }：内容没变就不改 updatedAt，避免"打字就置顶"的抖动 */
  function updateNote(state, id, patch) {
    const note = findNote(state, id);
    if (!note) return { note: null, changed: false };
    const title = patch && patch.title !== undefined ? clampText(patch.title, MAX_TITLE) : note.title;
    const body = patch && patch.body !== undefined ? clampText(patch.body, MAX_BODY) : note.body;
    if (title === note.title && body === note.body) return { note: note, changed: false };
    note.title = title;
    note.body = body;
    note.updatedAt = nowMs();
    return { note: note, changed: true };
  }

  function addNote(state, note) {
    const item = normalizeNote(note);
    state.notes.unshift(item);
    if (state.notes.length > MAX_NOTES) state.notes.length = MAX_NOTES;
    return item;
  }

  /** 删除时连位置一起返回，撤销才能放回原来的排序位置 */
  function deleteNote(state, id) {
    const index = state.notes.findIndex(function (n) { return n.id === id; });
    if (index < 0) return null;
    const removed = state.notes.splice(index, 1)[0];
    if (state.activeId === id) {
      const next = sortNotes(state.notes, 'updated')[0];
      state.activeId = next ? next.id : '';
    }
    return { note: removed, index: index };
  }

  /** 撤销删除：按原索引插回，保持它原来的时间戳 */
  function insertNote(state, note, index) {
    const item = normalizeNote(note);
    const at = Math.max(0, Math.min(typeof index === 'number' ? index : 0, state.notes.length));
    state.notes.splice(at, 0, item);
    return item;
  }

  /* ---------------------------------------------------------------- 排序 */

  function sortNotes(notes, mode) {
    const list = notes.slice();
    if (mode === 'title') {
      // 中文按拼音排：Intl.Collator 拿不到就退回 localeCompare
      let collator = null;
      try {
        collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
      } catch { collator = null; }
      list.sort(function (a, b) {
        const at = a.title.trim() || '未命名笔记';
        const bt = b.title.trim() || '未命名笔记';
        const r = collator ? collator.compare(at, bt) : at.localeCompare(bt);
        return r !== 0 ? r : b.updatedAt - a.updatedAt;
      });
      return list;
    }
    if (mode === 'created') {
      list.sort(function (a, b) { return b.createdAt - a.createdAt; });
      return list;
    }
    list.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    return list;
  }

  /* ---------------------------------------------------------------- 搜索 */

  function termList(query) {
    return String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function countOccurrences(haystack, needle) {
    let count = 0;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      count += 1;
      at = haystack.indexOf(needle, at + needle.length);
    }
    return count;
  }

  /** 摘要：把第一个命中的关键词放在中间，返回纯文本 + 需要打标记的区间 */
  function buildSnippet(text, terms) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return { text: '', ranges: [] };
    const lower = flat.toLowerCase();
    let hit = -1;
    let hitTerm = '';
    terms.forEach(function (term) {
      const at = lower.indexOf(term);
      if (at >= 0 && (hit < 0 || at < hit)) { hit = at; hitTerm = term; }
    });
    if (hit < 0) {
      return { text: flat.slice(0, SNIPPET_PAD * 2) + (flat.length > SNIPPET_PAD * 2 ? '…' : ''), ranges: [] };
    }
    const start = Math.max(0, hit - SNIPPET_PAD);
    const end = Math.min(flat.length, hit + hitTerm.length + SNIPPET_PAD);
    let snippet = flat.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < flat.length) snippet = snippet + '…';

    // 在摘要里把所有词都标出来
    const ranges = [];
    const snippetLower = snippet.toLowerCase();
    terms.forEach(function (term) {
      if (!term) return;
      let at = snippetLower.indexOf(term);
      while (at >= 0) {
        ranges.push([at, at + term.length]);
        at = snippetLower.indexOf(term, at + term.length);
      }
    });
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    const merged = [];
    ranges.forEach(function (r) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    return { text: snippet, ranges: merged };
  }

  /**
   * 搜索：空格分隔的多个词按"都要命中"处理（AND）。
   * 排序按得分：标题命中权重远高于正文，正文里出现次数多的排前面。
   */
  function searchNotes(notes, query) {
    const terms = termList(query);
    const list = Array.isArray(notes) ? notes : [];
    if (!terms.length) return [];

    const hits = [];
    list.forEach(function (note) {
      const title = (note.title || '').toLowerCase();
      const body = (note.body || '').toLowerCase();
      let score = 0;
      let matchedAll = true;

      terms.forEach(function (term) {
        const inTitle = countOccurrences(title, term);
        const inBody = countOccurrences(body, term);
        if (!inTitle && !inBody) { matchedAll = false; return; }
        score += inTitle * 12 + Math.min(inBody, 8) * 2;
      });
      if (!matchedAll) return;

      // 标题整体前缀命中再加一点分
      if (title.indexOf(terms[0]) === 0) score += 6;
      score += Math.min(note.updatedAt / 1e13, 1); // 时间只做极小的破平局因子

      hits.push({
        id: note.id,
        note: note,
        score: score,
        snippet: buildSnippet(note.body, terms),
        titleRanges: (function () {
          const ranges = [];
          const lower = title;
          terms.forEach(function (term) {
            let at = lower.indexOf(term);
            while (at >= 0) {
              ranges.push([at, at + term.length]);
              at = lower.indexOf(term, at + term.length);
            }
          });
          return ranges.sort(function (a, b) { return a[0] - b[0]; });
        })(),
      });
    });

    hits.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.note.updatedAt - a.note.updatedAt;
    });
    return hits;
  }

  /* ---------------------------------------------------------- 导出 / 导入 */

  function slugify(title) {
    const base = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
    return (base || '未命名笔记').slice(0, 60);
  }

  /**
   * 正文第一个块就是一级标题吗？
   *
   * 这是"标题字段"和"印张上那一行标题"之间唯一的判据，两处都用它：
   * · 印张要不要在正文前面排出标题字段的字；
   * · 导出 .md 时要不要把标题补成 `# ...`。
   * 判据一致，才能保证"印张上看到的第一行标题"和"导出文件里的第一个 H1"永远是同一个。
   *
   * 只认一个井号（`## 小标题` 不算），因为只有一级标题才是文档标题；
   * 井号后不要求空格（照顾中文写法），但必须跟了字。
   */
  function bodyStartsWithH1(body) {
    const first = String(body == null ? '' : body).replace(/^\s+/, '').split('\n')[0];
    return /^#(?!#)[ \t]*\S/.test(first);
  }

  function toMarkdown(note) {
    const title = (note.title || '').trim() || '未命名笔记';
    const body = note.body || '';
    const head = bodyStartsWithH1(body) ? '' : '# ' + title + '\n\n';
    return head + body.replace(/\s+$/, '') + '\n';
  }

  function toBackup(state) {
    return {
      app: APP_TAG,
      v: SCHEMA_VERSION,
      exportedAt: new Date(nowMs()).toISOString(),
      notes: state.notes.map(function (n) {
        return { id: n.id, title: n.title, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt };
      }),
      activeId: state.activeId,
    };
  }

  /**
   * 导入解析：认自己的备份格式，也认"一堆笔记对象"的裸数组。
   * 返回 { notes, skipped, source }，坏数据不抛错，只计数。
   */
  function parseBackup(text) {
    let data;
    try {
      data = JSON.parse(String(text || ''));
    } catch {
      throw new Error('不是合法的 JSON 文件');
    }
    let list = null;
    let source = 'backup';
    if (Array.isArray(data)) {
      list = data;
      source = 'array';
    } else if (data && typeof data === 'object' && Array.isArray(data.notes)) {
      list = data.notes;
      source = data.app === APP_TAG ? 'backup' : 'foreign';
    }
    if (!list) throw new Error('没找到 notes 数组');

    const notes = [];
    let skipped = 0;
    list.forEach(function (item) {
      if (!item || typeof item !== 'object' || (item.title === undefined && item.body === undefined)) {
        skipped += 1;
        return;
      }
      notes.push(normalizeNote(item));
    });
    return { notes: notes, skipped: skipped, source: source };
  }

  /* ------------------------------------------------------ LocalStorage 适配 */

  /**
   * 存储适配器：LocalStorage 不可用（隐私模式 / 被禁用）时退回内存，
   * 界面据此提示"这次改动不会保存"，而不是假装保存成功。
   */
  function createStorage(backing) {
    let memory = new Map();
    let available = false;
    let reason = '';

    if (backing === undefined) {
      try {
        backing = typeof localStorage !== 'undefined' ? localStorage : null;
      } catch {
        backing = null;
      }
    }

    if (backing) {
      try {
        const probe = '__md_notes_probe__';
        backing.setItem(probe, '1');
        backing.removeItem(probe);
        available = true;
      } catch (err) {
        available = false;
        reason = err && err.name === 'QuotaExceededError' ? '配额已满' : '浏览器不允许写入本地存储';
      }
    } else {
      reason = '这个环境没有 LocalStorage';
    }

    function read(key) {
      // 内存里的是"没落盘成功"的那份，优先级高于 backing，否则用户会看到内容凭空回退
      if (memory.has(key)) return memory.get(key);
      try {
        if (!available) return null;
        const raw = backing.getItem(key);
        return raw == null ? null : raw;
      } catch {
        return null;
      }
    }

    function write(key, value) {
      if (!available) {
        memory.set(key, value);
        return { ok: true, persisted: false };
      }
      try {
        backing.setItem(key, value);
        return { ok: true, persisted: true };
      } catch (err) {
        // 配额爆了就退回内存，保证这次会话不丢内容，同时如实上报
        memory.set(key, value);
        reason = err && err.name === 'QuotaExceededError' ? '本地存储配额已满' : '写入本地存储失败';
        return { ok: false, persisted: false, error: reason };
      }
    }

    return {
      get available() { return available; },
      get reason() { return reason; },
      read: read,
      write: write,
      remove: function (key) {
        try {
          if (available) backing.removeItem(key);
        } catch { /* 删不掉也不影响后续 */ }
        memory.delete(key);
      },
    };
  }

  function loadState(storage) {
    const store = storage || createStorage();
    const raw = store.read(KEY_NOTES);
    if (!raw) return normalizeState({ notes: seedNotes() });
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      return normalizeState({ notes: seedNotes() });
    }
  }

  function saveState(state, storage) {
    const store = storage || createStorage();
    const payload = JSON.stringify({
      v: SCHEMA_VERSION,
      notes: state.notes,
      activeId: state.activeId,
    });
    const result = store.write(KEY_NOTES, payload);
    return {
      ok: result.ok,
      persisted: result.persisted,
      bytes: byteSize(payload),
      error: result.error || '',
    };
  }

  const DEFAULT_UI = { rail: 280, seam: 0.5, pane: 'write', sort: 'updated', follow: true };

  function loadUI(storage) {
    const store = storage || createStorage();
    try {
      const raw = store.read(KEY_UI);
      const data = raw ? JSON.parse(raw) : {};
      return {
        rail: Number.isFinite(data.rail) ? Math.max(220, Math.min(420, data.rail)) : DEFAULT_UI.rail,
        seam: Number.isFinite(data.seam) ? Math.max(0.22, Math.min(0.78, data.seam)) : DEFAULT_UI.seam,
        pane: ['notes', 'write', 'read'].indexOf(data.pane) >= 0 ? data.pane : DEFAULT_UI.pane,
        sort: SORTS.some(function (s) { return s.value === data.sort; }) ? data.sort : DEFAULT_UI.sort,
        follow: data.follow !== false,
      };
    } catch {
      return Object.assign({}, DEFAULT_UI);
    }
  }

  function saveUI(ui, storage) {
    const store = storage || createStorage();
    store.write(KEY_UI, JSON.stringify(ui || DEFAULT_UI));
  }

  /* ------------------------------------------------------------ 开场笔记 */

  /**
   * 首次打开时的两篇笔记：一篇讲清楚这张"校样"怎么用，一篇是随手可查的速查表。
   * 用户删掉之后不再自动补回（只有笔记为空、且从未存过任何数据时才播种）。
   */
  function seedNotes() {
    const ts = nowMs();
    return [
      {
        id: 'seed-welcome',
        title: '欢迎，这是一张校样',
        createdAt: ts - 120000,
        updatedAt: ts - 1000,
        body: [
          '左边是**稿纸**，右边是**印张**：你敲下的每一行，右边立刻按版面排好。',
          '',
          '标题框里的字就是这篇的标题，它会排成印张最上面那一行——',
          '所以正文里不必再写一遍；万一写了（开头就是 `# 标题`），印张也不会重复排两次。',
          '',
          '## 它认得这些',
          '',
          '- 标题、*强调*、~~删除线~~、`行内代码`',
          '- [链接](https://commonmark.org)、图片、`---` 分隔线',
          '- 表格、引用、有序 / 无序列表、任务清单',
          '',
          '## 三个值得试一下的地方',
          '',
          '- [x] 在左边打字，看右边怎么排',
          '- [ ] 点这个复选框——它会真的改回左边的原文',
          '- [ ] 在右边的印张里点任意段落，光标会跳回左边的对应行',
          '',
          '> 右页左边那道竖线边上会出现一枚红色记号，',
          '> 它标的就是光标所在的那一块。',
          '',
          '## 代码块带语法高亮',
          '',
          '```js',
          '// 全部数据都在 LocalStorage 里，没有后端',
          'const notes = load();',
          'notes.sort((a, b) => b.updatedAt - a.updatedAt);',
          '```',
          '',
          '```bash',
          'npm start        # 起本地静态服务',
          'npm test         # 跑解析层测试',
          '```',
          '',
          '写完不用保存：停手 0.4 秒自动落盘，左下角会显示"已保存"。',
        ].join('\n'),
      },
      {
        id: 'seed-cheatsheet',
        title: 'Markdown 速查',
        createdAt: ts - 90000,
        updatedAt: ts - 60000,
        body: [
          '# Markdown 速查',
          '',
          '| 语法 | 写法 | 说明 |',
          '| --- | --- | --- |',
          '| 标题 | `## 二级` | 一至六级 |',
          '| 加粗 | `**粗**` | 星号或下划线 |',
          '| 斜体 | `*斜*` | 同上 |',
          '| 行内代码 | `` `code` `` | 反引号 |',
          '| 链接 | `[文字](网址)` | 也可直接粘网址 |',
          '| 列表 | `- 项` / `1. 项` | 缩进两格即嵌套 |',
          '| 引用 | `> 引用` | 可嵌套 |',
          '| 分隔线 | `---` | 三个以上 |',
          '',
          '## 常用代码块标注',
          '',
          '```diff',
          '- 旧的写法',
          '+ 新的写法',
          '```',
          '',
          '```python',
          'def hello(name: str) -> str:',
          '    """打声招呼"""',
          '    return f"你好，{name}"',
          '```',
          '',
          '## 文件里存了什么',
          '',
          '1. 笔记正文（Markdown 原文，不经任何加工）',
          '2. 标题、创建时间、最后修改时间',
          '3. 界面偏好：侧栏宽度、左右分栏比例、排序方式',
          '',
          '右上角可以导出成 `.md` 文件，或在侧栏底部整包备份成 JSON。',
        ].join('\n'),
      },
    ];
  }

  function emptyState() {
    return { v: SCHEMA_VERSION, notes: [], activeId: '' };
  }

  return {
    KEY_NOTES: KEY_NOTES,
    KEY_UI: KEY_UI,
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_TITLE: MAX_TITLE,
    MAX_BODY: MAX_BODY,
    MAX_NOTES: MAX_NOTES,
    SORTS: SORTS,
    DEFAULT_UI: DEFAULT_UI,

    uid: uid,
    clampText: clampText,
    byteSize: byteSize,
    formatBytes: formatBytes,
    relativeTime: relativeTime,
    formatDate: formatDate,
    slugify: slugify,

    normalizeNote: normalizeNote,
    normalizeState: normalizeState,
    emptyState: emptyState,
    seedNotes: seedNotes,

    createNote: createNote,
    findNote: findNote,
    updateNote: updateNote,
    addNote: addNote,
    deleteNote: deleteNote,
    insertNote: insertNote,

    sortNotes: sortNotes,
    termList: termList,
    buildSnippet: buildSnippet,
    searchNotes: searchNotes,

    toMarkdown: toMarkdown,
    bodyStartsWithH1: bodyStartsWithH1,
    toBackup: toBackup,
    parseBackup: parseBackup,

    createStorage: createStorage,
    loadState: loadState,
    saveState: saveState,
    loadUI: loadUI,
    saveUI: saveUI,
  };
});
