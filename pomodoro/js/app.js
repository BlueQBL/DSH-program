/* ============================================================
   番茄钟 · 交互层（app.js）
   负责：表盘绘制与上弦、计时循环、提示音、桌面通知、纸带与统计渲染。
   计时逻辑全在 core.js 里，这里只做「把它画出来」和「把动作喂给它」。
   ============================================================ */
(() => {
  'use strict';

  const C = window.PomodoroCore;
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ── 表盘几何（与 index.html 里的 viewBox 0 0 420 420 对齐） ── */
  const CX = 210;
  const CY = 210;
  const R_TICK_OUT = 184;
  const R_TICK_MINOR_IN = 176;
  const R_TICK_MAJOR_IN = 170;
  const R_TICK_ZERO_IN = 158;
  const R_NUM = 150;
  const R_BAND = 134;
  const TICK_COUNT = 60; // 一圈代表 60 分钟，和面板上刻的「60 min」一致

  const WIND_TICK_MS = 250; // 主循环步长：显示精确到秒，250ms 足够跟上秒的跳变
  const ABANDON_MS = C.ABANDON_MS; // 超时这么久才回来，当作人已经走开，不计入统计
  const BANNER_MS = 30000; // 到点横幅停留时间

  /* ── 存储 ─────────────────────────────────────────── */
  /** 无痕模式下 localStorage 会直接抛错，退化成内存存储，功能不残废。 */
  function makeStorage() {
    try {
      const probe = '__pomodoro__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (e) {
      const mem = new Map();
      return {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => void mem.set(k, String(v)),
        removeItem: (k) => void mem.delete(k),
      };
    }
  }

  const storage = makeStorage();
  let state = C.load(storage);
  const save = () => C.save(storage, state);

  /* ── 元素 ─────────────────────────────────────────── */
  const dial = $('dial');
  const dialScale = $('dialScale');
  const dialBand = $('dialBand');
  const dialHand = $('dialHand');
  const clockEl = $('clock');
  const phaseChip = $('phaseChip');
  const roundLine = $('roundLine');
  const startBtn = $('startBtn');
  const resetBtn = $('resetBtn');
  const skipBtn = $('skipBtn');
  const plate = $('plate');
  const dialHint = $('dialHint');
  const topTally = $('topTally');
  const tapeList = $('tapeList');
  const tapeEmpty = $('tapeEmpty');
  const tapeMeta = $('tapeMeta');
  const chartEl = $('chart');
  const chartMeta = $('chartMeta');
  const figuresEl = $('figures');
  const banner = $('banner');
  const bannerTitle = $('bannerTitle');
  const bannerSub = $('bannerSub');
  const bannerActions = $('bannerActions');
  const setHint = $('setHint');
  const stepDown = $('stepDown');
  const stepUp = $('stepUp');
  const soundBtn = $('soundBtn');
  const notifyBtn = $('notifyBtn');

  const settingInputs = Array.from(document.querySelectorAll('[data-setting]'));
  const booleanInputs = Array.from(document.querySelectorAll('[data-boolean]'));

  /* ── 小工具 ───────────────────────────────────────── */
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const phaseOf = (v) => C.PHASE_MAP[v] || C.PHASES[0];

  /* ── 声音 ─────────────────────────────────────────── */
  /* 全部用 Web Audio 现场合成，不加载音频文件：
     一声「铃」= 几个不成谐波关系的正弦分音叠加，衰减包络拉长，听起来像金属被敲响。*/
  let ctx = null;

  function ac() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function bell(partials, when = 0) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime + when;
    const master = c.createGain();
    master.gain.value = 0.42;
    master.connect(c.destination);

    for (const [freq, peak, decay] of partials) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(master);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
    }
  }

  const BELL_ALARM = [[1046.5, 0.17, 1.5], [1568, 0.11, 1.2], [2093, 0.065, 0.85], [2794, 0.035, 0.55]];
  const BELL_SOFT = [[784, 0.16, 1.3], [1174.7, 0.095, 1.0], [1568, 0.05, 0.7]];

  /** 一轮结束时敲铃。专注结束要够响，休息结束轻一点。 */
  function chimePhase(phase) {
    if (!state.settings.sound) return;
    if (phase === 'focus') {
      bell(BELL_ALARM, 0);
      bell(BELL_ALARM, 0.24);
      bell(BELL_ALARM, 0.48);
    } else {
      bell(BELL_SOFT, 0);
      bell(BELL_SOFT, 0.28);
    }
  }

  /** 上弦时的「嗒」：很短的一下，用频率下滑模拟机械卡齿。 */
  function tickSound(volume) {
    const c = ac();
    if (!c) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2600, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.018);
    osc.connect(gain);
    gain.connect(c.destination);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /* ── 桌面通知 ─────────────────────────────────────── */
  const notifyState = () => ('Notification' in window ? Notification.permission : 'unsupported');

  function sendNotification(title, body) {
    if (notifyState() !== 'granted') return;
    try {
      // silent：铃声由页面自己发，避免和系统提示音叠成两下
      const n = new Notification(title, { body, tag: 'pomodoro', renotify: true, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* 部分浏览器在没有 Service Worker 时会抛错，忽略即可 */ }
  }

  /** 第一次按「开始」时顺势申请通知权限——那是一次真实的用户手势。 */
  function maybeAskNotify() {
    if (notifyState() !== 'default' || state.notifyAsked) return;
    state.notifyAsked = true;
    save();
    try {
      Notification.requestPermission().then(renderNotifyButton).catch(() => {});
    } catch (e) { renderNotifyButton(); }
  }

  /* ── 表盘：刻度与数字 ─────────────────────────────── */
  /** 角度 → 坐标。0° 在正上方，顺时针为正，和真实表盘一致。 */
  function pt(angle, r) {
    const a = ((angle - 90) * Math.PI) / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }

  let ticks = [];

  function buildScale() {
    const frag = document.createDocumentFragment();
    ticks = [];

    for (let m = 0; m < TICK_COUNT; m++) {
      const angle = (m / TICK_COUNT) * 360;
      const zero = m === 0;
      const major = m % 5 === 0;
      const rIn = zero ? R_TICK_ZERO_IN : major ? R_TICK_MAJOR_IN : R_TICK_MINOR_IN;
      const [x1, y1] = pt(angle, rIn);
      const [x2, y2] = pt(angle, R_TICK_OUT);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      line.setAttribute('class', 'dial__tick ' + (zero ? 'dial__tick--zero' : major ? 'dial__tick--major' : 'dial__tick--minor'));
      frag.appendChild(line);
      ticks.push({ el: line, minute: m, lit: false });
    }

    for (let m = 5; m < TICK_COUNT; m += 5) {
      const [x, y] = pt((m / TICK_COUNT) * 360, R_NUM);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', x.toFixed(2));
      text.setAttribute('y', y.toFixed(2));
      text.setAttribute('class', 'dial__num');
      text.textContent = String(m);
      frag.appendChild(text);
    }

    dialScale.replaceChildren(frag);
  }

  /** 剩余时间的扇形带：从零位顺时针扫到指针处，半径即剩余分钟数。 */
  function bandPath(angle) {
    if (angle <= 0.05) return '';
    const [x1, y1] = pt(0, R_BAND);
    const [x2, y2] = pt(angle, R_BAND);
    if (angle >= 359.95) {
      const [xm, ym] = pt(180, R_BAND);
      return `M ${CX} ${CY} L ${x1} ${y1} A ${R_BAND} ${R_BAND} 0 0 1 ${xm} ${ym} A ${R_BAND} ${R_BAND} 0 0 1 ${x1} ${y1} Z`;
    }
    const large = angle > 180 ? 1 : 0;
    return `M ${CX} ${CY} L ${x1} ${y1} A ${R_BAND} ${R_BAND} 0 ${large} 1 ${x2} ${y2} Z`;
  }

  /** 把指针、扇形带、被点亮的刻度一次性刷成 angle 对应的样子。 */
  function paintDial(angle, jump) {
    dialHand.classList.toggle('is-jump', !!jump);
    // 用 CSS transform 而不是 SVG 的 transform 属性：属性变化不会触发 CSS 过渡，
    // 而这里要靠过渡让指针连续地扫，而不是一秒跳一格。
    dialHand.style.transform = `rotate(${angle.toFixed(3)}deg)`;
    dialBand.setAttribute('d', bandPath(angle));

    const litUpTo = angle / 6; // 每分钟 6°
    for (const t of ticks) {
      if (t.minute === 0) continue; // 零位是终点，不参与点亮
      const lit = t.minute <= litUpTo;
      if (lit !== t.lit) {
        t.el.classList.toggle('is-lit', lit);
        t.lit = lit;
      }
    }
  }

  /* ── 渲染：仪器 ───────────────────────────────────── */
  let lastSec = -1;
  // 换阶段时指针要"啪"地弹到新位置，不能顺着表盘扫过去：
  // 从 0° 扫回 300° 会绕一大圈，看着像故障。
  let jumpNext = false;

  function renderPushers() {
    const status = C.statusOf(state);
    const p = phaseOf(state.phase);

    if (status === 'running') startBtn.textContent = '暂停';
    else if (status === 'paused') startBtn.textContent = '继续';
    else startBtn.textContent = state.phase === 'focus' ? '开始专注' : '开始休息';

    skipBtn.textContent = state.phase === 'focus' ? '跳过专注' : '跳过休息';
    resetBtn.disabled = status === 'idle';

    startBtn.setAttribute('aria-label', `${startBtn.textContent}（${p.label} ${Math.round(state.totalMs / 60000)} 分钟）`);
  }

  function renderMeta() {
    const p = phaseOf(state.phase);
    const s = state.settings;

    if (phaseChip.dataset.phase !== state.phase) phaseChip.dataset.phase = state.phase;
    phaseChip.textContent = p.label;

    if (state.phase === 'focus') {
      roundLine.textContent = `第 ${state.round} / ${s.rounds} 个番茄`;
    } else if (state.phase === 'short') {
      roundLine.textContent = `休息中 · 接下来第 ${Math.min(state.round + 1, s.rounds)} 个番茄`;
    } else {
      roundLine.textContent = '一组做完了 · 下一个番茄重新数';
    }
  }

  function renderDialA11y(restMs) {
    const minutes = Math.round(state.totalMs / 60000);
    dial.setAttribute('aria-valuenow', String(C.clamp(Math.round(restMs / 60000), 0, 60)));
    dial.setAttribute('aria-valuetext', state.running
      ? `本轮共 ${minutes} 分钟，还剩 ${C.formatClock(restMs)}，调整时长请先暂停`
      : `本轮 ${minutes} 分钟，可用方向键调整`);
    if (state.running) dial.setAttribute('aria-disabled', 'true');
    else dial.removeAttribute('aria-disabled');
    dial.classList.toggle('is-locked', state.running);
  }

  function renderTitle(restMs) {
    const p = phaseOf(state.phase);
    const title = state.running
      ? `${C.formatClock(restMs)} · ${p.label}`
      : `${p.label} ${Math.round(state.totalMs / 60000)} 分 · 番茄钟`;
    if (document.title !== title) document.title = title;
  }

  /** 仪器的全部状态：数字、指针、扇形带、按钮、标题。按秒调用。 */
  function paint(now = Date.now()) {
    const restMs = C.remainingMsOf(state, now);
    const angle = C.needleAngle(state, now);

    // 上弦时指针要跟手，换阶段时要直接就位，都不能用 0.45s 的过渡；
    // 正常走时反而要过渡，让指针连续地扫。
    paintDial(angle, winding || jumpNext);
    jumpNext = false;

    const text = C.formatClock(restMs);
    if (clockEl.textContent !== text) clockEl.textContent = text;
    clockEl.classList.toggle('is-done', restMs <= 0);

    if (document.body.dataset.phase !== state.phase) document.body.dataset.phase = state.phase;
    document.body.classList.toggle('is-running', state.running);

    renderMeta();
    renderPushers();
    renderDialA11y(restMs);
    renderTitle(restMs);

    stepDown.disabled = state.running || state.totalMs <= 60000;
    stepUp.disabled = state.running || state.totalMs >= 60 * 60000;
  }

  /* ── 渲染：纸带与统计 ─────────────────────────────── */
  function renderTape() {
    const st = C.todayStats(state);
    const list = st.sessions;

    tapeMeta.textContent = list.length ? `${list.length} 段` : '';
    tapeEmpty.hidden = list.length > 0;

    tapeList.replaceChildren(...list.map((r) => {
      const li = document.createElement('li');
      li.className = 'tape__row';
      li.dataset.phase = r.phase;
      li.innerHTML =
        `<span class="tape__mark" aria-hidden="true"></span>` +
        `<span class="tape__span">${hhmm(r.startTs)} – ${hhmm(r.endTs)}</span>` +
        `<span class="tape__leader" aria-hidden="true"></span>` +
        `<span class="tape__phase">${esc(phaseOf(r.phase).label)}</span>` +
        `<span class="tape__min">${r.plannedMin} 分</span>` +
        `<button class="tape__del" type="button" data-id="${esc(r.id)}" ` +
        `aria-label="删除 ${hhmm(r.startTs)} 开始的这段${esc(phaseOf(r.phase).label)}记录">×</button>`;
      return li;
    }));

    if (st.pomodoros > 0) {
      const total = document.createElement('li');
      total.className = 'tape__total';
      total.innerHTML =
        `<span>今天 ${st.pomodoros} 个番茄</span>` +
        `<em>${C.formatDuration(st.focusMin)}专注</em>`;
      tapeList.appendChild(total);
    }
  }

  function renderChart() {
    const days = C.series(state, 7);
    const goal = state.settings.goal;
    const peak = Math.max(goal, ...days.map((d) => d.pomodoros), 1);

    const bars = days.map((d) => {
      const h = ((d.pomodoros / peak) * 100).toFixed(2);
      return `<div class="chart__bar" data-empty="${d.pomodoros ? 0 : 1}" style="--h:${h}%" ` +
        `title="${d.key} · ${d.pomodoros} 个番茄 · ${C.formatDuration(d.focusMin)}">` +
        `<span class="chart__num">${d.pomodoros || ''}</span>` +
        `<span class="chart__fill"></span>` +
        `</div>`;
    }).join('');

    const labels = days.map((d) => (
      `<span class="chart__label${d.isToday ? ' is-today' : ''}">${d.isToday ? '今天' : '周' + d.weekday}</span>`
    )).join('');

    chartEl.innerHTML =
      `<div class="chart__plot" style="--goal:${((goal / peak) * 100).toFixed(2)}%">` +
        `<span class="chart__goal" aria-hidden="true"></span>` + bars +
      `</div>` +
      `<div class="chart__labels">${labels}</div>`;
    chartMeta.textContent = `虚线 = 每天 ${goal} 个`;

    const t = C.totals(state);
    const hours = t.focusMin / 60;
    figuresEl.innerHTML =
      `<li class="figures__item"><span class="figures__num">${C.streak(state)}</span><span class="figures__label">天连续</span></li>` +
      `<li class="figures__item"><span class="figures__num">${t.pomodoros}</span><span class="figures__label">累计番茄</span></li>` +
      `<li class="figures__item"><span class="figures__num">${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}</span><span class="figures__label">小时专注</span></li>`;
  }

  function renderTally() {
    const st = C.todayStats(state);
    topTally.innerHTML = st.pomodoros
      ? `今天 <b>${st.pomodoros}</b> 个番茄 · <b>${C.formatDuration(st.focusMin)}</b>专注`
      : '今天还没有番茄';
  }

  const refreshLog = () => { renderTape(); renderChart(); renderTally(); };

  /* ── 渲染：设置 ───────────────────────────────────── */
  function renderSettings() {
    for (const input of settingInputs) input.value = String(state.settings[input.dataset.setting]);
    for (const input of booleanInputs) input.checked = !!state.settings[input.dataset.boolean];
    soundBtn.setAttribute('aria-pressed', String(!!state.settings.sound));
    renderNotifyButton();

    $('setKeepAwake').disabled = !('wakeLock' in navigator);
    $('setKeepAwake').closest('.switch').title = 'wakeLock' in navigator
      ? ''
      : '这个浏览器不支持屏幕常亮（Wake Lock API）';
  }

  function renderNotifyButton() {
    const ns = notifyState();
    if (ns === 'granted') {
      notifyBtn.textContent = '通知已开启';
      notifyBtn.disabled = true;
      notifyBtn.title = '时间到了会弹出桌面通知';
    } else if (ns === 'denied') {
      notifyBtn.textContent = '通知被禁止';
      notifyBtn.disabled = true;
      notifyBtn.title = '浏览器禁止了桌面通知，需要在地址栏的网站设置里重新允许。页面横幅、铃声和标题提醒仍然有效。';
    } else if (ns === 'unsupported') {
      notifyBtn.textContent = '无桌面通知';
      notifyBtn.disabled = true;
      notifyBtn.title = '这个浏览器不支持桌面通知，页面横幅、铃声和标题提醒仍然有效。';
    } else {
      notifyBtn.textContent = '开启通知';
      notifyBtn.disabled = false;
      notifyBtn.title = '时间到了会弹出桌面通知';
    }
  }

  function flashHint(text, ms = 4200) {
    dialHint.textContent = text;
    dialHint.classList.add('is-flash');
    clearTimeout(flashHint.timer);
    flashHint.timer = setTimeout(() => {
      dialHint.classList.remove('is-flash');
      dialHint.textContent = HINT_DEFAULT;
    }, ms);
  }

  const HINT_DEFAULT = '拖动表盘上弦，或选中表盘后按 ↑ ↓ 调整分钟。空格键开始 / 暂停。';

  function setSetHint(text) {
    setHint.textContent = text;
    setHint.classList.toggle('is-warn', !!text);
    clearTimeout(setSetHint.timer);
    if (text) setSetHint.timer = setTimeout(() => { setHint.textContent = ''; setHint.classList.remove('is-warn'); }, 6000);
  }

  /* ── 计时循环 ─────────────────────────────────────── */
  let bannerTimer = 0;
  let currentDay = C.dayKey();

  function loop() {
    const now = Date.now();

    if (state.running && now >= state.deadline) {
      finish(now);
      return;
    }

    if (C.dayKey(new Date(now)) !== currentDay) {
      currentDay = C.dayKey(new Date(now));
      refreshLog();
    }

    const sec = Math.ceil(C.remainingMsOf(state, now) / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      paint(now);
      if (state.settings.ticking && state.running && state.phase === 'focus') tickSound(0.012);
    }
  }

  /** 一轮走到头：记账、敲铃、发通知、弹横幅、推进阶段。 */
  function finish(now) {
    const late = Math.max(0, now - (state.deadline || now));
    const abandoned = late > ABANDON_MS;
    const endedPhase = state.phase;
    const endedRound = state.round;

    // autoNext 由 core 直接读设置决定，这里只管「这一轮算不算数」
    const res = C.complete(state, now, { record: !abandoned });
    save();

    lastSec = -1;
    plate.classList.remove('is-ringing');
    void plate.offsetWidth; // 强制重排，让动画能重播
    plate.classList.add('is-ringing');

    chimePhase(endedPhase);
    announce(res, endedPhase, endedRound, abandoned, late);

    jumpNext = true;
    paint(now);
    refreshLog();
    syncWakeLock();
  }

  function announce(res, endedPhase, endedRound, abandoned, late) {
    const ended = phaseOf(endedPhase);
    const next = phaseOf(res.next.phase);
    const st = C.todayStats(state);
    const nextMin = Math.round(state.totalMs / 60000); // complete 之后 totalMs 已经是下一轮的时长

    let title;
    let sub;

    if (abandoned) {
      title = '这一轮结束很久了';
      sub = `已经过去 ${Math.round(late / 60000)} 分钟，多半是人不在，这一轮没有记进统计。`;
    } else if (endedPhase === 'focus') {
      title = '该休息了';
      sub = `第 ${endedRound} 个番茄完成，今天共 ${st.pomodoros} 个 · ${C.formatDuration(st.focusMin)}。` +
        (res.next.phase === 'long' ? ' 一组做完了，去长休一下。' : ' 站起来活动一下吧。');
    } else {
      title = '休息结束';
      sub = endedPhase === 'long'
        ? '新的一个番茄，从第一个重新开始。'
        : `回来吧，接下来是第 ${res.next.round} 个番茄。`;
    }

    sendNotification(
      `${ended.label}结束 · 番茄钟`,
      abandoned ? sub : `接下来：${next.label} ${nextMin} 分钟。${endedPhase === 'focus' ? `今天已完成 ${st.pomodoros} 个番茄。` : ''}`
    );

    // 横幅
    bannerTitle.textContent = title;
    bannerSub.textContent = sub;
    bannerActions.replaceChildren();

    if (res.autoStarted) {
      bannerActions.appendChild(makeBannerBtn(`正在${next.label} · 暂停`, 'pusher pusher--main', () => {
        C.pause(state, Date.now());
        save();
        lastSec = -1;
        paint();
        hideBanner();
      }));
      bannerActions.appendChild(makeBannerBtn('知道了', 'pusher pusher--ghost', hideBanner));
    } else {
      bannerActions.appendChild(makeBannerBtn(`开始${next.label}`, 'pusher pusher--main', () => {
        C.start(state, Date.now());
        save();
        lastSec = -1;
        paint();
        syncWakeLock();
        hideBanner();
      }));
      bannerActions.appendChild(makeBannerBtn('先不开始', 'pusher pusher--ghost', hideBanner));
    }

    banner.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, BANNER_MS);
  }

  function makeBannerBtn(label, className, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function hideBanner() {
    banner.hidden = true;
    clearTimeout(bannerTimer);
  }

  /* ── 动作 ─────────────────────────────────────────── */
  function toggleRun() {
    if (C.statusOf(state) === 'idle' && state.remainingMs <= 0) C.reset(state);
    C.toggle(state, Date.now());
    save();
    // 浏览器要求申请通知权限必须来自用户手势，这里是最自然的时机
    if (state.running) maybeAskNotify();
    lastSec = -1;
    paint();
    syncWakeLock();
    if (state.running) hideBanner();
  }

  function doReset() {
    C.reset(state);
    save();
    lastSec = -1;
    paint();
    syncWakeLock();
    flashHint('已重置。表盘回到本轮起点。', 2600);
  }

  function doSkip() {
    const ended = phaseOf(state.phase);
    C.complete(state, Date.now(), { record: false });
    save();
    lastSec = -1;
    paint();
    refreshLog();
    syncWakeLock();
    flashHint(`跳过了这一段${ended.label}，没有计入统计。`, 3000);
  }

  /* ── 上弦：拖动表盘 / 方向键 / ± ──────────────────── */
  let winding = false;
  let windMinute = -1;

  function minuteFromEvent(e) {
    const box = dial.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // 屏幕坐标 → 以正上方为 0°、顺时针为正的角度
    let deg = (Math.atan2(e.clientX - cx, cy - e.clientY) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return C.clamp(Math.round((deg / 360) * TICK_COUNT), 1, TICK_COUNT);
  }

  function windTo(minutes, silent) {
    if (minutes === windMinute) return;
    const prev = windMinute;
    windMinute = minutes;
    C.setRemaining(state, minutes * 60000);
    if (!silent && prev >= 0) tickSound(0.05);
    lastSec = -1;
    paint();
  }

  function beginWind(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (state.running) {
      flashHint('计时中不能改时长，先按暂停。', 3000);
      return;
    }
    winding = true;
    dial.classList.add('is-winding');
    windMinute = -1;
    try { dial.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    windTo(minuteFromEvent(e), true);
    e.preventDefault();
  }

  function moveWind(e) {
    if (!winding) return;
    windTo(minuteFromEvent(e), false);
  }

  function endWind(e) {
    if (!winding) return;
    winding = false;
    dial.classList.remove('is-winding');
    try { dial.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    save();
    lastSec = -1;
    paint();
    flashHint(`这一轮 ${windMinute} 分钟。松手即定，按开始就跑。`, 2800);
  }

  function nudgeWind(delta) {
    if (state.running) {
      flashHint('计时中不能改时长，先按暂停。', 3000);
      return;
    }
    const minutes = C.clamp(Math.round(state.totalMs / 60000) + delta, 1, 60);
    windMinute = -1;
    C.setRemaining(state, minutes * 60000);
    save();
    tickSound(0.05);
    lastSec = -1;
    paint();
    flashHint(`这一轮 ${minutes} 分钟。`, 2200);
  }

  /* ── 屏幕常亮 ─────────────────────────────────────── */
  let wakeLock = null;

  async function syncWakeLock() {
    const want = state.settings.keepAwake && state.running && state.phase === 'focus';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (e) {
      wakeLock = null; // 被系统拒绝（比如电量低）：不影响计时
    }
  }

  /* ── 事件绑定 ─────────────────────────────────────── */
  startBtn.addEventListener('click', toggleRun);
  resetBtn.addEventListener('click', doReset);
  skipBtn.addEventListener('click', doSkip);
  stepDown.addEventListener('click', () => nudgeWind(-1));
  stepUp.addEventListener('click', () => nudgeWind(1));

  $('testChime').addEventListener('click', () => {
    const wasOff = !state.settings.sound;
    if (wasOff) state.settings.sound = true;
    chimePhase(state.phase === 'focus' ? 'focus' : state.phase);
    if (wasOff) setTimeout(() => { state.settings.sound = false; }, 2000);
  });

  soundBtn.addEventListener('click', () => {
    state.settings.sound = !state.settings.sound;
    save();
    renderSettings();
    if (state.settings.sound) tickSound(0.06);
  });

  notifyBtn.addEventListener('click', () => {
    if (notifyState() !== 'default') return;
    state.notifyAsked = true;
    save();
    try { Notification.requestPermission().then(renderNotifyButton).catch(renderNotifyButton); }
    catch (e) { renderNotifyButton(); }
  });

  $('clearDay').addEventListener('click', () => {
    const st = C.todayStats(state);
    if (!st.sessions.length) {
      setSetHint('今天还没有记录。');
      return;
    }
    if (!window.confirm(`确定清空今天的 ${st.sessions.length} 段记录吗？`)) return;
    C.clearDay(state);
    save();
    refreshLog();
    setSetHint('今天的记录已清空。');
  });

  // 表盘：指针拖拽 + 键盘
  dial.addEventListener('pointerdown', beginWind);
  dial.addEventListener('pointermove', moveWind);
  dial.addEventListener('pointerup', endWind);
  dial.addEventListener('pointercancel', endWind);

  dial.addEventListener('keydown', (e) => {
    const stepMin = e.shiftKey ? 5 : 1;
    const map = {
      ArrowUp: stepMin, ArrowRight: stepMin,
      ArrowDown: -stepMin, ArrowLeft: -stepMin,
      PageUp: 5, PageDown: -5,
    };
    if (e.key in map) {
      e.preventDefault();
      nudgeWind(map[e.key]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      nudgeWind(1 - Math.round(state.totalMs / 60000));
    } else if (e.key === 'End') {
      e.preventDefault();
      nudgeWind(60 - Math.round(state.totalMs / 60000));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      toggleRun();
    }
  });

  // 设置：数字输入
  for (const input of settingInputs) {
    input.addEventListener('change', () => {
      const key = input.dataset.setting;
      const raw = Number(input.value);
      const [lo, hi] = C.LIMITS[key];
      const status = C.statusOf(state);
      const running = status !== 'idle';

      C.applySettings(state, { [key]: Number.isFinite(raw) ? raw : state.settings[key] });
      const applied = state.settings[key];
      input.value = String(applied);

      const box = input.closest('.field__box');
      box.classList.toggle('is-invalid', Number.isFinite(raw) && (raw < lo || raw > hi));
      if (box.classList.contains('is-invalid')) {
        setSetHint(`${C.LIMITS[key][0]}–${C.LIMITS[key][1]} 之间，已按 ${applied} 记。`);
      } else if (running && (key === 'focus' || key === 'short' || key === 'long')) {
        setSetHint(`这一轮仍按原来的 ${Math.round(state.totalMs / 60000)} 分钟走完，改的时长从下一轮生效。`);
      } else if (key === 'rounds' || key === 'goal') {
        setSetHint('已保存。');
      } else {
        setSetHint('已保存。');
      }

      save();
      lastSec = -1;
      paint();
      refreshLog();
    });
  }

  // 设置：开关
  for (const input of booleanInputs) {
    input.addEventListener('change', () => {
      C.applySettings(state, { [input.dataset.boolean]: input.checked });
      save();
      soundBtn.setAttribute('aria-pressed', String(!!state.settings.sound));
      lastSec = -1;
      paint();
      if (input.dataset.boolean === 'sound' && input.checked) tickSound(0.06);
      syncWakeLock();
    });
  }

  // 纸带：删除某一段
  tapeList.addEventListener('click', (e) => {
    const btn = e.target.closest('.tape__del');
    if (!btn) return;
    if (!C.removeRecord(state, btn.dataset.id)) return;
    save();
    refreshLog();
    setSetHint('已删除那一段记录。');
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !banner.hidden) {
      hideBanner();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.code === 'Space') {
      // 焦点在按钮上时，空格是「按下这个按钮」，别抢
      if (tag === 'button' || tag === 'a') return;
      if (e.target === dial) return;
      e.preventDefault();
      toggleRun();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      doReset();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      doSkip();
    }
  });

  // 切回前台：立刻补一次判断，把休眠期间漏掉的时间补上
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const now = Date.now();
    if (state.running && now >= state.deadline) finish(now);
    else { lastSec = -1; paint(now); }
    syncWakeLock();
  });

  // 这里不用再监听 pagehide 补一次保存：每个会改状态的地方都已经就地存过了。
  // 多存一次反而有害——同时开了两个标签页时，先关掉的那个会把内存里的旧状态写回去，
  // 盖掉另一个标签页刚记下的番茄。

  /* ── 启动 ─────────────────────────────────────────── */
  buildScale();
  renderSettings();
  refreshLog();
  paint();

  // 上次关掉页面时如果还在计时，这里会接着走；
  // 如果时钟早就该响了，loop 的第一拍就会把它结算掉。
  if (state.running) syncWakeLock();
  setInterval(loop, WIND_TICK_MS);
  loop();
})();
