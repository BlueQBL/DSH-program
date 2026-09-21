/*!
 * 案头待办 · 数据核心（core.js）
 * 纯逻辑，不碰 DOM：可在浏览器和 Node 里同时运行。
 * 浏览器挂到 window.TodoCore，Node 走 module.exports。
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (root) root.TodoCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'todo-app/v1';
  const SCHEMA_VERSION = 1;
  const MAX_TITLE = 80;
  const MAX_DESC = 500;
  const MAX_CATEGORY = 16;
  const MAX_SUBTASK = 60;
  const MAX_SUBTASKS = 50;
  const UNDO_LIMIT = 10;

  const PRIORITIES = [
    { value: 'urgent', label: '紧急', rank: 0 },
    { value: 'high', label: '高', rank: 1 },
    { value: 'normal', label: '中', rank: 2 },
    { value: 'low', label: '低', rank: 3 },
  ];
  const PRIORITY_RANK = PRIORITIES.reduce((acc, p) => ((acc[p.value] = p.rank), acc), {});
  const STATUSES = [
    { value: 'all', label: '全部' },
    { value: 'active', label: '未完成' },
    { value: 'done', label: '已完成' },
    { value: 'overdue', label: '已逾期' },
  ];
  const SORTS = [
    { value: 'smart', label: '智能排序' },
    { value: 'due', label: '按截止日期' },
    { value: 'priority', label: '按优先级' },
    { value: 'created', label: '按创建时间' },
    { value: 'title', label: '按标题' },
  ];
  const DEFAULT_CATEGORIES = ['工作', '学习', '生活'];
  const CATEGORY_PALETTE = ['#1F6F78', '#C08A2B', '#5B4BA6', '#2F6B3F', '#B0436A', '#3A6EA5', '#8A5A2B', '#6B6F45'];

  const DONE_RETENTION_DAYS = 14;

  /* ---------------------------------------------------------------- 基础工具 */

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toISODate(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function todayISO(now) {
    return toISODate(now instanceof Date ? now : new Date());
  }

  /** 'YYYY-MM-DD' → 本地零点的毫秒数；不合法返回 NaN（刻意不走 Date.parse，避免时区漂移） */
  function parseDate(str) {
    if (typeof str !== 'string') return NaN;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
    if (!m) return NaN;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return NaN;
    return dt.getTime();
  }

  function isValidDate(str) {
    return !Number.isNaN(parseDate(str));
  }

  function addDays(dateStr, days) {
    const t = parseDate(dateStr);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  }

  /** 今天 + offset 天的 ISO 日期 */
  function shiftISO(offset, now) {
    const t = parseDate(todayISO(now));
    const d = new Date(t);
    d.setDate(d.getDate() + offset);
    return toISODate(d);
  }

  /** 两个日期相差几天：a - b，按本地日历日算 */
  function diffDays(aISO, bISO) {
    const a = parseDate(aISO);
    const b = parseDate(bISO);
    if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
    return Math.round((a - b) / 86400000);
  }

  /** 距离某个截止日期还有几天：截止日 − 今天。正数=还没到，0=今天，负数=已逾期 */
  function daysUntil(dueISO, now) {
    if (!isValidDate(dueISO)) return NaN;
    return diffDays(dueISO, todayISO(now));
  }

  function isOverdue(task, now) {
    if (!task || task.done) return false;
    const days = daysUntil(task.due, now);
    return !Number.isNaN(days) && days < 0;
  }

  /** 逾期/剩余天数的人话说法 */
  function dueLabel(dueISO, now) {
    if (!isValidDate(dueISO)) return { text: '无截止日期', tone: 'none', days: null };
    const days = daysUntil(dueISO, now);
    if (days === 0) return { text: '今天到期', tone: 'today', days };
    if (days === 1) return { text: '明天到期', tone: 'soon', days };
    if (days === -1) return { text: '逾期 1 天', tone: 'overdue', days };
    if (days < 0) return { text: `逾期 ${-days} 天`, tone: 'overdue', days };
    if (days <= 3) return { text: `${days} 天后到期`, tone: 'soon', days };
    return { text: dueISO.slice(5).replace('-', '/') + ' 到期', tone: 'later', days };
  }

  let seq = 0;
  function uid() {
    seq += 1;
    return 't' + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function clamp(str, max) {
    return String(str == null ? '' : str).slice(0, max);
  }

  function normalizePriority(value) {
    return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value) ? value : 'normal';
  }

  function priorityLabel(value) {
    const found = PRIORITIES.find((p) => p.value === value);
    return found ? found.label : '中';
  }

  function priorityRank(value) {
    return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, value) ? PRIORITY_RANK[value] : 99;
  }

  /* ---------------------------------------------------------------- 任务构造 */

  function createTask(input, now) {
    const src = input || {};
    const iso = now instanceof Date ? now : new Date();
    const title = clamp(src.title, MAX_TITLE).trim();
    if (!title) throw new Error('标题不能为空');
    const due = isValidDate(src.due) ? src.due : '';
    return {
      id: src.id || uid(),
      title,
      desc: clamp(src.desc, MAX_DESC).trim(),
      due,
      priority: normalizePriority(src.priority),
      category: clamp(src.category, MAX_CATEGORY).trim() || '未分类',
      subtasks: sanitizeSubtasks(src.subtasks),
      done: Boolean(src.done),
      createdAt: typeof src.createdAt === 'number' ? src.createdAt : iso.getTime(),
      updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : iso.getTime(),
      completedAt: typeof src.completedAt === 'number' ? src.completedAt : null,
    };
  }

  /* ---------------------------------------------------------------- 子任务 */

  function createSubtask(input) {
    const src = typeof input === 'string' ? { title: input } : input || {};
    const title = clamp(src.title, MAX_SUBTASK).trim();
    if (!title) throw new Error('子任务标题不能为空');
    return {
      id: src.id || uid(),
      title,
      done: Boolean(src.done),
      createdAt: typeof src.createdAt === 'number' ? src.createdAt : Date.now(),
      completedAt: typeof src.completedAt === 'number' ? src.completedAt : null,
    };
  }

  /** 清洗子任务列表：丢掉空标题、拆开重复 id、限制条数 */
  function sanitizeSubtasks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      if (typeof item !== 'string' && (typeof item !== 'object' || item === null)) continue;
      let sub;
      try {
        sub = createSubtask(item);
      } catch {
        continue;
      }
      if (seen.has(sub.id)) sub.id = uid();
      seen.add(sub.id);
      out.push(sub);
      if (out.length >= MAX_SUBTASKS) break;
    }
    return out;
  }

  function findSubtask(task, subtaskId) {
    return (task && task.subtasks ? task.subtasks : []).find((s) => s.id === subtaskId) || null;
  }

  /** 某个任务的子任务进度：{total, done, active, rate, allDone, has} */
  function subtaskProgress(task) {
    const list = (task && task.subtasks) || [];
    const total = list.length;
    const done = list.filter((s) => s.done).length;
    return {
      total,
      done,
      active: total - done,
      rate: total === 0 ? 0 : Math.round((done / total) * 100),
      allDone: total > 0 && done === total,
      has: total > 0,
      next: list.find((s) => !s.done) || null,
    };
  }

  function countSubtasks(tasks) {
    let total = 0;
    let done = 0;
    let withSubtasks = 0;
    (tasks || []).forEach((t) => {
      const p = subtaskProgress(t);
      if (!p.has) return;
      withSubtasks += 1;
      total += p.total;
      done += p.done;
    });
    return { total, done, active: total - done, withSubtasks, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  function addSubtask(state, taskId, input, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return { state, subtask: null };
    const list = task.subtasks || [];
    if (list.length >= MAX_SUBTASKS) return { state, subtask: null };
    let subtask;
    try {
      subtask = createSubtask(typeof input === 'string' ? { title: input, createdAt: iso.getTime() } : Object.assign({ createdAt: iso.getTime() }, input));
    } catch {
      return { state, subtask: null };
    }
    const subtasks = list.concat([subtask]);
    const next = withTask(state, taskId, { subtasks }, iso);
    return { state: next, subtask: next === state ? null : subtask };
  }

  function updateSubtask(state, taskId, subtaskId, patch, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = state.tasks.find((t) => t.id === taskId);
    const target = findSubtask(task, subtaskId);
    if (!target) return state;
    const next = Object.assign({}, target, patch);
    // 只有调用方显式给了 title 才动标题，且空标题不会把原名冲掉
    if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
      const clean = clamp(next.title, MAX_SUBTASK).trim();
      if (clean) next.title = clean;
      else next.title = target.title;
    }
    next.done = Boolean(next.done);
    next.completedAt = next.done ? target.completedAt || iso.getTime() : null;
    const subtasks = task.subtasks.map((s) => (s.id === subtaskId ? next : s));
    return withTask(state, taskId, { subtasks }, iso);
  }

  function removeSubtask(state, taskId, subtaskId, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!findSubtask(task, subtaskId)) return state;
    return withTask(state, taskId, { subtasks: task.subtasks.filter((s) => s.id !== subtaskId) }, iso);
  }

  function toggleSubtask(state, taskId, subtaskId, now) {
    const target = findSubtask(state.tasks.find((t) => t.id === taskId), subtaskId);
    if (!target) return state;
    return updateSubtask(state, taskId, subtaskId, { done: !target.done }, now);
  }

  function clearDoneSubtasks(state, taskId, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !subtaskProgress(task).done) return state;
    return withTask(state, taskId, { subtasks: (task.subtasks || []).filter((s) => !s.done) }, iso);
  }

  /** 一键把某个任务的所有子任务标记为完成 / 未完成 */
  function setAllSubtasks(state, taskId, done, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || !subtaskProgress(task).has) return state;
    const subtasks = (task.subtasks || []).map((s) =>
      Object.assign({}, s, {
        done: Boolean(done),
        completedAt: done ? s.completedAt || iso.getTime() : null,
      })
    );
    return withTask(state, taskId, { subtasks }, iso);
  }

  /** 全部子任务都完成时，顺手把大任务也标记完成（只在"完成"方向生效） */
  function applySubtaskMomentum(state, taskId, now) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.done) return state;
    if (!subtaskProgress(task).allDone) return state;
    return withTask(state, taskId, { done: true }, now);
  }

  /* ---------------------------------------------------------------- 存储适配 */

  function hasLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' && localStorage !== null;
    } catch {
      return false;
    }
  }

  /** 内存兜底：隐私模式 / 浏览器禁用存储时应用依然可用，只是刷新后不保留 */
  function memoryStorage() {
    const map = new Map();
    return {
      ephemeral: true,
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, String(v)),
      removeItem: (k) => void map.delete(k),
    };
  }

  function resolveStorage(injected) {
    if (injected) return injected;
    if (hasLocalStorage()) return localStorage;
    return memoryStorage();
  }

  /* ---------------------------------------------------------------- 状态与持久化 */

  function createState(overrides) {
    const o = overrides || {};
    return {
      version: SCHEMA_VERSION,
      tasks: Array.isArray(o.tasks) ? o.tasks : [],
      categories: Array.isArray(o.categories) && o.categories.length ? o.categories.slice(0, 24) : DEFAULT_CATEGORIES.slice(),
      filters: Object.assign(
        { query: '', categories: [], priorities: [], status: 'all', sort: 'smart' },
        o.filters || {}
      ),
      prefs: Object.assign({ theme: 'light', showDone: true }, o.prefs || {}),
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : null,
    };
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      let task;
      try {
        task = createTask(item);
      } catch {
        continue; // 标题为空的脏数据直接丢掉，不让它污染整个列表
      }
      if (seen.has(task.id)) task.id = uid();
      seen.add(task.id);
      out.push(task);
    }
    return out;
  }

  function sanitizeCategories(raw, tasks) {
    const list = [];
    const push = (name) => {
      const clean = clamp(name, MAX_CATEGORY).trim();
      if (clean && !list.includes(clean)) list.push(clean);
    };
    (Array.isArray(raw) ? raw : []).forEach(push);
    if (!list.length) DEFAULT_CATEGORIES.forEach(push);
    // 任务里出现过但没登记的分类，自动补进来，避免筛选项丢标签
    tasks.forEach((t) => push(t.category));
    return list.slice(0, 24);
  }

  function load(storage) {
    const store = resolveStorage(storage);
    let parsed = null;
    try {
      const raw = store.getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch {
      parsed = null; // 存储里是坏 JSON 时当作空库，而不是整个白屏
    }
    if (!parsed || typeof parsed !== 'object') return createState();

    const tasks = sanitizeTasks(parsed.tasks);
    const state = createState({
      tasks,
      categories: sanitizeCategories(parsed.categories, tasks),
      filters: parsed.filters,
      prefs: parsed.prefs,
      updatedAt: parsed.updatedAt,
    });
    state.filters.status = STATUSES.some((s) => s.value === state.filters.status) ? state.filters.status : 'all';
    state.filters.sort = SORTS.some((s) => s.value === state.filters.sort) ? state.filters.sort : 'smart';
    state.filters.categories = asStringArray(state.filters.categories);
    state.filters.priorities = asStringArray(state.filters.priorities).filter((p) => priorityRank(p) < 90);
    state.filters.query = clamp(state.filters.query, 120);
    if (state.prefs.theme !== 'dark') state.prefs.theme = 'light';
    return state;
  }

  function asStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value.filter((v) => typeof v === 'string').slice(0, 24);
  }

  function save(state, storage) {
    const store = resolveStorage(storage);
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false; // 配额满 / 存储被禁用：不抛错，界面照常用
    }
  }

  function clear(storage) {
    const store = resolveStorage(storage);
    try {
      store.removeItem(STORAGE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- 统计 */

  function computeStats(tasks, now) {
    const iso = todayISO(now);
    const total = tasks.length;
    const done = tasks.filter((t) => t.done).length;
    const active = total - done;
    const overdue = tasks.filter((t) => isOverdue(t, now)).length;
    const today = tasks.filter((t) => !t.done && t.due === iso).length;
    const upcoming = tasks.filter((t) => !t.done && t.due && daysUntil(t.due, now) > 0 && daysUntil(t.due, now) <= 7).length;

    const byCategory = [];
    const catMap = new Map();
    const byPriority = [];
    const priMap = new Map();
    PRIORITIES.forEach((p) => priMap.set(p.value, { value: p.value, label: p.label, total: 0, done: 0, active: 0, overdue: 0 }));

    tasks.forEach((t) => {
      if (!catMap.has(t.category)) catMap.set(t.category, { name: t.category, total: 0, done: 0, active: 0, overdue: 0 });
      const cat = catMap.get(t.category);
      cat.total += 1;
      if (t.done) cat.done += 1;
      else cat.active += 1;
      if (isOverdue(t, now)) cat.overdue += 1;

      const pri = priMap.get(t.priority);
      if (pri) {
        pri.total += 1;
        if (t.done) pri.done += 1;
        else pri.active += 1;
        if (isOverdue(t, now)) pri.overdue += 1;
      }
    });

    catMap.forEach((c) => byCategory.push(c));
    byCategory.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'));
    priMap.forEach((p) => byPriority.push(p));

    const st = countSubtasks(tasks);

    return {
      total,
      done,
      active,
      overdue,
      today,
      upcoming,
      rate: total === 0 ? 0 : Math.round((done / total) * 100),
      subtasks: st,
      byCategory,
      byPriority,
    };
  }

  /** 最近 N 天每天完成了多少（用于签条上的 14 格打卡条） */
  function completionSeries(tasks, days, now) {
    const n = Math.max(1, days || 14);
    const iso = todayISO(now);
    const buckets = [];
    const index = new Map();
    for (let i = n - 1; i >= 0; i -= 1) {
      const date = shiftISO(-i, now);
      const bucket = { date, count: 0, iso };
      index.set(date, bucket);
      buckets.push(bucket);
    }
    tasks.forEach((t) => {
      if (!t.done || typeof t.completedAt !== 'number') return;
      const key = toISODate(new Date(t.completedAt));
      const bucket = index.get(key);
      if (bucket) bucket.count += 1;
    });
    return buckets;
  }

  /** 连续完成天数：从今天（或昨天）往前数，有完成记录就不断 */
  function streak(tasks, now) {
    const series = completionSeries(tasks, 400, now);
    let count = 0;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      if (series[i].count > 0) count += 1;
      else if (i === series.length - 1) continue; // 今天还没完成不算断
      else break;
    }
    return count;
  }

  /* ---------------------------------------------------------------- 筛选 / 搜索 / 排序 */

  function matchStatus(task, status, now) {
    switch (status) {
      case 'active':
        return !task.done;
      case 'done':
        return task.done;
      case 'overdue':
        return isOverdue(task, now);
      default:
        return true;
    }
  }

  function matchesQuery(task, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const subs = (task.subtasks || []).map((s) => s.title).join('\u0000');
    const haystack = [task.title, task.desc, task.category, priorityLabel(task.priority), task.due, subs]
      .join('\u0000')
      .toLowerCase();
    // 多关键词按 AND 处理，让「工作 报告」这类输入能收敛结果
    return q.split(/\s+/).every((term) => haystack.includes(term));
  }

  function selectTasks(state, overrides) {
    const f = Object.assign({}, state.filters, overrides || {});
    const now = f.now;
    const list = state.tasks.filter((task) => {
      if (f.categories.length && !f.categories.includes(task.category)) return false;
      if (f.priorities.length && !f.priorities.includes(task.priority)) return false;
      if (!matchStatus(task, f.status, now)) return false;
      if (!matchesQuery(task, f.query)) return false;
      return true;
    });
    return sortTasks(list, f.sort === 'smart' || !f.sort ? 'smart' : f.sort, now);
  }

  function sortTasks(list, sort, now) {
    const out = list.slice();
    const byCreatedDesc = (a, b) => b.createdAt - a.createdAt;
    switch (sort) {
      case 'due':
        out.sort(
          (a, b) =>
            compareDue(a, b) || priorityRank(a.priority) - priorityRank(b.priority) || byCreatedDesc(a, b)
        );
        break;
      case 'priority':
        out.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || compareDue(a, b) || byCreatedDesc(a, b));
        break;
      case 'created':
        out.sort(byCreatedDesc);
        break;
      case 'title':
        out.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
        break;
      default:
        // 智能：未完成 → 逾期 → 快到期 → 高优先级 排在前面
        out.sort(
          (a, b) =>
            Number(a.done) - Number(b.done) ||
            Number(isOverdue(b, now)) - Number(isOverdue(a, now)) ||
            compareDue(a, b) ||
            priorityRank(a.priority) - priorityRank(b.priority) ||
            byCreatedDesc(a, b)
        );
    }
    return out;
  }

  /** 比较截止日期：没有日期的排到最后（不能返回 NaN，否则排序会变得不稳定） */
  function compareDue(a, b) {
    const av = a.due ? parseDate(a.due) : NaN;
    const bv = b.due ? parseDate(b.due) : NaN;
    const an = Number.isNaN(av) ? Infinity : av;
    const bn = Number.isNaN(bv) ? Infinity : bv;
    return an - bn;
  }

  /* ---------------------------------------------------------------- 纯函数式变更 */

  function withTask(state, id, patch, now) {
    const iso = now instanceof Date ? now : new Date();
    let touched = false;
    const tasks = state.tasks.map((t) => {
      if (t.id !== id) return t;
      touched = true;
      const next = Object.assign({}, t, patch);
      next.title = clamp(next.title, MAX_TITLE).trim() || t.title;
      next.desc = clamp(next.desc, MAX_DESC).trim();
      next.category = clamp(next.category, MAX_CATEGORY).trim() || '未分类';
      next.due = isValidDate(next.due) ? next.due : '';
      next.priority = normalizePriority(next.priority);
      next.subtasks = sanitizeSubtasks(next.subtasks);
      next.done = Boolean(next.done);
      next.completedAt = next.done ? t.completedAt || iso.getTime() : null;
      next.updatedAt = iso.getTime();
      return next;
    });
    if (!touched) return state;
    return Object.assign({}, state, {
      tasks,
      categories: sanitizeCategories(state.categories, tasks),
      updatedAt: iso.getTime(),
    });
  }

  function addTask(state, input, now) {
    const iso = now instanceof Date ? now : new Date();
    const task = createTask(Object.assign({}, input, { createdAt: iso.getTime(), updatedAt: iso.getTime() }), iso);
    const tasks = [task].concat(state.tasks);
    return {
      state: Object.assign({}, state, {
        tasks,
        categories: sanitizeCategories(state.categories.concat([task.category]), tasks),
        updatedAt: iso.getTime(),
      }),
      task,
    };
  }

  function removeTask(state, id, now) {
    const iso = now instanceof Date ? now : new Date();
    const tasks = state.tasks.filter((t) => t.id !== id);
    if (tasks.length === state.tasks.length) return state;
    return Object.assign({}, state, { tasks, updatedAt: iso.getTime() });
  }

  function toggleTask(state, id, now) {
    const target = state.tasks.find((t) => t.id === id);
    if (!target) return state;
    return withTask(state, id, { done: !target.done }, now);
  }

  function duplicateTask(state, id, now) {
    const target = state.tasks.find((t) => t.id === id);
    if (!target) return state;
    const copy = Object.assign({}, target, { id: uid(), done: false, completedAt: null });
    copy.title = clamp(copy.title, MAX_TITLE - 5) + ' 副本';
    // 子任务也要换新 id：副本里的每一步都是独立的，不能和原件共用一个身份
    copy.subtasks = (target.subtasks || []).map((s) => Object.assign({}, s, { id: uid() }));
    return addTask(state, copy, now).state;
  }

  function clearCompleted(state, now) {
    const iso = now instanceof Date ? now : new Date();
    const tasks = state.tasks.filter((t) => !t.done);
    if (tasks.length === state.tasks.length) return state;
    return Object.assign({}, state, { tasks, updatedAt: iso.getTime() });
  }

  function setFilter(state, patch) {
    return Object.assign({}, state, { filters: Object.assign({}, state.filters, patch) });
  }

  function toggleFilterValue(state, key, value) {
    const current = Array.isArray(state.filters[key]) ? state.filters[key] : [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : current.concat([value]);
    return setFilter(state, { [key]: next });
  }

  function resetFilters(state) {
    return setFilter(state, { query: '', categories: [], priorities: [], status: 'all', sort: 'smart' });
  }

  function addCategory(state, name) {
    const clean = clamp(name, MAX_CATEGORY).trim();
    if (!clean || state.categories.includes(clean)) return state;
    return Object.assign({}, state, { categories: state.categories.concat([clean]) });
  }

  function removeCategory(state, name) {
    const tasks = state.tasks.map((t) => (t.category === name ? Object.assign({}, t, { category: '未分类' }) : t));
    const categories = state.categories.filter((c) => c !== name);
    if (!categories.includes('未分类') && tasks.some((t) => t.category === '未分类')) categories.push('未分类');
    return Object.assign({}, state, {
      tasks,
      categories,
      filters: setFilter(state, { categories: state.filters.categories.filter((c) => c !== name) }).filters,
    });
  }

  /** 给分类分配一个稳定颜色（按分类在列表中的序号取色） */
  function categoryColor(state, name) {
    const i = state.categories.indexOf(name);
    return CATEGORY_PALETTE[(i < 0 ? 7 : i) % CATEGORY_PALETTE.length];
  }

  function filtersActive(state) {
    const f = state.filters;
    return Boolean(f.query || f.categories.length || f.priorities.length || f.status !== 'all');
  }

  /* ---------------------------------------------------------------- 导入 / 导出 */

  function toJSON(state) {
    return JSON.stringify(
      { version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tasks: state.tasks, categories: state.categories },
      null,
      2
    );
  }

  function fromJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('不是合法的 JSON 文件');
    }
    const rawTasks = Array.isArray(parsed) ? parsed : parsed && parsed.tasks;
    if (!Array.isArray(rawTasks)) throw new Error('文件里没有 tasks 列表');
    const tasks = sanitizeTasks(rawTasks);
    if (!tasks.length) throw new Error('文件里没有可导入的任务');
    return { tasks, categories: sanitizeCategories(parsed && parsed.categories, tasks) };
  }

  function toCSV(state) {
    const head = ['标题', '描述', '截止日期', '优先级', '分类', '状态', '子任务', '创建时间', '完成时间'];
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const subs = (t) =>
      (t.subtasks || [])
        .map((s) => (s.done ? `[x] ${s.title}` : `[ ] ${s.title}`))
        .join(' | ');
    const rows = state.tasks.map((t) =>
      [
        t.title,
        t.desc,
        t.due,
        priorityLabel(t.priority),
        t.category,
        t.done ? '已完成' : '未完成',
        subs(t),
        new Date(t.createdAt).toLocaleString('zh-CN'),
        t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '',
      ]
        .map(esc)
        .join(',')
    );
    return '\ufeff' + [head.map(esc).join(','), ...rows].join('\r\n');
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    MAX_TITLE,
    MAX_DESC,
    MAX_CATEGORY,
    MAX_SUBTASK,
    MAX_SUBTASKS,
    UNDO_LIMIT,
    DONE_RETENTION_DAYS,
    PRIORITIES,
    STATUSES,
    SORTS,
    DEFAULT_CATEGORIES,
    CATEGORY_PALETTE,
    // 工具
    pad2,
    toISODate,
    todayISO,
    parseDate,
    isValidDate,
    addDays,
    shiftISO,
    diffDays,
    daysUntil,
    isOverdue,
    dueLabel,
    uid,
    clamp,
    normalizePriority,
    priorityLabel,
    priorityRank,
    // 状态
    createState,
    load,
    save,
    clear,
    resolveStorage,
    memoryStorage,
    // 变更
    addTask,
    createTask,
    withTask,
    removeTask,
    toggleTask,
    duplicateTask,
    clearCompleted,
    setFilter,
    toggleFilterValue,
    resetFilters,
    addCategory,
    removeCategory,
    // 子任务
    createSubtask,
    sanitizeSubtasks,
    subtaskProgress,
    countSubtasks,
    findSubtask,
    addSubtask,
    updateSubtask,
    removeSubtask,
    toggleSubtask,
    clearDoneSubtasks,
    setAllSubtasks,
    applySubtaskMomentum,
    // 查询
    selectTasks,
    sortTasks,
    matchesQuery,
    matchStatus,
    computeStats,
    completionSeries,
    streak,
    categoryColor,
    filtersActive,
    // 交换
    toJSON,
    fromJSON,
    toCSV,
  };
});
