/*!
 * 番茄钟 · 计时核心（core.js）
 * 纯逻辑，不碰 DOM：浏览器挂到 window.PomodoroCore，Node 走 module.exports。
 *
 * 计时以「截止时刻」（deadline）为准，而不是每次 tick 累加秒数。
 * 理由是 setInterval 会被浏览器降频：切到后台标签页会降到 1 秒甚至 1 分钟一次，
 * 笔记本合盖休眠回来更是直接断档。用 deadline = 开始时刻 + 总时长，
 * 每次渲染只做一次减法，无论被降频多久，剩余时间始终准确。
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (root) root.PomodoroCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STORAGE_KEY = 'pomodoro/v1';
  const KEEP_DAYS = 180; // 历史保留天数，超出的自动清理
  const AUTO_LATE_MS = 90 * 1000; // 超时这么久才回来（多半是休眠），不自动接下一轮
  const ABANDON_MS = 10 * 60 * 1000; // 超时这么久才回来，当作人已经走开，这一轮不计入统计

  /**
   * 三个阶段。color 是界面上的语义色：
   * 番茄红 = 果子熟了（专注），嫩芽绿 = 长叶（短休），黄铜 = 收工（长休）。
   */
  const PHASES = [
    { value: 'focus', label: '专注', en: 'Focus', hint: '关掉别的窗口，只做这一件事。' },
    { value: 'short', label: '短休', en: 'Short break', hint: '站起来，看看远处。' },
    { value: 'long', label: '长休', en: 'Long break', hint: '离开座位走一走。' },
  ];
  const PHASE_MAP = PHASES.reduce((acc, p) => ((acc[p.value] = p), acc), {});

  /** 各时长的可调范围（分钟）。表盘一圈 60 分钟，所以单轮上限就是 60。 */
  const LIMITS = {
    focus: [1, 60],
    short: [1, 30],
    long: [1, 60],
    rounds: [2, 8],
    goal: [1, 16],
  };

  const DEFAULTS = {
    settings: {
      focus: 25,
      short: 5,
      long: 15,
      rounds: 4, // 每几个番茄进一次长休
      goal: 8, // 每天的目标番茄数
      autoNext: false, // 一轮结束后是否自动接上下一轮
      sound: true,
      ticking: false, // 专注时的秒针轻响
      keepAwake: false, // 专注期间保持屏幕常亮
    },
    phase: 'focus',
    round: 1,
    running: false,
    deadline: 0, // 仅 running 时有意义
    remainingMs: 25 * 60000, // 未运行时（待机/暂停）的剩余毫秒
    totalMs: 25 * 60000, // 当前这一轮的总时长；运行中改设置不影响它
    startedAt: 0, // 本轮第一次开始的时刻，用于纸带
    days: {}, // 'YYYY-MM-DD' -> { sessions: [...] }
    notifyAsked: false,
  };

  /* ── 小工具 ─────────────────────────────────────── */
  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /** 本地日期键。用本地时间而不是 toISOString，否则晚上 8 点后会算到第二天。 */
  function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** 毫秒 → 倒计时钟面文本。向上取整，这样刚开始显示的是完整的 25:00，归零才显示 00:00。 */
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }

  /** 分钟数 → 中文时长，例如 90 → 「1 小时 30 分」 */
  function formatDuration(min) {
    const v = Math.max(0, Math.round(min));
    if (v < 60) return `${v} 分钟`;
    const h = Math.floor(v / 60);
    const m = v % 60;
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  const phaseMinutes = (settings, phase) => Number(settings[phase]) || 0;

  /* ── 状态读写 ───────────────────────────────────── */
  function defaultState() {
    const s = clone(DEFAULTS);
    s.totalMs = s.settings.focus * 60000;
    s.remainingMs = s.totalMs;
    return s;
  }

  /** 把任何来源的数据修成合法状态：localStorage 可能被手改过，也可能来自旧版本。 */
  function sanitize(raw) {
    const base = defaultState();
    if (!raw || typeof raw !== 'object') return base;

    const s = Object.assign(base, { days: {} });
    const rs = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    for (const key of ['focus', 'short', 'long', 'rounds', 'goal']) {
      const [lo, hi] = LIMITS[key];
      const v = Math.round(Number(rs[key]));
      s.settings[key] = Number.isFinite(v) ? clamp(v, lo, hi) : base.settings[key];
    }
    for (const key of ['autoNext', 'sound', 'ticking', 'keepAwake']) {
      s.settings[key] = typeof rs[key] === 'boolean' ? rs[key] : base.settings[key];
    }
    s.notifyAsked = !!raw.notifyAsked;

    s.phase = PHASE_MAP[raw.phase] ? raw.phase : 'focus';
    s.round = clamp(Math.round(Number(raw.round)) || 1, 1, s.settings.rounds);

    const total = phaseMinutes(s.settings, s.phase) * 60000;
    s.totalMs = Number(raw.totalMs) > 0 ? Number(raw.totalMs) : total;
    const rest = Number(raw.remainingMs);
    s.remainingMs = Number.isFinite(rest) ? clamp(rest, 0, s.totalMs) : s.totalMs;

    s.running = !!raw.running && s.remainingMs > 0;
    s.deadline = s.running ? Number(raw.deadline) || Date.now() + s.remainingMs : 0;
    s.startedAt = Number(raw.startedAt) > 0 ? Number(raw.startedAt) : 0;

    if (raw.days && typeof raw.days === 'object') {
      for (const [key, day] of Object.entries(raw.days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
        const list = day && Array.isArray(day.sessions) ? day.sessions : [];
        const clean = list.filter((r) => r && PHASE_MAP[r.phase] && Number(r.endTs) > 0);
        if (clean.length) s.days[key] = { sessions: clean.map(normalizeRecord) };
      }
    }
    prune(s, KEEP_DAYS);
    return s;
  }

  function normalizeRecord(r) {
    return {
      id: String(r.id || uid()),
      phase: r.phase,
      startTs: Number(r.startTs) || Number(r.endTs),
      endTs: Number(r.endTs),
      plannedMin: Math.max(1, Math.round(Number(r.plannedMin) || 1)),
    };
  }

  function prune(state, keep = KEEP_DAYS) {
    const keys = Object.keys(state.days).sort();
    while (keys.length > keep) delete state.days[keys.shift()];
  }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY);
      return sanitize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return defaultState();
    }
  }

  function save(storage, state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      return false; // 隐私模式 / 配额满：不打扰用户，本轮数据只在内存里
    }
  }

  /* ── 计时状态机 ─────────────────────────────────── */
  /** 'idle'（整装待发）| 'running'（在跑）| 'paused'（中途停住） */
  function statusOf(state) {
    if (state.running) return 'running';
    return state.remainingMs > 0 && state.remainingMs < state.totalMs ? 'paused' : 'idle';
  }

  function remainingMsOf(state, now) {
    if (!state.running) return Math.max(0, state.remainingMs);
    return Math.max(0, state.deadline - now);
  }

  /** 已走完的比例 0–1 */
  function progressOf(state, now) {
    if (!(state.totalMs > 0)) return 0;
    return clamp(1 - remainingMsOf(state, now) / state.totalMs, 0, 1);
  }

  /** 剩余时间对应的表盘角度（0 在正上方，顺时针为正），一圈代表 60 分钟。 */
  function needleAngle(state, now) {
    const minutes = remainingMsOf(state, now) / 60000;
    return clamp(minutes / 60, 0, 1) * 360;
  }

  function start(state, now) {
    if (state.running) return state;
    const rest = state.remainingMs > 0 ? state.remainingMs : state.totalMs;
    state.running = true;
    state.remainingMs = rest;
    state.deadline = now + rest;
    if (!state.startedAt) state.startedAt = now;
    return state;
  }

  function pause(state, now) {
    if (!state.running) return state;
    state.remainingMs = Math.max(0, state.deadline - now);
    state.running = false;
    state.deadline = 0;
    return state;
  }

  function toggle(state, now) {
    return state.running ? pause(state, now) : start(state, now);
  }

  /** 回到本轮起点：读回设置里的时长，时钟归零重来。 */
  function reset(state) {
    state.running = false;
    state.deadline = 0;
    state.startedAt = 0;
    state.totalMs = phaseMinutes(state.settings, state.phase) * 60000;
    state.remainingMs = state.totalMs;
    return state;
  }

  /** 本轮结束后该往哪走。专注 → 短休（满一组则长休），休息 → 下一个番茄。 */
  function nextPhaseOf(state) {
    if (state.phase === 'focus') {
      return state.round >= state.settings.rounds
        ? { phase: 'long', round: state.round }
        : { phase: 'short', round: state.round };
    }
    if (state.phase === 'long') return { phase: 'focus', round: 1 };
    return { phase: 'focus', round: clamp(state.round + 1, 1, state.settings.rounds) };
  }

  function applyPhase(state, phase, round, now, running) {
    state.phase = phase;
    state.round = round;
    state.totalMs = phaseMinutes(state.settings, phase) * 60000;
    state.remainingMs = state.totalMs;
    state.running = !!running;
    state.deadline = running ? now + state.totalMs : 0;
    state.startedAt = running ? now : 0;
    return state;
  }

  /** 只在一轮真正走完时记账，所以实际时长就等于计划时长，不额外记一份。 */
  function makeRecord(state, now) {
    const endTs = state.running && state.deadline ? Math.min(state.deadline, now) : now;
    return {
      id: uid(),
      phase: state.phase,
      startTs: state.startedAt || endTs - state.totalMs,
      endTs,
      plannedMin: Math.max(1, Math.round(state.totalMs / 60000)),
    };
  }

  function pushRecord(state, record) {
    const key = dayKey(new Date(record.endTs));
    const day = state.days[key] || (state.days[key] = { sessions: [] });
    day.sessions.push(record);
    prune(state);
    return record;
  }

  /**
   * 结束当前这一轮：记一笔，然后推进到下一阶段。
   * opts.record === false 用于「跳过」——跳过不算番茄。
   * opts.auto 缺省时看设置里的 autoNext；但超时太久（多半是电脑睡过）一律不自动接。
   */
  function complete(state, now, opts = {}) {
    const late = Math.max(0, now - (state.deadline || now));
    const abandoned = late > ABANDON_MS;
    const record = opts.record === false || abandoned ? null : makeRecord(state, now);
    const ended = { phase: state.phase, round: state.round, record };
    const auto = opts.auto === undefined ? state.settings.autoNext : !!opts.auto;
    const autoStarted = auto && !abandoned && late < AUTO_LATE_MS;
    const next = nextPhaseOf(state);

    applyPhase(state, next.phase, next.round, now, autoStarted);
    if (record) pushRecord(state, record);
    return { record, ended, next, late, abandoned, autoStarted };
  }

  /**
   * 改设置。跑着的和暂停中的那一轮都不动，改动从下一轮生效——
   * 否则会出现「剩余时间比总时长还长」这种自相矛盾的状态。
   * 只有整装待发的那一轮会立刻跟着设置走。
   */
  function applySettings(state, patch) {
    const prev = state.settings;
    const next = Object.assign({}, prev, patch);
    for (const key of ['focus', 'short', 'long', 'rounds', 'goal']) {
      const [lo, hi] = LIMITS[key];
      const v = Math.round(Number(next[key]));
      next[key] = Number.isFinite(v) ? clamp(v, lo, hi) : prev[key];
    }
    state.settings = next;
    if (state.round > next.rounds) state.round = next.rounds;

    // 只认「当前这个阶段的时长被改了」；改每日目标之类的设置不该推翻已经上好的弦
    const phaseLenChanged = next[state.phase] !== prev[state.phase];
    if (phaseLenChanged && statusOf(state) === 'idle') {
      state.totalMs = phaseMinutes(next, state.phase) * 60000;
      state.remainingMs = state.totalMs;
    }
    return state;
  }

  /**
   * 直接设定本轮剩余时长（表盘上弦用）。
   * 只在未运行时可用；运行中想改时长请先暂停。
   */
  function setRemaining(state, ms) {
    const cap = 60 * 60000;
    const v = clamp(Math.round(ms), 0, cap);
    state.totalMs = v;
    state.remainingMs = v;
    state.running = false;
    state.deadline = 0;
    state.startedAt = 0;
    return state;
  }

  /* ── 统计 ───────────────────────────────────────── */
  function sessionsOf(state, key) {
    const d = state.days[key];
    return d && Array.isArray(d.sessions) ? d.sessions : [];
  }

  const isFocus = (r) => r.phase === 'focus';

  function dayStats(state, key) {
    const list = sessionsOf(state, key);
    const focus = list.filter(isFocus);
    return {
      pomodoros: focus.length,
      focusMin: focus.reduce((a, r) => a + r.plannedMin, 0),
      breakMin: list.filter((r) => !isFocus(r)).reduce((a, r) => a + r.plannedMin, 0),
      sessions: list.slice().sort((a, b) => a.endTs - b.endTs),
    };
  }

  const todayStats = (state, now = new Date()) => dayStats(state, dayKey(now));

  /** 最近 n 天的每日番茄数，按时间正序，最后一项是今天。 */
  function series(state, n = 7, now = new Date()) {
    const out = [];
    const today = dayKey(now);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dayKey(d);
      const st = dayStats(state, key);
      out.push({
        key,
        date: d,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        weekday: '日一二三四五六'[d.getDay()],
        pomodoros: st.pomodoros,
        focusMin: st.focusMin,
        isToday: key === today,
      });
    }
    return out;
  }

  /** 连续天数：今天有记录就从今天往回数，今天还没有就从昨天算起（当天的机会还没用完）。 */
  function streak(state, now = new Date()) {
    let count = 0;
    for (let i = 0; i < KEEP_DAYS; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const has = dayStats(state, dayKey(d)).pomodoros > 0;
      if (has) count += 1;
      else if (i > 0) break;
    }
    return count;
  }

  function totals(state) {
    const keys = Object.keys(state.days);
    let pomodoros = 0;
    let focusMin = 0;
    for (const key of keys) {
      const st = dayStats(state, key);
      pomodoros += st.pomodoros;
      focusMin += st.focusMin;
    }
    const activeDays = keys.filter((k) => dayStats(state, k).pomodoros > 0).length;
    return { pomodoros, focusMin, activeDays };
  }

  function removeRecord(state, id) {
    for (const [key, day] of Object.entries(state.days)) {
      const i = day.sessions.findIndex((r) => r.id === id);
      if (i >= 0) {
        day.sessions.splice(i, 1);
        if (!day.sessions.length) delete state.days[key];
        return true;
      }
    }
    return false;
  }

  function clearDay(state, key, now = new Date()) {
    const k = key || dayKey(now);
    if (!state.days[k]) return false;
    delete state.days[k];
    return true;
  }

  return {
    STORAGE_KEY,
    KEEP_DAYS,
    AUTO_LATE_MS,
    ABANDON_MS,
    PHASES,
    PHASE_MAP,
    LIMITS,
    DEFAULTS,
    // 状态
    defaultState,
    sanitize,
    load,
    save,
    // 计时
    statusOf,
    remainingMsOf,
    progressOf,
    needleAngle,
    start,
    pause,
    toggle,
    reset,
    complete,
    nextPhaseOf,
    setRemaining,
    applySettings,
    // 统计
    dayKey,
    dayStats,
    todayStats,
    series,
    streak,
    totals,
    removeRecord,
    clearDay,
    // 格式化
    formatClock,
    formatDuration,
    clamp,
  };
});
