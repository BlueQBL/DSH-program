'use strict';

/**
 * 数据层冒烟测试：把 core.js 当纯模块跑，不碰 DOM。
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

function ok(value, label) {
  eq(Boolean(value), true, label);
}

function no(value, label) {
  eq(Boolean(value), false, label);
}

function throws(fn, label) {
  try {
    fn();
    failures.push(`${label}\n    期望抛错，实际没有`);
  } catch {
    pass += 1;
  }
}

function group(name, fn) {
  const before = failures.length;
  fn();
  const status = failures.length === before ? '✓' : '✗';
  console.log(`  ${status} ${name}`);
}

/** 固定"现在"，让日期断言不随运行时间漂移 */
const NOW = new Date(2026, 2, 10, 9, 30); // 2026-03-10 周二
const TODAY = '2026-03-10';

function fakeStorage(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

function seedState(items) {
  let state = core.createState();
  items.forEach((item) => {
    state = core.addTask(state, item, NOW).state;
  });
  return state;
}

/** 按标题取任务：不依赖列表顺序，断言更抗改动 */
const pick = (state, title) => state.tasks.find((t) => t.title === title);

console.log('\n案头待办 · 数据层测试\n');

/* ------------------------------------------------------------------ 日期 */
group('日期工具（本地时区、不漂移）', () => {
  eq(core.todayISO(NOW), TODAY, 'todayISO 用本地日期');
  eq(core.parseDate('2026-03-10'), new Date(2026, 2, 10).getTime(), 'parseDate 解析本地零点');
  ok(Number.isNaN(core.parseDate('2026-02-30')), 'parseDate 拒绝不存在的日期');
  ok(Number.isNaN(core.parseDate('2026/03/10')), 'parseDate 拒绝非 ISO 写法');
  no(core.isValidDate(''), '空字符串不是合法日期');
  no(core.isValidDate(undefined), 'undefined 不是合法日期');
  eq(core.addDays('2026-02-28', 1), '2026-03-01', 'addDays 跨月（非闰年）');
  eq(core.addDays('2028-02-28', 1), '2028-02-29', 'addDays 跨月（闰年）');
  eq(core.shiftISO(0, NOW), TODAY, 'shiftISO(0) 是今天');
  eq(core.shiftISO(-1, NOW), '2026-03-09', 'shiftISO(-1) 是昨天');
  eq(core.shiftISO(1, NOW), '2026-03-11', 'shiftISO(1) 是明天');
  eq(core.diffDays('2026-03-13', '2026-03-10'), 3, 'diffDays 顺推');
  eq(core.diffDays('2026-03-08', '2026-03-10'), -2, 'diffDays 逆推');
  eq(core.daysUntil('2026-03-13', NOW), 3, 'daysUntil 未来为正');
  eq(core.daysUntil(TODAY, NOW), 0, 'daysUntil 今天是 0');
  eq(core.daysUntil('2026-03-08', NOW), -2, 'daysUntil 过去为负');
  ok(Number.isNaN(core.daysUntil('', NOW)), 'daysUntil 对空日期给 NaN');
});

group('到期文案与逾期判断', () => {
  eq(core.dueLabel(TODAY, NOW).text, '今天到期', '今天到期的说法');
  eq(core.dueLabel('2026-03-11', NOW).text, '明天到期', '明天到期的说法');
  eq(core.dueLabel('2026-03-13', NOW).text, '3 天后到期', '三天内说几天后');
  eq(core.dueLabel('2026-03-25', NOW).text, '03/25 到期', '远期直接给日期');
  eq(core.dueLabel('2026-03-08', NOW).text, '逾期 2 天', '逾期天数');
  eq(core.dueLabel('', NOW).tone, 'none', '没有截止日期时给 none');
  const base = { done: false, due: '2026-03-09' };
  ok(core.isOverdue(base, NOW), '过期且未完成算逾期');
  ok(!core.isOverdue(Object.assign({}, base, { done: true }), NOW), '已完成不算逾期');
  ok(!core.isOverdue({ done: false, due: TODAY }, NOW), '今天到期不算逾期');
  ok(!core.isOverdue({ done: false, due: '' }, NOW), '没有截止日期不算逾期');
});

/* ------------------------------------------------------------------ 任务 */
group('创建任务：字段归一化', () => {
  const task = core.createTask({ title: '  写周报  ', desc: '  a  ', priority: 'weird', category: '  ' }, NOW);
  eq(task.title, '写周报', '标题去空格');
  eq(task.desc, 'a', '描述去空格');
  eq(task.priority, 'normal', '非法优先级回落到中');
  eq(task.category, '未分类', '空分类回落到未分类');
  eq(task.due, '', '缺失截止日期时留空');
  eq(task.done, false, '默认未完成');
  eq(task.completedAt, null, '未完成没有完成时间');
  ok(task.id && task.id.length > 4, '自动生成 id');
  throws(() => core.createTask({ title: '   ' }, NOW), '空标题抛错');
  eq(core.createTask({ title: 'x'.repeat(200) }, NOW).title.length, core.MAX_TITLE, '标题按上限截断');
  eq(core.createTask({ title: 't', due: '2026-13-01' }, NOW).due, '', '非法日期被丢掉');
  eq(core.createTask({ title: 't', priority: 'urgent' }, NOW).priority, 'urgent', '合法优先级保留');
});

group('增删改：不可变、分类自动登记', () => {
  let state = core.createState();
  const added = core.addTask(state, { title: '任务一', category: '阅读' }, NOW);
  state = added.state;
  eq(state.tasks.length, 1, '新增后有一条');
  ok(state.categories.includes('阅读'), '新分类自动进分类表');
  eq(state.tasks[0].category, '阅读', '新分类写进任务');

  const forked = core.addTask(state, { title: '任务二' }, NOW).state;
  eq(state.tasks.length, 1, 'addTask 不改动原状态');
  eq(forked.tasks.length, 2, '新状态有两条');

  const id = state.tasks[0].id;
  const edited = core.withTask(state, id, { title: '任务一（改）', priority: 'urgent', due: TODAY }, NOW);
  eq(edited.tasks[0].title, '任务一（改）', '标题被改写');
  eq(edited.tasks[0].priority, 'urgent', '优先级被改写');
  eq(edited.tasks[0].due, TODAY, '截止日期被改写');
  eq(state.tasks[0].title, '任务一', 'withTask 不改动原状态');
  eq(core.withTask(state, 'not-exist', { title: 'x' }, NOW), state, '改不存在的 id 时原样返回');

  const done = core.toggleTask(state, id, NOW);  eq(done.tasks[0].done, true, 'toggle 标记完成');
  ok(typeof done.tasks[0].completedAt === 'number', '完成时记录完成时间');
  const back = core.toggleTask(done, id, NOW);
  eq(back.tasks[0].done, false, '再 toggle 回到未完成');
  eq(back.tasks[0].completedAt, null, '恢复未完成时清掉完成时间');

  const dup = core.duplicateTask(state, id, NOW);
  eq(dup.tasks.length, 2, '复制多出一条');
  eq(dup.tasks[0].id !== id, true, '副本换了 id');
  eq(dup.tasks[0].done, false, '副本是未完成');
  ok(dup.tasks[0].title.includes('副本'), '副本标题有标记');

  const removed = core.removeTask(state, id, NOW);
  eq(removed.tasks.length, 0, '删除后为空');
  eq(core.removeTask(state, 'nope', NOW), state, '删不存在的 id 时原样返回');
});

group('清空已完成', () => {
  let state = seedState([
    { title: 'A' },
    { title: 'B' },
    { title: 'C' },
  ]);
  state = core.withTask(state, pick(state, 'A').id, { done: true }, NOW);
  state = core.withTask(state, pick(state, 'C').id, { done: true }, NOW);
  const cleared = core.clearCompleted(state, NOW);
  eq(cleared.tasks.length, 1, '只留下未完成的');
  eq(cleared.tasks[0].title, 'B', '留下的是没完成的那条');
  const allDone = core.clearCompleted(cleared, NOW);
  eq(allDone, cleared, '没有已完成时原样返回');
});

/* ------------------------------------------------------------------ 筛选 */
const FIXTURE = [
  { title: '写季度复盘', desc: '结论放第一页', due: TODAY, priority: 'urgent', category: '工作' },
  { title: '给接口补重试', desc: '退避三次', due: '2026-03-01', priority: 'high', category: '工作' },
  { title: '读《重构》', desc: '第六章', due: '2026-03-20', priority: 'normal', category: '学习' },
  { title: '预约牙医', desc: '', due: '', priority: 'low', category: '生活' },
];

group('筛选：分类 / 优先级 / 状态', () => {
  let state = seedState(FIXTURE);
  state = core.withTask(state, pick(state, '预约牙医').id, { done: true }, NOW); // 这条已完成

  const all = core.selectTasks(state, { now: NOW });
  eq(all.length, 4, '默认全部显示');

  const work = core.selectTasks(core.setFilter(state, { categories: ['工作'] }), { now: NOW });
  eq(work.length, 2, '按分类筛选');

  const multi = core.selectTasks(core.setFilter(state, { categories: ['工作', '学习'] }), { now: NOW });
  eq(multi.length, 3, '多选分类取并集');

  const urgent = core.selectTasks(core.setFilter(state, { priorities: ['urgent'] }), { now: NOW });
  eq(urgent.length, 1, '按优先级筛选');

  const active = core.selectTasks(core.setFilter(state, { status: 'active' }), { now: NOW });
  eq(active.length, 3, '按未完成筛选');

  const doneList = core.selectTasks(core.setFilter(state, { status: 'done' }), { now: NOW });
  eq(doneList.length, 1, '按已完成筛选');

  const overdue = core.selectTasks(core.setFilter(state, { status: 'overdue' }), { now: NOW });
  eq(overdue.map((t) => t.title), ['给接口补重试'], '逾期的只有那一条');

  const combo = core.selectTasks(core.setFilter(state, { status: 'active', categories: ['工作'], priorities: ['urgent'] }), {
    now: NOW,
  });
  eq(combo.length, 1, '多个条件叠加是取交集');

  const none = core.selectTasks(core.setFilter(state, { categories: ['不存在'] }), { now: NOW });
  eq(none.length, 0, '筛不到就是空');
});

group('搜索：多关键词 AND、大小写不敏感', () => {
  const state = seedState(FIXTURE);
  const q = (query) => core.selectTasks(core.setFilter(state, { query }), { now: NOW }).map((t) => t.title).sort();

  eq(q('复盘'), ['写季度复盘'], '命中标题');
  eq(q('退避'), ['给接口补重试'], '命中描述');
  eq(q('学习'), ['读《重构》'], '命中分类');
  eq(q('工作 复盘'), ['写季度复盘'], '两个词都命中才留下');
  eq(q('工作 重构'), [], '有一个词不命中就排除');
  eq(q('重构'), ['读《重构》'], '书名号也能搜');
  eq(q('URGENT'), [], '英文优先级不进正文，中文标签才可搜');
  eq(q('紧急'), ['写季度复盘'], '中文优先级标签可搜');
  eq(q('2026-03-20'), ['读《重构》'], '截止日期也能搜到');
  eq(q('   ').length, 4, '纯空格等于不搜索');
  eq(q('').length, 4, '空串返回全部');
});

group('排序：智能 / 截止 / 优先级 / 创建 / 标题', () => {
  const state = seedState(FIXTURE);
  const titles = (sort) => core.sortTasks(state.tasks, sort, NOW).map((t) => t.title);

  eq(titles('due'), ['给接口补重试', '写季度复盘', '读《重构》', '预约牙医'], '按截止日期，无日期排最后');
  eq(titles('priority'), ['写季度复盘', '给接口补重试', '读《重构》', '预约牙医'], '按优先级紧急→低');
  // Node 未带完整 ICU 时 localeCompare('zh-CN') 会退回码点序，所以这里只断言"排过序且不丢东西"
  const byTitle = titles('title');
  eq(byTitle.length, 4, '按标题排序条数不变');
  eq([...byTitle].sort(), [...titles('due')].sort(), '按标题排序只是换顺序');
  eq(titles('created').length, 4, '按创建时间也能排');

  const smart = titles('smart');
  eq(smart, ['给接口补重试', '写季度复盘', '读《重构》', '预约牙医'], '智能排序：逾期 → 今天 → 未来 → 无日期');

  let doneState = core.withTask(state, pick(state, '给接口补重试').id, { done: true }, NOW);
  doneState = core.withTask(doneState, pick(doneState, '写季度复盘').id, { done: true }, NOW);
  const smart2 = core.sortTasks(doneState.tasks, 'smart', NOW).map((t) => t.title);
  eq(smart2, ['读《重构》', '预约牙医', '给接口补重试', '写季度复盘'], '已完成的沉到最后，完成之间仍按截止日期');
});

/* ------------------------------------------------------------------ 统计 */
group('统计：完成率、逾期、分类、优先级', () => {
  let state = seedState(FIXTURE);
  state = core.withTask(state, pick(state, '预约牙医').id, { done: true }, NOW);

  const stats = core.computeStats(state.tasks, NOW);
  eq(stats.total, 4, '总数');
  eq(stats.done, 1, '已完成数');
  eq(stats.active, 3, '待办数');
  eq(stats.rate, 25, '完成率取整');
  eq(stats.overdue, 1, '逾期数');
  eq(stats.today, 1, '今天到期数');
  eq(stats.upcoming, 0, '十天后的那条不算七天内');

  const near = core.computeStats(
    seedState([
      { title: '三天后', due: '2026-03-13' },
      { title: '第七天', due: '2026-03-17' },
      { title: '第八天', due: '2026-03-18' },
      { title: '今天', due: TODAY },
    ]).tasks,
    NOW
  );
  eq(near.upcoming, 2, '七天内到期 = 第 1~7 天，今天的单独算');
  eq(near.today, 1, '今天到期单独计数');

  eq(core.computeStats([], NOW).rate, 0, '空列表完成率是 0，不是 NaN');

  const work = stats.byCategory.find((c) => c.name === '工作');
  eq([work.total, work.done, work.active, work.overdue], [2, 0, 2, 1], '分类统计四个数都对');
  eq(stats.byCategory[0].name, '工作', '分类按数量倒序');
  const low = stats.byPriority.find((p) => p.value === 'low');
  eq([low.total, low.done], [1, 1], '优先级统计跟随完成状态');
});

group('近两周完成量与连续天数', () => {
  let state = seedState([
    { title: 'A' },
    { title: 'B' },
    { title: 'C' },
  ]);
  state = core.withTask(state, pick(state, 'A').id, { done: true }, NOW);
  state = core.withTask(state, pick(state, 'B').id, { done: true }, NOW);

  const series = core.completionSeries(state.tasks, 14, NOW);
  eq(series.length, 14, '画 14 格');
  eq(series[13].date, TODAY, '最后一格是今天');
  eq(series[13].count, 2, '今天完成 2 条');
  eq(series[12].count, 0, '昨天 0 条');
  eq(core.completionSeries([], 3, NOW).length, 3, 'days 参数生效');
  eq(core.streak(state.tasks, NOW), 1, '今天有完成算 1 天连续');
  eq(core.streak([], NOW), 0, '没数据连续 0 天');
});

/* ------------------------------------------------------------------ 持久化 */
group('LocalStorage：保存 / 读取 / 坏数据兜底', () => {
  const store = fakeStorage();
  let state = seedState(FIXTURE);
  state = core.setFilter(state, { query: '复盘', categories: ['工作'], status: 'active', sort: 'due' });
  state = core.withTask(state, pick(state, '预约牙医').id, { done: true }, NOW);
  ok(core.save(state, store), '保存返回成功');

  const reloaded = core.load(store);
  eq(reloaded.tasks.length, 4, '任务数不丢');
  eq(reloaded.filters.query, '复盘', '搜索词被记下来');
  eq(reloaded.filters.categories, ['工作'], '分类筛选被记下来');
  eq(reloaded.filters.status, 'active', '状态筛选被记下来');
  eq(reloaded.filters.sort, 'due', '排序被记下来');
  eq(reloaded.tasks.find((t) => t.title === '预约牙医').done, true, '完成状态不丢');
  eq(reloaded.tasks.find((t) => t.title === '读《重构》').desc, '第六章', '描述不丢');
  eq(reloaded.tasks.find((t) => t.title === '预约牙医').due, '', '空截止日期不丢成 undefined');

  eq(core.load(fakeStorage()).tasks.length, 0, '空存储得到空状态');
  eq(core.load(fakeStorage({ [core.STORAGE_KEY]: '{坏 JSON' })).tasks.length, 0, '坏 JSON 不炸，落回空状态');
  eq(core.load(fakeStorage({ [core.STORAGE_KEY]: 'null' })).tasks.length, 0, 'null 也落回空状态');

  const dirty = fakeStorage({
    [core.STORAGE_KEY]: JSON.stringify({
      version: 1,
      tasks: [
        { title: '好的', priority: 'urgent' },
        { title: '   ' },
        null,
        { desc: '没有标题' },
        { id: 'dup', title: '重复一' },
        { id: 'dup', title: '重复二' },
      ],
      filters: { status: '乱写的', sort: '乱写的', categories: '不是数组', query: 123 },
      prefs: { theme: '紫色' },
    }),
  });
  const cleaned = core.load(dirty);
  eq(cleaned.tasks.length, 3, '脏数据里只留下有标题的');
  eq(cleaned.filters.status, 'all', '非法状态回落 all');
  eq(cleaned.filters.sort, 'smart', '非法排序回落 smart');
  eq(cleaned.filters.categories, [], '非数组筛选回落空数组');
  eq(cleaned.prefs.theme, 'light', '非法主题回落白天');
  eq(new Set(cleaned.tasks.map((t) => t.id)).size, 3, '重复 id 被拆开');

  ok(core.clear(store), '清空返回成功');
  eq(core.load(store).tasks.length, 0, '清空后读回空状态');
});

group('存储不可用时用内存兜底', () => {
  const memory = core.memoryStorage();
  eq(memory.ephemeral, true, '内存兜底带 ephemeral 标记');
  let state = seedState([{ title: '内存里的任务' }]);
  ok(core.save(state, memory), '内存兜底也能保存');
  eq(core.load(memory).tasks.length, 1, '内存兜底也能读回');
});

group('分类表：增删与颜色', () => {
  let state = core.createState();
  state = core.addCategory(state, '阅读');
  ok(state.categories.includes('阅读'), '新增分类');
  eq(core.addCategory(state, '阅读'), state, '重复分类不重复加');
  eq(core.addCategory(state, '   '), state, '空分类不加');
  eq(core.categoryColor(state, '工作'), core.CATEGORY_PALETTE[0], '第一个分类拿第一号色');
  eq(core.categoryColor(state, '阅读'), core.CATEGORY_PALETTE[3], '第四个分类拿第四号色');
  eq(core.categoryColor(state, '不存在'), core.CATEGORY_PALETTE[7], '未知分类有兜底色');

  state = seedState([{ title: 'X', category: '阅读' }]);
  state = core.addCategory(state, '阅读');
  const after = core.removeCategory(state, '阅读');
  no(after.categories.includes('阅读'), '删除分类后分类表里没有了');
  eq(after.tasks[0].category, '未分类', '分类下的任务改判未分类');
  ok(after.categories.includes('未分类'), '未分类自动登记');
});

group('筛选聚合状态', () => {
  let state = core.createState();
  no(core.filtersActive(state), '初始没有筛选');
  state = core.setFilter(state, { query: 'x' });
  ok(core.filtersActive(state), '有搜索词算有筛选');
  state = core.resetFilters(state);
  no(core.filtersActive(state), '重置后回到无筛选');
  state = core.toggleFilterValue(state, 'priorities', 'high');
  eq(state.filters.priorities, ['high'], 'toggle 加上去');
  state = core.toggleFilterValue(state, 'priorities', 'high');
  eq(state.filters.priorities, [], '再 toggle 拿下来');
});

/* ------------------------------------------------------------------ 交换 */
group('导入导出：JSON / CSV 往返', () => {
  let state = seedState(FIXTURE);
  state = core.withTask(state, pick(state, '写季度复盘').id, { done: true }, NOW);

  const json = core.toJSON(state);
  const back = core.fromJSON(json);
  eq(back.tasks.length, 4, 'JSON 往返不丢条数');
  eq(back.tasks.find((t) => t.title === '写季度复盘').done, true, 'JSON 往返保留完成状态');
  eq(back.tasks.find((t) => t.title === '写季度复盘').priority, 'urgent', 'JSON 往返保留优先级');
  ok(back.categories.includes('学习'), 'JSON 往返保留分类表');

  const csv = core.toCSV(state);
  const lines = csv.replace(/^\ufeff/, '').split('\r\n');
  eq(lines.length, 5, 'CSV 一行表头 + 四行数据');
  ok(lines[0].startsWith('"标题"'), 'CSV 表头正确');
  ok(csv.includes('"写季度复盘"'), 'CSV 里有标题');
  ok(csv.includes('"已完成"'), 'CSV 里有中文状态');
  ok(csv.includes('"紧急"'), 'CSV 里优先级是中文');
  const quoted = core.toCSV(seedState([{ title: '带"引号"的标题', desc: 'x' }]));
  ok(quoted.includes('"带""引号""的标题"'), 'CSV 引号被转义成双写');

  throws(() => core.fromJSON('不是 json'), '非 JSON 文件抛错');
  throws(() => core.fromJSON('{"nope":1}'), '缺 tasks 的文件抛错');
  throws(() => core.fromJSON('{"tasks":[]}'), '空 tasks 文件抛错');
  eq(core.fromJSON(JSON.stringify([{ title: '裸数组也能导' }])).tasks.length, 1, '裸数组形式也接受');
});

/* ------------------------------------------------------------------ 规模 */
group('规模：400 条任务不卡（逻辑层）', () => {
  const many = [];
  for (let i = 0; i < 400; i += 1) {
    many.push({
      title: `任务 ${i}`,
      desc: i % 3 === 0 ? '说明文字' : '',
      due: core.shiftISO((i % 30) - 15, NOW),
      priority: core.PRIORITIES[i % 4].value,
      category: ['工作', '学习', '生活', '杂事'][i % 4],
      done: i % 5 === 0,
    });
  }
  const state = seedState(many);
  eq(state.tasks.length, 400, '400 条都进去了');
  const started = Date.now();
  const list = core.selectTasks(core.setFilter(state, { query: '任务 1', status: 'active' }), { now: NOW });
  const stats = core.computeStats(state.tasks, NOW);
  const elapsed = Date.now() - started;
  ok(list.length > 0, '搜索在 400 条里能命中');
  eq(stats.total, 400, '统计覆盖全量');
  ok(elapsed < 200, `筛选 + 统计耗时 ${elapsed}ms，应远小于 200ms`);
});

/* ------------------------------------------------------------------ 汇总 */
const total = pass + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} 数据层：${pass}/${total} 项通过\n`);
if (failures.length) {
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exitCode = 1;
}
