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
function seed(state, dayKeyStr, breakCount, focusCount, minutes = 25, taskId = '') {
  const day = state.days[dayKeyStr] || (state.days[dayKeyStr] = { sessions: [] });
  const [y, m, d] = dayKeyStr.split('-').map(Number);
  const base = new Date(y, m - 1, d, 9, 0, 0).getTime();
  for (let i = 0; i < focusCount; i++) {
    const s = base + i * 30 * MIN;
    day.sessions.push({ id: `f${dayKeyStr}${i}${taskId}`, phase: 'focus', startTs: s, endTs: s + minutes * MIN, plannedMin: minutes, taskId });
  }
  for (let i = 0; i < breakCount; i++) {
    const s = base + (focusCount + i) * 30 * MIN;
    day.sessions.push({ id: `b${dayKeyStr}${i}`, phase: 'short', startTs: s, endTs: s + 5 * MIN, plannedMin: 5, taskId: '' });
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

/* ── 任务 ─────────────────────────────────────────── */
group('加任务：标题去空格、超长截断、空标题不要', () => {
  const s = core.defaultState();
  const a = core.addTask(s, '  写周报  ', 3, T0);
  eq(a.title, '写周报', '首尾空格被去掉');
  eq(a.estimate, 3, '预估番茄数');
  eq(a.done, false, '新建是未完成');
  eq(s.tasks.length, 1, '进了列表');
  eq(s.activeTaskId, a.id, '第一个任务自动成为当前任务');

  eq(core.addTask(s, '   ', 1, T0), null, '全空格不算任务');
  eq(core.addTask(s, null, 1, T0), null, 'null 不算任务');
  eq(s.tasks.length, 1, '没有多出来');

  const long = core.addTask(s, 'x'.repeat(200), 1, T0);
  eq(long.title.length, core.LIMITS.taskTitle[1], '超长标题被截断');

  const weird = core.addTask(s, '预估越界', 999, T0);
  eq(weird.estimate, core.LIMITS.taskEstimate[1], '预估被夹到上限');
  eq(core.addTask(s, '预估负数', -5, T0).estimate, core.LIMITS.taskEstimate[0], '预估被夹到下限');
  eq(core.addTask(s, '预估不是数', 'abc', T0).estimate, 1, '非数字回落到 1');
});

group('改任务：标题不能被改成空的，预估会被夹住', () => {
  const s = core.defaultState();
  const t = core.addTask(s, '原标题', 2, T0);
  eq(core.updateTask(s, t.id, { title: '新标题' }).title, '新标题', '改标题');
  eq(core.updateTask(s, t.id, { title: '   ' }), null, '空标题被拒绝');
  eq(core.taskById(s, t.id).title, '新标题', '原标题没被改坏');
  eq(core.updateTask(s, t.id, { estimate: 50 }).estimate, core.LIMITS.taskEstimate[1], '预估被夹住');
  eq(core.updateTask(s, '不存在的 id', { title: 'x' }), null, '改不存在的任务返回 null');
});

group('勾完一个任务，当前任务自动让给下一条', () => {
  const s = core.defaultState();
  const a = core.addTask(s, 'A', 1, T0);
  const b = core.addTask(s, 'B', 1, T0 + 1);
  eq(s.activeTaskId, a.id, '当前是 A');

  core.toggleTaskDone(s, a.id, T0 + 100);
  eq(core.taskById(s, a.id).done, true, 'A 标记完成');
  eq(core.taskById(s, a.id).doneAt, T0 + 100, '记了完成时间');
  eq(s.activeTaskId, b.id, '当前任务让给 B');

  core.toggleTaskDone(s, b.id, T0 + 200);
  eq(s.activeTaskId, '', '全做完了就没有当前任务');

  core.toggleTaskDone(s, a.id, T0 + 300);
  eq(core.taskById(s, a.id).done, false, '再点一下取消完成');
  eq(core.taskById(s, a.id).doneAt, 0, '完成时间被清掉');
});

group('任务列表：没做完的排前面', () => {
  const s = core.defaultState();
  const a = core.addTask(s, 'A', 1, T0);
  const b = core.addTask(s, 'B', 1, T0 + 1);
  const c = core.addTask(s, 'C', 1, T0 + 2);
  core.toggleTaskDone(s, b.id, T0 + 10);
  eq(core.taskList(s).map((t) => t.title), ['A', 'C', 'B'], 'A、C 在前，做完的 B 垫底');
  void a;
});

group('删任务：当前任务跟着清掉，历史记录不受影响', () => {
  const s = core.defaultState();
  const t = core.addTask(s, '会被删掉', 1, T0);
  s.activeTaskId = t.id;
  ok(core.removeTask(s, t.id), '删除成功');
  eq(s.tasks.length, 0, '列表空了');
  eq(s.activeTaskId, '', '当前任务被清空');
  no(core.removeTask(s, t.id), '再删一次返回 false');
});

/* ── 番茄与任务的归属 ─────────────────────────────── */
group('开工时把任务冻结下来，中途换任务不追溯本轮', () => {
  const s = core.defaultState();
  const a = core.addTask(s, '任务 A', 1, T0);
  const b = core.addTask(s, '任务 B', 1, T0 + 1);
  core.setActiveTask(s, a.id);

  core.start(s, T0);
  eq(s.roundTaskId, a.id, '本轮记给 A');

  core.setActiveTask(s, b.id); // 中途改主意
  eq(s.activeTaskId, b.id, '当前选中变成 B');
  eq(s.roundTaskId, a.id, '但本轮仍然记给 A');

  const res = core.complete(s, at(25));
  eq(res.record.taskId, a.id, '记录归属 A');
  eq(s.roundTaskId, '', '换阶段后冻结被清掉');

  // 再跑一轮，这回该记给 B
  core.start(s, at(25));
  eq(s.roundTaskId, b.id, '下一轮记给 B');
  const res2 = core.complete(s, at(25));
  eq(res2.record.taskId, '', '短休不归任何任务');
});

group('重置会把冻结的任务清掉', () => {
  const s = core.defaultState();
  const a = core.addTask(s, '任务 A', 1, T0);
  core.setActiveTask(s, a.id);
  core.start(s, T0);
  eq(s.roundTaskId, a.id, '先记给 A');
  core.reset(s);
  eq(s.roundTaskId, '', '重置后清空');
  core.start(s, T0 + 1000);
  eq(s.roundTaskId, a.id, '重新开工时再冻结一次');
});

group('没选任务也能跑，只是记录里没有归属', () => {
  const s = core.defaultState();
  core.start(s, T0);
  eq(s.roundTaskId, '', '没有归属');
  const res = core.complete(s, at(25));
  eq(res.record.taskId, '', '记录里 taskId 为空');
  eq(core.todayStats(s, new Date(T0)).pomodoros, 1, '番茄照样算');
});

group('删掉任务之后，历史番茄仍然数得出来', () => {
  const s = core.defaultState();
  const t = core.addTask(s, '临时任务', 1, T0);
  core.setActiveTask(s, t.id);
  core.start(s, T0);
  core.complete(s, at(25));
  core.removeTask(s, t.id);

  const row = core.taskBreakdown(s, 7, new Date(at(25))).find((r) => r.id === t.id);
  ok(row, '这个任务在统计里还在');
  eq(row.pomodoros, 1, '仍然记着 1 个番茄');
  eq(row.title, '已删除的任务', '标题标成已删除');
  eq(row.known, false, '标记为已不存在的任务');
});

/* ── 效率统计 ─────────────────────────────────────── */
group('区间记录：7 天和 30 天都能取', () => {
  const s = core.defaultState();
  for (let i = 0; i < 20; i++) {
    const d = new Date(2026, 2, 10 - i);
    seed(s, core.dayKey(d), 0, 1);
  }
  eq(core.sessionsInRange(s, 7, new Date(T0)).length, 7, '7 天里 7 条');
  eq(core.sessionsInRange(s, 30, new Date(T0)).length, 20, '30 天里 20 条');
  eq(core.series(s, 30, new Date(T0)).length, 30, '30 天序列 30 项');
});

group('时段分布：按开始时间落到 24 个小时桶里', () => {
  const s = core.defaultState();
  // 手工塞三条：9 点两条、14 点一条
  s.days['2026-03-10'] = { sessions: [
    { id: 'a', phase: 'focus', startTs: new Date(2026, 2, 10, 9, 5).getTime(), endTs: new Date(2026, 2, 10, 9, 30).getTime(), plannedMin: 25, taskId: '' },
    { id: 'b', phase: 'focus', startTs: new Date(2026, 2, 10, 9, 40).getTime(), endTs: new Date(2026, 2, 10, 10, 5).getTime(), plannedMin: 25, taskId: '' },
    { id: 'c', phase: 'focus', startTs: new Date(2026, 2, 10, 14, 0).getTime(), endTs: new Date(2026, 2, 10, 14, 25).getTime(), plannedMin: 25, taskId: '' },
    { id: 'd', phase: 'short', startTs: new Date(2026, 2, 10, 20, 0).getTime(), endTs: new Date(2026, 2, 10, 20, 5).getTime(), plannedMin: 5, taskId: '' },
  ] };
  const hist = core.hourHistogram(s, 7, new Date(T0));
  eq(hist.length, 24, '24 个小时桶');
  eq(hist[9].count, 2, '9 点两个');
  eq(hist[14].count, 1, '14 点一个');
  eq(hist[20].count, 0, '休息不算进效率');
  eq(Math.max(...hist.map((h) => h.count)), 2, '峰值是 2');
});

group('效率指标：只按有记录的天算日均', () => {
  const s = core.defaultState();
  core.applySettings(s, { goal: 4 });
  seed(s, '2026-03-08', 0, 2);  // 没达标
  seed(s, '2026-03-09', 0, 4);  // 达标
  seed(s, '2026-03-10', 1, 6);  // 达标（多一个短休）

  const e = core.efficiency(s, 7, new Date(T0));
  eq(e.pomodoros, 12, '共 12 个番茄');
  eq(e.focusMin, 300, '共 300 分钟专注');
  eq(e.breakMin, 5, '休息 5 分钟');
  eq(e.activeDays, 3, '3 天有记录');
  eq(e.idleDays, 4, '7 天里 4 天空着');
  eq(e.goalHitDays, 2, '2 天达标');
  eq(e.avgPerDay, 12 / 7, '按 7 天摊');
  eq(e.avgPerActiveDay, 4, '按有记录的 3 天摊 = 4');
  eq(e.focusRatio, 300 / 305, '专注占比');
  eq(e.best.key, '2026-03-10', '最好的一天是今天');
  eq(e.best.pomodoros, 6, '那天 6 个');
});

group('任务完成率与任务消耗排行', () => {
  const s = core.defaultState();
  const a = core.addTask(s, '大任务', 5, T0);
  const b = core.addTask(s, '小任务', 2, T0 + 1);
  core.addTask(s, '还没开始的', 1, T0 + 2);
  core.toggleTaskDone(s, b.id, T0 + 10);

  seed(s, '2026-03-10', 0, 3, 25, a.id);
  seed(s, '2026-03-09', 0, 1, 25, a.id);
  seed(s, '2026-03-10', 0, 2, 25, b.id);
  seed(s, '2026-03-10', 0, 1, 25, ''); // 没指派

  const e = core.efficiency(s, 7, new Date(T0));
  eq(e.doneTasks, 1, '完成 1 个任务');
  eq(e.totalTasks, 3, '共 3 个任务');
  eq(e.completionRate, 1 / 3, '完成率 1/3');

  const rank = core.taskBreakdown(s, 7, new Date(T0));
  eq(rank.map((r) => r.title), ['大任务', '小任务', '未指派'], '按番茄数从多到少');
  eq(rank[0].pomodoros, 4, '大任务吃了 4 个');
  eq(rank[0].focusMin, 100, '合 100 分钟');
  eq(rank[0].estimate, 5, '带上预估');
  eq(rank[1].done, true, '小任务已完成');
  eq(rank[2].id, '', '未指派的 id 是空串');

  eq(core.taskStats(s, a.id).pomodoros, 4, '单任务全期统计');
  eq(core.taskStats(s, a.id).focusMin, 100, '单任务全期分钟');
});

/* ── 环境音 ───────────────────────────────────────── */
group('环境音只跟着计时状态走', () => {
  const s = core.defaultState();
  no(core.ambienceShouldPlay(s), '默认关闭时不响');

  core.applySettings(s, { ambience: 'rain' });
  no(core.ambienceShouldPlay(s), '选了下雨但还没开始计时，不响');

  core.start(s, T0);
  ok(core.ambienceShouldPlay(s), '专注计时中要响');

  core.pause(s, at(5));
  no(core.ambienceShouldPlay(s), '暂停就静音');

  core.start(s, at(5));
  // 让短休自动接上，否则"计时没在跑"本身就意味着静音，测不出「仅专注时段」这一条
  core.applySettings(s, { ambienceFocusOnly: false, autoNext: true });
  core.complete(s, at(25));
  eq(s.phase, 'short', '现在是短休');
  ok(s.running, '短休已经自动开始了');
  ok(core.ambienceShouldPlay(s), '关掉「仅专注时段」后，休息也响');

  core.applySettings(s, { ambienceFocusOnly: true });
  no(core.ambienceShouldPlay(s), '打开「仅专注时段」后，休息静音');

  core.applySettings(s, { ambience: '不存在的场景' });
  ok(s.running, '这里计时还在跑');
  no(core.ambienceShouldPlay(s), '非法场景不响');
});

/* ── 读档容错（任务部分） ─────────────────────────── */
group('存档里的任务脏数据也能扛住', () => {
  const store = fakeStorage({
    'pomodoro/v1': JSON.stringify({
      tasks: [
        { id: 'ok', title: '正常任务', estimate: 3, done: false, createdAt: T0 },
        { title: '没有 id' },
        { id: 'empty', title: '   ' },
        null,
        { id: 'bad', title: '预估越界', estimate: 99 },
      ],
      activeTaskId: 'ok',
      roundTaskId: 'ok',
      running: false,
      settings: { ambience: 'rain', ambienceVolume: 5, range: 999 },
    }),
  });
  const s = core.load(store);
  eq(s.tasks.length, 3, '空标题和 null 被丢掉，剩下的补上 id');
  ok(s.tasks.every((t) => t.id && t.title), '每个任务都有 id 和标题');
  eq(s.tasks.find((t) => t.id === 'bad').estimate, core.LIMITS.taskEstimate[1], '预估被夹住');
  eq(s.activeTaskId, 'ok', '当前任务保留');
  eq(s.roundTaskId, '', '没在计时 → 冻结的任务不该留到下一次');
  eq(s.settings.ambience, 'rain', '环境音场景保留');
  eq(s.settings.ambienceVolume, 1, '音量夹到 [0,1]');
  eq(s.settings.range, 7, '非法区间回落到 7 天');
});

group('当前任务指向一个不存在的 id 时会被清掉', () => {
  const store = fakeStorage({
    'pomodoro/v1': JSON.stringify({ tasks: [{ id: 'a', title: 'A' }], activeTaskId: '幽灵' }),
  });
  eq(core.load(store).activeTaskId, '', '幽灵 id 被清空');
});

/* ── 收尾 ──────────────────────────────────────────── */
console.log('');
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}\n`);
  console.log(`失败 ${failures.length} 项，通过 ${pass} 项。\n`);
  process.exit(1);
}
console.log(`全部通过：${pass} 项断言。\n`);
