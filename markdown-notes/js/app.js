/*!
 * 校样 · 界面交互（app.js）
 *
 * 三件事是这里的核心：
 * 1. 实时预览：稿纸打字 → 停手 70ms 排版一次；停手 400ms 落盘一次。
 * 2. 光标 ↔ 印张双向定位：签名交互。印张页边那枚红括号指着光标所在的块，
 *    反过来点印张里任意一块，光标跳回对应的源码行。
 * 3. 印张里的勾选框能改回原文——右边的纸面可以编辑左边的墨。
 */
(function () {
  'use strict';

  const md = window.MDMarkdown;
  const store = window.MDStore;
  if (!md || !store) return;

  const PREVIEW_DELAY = 70;    // 打字到重排的等待
  const SAVE_DELAY = 400;      // 停手多久算写完
  const SAVE_MAX_WAIT = 4000;  // 一直在打字也不能超过这么久不落盘
  const MOBILE = '(max-width: 1080px)';

  const el = (id) => document.getElementById(id);

  const dom = {
    app: el('app'),
    workbench: el('workbench'),
    rail: document.querySelector('.rail'),
    source: document.querySelector('.source'),
    proof: document.querySelector('.proof'),
    seam: el('seam'),
    cards: el('cards'),
    search: el('search'),
    searchClear: el('searchClear'),
    railCount: el('railCount'),
    paneCount: el('paneCount'),
    storeInfo: el('storeInfo'),
    newNote: el('newNote'),
    exportAll: el('exportAll'),
    importBtn: el('importBtn'),
    fileInput: el('fileInput'),
    title: el('title'),
    stamp: el('stamp'),
    editor: el('editor'),
    tools: document.querySelector('.tools'),
    saveState: el('saveState'),
    caretState: el('caretState'),
    countState: el('countState'),
    sourceBlank: el('sourceBlank'),
    blankNew: el('blankNew'),
    copyNote: el('copyNote'),
    exportNote: el('exportNote'),
    deleteNote: el('deleteNote'),
    follow: el('follow'),
    proofScroll: el('proofScroll'),
    page: el('page'),
    preview: el('preview'),
    proofBlank: el('proofBlank'),
    tickCursor: el('tickCursor'),
    tickHover: el('tickHover'),
    toasts: el('toasts'),
  };

  const storage = store.createStorage();

  const state = {
    data: store.loadState(storage),
    ui: store.loadUI(storage),
    query: '',
    follow: true,
    dirty: false,
    saveTimer: 0,
    previewTimer: 0,
    lastSaveAt: 0,
    renderedId: null,   // 编辑器里现在装的是哪一篇
    railSig: '',
    cursorEl: null,
    hoverEl: null,
    statsCache: new Map(),
    warnedLength: false,
  };

  state.follow = state.ui.follow !== false;

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isNarrow = () => window.matchMedia && window.matchMedia(MOBILE).matches;

  /* ------------------------------------------------------------ 小工具 */

  function activeNote() {
    return store.findNote(state.data, state.data.activeId);
  }

  function noteTitle(note) {
    return (note.title || '').trim() || '未命名笔记';
  }

  function timeLabel(ts) {
    const d = new Date(ts || Date.now());
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /** 笔记字数缓存：列表里每条都算一次会浪费，按 updatedAt 失效即可 */
  function noteCount(note) {
    const hit = state.statsCache.get(note.id);
    if (hit && hit.u === note.updatedAt) return hit.count;
    const count = md.stats(note.body).count;
    state.statsCache.set(note.id, { u: note.updatedAt, count: count });
    return count;
  }

  /** 把搜索命中的区间标成 <mark>（入参是原文，转义在切片时逐段做） */
  function markRanges(raw, ranges) {
    const text = String(raw == null ? '' : raw);
    if (!ranges || !ranges.length) return md.escapeHtml(text);
    let out = '';
    let last = 0;
    ranges.forEach((pair) => {
      let start = Math.max(pair[0], last);
      const end = Math.min(pair[1], text.length);
      if (end <= start) return;
      out += md.escapeHtml(text.slice(last, start)) + '<mark>' + md.escapeHtml(text.slice(start, end)) + '</mark>';
      last = end;
    });
    return out + md.escapeHtml(text.slice(last));
  }

  /* -------------------------------------------------------------- 吐司 */

  function toast(message, opts) {
    const o = opts || {};
    const box = document.createElement('div');
    box.className = 'toast';

    const msg = document.createElement('span');
    msg.className = 'toast__msg';
    msg.innerHTML = message;
    box.appendChild(msg);

    let timer = 0;
    let remaining = o.duration || 3600;
    let startedAt = 0;

    function close() {
      window.clearTimeout(timer);
      box.classList.add('is-gone');
      window.setTimeout(() => box.remove(), 240);
    }

    function arm() {
      startedAt = Date.now();
      timer = window.setTimeout(close, remaining);
    }

    if (o.action) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'toast__act';
      act.textContent = o.action;
      act.addEventListener('click', () => {
        close();
        if (o.onAction) o.onAction();
      });
      box.appendChild(act);

      // 要人做决定的消息，指针悬停时先别走
      box.addEventListener('mouseenter', () => {
        window.clearTimeout(timer);
        remaining = Math.max(1200, remaining - (Date.now() - startedAt));
      });
      box.addEventListener('mouseleave', arm);
    }

    dom.toasts.appendChild(box);
    while (dom.toasts.children.length > 3) dom.toasts.firstElementChild.remove();
    arm();
    return { close: close };
  }

  /**
   * 复制：剪贴板 API 在有些环境里既不 resolve 也不 reject（权限被挡、非安全上下文…），
   * 那种情况下"点了没反应"比"复制失败"更糟，所以给它一个 800ms 的兜底判决。
   */
  async function copyText(text, okMessage) {
    function fallback() {
      const tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', 'readonly');
      tmp.style.position = 'fixed';
      tmp.style.top = '-1000px';
      document.body.appendChild(tmp);
      tmp.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch { done = false; }
      tmp.remove();
      toast(done ? okMessage : '复制没成功，请手动选中复制。');
      return done;
    }

    try {
      if (!navigator.clipboard || !window.isSecureContext) return fallback();
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('剪贴板无响应')), 800)),
      ]);
      toast(okMessage);
      return true;
    } catch {
      return fallback();
    }
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* -------------------------------------------------------- 落盘与状态 */

  function setSaveState(text, tone) {
    dom.saveState.textContent = text;
    if (tone) dom.saveState.dataset.tone = tone;
    else delete dom.saveState.dataset.tone;
  }

  function persist(force) {
    window.clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    const result = store.saveState(state.data, storage);
    state.dirty = false;
    state.lastSaveAt = Date.now();

    if (result.persisted) setSaveState('已保存 ' + timeLabel(), 'ok');
    else setSaveState(result.error ? '未能保存：' + result.error : '仅本次会话', 'warn');

    updateStoreInfo(result.bytes);
    renderRail();
    if (force) return result;
    return result;
  }

  function scheduleSave() {
    state.dirty = true;
    const waited = Date.now() - state.lastSaveAt;
    if (waited > SAVE_MAX_WAIT) { persist(); return; }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => persist(), SAVE_DELAY);
  }

  function updateStoreInfo(bytes) {
    const count = state.data.notes.length;
    const size = bytes === undefined
      ? store.byteSize(JSON.stringify({ v: 1, notes: state.data.notes, activeId: state.data.activeId }))
      : bytes;
    const parts = [count + ' 篇', store.formatBytes(size)];
    if (!storage.available) { parts.push('不会保存'); dom.storeInfo.dataset.tone = 'warn'; }
    else delete dom.storeInfo.dataset.tone;
    dom.storeInfo.textContent = parts.join(' · ');
    dom.storeInfo.title = storage.available
      ? '全部数据都在这个浏览器的 LocalStorage 里'
      : '本地存储不可用：' + (storage.reason || '原因未知');
  }

  /* ------------------------------------------------------------ 目录栏 */

  function visibleEntries() {
    const query = state.query.trim();
    if (query) {
      return store.searchNotes(state.data.notes, query).map((hit) => ({
        note: hit.note,
        titleRanges: hit.titleRanges,
        snippet: hit.snippet,
      }));
    }
    return store.sortNotes(state.data.notes, state.ui.sort).map((note) => ({ note: note }));
  }

  function cardHtml(entry) {
    const note = entry.note;
    const title = (note.title || '').trim();
    const titleHtml = title
      ? markRanges(title, entry.titleRanges)
      : '<span class="card__title--empty">未命名笔记</span>';
    const active = note.id === state.data.activeId;
    const meta = store.relativeTime(note.updatedAt) + ' · ' + noteCount(note) + ' 字';
    const snippet = entry.snippet && entry.snippet.text
      ? '<span class="card__snippet">' + markRanges(entry.snippet.text, entry.snippet.ranges) + '</span>'
      : '';
    return (
      '<li class="card" data-id="' + note.id + '" data-active="' + active + '">' +
      '<button type="button" class="card__open" data-act="open" data-id="' + note.id + '">' +
      '<span class="card__title">' + titleHtml + '</span>' +
      '<span class="card__meta">' + md.escapeHtml(meta) + '</span>' + snippet +
      '</button>' +
      '<button type="button" class="card__del" data-act="del" data-id="' + note.id + '"' +
      ' aria-label="删除《' + md.escapeAttr(noteTitle(note)) + '》" title="删除这篇笔记">×</button>' +
      '</li>'
    );
  }

  function renderRail(force) {
    const query = state.query.trim();
    const entries = visibleEntries();

    dom.railCount.textContent = query
      ? entries.length + ' / ' + state.data.notes.length + ' 篇'
      : state.data.notes.length + ' 篇';
    dom.paneCount.textContent = String(state.data.notes.length);
    dom.searchClear.hidden = !query;

    const sig = entries.map((e) => e.note.id).join(',') + '#' + query + '#' +
      state.data.activeId + '#' + state.ui.sort + '#' + state.data.notes.length;
    if (!force && sig === state.railSig) { return; }
    state.railSig = sig;

    if (!entries.length) {
      dom.cards.innerHTML = query
        ? '<li class="rail__empty"><strong>没有匹配「' + md.escapeHtml(query) + '」的笔记</strong>' +
          '搜索会同时看标题和正文，多个词用空格隔开。' +
          '<button type="button" class="btn" data-act="clear">清除搜索</button></li>'
        : '<li class="rail__empty"><strong>还没有笔记</strong>' +
          '第一篇是空的，写什么都行。' +
          '<button type="button" class="btn btn--key" data-act="new">＋ 新建笔记</button></li>';
      return;
    }

    dom.cards.innerHTML = entries.map(cardHtml).join('');
  }

  /** 打字时只改当前那张卡，别整栏重排（会闪、会打断悬停） */
  function updateActiveCard() {
    const note = activeNote();
    if (!note) return;
    const card = dom.cards.querySelector('.card[data-id="' + note.id + '"]');
    if (!card) return;
    const title = card.querySelector('.card__title');
    const meta = card.querySelector('.card__meta');
    const text = (note.title || '').trim();
    if (title) {
      title.innerHTML = text
        ? md.escapeHtml(text)
        : '<span class="card__title--empty">未命名笔记</span>';
    }
    if (meta) {
      meta.textContent = store.relativeTime(note.updatedAt) + ' · ' + noteCount(note) + ' 字';
    }
  }

  /* -------------------------------------------------------------- 稿纸 */

  function renderSource(force) {
    const note = activeNote();
    const empty = !note;
    dom.source.dataset.empty = String(empty);
    dom.sourceBlank.hidden = !empty;
    dom.copyNote.disabled = empty;
    dom.exportNote.disabled = empty;
    dom.deleteNote.disabled = empty;

    if (empty) { state.renderedId = null; updateStats(); return; }

    if (force || state.renderedId !== note.id) {
      dom.title.value = note.title;
      dom.editor.value = note.body;
      dom.editor.scrollTop = 0;
      state.renderedId = note.id;
    }
    dom.stamp.textContent = '创建 ' + store.formatDate(note.createdAt) +
      ' · ' + store.relativeTime(note.updatedAt) + '改过';
    updateStats();
  }

  function updateStats() {
    const note = activeNote();
    if (!note) {
      dom.countState.textContent = '0 字';
      dom.caretState.textContent = '行 1 · 列 1';
      return;
    }
    const stats = md.stats(note.body);
    dom.countState.textContent = stats.count + ' 字 · ' + (stats.readMinutes ? '约 ' + stats.readMinutes + ' 分钟' : '还没写');
    updateCaret();
  }

  function caretPos() {
    const ta = dom.editor;
    const upto = ta.value.slice(0, ta.selectionStart);
    const lines = upto.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
  }

  function updateCaret() {
    const pos = caretPos();
    dom.caretState.textContent = '行 ' + pos.line + ' · 列 ' + pos.col;
  }

  /* -------------------------------------------------------------- 印张 */

  /**
   * 印张顶部那一行标题。
   *
   * 标题是单独一个输入框，不属于正文，所以渲染时要在正文前面排出来——
   * 否则"编辑页有标题、预览页没有"就成了两套说法。
   * 正文自己以一级标题开头时就不排，免得同一句话出现两次；
   * 判据和导出 .md 用的是同一个函数，印张看到什么、导出就是什么。
   */
  function titleHeadHtml(note) {
    const title = (note.title || '').trim();
    if (!title || store.bodyStartsWithH1(note.body)) return '';
    return '<h1 class="page__title" data-title="1">' + md.renderInline(title) + '</h1>';
  }

  function renderProof() {
    const note = activeNote();
    const empty = !note;
    dom.proof.dataset.empty = String(empty);
    dom.proofBlank.hidden = !empty;

    if (empty) {
      dom.preview.innerHTML = '';
      state.cursorEl = null;
      dom.tickCursor.classList.remove('is-on');
      dom.tickHover.classList.remove('is-on');
      return;
    }

    // 空笔记给一句提示，但别让它变成"正文"——所以不带 data-line，光标联动会忽略它
    const next = (titleHeadHtml(note) + md.render(note.body)) ||
      '<p class="page__hint">左边的第一行会排在这里。</p>';
    if (dom.preview.innerHTML !== next) dom.preview.innerHTML = next;
    state.cursorEl = null;
    syncCursor(false);
  }

  function cursorLine() {
    return caretPos().line;
  }

  /** 找出光标所在的最小（最内层）块——嵌套列表里要落到 li 而不是 ul */
  function blockForLine(line) {
    const blocks = dom.preview.querySelectorAll('[data-line]');
    let best = null;
    let bestSpan = Infinity;
    let bestDepth = -1;
    for (let i = 0; i < blocks.length; i++) {
      const node = blocks[i];
      const start = Number(node.dataset.line);
      const end = Number(node.dataset.end);
      if (!(line >= start && line <= end)) continue;
      const span = end - start;
      let depth = 0;
      for (let p = node.parentElement; p && p !== dom.preview; p = p.parentElement) {
        if (p.dataset && p.dataset.line) depth += 1;
      }
      if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
        best = node;
        bestSpan = span;
        bestDepth = depth;
      }
    }
    return best;
  }

  function placeTick(tick, node) {
    if (!node) { tick.classList.remove('is-on'); return; }
    tick.style.top = node.offsetTop + 'px';
    tick.style.height = Math.max(node.offsetHeight, 16) + 'px';
    tick.classList.add('is-on');
  }

  function scrollPageTo(node) {
    const cont = dom.proofScroll;
    const cr = cont.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const pad = 56;
    let delta = 0;
    if (nr.top < cr.top + pad) delta = nr.top - cr.top - pad;
    else if (nr.bottom > cr.bottom - pad) delta = nr.bottom - cr.bottom + pad;
    if (!delta) return;
    cont.scrollTo({
      top: cont.scrollTop + delta,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }

  function syncCursor(doScroll) {
    if (!activeNote()) return;
    const node = blockForLine(cursorLine());

    if (state.cursorEl && state.cursorEl !== node) state.cursorEl.classList.remove('is-cursor');
    state.cursorEl = node || null;

    if (!node) {
      dom.tickCursor.classList.remove('is-on');
      return;
    }
    node.classList.add('is-cursor');
    placeTick(dom.tickCursor, node);
    if (doScroll && state.follow) scrollPageTo(node);
  }

  /** 反向：点印张里的块，光标跳回源码行 */
  function jumpToLine(line) {
    if (isNarrow()) setPane('write');
    const ta = dom.editor;
    const value = ta.value;
    let pos = 0;
    let n = 1;
    while (n < line) {
      const at = value.indexOf('\n', pos);
      if (at < 0) break;
      pos = at + 1;
      n += 1;
    }
    ta.focus();
    ta.setSelectionRange(pos, pos);
    const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 22;
    ta.scrollTop = Math.max(0, (n - 1) * lineHeight - ta.clientHeight * 0.32);
    updateCaret();
    syncCursor(true);
  }

  /* -------------------------------------------------------- 编辑器写入 */

  function commitEditor(value, selStart, selEnd) {
    const ta = dom.editor;
    ta.value = value;
    const a = selStart === undefined ? ta.value.length : selStart;
    const b = selEnd === undefined ? a : selEnd;
    ta.setSelectionRange(a, b);
    ta.focus();
    onFieldInput();
  }

  function wrapSelection(before, after, placeholder) {
    const ta = dom.editor;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const picked = value.slice(start, end) || placeholder || '';
    const wrappedBefore = value.slice(start - before.length, start) === before;
    const wrappedAfter = value.slice(end, end + after.length) === after;

    if (wrappedBefore && wrappedAfter) {
      // 已经包过一层就脱掉，按钮变成开关
      const next = value.slice(0, start - before.length) + picked + value.slice(end + after.length);
      const offset = start - before.length;
      commitEditor(next, offset, offset + picked.length);
      return;
    }
    const next = value.slice(0, start) + before + picked + after + value.slice(end);
    const offset = start + before.length;
    commitEditor(next, offset, offset + picked.length);
  }

  /** 对选中的每一行加前缀；全都有前缀就当作取消 */
  function prefixLines(prefix) {
    const ta = dom.editor;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to < 0) to = value.length;

    const lines = value.slice(from, to).split('\n');
    const allPrefixed = lines.every((line) => line.startsWith(prefix) || line.trim() === '');
    const next = lines.map((line) => {
      if (allPrefixed) return line.startsWith(prefix) ? line.slice(prefix.length) : line;
      if (!line.trim()) return line;
      return prefix + line;
    }).join('\n');

    const delta = next.length - (to - from);
    commitEditor(value.slice(0, from) + next + value.slice(to), from, Math.max(from, end + delta));
  }

  /** 插入一段独立成块的文本；offset 定点落光标，select 则选中某段字 */
  function insertBlock(text, select, offset) {
    const ta = dom.editor;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const head = value.slice(0, start);
    const lead = head && !head.endsWith('\n') ? '\n\n' : '';
    const body = lead + text + '\n';
    const next = head + body + value.slice(end);
    const base = head.length + lead.length;
    let anchor = base;
    let anchorEnd = base;
    if (typeof offset === 'number') {
      anchor = base + offset;
      anchorEnd = anchor;
    } else if (select) {
      const at = text.indexOf(select);
      if (at >= 0) { anchor = base + at; anchorEnd = anchor + select.length; }
    }
    commitEditor(next, anchor, anchorEnd);
  }

  /**
   * 回车续行：列表接着列表、引用接着引用；
   * 空项上回车等于"退出这个列表"——写起来跟正经编辑器一样。
   */
  function handleEnter() {
    const ta = dom.editor;
    const value = ta.value;
    const pos = ta.selectionStart;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const current = value.slice(lineStart, pos);
    const plain = current.match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/);
    const quote = current.match(/^(\s*>\s?)(.*)$/);

    if (plain) {
      const indent = plain[1];
      const marker = plain[2];
      const rest = plain[4];
      const task = rest.match(/^\[([ xX])\]\s+/);
      if (!rest.trim()) {
        // 空项：把标记删掉，光标落在缩进后
        const next = value.slice(0, lineStart) + '\n' + value.slice(pos);
        commitEditor(next, lineStart + 1, lineStart + 1);
        return;
      }
      let nextMarker = marker;
      if (/^\d/.test(marker)) {
        const num = parseInt(marker, 10) + 1;
        nextMarker = String(num) + marker.slice(-1);
      }
      const prefix = indent + nextMarker + plain[3] + (task ? '[ ] ' : '');
      const insert = '\n' + prefix;
      const next = value.slice(0, pos) + insert + value.slice(ta.selectionEnd);
      commitEditor(next, pos + insert.length, pos + insert.length);
      return;
    }

    if (quote && quote[2].trim()) {
      const insert = '\n' + quote[1];
      const next = value.slice(0, pos) + insert + value.slice(ta.selectionEnd);
      commitEditor(next, pos + insert.length, pos + insert.length);
    }
  }

  function indentSelection(outdent) {
    const ta = dom.editor;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    let to = value.indexOf('\n', end);
    if (to < 0) to = value.length;
    const chunk = value.slice(from, to);

    if (!chunk.includes('\n') && !outdent) {
      const spaces = '  ';
      const next = value.slice(0, start) + spaces + value.slice(end);
      commitEditor(next, start + spaces.length, start + spaces.length);
      return;
    }

    const lines = chunk.split('\n');
    const next = lines.map((line) => {
      if (outdent) {
        if (line.startsWith('  ')) return line.slice(2);
        if (line.startsWith(' ')) return line.slice(1);
        return line;
      }
      return line.trim() ? '  ' + line : line;
    }).join('\n');

    const delta = next.length - chunk.length;
    commitEditor(value.slice(0, from) + next + value.slice(to), from, Math.max(from, end + delta));
  }

  function applyTool(kind) {
    if (!activeNote()) return;
    switch (kind) {
      case 'h2': return prefixLines('## ');
      case 'list': return prefixLines('- ');
      case 'quote': return prefixLines('> ');
      case 'bold': return wrapSelection('**', '**', '粗体');
      case 'italic': return wrapSelection('*', '*', '斜体');
      case 'code': return wrapSelection('`', '`', '代码');
      case 'link': return wrapSelection('[', '](https://)', '链接文字');
      case 'fence': return insertBlock('```js\n\n```', null, '```js\n'.length);
      case 'table':
        return insertBlock('| 表头 | 表头 |\n| --- | --- |\n|  |  |', '表头');
      case 'hr': return insertBlock('---', '');
      default: return undefined;
    }
  }

  /* ------------------------------------------------------- 编辑与选择 */

  function onFieldInput() {
    const note = activeNote();
    if (!note) return;
    const before = note.updatedAt;
    store.updateNote(state.data, note.id, { title: dom.title.value, body: dom.editor.value });

    if (dom.editor.value.length > store.MAX_BODY && !state.warnedLength) {
      state.warnedLength = true;
      toast('正文超过 ' + store.MAX_BODY + ' 字符，超出的部分不会保存。', { duration: 6000 });
    }

    if (note.updatedAt !== before) {
      dom.stamp.textContent = '创建 ' + store.formatDate(note.createdAt) +
        ' · ' + store.relativeTime(note.updatedAt) + '改过';
    }
    updateActiveCard();
    updateCaret();
    setSaveState('待保存…', 'saving');
    scheduleSave();

    // 字数与重排一起延后：长文上每敲一个字都全量统计太浪费
    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => {
      renderProof();
      updateStats();
    }, PREVIEW_DELAY);
  }

  function newNote() {
    const note = store.createNote({});
    store.addNote(state.data, note);
    state.data.activeId = note.id;
    state.renderedId = null;
    state.railSig = '';
    persist(true);
    renderAll();
    if (isNarrow()) setPane('write');
    dom.title.focus();
    dom.title.select();
  }

  function selectNote(id) {
    if (state.data.activeId === id) return;
    state.data.activeId = id;
    state.renderedId = null;
    window.clearTimeout(state.previewTimer);
    renderRail();
    renderSource(true);
    renderProof();
    updateCaret();
    syncCursor(true);
    store.saveUI(state.ui, storage);
    persist();
    if (isNarrow()) setPane('write');
    dom.editor.focus();
  }

  function removeNote(id) {
    const note = store.findNote(state.data, id);
    if (!note) return;
    const label = noteTitle(note);
    const removed = store.deleteNote(state.data, id);
    if (!removed) return;

    state.renderedId = null;
    state.railSig = '';
    persist(true);
    renderAll();

    toast('已删除《' + md.escapeHtml(label) + '》', {
      action: '撤销',
      duration: 9000,
      onAction: () => {
        store.insertNote(state.data, removed.note, removed.index);
        state.data.activeId = removed.note.id;
        state.renderedId = null;
        state.railSig = '';
        persist(true);
        renderAll();
        toast('已恢复《' + md.escapeHtml(label) + '》');
      },
    });
  }

  /** 印张里的勾选框：点它的效果是改回左边的原文 */
  function toggleTask(line) {
    const note = activeNote();
    if (!note) return;
    const lines = note.body.split('\n');
    const index = line - 1;
    if (index < 0 || index >= lines.length) return;
    const next = lines[index].replace(
      /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/,
      (all, head, mark, tail) => head + (mark.toLowerCase() === 'x' ? ' ' : 'x') + tail
    );
    if (next === lines[index]) return;
    lines[index] = next;
    note.body = lines.join('\n');
    note.updatedAt = Date.now();
    if (state.renderedId === note.id) dom.editor.value = note.body;
    renderProof();
    updateStats();
    updateActiveCard();
    persist(true);
  }

  /* ------------------------------------------------------ 全文渲染 */

  function renderAll() {
    renderRail(true);
    renderSource(true);
    renderProof();
    updateStoreInfo();
    updateCaret();
    if (!state.dirty) {
      setSaveState(state.data.notes.length ? '已保存 ' + timeLabel(state.lastSaveAt || Date.now()) : '还没有笔记',
        state.data.notes.length ? 'ok' : undefined);
    }
  }

  /* ---------------------------------------------------------- 界面偏好 */

  function applySeam() {
    const ratio = Math.min(0.8, Math.max(0.2, state.ui.seam));
    document.documentElement.style.setProperty('--src-fr', String(ratio * 2));
    document.documentElement.style.setProperty('--prf-fr', String((1 - ratio) * 2));
    dom.seam.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    dom.seam.setAttribute('aria-valuemin', '20');
    dom.seam.setAttribute('aria-valuemax', '80');
  }

  function applyUI() {
    document.documentElement.style.setProperty('--rail', state.ui.rail + 'px');
    applySeam();
    dom.app.dataset.pane = state.ui.pane;
    dom.follow.checked = state.follow;

    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-btn]'), (btn) => {
      btn.setAttribute('aria-current', String(btn.dataset.paneBtn === state.ui.pane));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), (btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === state.ui.sort));
    });
  }

  function setPane(pane) {
    state.ui.pane = pane;
    dom.app.dataset.pane = pane;
    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-btn]'), (btn) => {
      btn.setAttribute('aria-current', String(btn.dataset.paneBtn === pane));
    });
    store.saveUI(state.ui, storage);
  }

  function setSort(sort) {
    state.ui.sort = sort;
    state.railSig = '';
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), (btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === sort));
    });
    store.saveUI(state.ui, storage);
    renderRail(true);
  }

  function setQuery(value) {
    state.query = value;
    state.railSig = '';
    renderRail(true);
  }

  /* -------------------------------------------------------- 导入导出 */

  function exportNote() {
    const note = activeNote();
    if (!note) return;
    download(store.slugify(noteTitle(note)) + '.md', store.toMarkdown(note), 'text/markdown;charset=utf-8');
    toast('已导出《' + md.escapeHtml(noteTitle(note)) + '》');
  }

  function exportAll() {
    if (!state.data.notes.length) { toast('还没有笔记可以备份。'); return; }
    const stamp = new Date();
    const name = '校样-备份-' + stamp.getFullYear() + String(stamp.getMonth() + 1).padStart(2, '0') +
      String(stamp.getDate()).padStart(2, '0') + '.json';
    download(name, JSON.stringify(store.toBackup(state.data), null, 2), 'application/json;charset=utf-8');
    toast('已导出 ' + state.data.notes.length + ' 篇笔记的 JSON 备份');
  }

  function importText(text, filename) {
    const isJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);
    if (!isJson) {
      const title = filename.replace(/\.[^.]+$/, '') || '导入的笔记';
      const note = store.createNote({ title: title, body: text });
      store.addNote(state.data, note);
      state.data.activeId = note.id;
      state.renderedId = null;
      persist(true);
      renderAll();
      toast('已把 ' + md.escapeHtml(filename) + ' 导入成一篇新笔记');
      return;
    }
    let parsed;
    try {
      parsed = store.parseBackup(text);
    } catch (err) {
      toast('导入失败：' + md.escapeHtml(err.message || '文件读不出来'));
      return;
    }
    if (!parsed.notes.length) { toast('这个文件里没有可导入的笔记。'); return; }
    parsed.notes.forEach((item) => {
      store.addNote(state.data, {
        id: store.uid(),
        title: item.title,
        body: item.body,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
    });
    state.railSig = '';
    persist(true);
    renderAll();
    const extra = parsed.skipped ? '，跳过 ' + parsed.skipped + ' 条坏数据' : '';
    toast('已导入 ' + parsed.notes.length + ' 篇笔记' + extra);
  }

  function pickFile() {
    dom.fileInput.value = '';
    dom.fileInput.click();
  }

  /* ------------------------------------------------------------ 事件 */

  function bind() {
    /* 目录栏 */
    dom.newNote.addEventListener('click', newNote);
    dom.blankNew.addEventListener('click', newNote);
    dom.exportAll.addEventListener('click', exportAll);
    dom.importBtn.addEventListener('click', pickFile);

    dom.fileInput.addEventListener('change', () => {
      const file = dom.fileInput.files && dom.fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importText(String(reader.result || ''), file.name);
      reader.onerror = () => toast('文件读取失败。');
      reader.readAsText(file);
    });

    dom.search.addEventListener('input', () => setQuery(dom.search.value));
    dom.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { dom.search.value = ''; setQuery(''); dom.search.blur(); return; }
      if (e.key === 'Enter') {
        const first = dom.cards.querySelector('.card');
        if (first) selectNote(first.dataset.id);
      }
    });
    dom.searchClear.addEventListener('click', () => {
      dom.search.value = '';
      setQuery('');
      dom.search.focus();
    });

    dom.cards.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'open') selectNote(btn.dataset.id);
      else if (act === 'del') removeNote(btn.dataset.id);
      else if (act === 'clear') { dom.search.value = ''; setQuery(''); }
      else if (act === 'new') newNote();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), (btn) => {
      btn.addEventListener('click', () => setSort(btn.dataset.sort));
    });

    /* 稿纸 */
    dom.title.addEventListener('input', onFieldInput);
    dom.editor.addEventListener('input', onFieldInput);
    dom.editor.addEventListener('click', () => { updateCaret(); syncCursor(true); });
    dom.editor.addEventListener('keyup', () => { updateCaret(); syncCursor(true); });
    dom.editor.addEventListener('select', updateCaret);

    dom.editor.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Tab') { e.preventDefault(); indentSelection(e.shiftKey); return; }
      if (e.key === 'Enter' && !e.shiftKey && !mod) {
        const ta = dom.editor;
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        const lineStart = before.lastIndexOf('\n') + 1;
        const current = before.slice(lineStart);
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(current) || /^(\s*>\s?)/.test(current)) {
          e.preventDefault();
          handleEnter();
        }
        return;
      }
      if (mod && !e.altKey) {
        const key = e.key.toLowerCase();
        let handled = true;
        if (key === 'b') applyTool('bold');
        else if (key === 'i') applyTool('italic');
        else if (key === 'e' || key === '`') applyTool('code');
        else if (key === 'k') applyTool('link');
        else handled = false;
        if (handled) {
          e.preventDefault();
          // 别让 Ctrl+K 顺手把搜索框也抢过去了
          e.stopPropagation();
        }
      }
    });

    dom.tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-md]');
      if (btn) applyTool(btn.dataset.md);
    });

    dom.copyNote.addEventListener('click', () => {
      const note = activeNote();
      if (note) copyText(store.toMarkdown(note), 'Markdown 原文已复制');
    });
    dom.exportNote.addEventListener('click', exportNote);
    dom.deleteNote.addEventListener('click', () => {
      const note = activeNote();
      if (note) removeNote(note.id);
    });

    /* 印张：点块回源码 / 点勾选框改原文 / 复制代码 */
    dom.preview.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const pre = copyBtn.closest('.md-codeblock').querySelector('pre');
        if (pre) copyText(pre.textContent.replace(/\n+$/, '') + '\n', '代码已复制');
        return;
      }
      const box = e.target.closest('[data-toggle-line]');
      if (box) { toggleTask(Number(box.dataset.toggleLine)); return; }
      if (e.target.closest('a')) return; // 链接交给浏览器
      // 印张上的标题不属于正文，没有源码行可跳，点它就把光标交给标题框
      if (e.target.closest('[data-title]')) {
        dom.title.focus();
        dom.title.select();
        return;
      }
      const block = e.target.closest('[data-line]');
      if (block) jumpToLine(Number(block.dataset.line));
    });

    dom.preview.addEventListener('mouseover', (e) => {
      const block = e.target.closest('[data-line], [data-title]');
      if (!block || block === state.cursorEl) { dom.tickHover.classList.remove('is-on'); return; }
      if (state.hoverEl === block) return;
      state.hoverEl = block;
      placeTick(dom.tickHover, block);
    });
    dom.preview.addEventListener('mouseleave', () => {
      state.hoverEl = null;
      dom.tickHover.classList.remove('is-on');
    });

    /* 印张：跟随光标开关 */
    dom.follow.addEventListener('change', () => {
      state.follow = dom.follow.checked;
      state.ui.follow = state.follow;
      store.saveUI(state.ui, storage);
      if (state.follow) syncCursor(true);
    });

    /* 窗格切换（窄屏） */
    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-btn]'), (btn) => {
      btn.addEventListener('click', () => setPane(btn.dataset.paneBtn));
    });

    /* 中缝拖动 / 键盘调整 */
    let dragging = false;

    dom.seam.addEventListener('pointerdown', (e) => {
      dragging = true;
      dom.seam.setPointerCapture(e.pointerId);
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    dom.seam.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const wb = dom.workbench.getBoundingClientRect();
      const railW = dom.rail.getBoundingClientRect().width;
      const usable = wb.width - railW - dom.seam.getBoundingClientRect().width;
      if (usable <= 0) return;
      state.ui.seam = Math.min(0.8, Math.max(0.2, (e.clientX - wb.left - railW) / usable));
      applySeam();
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      store.saveUI(state.ui, storage);
    };
    dom.seam.addEventListener('pointerup', endDrag);
    dom.seam.addEventListener('pointercancel', endDrag);

    dom.seam.addEventListener('dblclick', () => {
      state.ui.seam = 0.5;
      applySeam();
      store.saveUI(state.ui, storage);
    });

    dom.seam.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.02;
      if (e.key === 'ArrowLeft') { state.ui.seam -= step; }
      else if (e.key === 'ArrowRight') { state.ui.seam += step; }
      else if (e.key === 'Home') { state.ui.seam = 0.5; }
      else return;
      e.preventDefault();
      state.ui.seam = Math.min(0.8, Math.max(0.2, state.ui.seam));
      applySeam();
      store.saveUI(state.ui, storage);
    });

    /* 全局快捷键 */
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        if (e.key === 'Escape') {
          const last = dom.toasts.lastElementChild;
          if (last) last.remove();
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'n') { e.preventDefault(); newNote(); }
      else if (key === 'k') { e.preventDefault(); dom.search.focus(); dom.search.select(); }
      else if (key === 's') {
        e.preventDefault();
        state.dirty = true;
        persist(true);
        toast('已保存到本地存储');
      }
    });

    /* 离开页面前兜底保存 */
    window.addEventListener('pagehide', () => { if (state.dirty) persist(true); });
    window.addEventListener('beforeunload', () => { if (state.dirty) persist(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.dirty) persist(true);
    });

    /* 窄屏 ↔ 宽屏切换时，把分栏比例重新算一遍 */
    window.addEventListener('resize', () => {
      if (!isNarrow()) applySeam();
    });
  }

  /* -------------------------------------------------------------- 启动 */

  function init() {
    // 支持 #pane=notes|write|read：窄屏下直接开在某一栏，截图和分享都用得上
    const hash = (window.location.hash || '').match(/pane=(notes|write|read)/);
    if (hash) state.ui.pane = hash[1];

    applyUI();
    bind();
    renderAll();

    if (!storage.available) {
      toast('这个浏览器不让写入本地存储，改动只在本次会话里有效。', { duration: 9000 });
    }

    if (activeNote()) {
      // 打开就聚焦正文，但光标必须在开头——否则"跟随光标"会把印张直接滚到文末
      if (!isNarrow()) {
        dom.editor.focus();
        dom.editor.setSelectionRange(0, 0);
        dom.editor.scrollTop = 0;
      }
      dom.proofScroll.scrollTop = 0;
      updateCaret();
      syncCursor(false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
