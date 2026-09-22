'use strict';

/**
 * 数据层测试：store.js 不碰 DOM，配一个假 LocalStorage 就能跑全流程。
 * 运行：node test/store.test.js
 */

const assert = require('assert');
const store = require('../js/store.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(
      `${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`
    );
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function has(text, needle, label) {
  if (String(text).indexOf(needle) >= 0) pass += 1;
  else failures.push(`${label}\n    应包含 ${JSON.stringify(needle)}\n    实际 ${JSON.stringify(text)}`);
}

function throws(fn, label) {
  try {
    fn();
    failures.push(`${label}\n    期望抛错，实际没有`);
  } catch {
    pass += 1;
  }
}

function group(name, fn) {
  try {
    fn();
  } catch (err) {
    failures.push(`[${name}] 抛错：${err && err.stack ? err.stack : err}`);
  }
}

/** 可以按需"写坏"的假 LocalStorage */
function fakeBacking(options) {
  const opts = options || {};
  const map = new Map();
  let writes = 0;
  return {
    map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      writes += 1;
      if (opts.failAfter !== undefined && writes > opts.failAfter) {
        const err = new Error('quota');
        err.name = 'QuotaExceededError';
        throw err;
      }
      map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
  };
}

/* ------------------------------------------------------------------ 笔记 */

group('笔记增删改', () => {
  const note = store.createNote({ title: '标题', body: '正文' });
  ok(note.id, '新笔记有 id');
  ok(note.createdAt > 0 && note.updatedAt > 0, '新笔记有时间戳');
  eq(note.title, '标题', '标题写入');
  eq(note.body, '正文', '正文写入');

  const state = { v: 1, notes: [], activeId: '' };
  store.addNote(state, note);
  eq(state.notes.length, 1, '加入列表');
  eq(store.findNote(state, note.id).title, '标题', '按 id 查找');

  // 内容没变时不刷新 updatedAt，否则"点一下就置顶"很讨厌
  const before = note.updatedAt;
  const same = store.updateNote(state, note.id, { title: '标题', body: '正文' });
  eq(same.changed, false, '内容未变标记为未改动');
  eq(store.findNote(state, note.id).updatedAt, before, '未改动不动 updatedAt');

  const changed = store.updateNote(state, note.id, { body: '新正文' });
  eq(changed.changed, true, '内容变了标记为已改动');
  eq(store.findNote(state, note.id).body, '新正文', '正文更新');
  ok(store.findNote(state, note.id).updatedAt >= before, '更新时间前推');

  eq(store.updateNote(state, '不存在', { body: 'x' }).note, null, '改不存在的笔记返回 null');

  // 超长输入截断，避免一篇文章把界面撑爆
  const long = store.createNote({ title: 'x'.repeat(500), body: 'y'.repeat(store.MAX_BODY + 100) });
  eq(long.title.length, store.MAX_TITLE, '标题截断到上限');
  eq(long.body.length, store.MAX_BODY, '正文截断到上限');
});

group('删除与撤销', () => {
  const state = { v: 1, notes: [], activeId: '' };
  const a = store.addNote(state, store.createNote({ title: '甲' }));
  const b = store.addNote(state, store.createNote({ title: '乙' }));
  state.activeId = a.id;

  const removed = store.deleteNote(state, a.id);
  eq(removed.note.title, '甲', '返回被删的笔记');
  eq(removed.index, 1, '记下原位置');
  eq(state.notes.length, 1, '列表少一条');
  eq(state.activeId, b.id, '删掉当前笔记后自动选中下一条');

  store.insertNote(state, removed.note, removed.index);
  eq(state.notes.length, 2, '撤销后回到两条');
  eq(state.notes[removed.index].title, '甲', '按原位置插回');
  eq(state.notes[removed.index].id, a.id, '撤销保持同一个 id');
  eq(store.deleteNote(state, '不存在'), null, '删不存在的返回 null');
});

group('排序', () => {
  const old = store.createNote({ title: 'B 老' });
  old.updatedAt = 1000;
  old.createdAt = 1000;
  const fresh = store.createNote({ title: 'A 新' });
  fresh.updatedAt = 9000;
  fresh.createdAt = 2000;
  const mid = store.createNote({ title: 'C 中' });
  mid.updatedAt = 5000;
  mid.createdAt = 3000;
  const list = [old, fresh, mid];

  eq(store.sortNotes(list, 'updated').map((n) => n.title), ['A 新', 'C 中', 'B 老'], '按修改时间倒序');
  eq(store.sortNotes(list, 'created')[0].title, 'C 中', '按创建时间倒序');
  eq(store.sortNotes(list, 'title')[0].title, 'A 新', '按标题升序');
  eq(list.map((n) => n.title), ['B 老', 'A 新', 'C 中'], '排序不改原数组');
});

/* ------------------------------------------------------------------ 搜索 */

group('搜索', () => {
  const mk = (title, body, updatedAt) => store.normalizeNote({ title, body, updatedAt: updatedAt || 1 });

  const notes = [
    mk('数组去重', '用 Set 去重，[...new Set(arr)]', 3000),
    mk('CSS 居中', 'flex 居中：display: flex; align-items: center', 2000),
    mk('杂记', '今天写了一段数组越界的调试笔记，数组数组', 1000),
  ];

  const hit = store.searchNotes(notes, '数组');
  eq(hit.length, 2, '两篇提到数组');
  eq(hit[0].note.title, '数组去重', '标题命中排最前');
  eq(hit[1].note.title, '杂记', '正文出现多次的紧随其后');

  eq(store.searchNotes(notes, 'FLEX')[0].note.title, 'CSS 居中', '搜索不区分大小写');
  eq(store.searchNotes(notes, 'flex center').length, 1, '多词按 AND 处理');
  eq(store.searchNotes(notes, '数组 flex').length, 0, '多词必须都命中');
  eq(store.searchNotes(notes, '   ').length, 0, '空查询没有结果');
  eq(store.searchNotes(notes, '压根没有').length, 0, '查不到就是空数组');

  const snippet = store.searchNotes(notes, '越界')[0].snippet;
  has(snippet.text, '越界', '摘要包含关键词');
  eq(snippet.ranges.length, 1, '摘要标记一处');
  eq(snippet.text.slice(snippet.ranges[0][0], snippet.ranges[0][1]), '越界', '标记区间落在关键词上');

  const many = store.searchNotes(notes, '数组 调试')[0].snippet;
  ok(many.ranges.length >= 2, '多个关键词都标记');
  const marked = many.ranges.map(([s, e]) => many.text.slice(s, e));
  ok(marked.indexOf('调试') >= 0, '调试被标出');
  ok(marked.every((m) => /^(?:数组|调试)+$/.test(m)), '标记区间只覆盖关键词（相邻命中会合并）');
  ok(many.ranges[0][0] < many.ranges[1][0], '标记按位置排序');

  const longBody = '前'.repeat(200) + '目标' + '后'.repeat(200);
  const longHit = store.searchNotes([mk('长文', longBody)], '目标')[0].snippet;
  ok(longHit.text.length < 120, '摘要截断得很短');
  has(longHit.text, '…', '截断处有省略号');
  has(longHit.text, '目标', '截断后关键词仍在');
});

/* ------------------------------------------------------ 存储与容错 */

group('LocalStorage 适配', () => {
  const backing = fakeBacking();
  const s = store.createStorage(backing);
  ok(s.available, '正常环境判定为可用');
  const w = s.write('k', 'v');
  eq(w.persisted, true, '写入落盘');
  eq(s.read('k'), 'v', '读回');
  s.remove('k');
  eq(s.read('k'), null, '删除后读不到');
});

group('没有 LocalStorage 时退回内存', () => {
  const s = store.createStorage(null);
  eq(s.available, false, '判定为不可用');
  ok(s.reason, '给出原因');
  const w = s.write('k', 'v');
  eq(w.persisted, false, '如实上报"没落盘"');
  eq(s.read('k'), 'v', '内存里还能读到，会话不丢内容');
});

group('配额爆掉的容错', () => {
  // 探测（第 1 次写）成功、removeItem 正常，写数据时（第 2 次写）抛 QuotaExceededError
  const backing = fakeBacking({ failAfter: 1 });
  const s = store.createStorage(backing);
  ok(s.available, '探测通过');
  const w = s.write('k', 'v');
  eq(w.ok, false, '写入失败要报错，不能装作成功');
  eq(w.persisted, false, '明确未落盘');
  has(s.reason, '配额', '原因里说清是配额问题');
  eq(s.read('k'), 'v', '内容退回内存，本次会话不丢');
});

group('状态存取与坏数据兜底', () => {
  const backing = fakeBacking();
  const s = store.createStorage(backing);

  const fresh = store.loadState(s);
  eq(fresh.notes.length, 2, '首次打开播种两篇笔记');
  ok(store.findNote(fresh, fresh.activeId), '默认选中一篇存在的笔记');

  const state = { v: 1, notes: [store.createNote({ title: '甲' })], activeId: '' };
  state.activeId = state.notes[0].id;
  const saved = store.saveState(state, s);
  eq(saved.persisted, true, '保存成功');
  ok(saved.bytes > 0, '回报占用字节数');

  const reloaded = store.loadState(s);
  eq(reloaded.notes[0].title, '甲', '读回内容一致');
  eq(reloaded.activeId, state.activeId, '读回选中项');

  // 空列表不能被当成"没数据"而重新播种
  backing.setItem(store.KEY_NOTES, JSON.stringify({ v: 1, notes: [], activeId: '' }));
  eq(store.loadState(s).notes.length, 0, '用户清空后不再自动播种');

  backing.setItem(store.KEY_NOTES, '{坏掉的 JSON');
  eq(store.loadState(s).notes.length, 2, '坏数据退回播种状态而不是崩溃');
});

group('状态规整', () => {
  const state = store.normalizeState({
    notes: [
      { id: 'a', title: '甲', body: 'x', createdAt: 5, updatedAt: 6 },
      { id: 'a', title: '重复 id', body: 'y', createdAt: 5, updatedAt: 7 },
      'nonsense',
      null,
    ],
    activeId: '不存在',
  });
  eq(state.notes.length, 4, '坏条目也规整成合法笔记');
  eq(new Set(state.notes.map((n) => n.id)).size, 4, '重复 id 被改掉');
  ok(state.notes.some((n) => n.id === state.activeId), '失效的选中项自动落到某篇上');

  const empty = store.normalizeState(null);
  eq(empty.notes.length, 0, 'null 规整成空状态');
  eq(empty.activeId, '', '空状态没有选中项');
});

group('界面偏好', () => {
  const backing = fakeBacking();
  const s = store.createStorage(backing);
  eq(store.loadUI(s).seam, 0.5, '默认分栏比例');
  eq(store.loadUI(s).follow, true, '默认跟随光标');
  store.saveUI({ rail: 320, seam: 0.62, pane: 'read', sort: 'title', follow: false }, s);
  const ui = store.loadUI(s);
  eq(ui.rail, 320, '侧栏宽度保留');
  eq(ui.seam, 0.62, '分栏比例保留');
  eq(ui.pane, 'read', '窗格保留');
  eq(ui.sort, 'title', '排序方式保留');
  eq(ui.follow, false, '跟随光标开关保留');

  backing.setItem(store.KEY_UI, JSON.stringify({ rail: 99999, seam: -3, pane: '乱写', sort: '乱写' }));
  const clamped = store.loadUI(s);
  eq(clamped.rail, 420, '越界宽度被夹住');
  eq(clamped.seam, 0.22, '越界比例被夹到下界');
  eq(clamped.pane, store.DEFAULT_UI.pane, '非法窗格回到默认');
  eq(clamped.sort, store.DEFAULT_UI.sort, '非法排序回到默认');
});

/* -------------------------------------------------------- 导出 / 导入 */

group('导出 Markdown', () => {
  const withH1 = store.normalizeNote({ title: '标题', body: '# 标题\n\n正文' });
  eq(store.toMarkdown(withH1), '# 标题\n\n正文\n', '正文自带标题时不重复加');

  const noH1 = store.normalizeNote({ title: '标题', body: '正文' });
  eq(store.toMarkdown(noH1), '# 标题\n\n正文\n', '正文没有标题时补上');

  const untitled = store.normalizeNote({ title: '  ', body: '正文' });
  eq(store.toMarkdown(untitled), '# 未命名笔记\n\n正文\n', '无标题时用兜底标题');

  eq(store.slugify('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i', '文件名里的非法字符被替换');
  eq(store.slugify('   '), '未命名笔记', '空标题兜底');
});

group('备份往返', () => {
  const state = { v: 1, notes: [], activeId: '' };
  const a = store.addNote(state, store.createNote({ title: '甲', body: '正文甲' }));
  store.addNote(state, store.createNote({ title: '乙', body: '正文乙' }));
  state.activeId = a.id;

  const backup = store.toBackup(state);
  eq(backup.app, 'markdown-notes', '备份带应用标记');
  eq(backup.notes.length, 2, '备份含全部笔记');

  const text = JSON.stringify(backup);
  const parsed = store.parseBackup(text);
  eq(parsed.notes.length, 2, '解析回两条');
  eq(parsed.notes.map((n) => n.title).sort(), ['乙', '甲'], '标题集合一致');
  eq(parsed.notes.map((n) => n.body).sort(), ['正文乙', '正文甲'], '正文集合一致');
  eq(parsed.source, 'backup', '认得出是自己的备份');
  eq(parsed.skipped, 0, '没有跳过任何条目');

  const arrayForm = store.parseBackup(JSON.stringify([{ title: '丙', body: 'x' }]));
  eq(arrayForm.notes.length, 1, '裸数组也认');
  eq(arrayForm.source, 'array', '标记来源为裸数组');

  const foreign = store.parseBackup(JSON.stringify({ notes: [{ title: '丁' }], app: 'other-app' }));
  eq(foreign.source, 'foreign', '别的应用导出的也认，但标记为外来');

  const messy = store.parseBackup(JSON.stringify({ notes: [{ title: '甲' }, 'x', null, { nothing: 1 }] }));
  eq(messy.notes.length, 1, '坏条目被跳过');
  eq(messy.skipped, 3, '跳过的条数如实回报');

  throws(() => store.parseBackup('不是 JSON'), '非 JSON 抛错');
  throws(() => store.parseBackup('{"a":1}'), '找不到 notes 数组时抛错');
});

/* ------------------------------------------------------------------ 杂项 */

group('时间与体积显示', () => {
  const now = new Date('2026-03-05T12:00:00').getTime();
  eq(store.relativeTime(now - 5000, now), '刚刚', '五秒前');
  eq(store.relativeTime(now - 5 * 60000, now), '5 分钟前', '五分钟前');
  eq(store.relativeTime(now - 3 * 3600000, now), '3 小时前', '三小时前');
  eq(store.relativeTime(new Date('2026-03-04T20:30:00').getTime(), now), '昨天 20:30', '昨天带具体时间');
  eq(store.relativeTime(new Date('2026-01-02T08:00:00').getTime(), now), '1月2日', '同年显示月日');
  has(store.relativeTime(new Date('2025-01-02T08:00:00').getTime(), now), '2025 年', '跨年带年份');

  eq(store.byteSize('abc'), 3, 'ASCII 三字节');
  eq(store.byteSize('中'), 3, '汉字三字节');
  eq(store.byteSize('😀'), 4, 'emoji 四字节（代理对）');
  eq(store.formatBytes(512), '512 B', '字节显示');
  eq(store.formatBytes(2048), '2.0 KB', 'KB 显示');
  eq(store.formatBytes(3 * 1024 * 1024), '3.00 MB', 'MB 显示');
});

/* ------------------------------------------------------------------ 汇总 */

const total = pass + failures.length;
if (failures.length) {
  console.error(`\n✗ 数据层：${pass}/${total} 通过，${failures.length} 个失败\n`);
  failures.forEach((f, idx) => console.error(`  ${idx + 1}) ${f}\n`));
  process.exit(1);
}
console.log(`✓ 数据层：${pass}/${total} 全部通过`);
