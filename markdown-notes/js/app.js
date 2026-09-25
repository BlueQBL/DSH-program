/*!
 * 校样 · 界面交互（app.js）
 *
 * 核心三件事（原有）：
 * 1. 实时预览：稿纸打字 → 停手 70ms 排版一次；停手 400ms 落盘一次。
 * 2. 光标 ↔ 印张双向定位：签名交互。印张页边那枚红括号指着光标所在的块，
 *    反过来点印张里任意一块，光标跳回对应的源码行。
 * 3. 印张里的勾选框能改回原文——右边的纸面可以编辑左边的墨。
 *
 * 扩展（图片 / 大纲 / 公式脚注 / 主题 / 风格 / PDF）：
 * · 图片：文件选择、粘贴、拖放三种入口，存进 IndexedDB，按"标题命名的虚拟目录"管理，
 *   导出 ZIP 时落成真目录；
 * · 大纲：直接从印张里已排好的标题收集，所以永远和正文一致；
 * · 数学与脚注：解析层负责，这里只管把结果排出来、把锚点点击接住；
 * · 主题与 Markdown 风格：写进界面偏好，换主题换的是整套 token。
 */
(function () {
  'use strict';

  const md = window.MDMarkdown;
  const store = window.MDStore;
  const MDImages = window.MDImages;
  const MDZip = window.MDZip;
  if (!md || !store) return;

  const PREVIEW_DELAY = 70;    // 打字到重排的等待
  const SAVE_DELAY = 400;      // 停手多久算写完
  const SAVE_MAX_WAIT = 4000;  // 一直在打字也不能超过这么久不落盘
  const MOBILE = '(max-width: 1080px)';

  /**
   * 主题：命名主题都照各家官方色板来，映射到本应用的角色
   * （台面 / 稿纸 / 印张 / 一支笔 / 代码 token）。
   * kind 只用来在设置里分组（深色 / 浅色），配色本身全在 styles.css 里。
   */
  const THEMES = [
    { value: 'proof', label: '校样', hint: '本应用默认：墨黑稿纸 + 纸白印张 + 一支红笔', kind: 'dark' },
    { value: 'one-dark', label: 'One Dark', hint: 'Atom 的经典深色', kind: 'dark' },
    { value: 'dracula', label: 'Dracula', hint: '紫调深色，对比鲜明', kind: 'dark' },
    { value: 'night-owl', label: 'Night Owl', hint: '深夜蓝，偏护眼', kind: 'dark' },
    { value: 'monokai', label: 'Monokai', hint: '高饱和经典', kind: 'dark' },
    { value: 'nord', label: 'Nord', hint: '冷灰蓝，低饱和', kind: 'dark' },
    { value: 'solarized-dark', label: 'Solarized Dark', hint: '低对比，久看不累', kind: 'dark' },
    { value: 'github-dark', label: 'GitHub Dark', hint: 'GitHub 的深色', kind: 'dark' },
    { value: 'solarized-light', label: 'Solarized Light', hint: '暖米色纸，白天用', kind: 'light' },
    { value: 'github-light', label: 'GitHub Light', hint: '白纸黑字', kind: 'light' },
  ];

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
    tabBadgeNotes: el('tabBadgeNotes'),
    tabBadgeOutline: el('tabBadgeOutline'),
    tabBadgeImages: el('tabBadgeImages'),
    storeInfo: el('storeInfo'),
    newNote: el('newNote'),
    exportAll: el('exportAll'),
    importBtn: el('importBtn'),
    settingsBtn: el('settingsBtn'),
    settings: el('settings'),
    themeList: el('themeList'),
    flavorList: el('flavorList'),
    fileInput: el('fileInput'),
    imageInput: el('imageInput'),
    title: el('title'),
    stamp: el('stamp'),
    editor: el('editor'),
    tools: document.querySelector('.tools'),
    dropzone: el('dropzone'),
    saveState: el('saveState'),
    caretState: el('caretState'),
    countState: el('countState'),
    sourceBlank: el('sourceBlank'),
    blankNew: el('blankNew'),
    copyNote: el('copyNote'),
    exportNote: el('exportNote'),
    exportZip: el('exportZip'),
    deleteNote: el('deleteNote'),
    exportPdf: el('exportPdf'),
    follow: el('follow'),
    proofScroll: el('proofScroll'),
    page: el('page'),
    preview: el('preview'),
    proofBlank: el('proofBlank'),
    tickCursor: el('tickCursor'),
    tickHover: el('tickHover'),
    outline: el('outline'),
    outlineFloat: el('outlineFloat'),
    outlineToggle: el('outlineToggle'),
    outlineCount: el('outlineCount'),
    imageGrid: el('imageGrid'),
    imageFolder: el('imageFolder'),
    imageUsage: el('imageUsage'),
    imageHint: el('imageHint'),
    uploadImage: el('uploadImage'),
    imageStrip: el('imageStrip'),
    imageStripItems: el('imageStripItems'),
    fenceHint: el('fenceHint'),
    fenceHintText: el('fenceHintText'),
    stripFence: el('stripFence'),
    toasts: el('toasts'),
  };

  const storage = store.createStorage();
  const imageStore = MDImages ? MDImages.createStore() : null;

  const state = {
    data: store.loadState(storage),
    ui: store.loadUI(storage),
    query: '',
    follow: true,
    dirty: false,
    saveTimer: 0,
    previewTimer: 0,
    lastSaveAt: 0,
    renderedId: null,
    railSig: '',
    cursorEl: null,
    hoverEl: null,
    statsCache: new Map(),
    warnedLength: false,
    outline: [],
    outlineSig: '',
    loadedImagesFor: null,
    imageList: [],
    imageBytes: 0,
    spyFrame: 0,
    ready: false,
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

  function noteCount(note) {
    const hit = state.statsCache.get(note.id);
    if (hit && hit.u === note.updatedAt) return hit.count;
    const count = md.stats(note.body).count;
    state.statsCache.set(note.id, { u: note.updatedAt, count: count });
    return count;
  }

  function markRanges(raw, ranges) {
    const text = String(raw == null ? '' : raw);
    if (!ranges || !ranges.length) return md.escapeHtml(text);
    let out = '';
    let last = 0;
    ranges.forEach((pair) => {
      const start = Math.max(pair[0], last);
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

  function saveBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function download(filename, text, mime) {
    saveBlob(filename, new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
  }

  function stampName(prefix, ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return prefix + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.' + ext;
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
      ? '笔记文本存在这个浏览器的 LocalStorage 里'
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
    dom.tabBadgeNotes.textContent = String(state.data.notes.length);
    dom.searchClear.hidden = !query;

    const sig = entries.map((e) => e.note.id).join(',') + '#' + query + '#' +
      state.data.activeId + '#' + state.ui.sort + '#' + state.data.notes.length;
    if (!force && sig === state.railSig) return;
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
    if (meta) meta.textContent = store.relativeTime(note.updatedAt) + ' · ' + noteCount(note) + ' 字';
    // 改标题时标签页标题跟着变（也是打印时的默认文件名）
    if (document.activeElement === dom.title) syncDocumentTitle();
  }

  /* -------------------------------------------------------------- 页签 */

  function setTab(tab) {
    const value = ['notes', 'outline', 'images'].indexOf(tab) >= 0 ? tab : 'notes';
    state.ui.tab = value;
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), (btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.tab === value));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), (panel) => {
      const on = panel.dataset.panel === value;
      panel.hidden = !on;
      panel.classList.toggle('is-active', on);
    });
    store.saveUI(state.ui, storage);
    if (value === 'outline') renderOutline(true);
    if (value === 'images') renderImagePanel();
  }

  /* -------------------------------------------------------------- 大纲 */

  /** 直接从印张里已经排好的标题收集——这样大纲和正文永远一致 */
  function collectOutline() {
    const nodes = dom.preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const list = [];
    Array.prototype.forEach.call(nodes, (node) => {
      const text = (node.textContent || '').trim();
      if (!node.id || !text) return;
      list.push({
        id: node.id,
        level: Number(node.tagName.slice(1)) || 1,
        text: text,
        isTitle: node.classList.contains('page__title'),
        el: node,
      });
    });
    return list;
  }

  function outlineItemHtml(item, minLevel) {
    const indent = Math.max(0, item.level - minLevel);
    return (
      '<button type="button" class="outline__item" data-id="' + md.escapeAttr(item.id) + '"' +
      ' data-level="' + item.level + '"' + (item.isTitle ? ' data-top="true"' : '') +
      ' style="--indent:' + indent + '">' + md.escapeHtml(item.text) + '</button>'
    );
  }

  function renderOutline(force) {
    const list = collectOutline();
    state.outline = list;

    const sig = list.map((h) => h.id + '|' + h.text).join(',');
    dom.tabBadgeOutline.textContent = String(list.length);
    dom.outlineCount.textContent = list.length ? list.length + ' 个标题' : '还没有标题';
    if (!force && sig === state.outlineSig) return;
    state.outlineSig = sig;

    if (!list.length) {
      const empty =
        '<div class="outline__empty"><strong>这篇还没有标题</strong>' +
        '正文里写一行 <code>## 小标题</code>，大纲会自动长出来。' +
        (activeNote() && activeNote().title.trim() ? '' : '标题框里填上标题，它就是大纲的第一行。') +
        '</div>';
      dom.outline.innerHTML = empty;
      dom.outlineFloat.innerHTML = empty;
      return;
    }

    const minLevel = list.reduce((min, h) => Math.min(min, h.level), 6);
    const html = list.map((item) => outlineItemHtml(item, minLevel)).join('');
    dom.outline.innerHTML = html;
    dom.outlineFloat.innerHTML = html;
    updateOutlineActive();
  }

  function markOutlineActive(id) {
    Array.prototype.forEach.call(document.querySelectorAll('.outline__item'), (btn) => {
      if (btn.dataset.id === id) btn.dataset.active = 'true';
      else btn.removeAttribute('data-active');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.outline__item[data-active="true"]'), (btn) => {
      const box = btn.parentElement;
      if (!box) return;
      const top = btn.offsetTop;
      const bottom = top + btn.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top - 8;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
    });
  }

  /** 滚动时高亮当前章节 */
  function updateOutlineActive() {
    if (!state.outline.length || !dom.outline.isConnected) return;
    const cont = dom.proofScroll;
    const line = cont.getBoundingClientRect().top + 28;
    let active = state.outline[0];
    state.outline.forEach((item) => {
      if (item.el.getBoundingClientRect().top <= line) active = item;
    });
    markOutlineActive(active.id);
  }

  function onProofScroll() {
    if (state.spyFrame) return;
    state.spyFrame = window.requestAnimationFrame(() => {
      state.spyFrame = 0;
      updateOutlineActive();
      hideHoverTick();
    });
  }

  function jumpToHeading(id, options) {
    const o = options || {};
    const target = dom.preview.querySelector('[id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (!target) return false;

    const cont = dom.proofScroll;
    const top = target.offsetTop - 18;
    cont.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });

    if (o.flash !== false) {
      target.classList.add('is-flash');
      window.setTimeout(() => target.classList.remove('is-flash'), 1000);
    }
    if (o.focusEditor) jumpToLine(Number(target.dataset.line) || 1);
    if (state.follow) markOutlineActive(id);
    closeFloatOutline();
    return true;
  }

  function toggleFloatOutline(force) {
    const show = force === undefined ? dom.outlineFloat.hidden : force;
    dom.outlineFloat.hidden = !show;
    dom.outlineToggle.setAttribute('aria-expanded', String(show));
    if (show) updateOutlineActive();
  }

  function closeFloatOutline() {
    if (!dom.outlineFloat.hidden) toggleFloatOutline(false);
  }

  /* -------------------------------------------------------------- 图片 */

  function imageFolderName() {
    const note = activeNote();
    return note ? MDImages.folderName(note.title) : MDImages.FALLBACK_TITLE;
  }

  async function refreshImages() {
    const note = activeNote();
    if (!note || !imageStore) {
      state.imageList = [];
      state.imageBytes = 0;
      renderImagePanel();
      return [];
    }
    const list = await imageStore.list(note.id);
    const usage = await imageStore.usage();
    state.imageList = list;
    state.imageBytes = usage.bytes;
    state.loadedImagesFor = note.id;
    renderImagePanel();
    return list;
  }

  async function loadNoteImages(noteId) {
    if (!imageStore) return [];
    if (state.loadedImagesFor === noteId) return state.imageList;
    const list = await imageStore.preload(noteId);
    state.loadedImagesFor = noteId;
    state.imageList = list;
    return list;
  }

  function renderImagePanel() {
    const note = activeNote();
    dom.imageFolder.textContent = MDImages ? imageFolderName() : '—';
    dom.tabBadgeImages.textContent = String(state.imageList.length);

    if (!MDImages || !imageStore) {
      dom.imageUsage.textContent = '不可用';
      dom.imageGrid.innerHTML = '<div class="images__empty">这个环境没有图片仓库。</div>';
      return;
    }
    if (!imageStore.available) {
      dom.imageHint.textContent = '注意：这个浏览器不让写本地图片库（' +
        (imageStore.reason || '原因未知') + '），图片只在本次会话有效。';
    }

    if (!note) {
      dom.imageUsage.textContent = '0 张';
      dom.imageGrid.innerHTML = '<div class="images__empty"><strong>没有打开的笔记</strong>' +
        '图片要放进某篇笔记的目录里，先打开或新建一篇。</div>';
      return;
    }

    const total = state.imageList.reduce((sum, rec) => sum + (rec.size || 0), 0);
    dom.imageUsage.textContent = state.imageList.length + ' 张 · ' + MDImages.formatBytes(total);

    if (!state.imageList.length) {
      dom.imageGrid.innerHTML =
        '<div class="images__empty"><strong>这篇还没有图片</strong>' +
        '上传、粘贴（Ctrl/Cmd+V）或把图片拖进稿纸都行。' +
        '<button type="button" class="btn btn--key" data-image-act="upload">＋ 上传图片</button></div>';
      renderImageStrip();
      return;
    }

    dom.imageGrid.innerHTML = state.imageList.map((rec) => {
      const used = imageStore.references(note.body, rec.name);
      return (
        '<figure class="image-card" data-name="' + md.escapeAttr(rec.name) + '">' +
        '<img class="image-card__thumb" src="' + md.escapeAttr(rec.url || '') + '" alt="" loading="lazy">' +
        '<figcaption class="image-card__body">' +
        '<span class="image-card__name">' + md.escapeHtml(rec.name) + '</span>' +
        '<span class="image-card__size">' + MDImages.formatBytes(rec.size || 0) +
        (used ? ' · 引用 ' + used + ' 处' : ' · 未引用') + '</span>' +
        '<span class="image-card__acts">' +
        '<button type="button" class="linkbtn" data-image-act="insert" data-name="' + md.escapeAttr(rec.name) + '">插入</button>' +
        '<button type="button" class="linkbtn linkbtn--danger" data-image-act="remove" data-name="' + md.escapeAttr(rec.name) + '">删除</button>' +
        '</span></figcaption></figure>'
      );
    }).join('');
    renderImageStrip();
  }

  /** 稿纸栏底部那条"本文图片"：编辑时也能看见图，点一下跳到引用它的那一行 */
  function renderImageStrip() {
    const note = activeNote();
    const show = Boolean(note && imageStore && state.imageList.length);
    dom.imageStrip.hidden = !show;
    if (!show) {
      dom.imageStripItems.innerHTML = '';
      return;
    }
    dom.imageStripItems.innerHTML = state.imageList.map((rec) => {
      const used = imageStore.references(note.body, rec.name);
      const hint = used
        ? rec.name + '（正文里引用了 ' + used + ' 次，点一下跳到那一行）'
        : rec.name + '（还没引用，点一下插到光标处）';
      return (
        '<button type="button" class="strip__item" data-strip="' + md.escapeAttr(rec.name) + '"' +
        ' data-used="' + (used ? 'true' : 'false') + '" title="' + md.escapeAttr(hint) + '">' +
        '<img src="' + md.escapeAttr(rec.url || '') + '" alt="" loading="lazy">' +
        '</button>'
      );
    }).join('');
  }

  function jumpToImageReference(name) {
    const note = activeNote();
    if (!note || !name) return;
    const at = note.body.indexOf(MDImages.srcFor(name));
    if (at < 0) { insertImageMarkdown([name]); return; }
    jumpToLine(note.body.slice(0, at).split('\n').length);
  }

  function isImageFile(file) {
    return Boolean(file) && (/^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(file.name || ''));
  }

  async function addImages(files, options) {
    const o = options || {};
    const note = activeNote();
    if (!note) {
      toast('先打开或新建一篇笔记——图片要放进它的目录里。');
      return [];
    }
    if (!imageStore) { toast('这个环境没有图片仓库，插不了图。'); return []; }

    const accepted = [];
    const rejected = [];
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!isImageFile(file)) { rejected.push(file.name || '未命名文件'); continue; }
      accepted.push(file);
    }
    if (!accepted.length) {
      toast('这些文件不是图片：' + md.escapeHtml(rejected.join('、')));
      return [];
    }

    const added = [];
    for (let i = 0; i < accepted.length; i += 1) {
      try {
        const rec = await imageStore.add(note.id, accepted[i]);
        added.push(rec);
      } catch (err) {
        toast('「' + md.escapeHtml(accepted[i].name || '图片') + '」存不进去：' +
          md.escapeHtml(err && err.message ? err.message : '未知错误'));
      }
    }

    state.loadedImagesFor = note.id;
    await refreshImages();
    if (o.insert !== false && added.length) insertImageMarkdown(added.map((rec) => rec.name));
    if (added.length) {
      toast('已放进「' + md.escapeHtml(imageFolderName()) + '」：' +
        md.escapeHtml(added.map((rec) => rec.name).join('、')) +
        (rejected.length ? '（跳过 ' + rejected.length + ' 个非图片文件）' : ''));
    }
    return added;
  }

  function insertImageMarkdown(names) {
    if (!activeNote() || !names.length) return;
    const text = names.map((name) => MDImages.markdownFor(name, MDImages.baseOf(name))).join('\n');
    insertBlock(text);
  }

  async function removeImage(name) {
    const note = activeNote();
    if (!note || !imageStore) return;
    const rec = state.imageList.filter((item) => item.name === name)[0];
    if (!rec) return;
    const used = imageStore.references(note.body, name);
    const blob = rec.blob;
    const kept = { name: rec.name, type: rec.type, addedAt: rec.addedAt };

    await imageStore.remove(note.id, name);
    await refreshImages();
    renderProof(); // 正文里的引用会变成"缺图"占位，看得见

    toast('已删除 ' + md.escapeHtml(name) +
      (used ? '（正文里还有 ' + used + ' 处引用，会显示成缺图）' : ''), {
      action: '撤销',
      duration: 9000,
      onAction: async () => {
        await imageStore.add(note.id, blob, { name: kept.name, type: kept.type });
        await refreshImages();
        renderProof();
        toast('已放回 ' + md.escapeHtml(name));
      },
    });
  }

  /* -------------------------------------------------------- 主题与风格 */

  /** 主题色板直接从算好的样式里读——CSS 是唯一真相，不在这里抄一份 */
  function themeSwatch(value) {
    const root = document.documentElement;
    const prev = root.dataset.theme;
    root.dataset.theme = value;
    const cs = window.getComputedStyle(root);
    const swatch = [
      cs.getPropertyValue('--ink-900').trim() || '#131922',
      cs.getPropertyValue('--paper').trim() || '#F6F5F1',
      cs.getPropertyValue('--pencil').trim() || '#D93F2B',
    ];
    if (prev) root.dataset.theme = prev;
    return swatch;
  }

  const themeValues = () => THEMES.map((t) => t.value);

  function renderSettings() {
    if (!dom.themeList) return;
    const themeButton = (theme) => {
      const swatch = themeSwatch(theme.value);
      return (
        '<button type="button" class="theme" data-theme-value="' + theme.value + '"' +
        ' aria-pressed="' + String(state.ui.theme === theme.value) + '">' +
        '<span class="theme__swatch">' +
        swatch.map((color) => '<i style="background:' + md.escapeAttr(color) + '"></i>').join('') +
        '</span>' +
        '<span class="theme__text"><span class="theme__label">' + md.escapeHtml(theme.label) + '</span>' +
        '<span class="theme__hint">' + md.escapeHtml(theme.hint) + '</span></span>' +
        '</button>'
      );
    };
    // 深色浅色分组：十个主题平铺太长，分组后一眼能找到自己要的那一类
    const groups = [
      { label: '深色', items: THEMES.filter((t) => t.kind !== 'light') },
      { label: '浅色', items: THEMES.filter((t) => t.kind === 'light') },
    ];
    dom.themeList.innerHTML = groups.map((group) => (
      '<div class="themes__group">' + md.escapeHtml(group.label) + '</div>' +
      group.items.map(themeButton).join('')
    )).join('');

    if (!dom.flavorList) return;
    const flavors = md.flavors();
    dom.flavorList.innerHTML = flavors.map((flavor) => {
      const flags = md.features.filter((f) => flavor.flags.indexOf(f.key) >= 0);
      const chips = md.features.map((f) => {
        const on = flavor.flags.indexOf(f.key) >= 0;
        return '<span class="flavor__flag' + (on ? ' is-on' : '') + '" title="' +
          md.escapeAttr(f.sample) + '">' + md.escapeHtml(f.label) + '</span>';
      }).join('');
      void flags;
      return (
        '<button type="button" class="flavor" data-flavor-value="' + flavor.value + '"' +
        ' aria-pressed="' + String(state.ui.flavor === flavor.value) + '">' +
        '<span class="flavor__label">' + md.escapeHtml(flavor.label) + '</span>' +
        '<span class="flavor__hint">' + md.escapeHtml(flavor.hint) + '</span>' +
        '<span class="flavor__flags">' + chips + '</span>' +
        '</button>'
      );
    }).join('');
  }

  function setTheme(value) {
    const theme = themeValues().indexOf(value) >= 0 ? value : 'proof';
    state.ui.theme = theme;
    document.documentElement.dataset.theme = theme;
    store.saveUI(state.ui, storage);
    renderSettings();
  }

  function setFlavor(value) {
    const known = md.flavors().map((f) => f.value);
    const flavor = known.indexOf(value) >= 0 ? value : md.DEFAULT_FLAVOR;
    if (state.ui.flavor === flavor) return;
    state.ui.flavor = flavor;
    store.saveUI(state.ui, storage);
    renderSettings();
    state.outlineSig = '';
    renderProof();
    renderOutline(true);
    const preset = md.FLAVORS[flavor];
    toast('Markdown 风格：<b>' + md.escapeHtml(preset.label) + '</b>　' + md.escapeHtml(preset.hint));
  }

  function toggleSettings(force) {
    const show = force === undefined ? dom.settings.hidden : force;
    dom.settings.hidden = !show;
    dom.settingsBtn.setAttribute('aria-expanded', String(show));
  }

  /* -------------------------------------------------------------- 稿纸 */

  function renderSource(force) {
    const note = activeNote();
    const empty = !note;
    dom.source.dataset.empty = String(empty);
    dom.sourceBlank.hidden = !empty;
    dom.copyNote.disabled = empty;
    dom.exportNote.disabled = empty;
    dom.exportZip.disabled = empty;
    dom.deleteNote.disabled = empty;
    dom.exportPdf.disabled = empty;

    if (empty) { state.renderedId = null; syncDocumentTitle(); updateStats(); return; }

    if (force || state.renderedId !== note.id) {
      dom.title.value = note.title;
      dom.editor.value = note.body;
      dom.editor.scrollTop = 0;
      state.renderedId = note.id;
    }
    dom.stamp.textContent = '创建 ' + store.formatDate(note.createdAt) +
      ' · ' + store.relativeTime(note.updatedAt) + '改过';
    syncDocumentTitle();
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
    dom.countState.textContent = stats.count + ' 字 · ' +
      (stats.readMinutes ? '约 ' + stats.readMinutes + ' 分钟' : '还没写');
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
    return '<h1 class="page__title" id="page-title" data-title="1">' + md.renderInline(title) + '</h1>';
  }

  /** 整篇被一层围栏包住时给个提示条：不静默改写原文，只提供一个按钮 */
  function updateFenceHint() {
    const note = activeNote();
    const wrapped = note ? md.detectWrappingFence(note.body) : null;
    dom.fenceHint.hidden = !wrapped;
    if (wrapped) {
      dom.fenceHintText.innerHTML =
        '这篇正文整段被一层 <code>' + md.escapeHtml(wrapped.fence) + '</code> 围栏包着' +
        (wrapped.info ? '（标注为 ' + md.escapeHtml(wrapped.info) + '）' : '') +
        '，所以在印张上显示成了代码块。';
    }
    return wrapped;
  }

  function stripWrappingFence() {
    const note = activeNote();
    if (!note) return;
    const wrapped = md.detectWrappingFence(note.body);
    if (!wrapped) return;
    const body = wrapped.inner.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    note.body = body;
    note.updatedAt = Date.now();
    if (state.renderedId === note.id) dom.editor.value = body;
    renderProof();
    updateStats();
    updateActiveCard();
    persist(true);
    toast('已拆掉外层围栏，正文按排版显示。（撤销：Ctrl/Cmd+Z）');
  }

  function renderProof() {
    const note = activeNote();
    const empty = !note;
    dom.proof.dataset.empty = String(empty);
    dom.proofBlank.hidden = !empty;

    if (empty) {
      dom.preview.innerHTML = '';
      dom.fenceHint.hidden = true;
      state.cursorEl = null;
      dom.tickCursor.classList.remove('is-on');
      dom.tickHover.classList.remove('is-on');
      renderOutline(true);
      return;
    }

    const body = titleHeadHtml(note) + md.render(note.body, {
      flavor: state.ui.flavor,
      // undefined = 这一篇的图库还没读回来（IndexedDB 是异步的）→ 先排"取图中"占位；
      // null = 读过了、确实没有 → 排"图库里没有这张图"
      resolveImage: (src) => {
        if (!imageStore) return null;
        if (state.loadedImagesFor !== note.id) return undefined;
        return imageStore.resolve(note.id, src);
      },
    });

    const next = body || '<p class="page__hint">左边的第一行会排在这里。</p>';
    if (dom.preview.innerHTML !== next) dom.preview.innerHTML = next;
    updateFenceHint();
    state.cursorEl = null;
    syncCursor(false);
    renderOutline();
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

  function hideHoverTick() {
    state.hoverEl = null;
    dom.tickHover.classList.remove('is-on');
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

  /** 让光标所在行滚进可视区（插图片、插脚注之后要用） */
  function scrollCaretIntoView() {
    const ta = dom.editor;
    const pos = caretPos();
    const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 22;
    const y = (pos.line - 1) * lineHeight;
    if (y < ta.scrollTop) ta.scrollTop = Math.max(0, y - lineHeight * 2);
    else if (y > ta.scrollTop + ta.clientHeight - lineHeight * 3) {
      ta.scrollTop = y - ta.clientHeight + lineHeight * 3;
    }
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
      const next = value.slice(0, start - before.length) + picked + value.slice(end + after.length);
      const offset = start - before.length;
      commitEditor(next, offset, offset + picked.length);
      return;
    }
    const next = value.slice(0, start) + before + picked + after + value.slice(end);
    const offset = start + before.length;
    commitEditor(next, offset, offset + picked.length);
  }

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
    scrollCaretIntoView();
  }

  function nextFootnoteLabel(body) {
    const text = String(body || '');
    const labels = new Set();
    let max = 0;
    const re = /\[\^([^\]\s]+)\]/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      labels.add(m[1]);
      if (/^\d+$/.test(m[1])) max = Math.max(max, Number(m[1]));
    }
    let candidate = max + 1;
    while (labels.has(String(candidate))) candidate += 1;
    return String(candidate);
  }

  /** 脚注：光标处写引用，文末补上定义，光标直接落在定义上，接着打字就行 */
  function insertFootnote() {
    if (!activeNote()) return;
    const ta = dom.editor;
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const label = nextFootnoteLabel(value);
    const ref = '[^' + label + ']';
    const head = value.slice(0, start);
    const tail = value.slice(end);
    const trimmed = (head + ref + tail).replace(/\s+$/, '');
    const def = '\n\n[^' + label + ']: ';
    const next = trimmed + def + '\n';
    const caret = trimmed.length + def.length;
    commitEditor(next, caret, caret);
    scrollCaretIntoView();
    toast('脚注 ' + label + ' 已开好：文末那行写说明就行，引用处会自动编号。');
  }

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
    if (kind === 'image') {
      if (!activeNote()) { toast('先打开或新建一篇笔记。'); return; }
      dom.imageInput.value = '';
      dom.imageInput.click();
      return;
    }
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
      case 'table': return insertBlock('| 表头 | 表头 |\n| --- | --- |\n|  |  |', '表头');
      case 'math': return insertBlock('$$\n\\frac{a}{b}\n$$', null, 3);
      case 'footnote': return insertFootnote();
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

    window.clearTimeout(state.previewTimer);
    state.previewTimer = window.setTimeout(() => {
      renderProof();
      updateStats();
    }, PREVIEW_DELAY);
  }

  async function newNote() {
    const note = store.createNote({});
    store.addNote(state.data, note);
    state.data.activeId = note.id;
    state.renderedId = null;
    state.railSig = '';
    state.loadedImagesFor = null;
    state.imageList = [];
    state.outlineSig = '';
    persist(true);
    renderAll();
    renderImagePanel();
    if (isNarrow()) setPane('write');
    dom.title.focus();
    dom.title.select();
  }

  async function selectNote(id) {
    if (state.data.activeId === id) return;
    state.data.activeId = id;
    state.renderedId = null;
    state.outlineSig = '';
    window.clearTimeout(state.previewTimer);
    renderRail();
    renderSource(true);
    updateCaret();
    await loadNoteImages(id);
    renderProof();
    renderImagePanel();
    syncCursor(true);
    store.saveUI(state.ui, storage);
    persist();
    if (isNarrow()) setPane('write');
    dom.editor.focus();
  }

  async function removeNote(id) {
    const note = store.findNote(state.data, id);
    if (!note) return;
    const label = noteTitle(note);
    const removed = store.deleteNote(state.data, id);
    if (!removed) return;

    state.renderedId = null;
    state.railSig = '';
    state.outlineSig = '';
    state.loadedImagesFor = null;
    state.imageList = [];
    persist(true);
    renderAll();
    await refreshImages();

    toast('已删除《' + md.escapeHtml(label) + '》', {
      action: '撤销',
      duration: 9000,
      onAction: async () => {
        store.insertNote(state.data, removed.note, removed.index);
        state.data.activeId = removed.note.id;
        state.renderedId = null;
        state.railSig = '';
        state.outlineSig = '';
        persist(true);
        renderAll();
        await refreshImages();
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
    renderImagePanel();
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

    setTheme(state.ui.theme || 'proof');
    if (md.flavors().every((f) => f.value !== state.ui.flavor)) state.ui.flavor = md.DEFAULT_FLAVOR;

    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-btn]'), (btn) => {
      btn.setAttribute('aria-current', String(btn.dataset.paneBtn === state.ui.pane));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), (btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.sort === state.ui.sort));
    });
    setTab(state.ui.tab || 'notes');
    renderSettings();
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
    // 和 ZIP 用同一套目录约定：图片引用补成 标题/文件名
    const folder = MDImages ? MDImages.folderName(note.title) : '';
    const names = MDImages ? new Set(state.imageList.map((rec) => rec.name)) : null;
    const text = MDImages
      ? noteMarkdownForExport(note, folder, names)
      : store.toMarkdown(note);
    download(store.slugify(noteTitle(note)) + '.md', text, 'text/markdown;charset=utf-8');
    toast('已导出《' + md.escapeHtml(noteTitle(note)) + '》的 Markdown' +
      (state.imageList.length ? '（图片引用写成了「' + md.escapeHtml(folder) + '/文件名」，要一起带走请用 ZIP）' : ''));
  }

  function indexMarkdown(notes, folders) {
    const lines = ['# 目录', ''];
    notes.forEach((note) => {
      const folder = folders.get(note.id) || MDImages.folderName(note.title);
      lines.push('- [' + noteTitle(note) + '](' + encodeURI(folder) + '.md)');
    });
    return lines.join('\n') + '\n';
  }

  /**
   * 导出时的目录结构（用户要的样子）：
   *
   *     我的笔记.md          ← 文档在文件夹外面
   *     我的笔记/            ← 图片在以标题命名的目录里
   *        截图-1.png
   *
   * 所以导出前要把正文里的图片路径补上目录前缀（正文里存的是文件名，
   * 这样改标题不会把引用写坏）。
   */
  function noteMarkdownForExport(note, folder, imageNames) {
    const has = imageNames ? (name) => imageNames.has(name) : null;
    const body = MDImages ? MDImages.rewritePaths(note.body, folder, has) : note.body;
    return store.toMarkdown({ title: note.title, body: body });
  }

  async function exportZip(all) {
    if (!MDZip) { toast('这个环境没有打包模块。'); return; }
    const note = activeNote();
    const notes = all ? store.sortNotes(state.data.notes, state.ui.sort) : (note ? [note] : []);
    if (!notes.length) { toast('没有可导出的笔记。'); return; }

    const folders = MDImages ? MDImages.folderNames(notes) : new Map();
    const files = [];
    let imageCount = 0;

    for (let i = 0; i < notes.length; i += 1) {
      const item = notes[i];
      const folder = folders.get(item.id) || (MDImages ? MDImages.folderName(item.title) : '未命名笔记');
      const records = imageStore ? await imageStore.list(item.id) : [];
      const names = new Set(records.map((rec) => rec.name));

      files.push({ path: folder + '.md', text: noteMarkdownForExport(item, folder, names) });
      for (let k = 0; k < records.length; k += 1) {
        const rec = records[k];
        if (!rec.blob) continue;
        imageCount += 1;
        files.push({ path: folder + '/' + rec.name, blob: rec.blob, date: new Date(rec.addedAt || Date.now()) });
      }
    }
    if (all && notes.length > 1) files.push({ path: '目录.md', text: indexMarkdown(notes, folders) });

    try {
      const blob = await MDZip.pack(files);
      const name = all ? stampName('校样-全部-', 'zip') : store.slugify(noteTitle(note)) + '.zip';
      saveBlob(name, blob);
      toast('已导出 ' + notes.length + ' 篇' + (imageCount ? '、' + imageCount + ' 张图片' : '') +
        '：文档在压缩包根目录，图片在<b>以标题命名的文件夹</b>里。');
    } catch (err) {
      toast('打包失败：' + md.escapeHtml(err && err.message ? err.message : '未知错误'));
    }
  }

  /**
   * 标签页标题始终跟着当前笔记走。
   * 编辑器都这么做，顺带解决一件麻烦事：打印窗口的默认文件名取的是文档标题，
   * 标题一直是对的，就不用指望"点导出那一瞬间改标题"能赶上。
   */
  function syncDocumentTitle() {
    const note = activeNote();
    document.title = note ? noteTitle(note) + ' · 校样' : '校样 · Markdown 笔记台';
  }

  /**
   * 导出 PDF：交给浏览器自己的打印引擎（打印窗口里选「另存为 PDF」）。
   *
   * 文件名是这里最麻烦的一件事：打印窗口的默认文件名取的是**最外层文档**的标题。
   * 应用被嵌在别的页面里打开时（预览面板、内嵌浏览器……），那个标题是外层页面的，
   * 甚至可能是空的——用户就会看到"文件名是空的"。
   * 所以这里分三种情况：
   *   · 独立打开：把文档标题换成笔记标题即可；
   *   · 同源嵌套：顺手把外层标签页的标题也换成笔记标题（打印完再还回去）；
   *   · 跨域嵌套：动不了外层，老实告诉用户"请在新标签页打开"，而不是打出一份文件名不对的 PDF。
   */
  function exportPdf() {
    const note = activeNote();
    if (!note) { toast('先打开一篇笔记。'); return; }

    const wanted = noteTitle(note);
    const paneBefore = state.ui.pane;
    const nested = window.top !== window.self;

    let topDoc = null;
    let previousTopTitle = '';
    if (nested) {
      try {
        topDoc = window.top.document;
        previousTopTitle = topDoc.title;
      } catch {
        topDoc = null; // 跨域，够不着外层
      }
    }

    if (nested && !topDoc) {
      toast('这个页面被嵌在别的网页里打开，直接打印会印出外层那个页面，文件名也会是外层页面的。' +
        '换成新标签页打开就能正常导出。', {
        action: '新标签页打开',
        duration: 12000,
        onAction: () => window.open(window.location.href, '_blank', 'noopener'),
      });
      return;
    }

    // 打印期间标题保持成纯笔记标题（不带"· 校样"后缀，免得文件名拖个尾巴）
    document.title = wanted;
    if (topDoc) topDoc.title = wanted;

    // 窄屏下"一次只显示一栏"，印张可能正处在 display:none；
    // Chrome 打印时不会给这种隐藏子树重新排版，结果就是一张白纸。
    if (isNarrow()) setPane('read');

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      if (topDoc && topDoc.title === wanted) topDoc.title = previousTopTitle;
      syncDocumentTitle();
      if (isNarrow()) setPane(paneBefore);
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.setTimeout(restore, 120000); // 万一 afterprint 不来，也别一直挂着

    toast('打印窗口的「另存为 PDF」里，文件名应该已经是《' + md.escapeHtml(wanted) + '》' +
      (nested ? '（这个页面被嵌着打开，我把外层标签页的标题也换成了它）' : '') +
      '；如果那里是空的，点右边「复制标题」粘进去即可。', {
      action: '复制标题',
      duration: 10000,
      onAction: () => copyText(wanted, '标题已复制，粘到文件名那一栏就行'),
    });

    window.setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        toast('打印窗口打不开：' + md.escapeHtml(err && err.message ? err.message : '未知错误'));
      }
    }, 140);
  }

  function exportAll() {
    if (!state.data.notes.length) { toast('还没有笔记可以备份。'); return; }
    download(stampName('校样-备份-', 'json'),
      JSON.stringify(store.toBackup(state.data), null, 2), 'application/json;charset=utf-8');
    toast('已导出 ' + state.data.notes.length + ' 篇笔记的 JSON 备份（不含图片，图片用 ZIP 导出）');
  }

  function importText(text, filename) {
    const isJson = /\.json$/i.test(filename) || /^\s*[[{]/.test(text);
    if (!isJson) {
      const title = filename.replace(/\.[^.]+$/, '') || '导入的笔记';
      const note = store.createNote({ title: title, body: text });
      store.addNote(state.data, note);
      state.data.activeId = note.id;
      state.renderedId = null;
      state.railSig = '';
      state.outlineSig = '';
      state.loadedImagesFor = null;
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
    state.outlineSig = '';
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
    dom.settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettings();
    });

    dom.settings.addEventListener('click', (e) => {
      const theme = e.target.closest('[data-theme-value]');
      if (theme) { setTheme(theme.dataset.themeValue); return; }
      const flavor = e.target.closest('[data-flavor-value]');
      if (flavor) setFlavor(flavor.dataset.flavorValue);
    });

    document.addEventListener('click', (e) => {
      if (dom.settings.hidden) return;
      if (dom.settings.contains(e.target) || dom.settingsBtn.contains(e.target)) return;
      toggleSettings(false);
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), (btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });

    dom.fileInput.addEventListener('change', () => {
      const file = dom.fileInput.files && dom.fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importText(String(reader.result || ''), file.name);
      reader.onerror = () => toast('文件读取失败。');
      reader.readAsText(file);
    });

    dom.imageInput.addEventListener('change', () => {
      const files = Array.prototype.slice.call(dom.imageInput.files || []);
      if (files.length) addImages(files);
      dom.imageInput.value = '';
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

    /* 大纲 */
    [dom.outline, dom.outlineFloat].forEach((box) => {
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('.outline__item');
        if (btn) jumpToHeading(btn.dataset.id);
      });
    });
    dom.outlineToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFloatOutline();
    });

    /* 图片 */
    dom.uploadImage.addEventListener('click', () => applyTool('image'));
    dom.imageStripItems.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-strip]');
      if (btn) jumpToImageReference(btn.dataset.strip);
    });
    dom.stripFence.addEventListener('click', stripWrappingFence);
    dom.imageGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-image-act]');
      if (!btn) return;
      const act = btn.dataset.imageAct;
      if (act === 'upload') applyTool('image');
      else if (act === 'insert') insertImageMarkdown([btn.dataset.name]);
      else if (act === 'remove') removeImage(btn.dataset.name);
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
          e.stopPropagation();
        }
      }
    });

    /* 粘贴图片：程序员截图之后直接 Ctrl+V 是最顺手的路径 */
    dom.editor.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].kind !== 'file') continue;
        if (!/^image\//i.test(items[i].type || '')) continue;
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
      if (!files.length) return;
      e.preventDefault();
      addImages(files);
    });

    /* 拖放图片 */
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;

    dom.source.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      dom.dropzone.hidden = false;
    });
    dom.source.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    dom.source.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dom.dropzone.hidden = true;
    });
    dom.source.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      dom.dropzone.hidden = true;
      const files = Array.prototype.slice.call(e.dataTransfer.files || []);
      const images = files.filter(isImageFile);
      if (images.length) addImages(images);
      else toast('拖进来的不是图片文件。');
    });
    document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

    dom.tools.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-md]');
      if (btn) applyTool(btn.dataset.md);
    });

    dom.copyNote.addEventListener('click', () => {
      const note = activeNote();
      if (note) copyText(store.toMarkdown(note), 'Markdown 原文已复制');
    });
    dom.exportNote.addEventListener('click', exportNote);
    dom.exportZip.addEventListener('click', () => exportZip(false));
    dom.exportPdf.addEventListener('click', exportPdf);
    dom.deleteNote.addEventListener('click', () => {
      const note = activeNote();
      if (note) removeNote(note.id);
    });

    /* 印张：链接 / 脚注跳转 / 点块回源码 / 点勾选框改原文 / 复制代码 */
    dom.preview.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const pre = copyBtn.closest('.md-codeblock').querySelector('pre');
        if (pre) copyText(pre.textContent.replace(/\n+$/, '') + '\n', '代码已复制');
        return;
      }
      const box = e.target.closest('[data-toggle-line]');
      if (box) { toggleTask(Number(box.dataset.toggleLine)); return; }

      // 站内锚点（脚注、[跳到](#sec-2)）：自己滚动，不动地址栏
      const anchor = e.target.closest('a[href^="#"]');
      if (anchor) {
        const id = anchor.getAttribute('href').slice(1);
        if (id && jumpToHeading(id, { flash: true })) e.preventDefault();
        return;
      }
      if (e.target.closest('a')) return;

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
      if (!block || block === state.cursorEl) { hideHoverTick(); return; }
      if (state.hoverEl === block) return;
      state.hoverEl = block;
      placeTick(dom.tickHover, block);
    });
    dom.preview.addEventListener('mouseleave', hideHoverTick);

    dom.proofScroll.addEventListener('scroll', onProofScroll, { passive: true });

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
      if (e.key === 'ArrowLeft') state.ui.seam -= step;
      else if (e.key === 'ArrowRight') state.ui.seam += step;
      else if (e.key === 'Home') state.ui.seam = 0.5;
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
          if (!dom.settings.hidden) { toggleSettings(false); return; }
          if (!dom.outlineFloat.hidden) { toggleFloatOutline(false); return; }
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
      } else if (key === 'p' && e.shiftKey) {
        e.preventDefault();
        exportPdf();
      }
    });

    /* 离开页面前兜底保存 */
    window.addEventListener('pagehide', () => {
      if (state.dirty) persist(true);
      if (imageStore) imageStore.releaseAll();
    });
    window.addEventListener('beforeunload', () => { if (state.dirty) persist(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.dirty) persist(true);
    });

    window.addEventListener('resize', () => {
      if (!isNarrow()) applySeam();
      else closeFloatOutline();
    });
  }

  /* -------------------------------------------------------------- 启动 */

  async function init() {
    // 地址栏可以带上偏好：#pane=read / #theme=dracula / #flavor=paper
    // （窄屏截某一栏、给别人看某套主题，都用得上；非法值会被 setTheme/setFlavor 挡回默认）
    const hash = window.location.hash || '';
    const pane = hash.match(/pane=(notes|write|read)/);
    if (pane) state.ui.pane = pane[1];
    const theme = hash.match(/theme=([a-z0-9-]+)/);
    if (theme) state.ui.theme = theme[1];
    const flavor = hash.match(/flavor=([a-z]+)/);
    if (flavor) state.ui.flavor = flavor[1];

    applyUI();
    bind();

    // 先画出来，别让首屏等 IndexedDB——图片位先放"取图中"的占位，读完再补一次
    renderRail(true);
    renderSource(true);
    renderProof();
    renderImagePanel();
    renderOutline(true);
    updateStoreInfo();
    updateCaret();
    setSaveState(state.data.notes.length ? '已保存 ' + timeLabel(state.lastSaveAt || Date.now()) : '还没有笔记',
      state.data.notes.length ? 'ok' : undefined);

    if (imageStore) {
      await imageStore.ready();
      if (!imageStore.available) {
        toast('这个浏览器不让写本地图片库（' + md.escapeHtml(imageStore.reason || '原因未知') +
          '），图片只在本次会话有效。', { duration: 9000 });
      } else {
        const ids = state.data.notes.map((n) => n.id);
        const cleaned = await imageStore.cleanup(ids);
        if (cleaned.removed) {
          toast('清理了 ' + cleaned.removed + ' 张属于已删除笔记的图片（' +
            MDImages.formatBytes(cleaned.bytes) + '）');
        }
      }
      if (activeNote()) await loadNoteImages(state.data.activeId);
      renderProof();
      renderImagePanel();
      renderAll();
    }

    if (!storage.available) {
      toast('这个浏览器不让写入本地存储，笔记改动只在本次会话里有效。', { duration: 9000 });
    }

    if (activeNote()) {
      if (!isNarrow()) {
        dom.editor.focus();
        dom.editor.setSelectionRange(0, 0);
        dom.editor.scrollTop = 0;
      }
      dom.proofScroll.scrollTop = 0;
      updateCaret();
      syncCursor(false);
      renderOutline(true);
    }
    state.ready = true;
    document.documentElement.dataset.ready = 'true';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
