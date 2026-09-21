/*!
 * 案头待办 · 界面层（ui.js）
 * 只做三件事：把状态画到 DOM 上、把用户操作翻译成 core 的状态变更、把状态存回 LocalStorage。
 */
(function (global) {
  'use strict';

  const core = global.TodoCore;
  if (!core) throw new Error('core.js 必须先于 ui.js 加载');

  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));
  const BATCH = 80; // 首屏之后分批渲染，避免几百条任务时掉帧

  const STATUS_ORDER = ['all', 'active', 'done', 'overdue'];

  function createApp(options) {
    const opts = options || {};
    const now = () => (typeof opts.now === 'function' ? opts.now() : new Date());

    const els = {
      form: $('#compose-form'),
      title: $('#f-title'),
      desc: $('#f-desc'),
      due: $('#f-due'),
      dueQuick: $('#due-quick'),
      category: $('#f-category'),
      categoryList: $('#category-list'),
      prioGroup: $('#f-priority'),
      submit: $('#compose-submit'),
      reset: $('#compose-reset'),
      titleCount: $('#title-count'),
      descCount: $('#desc-count'),

      search: $('#search-input'),
      searchClear: $('#search-clear'),
      statusBar: $('#status-bar'),
      chipCategories: $('#chip-categories'),
      chipPriorities: $('#chip-priorities'),
      sort: $('#sort-select'),
      results: $('#results-count'),
      filterReset: $('#filters-reset'),
      board: $('#board'),
      list: $('#task-list'),
      empty: $('#empty-state'),
      emptyTitle: $('#empty-title'),
      emptyDesc: $('#empty-desc'),
      emptyAction: $('#empty-action'),
      busyBar: $('#busy-bar'),
      clearDone: $('#clear-done'),

      statRate: $('#stat-rate'),
      statRing: $('#ring-value'),
      statTotal: $('#stat-total'),
      statActive: $('#stat-active'),
      statDone: $('#stat-done'),
      statOverdue: $('#stat-overdue'),
      statToday: $('#stat-today'),
      statUpcoming: $('#stat-upcoming'),
      statStreak: $('#stat-streak'),
      categoryStats: $('#category-stats'),
      categoryEmpty: $('#category-stats-empty'),
      series: $('#series'),
      seriesMeta: $('#series-meta'),
      prioStats: $('#priority-stats'),
      footnote: $('#stats-footnote'),

      themeToggle: $('#theme-toggle'),
      exportJSON: $('#export-json'),
      exportCSV: $('#export-csv'),
      importInput: $('#import-input'),
      importButton: $('#import-button'),
      demoButton: $('#demo-button'),
      notifyButton: $('#notify-button'),

      toast: $('#toast'),
      toastText: $('#toast-text'),
      toastAction: $('#toast-action'),
      confirmDialog: $('#confirm-dialog'),
      confirmTitle: $('#confirm-title'),
      confirmDesc: $('#confirm-desc'),
      confirmOk: $('#confirm-ok'),
    };

    const storage = core.resolveStorage(opts.storage);
    const persisted = core.load(storage);
    let state = persisted;
    let visible = core.selectTasks(state);
    let renderToken = 0;
    const undoStack = [];
    let scheduledFrame = 0;
    let confirmAction = null;
    let toastTimer = 0;
    let toastUndo = null;
    let scrollAnchor = null;

    /* ------------------------------------------------------------ 存储 */

    function persist() {
      const ok = core.save(state, storage);
      if (!ok && storage.ephemeral !== true) {
        showToast('浏览器拒绝写入本地存储，本次改动不会保留', null);
      }
      if (storage.ephemeral === true && els.footnote) {
        els.footnote.dataset.warn = '1';
      }
    }

    /* ------------------------------------------------------------ 撤销 */

    function snapshot() {
      undoStack.push(JSON.stringify(state));
      if (undoStack.length > core.UNDO_LIMIT) undoStack.shift();
    }

    function undo() {
      const raw = undoStack.pop();
      if (!raw) {
        showToast('没有可撤销的操作', null);
        return;
      }
      state = core.createState(JSON.parse(raw));
      state.updatedAt = Date.now();
      persist();
      refresh(true);
      showToast('已撤销上一步', null);
    }

    /* ------------------------------------------------------------ 状态变更出口 */

    function commit(next, message, opts2) {
      const o = opts2 || {};
      if (next === state && !o.force) return;
      if (o.snapshot !== false) snapshot();
      if (o.before) o.before();
      state = next;
      persist();
      refresh(o.full !== false);
      if (message) showToast(message, o.undo ? undo : null);
    }

    /* ------------------------------------------------------------ 表单 */

    const draft = () => ({
      title: els.title.value,
      desc: els.desc.value,
      due: els.due.value,
      priority: ($$('#f-priority input:checked')[0] || {}).value || 'normal',
      category: (els.category.value || '').trim() || '未分类',
    });

    function clearForm(focus) {
      els.form.reset();
      els.due.value = '';
      $$('#f-priority input').forEach((input) => {
        input.checked = input.value === 'normal';
      });
      els.category.value = '';
      updateCounters();
      setFormError('');
      if (focus !== false) els.title.focus();
    }

    function updateCounters() {
      if (els.titleCount) {
        els.titleCount.textContent = `${els.title.value.length}/${core.MAX_TITLE}`;
        els.titleCount.dataset.over = String(els.title.value.length > core.MAX_TITLE);
      }
      if (els.descCount) els.descCount.textContent = `${els.desc.value.length}/${core.MAX_DESC}`;
    }

    function setFormError(message) {
      const box = $('#compose-error');
      if (!box) return;
      box.textContent = message || '';
      box.hidden = !message;
      els.title.setAttribute('aria-invalid', message ? 'true' : 'false');
    }

    function submitForm(event) {
      event.preventDefault();
      const input = draft();
      if (!input.title.trim()) {
        setFormError('先写点什么，标题不能为空');
        els.title.focus();
        return;
      }
      if (input.due && !core.isValidDate(input.due)) {
        setFormError('截止日期格式不对，请用日期选择器');
        return;
      }
      const result = core.addTask(state, input, now());
      setFormError('');
      commit(result.state, '已加入待办', { snapshot: true });
      clearForm(true);
      flashCard(result.task.id);
    }

    /* ------------------------------------------------------------ 渲染：工具栏 */

    function renderSelectors() {
      // 状态下拉 / 排序下拉的选项来自 core，保证和逻辑层同一份枚举
      if (els.sort && !els.sort.options.length) {
        core.SORTS.forEach((s) => {
          const opt = document.createElement('option');
          opt.value = s.value;
          opt.textContent = s.label;
          els.sort.appendChild(opt);
        });
      }
      if (els.statusBar && !els.statusBar.children.length) {
        core.STATUSES.forEach((s) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'seg';
          btn.dataset.status = s.value;
          btn.innerHTML = '<span class="seg-label"></span><span class="seg-count" data-count></span>';
          btn.querySelector('.seg-label').textContent = s.label;
          els.statusBar.appendChild(btn);
        });
      }
      renderCategoryOptions();
      renderPriorityInputs(els.prioGroup);
    }

    function renderCategoryOptions() {
      if (els.categoryList) {
        els.categoryList.textContent = '';
        state.categories.forEach((name) => {
          const opt = document.createElement('option');
          opt.value = name;
          els.categoryList.appendChild(opt);
        });
      }
    }

    /** 优先级单选组：立单表单和编辑对话框共用同一份构造逻辑 */
    function renderPriorityInputs(container) {
      if (!container || container.children.length) return;
      core.PRIORITIES.forEach((p, i) => {
        const label = document.createElement('label');
        label.className = 'prio';
        label.dataset.priority = p.value;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'priority';
        input.value = p.value;
        input.checked = p.value === 'normal';
        if (i === 0) input.setAttribute('aria-label', '优先级');
        const span = document.createElement('span');
        span.textContent = p.label;
        label.append(input, span);
        container.appendChild(label);
      });
    }

    function renderDueQuick() {
      if (!els.dueQuick || els.dueQuick.children.length) return;
      const preset = [
        { label: '今天', offset: 0 },
        { label: '明天', offset: 1 },
        { label: '本周末', offset: null, compute: weekendOffset },
        { label: '下周一', offset: null, compute: nextMondayOffset },
        { label: '清空', offset: null, clear: true },
      ];
      preset.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quick';
        btn.textContent = p.label;
        btn.addEventListener('click', () => {
          if (p.clear) {
            els.due.value = '';
          } else {
            const offset = p.compute ? p.compute(now()) : p.offset;
            els.due.value = core.shiftISO(offset, now());
          }
        });
        els.dueQuick.appendChild(btn);
      });
    }

    function weekendOffset(date) {
      const day = date.getDay(); // 0=周日
      const delta = day === 0 ? 0 : 6 - day;
      return delta;
    }

    function nextMondayOffset(date) {
      const day = date.getDay();
      const delta = day === 0 ? 1 : 8 - day;
      return delta;
    }

    function renderFilters() {
      const stats = core.computeStats(state.tasks, now());
      const f = state.filters;

      if (els.statusBar) {
        const counts = { all: stats.total, active: stats.active, done: stats.done, overdue: stats.overdue };
        $$('.seg', els.statusBar).forEach((btn) => {
          const value = btn.dataset.status;
          btn.classList.toggle('is-on', f.status === value);
          btn.setAttribute('aria-pressed', String(f.status === value));
          btn.disabled = value !== 'all' && counts[value] === 0 && f.status !== value;
          btn.querySelector('[data-count]').textContent = counts[value] ? String(counts[value]) : '';
        });
      }

      if (els.sort) els.sort.value = f.sort;
      // 只在用户没在输入时回填，避免防抖窗口内的重绘把正在敲的字冲掉
      if (els.search && els.search.value !== f.query && document.activeElement !== els.search) {
        els.search.value = f.query;
      }
      if (els.searchClear) els.searchClear.hidden = !f.query;

      renderChipRow(els.chipCategories, state.categories, f.categories, (name) => {
        const cat = stats.byCategory.find((c) => c.name === name);
        return {
          label: name,
          count: cat ? cat.active : 0,
          color: core.categoryColor(state, name),
          key: 'categories',
          value: name,
        };
      });

      renderChipRow(els.chipPriorities, core.PRIORITIES.map((p) => p.value), f.priorities, (value) => {
        const stat = stats.byPriority.find((p) => p.value === value);
        return {
          label: core.priorityLabel(value),
          count: stat ? stat.active : 0,
          color: `var(--prio-${value})`,
          key: 'priorities',
          value,
        };
      });

      if (els.filterReset) {
        const active = core.filtersActive(state);
        els.filterReset.disabled = !active;
        els.filterReset.dataset.active = String(active);
      }
      if (els.clearDone) {
        els.clearDone.disabled = stats.done === 0;
      }
    }

    function renderChipRow(container, values, selected, describe) {
      if (!container) return;
      container.textContent = '';
      values.forEach((value) => {
        const info = describe(value);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.dataset.filterKey = info.key;
        btn.dataset.filterValue = String(info.value);
        btn.classList.toggle('is-on', selected.includes(value));
        btn.setAttribute('aria-pressed', String(selected.includes(value)));
        btn.style.setProperty('--chip-color', info.color);

        const dot = document.createElement('span');
        dot.className = 'chip-dot';
        const label = document.createElement('span');
        label.className = 'chip-label';
        label.textContent = info.label;
        btn.append(dot, label);
        if (info.count) {
          const count = document.createElement('span');
          count.className = 'chip-count';
          count.textContent = String(info.count);
          btn.appendChild(count);
        }
        container.appendChild(btn);
      });
    }

    /* ------------------------------------------------------------ 渲染：任务列表 */

    function renderTask(task, index) {
      const li = document.createElement('li');
      li.className = 'task';
      li.dataset.id = task.id;
      li.dataset.priority = task.priority;
      li.dataset.category = task.category;
      li.classList.toggle('is-done', task.done);
      if (core.isOverdue(task, now())) li.classList.add('is-overdue');
      li.style.setProperty('--cat-color', core.categoryColor(state, task.category));

      /* ---- 票根：撕下即完成 ---- */
      const stub = document.createElement('div');
      stub.className = 'stub';
      stub.dataset.role = 'stub';
      stub.setAttribute('role', 'button');
      stub.tabIndex = 0;
      stub.setAttribute(
        'aria-label',
        `${task.done ? '恢复' : '撕下票根完成'}：${task.title}`
      );
      stub.title = task.done ? '把票根贴回去（恢复未完成）' : '撕下票根 → 标记完成';

      const no = document.createElement('span');
      no.className = 'stub-no';
      no.textContent = 'NO.' + String(index + 1).padStart(3, '0');

      const prio = document.createElement('span');
      prio.className = 'stub-prio';
      prio.textContent = core.priorityLabel(task.priority);

      const cat = document.createElement('span');
      cat.className = 'stub-cat';
      cat.textContent = task.category;

      const grip = document.createElement('span');
      grip.className = 'stub-grip';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML = '<i></i><i></i><i></i>';

      stub.append(no, prio, cat, grip);

      /* ---- 票面 ---- */
      const body = document.createElement('div');
      body.className = 'task-body';

      const head = document.createElement('div');
      head.className = 'task-head';
      const titleEl = document.createElement('h3');
      titleEl.className = 'task-title';
      titleEl.textContent = task.title;
      head.appendChild(titleEl);

      if (task.done) {
        const mark = document.createElement('span');
        mark.className = 'task-done-mark';
        mark.textContent = '完成';
        head.appendChild(mark);
      }
      body.appendChild(head);

      if (task.desc) {
        const desc = document.createElement('p');
        desc.className = 'task-desc';
        desc.textContent = task.desc;
        body.appendChild(desc);
      }

      const meta = document.createElement('div');
      meta.className = 'task-meta';
      const due = core.dueLabel(task.due, now());
      const dueEl = document.createElement('span');
      dueEl.className = 'badge due';
      dueEl.dataset.tone = task.done ? 'done' : due.tone;
      dueEl.textContent = task.done ? (task.due ? `${task.due.slice(5).replace('-', '/')} · 已完成` : '已完成') : due.text;
      meta.appendChild(dueEl);

      if (task.done && task.completedAt) {
        const when = document.createElement('span');
        when.className = 'badge';
        when.textContent = relativeTime(task.completedAt, now());
        meta.appendChild(when);
      }
      body.appendChild(meta);

      /* ---- 操作 ---- */
      const actions = document.createElement('div');
      actions.className = 'task-actions';

      const toggle = button('check', task.done ? '恢复未完成' : '标记完成', 'icon-button check', () => {
        toggleTask(task.id);
      });
      const edit = button('edit', '编辑', 'icon-button', () => openEditor(task));
      const dup = button('copy', '复制一份', 'icon-button', () => {
        commit(core.duplicateTask(state, task.id, now()), '已复制一份', { undo: true });
      });
      const del = button('trash', '删除', 'icon-button danger', () => askDelete(task));

      actions.append(toggle, edit, dup, del);

      li.append(stub, body, actions);
      return li;
    }

    function button(icon, label, className, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#icon-${icon}`);
      svg.appendChild(use);
      btn.appendChild(svg);
      btn.addEventListener('click', onClick);
      return btn;
    }

    function relativeTime(ts, date) {
      const mins = Math.round((date.getTime() - ts) / 60000);
      if (mins < 1) return '刚刚完成';
      if (mins < 60) return `${mins} 分钟前完成`;
      const hours = Math.round(mins / 60);
      if (hours < 24) return `${hours} 小时前完成`;
      const days = Math.round(hours / 24);
      if (days === 1) return '昨天完成';
      if (days < 30) return `${days} 天前完成`;
      return new Date(ts).toLocaleDateString('zh-CN');
    }

    function renderBoard() {
      if (!els.list) return;
      renderToken += 1;
      const token = renderToken;
      els.list.textContent = '';
      visible = core.selectTasks(state);

      const frag = document.createDocumentFragment();
      visible.slice(0, BATCH).forEach((task, i) => frag.appendChild(renderTask(task, i)));
      els.list.appendChild(frag);

      if (visible.length > BATCH) {
        // 大列表分批补齐，先让首屏可交互
        let cursor = BATCH;
        const pump = () => {
          if (token !== renderToken) return;
          const slice = visible.slice(cursor, cursor + BATCH);
          const more = document.createDocumentFragment();
          slice.forEach((task, i) => more.appendChild(renderTask(task, cursor + i)));
          els.list.appendChild(more);
          cursor += BATCH;
          if (cursor < visible.length) scheduledFrame = requestAnimationFrame(pump);
        };
        scheduledFrame = requestAnimationFrame(pump);
      }

      const has = visible.length > 0;
      if (els.empty) {
        els.empty.hidden = has;
        renderEmptyState();
      }

      // 票根拖拽是挂在卡片上的，渲染完立刻绑定，不等 MutationObserver 的下一轮
      attachStubHandlers();

      if (els.results) {
        const total = state.tasks.length;
        els.results.textContent = has
          ? `显示 ${visible.length} / ${total} 条`
          : `0 / ${total} 条`;
      }
      if (els.board) els.board.dataset.count = String(visible.length);
    }

    function renderEmptyState() {
      const filtering = core.filtersActive(state);
      if (els.emptyTitle) els.emptyTitle.textContent = state.tasks.length === 0 ? '案头是空的' : '没有符合条件的待办';
      if (els.emptyDesc) {
        els.emptyDesc.textContent =
          state.tasks.length === 0
            ? '在左边写下第一件事，给它一个截止日期和优先级。'
            : '换个关键词，或者把筛选条件放宽一点。';
      }
      if (els.emptyAction) {
        els.emptyAction.dataset.mode = filtering ? 'reset' : 'focus';
        els.emptyAction.textContent = filtering ? '清空筛选条件' : '写一条待办';
      }
    }

    /* ------------------------------------------------------------ 渲染：统计 */

    function renderStats() {
      const date = now();
      const stats = core.computeStats(state.tasks, date);
      const series = core.completionSeries(state.tasks, 14, date);

      if (els.statRate) els.statRate.textContent = `${stats.rate}%`;
      if (els.statRing) {
        const r = Number(els.statRing.getAttribute('r')) || 34;
        const c = 2 * Math.PI * r;
        els.statRing.setAttribute('stroke-dasharray', String(c));
        els.statRing.setAttribute('stroke-dashoffset', String(c * (1 - stats.rate / 100)));
      }
      setText(els.statTotal, stats.total);
      setText(els.statActive, stats.active);
      setText(els.statDone, stats.done);
      setText(els.statOverdue, stats.overdue);
      setText(els.statToday, stats.today);
      if (els.statUpcoming) els.statUpcoming.textContent = String(stats.upcoming);
      if (els.statStreak) els.statStreak.textContent = `${core.streak(state.tasks, date)} 天`;

      // 分类分布
      if (els.categoryStats) {
        els.categoryStats.textContent = '';
        const rows = stats.byCategory.slice(0, 8);
        els.categoryEmpty && (els.categoryEmpty.hidden = rows.length > 0);
        rows.forEach((cat) => {
          const li = document.createElement('li');
          li.className = 'bar-row';
          li.style.setProperty('--cat-color', core.categoryColor(state, cat.name));

          const name = document.createElement('button');
          name.type = 'button';
          name.className = 'bar-name';
          name.textContent = cat.name;
          name.title = `只看「${cat.name}」`;
          name.addEventListener('click', () => {
            commit(core.setFilter(state, { categories: [cat.name] }), `已筛选：${cat.name}`, { snapshot: false });
          });

          const track = document.createElement('div');
          track.className = 'bar-track';
          const fill = document.createElement('span');
          const max = stats.byCategory[0].total || 1;
          fill.style.width = `${Math.round((cat.total / max) * 100)}%`;
          const doneWidth = cat.total ? Math.round((cat.done / cat.total) * 100) : 0;
          fill.style.setProperty('--done-width', `${doneWidth}%`);
          track.appendChild(fill);

          const value = document.createElement('span');
          value.className = 'bar-value';
          value.textContent = `${cat.done}/${cat.total}`;
          li.append(name, track, value);
          els.categoryStats.appendChild(li);
        });
      }

      // 近 14 天完成量
      if (els.series) {
        els.series.textContent = '';
        const peak = Math.max(1, ...series.map((d) => d.count));
        series.forEach((day) => {
          const col = document.createElement('div');
          col.className = 'tick';
          col.style.setProperty('--h', `${Math.round((day.count / peak) * 100)}%`);
          col.classList.toggle('is-today', day.date === core.todayISO(date));
          col.classList.toggle('is-empty', day.count === 0);
          col.title = `${day.date}：完成 ${day.count} 条`;
          col.innerHTML = '<i></i><b></b>';
          col.querySelector('b').textContent = String(day.count || '');
          els.series.appendChild(col);
        });
        if (els.seriesMeta) {
          const sum = series.reduce((acc, d) => acc + d.count, 0);
          els.seriesMeta.textContent = `近 14 天完成 ${sum} 条`;
        }
      }

      // 优先级分布
      if (els.prioStats) {
        els.prioStats.textContent = '';
        stats.byPriority.forEach((p) => {
          const li = document.createElement('li');
          li.className = 'prio-row';
          li.dataset.priority = p.value;
          const label = document.createElement('span');
          label.className = 'prio-name';
          label.textContent = p.label;
          const meter = document.createElement('div');
          meter.className = 'prio-meter';
          const fill = document.createElement('i');
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          fill.style.width = `${pct}%`;
          meter.appendChild(fill);
          const value = document.createElement('span');
          value.className = 'prio-value';
          value.textContent = p.active ? `${p.active} 待办` : p.total ? '已清空' : '—';
          li.append(label, meter, value);
          els.prioStats.appendChild(li);
        });
      }

      if (els.footnote) {
        const ts = state.updatedAt ? new Date(state.updatedAt).toLocaleString('zh-CN', { hour12: false }) : null;
        els.footnote.textContent = storage.ephemeral
          ? '当前浏览器禁用了本地存储，数据只存在内存里，刷新会丢。'
          : ts
          ? `数据保存在本机浏览器 · 最近改动 ${ts}`
          : '数据保存在本机浏览器，刷新不会丢';
      }
    }

    function setText(el, value) {
      if (el) el.textContent = String(value);
    }

    /* ------------------------------------------------------------ 刷新 */

    function refresh(withBoard) {
      renderFilters();
      renderStats();
      if (withBoard !== false) renderBoard();
      if (els.themeToggle) {
        els.themeToggle.checked = state.prefs.theme === 'dark';
      }
    }

    function scheduleRefresh() {
      refresh(true);
    }

    /* ------------------------------------------------------------ 撕票根交互 */

    const TEAR_THRESHOLD = 34;

    function bindStubDrag(li) {
      const stub = $('[data-role="stub"]', li);
      if (!stub) return;
      let start = null;
      let moved = false;

      const onDown = (event) => {
        if (event.button != null && event.button !== 0) return;
        start = { x: event.clientX, y: event.clientY, id: event.pointerId };
        moved = false;
        li.classList.add('is-dragging');
        if (stub.setPointerCapture && event.pointerId != null) {
          try {
            stub.setPointerCapture(event.pointerId);
          } catch {
            /* 某些浏览器不支持捕获，忽略即可 */
          }
        }
      };

      const onMove = (event) => {
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
        stub.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${Math.max(-6, Math.min(6, dx * 0.06))}deg)`;
        li.style.setProperty('--tear', String(Math.min(1, Math.abs(dy) / TEAR_THRESHOLD)));
        if (Math.abs(dy) > TEAR_THRESHOLD) li.classList.add('is-armed');
        else li.classList.remove('is-armed');
      };

      const finish = (event, cancelled) => {
        if (!start) return;
        const dx = event && event.clientX != null ? event.clientX - start.x : 0;
        const dy = event && event.clientY != null ? event.clientY - start.y : 0;
        const far = Math.abs(dy) > TEAR_THRESHOLD;
        start = null;
        li.classList.remove('is-dragging', 'is-armed');
        if (cancelled) {
          stub.style.transform = '';
          li.style.setProperty('--tear', '0');
          return;
        }
        if (far) {
          tearOff(li, stub, Math.sign(dy) || 1);
          return;
        }
        stub.style.transform = '';
        li.style.setProperty('--tear', '0');
        if (!moved) toggleTask(li.dataset.id);
        void dx;
      };

      stub.addEventListener('pointerdown', onDown);
      stub.addEventListener('pointermove', onMove);
      stub.addEventListener('pointerup', (e) => finish(e, false));
      stub.addEventListener('pointercancel', (e) => finish(e, true));
      stub.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleTask(li.dataset.id);
        }
      });
    }

    function tearOff(li, stub, direction) {
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      li.classList.add('is-tearing');
      if (reduced) {
        applyTear(li.dataset.id);
        return;
      }
      stub.style.transform = `translate3d(0, ${direction * 140}%, 0) rotate(${direction * 12}deg)`;
      li.style.setProperty('--tear', '1');
      setTimeout(() => applyTear(li.dataset.id), 360);
    }

    function applyTear(id) {
      const target = state.tasks.find((t) => t.id === id);
      if (!target) return;
      const result = core.toggleTask(state, id, now());
      const willBeDone = !target.done;
      commit(result, willBeDone ? '已撕下票根 · 完成' : '票根贴回 · 恢复未完成', { undo: true, full: true });
    }

    function toggleTask(id) {
      const target = state.tasks.find((t) => t.id === id);
      if (!target) return;
      const next = core.toggleTask(state, id, now());
      commit(next, target.done ? '已恢复未完成' : '已标记完成', { undo: true });
    }

    function flashCard(id) {
      requestAnimationFrame(() => {
        const li = els.list && els.list.querySelector(`[data-id="${id}"]`);
        if (!li) return;
        li.classList.add('is-new');
        setTimeout(() => li.classList.remove('is-new'), 900);
        li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }

    /* ------------------------------------------------------------ 编辑对话框 */

    function openEditor(task) {
      const dialog = $('#edit-dialog');
      if (!dialog || typeof dialog.showModal !== 'function') return;
      const form = $('#edit-form');
      form.dataset.id = task.id;
      $('#e-title').value = task.title;
      $('#e-desc').value = task.desc;
      $('#e-due').value = task.due || '';
      $('#e-category').value = task.category;
      renderPriorityInputs($('#e-priority'));
      $$('#e-priority input').forEach((input) => {
        input.checked = input.value === task.priority;
      });
      $('#e-error').hidden = true;
      dialog.showModal();
      $('#e-title').focus();
    }

    function submitEditor(event) {
      event.preventDefault();
      const form = $('#edit-form');
      const id = form.dataset.id;
      const title = $('#e-title').value.trim();
      const error = $('#e-error');
      if (!title) {
        error.textContent = '标题不能为空';
        error.hidden = false;
        return;
      }
      const due = $('#e-due').value;
      if (due && !core.isValidDate(due)) {
        error.textContent = '截止日期格式不对';
        error.hidden = false;
        return;
      }
      const patch = {
        title,
        desc: $('#e-desc').value,
        due,
        category: $('#e-category').value.trim() || '未分类',
        priority: ($$('#e-priority input:checked')[0] || {}).value || 'normal',
      };
      const next = core.withTask(state, id, patch, now());
      $('#edit-dialog').close();
      commit(next, '已保存改动', { undo: true });
      flashCard(id);
    }

    /* ------------------------------------------------------------ 确认框 / 提示 */

    function askConfirm(title, desc, onOk) {
      confirmAction = onOk;
      if (els.confirmTitle) els.confirmTitle.textContent = title;
      if (els.confirmDesc) els.confirmDesc.textContent = desc;
      if (els.confirmDialog && typeof els.confirmDialog.showModal === 'function') {
        els.confirmDialog.showModal();
      } else if (window.confirm(`${title}\n${desc}`)) {
        onOk();
      }
    }

    function askDelete(task) {
      askConfirm('删除这条待办？', `「${task.title}」将从本地存储里移除，删掉之后可以用底部提示里的「撤销」找回。`, () => {
        commit(core.removeTask(state, task.id, now()), '已删除', { undo: true });
      });
    }

    function showToast(message, action) {
      if (!els.toast) return;
      els.toastText.textContent = message;
      toastUndo = typeof action === 'function' ? action : null;
      els.toastAction.hidden = !toastUndo;
      els.toast.hidden = false;
      els.toast.dataset.show = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, toastUndo ? 7000 : 2600);
    }

    function hideToast() {
      if (!els.toast) return;
      els.toast.dataset.show = '0';
      els.toast.hidden = true;
    }

    /* ------------------------------------------------------------ 导入导出 */

    function download(filename, text, type) {
      const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function stamp() {
      const d = now();
      return `${d.getFullYear()}${core.pad2(d.getMonth() + 1)}${core.pad2(d.getDate())}-${core.pad2(d.getHours())}${core.pad2(
        d.getMinutes()
      )}`;
    }

    function importFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = core.fromJSON(String(reader.result));
        } catch (err) {
          showToast(`导入失败：${err.message}`, null);
          return;
        }
        const next = core.createState({
          tasks: parsed.tasks.concat(state.tasks),
          categories: state.categories.concat(parsed.categories),
          filters: state.filters,
          prefs: state.prefs,
          updatedAt: Date.now(),
        });
        commit(next, `已导入 ${parsed.tasks.length} 条待办`, { snapshot: true, undo: true });
      };
      reader.onerror = () => showToast('读取文件失败', null);
      reader.readAsText(file, 'utf-8');
    }

    function loadDemo() {
      const today = core.todayISO(now());
      const demo = [
        { title: '把季度复盘写成三页纸', desc: '结论放第一页，数据放第二页，下周计划放第三页。', due: today, priority: 'urgent', category: '工作' },
        { title: '给接口补上失败重试', desc: '超时 3 次退避重试，失败写进日志。', due: core.shiftISO(2, now()), priority: 'high', category: '工作' },
        { title: '读完《重构》第 6 章', desc: '把书里的例子敲一遍，记在笔记里。', due: core.shiftISO(5, now()), priority: 'normal', category: '学习' },
        { title: '预约牙科检查', desc: '', due: core.shiftISO(-2, now()), priority: 'high', category: '生活' },
        { title: '整理书架', desc: '按主题分组，闲书收进箱子。', due: '', priority: 'low', category: '生活', done: true },
        { title: '跑一次 5 公里', desc: '傍晚沿河堤，配速不重要。', due: core.shiftISO(-1, now()), priority: 'normal', category: '生活', done: true },
      ];
      const date = now();
      let next = state;
      demo.forEach((item, i) => {
        const created = date.getTime() - (demo.length - i) * 3600000;
        const res = core.addTask(next, Object.assign({}, item, { createdAt: created }), date);
        next = res.state;
        if (item.done) {
          next = core.withTask(next, res.task.id, { done: true }, date);
        }
      });
      commit(next, '示例数据已铺好', { undo: true });
    }

    /* ------------------------------------------------------------ 事件绑定 */

    function bind() {
      if (els.form) els.form.addEventListener('submit', submitForm);
      if (els.reset) {
        els.reset.addEventListener('click', () => {
          clearForm(true);
          showToast('表单已清空', null);
        });
      }
      ['input', 'change'].forEach((ev) => {
        els.title && els.title.addEventListener(ev, updateCounters);
        els.desc && els.desc.addEventListener(ev, updateCounters);
      });

      if (els.search) {
        let debounce = 0;
        els.search.addEventListener('input', () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => {
            state = core.setFilter(state, { query: els.search.value });
            persist();
            refresh(true);
          }, 120);
        });
      }
      if (els.searchClear) {
        els.searchClear.addEventListener('click', () => {
          els.search.value = '';
          state = core.setFilter(state, { query: '' });
          persist();
          refresh(true);
          els.search.focus();
        });
      }
      if (els.sort) {
        els.sort.addEventListener('change', () => {
          state = core.setFilter(state, { sort: els.sort.value });
          persist();
          refresh(true);
        });
      }
      if (els.filterReset) {
        els.filterReset.addEventListener('click', () => {
          commit(core.resetFilters(state), '筛选条件已清空', { snapshot: false });
          if (els.search) els.search.value = '';
        });
      }

      // 工具栏里的筛选按钮统一走事件委托，列表重绘也不会丢
      document.addEventListener('click', (event) => {
        const seg = event.target.closest && event.target.closest('.seg');
        if (seg && els.statusBar && els.statusBar.contains(seg)) {
          state = core.setFilter(state, { status: seg.dataset.status });
          persist();
          refresh(true);
          return;
        }
        const chip = event.target.closest && event.target.closest('.chip[data-filter-key]');
        if (chip) {
          const key = chip.dataset.filterKey;
          const value = chip.dataset.filterValue;
          state = core.toggleFilterValue(state, key, value);
          persist();
          refresh(true);
          return;
        }
        const preset = event.target.closest && event.target.closest('[data-preset-status]');
        if (preset) {
          state = core.setFilter(state, { status: preset.dataset.presetStatus, categories: [], priorities: [], query: '' });
          persist();
          refresh(true);
        }
      });

      if (els.clearDone) {
        els.clearDone.addEventListener('click', () => {
          const done = state.tasks.filter((t) => t.done).length;
          if (!done) return;
          askConfirm('清空已完成？', `${done} 条已完成的待办会从列表里移除。`, () => {
            commit(core.clearCompleted(state, now()), `已移除 ${done} 条完成的待办`, { undo: true });
          });
        });
      }

      if (els.emptyAction) {
        els.emptyAction.addEventListener('click', () => {
          if (els.emptyAction.dataset.mode === 'reset') {
            commit(core.resetFilters(state), '筛选条件已清空', { snapshot: false });
            if (els.search) els.search.value = '';
          } else {
            els.title.focus();
          }
        });
      }

      if (els.confirmOk) {
        els.confirmOk.addEventListener('click', () => {
          const fn = confirmAction;
          confirmAction = null;
          els.confirmDialog.close();
          if (fn) fn();
        });
      }

      const editForm = $('#edit-form');
      if (editForm) editForm.addEventListener('submit', submitEditor);

      if (els.toastAction) {
        els.toastAction.addEventListener('click', () => {
          const fn = toastUndo;
          hideToast();
          if (fn) fn();
        });
      }

      // 键盘：n 新任务、/ 搜索、Esc 收起提示、Ctrl/⌘+Z 撤销
      document.addEventListener('keydown', (event) => {
        const tag = (event.target && event.target.tagName) || '';
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (event.target && event.target.isContentEditable);
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !typing) {
          event.preventDefault();
          undo();
          return;
        }
        if (typing) return;
        if (event.key === 'n') {
          event.preventDefault();
          els.title.focus();
        } else if (event.key === '/') {
          event.preventDefault();
          els.search.focus();
        } else if (event.key === 'Escape') {
          hideToast();
        }
      });

      if (els.themeToggle) {
        els.themeToggle.addEventListener('change', () => {
          state = Object.assign({}, state, {
            prefs: Object.assign({}, state.prefs, { theme: els.themeToggle.checked ? 'dark' : 'light' }),
          });
          applyTheme();
          persist();
          showToast(els.themeToggle.checked ? '已切到夜间' : '已切回白天', null);
        });
      }

      if (els.exportJSON) {
        els.exportJSON.addEventListener('click', () => {
          download(`待办备份-${stamp()}.json`, core.toJSON(state), 'application/json');
        });
      }
      if (els.exportCSV) {
        els.exportCSV.addEventListener('click', () => {
          download(`待办表格-${stamp()}.csv`, core.toCSV(state), 'text/csv;charset=utf-8');
        });
      }
      if (els.importButton && els.importInput) {
        els.importButton.addEventListener('click', () => els.importInput.click());
        els.importInput.addEventListener('change', () => {
          const file = els.importInput.files && els.importInput.files[0];
          if (file) importFile(file);
          els.importInput.value = '';
        });
      }
      if (els.demoButton) els.demoButton.addEventListener('click', loadDemo);
      if (els.notifyButton) els.notifyButton.addEventListener('click', requestNotifications);
    }

    /* ------------------------------------------------------------ 到期提醒（可选） */

    function requestNotifications() {
      if (!('Notification' in window)) {
        showToast('这个浏览器不支持桌面提醒', null);
        return;
      }
      if (Notification.permission === 'granted') {
        notifyDue();
        return;
      }
      Notification.requestPermission().then((permission) => {
        if (permission === 'granted') notifyDue();
        else showToast('没有拿到提醒权限，只影响桌面通知', null);
      });
    }

    function notifyDue() {
      const date = now();
      const due = state.tasks.filter((t) => !t.done && core.isOverdue(t, date));
      const today = state.tasks.filter((t) => !t.done && t.due === core.todayISO(date));
      const total = due.length + today.length;
      if (!total) {
        showToast('今天没有到期和逾期的待办', null);
        return;
      }
      const body = `${due.length ? `${due.length} 条已逾期` : ''}${due.length && today.length ? '，' : ''}${
        today.length ? `${today.length} 条今天到期` : ''
      }`;
      try {
        new Notification('案头待办 · 该动手了', { body });
      } catch {
        /* 有些环境禁止直接构造通知，忽略 */
      }
      showToast(body, null);
    }

    /* ------------------------------------------------------------ 主题 */

    function applyTheme() {
      document.documentElement.dataset.theme = state.prefs.theme === 'dark' ? 'dark' : 'light';
      if (els.themeToggle) els.themeToggle.checked = state.prefs.theme === 'dark';
    }

    /* ------------------------------------------------------------ 列表事件委托 */

    /** 撕票根的拖拽要绑在元素上，所以每次重绘后给新出现的卡片补一次绑定 */
    function attachStubHandlers() {
      if (!els.list) return;
      $$('li.task', els.list).forEach((li) => {
        if (li.dataset.bound === '1') return;
        li.dataset.bound = '1';
        bindStubDrag(li);
      });
    }

    /* ------------------------------------------------------------ 启动 */

    function start() {
      renderSelectors();
      renderDueQuick();
      updateCounters();
      applyTheme();
      refresh(true);
      bind();
      if (opts.demo && state.tasks.length === 0) loadDemo();
      if (els.busyBar) els.busyBar.hidden = true;
    }

    const api = {
      start,
      get state() {
        return state;
      },
      refresh: scheduleRefresh,
      showToast,
      undo,
      attachStubHandlers,
    };
    return api;
  }

  global.TodoUI = { createApp };
})(typeof window !== 'undefined' ? window : globalThis);
