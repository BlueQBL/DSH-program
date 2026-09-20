/* ═══════════════════════════════════════════════════════════════
   流水账 · 数据层
   ───────────────────────────────────────────────────────────────
   金额一律以「分」为整数存储，避免浮点误差。
   全部数据存在浏览器 localStorage，键名 ledger.v1，不上传任何服务器。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var KEY = 'ledger.v1';
  var VERSION = 1;

  /* ── 默认分类 ────────────────────────────────────────────── */
  var DEFAULT_CATEGORIES = [
    { id: 'e-food',    name: '餐饮', type: 'expense' },
    { id: 'e-traffic', name: '交通', type: 'expense' },
    { id: 'e-shop',    name: '购物', type: 'expense' },
    { id: 'e-home',    name: '居住', type: 'expense' },
    { id: 'e-phone',   name: '通讯', type: 'expense' },
    { id: 'e-health',  name: '医疗', type: 'expense' },
    { id: 'e-fun',     name: '娱乐', type: 'expense' },
    { id: 'e-study',   name: '学习', type: 'expense' },
    { id: 'e-social',  name: '人情', type: 'expense' },
    { id: 'e-other',   name: '其他', type: 'expense' },
    { id: 'i-salary',  name: '工资', type: 'income' },
    { id: 'i-bonus',   name: '奖金', type: 'income' },
    { id: 'i-side',    name: '兼职', type: 'income' },
    { id: 'i-gift',    name: '红包', type: 'income' },
    { id: 'i-invest',  name: '理财', type: 'income' },
    { id: 'i-refund',  name: '报销', type: 'income' },
    { id: 'i-other',   name: '其他', type: 'income' }
  ];

  /* ═══════════════════════════════════════════════════════════
     日期与金额工具
     ═══════════════════════════════════════════════════════════ */

  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 今天，本地时区，YYYY-MM-DD。绝不用 toISOString（那是 UTC）。 */
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 现在时刻 HH:mm */
  function nowTime(d) {
    d = d || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** 'YYYY-MM-DD' → Date（本地零点），非法返回 null */
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], da = +m[3];
    var d = new Date(y, mo - 1, da);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
    return d;
  }

  function isDate(s) { return parseDate(s) !== null; }

  /** 'YYYY-MM-DD' → '2026-02' */
  function ymOf(dateStr) { return String(dateStr || '').slice(0, 7); }

  function isYm(s) { return /^\d{4}-\d{2}$/.test(String(s || '')); }

  /** '2026-02' → '2026年2月' */
  function ymLabel(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    return m ? (+m[1]) + '年' + (+m[2]) + '月' : '—';
  }

  function ymShift(ym, delta) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return ym;
    var t = (+m[1]) * 12 + (+m[2]) - 1 + delta;
    return Math.floor(t / 12) + '-' + pad2((t % 12 + 12) % 12 + 1);
  }

  function daysInMonth(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(ym || '');
    if (!m) return 30;
    return new Date(+m[1], +m[2], 0).getDate();
  }

  /** '2026-02-14' → '周六' */
  function weekday(dateStr) {
    var d = parseDate(dateStr);
    return d ? WEEK[d.getDay()] : '';
  }

  /** '2026-02-14' → '02-14' */
  function md(dateStr) { return String(dateStr || '').slice(5); }

  /** '2026-02-14' → '2月14日 周六' */
  function cnDate(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return dateStr || '';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
  }

  /** 把金额字符串变成「分」。支持算式 128+36.5。无法解析返回 null。 */
  function parseAmount(input) {
    var s = String(input == null ? '' : input)
      .replace(/[¥￥,，\s]/g, '')
      .trim();
    if (!s) return null;
    var value = evalExpr(s);
    if (value === null || !isFinite(value) || value < 0) return null;
    var cents = Math.round(value * 100);
    if (cents > 99999999999) return null; // 一亿以内，够用了
    return cents;
  }

  /**
   * 只认 数字 与 + - * 的算式，两步折叠求值，不碰 eval。
   * 「128+36.5」这种写法是给 AA 分账用的：一次记下自己该付的那份。
   */
  function evalExpr(s) {
    if (!/^\d*\.?\d+([+\-*]\d*\.?\d+)*$/.test(s)) return null;

    var parts = s.split(/([+\-*])/);
    var nums = [], ops = [], i;
    for (i = 0; i < parts.length; i++) {
      if (i % 2 === 0) nums.push(parseFloat(parts[i]));
      else ops.push(parts[i]);
    }
    if (nums.some(isNaN)) return null;

    // 第一遍折叠乘法
    var folded = [nums[0]], rest = [];
    for (i = 0; i < ops.length; i++) {
      if (ops[i] === '*') folded[folded.length - 1] *= nums[i + 1];
      else { rest.push(ops[i]); folded.push(nums[i + 1]); }
    }
    // 第二遍加减
    var total = folded[0];
    for (i = 0; i < rest.length; i++) {
      total = rest[i] === '+' ? total + folded[i + 1] : total - folded[i + 1];
    }
    return total;
  }

  /** 分 → '1,024.50' */
  function money(cents, withSign) {
    var v = Math.abs(Math.round(cents || 0));
    var yuan = String(Math.floor(v / 100));
    var dec = pad2(v % 100);
    var out = yuan.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
    if (withSign) out = (cents < 0 ? '−' : '+') + out;
    return out;
  }

  /** 分 → '¥1,024.50' */
  function yuan(cents) { return '¥' + money(cents); }

  /** 分 → '1024.5'（不带千分位，导出用） */
  function plain(cents) { return (Math.round(cents || 0) / 100).toFixed(2); }

  function uid(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) +
      Math.random().toString(36).slice(2, 7);
  }

  /* ═══════════════════════════════════════════════════════════
     状态
     ═══════════════════════════════════════════════════════════ */

  function blank() {
    return {
      version: VERSION,
      records: [],
      categories: DEFAULT_CATEGORIES.map(function (c) { return { id: c.id, name: c.name, type: c.type }; }),
      budgets: { monthly: 0, byCategory: {} },
      meta: { createdAt: Date.now(), lastOpenAt: Date.now() }
    };
  }

  function normalize(raw) {
    var base = blank();
    if (!raw || typeof raw !== 'object') return base;

    if (Array.isArray(raw.categories) && raw.categories.length) {
      base.categories = raw.categories
        .filter(function (c) { return c && typeof c.name === 'string' && c.name.trim(); })
        .map(function (c) {
          return {
            id: typeof c.id === 'string' && c.id ? c.id : uid('c'),
            name: c.name.trim().slice(0, 12),
            type: c.type === 'income' ? 'income' : 'expense'
          };
        });
    }

    var ids = {};
    base.categories.forEach(function (c) { ids[c.id] = c; });

    if (Array.isArray(raw.records)) {
      base.records = raw.records.map(function (r) {
        if (!r || typeof r !== 'object') return null;
        var amount = Math.round(Number(r.amount));
        if (!isFinite(amount) || amount <= 0) return null;
        var date = isDate(r.date) ? r.date : null;
        if (!date) return null;
        var type = r.type === 'income' ? 'income' : 'expense';
        var catId = ids[r.category] ? r.category : null;
        if (!catId) {
          var fallback = base.categories.filter(function (c) { return c.type === type; })[0];
          catId = fallback ? fallback.id : 'e-other';
        }
        return {
          id: typeof r.id === 'string' && r.id ? r.id : uid('r'),
          type: type,
          amount: amount,
          category: catId,
          note: typeof r.note === 'string' ? r.note.slice(0, 60) : '',
          date: date,
          time: /^\d{2}:\d{2}$/.test(r.time) ? r.time : '00:00',
          createdAt: Number(r.createdAt) || 0
        };
      }).filter(Boolean);
    }

    if (raw.budgets && typeof raw.budgets === 'object') {
      var monthly = Math.round(Number(raw.budgets.monthly) || 0);
      base.budgets.monthly = monthly > 0 ? monthly : 0;
      var by = {};
      if (raw.budgets.byCategory && typeof raw.budgets.byCategory === 'object') {
        Object.keys(raw.budgets.byCategory).forEach(function (k) {
          var v = Math.round(Number(raw.budgets.byCategory[k]) || 0);
          if (v > 0 && ids[k]) by[k] = v;
        });
      }
      base.budgets.byCategory = by;
    }

    if (raw.meta && typeof raw.meta === 'object') {
      base.meta.createdAt = Number(raw.meta.createdAt) || base.meta.createdAt;
      base.meta.lastOpenAt = Number(raw.meta.lastOpenAt) || base.meta.lastOpenAt;
    }
    return base;
  }

  function load() {
    var raw = null;
    try {
      var s = global.localStorage.getItem(KEY);
      if (s) raw = JSON.parse(s);
    } catch (e) {
      console.warn('读取本地数据失败：', e);
    }
    var state = normalize(raw);
    if (!raw) state.meta.createdAt = Date.now();
    return state;
  }

  var storageOK = (function () {
    try {
      global.localStorage.setItem('ledger.probe', '1');
      global.localStorage.removeItem('ledger.probe');
      return true;
    } catch (e) { return false; }
  })();

  function save(state) {
    try {
      state.meta.lastOpenAt = Date.now();
      global.localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('保存失败：', e);
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     查询与统计
     ═══════════════════════════════════════════════════════════ */

  function catMap(state) {
    var m = {};
    state.categories.forEach(function (c) { m[c.id] = c; });
    return m;
  }

  function catName(state, id) {
    var m = catMap(state);
    return m[id] ? m[id].name : '未分类';
  }

  /** 按时间倒序（日期降序，同日按时刻降序） */
  function sorted(list) {
    return list.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.time !== b.time) return a.time < b.time ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  function inMonth(state, ym) {
    return state.records.filter(function (r) { return ymOf(r.date) === ym; });
  }

  function onDate(state, date) {
    return sorted(state.records.filter(function (r) { return r.date === date; }));
  }

  function sum(list) {
    var out = { expense: 0, income: 0, count: list.length, balance: 0 };
    list.forEach(function (r) {
      if (r.type === 'income') out.income += r.amount;
      else out.expense += r.amount;
    });
    out.balance = out.income - out.expense;
    return out;
  }

  /** 某月按分类汇总，降序 */
  function byCategory(state, ym, type) {
    var m = catMap(state);
    var buckets = {};
    inMonth(state, ym).forEach(function (r) {
      if (r.type !== type) return;
      var k = r.category;
      if (!buckets[k]) buckets[k] = { id: k, name: m[k] ? m[k].name : '未分类', amount: 0, count: 0 };
      buckets[k].amount += r.amount;
      buckets[k].count += 1;
    });
    var list = Object.keys(buckets).map(function (k) { return buckets[k]; });
    list.sort(function (a, b) { return b.amount - a.amount; });
    var total = list.reduce(function (s, x) { return s + x.amount; }, 0);
    list.forEach(function (x) { x.pct = total ? x.amount / total : 0; });
    return { list: list, total: total };
  }

  /** 某月每天的发生额 */
  function byDay(state, ym, type) {
    var n = daysInMonth(ym);
    var days = [];
    for (var i = 1; i <= n; i++) {
      days.push({ day: i, date: ym + '-' + pad2(i), amount: 0, count: 0 });
    }
    inMonth(state, ym).forEach(function (r) {
      if (type && r.type !== type) return;
      var d = +r.date.slice(8, 10);
      if (days[d - 1]) { days[d - 1].amount += r.amount; days[d - 1].count += 1; }
    });
    return days;
  }

  /** 有记录的日期集合（去重） */
  function activeDates(state) {
    var seen = {};
    state.records.forEach(function (r) { seen[r.date] = true; });
    return Object.keys(seen).sort();
  }

  /** 连续记账天数。今天没记就从昨天起算，白天不会平白断掉。 */
  function streak(state) {
    var dates = activeDates(state);
    if (!dates.length) return 0;
    var set = {};
    dates.forEach(function (d) { set[d] = true; });

    var cursor = new Date();
    if (!set[todayStr(cursor)]) cursor.setDate(cursor.getDate() - 1);
    var n = 0;
    while (set[todayStr(cursor)]) {
      n++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return n;
  }

  /** 本月记账天数 */
  function activeDaysIn(state, ym) {
    var seen = {};
    inMonth(state, ym).forEach(function (r) { seen[r.date] = true; });
    return Object.keys(seen).length;
  }

  /** 近 n 个月（含当月）的收支 */
  function recentMonths(state, ym, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var key = ymShift(ym, -i);
      var s = sum(inMonth(state, key));
      s.ym = key;
      out.push(s);
    }
    return out;
  }

  /** 预算执行情况 */
  function budgetStatus(state, ym) {
    var s = sum(inMonth(state, ym));
    var total = state.budgets.monthly || 0;
    var n = daysInMonth(ym);
    var today = todayStr();
    var isCurrent = ymOf(today) === ym;
    var dayNow = isCurrent ? +today.slice(8, 10) : n;
    var left = Math.max(0, n - dayNow);

    var out = {
      total: total,
      spent: s.expense,
      ratio: total ? s.expense / total : 0,
      remaining: total ? total - s.expense : 0,
      daysLeft: left,
      perDayLeft: total && left > 0 ? Math.max(0, total - s.expense) / left : 0,
      categories: []
    };

    Object.keys(state.budgets.byCategory).forEach(function (id) {
      var cap = state.budgets.byCategory[id];
      var used = 0, count = 0;
      inMonth(state, ym).forEach(function (r) {
        if (r.type === 'expense' && r.category === id) { used += r.amount; count++; }
      });
      if (!count && !cap) return;
      out.categories.push({
        id: id,
        name: catName(state, id),
        cap: cap,
        used: used,
        ratio: cap ? used / cap : 0
      });
    });
    out.categories.sort(function (a, b) { return b.ratio - a.ratio; });
    return out;
  }

  /* ═══════════════════════════════════════════════════════════
     记录增删改
     ═══════════════════════════════════════════════════════════ */

  function addRecord(state, data) {
    var rec = {
      id: uid('r'),
      type: data.type === 'income' ? 'income' : 'expense',
      amount: Math.round(data.amount),
      category: data.category,
      note: (data.note || '').slice(0, 60),
      date: isDate(data.date) ? data.date : todayStr(),
      time: data.time || nowTime(),
      createdAt: Date.now()
    };
    state.records.push(rec);
    return rec;
  }

  function updateRecord(state, id, patch) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id !== id) continue;
      var r = state.records[i];
      if (patch.type) r.type = patch.type === 'income' ? 'income' : 'expense';
      if (patch.amount != null) r.amount = Math.round(patch.amount);
      if (patch.category) r.category = patch.category;
      if (patch.note != null) r.note = String(patch.note).slice(0, 60);
      if (isDate(patch.date)) r.date = patch.date;
      if (/^\d{2}:\d{2}$/.test(patch.time)) r.time = patch.time;
      return r;
    }
    return null;
  }

  function removeRecord(state, id) {
    for (var i = 0; i < state.records.length; i++) {
      if (state.records[i].id === id) return state.records.splice(i, 1)[0];
    }
    return null;
  }

  function restoreRecord(state, rec) {
    if (rec) state.records.push(rec);
    return rec;
  }

  function countByCategory(state, catId) {
    return state.records.filter(function (r) { return r.category === catId; }).length;
  }

  function addCategory(state, name, type) {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return null;
    var dup = state.categories.filter(function (c) {
      return c.type === type && c.name === name;
    })[0];
    if (dup) return dup;
    var c = { id: uid('c'), name: name, type: type === 'income' ? 'income' : 'expense' };
    state.categories.push(c);
    return c;
  }

  function renameCategory(state, id, name) {
    name = String(name || '').trim().slice(0, 12);
    if (!name) return false;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].id === id) { state.categories[i].name = name; return true; }
    }
    return false;
  }

  /** 删除分类：把它的记录改挂到同类型的另一个分类上，一笔都不丢。 */
  function removeCategory(state, id) {
    var target = null;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].id === id) { target = state.categories[i]; break; }
    }
    if (!target) return null;
    if (state.categories.filter(function (c) { return c.type === target.type; }).length <= 1) {
      return { ok: false, reason: 'last' };
    }
    var fallback = state.categories.filter(function (c) {
      return c.type === target.type && c.id !== id;
    }).pop();

    var moved = 0;
    state.records.forEach(function (r) {
      if (r.category === id) { r.category = fallback.id; moved++; }
    });
    delete state.budgets.byCategory[id];
    state.categories = state.categories.filter(function (c) { return c.id !== id; });
    return { ok: true, moved: moved, fallback: fallback, removed: target };
  }

  /* ═══════════════════════════════════════════════════════════
     CSV
     ═══════════════════════════════════════════════════════════ */

  var CSV_HEAD = ['日期', '时间', '类型', '分类', '金额', '备注'];

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(state, list) {
    var m = catMap(state);
    var rows = [CSV_HEAD.slice()];
    sorted(list || state.records).forEach(function (r) {
      rows.push([
        r.date,
        r.time,
        r.type === 'income' ? '收入' : '支出',
        m[r.category] ? m[r.category].name : '未分类',
        plain(r.amount),
        r.note || ''
      ]);
    });
    // BOM：Excel 打开中文 CSV 不乱码
    return '\ufeff' + rows.map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n') + '\r\n';
  }

  function parseCSV(text) {
    var s = String(text || '').replace(/^\ufeff/, '');
    var rows = [], row = [], cell = '', quoted = false, i = 0, c;
    while (i < s.length) {
      c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { row.push(cell); cell = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) {
      return r.some(function (x) { return String(x).trim() !== ''; });
    });
  }

  var HEAD_ALIAS = {
    date:  ['日期', 'date', '时间日期', '交易日期', '记账日期'],
    time:  ['时间', 'time', '时刻'],
    type:  ['类型', 'type', '收支', '收支类型'],
    cat:   ['分类', 'category', '类别', '标签', 'category_name'],
    amt:   ['金额', 'amount', 'money', '数额', '金额(元)', '金额（元）'],
    note:  ['备注', 'note', '说明', '摘要', 'desc', 'memo', '备注说明']
  };

  function matchHeader(name) {
    var n = String(name || '').trim().toLowerCase().replace(/\s/g, '');
    for (var k in HEAD_ALIAS) {
      if (HEAD_ALIAS[k].some(function (a) { return a.toLowerCase() === n; })) return k;
    }
    for (var k2 in HEAD_ALIAS) {
      if (HEAD_ALIAS[k2].some(function (a) { return n.indexOf(a.toLowerCase()) >= 0; })) return k2;
    }
    return null;
  }

  var TYPE_EXPENSE = ['支出', 'expense', 'out', 'outcome', '消费', '付款', '支', '-'];
  var TYPE_INCOME  = ['收入', 'income', 'in', '入账', '收款', '收', '+'];

  function normType(v) {
    var s = String(v || '').trim().toLowerCase();
    if (!s) return null;
    if (TYPE_INCOME.indexOf(s) >= 0) return 'income';
    if (TYPE_EXPENSE.indexOf(s) >= 0) return 'expense';
    if (s.indexOf('收') === 0) return 'income';
    if (s.indexOf('支') === 0) return 'expense';
    return null;
  }

  /** 解析金额单元格，返回 { cents, sign } */
  function cellAmount(v) {
    var s = String(v == null ? '' : v).replace(/[¥￥,，\s]/g, '');
    var neg = /^[-−]/.test(s);
    var pos = /^\+/.test(s);
    var n = parseAmount(s.replace(/^[-−+]/, ''));
    if (n === null) return null;
    return { cents: n, sign: neg ? 'expense' : (pos ? 'income' : null) };
  }

  /**
   * CSV → 记录数组。
   * 表头顺序随意、列可缺；缺的分类会自动建。
   * 返回 { records, created:[分类名], skipped, error }
   */
  function fromCSV(state, text) {
    var rows = parseCSV(text);
    if (!rows.length) return { records: [], created: [], skipped: 0, error: '文件是空的' };

    var head = rows[0].map(matchHeader);
    var hasHeader = head.indexOf('amt') >= 0 || head.indexOf('date') >= 0;
    var idx = {};
    if (hasHeader) {
      head.forEach(function (k, i) { if (k && idx[k] == null) idx[k] = i; });
      rows = rows.slice(1);
    } else {
      // 没表头就按 日期,时间,类型,分类,金额,备注 猜测
      idx = { date: 0, time: 1, type: 2, cat: 3, amt: 4, note: 5 };
    }
    if (idx.amt == null) {
      return { records: [], created: [], skipped: 0, error: '找不到「金额」列' };
    }

    var created = [], skipped = 0, out = [];

    rows.forEach(function (row) {
      var rawAmt = row[idx.amt];
      var amt = cellAmount(rawAmt);
      // 金额必须存在且为正：0 元和空行都不是一笔账
      if (!amt || !(amt.cents > 0)) { skipped++; return; }

      var type = idx.type != null ? normType(row[idx.type]) : null;
      if (!type) type = amt.sign || 'expense';

      var rawDate = idx.date != null ? String(row[idx.date] || '').trim() : '';
      var rawTime = idx.time != null ? String(row[idx.time] || '').trim() : '';
      var date = null, time = null;

      var dm = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(rawDate);
      if (dm) date = dm[1] + '-' + pad2(+dm[2]) + '-' + pad2(+dm[3]);
      var tm = /(\d{1,2}):(\d{2})/.exec(rawDate + ' ' + rawTime);
      if (tm) time = pad2(+tm[1]) + ':' + tm[2];
      if (!date) date = todayStr();
      if (!time) time = '00:00';
      if (!isDate(date)) { skipped++; return; }

      var catNameRaw = idx.cat != null ? String(row[idx.cat] || '').trim().slice(0, 12) : '';
      var cat = catNameRaw
        ? state.categories.filter(function (c) { return c.type === type && c.name === catNameRaw; })[0]
        : null;
      if (!cat && catNameRaw) {
        cat = addCategory(state, catNameRaw, type);
        created.push(catNameRaw);
      }
      if (!cat) cat = state.categories.filter(function (c) { return c.type === type; })[0];
      if (!cat) { skipped++; return; }

      out.push({
        id: uid('r'),
        type: type,
        amount: amt.cents,
        category: cat.id,
        note: idx.note != null ? String(row[idx.note] || '').trim().slice(0, 60) : '',
        date: date,
        time: time,
        createdAt: Date.now()
      });
    });

    return { records: out, created: created, skipped: skipped, error: null };
  }

  /** 自动识别是 CSV 还是 JSON */
  function parseAnyImport(state, text) {
    var t = String(text || '').replace(/^\ufeff/, '').trim();
    if (!t) return { error: '文件是空的' };
    if (t[0] === '{' || t[0] === '[') {
      var data;
      try { data = JSON.parse(t); } catch (e) { return { error: 'JSON 解析失败：' + e.message }; }
      var records = Array.isArray(data) ? data : (data && data.records);
      if (!Array.isArray(records)) return { error: 'JSON 里找不到记录数组' };

      // 先把文件里的分类并进来，并把文件内的分类 id 映射到本机 id，
      // 否则记录会挂到不存在的分类上。
      var idMap = {};
      if (data && Array.isArray(data.categories)) {
        data.categories.forEach(function (c) {
          if (!c || typeof c.name !== 'string' || !c.name.trim()) return;
          var type = c.type === 'income' ? 'income' : 'expense';
          var hit = state.categories.filter(function (x) {
            return x.type === type && x.name === c.name.trim();
          })[0] || addCategory(state, c.name, type);
          if (hit && typeof c.id === 'string' && c.id) idMap[c.id] = hit.id;
        });
      }
      var mapped = records.map(function (r) {
        if (!r || typeof r !== 'object') return null;
        var copy = {};
        for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) copy[k] = r[k];
        if (copy.category && idMap[copy.category]) copy.category = idMap[copy.category];
        return copy;
      }).filter(Boolean);

      var clean = normalize({ records: mapped, categories: state.categories }).records;
      return { records: clean, created: [], skipped: records.length - clean.length, error: null, kind: 'json' };
    }
    var res = fromCSV(state, t);
    res.kind = 'csv';
    return res;
  }

  /* ═══════════════════════════════════════════════════════════
     导出
     ═══════════════════════════════════════════════════════════ */

  function toJSON(state) {
    return JSON.stringify({
      app: '流水账',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      records: sorted(state.records),
      categories: state.categories,
      budgets: state.budgets
    }, null, 2);
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ── 导出 ────────────────────────────────────────────────── */

  global.Ledger = {
    KEY: KEY,
    VERSION: VERSION,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    storageOK: storageOK,

    blank: blank,
    normalize: normalize,
    load: load,
    save: save,

    todayStr: todayStr,
    nowTime: nowTime,
    parseDate: parseDate,
    isDate: isDate,
    ymOf: ymOf,
    isYm: isYm,
    ymLabel: ymLabel,
    ymShift: ymShift,
    daysInMonth: daysInMonth,
    weekday: weekday,
    md: md,
    cnDate: cnDate,
    pad2: pad2,
    uid: uid,

    parseAmount: parseAmount,
    money: money,
    yuan: yuan,
    plain: plain,

    catMap: catMap,
    catName: catName,
    sorted: sorted,
    inMonth: inMonth,
    onDate: onDate,
    sum: sum,
    byCategory: byCategory,
    byDay: byDay,
    activeDates: activeDates,
    activeDaysIn: activeDaysIn,
    streak: streak,
    recentMonths: recentMonths,
    budgetStatus: budgetStatus,

    addRecord: addRecord,
    updateRecord: updateRecord,
    removeRecord: removeRecord,
    restoreRecord: restoreRecord,
    countByCategory: countByCategory,
    addCategory: addCategory,
    renameCategory: renameCategory,
    removeCategory: removeCategory,

    toCSV: toCSV,
    parseCSV: parseCSV,
    fromCSV: fromCSV,
    parseAnyImport: parseAnyImport,
    toJSON: toJSON,
    download: download
  };

})(window);
