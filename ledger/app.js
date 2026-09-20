/* ═══════════════════════════════════════════════════════════════
   流水账 · 交互层
   ───────────────────────────────────────────────────────────────
   纸卷（记一笔 + 今日流水）常驻左侧。
   账页（流水 / 统计 / 设置）在右侧翻。
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var L = global.Ledger;
  var $ = function (id) { return document.getElementById(id); };

  /* ═══════════════════════════════════════════════════════════
     状态
     ═══════════════════════════════════════════════════════════ */

  var PREFS_KEY = 'ledger.prefs.v1';

  var prefs = (function () {
    var base = { keypad: false, type: 'expense', lastCat: {} };
    try {
      var raw = JSON.parse(global.localStorage.getItem(PREFS_KEY) || '{}');
      if (raw && typeof raw === 'object') {
        base.keypad = !!raw.keypad;
        base.type = raw.type === 'income' ? 'income' : 'expense';
        if (raw.lastCat && typeof raw.lastCat === 'object') base.lastCat = raw.lastCat;
      }
    } catch (e) { /* 用默认值 */ }
    return base;
  })();

  function savePrefs() {
    try { global.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
  }

  var state = {
    data: null,
    ym: L.ymOf(L.todayStr()),
    tab: 'flow',
    allTime: false,
    filters: { q: '', type: 'all', cat: '', min: '', max: '' },
    editingId: null,
    draft: { type: prefs.type, amount: '', category: null, note: '', date: L.todayStr(), time: '' },
    bcKind: 'expense',
    flowLimit: 120
  };

  var els = {};

  /* ═══════════════════════════════════════════════════════════
     小工具
     ═══════════════════════════════════════════════════════════ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function thousands(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 坐标轴上的钱：够大就不要小数 */
  function axisMoney(cents) {
    var y = cents / 100;
    if (y >= 100) return thousands(y);
    return (Math.round(y * 10) / 10).toFixed(y % 1 === 0 ? 0 : 1);
  }

  function niceMax(v) {
    if (!(v > 0)) return 100;
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    var step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return step * exp;
  }

  function signedMoney(cents, type) {
    return (type === 'income' ? '+' : '−') + L.money(cents);
  }

  function persist() {
    // 每次改动都当场落盘。不要挪到 beforeunload 里做：
    // 那时写的是内存里的旧快照，会把别的标签页刚存的数据覆盖掉。
    if (!L.save(state.data)) {
      toast('存不进本地存储：浏览器可能禁用了网站数据，或者空间满了。先去设置里导出备份。', { kind: 'bad', duration: 9000 });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     提示条 / 确认框
     ═══════════════════════════════════════════════════════════ */

  function toast(html, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'toast' + (opts.kind ? ' is-' + opts.kind : '');
    var msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.innerHTML = html;
    el.appendChild(msg);

    var timer = setTimeout(dismiss, opts.duration || 4200);

    function dismiss() {
      clearTimeout(timer);
      if (!el.parentNode) return;
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 200);
    }

    if (opts.action) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-act';
      b.textContent = opts.action;
      b.addEventListener('click', function () {
        dismiss();
        if (opts.onAction) opts.onAction();
      });
      el.appendChild(b);
    }

    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
    return dismiss;
  }

  function confirmSheet(title, bodyHtml, okLabel) {
    return new Promise(function (resolve) {
      var dlg = els.dialog;
      els.dialogTitle.textContent = title;
      els.dialogBody.innerHTML = bodyHtml;
      els.dialogOk.textContent = okLabel || '确定';

      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        dlg.removeEventListener('cancel', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(v);
      }
      var okBtn = els.dialogOk, cancelBtn = els.dialogCancel;
      function onOk() { finish(true); }
      function onCancel() { finish(false); }
      function onClose() { finish(false); }

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); onCancel(); });
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      okBtn.focus();
    });
  }

  /* ═══════════════════════════════════════════════════════════
     纸卷：分类选择
     ═══════════════════════════════════════════════════════════ */

  function catsOf(type) {
    return state.data.categories.filter(function (c) { return c.type === type; });
  }

  function ensureDraftCategory() {
    var list = catsOf(state.draft.type);
    if (!list.length) { state.draft.category = null; return; }
    var exists = list.filter(function (c) { return c.id === state.draft.category; })[0];
    if (exists) return;
    var last = prefs.lastCat[state.draft.type];
    var hit = list.filter(function (c) { return c.id === last; })[0];
    state.draft.category = (hit || list[0]).id;
  }

  function renderChips() {
    ensureDraftCategory();
    els.categoryPicker.innerHTML = catsOf(state.draft.type).map(function (c) {
      return '<button type="button" class="chip" role="radio" data-cat="' + esc(c.id) + '" ' +
        'aria-checked="' + (c.id === state.draft.category) + '">' + esc(c.name) + '</button>';
    }).join('');
  }

  function renderSeg() {
    Array.prototype.forEach.call(els.segBtns, function (b) {
      b.setAttribute('aria-checked', String(b.dataset.type === state.draft.type));
    });
    els.entry.dataset.type = state.draft.type;
  }

  /* ═══════════════════════════════════════════════════════════
     纸卷：今日流水与底部
     ═══════════════════════════════════════════════════════════ */

  function rowHTML(r, newId, cls) {
    var cat = L.catName(state.data, r.category);
    var note = r.note
      ? '<span class="row-note">' + esc(r.note) + '</span><span class="row-cat">' + esc(cat) + '</span>'
      : '<span class="row-note row-note-empty">' + esc(cat) + '</span>';
    return '<li class="' + cls + (r.type === 'expense' ? ' row-expense' : '') +
      (r.id === newId ? ' is-new' : '') + '" data-id="' + esc(r.id) + '">' +
      '<span class="row-time">' + esc(r.time) + '</span>' +
      '<button type="button" class="row-main" data-edit="' + esc(r.id) + '" ' +
      'aria-label="修改这条记录：' + esc(cat) + ' ' + esc(L.money(r.amount)) + '">' + note + '</button>' +
      '<span class="row-amount">' + signedMoney(r.amount, r.type) + '</span>' +
      '<button type="button" class="row-del" data-del="' + esc(r.id) + '" ' +
      'aria-label="删除这条记录">✕</button>' +
      '</li>';
  }

  function renderToday(newId) {
    var today = L.todayStr();
    var list = L.onDate(state.data, today);
    var s = L.sum(list);

    els.todayList.innerHTML = list.map(function (r) {
      return rowHTML(r, newId || null, 'row');
    }).join('');

    els.todayEmpty.hidden = list.length > 0;
    els.todayMeta.textContent = list.length ? list.length + ' 笔' : '';
    els.todayExpense.textContent = s.expense ? L.yuan(s.expense) : '—';
    els.todayIncome.textContent = s.income ? L.yuan(s.income) : '—';

    if (newId) {
      els.todayList.classList.remove('is-feeding');
      void els.todayList.offsetWidth;
      els.todayList.classList.add('is-feeding');
    }
  }

  function renderTapeFoot() {
    var n = L.streak(state.data);
    els.streak.innerHTML = n > 0
      ? '连续记账 <b>' + n + '</b> 天'
      : '记下今天第一笔，连续记录就从今天开始。';

    var bs = L.budgetStatus(state.data, state.ym);
    var today = L.todayStr();
    var isCurrent = L.ymOf(today) === state.ym;

    if (!bs.total || !isCurrent) {
      els.budgetWarn.hidden = true;
      return;
    }

    var text = '';
    if (bs.spent > bs.total) {
      text = '本月已超支 <b>' + L.yuan(bs.spent - bs.total) + '</b>。' +
        (bs.daysLeft > 0 ? '还剩 ' + bs.daysLeft + ' 天。' : '');
    } else if (bs.ratio >= 0.8) {
      text = '本月预算已用 <b>' + Math.round(bs.ratio * 100) + '%</b>，还剩 <b>' +
        L.yuan(bs.remaining) + '</b>。' +
        (bs.daysLeft > 0 ? '剩下 ' + bs.daysLeft + ' 天，每天别超过 <b>' + L.yuan(bs.perDayLeft) + '</b>。' : '');
    }
    els.budgetWarn.innerHTML = text;
    els.budgetWarn.hidden = !text;
  }

  /* ═══════════════════════════════════════════════════════════
     账页：流水
     ═══════════════════════════════════════════════════════════ */

  function filtered() {
    var f = state.filters;
    var list = state.allTime
      ? state.data.records.slice()
      : L.inMonth(state.data, state.ym);

    if (f.type !== 'all') {
      list = list.filter(function (r) { return r.type === f.type; });
    }
    if (f.cat) {
      list = list.filter(function (r) { return r.category === f.cat; });
    }
    if (f.min !== '') {
      var mn = L.parseAmount(f.min);
      if (mn !== null) list = list.filter(function (r) { return r.amount >= mn; });
    }
    if (f.max !== '') {
      var mx = L.parseAmount(f.max);
      if (mx !== null) list = list.filter(function (r) { return r.amount <= mx; });
    }
    var q = f.q.trim().toLowerCase();
    if (q) {
      list = list.filter(function (r) {
        var hay = (r.note + ' ' + L.catName(state.data, r.category) + ' ' +
          L.money(r.amount) + ' ' + r.date).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    return L.sorted(list);
  }

  function hasFilters() {
    var f = state.filters;
    return !!(f.q.trim() || f.type !== 'all' || f.cat || f.min !== '' || f.max !== '');
  }

  function deltaHTML(cur, prev, label) {
    if (!prev) return '<span class="sum-delta">' + esc(label) + '无对比</span>';
    var diff = cur - prev;
    var pct = Math.round(Math.abs(diff) / prev * 100);
    if (diff === 0) return '<span class="sum-delta">' + esc(label) + '持平</span>';
    var cls = diff > 0 ? 'up' : 'down';
    return '<span class="sum-delta">' + esc(label) + ' <span class="' + cls + '">' +
      (diff > 0 ? '↑' : '↓') + pct + '%</span></span>';
  }

  function renderSummary() {
    var s;
    var prev;
    var label;

    if (state.allTime) {
      s = L.sum(state.data.records);
      prev = null;
      label = '全部时间';
    } else {
      s = L.sum(L.inMonth(state.data, state.ym));
      prev = L.sum(L.inMonth(state.data, L.ymShift(state.ym, -1)));
      label = '较上月';
    }

    var days = state.allTime ? L.activeDates(state.data).length : L.activeDaysIn(state.data, state.ym);

    els.summary.innerHTML =
      '<div class="sum-cell" data-kind="expense">' +
        '<span class="sum-label">支出</span>' +
        '<span class="sum-value">' + (s.expense ? L.yuan(s.expense) : '¥0.00') + '</span>' +
        (prev ? deltaHTML(s.expense, prev.expense, label) : '<span class="sum-delta">' + esc(label) + '</span>') +
      '</div>' +
      '<div class="sum-cell" data-kind="income">' +
        '<span class="sum-label">收入</span>' +
        '<span class="sum-value">' + (s.income ? L.yuan(s.income) : '¥0.00') + '</span>' +
        (prev ? deltaHTML(s.income, prev.income, label) : '<span class="sum-delta">' + esc(label) + '</span>') +
      '</div>' +
      '<div class="sum-cell" data-kind="balance">' +
        '<span class="sum-label">结余</span>' +
        '<span class="sum-value">' + (s.balance < 0 ? '−' : '') + L.yuan(Math.abs(s.balance)) + '</span>' +
        '<span class="sum-delta">' + s.count + ' 笔 · 记账 ' + days + ' 天</span>' +
      '</div>';
  }

  function renderFilters() {
    var cats = state.data.categories;
    var opts = '<option value="">全部分类</option>' + cats.map(function (c) {
      return '<option value="' + esc(c.id) + '"' +
        (state.filters.cat === c.id ? ' selected' : '') + '>' +
        esc(c.name) + '（' + (c.type === 'income' ? '收' : '支') + '）</option>';
    }).join('');

    var types = [['all', '全部'], ['expense', '支出'], ['income', '收入']];

    els.filterBar.innerHTML =
      '<div class="f-field">' +
        '<label for="f-q">搜索</label>' +
        '<input id="f-q" type="search" placeholder="备注、分类、金额…" value="' + esc(state.filters.q) + '">' +
      '</div>' +
      '<div class="f-field">' +
        '<label for="f-cat">分类</label>' +
        '<select id="f-cat">' + opts + '</select>' +
      '</div>' +
      '<div class="f-field">' +
        '<label for="f-min">金额区间</label>' +
        '<div class="f-range">' +
          '<input id="f-min" type="text" inputmode="decimal" placeholder="最低" value="' + esc(state.filters.min) + '">' +
          '<span>—</span>' +
          '<input id="f-max" type="text" inputmode="decimal" placeholder="最高" value="' + esc(state.filters.max) + '">' +
        '</div>' +
      '</div>' +
      '<div class="f-field">' +
        '<label>收支</label>' +
        '<div class="switch" role="group" aria-label="按收支筛选">' +
          types.map(function (t) {
            return '<button type="button" data-ftype="' + t[0] + '" aria-pressed="' +
              (state.filters.type === t[0]) + '">' + t[1] + '</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      (hasFilters() ? '<div class="f-field"><button type="button" class="ghost-btn" id="f-clear">清除筛选</button></div>' : '');
  }

  function renderGroups() {
    var list = filtered();
    var total = L.sum(list);

    if (!list.length) {
      els.groups.innerHTML = hasFilters()
        ? '<div class="empty-block"><p>没有符合条件的记录。</p>' +
          '<button type="button" class="ghost-btn" id="empty-clear">清除筛选</button></div>'
        : '<div class="empty-block"><p>' +
          (state.allTime ? '账本还是空的。' : L.ymLabel(state.ym) + '没有记录。') + '</p>' +
          '<button type="button" class="ghost-btn" id="empty-today">' +
          (state.allTime ? '去记第一笔' : '回到本月') + '</button></div>';
      return;
    }

    var shown = list.slice(0, state.flowLimit);
    var html = '';
    var lastDate = null;
    var lastYm = null;

    shown.forEach(function (r) {
      if (r.date !== lastDate) {
        if (lastDate !== null) html += '</ul></div>';
        var thisYm = L.ymOf(r.date);
        var head = '';
        if (state.allTime && thisYm !== lastYm) {
          var ms = L.sum(state.data.records.filter(function (x) { return L.ymOf(x.date) === thisYm; }));
          head = '<div class="group-head" style="margin-top:6px">' +
            '<span class="group-date">' + esc(L.ymLabel(thisYm)) + '</span>' +
            '<span class="group-total">支出 ' + L.yuan(ms.expense) + ' · 收入 ' + L.yuan(ms.income) + '</span></div>';
          lastYm = thisYm;
        }
        var daySum = L.sum(L.onDate(state.data, r.date));
        html += head + '<div class="group">' +
          '<div class="group-head">' +
            '<span class="group-date">' + esc(r.date) + '</span>' +
            '<span class="group-week">' + esc(L.weekday(r.date)) + '</span>' +
            '<span class="group-total">' +
              (daySum.expense ? '支 ' + L.yuan(daySum.expense) : '') +
              (daySum.expense && daySum.income ? ' · ' : '') +
              (daySum.income ? '收 ' + L.yuan(daySum.income) : '') +
            '</span>' +
          '</div><ul class="glist">';
        lastDate = r.date;
      }
      html += rowHTML(r, null, 'grow');
    });
    html += '</ul></div>';

    if (list.length > shown.length) {
      html += '<div class="more-bar"><button type="button" class="ghost-btn" id="more-btn">' +
        '还有 ' + (list.length - shown.length) + ' 笔，显示更多</button></div>';
    }
    els.groups.innerHTML = html;
  }

  function renderFlow() {
    renderSummary();
    renderFilters();
    renderGroups();
  }

  /* ═══════════════════════════════════════════════════════════
     账页：统计
     ═══════════════════════════════════════════════════════════ */

  function meterHTML(label, used, cap) {
    var ratio = cap ? used / cap : 0;
    var over = cap && used > cap;
    return '<div class="sub-meter">' +
      '<span class="bc-name">' + esc(label) + '</span>' +
      '<span class="meter' + (ratio >= 0.8 ? ' is-warn' : '') + '">' +
        '<span class="meter-fill" style="width:' + Math.min(100, ratio * 100).toFixed(1) + '%"></span>' +
      '</span>' +
      '<span class="sub-meter-val' + (over ? ' is-over' : '') + '">' +
        L.yuan(used) + ' / ' + L.yuan(cap) +
      '</span></div>';
  }

  function renderBudgetBlock() {
    var bs = L.budgetStatus(state.data, state.ym);
    if (!bs.total) {
      return '<section class="block">' +
        '<h3 class="block-title">预算</h3>' +
        '<p class="meter-note">还没设预算。定一个月度上限，超了这里会告诉你。</p>' +
        '<div class="btn-row" style="margin-top:12px">' +
          '<button type="button" class="ghost-btn" data-goto="setup">去设预算</button>' +
        '</div></section>';
    }

    var over = bs.spent > bs.total;
    var note;
    if (over) {
      note = '<p class="meter-note is-over">已超支 <b>' + L.yuan(bs.spent - bs.total) + '</b>。' +
        (bs.daysLeft > 0 ? '本月还剩 ' + bs.daysLeft + ' 天。' : '') + '</p>';
    } else {
      note = '<p class="meter-note">还剩 <b>' + L.yuan(bs.remaining) + '</b>' +
        (bs.daysLeft > 0
          ? '，' + bs.daysLeft + ' 天，每天别超过 <b>' + L.yuan(bs.perDayLeft) + '</b>'
          : '') + '。</p>';
    }

    return '<section class="block">' +
      '<h3 class="block-title">预算<span class="block-note">' +
        Math.round(bs.ratio * 100) + '%</span></h3>' +
      '<div class="meter-head"><span>本月支出</span>' +
        '<b>' + L.yuan(bs.spent) + ' / ' + L.yuan(bs.total) + '</b></div>' +
      '<span class="meter' + (bs.ratio >= 0.8 ? ' is-warn' : '') + '">' +
        '<span class="meter-fill" style="width:' + Math.min(100, bs.ratio * 100).toFixed(1) + '%"></span>' +
      '</span>' + note +
      (bs.categories.length
        ? '<div style="margin-top:16px">' + bs.categories.map(function (c) {
            return meterHTML(c.name, c.used, c.cap);
          }).join('') + '</div>'
        : '') +
      '</section>';
  }

  function renderBarcodeBlock() {
    var kind = state.bcKind;
    var res = L.byCategory(state.data, state.ym, kind);
    var head = '<div class="bc-head">' +
      '<h3 class="block-title" style="margin:0;flex:1 1 auto">分类<span class="block-note">' +
        (kind === 'expense' ? '钱花在哪儿了' : '钱从哪儿来') + '</span></h3>' +
      '<div class="switch" role="group" aria-label="切换收/支">' +
        '<button type="button" data-bc="expense" aria-pressed="' + (kind === 'expense') + '">支出</button>' +
        '<button type="button" data-bc="income" aria-pressed="' + (kind === 'income') + '">收入</button>' +
      '</div></div>';

    if (!res.list.length) {
      return '<section class="block">' + head +
        '<p class="meter-note">' + esc(L.ymLabel(state.ym)) +
        (kind === 'expense' ? '没有支出。' : '没有收入。') + '</p></section>';
    }

    var rows = res.list.map(function (c) {
      var pct = Math.round(c.pct * 1000) / 10;
      return '<button type="button" class="bc-row" data-kind="' + kind + '" data-cat="' + esc(c.id) + '" ' +
        'aria-pressed="false" title="在流水里只看「' + esc(c.name) + '」">' +
        '<span class="bc-name">' + esc(c.name) + '</span>' +
        '<span class="bc-track"><span class="bc-bar" style="--w:' + Math.max(1.5, c.pct * 100).toFixed(1) + '%"></span></span>' +
        '<span class="bc-amount">' + L.yuan(c.amount) + '</span>' +
        '<span class="bc-pct">' + pct + '%</span>' +
        '</button>';
    }).join('');

    return '<section class="block">' + head +
      '<div class="bc-list">' + rows + '</div>' +
      '<p class="bc-foot">共 ' + res.list.length + ' 个分类，合计 <b>' +
        esc(L.yuan(res.total)) + '</b>。点一条可以只看它的流水。</p>' +
      '</section>';
  }

  function renderDailyBlock() {
    var ym = state.ym;
    var days = L.byDay(state.data, ym, 'expense');
    var n = days.length;
    var total = days.reduce(function (s, d) { return s + d.amount; }, 0);
    var today = L.todayStr();
    var isCurrent = L.ymOf(today) === ym;
    var elapsed = isCurrent ? (+today.slice(8, 10)) : n;
    var avg = elapsed ? total / elapsed : 0;

    if (!total) {
      return '<section class="block"><h3 class="block-title">每日支出</h3>' +
        '<p class="meter-note">这个月还没有支出记录。</p></section>';
    }

    var W = 760, H = 172, PL = 54, PR = 12, PT = 14, PB = 26;
    var pw = W - PL - PR, ph = H - PT - PB;
    var top = niceMax(Math.max.apply(null, days.map(function (d) { return d.amount; })));
    var bw = pw / n;

    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="' + esc(L.ymLabel(ym)) + '每日支出柱状图，共 ' + L.yuan(total) + '">';

    [0, 0.5, 1].forEach(function (f) {
      var y = PT + ph * (1 - f);
      svg += '<line class="grid-line" x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '"/>';
      svg += '<text class="lbl" x="' + (PL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' +
        axisMoney(top * f) + '</text>';
    });

    days.forEach(function (d, i) {
      var x = PL + i * bw + bw * 0.18;
      var w = Math.max(1.5, bw * 0.64);
      var h = top ? (d.amount / top) * ph : 0;
      var y = PT + ph - h;
      var isToday = d.date === today;
      if (d.amount > 0) {
        svg += '<rect class="bar-daily' + (isToday ? ' is-today' : '') + '" x="' + x.toFixed(1) +
          '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '">' +
          '<title>' + esc(L.cnDate(d.date)) + '：' + esc(L.yuan(d.amount)) + '（' + d.count + ' 笔）</title></rect>';
      }
    });

    var ay = PT + ph - (top ? (avg / top) * ph : 0);
    svg += '<line class="avg-line" x1="' + PL + '" y1="' + ay.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + ay.toFixed(1) + '"/>';
    svg += '<text class="lbl-strong" x="' + (W - PR) + '" y="' + Math.max(PT + 9, ay - 5).toFixed(1) +
      '" text-anchor="end">日均 ' + axisMoney(avg) + '</text>';

    days.forEach(function (d, i) {
      if (d.day !== 1 && d.day % 5 !== 0 && d.day !== n) return;
      var x = PL + i * bw + bw / 2;
      svg += '<text class="lbl" x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + d.day + '</text>';
    });

    svg += '<line class="axis" x1="' + PL + '" y1="' + (PT + ph) + '" x2="' + (W - PR) + '" y2="' + (PT + ph) + '"/>';
    svg += '</svg>';

    return '<section class="block">' +
      '<h3 class="block-title">每日支出<span class="block-note">' +
        (isCurrent ? '到今天为止 ' + elapsed + ' 天' : n + ' 天') + '</span></h3>' +
      '<div class="chart-wrap">' + svg + '</div>' +
      '</section>';
  }

  function renderTrendBlock() {
    var months = L.recentMonths(state.data, state.ym, 6);
    var any = months.some(function (m) { return m.expense || m.income; });
    if (!any) {
      return '<section class="block"><h3 class="block-title">近 6 个月</h3>' +
        '<p class="meter-note">这半年还没有记录。</p></section>';
    }

    var W = 760, H = 186, PL = 54, PR = 12, PT = 16, PB = 30;
    var pw = W - PL - PR, ph = H - PT - PB;
    var peak = 0;
    months.forEach(function (m) { peak = Math.max(peak, m.expense, m.income); });
    var top = niceMax(peak);
    var slot = pw / months.length;
    var bw = Math.min(26, slot * 0.28);

    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="近 6 个月收支对比">';

    [0, 0.5, 1].forEach(function (f) {
      var y = PT + ph * (1 - f);
      svg += '<line class="grid-line" x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '"/>';
      svg += '<text class="lbl" x="' + (PL - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end">' +
        axisMoney(top * f) + '</text>';
    });

    months.forEach(function (m, i) {
      var cx = PL + slot * i + slot / 2;
      var base = PT + ph;
      [['expense', -1], ['income', 1]].forEach(function (pair) {
        var kind = pair[0], dir = pair[1];
        var v = m[kind];
        var h = top ? (v / top) * ph : 0;
        var x = cx + (dir < 0 ? -bw - 1 : 1);
        var cls = kind === 'expense' ? 'bar-expense' : 'bar-income';
        if (v > 0) {
          svg += '<rect class="' + cls + '" x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) +
            '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '">' +
            '<title>' + esc(L.ymLabel(m.ym)) + '：支出 ' + esc(L.yuan(m.expense)) +
            '，收入 ' + esc(L.yuan(m.income)) + '</title></rect>';
        }
        svg += '<text class="lbl' + (m.ym === state.ym ? '-strong' : '') + '" x="' + x.toFixed(1) +
          '" y="' + (base - h - 5).toFixed(1) + '" text-anchor="middle">' +
          (v ? axisMoney(v) : '') + '</text>';
      });
      svg += '<text class="lbl' + (m.ym === state.ym ? '-strong' : '') + '" x="' + cx.toFixed(1) +
        '" y="' + (H - 10) + '" text-anchor="middle">' + (+m.ym.slice(5, 7)) + '月</text>';
    });

    svg += '<line class="axis" x1="' + PL + '" y1="' + (PT + ph) + '" x2="' + (W - PR) + '" y2="' + (PT + ph) + '"/>';
    svg += '</svg>';

    var sumExpense = months.reduce(function (s, m) { return s + m.expense; }, 0);
    var sumIncome = months.reduce(function (s, m) { return s + m.income; }, 0);

    return '<section class="block">' +
      '<h3 class="block-title">近 6 个月<span class="block-note">合计支出 ' +
        esc(L.yuan(sumExpense)) + '</span></h3>' +
      '<div class="chart-wrap">' + svg + '</div>' +
      '<div class="legend">' +
        '<span><i class="k-expense"></i>支出</span>' +
        '<span><i class="k-income"></i>收入</span>' +
        '<span>6 个月结余 ' + esc((sumIncome - sumExpense) < 0 ? '−' : '') +
          esc(L.yuan(Math.abs(sumIncome - sumExpense))) + '</span>' +
      '</div></section>';
  }

  function renderStats() {
    els.panelStats.innerHTML =
      renderBudgetBlock() +
      renderBarcodeBlock() +
      renderDailyBlock() +
      renderTrendBlock();
  }

  /* ═══════════════════════════════════════════════════════════
     账页：设置
     ═══════════════════════════════════════════════════════════ */

  function catItemsHTML(type) {
    return catsOf(type).map(function (c) {
      var n = L.countByCategory(state.data, c.id);
      return '<div class="cat-item" data-id="' + esc(c.id) + '">' +
        '<input type="text" value="' + esc(c.name) + '" maxlength="12" ' +
          'data-rename="' + esc(c.id) + '" aria-label="分类名 ' + esc(c.name) + '">' +
        '<span class="cat-count">' + n + ' 笔</span>' +
        '<button type="button" class="cat-del" data-delcat="' + esc(c.id) + '" ' +
          'aria-label="删除分类 ' + esc(c.name) + '">✕</button>' +
        '</div>';
    }).join('');
  }

  function factRow(k, v) {
    return '<div><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>';
  }

  function renderSetup() {
    var d = state.data;
    var dates = L.activeDates(d);
    var span = dates.length ? dates[0] + ' → ' + dates[dates.length - 1] : '—';
    var expCats = catsOf('expense');

    els.panelSetup.innerHTML =
      '<div class="setup-grid">' +

        '<div class="setup-col">' +
          '<h3 class="block-title">预算</h3>' +
          '<div class="set-row">' +
            '<label for="bud-monthly">月度总预算</label>' +
            '<input id="bud-monthly" type="text" inputmode="decimal" placeholder="0" value="' +
              (d.budgets.monthly ? L.plain(d.budgets.monthly) : '') + '">' +
            '<span class="unit">元</span>' +
          '</div>' +
          '<p class="tip" style="margin:6px 0 14px">填 0 或留空就是不设上限。</p>' +
          (expCats.length
            ? '<p class="cat-group-name">分类预算（可选）</p>' + expCats.map(function (c) {
                var v = d.budgets.byCategory[c.id];
                return '<div class="set-row">' +
                  '<label for="bud-' + esc(c.id) + '">' + esc(c.name) + '</label>' +
                  '<input id="bud-' + esc(c.id) + '" type="text" inputmode="decimal" data-budcat="' +
                    esc(c.id) + '" placeholder="0" value="' + (v ? L.plain(v) : '') + '">' +
                  '<span class="unit">元</span></div>';
              }).join('')
            : '') +
          '<div class="btn-row" style="margin-top:14px">' +
            '<button type="button" class="ghost-btn" id="save-budget">保存预算</button>' +
          '</div>' +
        '</div>' +

        '<div class="setup-col">' +
          '<h3 class="block-title">关于</h3>' +
          '<dl class="facts">' +
            factRow('记录', d.records.length + ' 笔') +
            factRow('分类', d.categories.length + ' 个') +
            factRow('覆盖', span) +
            factRow('记账天数', L.activeDates(d).length + ' 天') +
            factRow('当前连续', L.streak(d) + ' 天') +
            factRow('存储键', 'ledger.v1') +
          '</dl>' +
          '<p class="tip">数据写在浏览器本机（localStorage），不联网、不上传。' +
            '清浏览器数据、换设备、换浏览器都会看不到——定期导出 JSON 存一份。</p>' +
          (els.installPrompt ? '<div class="btn-row" style="margin-top:12px">' +
            '<button type="button" class="ghost-btn" id="install-app">装到主屏 / 桌面</button></div>' : '') +
        '</div>' +

      '</div>' +

      '<section class="block" style="margin-top:30px">' +
        '<h3 class="block-title">分类</h3>' +
        '<div class="setup-grid">' +
          '<div class="setup-col">' +
            '<p class="cat-group-name">支出分类</p>' + catItemsHTML('expense') +
            '<div class="cat-add"><input type="text" maxlength="12" placeholder="新支出分类" data-newcat="expense"><button type="button" data-addcat="expense">添加</button></div>' +
          '</div>' +
          '<div class="setup-col">' +
            '<p class="cat-group-name">收入分类</p>' + catItemsHTML('income') +
            '<div class="cat-add"><input type="text" maxlength="12" placeholder="新收入分类" data-newcat="income"><button type="button" data-addcat="income">添加</button></div>' +
          '</div>' +
        '</div>' +
        '<p class="tip">改名字直接编辑输入框，失焦即保存。删掉的分类，它名下的记录会自动改挂到同类型最后一个分类上，一笔都不会丢。</p>' +
      '</section>' +

      '<section class="block">' +
        '<h3 class="block-title">数据</h3>' +
        '<div class="btn-row">' +
          '<button type="button" class="ghost-btn" id="export-json">导出 JSON</button>' +
          '<button type="button" class="ghost-btn" id="export-csv">导出 CSV</button>' +
          '<button type="button" class="ghost-btn" id="import-btn">导入文件…</button>' +
          '<button type="button" class="ghost-btn danger" id="wipe-btn">清空全部数据</button>' +
        '</div>' +
        '<input type="file" id="import-file" accept=".json,.csv,.txt,application/json,text/csv" hidden>' +
        '<p class="tip">CSV 用 Excel、Numbers、WPS 都能打开，表头是「日期,时间,类型,分类,金额,备注」。' +
          '导入支持 JSON 和 CSV，按「日期+时间+类型+金额+分类+备注」去重，重复的会跳过，不会灌出双份。</p>' +
      '</section>';
  }

  /* ═══════════════════════════════════════════════════════════
     账页：外壳
     ═══════════════════════════════════════════════════════════ */

  function renderBookBar() {
    els.monthLabel.textContent = state.allTime ? '全部时间' : L.ymLabel(state.ym);
    els.monthPicker.value = state.ym;
    els.thisMonth.hidden = state.allTime || state.ym === L.ymOf(L.todayStr());
    els.allTime.setAttribute('aria-pressed', String(state.allTime));

    Array.prototype.forEach.call(els.tabs, function (t) {
      var on = t.dataset.tab === state.tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });

    els.panelFlow.hidden = state.tab !== 'flow';
    els.panelStats.hidden = state.tab !== 'stats';
    els.panelSetup.hidden = state.tab !== 'setup';
  }

  function renderAll(opts) {
    opts = opts || {};
    renderSeg();
    renderChips();
    renderToday(opts.newId);
    renderTapeFoot();
    renderBookBar();
    if (state.tab === 'flow') renderFlow();
    else if (state.tab === 'stats') renderStats();
    else renderSetup();
  }

  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    renderBookBar();
    if (tab === 'flow') renderFlow();
    else if (tab === 'stats') renderStats();
    else renderSetup();
  }

  function gotoMonth(ym) {
    state.ym = ym;
    state.allTime = false;
    state.flowLimit = 120;
    renderAll();
  }

  /* ═══════════════════════════════════════════════════════════
     记一笔
     ═══════════════════════════════════════════════════════════ */

  function setDraftType(type) {
    state.draft.type = type === 'income' ? 'income' : 'expense';
    prefs.type = state.draft.type;
    savePrefs();
    renderSeg();
    renderChips();
  }

  function pickCategory(id) {
    state.draft.category = id;
    prefs.lastCat[state.draft.type] = id;
    savePrefs();
    renderChips();
  }

  function showFormError(msg) {
    els.formError.textContent = msg;
    els.formError.hidden = !msg;
  }

  function readForm() {
    state.draft.amount = els.amount.value;
    state.draft.note = els.note.value;
    state.draft.date = els.date.value || L.todayStr();
    if (!state.draft.time) state.draft.time = L.nowTime();
  }

  function resetForm(keepDate) {
    els.amount.value = '';
    els.note.value = '';
    state.draft.amount = '';
    state.draft.note = '';
    state.draft.time = L.nowTime();
    if (!keepDate) {
      state.draft.date = L.todayStr();
      els.date.value = state.draft.date;
    }
    showFormError('');
  }

  function startEdit(id) {
    var r = state.data.records.filter(function (x) { return x.id === id; })[0];
    if (!r) return;

    state.editingId = id;
    state.draft.type = r.type;
    state.draft.category = r.category;
    state.draft.note = r.note;
    state.draft.date = r.date;
    state.draft.time = r.time;
    state.draft.amount = L.plain(r.amount);

    els.amount.value = L.plain(r.amount);
    els.note.value = r.note;
    els.date.value = r.date;
    showFormError('');

    els.tapeTitle.textContent = '改这一笔';
    els.printLabel.textContent = '保存修改';
    els.cancelEdit.hidden = false;

    renderSeg();
    renderChips();

    if (global.matchMedia && global.matchMedia('(max-width: 1000px)').matches) {
      els.tape.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    els.amount.focus();
    els.amount.select();
  }

  function cancelEdit() {
    state.editingId = null;
    els.tapeTitle.textContent = '记一笔';
    els.printLabel.textContent = '打印这一笔';
    els.cancelEdit.hidden = true;
    resetForm(false);
    renderChips();
  }

  function submitEntry() {
    readForm();

    var cents = L.parseAmount(state.draft.amount);
    if (cents === null || cents <= 0) {
      showFormError(state.draft.amount.trim()
        ? '这个金额看不懂。写成 28.5 或 128+36.5 这样。'
        : '先填个金额。');
      els.amount.focus();
      return;
    }
    ensureDraftCategory();
    if (!state.draft.category) {
      showFormError('至少留一个分类。');
      return;
    }
    if (!L.isDate(state.draft.date)) {
      showFormError('日期不对，用 2026-02-14 这样的格式。');
      return;
    }
    showFormError('');

    if (state.editingId) {
      var updated = L.updateRecord(state.data, state.editingId, {
        type: state.draft.type,
        amount: cents,
        category: state.draft.category,
        note: state.draft.note.trim(),
        date: state.draft.date,
        time: state.draft.time
      });
      var id = state.editingId;
      cancelEdit();
      persist();
      renderAll({ newId: id });
      toast('已改：' + esc(L.catName(state.data, updated.category)) + ' <b>' +
        signedMoney(updated.amount, updated.type) + '</b>');
      return;
    }

    var rec = L.addRecord(state.data, {
      type: state.draft.type,
      amount: cents,
      category: state.draft.category,
      note: state.draft.note.trim(),
      date: state.draft.date,
      time: L.nowTime()
    });

    persist();
    resetForm(true);
    renderAll({ newId: rec.id });
    els.amount.focus();

    var before = L.budgetStatus(state.data, state.ym).spent - rec.amount;
    var bs = L.budgetStatus(state.data, state.ym);
    var msg = '已记账：' + esc(L.catName(state.data, rec.category)) + ' <b>' +
      signedMoney(rec.amount, rec.type) + '</b>';

    if (rec.type === 'expense' && bs.total && L.ymOf(rec.date) === state.ym) {
      if (before <= bs.total && bs.spent > bs.total) {
        msg += '　本月预算已破，超 <b>' + L.yuan(bs.spent - bs.total) + '</b>';
      } else if (bs.ratio >= 0.8) {
        msg += '　本月预算已用 <b>' + Math.round(bs.ratio * 100) + '%</b>';
      }
    }

    toast(msg, {
      kind: rec.type === 'expense' && bs.total && bs.spent > bs.total ? 'bad' : 'good',
      action: '撤销',
      duration: 5200,
      onAction: function () {
        L.removeRecord(state.data, rec.id);
        persist();
        renderAll();
        toast('已撤销这一笔。');
      }
    });
  }

  function deleteRecord(id) {
    var rec = state.data.records.filter(function (r) { return r.id === id; })[0];
    if (!rec) return;
    L.removeRecord(state.data, id);
    if (state.editingId === id) cancelEdit();
    persist();
    renderAll();
    toast('已删除：' + esc(L.catName(state.data, rec.category)) + ' <b>' +
      signedMoney(rec.amount, rec.type) + '</b>', {
      action: '撤销',
      duration: 6000,
      onAction: function () {
        L.restoreRecord(state.data, rec);
        persist();
        renderAll();
        toast('已恢复。');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     数字键盘
     ═══════════════════════════════════════════════════════════ */

  function setKeypad(on) {
    prefs.keypad = !!on;
    savePrefs();
    els.keypad.hidden = !prefs.keypad;
    els.keypadToggle.setAttribute('aria-expanded', String(prefs.keypad));
    els.keypadToggle.textContent = prefs.keypad ? '收起键盘' : '键盘';
  }

  function keypadPress(key) {
    var el = els.amount;
    var v = el.value;
    if (key === 'back') {
      el.value = v.slice(0, -1);
    } else if (key === 'enter') {
      submitEntry();
      return;
    } else if (key === '00') {
      el.value = v + '00';
    } else {
      el.value = v + key;
    }
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /* ═══════════════════════════════════════════════════════════
     导入导出
     ═══════════════════════════════════════════════════════════ */

  function stamp() {
    var d = new Date();
    return d.getFullYear() + L.pad2(d.getMonth() + 1) + L.pad2(d.getDate()) +
      '-' + L.pad2(d.getHours()) + L.pad2(d.getMinutes());
  }

  function exportJSON() {
    L.download('流水账-' + stamp() + '.json', L.toJSON(state.data), 'application/json');
    toast('已导出 JSON，' + state.data.records.length + ' 笔。');
  }

  function exportCSV() {
    L.download('流水账-' + stamp() + '.csv', L.toCSV(state.data), 'text/csv');
    toast('已导出 CSV，' + state.data.records.length + ' 笔。');
  }

  function doImport(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var res = L.parseAnyImport(state.data, String(reader.result || ''));
      if (res.error) {
        toast('导入失败：' + esc(res.error), { kind: 'bad', duration: 7000 });
        return;
      }

      var existing = {};
      state.data.records.forEach(function (r) {
        existing[[r.date, r.time, r.type, r.amount, r.category, r.note].join('|')] = true;
      });

      var fresh = [], dup = 0;
      res.records.forEach(function (r) {
        var key = [r.date, r.time, r.type, r.amount, r.category, r.note].join('|');
        if (existing[key]) { dup++; return; }
        existing[key] = true;
        fresh.push(r);
      });

      if (!fresh.length) {
        toast('没有新记录：读到 ' + res.records.length + ' 笔，' + dup +
          ' 笔已经在账本里了。', { duration: 6000 });
        renderAll();
        return;
      }

      confirmSheet('导入',
        '读到 <b>' + res.records.length + '</b> 笔，其中 <b>' + fresh.length + '</b> 笔是新的，' +
        '<b>' + dup + '</b> 笔重复。' +
        (res.created && res.created.length
          ? '<br>会新建分类：' + esc(res.created.join('、')) + '。' : '') +
        '<br>把它们合并进现在的账本？',
        '合并导入').then(function (ok) {
        if (!ok) { renderAll(); return; }
        fresh.forEach(function (r) { state.data.records.push(r); });
        persist();
        renderAll();
        toast('导入完成：新增 <b>' + fresh.length + '</b> 笔。', { kind: 'good' });
      });
    };
    reader.onerror = function () {
      toast('读不了这个文件。', { kind: 'bad' });
    };
    reader.readAsText(file, 'utf-8');
  }

  /* ═══════════════════════════════════════════════════════════
     设置页交互
     ═══════════════════════════════════════════════════════════ */

  function collectBudgetInputs() {
    var monthly = $('bud-monthly');
    if (!monthly) return;
    var v = L.parseAmount(monthly.value);
    state.data.budgets.monthly = v === null ? 0 : v;

    var by = {};
    Array.prototype.forEach.call(els.panelSetup.querySelectorAll('[data-budcat]'), function (inp) {
      var cents = L.parseAmount(inp.value);
      if (cents) by[inp.dataset.budcat] = cents;
    });
    state.data.budgets.byCategory = by;
  }

  /* ═══════════════════════════════════════════════════════════
     事件绑定
     ═══════════════════════════════════════════════════════════ */

  function bind() {
    /* — 纸卷：类型 — */
    els.segBtns.forEach(function (b) {
      b.addEventListener('click', function () { setDraftType(b.dataset.type); });
    });

    /* — 纸卷：分类 — */
    els.categoryPicker.addEventListener('click', function (e) {
      var c = e.target.closest('[data-cat]');
      if (c) pickCategory(c.dataset.cat);
    });

    /* — 纸卷：键盘 — */
    els.keypadToggle.addEventListener('click', function () { setKeypad(!prefs.keypad); });
    els.keypad.addEventListener('click', function (e) {
      var b = e.target.closest('[data-key]');
      if (b) keypadPress(b.dataset.key);
    });

    /* — 纸卷：表单 — */
    els.entry.addEventListener('submit', function (e) {
      e.preventDefault();
      submitEntry();
    });
    els.cancelEdit.addEventListener('click', cancelEdit);

    els.note.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitEntry(); }
    });
    els.date.addEventListener('change', function () {
      state.draft.date = els.date.value || L.todayStr();
    });

    /* — 纸卷：今日流水 — */
    els.todayList.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) { deleteRecord(del.dataset.del); return; }
      var ed = e.target.closest('[data-edit]');
      if (ed) startEdit(ed.dataset.edit);
    });

    /* — 账页：月份 — */
    els.prevMonth.addEventListener('click', function () { gotoMonth(L.ymShift(state.ym, -1)); });
    els.nextMonth.addEventListener('click', function () { gotoMonth(L.ymShift(state.ym, 1)); });
    els.thisMonth.addEventListener('click', function () { gotoMonth(L.ymOf(L.todayStr())); });
    els.allTime.addEventListener('click', function () {
      state.allTime = !state.allTime;
      state.flowLimit = 120;
      // 「全部」是流水页的概念，切过去才看得见效果
      if (state.allTime) state.tab = 'flow';
      renderAll();
    });
    els.monthLabel.addEventListener('click', function () {
      if (typeof els.monthPicker.showPicker === 'function') {
        try { els.monthPicker.showPicker(); return; } catch (e) { /* 回退 */ }
      }
      els.monthPicker.focus();
      els.monthPicker.click();
    });
    els.monthPicker.addEventListener('change', function () {
      if (L.isYm(els.monthPicker.value)) gotoMonth(els.monthPicker.value);
    });

    /* — 账页：页签 — */
    els.tabs.forEach(function (t) { t.addEventListener('click', function () { switchTab(t.dataset.tab); }); });
    els.tabList.addEventListener('keydown', function (e) {
      var i = els.tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
      if (next < 0 || next >= els.tabs.length) return;
      e.preventDefault();
      els.tabs[next].focus();
      switchTab(els.tabs[next].dataset.tab);
    });

    /* — 流水页：筛选 — */
    function rerenderFlow() {
      state.flowLimit = 120;
      renderFlow();
    }
    els.filterBar.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'f-q') { state.filters.q = t.value; state.flowLimit = 120; renderGroups(); }
      else if (t.id === 'f-min') { state.filters.min = t.value; state.flowLimit = 120; renderGroups(); }
      else if (t.id === 'f-max') { state.filters.max = t.value; state.flowLimit = 120; renderGroups(); }
    });
    els.filterBar.addEventListener('change', function (e) {
      if (e.target.id === 'f-cat') { state.filters.cat = e.target.value; rerenderFlow(); }
    });
    els.filterBar.addEventListener('click', function (e) {
      var sw = e.target.closest('[data-ftype]');
      if (sw) { state.filters.type = sw.dataset.ftype; rerenderFlow(); return; }
      if (e.target.id === 'f-clear') { clearFilters(); }
    });

    els.panelFlow.addEventListener('click', function (e) {
      if (e.target.id === 'f-clear' || e.target.id === 'empty-clear') { clearFilters(); return; }
      if (e.target.id === 'empty-today') {
        if (state.allTime) { state.allTime = false; renderAll(); switchTab('flow'); els.amount.focus(); }
        else gotoMonth(L.ymOf(L.todayStr()));
        return;
      }
      if (e.target.id === 'more-btn') { state.flowLimit += 200; renderGroups(); return; }

      var del = e.target.closest('[data-del]');
      if (del) { deleteRecord(del.dataset.del); return; }
      var ed = e.target.closest('[data-edit]');
      if (ed) startEdit(ed.dataset.edit);
    });

    /* — 统计页 — */
    els.panelStats.addEventListener('click', function (e) {
      var sw = e.target.closest('[data-bc]');
      if (sw) { state.bcKind = sw.dataset.bc; renderStats(); return; }
      var row = e.target.closest('.bc-row');
      if (row) {
        state.filters.cat = row.dataset.cat;
        state.filters.type = row.dataset.kind;
        state.flowLimit = 120;
        switchTab('flow');
        return;
      }
      if (e.target.closest('[data-goto="setup"]')) switchTab('setup');
    });

    /* — 设置页 — */
    els.panelSetup.addEventListener('click', function (e) {
      var t = e.target;
      if (t.id === 'export-json') { exportJSON(); return; }
      if (t.id === 'export-csv') { exportCSV(); return; }
      if (t.id === 'import-btn') { $('import-file').click(); return; }
      if (t.id === 'save-budget') {
        collectBudgetInputs();
        persist();
        renderAll();
        toast('预算已保存。', { kind: 'good' });
        return;
      }
      if (t.id === 'install-app') { promptInstall(); return; }
      if (t.id === 'wipe-btn') {
        confirmSheet('清空数据',
          '账本里有 <b>' + state.data.records.length + '</b> 笔记录。清空之后全部消失，' +
          '没法恢复。建议先导出 JSON。<br><br>确定要清空？', '清空').then(function (ok) {
          if (!ok) return;
          state.data = L.blank();
          persist();
          renderAll();
          toast('账本已清空。');
        });
        return;
      }

      var delc = t.closest('[data-delcat]');
      if (delc) {
        var cid = delc.dataset.delcat;
        var c = state.data.categories.filter(function (x) { return x.id === cid; })[0];
        if (!c) return;
        var n = L.countByCategory(state.data, cid);
        confirmSheet('删除分类',
          '删除「<b>' + esc(c.name) + '</b>」？' +
          (n ? '<br>它名下有 <b>' + n + '</b> 笔记录，会全部改挂到同类型的另一个分类上，记录不会丢。' : ''),
          '删除').then(function (ok) {
          if (!ok) return;
          var res = L.removeCategory(state.data, cid);
          if (res && res.ok === false) {
            toast('同类型至少要留一个分类，删不了。', { kind: 'bad' });
            return;
          }
          persist();
          renderAll();
          toast('已删除「' + esc(c.name) + '」' +
            (res.moved ? '，' + res.moved + ' 笔改挂到「' + esc(res.fallback.name) + '」。' : '。'));
        });
        return;
      }

      var addc = t.closest('[data-addcat]');
      if (addc) {
        var type = addc.dataset.addcat;
        var input = els.panelSetup.querySelector('[data-newcat="' + type + '"]');
        var name = input ? input.value.trim() : '';
        if (!name) { toast('先写个分类名。', { kind: 'bad' }); if (input) input.focus(); return; }
        var made = L.addCategory(state.data, name, type);
        if (!made) { toast('这个分类已经在了。'); renderSetup(); return; }
        persist();
        renderAll();
        toast('已添加分类「' + esc(made.name) + '」。', { kind: 'good' });
      }
    });

    els.panelSetup.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'import-file') {
        if (t.files && t.files[0]) doImport(t.files[0]);
        t.value = '';
        return;
      }
      if (t.dataset.rename) {
        var id = t.dataset.rename;
        var name = t.value.trim();
        var before = state.data.categories.filter(function (c) { return c.id === id; })[0];
        if (!before || name === before.name) { renderSetup(); return; }
        if (!name) { toast('分类名不能是空的。', { kind: 'bad' }); renderSetup(); return; }
        L.renameCategory(state.data, id, name);
        persist();
        renderAll();
        toast('分类改成「' + esc(name) + '」了。');
      }
    });

    els.panelSetup.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (t.dataset.newcat) {
        e.preventDefault();
        var btn = els.panelSetup.querySelector('[data-addcat="' + t.dataset.newcat + '"]');
        if (btn) btn.click();
      } else if (t.dataset.rename) {
        t.blur();
      }
    });

    /* — 全局快捷键 — */
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

      if (e.key === 'Escape') {
        if (state.editingId) { cancelEdit(); return; }
        if (typing) { e.target.blur(); return; }
        if (hasFilters()) { clearFilters(); }
        return;
      }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); gotoMonth(L.ymShift(state.ym, -1)); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); gotoMonth(L.ymShift(state.ym, 1)); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        els.amount.focus();
      } else if (e.key === '/') {
        e.preventDefault();
        switchTab('flow');
        var q = $('f-q');
        if (q) q.focus();
      }
    });

    /* — 别的标签页改了账本：同步过来 — */
    global.addEventListener('storage', function (e) {
      if (e.key !== L.KEY || e.newValue == null) return;
      state.data = L.load();
      if (state.editingId && !state.data.records.some(function (r) { return r.id === state.editingId; })) {
        cancelEdit();
      }
      renderAll();
      toast('另一个标签页动了账本，已经同步过来。');
    });
  }

  function clearFilters() {
    state.filters = { q: '', type: 'all', cat: '', min: '', max: '' };
    state.flowLimit = 120;
    renderFlow();
  }

  /* ═══════════════════════════════════════════════════════════
     PWA
     ═══════════════════════════════════════════════════════════ */

  function promptInstall() {
    var ev = els.installPrompt;
    if (!ev) return;
    els.installPrompt = null;
    ev.prompt();
    ev.userChoice.then(function (choice) {
      if (choice && choice.outcome === 'accepted') toast('已经装好了。', { kind: 'good' });
      else renderSetup();
    });
  }

  function setupPWA() {
    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      els.installPrompt = e;
      if (state.tab === 'setup') renderSetup();
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost-btn';
      btn.textContent = '装到主屏';
      btn.addEventListener('click', function () { promptInstall(); btn.remove(); });
      els.mastheadRight.appendChild(btn);
    });

    global.addEventListener('appinstalled', function () {
      els.installPrompt = null;
      toast('已经装到主屏了，下次离线也能打开。', { kind: 'good' });
    });

    if ('serviceWorker' in navigator &&
        (location.protocol === 'http:' || location.protocol === 'https:')) {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('离线缓存没装上：', e);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     启动
     ═══════════════════════════════════════════════════════════ */

  function cacheEls() {
    els.toasts = $('toasts');
    els.dialog = $('confirm-dialog');
    els.dialogTitle = $('confirm-title');
    els.dialogBody = $('confirm-body');
    els.dialogOk = $('confirm-ok');
    els.dialogCancel = $('confirm-cancel');

    els.masthead = document.querySelector('.masthead');
    els.mastheadRight = document.querySelector('.masthead-right');
    els.stamp = $('today-stamp');
    els.tape = document.querySelector('.tape');
    els.tapeTitle = $('tape-title');

    els.entry = $('entry-form');
    els.segBtns = Array.prototype.slice.call(document.querySelectorAll('.seg-btn'));
    els.amount = $('amount');
    els.note = $('note');
    els.date = $('date');
    els.keypad = $('keypad');
    els.keypadToggle = $('keypad-toggle');
    els.categoryPicker = $('category-picker');
    els.printLabel = $('print-label');
    els.cancelEdit = $('cancel-edit');
    els.formError = $('form-error');

    els.todayList = $('today-list');
    els.todayEmpty = $('today-empty');
    els.todayMeta = $('today-meta');
    els.todayExpense = $('today-expense');
    els.todayIncome = $('today-income');
    els.streak = $('streak');
    els.budgetWarn = $('budget-warn');

    els.monthLabel = $('month-label');
    els.monthPicker = $('month-picker');
    els.prevMonth = $('prev-month');
    els.nextMonth = $('next-month');
    els.thisMonth = $('this-month');
    els.allTime = $('all-time');
    els.tabList = document.querySelector('.tabs');
    els.tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    els.panelFlow = $('panel-flow');
    els.panelStats = $('panel-stats');
    els.panelSetup = $('panel-setup');
    els.summary = $('summary');
    els.filterBar = $('filter-bar');
    els.groups = $('groups');
  }

  function boot() {
    cacheEls();

    state.data = L.load();
    state.draft.date = L.todayStr();
    state.flowLimit = 120;

    // manifest 里的快捷方式：?tab=stats / ?action=add
    var params = new URLSearchParams(global.location.search);
    if (params.get('tab') === 'stats') state.tab = 'stats';
    if (params.get('tab') === 'setup') state.tab = 'setup';

    els.stamp.textContent = L.cnDate(L.todayStr()) + ' · ' +
      String(new Date().getFullYear()) + ' 年第 ' +
      Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 86400000 + 1) + ' 天';

    els.date.value = state.draft.date;
    state.draft.time = L.nowTime();
    setKeypad(prefs.keypad);
    ensureDraftCategory();

    bind();
    renderAll();
    setupPWA();

    if (!L.storageOK) {
      toast('浏览器不让写本地数据，这次的记录关掉页面就没了。检查一下无痕模式或网站数据设置。',
        { kind: 'bad', duration: 12000 });
    }

    els.amount.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
