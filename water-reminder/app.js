/* ============================================================
   水尺 · Water Gauge
   自动提醒喝水：定时提醒（桌面通知 + 提示音 + 横幅）、
   按作息时段计算应到水位、拖拽水位记录、本地存储、7 天历史。
   ============================================================ */
(() => {
  'use strict';

  const KEY = 'water-gauge.v1';
  const SNOOZE_MS = 10 * 60 * 1000;
  const NUDGE_SIP = 250;

  const $ = (id) => document.getElementById(id);

  /* ── 工具 ───────────────────────────────────────── */
  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtMl = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 状态 ───────────────────────────────────────── */
  const DEFAULTS = {
    settings: { interval: 45, goal: 2000, dayStart: '08:00', dayEnd: '22:00', sound: true, paused: false },
    days: {},
    snoozeUntil: 0,
    notifyAsked: false,
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return clone(DEFAULTS);
      const p = JSON.parse(raw);
      const s = Object.assign(clone(DEFAULTS), p);
      s.settings = Object.assign(clone(DEFAULTS.settings), p.settings || {});
      s.days = p.days && typeof p.days === 'object' ? p.days : {};
      if (!(s.settings.goal > 0)) s.settings.goal = 2000;
      return s;
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  let state = load();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式下静默 */ }
  }

  function prune(keep = 60) {
    const keys = Object.keys(state.days).sort();
    while (keys.length > keep) delete state.days[keys.shift()];
  }

  /* ── 选择器：记录 / 节奏 / 计划 ──────────────────── */
  const todayEntries = () => (state.days[dayKey()] || {}).entries || [];

  function entriesOf(key) {
    const d = state.days[key];
    if (!d || !Array.isArray(d.entries)) return [];
    return d.entries;
  }

  const sumMl = (list) => list.reduce((a, e) => a + (Number(e.ml) || 0), 0);
  const todayTotal = () => sumMl(todayEntries());
  const lastEntryTs = () => {
    const list = todayEntries();
    return list.length ? Math.max(...list.map((e) => e.ts)) : 0;
  };

  function addEntry(ml, label) {
    const key = dayKey();
    const day = state.days[key] || (state.days[key] = { entries: [] });
    day.entries.push({ id: uid(), ts: Date.now(), ml: Math.round(ml), label });
    prune();
    state.snoozeUntil = 0;
    save();
  }

  function removeEntry(id) {
    const list = todayEntries();
    const i = list.findIndex((e) => e.id === id);
    if (i >= 0) { list.splice(i, 1); save(); }
  }

  function windowFor(date = new Date()) {
    const [sh, sm] = state.settings.dayStart.split(':').map(Number);
    const [eh, em] = state.settings.dayEnd.split(':').map(Number);
    const start = new Date(date); start.setHours(sh || 0, sm || 0, 0, 0);
    const end = new Date(date); end.setHours(eh || 0, em || 0, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start, end };
  }

  function pace(now = new Date()) {
    const w = windowFor(now);
    const span = w.end - w.start;
    const f = span > 0 ? clamp((now - w.start) / span, 0, 1) : 0;
    const expected = state.settings.goal * f;
    const total = todayTotal();
    return { w, f, expected, total, delta: total - expected };
  }

  /** 计划时刻：按固定间隔铺满整个作息时段的"应到水位"时刻表 */
  function slots(now = new Date()) {
    const w = windowFor(now);
    const iv = Math.max(5, state.settings.interval) * 60000;
    const out = [];
    for (let t = w.start.getTime() + iv; t < w.end.getTime() && out.length < 60; t += iv) out.push(t);
    return out;
  }

  function schedule(now = new Date()) {
    const s = state.settings;
    const w = windowFor(now);
    if (s.paused) return { kind: 'paused' };

    const tomorrowStart = () => { const d = new Date(w.start); d.setDate(d.getDate() + 1); return d; };
    if (now < w.start) return { kind: 'before', at: w.start };
    if (now >= w.end) return { kind: 'after', at: tomorrowStart() };

    const iv = Math.max(5, s.interval) * 60000;
    const last = lastEntryTs();
    const base = last ? last + iv : w.start.getTime() + iv;
    const at = Math.max(base, state.snoozeUntil || 0);
    if (at >= w.end.getTime()) return { kind: 'done' };

    const due = new Date(at);
    return { kind: 'scheduled', at: due, pending: now.getTime() >= at };
  }

  /* ── 声音 ───────────────────────────────────────── */
  let ctx = null;

  function audio() {
    if (!state.settings.sound) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) { try { ctx = new AC(); } catch (e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, delay, dur, peak) {
    const c = audio();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(c.destination);
    const t = c.currentTime + delay;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  const chimeRemind = () => { tone(659.25, 0, 0.55, 0.16); tone(987.77, 0.18, 0.6, 0.12); };
  const chimeLog = () => tone(1046.5, 0, 0.14, 0.07);

  /* ── 桌面通知 ───────────────────────────────────── */
  function notifyState() {
    return ('Notification' in window) ? Notification.permission : 'unsupported';
  }

  function sendNotification(title, body) {
    if (notifyState() !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag: 'water-gauge', renotify: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* 某些浏览器在无 Service Worker 时抛错，忽略 */ }
  }

  function askNotify() {
    if (notifyState() !== 'default' || state.notifyAsked) return;
    state.notifyAsked = true;
    save();
    try { Notification.requestPermission().then(() => renderSettings()); } catch (e) { /* 忽略 */ }
  }

  /* ── 提醒触发 ───────────────────────────────────── */
  let chimedFor = null;

  function fire(at) {
    chimedFor = at.getTime();
    chimeRemind();
    const ws = windowFor();
    const last = lastEntryTs();
    const mins = last ? Math.max(1, Math.round((Date.now() - last) / 60000)) : Math.round((Date.now() - ws.start) / 60000);
    const body = last
      ? `${mins} 分钟没喝水了。记一杯，大约 ${NUDGE_SIP} ml。`
      : `今天还没喝过水。先来一杯，大约 ${NUDGE_SIP} ml。`;
    sendNotification('该喝水了', body);
  }

  /* ── 刻度柱 ─────────────────────────────────────── */
  const scale = $('scale');
  const rail = $('rail');
  const water = $('water');
  const gap = $('gap');
  const cursor = $('cursor');
  const ticksBox = $('ticks');
  const labelsBox = $('scaleLabels');
  const timesBox = $('scaleTimes');

  const mq = window.matchMedia('(max-width: 899px)');
  let horizontal = mq.matches;

  let cursorLabel = null;
  let marks = [];

  function tickStep(goal) {
    for (const st of [250, 500, 1000]) if (goal / st <= 9) return st;
    return 1000;
  }

  function pos(el, pct) {
    if (horizontal) el.style.left = pct + '%';
    else el.style.bottom = pct + '%';
  }

  function buildScale() {
    const goal = state.settings.goal;
    const step = tickStep(goal);
    const minorStep = step / 5;

    // 刻线与毫升标签（顶端固定为目标线）
    const frag = document.createDocumentFragment();
    const labelFrag = document.createDocumentFragment();

    const addTick = (pct, major) => {
      const t = document.createElement('span');
      t.className = 'tick ' + (major ? 'tick--major' : 'tick--minor');
      pos(t, pct);
      frag.appendChild(t);
    };
    const addLabel = (pct, text) => {
      const l = document.createElement('span');
      l.className = 'scale__label';
      l.textContent = text;
      if (horizontal) {
        l.style.left = pct + '%';
        l.style.transform = 'translateX(' + (pct <= 0.5 ? '0' : pct >= 99.5 ? '-100%' : '-50%') + ')';
      } else {
        l.style.bottom = 'calc(' + pct + '% - 6px)';
      }
      labelFrag.appendChild(l);
    };

    for (let v = 0; v < goal - 1e-6; v += minorStep) {
      const pct = (v / goal) * 100;
      const major = Math.abs(v % step) < 1e-6;
      addTick(pct, major);
      if (major) addLabel(pct, fmtMl(v));
    }
    addTick(100, true);
    addLabel(100, fmtMl(goal));

    ticksBox.replaceChildren(frag);
    labelsBox.replaceChildren(labelFrag);

    // 计划时刻标记（仅竖放时显示）
    marks = [];
    timesBox.replaceChildren();
    cursorLabel = null;

    if (!horizontal) {
      const w = windowFor();
      const span = w.end - w.start;
      const list = slots();
      const railH = rail.clientHeight || 560;
      const showLabels = list.length > 0 && railH / list.length >= 24;
      const now = Date.now();
      let nearest = -1;
      let best = Infinity;

      list.forEach((t, i) => {
        const d = Math.abs(t - now);
        if (d < best) { best = d; nearest = i; }
      });

      list.forEach((t, i) => {
        const pct = ((t - w.start.getTime()) / span) * 100;
        const el = document.createElement('span');
        el.className = 'scale__mark';
        el.style.bottom = pct + '%';
        el.style.transform = 'translateY(50%)';
        el.textContent = (showLabels && i !== nearest) ? hhmm(new Date(t)) : '';
        timesBox.appendChild(el);
        marks.push({ el, t });
      });

      const cl = document.createElement('span');
      cl.className = 'scale__cursor-label';
      cl.textContent = '现在';
      timesBox.appendChild(cl);
      cursorLabel = cl;
    }

    paintScale(true);
  }

  let lastWater = -1;
  let lastCursor = -1;

  function paintScale(force) {
    const goal = state.settings.goal;
    const now = new Date();
    const p = pace(now);
    const sch = schedule(now);

    const waterPct = clamp(p.total / goal, 0, 1) * 100;
    if (force || waterPct !== lastWater) {
      lastWater = waterPct;
      if (horizontal) water.style.width = waterPct + '%';
      else water.style.height = waterPct + '%';
      water.dataset.zero = p.total > 0 ? '0' : '1';
    }

    // 落后于应到水位的缺口
    const expectPct = clamp(p.expected / goal, 0, 1) * 100;
    const behind = p.delta < -50 && p.f > 0 && p.f < 1;
    if (behind) {
      const lo = Math.min(waterPct, expectPct);
      const h = Math.abs(expectPct - waterPct);
      if (horizontal) { gap.style.left = lo + '%'; gap.style.width = h + '%'; }
      else { gap.style.bottom = lo + '%'; gap.style.height = h + '%'; }
      gap.classList.add('is-on');
    } else {
      gap.classList.remove('is-on');
    }

    // 应到水位游标
    const inWindow = now >= p.w.start && now < p.w.end && !state.settings.paused;
    const cursorPct = expectPct;
    if (force || cursorPct !== lastCursor) {
      lastCursor = cursorPct;
      pos(cursor, cursorPct);
      if (cursorLabel) {
        cursorLabel.style.bottom = 'calc(' + cursorPct + '% - 6px)';
        cursorLabel.classList.toggle('is-due', !!sch.pending);
      }
    }
    cursor.classList.toggle('is-on', inWindow);
    cursor.classList.toggle('is-due', !!sch.pending);

    marks.forEach((m) => {
      const isPast = m.t <= now.getTime();
      m.el.classList.toggle('is-past', isPast);
      m.el.classList.toggle('is-future', !isPast);
    });
  }

  /* ── 渲染：读数 / 记录 / 7 天 / 设置 / 横幅 ──────── */
  const statusChip = $('statusChip');
  const totalEl = $('totalMl');
  const goalEl = $('goalMl');
  const nextLine = $('nextLine');
  const logList = $('logList');
  const logEmpty = $('logEmpty');
  const logMeta = $('logMeta');
  const weekBox = $('week');
  const nudge = $('nudge');
  const nudgeSub = $('nudgeSub');
  const nudgeLog = $('nudgeLog');
  const pauseBtn = $('pauseBtn');

  function statusOf(p, sch) {
    if (state.settings.paused) return { state: 'paused', text: '已暂停' };
    if (sch.pending) return { state: 'due', text: '该喝水了' };
    if (p.total >= state.settings.goal) return { state: 'reached', text: '已达标' };
    if (p.delta >= 150) return { state: 'ahead', text: `提前 ${fmtMl(p.delta)} ml` };
    if (p.delta <= -150) return { state: 'behind', text: `落后 ${fmtMl(-p.delta)} ml` };
    return { state: 'on-track', text: '按计划' };
  }

  function nextText(sch, now) {
    const s = state.settings;
    switch (sch.kind) {
      case 'paused': return '提醒已暂停。点左上角「继续提醒」恢复。';
      case 'before': return `提醒从 ${hhmm(sch.at)} 开始。`;
      case 'after': return `已过作息时段（${s.dayEnd}）。明天 ${s.dayStart} 继续。`;
      case 'done': return `今天的提醒结束了。明天 ${s.dayStart} 继续。`;
      default: break;
    }
    const last = lastEntryTs();
    if (sch.pending) {
      return last
        ? `现在该喝水了。上次喝水在 ${hhmm(new Date(last))}。`
        : '现在该喝水了。今天还没记录。';
    }
    const mins = Math.max(0, Math.round((sch.at - now) / 60000));
    const tail = last ? `上次喝水 ${hhmm(new Date(last))}` : '今天还没有记录';
    return `下次提醒 ${hhmm(sch.at)}（还有 ${mins} 分钟）。${tail}。`;
  }

  let logSig = null;

  function renderLog(force) {
    const list = todayEntries().slice().sort((a, b) => b.ts - a.ts);
    const sig = list.map((e) => e.id + ':' + e.ml).join('|');
    if (!force && sig === logSig) return;
    logSig = sig;
    logMeta.textContent = list.length ? `共 ${list.length} 次 · ${fmtMl(sumMl(list))} ml` : '';
    logEmpty.hidden = list.length > 0;
    logList.replaceChildren(...list.map((e) => {
      const li = document.createElement('li');
      li.className = 'log__row';
      li.innerHTML =
        `<span class="log__time">${hhmm(new Date(e.ts))}</span>` +
        `<span class="log__name">${esc(e.label || '记录')}</span>` +
        `<span class="log__ml">${fmtMl(e.ml)} ml</span>` +
        `<button class="log__del" type="button" data-id="${esc(e.id)}" aria-label="删除 ${hhmm(new Date(e.ts))} 的 ${fmtMl(e.ml)} 毫升记录">删除</button>`;
      return li;
    }));
  }

  let weekSig = null;

  function renderWeek(force) {
    const goal = state.settings.goal;
    const cn = ['日', '一', '二', '三', '四', '五', '六'];
    const today = dayKey();
    const cells = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = dayKey(d);
      const ml = sumMl(entriesOf(key));
      const h = clamp(ml / goal, 0, 1) * 100;
      const isToday = key === today;
      cells.push(
        `<div class="week__day${isToday ? ' is-today' : ''}" title="${key} · ${fmtMl(ml)} ml">` +
          `<span class="week__ml">${ml ? fmtMl(ml) : '—'}</span>` +
          `<div class="week__bar"><span class="week__goal"></span><span class="week__fill" style="height:${h}%"></span></div>` +
          `<span class="week__label">${isToday ? '今天' : '周' + cn[d.getDay()]}</span>` +
        `</div>`
      );
    }
    const html = cells.join('');
    if (!force && html === weekSig) return;
    weekSig = html;
    weekBox.innerHTML = html;
  }

  const setIntervalEl = $('setInterval');
  const setGoalEl = $('setGoal');
  const setStartEl = $('setStart');
  const setEndEl = $('setEnd');
  const setSoundEl = $('setSound');
  const notifyBtn = $('notifyBtn');
  const notifyHint = $('notifyHint');

  function renderSettings() {
    const s = state.settings;
    setIntervalEl.value = String(s.interval);
    setGoalEl.value = String(s.goal);
    setStartEl.value = s.dayStart;
    setEndEl.value = s.dayEnd;
    setSoundEl.checked = !!s.sound;

    const ns = notifyState();
    if (ns === 'unsupported') {
      notifyBtn.textContent = '此浏览器不支持桌面通知';
      notifyBtn.disabled = true;
      notifyHint.hidden = true;
    } else if (ns === 'granted') {
      notifyBtn.textContent = '桌面通知已开启';
      notifyBtn.disabled = true;
      notifyHint.hidden = true;
    } else if (ns === 'denied') {
      notifyBtn.textContent = '桌面通知被禁止';
      notifyBtn.disabled = true;
      notifyHint.hidden = false;
      notifyHint.textContent = '浏览器禁止了桌面通知，需要在地址栏的网站设置里重新允许。页面横幅、提示音和标题提醒仍然有效。';
    } else {
      notifyBtn.textContent = '开启桌面通知';
      notifyBtn.disabled = false;
      notifyHint.hidden = true;
    }
  }

  function renderNudge(sch, p) {
    nudge.hidden = !sch.pending;
    if (!sch.pending) return;
    const last = lastEntryTs();
    const mins = last
      ? Math.max(1, Math.round((Date.now() - last) / 60000))
      : Math.round((Date.now() - p.w.start) / 60000);
    nudgeSub.textContent = last
      ? `上次喝水是 ${mins} 分钟前（${hhmm(new Date(last))}）。`
      : `今天还没喝过水，已经过了 ${Math.max(1, mins)} 分钟。`;
  }

  let lastTitle = '';

  function render() {
    const now = new Date();
    const p = pace(now);
    const sch = schedule(now);

    totalEl.textContent = fmtMl(p.total);
    goalEl.textContent = fmtMl(state.settings.goal);

    const st = statusOf(p, sch);
    if (statusChip.dataset.state !== st.state) statusChip.dataset.state = st.state;
    statusChip.textContent = st.text;

    nextLine.textContent = nextText(sch, now);
    nextLine.classList.toggle('is-due', !!sch.pending);

    pauseBtn.textContent = state.settings.paused ? '继续提醒' : '暂停提醒';

    const title = sch.pending ? '该喝水了 · 水尺'
      : state.settings.paused ? '提醒已暂停 · 水尺'
      : `${fmtMl(p.total)} ml · 水尺`;
    if (title !== lastTitle) { lastTitle = title; document.title = title; }

    paintScale(false);
    renderLog();
    renderWeek();
    renderNudge(sch, p);
  }

  /* ── 主循环 ─────────────────────────────────────── */
  let currentDay = dayKey();

  function tick() {
    const now = new Date();
    if (dayKey(now) !== currentDay) {
      currentDay = dayKey(now);
      buildScale();
      renderWeek();
    }
    const sch = schedule(now);
    if (sch.pending && chimedFor !== sch.at.getTime() && !document.hidden) fire(sch.at);
    render();
  }

  /* ── 记录动作 ───────────────────────────────────── */
  function log(ml, label) {
    if (!(ml > 0)) return;
    addEntry(ml, label);
    chimeLog();
    askNotify();
    render();
  }

  const gaugeHint = document.querySelector('.gauge__hint');
  const hintDefault = gaugeHint.textContent;
  let hintTimer = 0;

  function tempHint(text) {
    gaugeHint.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { gaugeHint.textContent = hintDefault; }, 4000);
  }

  /* 拖拽水位记录 */
  let dragging = false;
  let dragMl = 0;

  function pctFromEvent(e) {
    const r = rail.getBoundingClientRect();
    if (horizontal) return clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    return clamp((r.bottom - e.clientY) / Math.max(1, r.height), 0, 1);
  }

  function dragPreview(e) {
    const pct = pctFromEvent(e);
    dragMl = Math.round((pct * state.settings.goal) / 10) * 10;
    const shown = clamp(dragMl / state.settings.goal, 0, 1) * 100;
    if (horizontal) water.style.width = shown + '%';
    else water.style.height = shown + '%';
    water.dataset.zero = dragMl > 0 ? '0' : '1';
  }

  rail.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    rail.classList.add('is-dragging');
    try { rail.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    dragPreview(e);
    e.preventDefault();
  });

  rail.addEventListener('pointermove', (e) => { if (dragging) dragPreview(e); });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('is-dragging');
    try { rail.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    const total = todayTotal();
    if (dragMl > total) {
      log(dragMl - total, '刻度尺');
    } else if (dragMl < total - 10) {
      tempHint('水位只能往上加。要减少的话，在下面的记录里删除一条。');
      lastWater = -1;
      render();
    } else {
      lastWater = -1;
      render();
    }
  }

  rail.addEventListener('pointerup', endDrag);
  rail.addEventListener('pointercancel', endDrag);

  /* 预设与自定义 */
  $('presets').addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    log(Number(btn.dataset.ml), btn.dataset.name);
  });

  const customForm = $('customForm');
  const customMl = $('customMl');
  const customError = $('customError');

  customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Math.round(Number(customMl.value));
    if (!(v >= 10 && v <= 2000)) {
      customError.hidden = false;
      customError.textContent = '请输入 10–2000 之间的毫升数。';
      customMl.focus();
      return;
    }
    customError.hidden = true;
    customMl.value = '';
    log(v, '其他');
  });

  logList.addEventListener('click', (e) => {
    const btn = e.target.closest('.log__del');
    if (!btn) return;
    removeEntry(btn.dataset.id);
    lastWater = -1;
    render();
    renderWeek();
  });

  /* 设置 */
  const applySetting = (fn, rebuild) => {
    fn();
    save();
    lastWater = -1; lastCursor = -1;
    if (rebuild) buildScale();
    render();
    renderWeek();
  };

  setIntervalEl.addEventListener('change', () => applySetting(() => { state.settings.interval = Number(setIntervalEl.value) || 45; }, true));
  setGoalEl.addEventListener('change', () => applySetting(() => {
    const v = Math.round(Number(setGoalEl.value));
    state.settings.goal = (v >= 500 && v <= 6000) ? v : state.settings.goal;
    setGoalEl.value = String(state.settings.goal);
  }, true));
  setStartEl.addEventListener('change', () => applySetting(() => { state.settings.dayStart = setStartEl.value || '08:00'; }, true));
  setEndEl.addEventListener('change', () => applySetting(() => { state.settings.dayEnd = setEndEl.value || '22:00'; }, true));
  setSoundEl.addEventListener('change', () => {
    state.settings.sound = setSoundEl.checked;
    save();
    if (state.settings.sound) chimeLog();
  });

  $('testChime').addEventListener('click', () => {
    const wasOff = !state.settings.sound;
    if (wasOff) state.settings.sound = true;
    chimeRemind();
    if (wasOff) setTimeout(() => { state.settings.sound = false; }, 900);
  });

  notifyBtn.addEventListener('click', () => {
    if (notifyState() !== 'default') return;
    state.notifyAsked = true;
    save();
    try { Notification.requestPermission().then(() => renderSettings()); } catch (e) { renderSettings(); }
  });

  $('resetBtn').addEventListener('click', () => {
    if (!todayEntries().length) { tempHint('今天还没有记录。'); return; }
    if (!window.confirm('确定清空今天的所有记录吗？')) return;
    delete state.days[dayKey()];
    state.snoozeUntil = 0;
    save();
    lastWater = -1;
    render();
    renderWeek();
  });

  pauseBtn.addEventListener('click', () => {
    state.settings.paused = !state.settings.paused;
    if (!state.settings.paused) { chimedFor = null; state.snoozeUntil = 0; }
    save();
    render();
  });

  /* 横幅动作 */
  nudgeLog.addEventListener('click', () => log(NUDGE_SIP, '玻璃杯'));

  $('nudgeSnooze').addEventListener('click', () => {
    state.snoozeUntil = Date.now() + SNOOZE_MS;
    const sch = schedule();
    chimedFor = sch.kind === 'scheduled' ? sch.at.getTime() : null;
    save();
    render();
  });

  /* ── 启动 ───────────────────────────────────────── */
  function onModeChange() {
    horizontal = mq.matches;
    scale.classList.toggle('mode-h', horizontal);
    scale.classList.toggle('mode-v', !horizontal);
    buildScale();
    render();
  }

  if (mq.addEventListener) mq.addEventListener('change', onModeChange);
  else if (mq.addListener) mq.addListener(onModeChange);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('resize', () => { if (!dragging) { lastWater = -1; lastCursor = -1; } });

  buildScale();
  renderSettings();
  renderWeek();

  // 打开页面时如果已经超时，只显示横幅，不补发声音和通知
  const first = schedule();
  chimedFor = first.kind === 'scheduled' && first.pending ? first.at.getTime() : null;

  tick();
  setInterval(tick, 1000);
})();
