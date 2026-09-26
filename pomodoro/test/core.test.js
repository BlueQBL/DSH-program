'use strict';

/**
 * 计时核心冒烟测试：把 core.js 当纯模块跑，不碰 DOM。
 * 运行：node test/core.test.js
 */

const assert = require('assert');
const core = require('../js/core.js');

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch (err) {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) { eq(Boolean(value), true, label); }
function no(value, label) { eq(Boolean(value), false, label); }

function group(name, fn) {
  const before = failures.length;
  fn();
  const status = failures.length === before ? '✓' : '✗';
  console.log(`  ${status} ${name}`);
}

const MIN = 60 * 1000;
const T0 = new Date(2026, 2, 10, 9, 30, 0).getTime(); // 2026-03-10 周二 09:30
const at = (min) => T0 + min * MIN;

/** 内存版 localStorage */
function fakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

/** 直接往历史里塞一段记录，用来造统计场景 */
function seed(state, dayKeyStr, breakCount, focusCount, minutes = 25) {
  const day = state.days[dayKeyStr] || (state.days[dayKeyStr] = { sessions: [] });
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  const base = new Date(y, m - 1, d, 9, 0, 0).getTime();
  for (let i = 0; i < focusCount; i++) {
    const s = base + i * 30 * MIN;
    day.sessions.push({ id: `f${dayKeyStr}${i}`, phase: 'focus', startTs: s, endTs: s + minutes * MIN, plannedMin: minutes });
  }
  for (let i = 0; i < breakCount; i++) {
    const s = base + (focusCount + i) * 30 * MIN;
    day.sessions.push({ id: `b${dayKeyStr}${i}`, phase: 'short', startTs: s, endTs: s + 5 * MIN, plannedMin: 5 });
  }
  return state;
}

console.log('\n番茄钟 · core.js 冒烟测试\n');

/* ── 格式化 ───────────────────────────────────────── */
group('formatClock 向上取整，归零才显示 00:00', () => {
  eq(core.formatClock(25 * MIN), '25:00', '25 分钟');
  eq(core.formatClock(25 * MIN - 1), '25:00', '差 1 毫秒仍是 25:00');
  eq(core.formatClock(61 * 1000), '01:01', '61 秒');
  eq(core.formatClock(0), '00:00', '归零');
  eq(core.formatClock(-5000), '00:00', '负数按 0 处理');
  eq(core.formatClock(3600 * 1000), '1:00:00', '整一小时');
});

group('formatDuration 说人话', () => {
  eq(core.formatDuration(25), '25 分钟', '25 分钟');
  eq(core.formatDuration(60), '1 小时', '整点');
  eq(core.formatDuration(90), '1 小时 30 分', '一小时半');
  eq(core.formatDuration(0), '0 分钟', '零');
});

group('dayKey 用本地日期，不受时区偏移影响', () => {
  eq(core.dayKey(new Date(2026, 2, 10, 23, 59)), '2026-03-10', '深夜仍是当天');
  eq(core.dayKey(new Date(2026, 2, 10, 0, 1)), '2026-03-10', '凌晨是当天');
  eq(core.dayKey(new Date(2026, 0, 5, 12, 0)), '2026-01-05', '月份补零');
});

/* ── 计时状态机 ───────────────────────────────────── */
group('默认状态：专注 25 分钟，整装待发', () => {
  const s = core.defaultState();
  eq(s.settings.focus, 25, '专注 25');
  eq(s.settings.short, 5, '短休 5');
  eq(s.settings.long, 15, '长休 15');
  eq(s.settings.rounds, 4, '每组 4 个');
  eq(s.phase, 'focus', '从专注开始');
  eq(core.statusOf(s), 'idle', '待机');
  eq(core.remainingMsOf(s, T0), 25 * MIN, '剩余 25 分钟');
  eq(core.needleAngle(s, T0), 150, '指针指在刻度 25（150°）');
});

group('开始 / 暂停 / 继续：剩余时间只认截止时刻', () => {
  const s = core.defaultState();
  core.start(s, T0);
  eq(core.statusOf(s), 'running', '在跑');
  eq(s.deadline, at(25), '截止时刻 = 开始 + 25 分钟');
  eq(core.remainingMsOf(s, at(10)), 15 * MIN, '10 分钟后还剩 15 分钟');

  core.pause(s, at(10));
  eq(core.statusOf(s), 'paused', '暂停中');
  eq(s.remainingMs, 15 * MIN, '剩余被定住');
  eq(core.remainingMsOf(s, at(30)), 15 * MIN, '暂停期间不再走');

  core.start(s, at(10));
  eq(core.statusOf(s), 'running', '继续');
  eq(s.deadline, at(25), '截止时刻顺延回来');
  eq(s.startedAt, T0, '本轮的开始时刻不变，纸带才对得上');
});

group('休眠/后台降频不会让计时跑偏', () => {
  const s = core.defaultState();
  core.start(s, T0);
  // 一觉睡了两小时，回来时早就过点了
  eq(core.remainingMsOf(s, at(120)), 0, '剩余归零，而不是负数');
  eq(core.progressOf(s, at(120)), 1, '进度封顶在 1');
  const res = core.complete(s, at(120));
  eq(res.late, 95 * MIN, '迟到 95 分钟被如实记录');
  ok(res.abandoned, '超时太久 → 判定为人已走开');
  eq(res.record, null, '不计入统计');
});

group('reset 回到本轮起点', () => {
  const s = core.defaultState();
  core.start(s, T0);
  core.pause(s, at(10));
  core.reset(s);
  eq(core.statusOf(s), 'idle', '回到待机');
  eq(s.remainingMs, 25 * MIN, '剩余恢复成设置里的时长');
  eq(s.startedAt, 0, '开始时刻清空');
});

/* ── 阶段推进 ─────────────────────────────────────── */
group('专注完 → 短休 → 下一个番茄', () => {
  const s = core.defaultState();
  core.start(s, T0);
  const r1 = core.complete(s, at(25));
  eq(r1.record.plannedMin, 25, '记下 25 分钟');
  eq(r1.record.phase, 'focus', '记的是专注');
  eq(s.phase, 'short', '进入短休');
  eq(s.round, 1, '第几个番茄要等休息结束才加');
  eq(s.remainingMs, 5 * MIN, '短休 5 分钟');

  const r2 = core.complete(s, at(30));
  eq(r2.record.phase, 'short', '短休也留一段记录');
  eq(s.phase, 'focus', '回到专注');
  eq(s.round, 2, '进入第 2 个番茄');
});

group('第 4 个番茄之后是长休，长休完重新数', () => {
  const s = core.defaultState();
  s.round = 4;
  s.phase = 'focus';
  s.totalMs = 25 * MIN;
  s.remainingMs = 25 * MIN;
  core.start(s, T0);

  const r = core.complete(s, at(25));
  eq(r.next.phase, 'long', '满一组 → 长休');
  eq(s.phase, 'long', '进入长休');
  eq(s.remainingMs, 15 * MIN, '长休 15 分钟');

  core.complete(s, at(40));
  eq(s.phase, 'focus', '回到专注');
  eq(s.round, 1, '重新从第 1 个开始');
});

group('每组番茄数被调小时，轮次不会越界', () => {
  const s = core.defaultState();
  s.round = 4;
  core.applySettings(s, { rounds: 2 });
  eq(s.round, 2, '轮次被收到新的上限内');
});

group('自动接下一轮 / 超时太久不自动接', () => {
  const s = core.defaultState();
  core.applySettings(s, { autoNext: true });
  core.start(s, T0);

  const timely = core.complete(s, at(25));
  ok(timely.autoStarted, '准时到点 → 自动开始下一轮');
  eq(core.statusOf(s), 'running', '确实在跑');
  eq(s.deadline, at(30), '短休从到点那一刻起算');

  const s2 = core.defaultState();
  core.applySettings(s2, { autoNext: true });
  core.start(s2, T0);
  const late = core.complete(s2, at(25 + 5)); // 迟到 5 分钟
  no(late.autoStarted, '迟到太久 → 不自动接');
  eq(core.statusOf(s2), 'idle', '停下来等人');
});

group('跳过不算番茄', () => {
  const s = core.defaultState();
  core.start(s, at(-5) * -1); // T0
  const res = core.complete(s, at(5), { record: false });
  eq(res.record, null, '没有记账');
  eq(core.todayStats(s, new Date(T0)).pomodoros, 0, '今日番茄数仍是 0');
  eq(s.phase, 'short', '但阶段照样推进');
});

/* ── 上弦 ─────────────────────────────────────────── */
group('setRemaining 上弦：范围 1–60 分钟，且只在未运行时', () => {
  const s = core.defaultState();
  core.setRemaining(s, 40 * MIN);
  eq(s.remainingMs, 40 * MIN, '上到 40 分钟');
  eq(s.totalMs, 40 * MIN, '总时长跟着走，表盘才不会转过一圈');
  eq(core.needleAngle(s, T0), 240, '指针指到刻度 40');

  core.setRemaining(s, 90 * MIN);
  eq(s.remainingMs, 60 * MIN, '超过一圈被收到 60');
  core.setRemaining(s, -5);
  eq(s.remainingMs, 0, '负数收到 0');
});

group('改设置：待机的立刻生效，跑着的从下一轮生效', () => {
  const s = core.defaultState();
  core.applySettings(s, { focus: 30 });
  eq(s.remainingMs, 30 * MIN, '待机时改了立刻生效');

  core.start(s, T0);
  core.applySettings(s, { focus: 50 });
  eq(s.remainingMs, 30 * MIN, '跑着的那一轮按原时长走完');
  eq(s.totalMs, 30 * MIN, '总时长也不变');
  eq(s.deadline, at(30), '截止时刻不受影响');

  core.pause(s, at(10));
  core.applySettings(s, { focus: 20 });
  eq(s.remainingMs, 20 * MIN, '暂停的一轮也不被改');
});

group('改别的设置不该推翻已经上好的弦', () => {
  const s = core.defaultState();
  core.setRemaining(s, 42 * MIN);
  core.applySettings(s, { goal: 12 });
  eq(s.remainingMs, 42 * MIN, '上好的 42 分钟还在');
  core.applySettings(s, { focus: 30 });
  eq(s.remainingMs, 30 * MIN, '真改了专注时长才覆盖');
});

group('超范围的设置被夹回合法区间', () => {
  const s = core.defaultState();
  core.applySettings(s, { focus: 999, short: 0, rounds: 100, goal: -3 });
  eq(s.settings.focus, core.LIMITS.focus[1], '专注取上限');
  eq(s.settings.short, core.LIMITS.short[0], '短休取下限');
  eq(s.settings.rounds, core.LIMITS.rounds[1], '组数取上限');
  eq(s.settings.goal, core.LIMITS.goal[0], '目标取下限');
  core.applySettings(s, { focus: 'abc' });
  eq(s.settings.focus, 60, '非数字被忽略，保留原值');
});

/* ── 统计 ─────────────────────────────────────────── */
group('今日统计只数专注，休息另算', () => {
  const s = core.defaultState();
  seed(s, '2026-03-10', 2, 3);
  const st = core.todayStats(s, new Date(T0));
  eq(st.pomodoros, 3, '3 个番茄');
  eq(st.focusMin, 75, '75 分钟专注');
  eq(st.breakMin, 10, '10 分钟休息');
  eq(st.sessions.length, 5, '纸带上 5 段');
});

group('最近 7 天按时间正序，最后一项是今天', () => {
  const s = core.defaultState();
  seed(s, '2026-03-08', 0, 2);
  seed(s, '2026-03-10', 0, 5);
  const list = core.series(s, 7, new Date(T0));
  eq(list.length, 7, '7 项');
  eq(list[0].key, '2026-03-04', '第一项是 6 天前');
  eq(list[6].key, '2026-03-10', '最后一项是今天');
  ok(list[6].isToday, '今天被标出来');
  eq(list[6].pomodoros, 5, '今天的数量');
  eq(list[4].pomodoros, 2, '3 月 8 日的数量');
  eq(list[0].pomodoros, 0, '没有记录的那天是 0');
});

group('连续天数：今天还没开始不算断', () => {
  const s = core.defaultState();
  seed(s, '2026-03-08', 0, 1);
  seed(s, '2026-03-09', 0, 1);
  eq(core.streak(s, new Date(T0)), 2, '今天还没记录，从昨天往回数');

  seed(s, '2026-03-10', 0, 1);
  eq(core.streak(s, new Date(T0)), 3, '今天记上了 → 3 天');

  seed(s, '2026-03-06', 0, 1);
  eq(core.streak(s, new Date(T0)), 3, '中间断了就不算（3-07 是空的）');
});

group('累计：番茄数、专注时长、有记录的天数', () => {
  const s = core.defaultState();
  seed(s, '2026-03-09', 0, 2);
  seed(s, '2026-03-10', 0, 3);
  const t = core.totals(s);
  eq(t.pomodoros, 5, '累计 5 个');
  eq(t.focusMin, 125, '累计 125 分钟');
  eq(t.activeDays, 2, '有 2 天有记录');
});

group('删除单条记录 / 清空某一天', () => {
  const s = core.defaultState();
  seed(s, '2026-03-10', 1, 2);
  const list = core.todayStats(s, new Date(T0)).sessions;
  ok(core.removeRecord(s, list[0].id), '删掉第一段');
  eq(core.todayStats(s, new Date(T0)).sessions.length, 2, '还剩 2 段');
  no(core.removeRecord(s, 'not-there'), '删不存在的返回 false');

  ok(core.clearDay(s, '2026-03-10'), '清空当天');
  eq(core.todayStats(s, new Date(T0)).pomodoros, 0, '清零了');
  no(core.clearDay(s, '2026-03-10'), '再清一次返回 false');
});

/* ── 存取与容错 ───────────────────────────────────── */
group('存档 → 读档：跑着的计时器能接着走', () => {
  const store = fakeStorage();
  const a = core.defaultState();
  core.start(a, T0);
  core.save(store, a);

  const b = core.load(store);
  eq(b.running, true, '重启页面后仍在计时');
  eq(b.deadline, at(25), '截止时刻原样恢复');
  eq(core.remainingMsOf(b, at(10)), 15 * MIN, '剩余时间接着算');
  eq(core.statusOf(b), 'running', '状态正确');
});

group('读档容错：脏数据不该让页面崩掉', () => {
  const store = fakeStorage({
    'pomodoro/v1': JSON.stringify({
      settings: { focus: 999, short: -4, rounds: 'x', autoNext: 'yes' },
      phase: 'teleport',
      round: 99,
      running: true,
      remainingMs: -100,
      totalMs: 0,
      days: {
        '2026-03-10': { sessions: [{ phase: 'focus', endTs: T0, plannedMin: 25 }, { phase: '???', endTs: T0 }, null] },
        '不是日期': { sessions: [{ phase: 'focus', endTs: T0, plannedMin: 25 }] },
      },
    }),
  });
  const s = core.load(store);
  eq(s.settings.focus, 60, '超范围的专注时长被夹回');
  eq(s.settings.short, 1, '负数被夹回下限');
  eq(s.settings.rounds, 4, '非数字回落到默认值');
  eq(s.settings.autoNext, false, '非布尔回落到默认值');
  eq(s.phase, 'focus', '非法阶段回落到专注');
  eq(s.round, 4, '轮次被夹进合法区间');
  no(s.running, '剩余为负 → 不认为在计时');
  eq(s.days['不是日期'], undefined, '非法日期键被丢掉');
  eq(s.days['2026-03-10'].sessions.length, 1, '坏记录被过滤，好记录留下');
});

group('完全读不出来时给一份默认状态', () => {
  const s = core.load(fakeStorage({ 'pomodoro/v1': '{坏掉的 JSON' }));
  eq(s.settings.focus, 25, '回落默认');
  eq(core.statusOf(s), 'idle', '待机');
  const empty = core.load(fakeStorage());
  eq(empty.settings.focus, 25, '没有存档也是默认');
  eq(core.load(null).settings.focus, 25, 'storage 为 null 也不炸');
});

group('存储写不进去时不抛错（无痕模式）', () => {
  const full = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
  };
  eq(core.save(full, core.defaultState()), false, '返回 false 而不是抛错');
});

group('历史超过保留天数，读档时剪掉最旧的', () => {
  const s = core.defaultState();
  for (let i = 0; i < core.KEEP_DAYS + 10; i++) {
    const d = new Date(2026, 0, 1 + i);
    seed(s, core.dayKey(d), 0, 1);
  }
  // 走真实路径：存档 → 读档，裁剪发生在 sanitize 里
  const store = fakeStorage();
  core.save(store, s);
  const back = core.load(store);

  const keys = Object.keys(back.days).sort();
  eq(keys.length, core.KEEP_DAYS, `只留 ${core.KEEP_DAYS} 天`);
  eq(keys[0], core.dayKey(new Date(2026, 0, 11)), '剪掉的是最旧的十天');
  eq(keys[keys.length - 1], core.dayKey(new Date(2026, 0, 1 + core.KEEP_DAYS + 9)), '最新的那天留着');
});

/* ── 收尾 ──────────────────────────────────────────── */
console.log('');
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  console.log(`失败 ${failures.length} 项，通过 ${pass} 项。\n`);
  process.exit(1);
}
console.log(`全部通过：${pass} 项断言。\n`);
