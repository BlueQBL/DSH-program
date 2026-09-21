'use strict';

/**
 * 界面冒烟测试：把真实的 index.html + core.js + ui.js 装进极简 DOM 垫片里跑一遍，
 * 覆盖"添加 → 筛选 → 搜索 → 编辑 → 完成 → 删除 → 刷新后仍在"的完整闭环。
 * 运行：node test/dom.test.js
 *
 * 说明：垫片只提供 DOM 语义与事件流，不做布局渲染；
 * 视觉是否好看不在这里断言，这里只保证交互逻辑与状态落地是对的。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const shim = require('./dom-shim.js');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'core.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pass = 0;
const failures = [];

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass += 1;
  } catch {
    failures.push(`${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  eq(Boolean(value), true, label);
}

async function group(name, fn) {
  const before = failures.length;
  await fn();
  const bad = failures.length > before;
  console.log(`  ${bad ? '✗' : '✓'} ${name}`);
  if (bad && currentWin) {
    const s = currentWin.__todoApp.state;
    console.log(
      `      ↳ 现场：可见=${JSON.stringify(titles(currentWin))} 筛选=${JSON.stringify(s.filters)} 计数=${
        $(currentWin, '#results-count').textContent
      } 状态=${JSON.stringify(s.tasks.map((t) => `${t.title}:${t.done ? 'done' : 'open'}`))}`
    );
  }
}

let currentWin = null;

/* ------------------------------------------------------------------ 运行环境 */

const GLOBALS = [
  'window', 'document', 'globalThis', 'localStorage', 'MutationObserver',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'FileReader', 'Blob', 'URL', 'Notification', 'matchMedia', 'getComputedStyle',
  'confirm', 'console', 'location', 'history',
];

/** 把 index.html 里的脚本按顺序在垫片环境里求值一次，等价于浏览器加载这个页面 */
function boot(storage) {
  const win = shim.createEnvironment({ storage });
  win.__parse(HTML);

  const run = (code) => {
    const fn = new Function(...GLOBALS, code);
    return fn.call(win, ...GLOBALS.map((name) => win[name]));
  };

  try {
    run(CORE_SRC);
    run(UI_SRC);
    // index.html 底部那段内联启动脚本
    run(HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.lastIndexOf('</script>')));
  } catch (err) {
    throw new Error(`脚本加载失败：${err.message}\n${err.stack}`);
  }

  return win;
}

function click(el, win) {
  el.dispatchEvent(new win.Event('click', { bubbles: true, cancelable: true }));
}

function type(el, value, win) {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function submit(el, win) {
  el.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
}

const $ = (win, sel) => win.document.querySelector(sel);
const $$ = (win, sel) => win.document.querySelectorAll(sel);
const titles = (win) => $$(win, '#task-list .task-title').map((el) => el.textContent);
const taskCount = (win) => $$(win, '#task-list .task').length;
const cardOf = (win, title) =>
  $$(win, '#task-list .task').find((li) => li.querySelector('.task-title').textContent === title);
const taskBy = (win, title) => win.__todoApp.state.tasks.find((t) => t.title === title);
const state = (win) => win.__todoApp.state;

/** 走一遍真实的提交路径：填表 → submit */
function addTask(win, input) {
  $(win, '#f-title').value = input.title;
  $(win, '#f-desc').value = input.desc || '';
  $(win, '#f-due').value = input.due || '';
  $(win, '#f-category').value = input.category || '';
  if (input.priority) {
    $$(win, '#f-priority input').forEach((r) => (r.checked = r.value === input.priority));
  }
  submit($(win, '#compose-form'), win);
}

/** 用指针事件模拟一次真实的撕票根动作（dy 超过阈值才撕下来） */
function tearStub(win, card, dy) {
  const stub = card.querySelector('.stub');
  stub.dispatchEvent(new win.Event('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerId: 1 }));
  stub.dispatchEvent(new win.Event('pointermove', { bubbles: true, clientX: 12, clientY: 10 + dy, pointerId: 1 }));
  stub.dispatchEvent(new win.Event('pointerup', { bubbles: true, clientX: 12, clientY: 10 + dy, pointerId: 1 }));
}

const tapStub = (win, card) => tearStub(win, card, 0);

/* ------------------------------------------------------------------ 测试主体 */

(async function main() {
  console.log('\n案头待办 · 界面测试\n');

  const win = boot();
  currentWin = win;
  const doc = win.document;
  const ISO = win.TodoCore.todayISO(new Date());
  const minus = (n) => win.TodoCore.shiftISO(n, new Date());

  /* ---------------------------------------------------------------- 启动 */
  await group('首次启动：真实页面装起来了', () => {
    ok($(win, '#compose-form'), '立单表单存在');
    ok(win.__todoApp, '应用实例已挂载');
    ok(win.TodoCore, 'core 注册到 window');
    eq(taskCount(win), 0, '初始没有任务');
    eq($(win, '#empty-state').hidden, false, '显示空态');
    eq($(win, '#stat-rate').textContent, '0%', '完成率 0%');
    eq($(win, '#results-count').textContent, '0 / 0 条', '计数 0 / 0');
  });

  await group('筛选项来自 core 的枚举，不是各写一份', () => {
    eq($$(win, '#status-bar .seg').length, win.TodoCore.STATUSES.length, '状态段数一致');
    eq($$(win, '#f-priority .prio').length, win.TodoCore.PRIORITIES.length, '优先级选项数一致');
    eq($$(win, '#sort-select option').length, win.TodoCore.SORTS.length, '排序选项数一致');
    eq($(win, '#due-quick').children.length, 5, '快捷日期按钮 5 个');
    ok($(win, '#category-list').children.length >= 3, '分类建议已有默认值');
  });

  /* ---------------------------------------------------------------- 新增 */
  await group('添加待办：标题 / 描述 / 截止日期 / 优先级 / 分类', () => {
    addTask(win, { title: '写季度复盘', desc: '结论放第一页', due: ISO, priority: 'urgent', category: '工作' });
    eq(taskCount(win), 1, '列表出现一条');
    eq(titles(win), ['写季度复盘'], '标题正确');
    eq($(win, '#task-list .task-desc').textContent, '结论放第一页', '描述正确');
    ok($(win, '#task-list .badge.due').textContent.includes('今天'), '今天到期有提示');
    eq($(win, '#task-list .task').dataset.priority, 'urgent', '优先级写进 DOM');
    eq($(win, '#task-list .stub-prio').textContent, '紧急', '票根印着优先级');
    eq($(win, '#task-list .stub-cat').textContent, '工作', '票根印着分类');
    eq($(win, '#task-list .stub-no').textContent, 'NO.001', '票根编号存在');
    eq($(win, '#stat-total').textContent, '1', '统计跟着更新');
    eq($(win, '#f-title').value, '', '提交后表单清空');
    eq($(win, '#empty-state').hidden, true, '有数据后空态收起');
  });

  await group('添加多条，新分类自动进筛选器', async () => {
    addTask(win, { title: '给接口补重试', due: win.TodoCore.shiftISO(-2, new Date()), priority: 'high', category: '工作' });
    addTask(win, { title: '读《重构》', due: win.TodoCore.shiftISO(3, new Date()), priority: 'normal', category: '学习' });
    addTask(win, { title: '预约牙医', priority: 'low', category: '生活' });
    eq(taskCount(win), 4, '四条都在');
    await tick(30); // 等 MutationObserver 把新卡片的拖拽监听挂上（真实浏览器里也是异步的）
    ok($$(win, '#chip-categories .chip-label').map((e) => e.textContent).includes('学习'), '「学习」出现在分类筛选里');
    eq($(win, '#stat-overdue').textContent, '1', '逾期数正确');
    eq($(win, '#stat-today').textContent, '1', '今天到期数正确');
    eq($(win, '#stat-active').textContent, '4', '待办数正确');
  });

  await group('空标题被拦下', () => {
    addTask(win, { title: '   ', desc: '没有标题' });
    eq(taskCount(win), 4, '没有新增');
    eq($(win, '#compose-error').hidden, false, '显示错误提示');
    ok($(win, '#compose-error').textContent.includes('标题'), '提示指向标题');
    eq($(win, '#f-title').getAttribute('aria-invalid'), 'true', '标题被标成非法');
  });

  /* ---------------------------------------------------------------- 筛选 */
  await group('按状态筛选', () => {
    const overdueCard = cardOf(win, '给接口补重试');
    click($(win, '#status-bar .seg[data-status="overdue"]'), win);
    eq(state(win).filters.status, 'overdue', '点「逾期」后筛选状态切换');
    eq(titles(win), ['给接口补重试'], '只看逾期');
    eq($(win, '#results-count').textContent, '显示 1 / 4 条', '计数写明过滤了多少');
    eq($(win, '#status-bar .seg[data-status="overdue"]').getAttribute('aria-pressed'), 'true', '选中态可读');
    click($(win, '#status-bar .seg[data-status="all"]'), win);
    eq(taskCount(win), 4, '切回全部');
    eq(titles(win).includes('给接口补重试'), true, '那条逾期的又回到列表里');
    void overdueCard;
  });

  await group('按分类 / 优先级筛选，且可叠加', () => {
    click($(win, '#chip-categories .chip[data-filter-value="工作"]'), win);
    eq(taskCount(win), 2, '只看「工作」');
    click($(win, '#chip-priorities .chip[data-filter-value="urgent"]'), win);
    eq(titles(win), ['写季度复盘'], '分类 + 优先级取交集');
    eq($(win, '#filters-reset').disabled, false, '有筛选时按钮可用');
    click($(win, '#filters-reset'), win);
    eq(taskCount(win), 4, '清空筛选回到全部');
    eq($(win, '#filters-reset').disabled, true, '没筛选时按钮禁用');
  });

  await group('搜索：防抖 120ms、多关键词 AND', async () => {
    type($(win, '#search-input'), '重试', win);
    eq(taskCount(win), 4, '防抖窗口内还没过滤');
    await tick(220);
    eq(titles(win), ['给接口补重试'], '搜标题命中');
    eq($(win, '#search-clear').hidden, false, '出现清空按钮');

    type($(win, '#search-input'), '结论 复盘', win);
    await tick(220);
    eq(taskCount(win), 1, '一个词命中标题、一个命中描述，都满足才留下');

    type($(win, '#search-input'), '复盘 牙医', win);
    await tick(220);
    eq(taskCount(win), 0, '两个词分属不同任务时为空');
    eq($(win, '#empty-state').hidden, false, '空态出现');
    eq($(win, '#empty-title').textContent, '没有符合条件的待办', '空态文案区分「筛不到」');

    click($(win, '#search-clear'), win);
    await tick(30);
    eq(taskCount(win), 4, '清空搜索后恢复');
    eq($(win, '#search-clear').hidden, true, '清空按钮收起');
  });

  await group('空态按钮一键回到全量', async () => {
    type($(win, '#search-input'), '不存在的关键词', win);
    await tick(220);
    eq(taskCount(win), 0, '先筛成空');
    click($(win, '#empty-action'), win);
    await tick(30);
    eq(taskCount(win), 4, '点一下回到全部');
  });

  await group('排序切换', () => {
    $(win, '#sort-select').value = 'due';
    $(win, '#sort-select').dispatchEvent(new win.Event('change', { bubbles: true }));
    eq(state(win).filters.sort, 'due', '下拉框换排序方式');
    eq(titles(win)[0], '给接口补重试', '按截止日期：最早的在最前');

    $(win, '#sort-select').value = 'smart';
    $(win, '#sort-select').dispatchEvent(new win.Event('change', { bubbles: true }));
    eq(state(win).filters.sort, 'smart', '切回智能排序');
    eq(titles(win)[0], '给接口补重试', '智能排序同样把逾期排最前');
  });

  /* ---------------------------------------------------------------- 完成 */
  await group('撕下票根 = 完成', async () => {
    win.__todoTraceTear = false;
    const card = cardOf(win, '读《重构》');
    eq(Boolean(card), true, '找到「读《重构》」卡片');
    ok(card.dataset.bound === '1', '票根已挂上拖拽监听');
    const id = card.dataset.id;
    const stub = card.querySelector('.stub');
    stub.dispatchEvent(new win.Event('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerId: 1 }));
    stub.dispatchEvent(new win.Event('pointermove', { bubbles: true, clientX: 12, clientY: 60, pointerId: 1 }));
    ok(card.classList.contains('is-armed'), '拖过阈值给出「待撕」反馈');
    stub.dispatchEvent(new win.Event('pointerup', { bubbles: true, clientX: 12, clientY: 60, pointerId: 1 }));
    await tick(520); // 撕票根有 360ms 的离场动画
    eq(state(win).tasks.find((t) => t.id === id).done, true, '撕下后标记完成');
    const after = $$(win, '#task-list .task').find((li) => li.dataset.id === id);
    ok(after.classList.contains('is-done'), '卡片变成已完成样式');
    ok(!after.classList.contains('is-tearing'), '撕完把动画类清掉了');
  });

  await group('轻点票根 = 切换完成状态', async () => {
    const id = cardOf(win, '预约牙医').dataset.id;
    tapStub(win, cardOf(win, '预约牙医'));
    await tick(420); // 撕票根有 360ms 的离场动画，等它落地
    eq(state(win).tasks.find((t) => t.id === id).done, true, '轻点也能完成');
    tapStub(win, cardOf(win, '预约牙医'));
    await tick(420);
    const back = state(win).tasks.find((t) => t.id === id);
    eq(back.done, false, '再点一次恢复未完成');
    eq(back.completedAt, null, '恢复未完成时清掉完成时间');
  });

  await group('票根可用键盘操作', () => {
    cardOf(win, '写季度复盘')
      .querySelector('.stub')
      .dispatchEvent(new win.Event('keydown', { bubbles: true, key: 'Enter' }));
    eq(taskBy(win, '写季度复盘').done, true, '回车标记完成');
  });

  await group('统计随完成情况变化', () => {
    eq($(win, '#stat-rate').textContent, '50%', '4 条完成 2 条 = 50%');
    eq($(win, '#stat-done').textContent, '2', '已完成 2');
    eq($(win, '#stat-active').textContent, '2', '待办 2');
    eq($(win, '#series').children.length, 14, '近两周画 14 格');
    ok($(win, '#series .tick.is-today').getAttribute('title').includes('2 条'), '今天完成 2 条');
    ok($(win, '#category-stats').children.length >= 3, '分类分布有柱子');
    ok(Number($(win, '#ring-value').getAttribute('stroke-dashoffset')) > 0, '完成率环有进度值');
  });

  /* ---------------------------------------------------------------- 编辑 */
  await group('编辑：打开、回填、保存', () => {
    click(cardOf(win, '预约牙医').querySelector('.icon-button[aria-label="编辑"]'), win);
    const dialog = $(win, '#edit-dialog');
    ok(dialog.hasAttribute('open'), '对话框打开');
    eq($(win, '#e-title').value, '预约牙医', '回填标题');
    eq($(win, '#e-category').value, '生活', '回填分类');
    eq($$(win, '#e-priority .prio').length, 4, '优先级选项已建好');
    eq($$(win, '#e-priority input:checked').length, 1, '恰好一个被选中');
    eq($$(win, '#e-priority input:checked')[0].value, 'low', '回填原来的优先级');

    $(win, '#e-title').value = '预约牙医（改到周四）';
    $(win, '#e-due').value = win.TodoCore.shiftISO(2, new Date());
    $$(win, '#e-priority input').forEach((r) => (r.checked = r.value === 'high'));
    submit($(win, '#edit-form'), win);

    eq(dialog.hasAttribute('open'), false, '保存后关闭');
    ok(taskBy(win, '预约牙医（改到周四）'), '新标题已生效');
    eq(taskBy(win, '预约牙医（改到周四）').priority, 'high', '优先级已更新');
    eq(taskBy(win, '预约牙医（改到周四）').due, win.TodoCore.shiftISO(2, new Date()), '截止日期已更新');
    eq(taskBy(win, '预约牙医'), undefined, '旧标题不再存在');
  });

  await group('编辑时空标题会被挡住', () => {
    click(cardOf(win, '预约牙医（改到周四）').querySelector('.icon-button[aria-label="编辑"]'), win);
    $(win, '#e-title').value = '  ';
    submit($(win, '#edit-form'), win);
    eq($(win, '#e-error').hidden, false, '给出错误提示');
    ok($(win, '#edit-dialog').hasAttribute('open'), '出错时不关闭对话框');
    $(win, '#edit-dialog').close();
  });

  /* ---------------------------------------------------------------- 复制 / 删除 */
  await group('复制一份', () => {
    click(cardOf(win, '给接口补重试').querySelector('.icon-button[aria-label="复制一份"]'), win);
    eq(taskCount(win), 5, '多出一条');
    ok(titles(win).some((t) => t.includes('副本')), '副本带标记');
  });

  await group('删除：先确认，再生效', () => {
    const card = $$(win, '#task-list .task').find((li) => li.querySelector('.task-title').textContent.includes('副本'));
    click(card.querySelector('.icon-button[aria-label="删除"]'), win);
    ok($(win, '#confirm-dialog').hasAttribute('open'), '弹出确认框');
    eq(taskCount(win), 5, '确认前还没删');
    click($(win, '#confirm-ok'), win);
    eq(taskCount(win), 4, '确认后删掉一条');
  });

  /* ---------------------------------------------------------------- 持久化 */
  await group('数据已写进 LocalStorage', () => {
    const raw = win.localStorage.getItem(win.TodoCore.STORAGE_KEY);
    ok(raw, '存储里有关键字');
    const parsed = JSON.parse(raw);
    eq(parsed.tasks.length, 4, '四条任务都存了');
    eq(parsed.version, win.TodoCore.SCHEMA_VERSION, '带 schema 版本号');
    eq(parsed.tasks.find((t) => t.title === '预约牙医（改到周四）').priority, 'high', '编辑结果也落地了');
  });

  await group('刷新页面（重建整个应用）后数据还在', () => {
    const second = boot(win.localStorage);
    eq(taskCount(second), 4, '列表条数一致');
    ok(titles(second).includes('写季度复盘'), '标题还在');
    ok(titles(second).includes('预约牙医（改到周四）'), '编辑过的内容还在');
    eq(taskBy(second, '写季度复盘').done, true, '完成状态还在');
    eq($(second, '#stat-rate').textContent, '50%', '统计重算出来还是 50%');
  });

  await group('撤销：删错了能找回', () => {
    const before = taskCount(win);
    click($$(win, '#task-list .task')[0].querySelector('.icon-button[aria-label="删除"]'), win);
    click($(win, '#confirm-ok'), win);
    eq(taskCount(win), before - 1, '先删掉一条');
    eq($(win, '#toast-action').hidden, false, '提示条上有撤销按钮');
    click($(win, '#toast-action'), win);
    eq(taskCount(win), before, '撤销后回来了');
  });

  await group('清空已完成', () => {
    const doneCount = win.__todoApp.state.tasks.filter((t) => t.done).length;
    ok(doneCount > 0, '确实有已完成的');
    click($(win, '#clear-done'), win);
    click($(win, '#confirm-ok'), win);
    eq(win.__todoApp.state.tasks.filter((t) => t.done).length, 0, '已完成的被清掉');
    eq(win.__todoApp.state.tasks.length, 4 - doneCount, '只留未完成的');
    eq($(win, '#clear-done').disabled, true, '清空后按钮禁用');
  });

  /* ---------------------------------------------------------------- 主题 / 导入导出 */
  await group('夜间模式可切换且被记住', () => {
    const toggle = $(win, '#theme-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new win.Event('change', { bubbles: true }));
    eq(doc.documentElement.getAttribute('data-theme'), 'dark', 'html 上打了 dark 标记');
    eq(JSON.parse(win.localStorage.getItem(win.TodoCore.STORAGE_KEY)).prefs.theme, 'dark', '主题存了下来');
    toggle.checked = false;
    toggle.dispatchEvent(new win.Event('change', { bubbles: true }));
    eq(doc.documentElement.getAttribute('data-theme'), 'light', '切回白天');
  });

  await group('导出按钮不报错', () => {
    let message = null;
    try {
      click($(win, '#export-json'), win);
      click($(win, '#export-csv'), win);
    } catch (err) {
      message = err.message;
    }
    eq(message, null, '导出 JSON / CSV 都走通');
  });

  await group('导入 JSON：合并而不是覆盖', async () => {
    const before = taskCount(win);
    const payload = JSON.stringify({
      version: 1,
      tasks: [{ title: '从备份导入的一条', priority: 'urgent', category: '导入' }],
      categories: ['导入'],
    });
    const input = $(win, '#import-input');
    input.files = [{ name: 'backup.json', content: payload }];
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick(40);
    eq(taskCount(win), before + 1, '多出导入的那一条');
    ok(titles(win).includes('从备份导入的一条'), '导入的标题在列表里');
    ok($$(win, '#chip-categories .chip-label').map((e) => e.textContent).includes('导入'), '导入的分类进了筛选器');
  });

  await group('导入坏文件只提示，不破坏现有数据', async () => {
    const before = taskCount(win);
    const input = $(win, '#import-input');
    input.files = [{ name: 'bad.json', content: '{这不是 JSON' }];
    input.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick(40);
    eq(taskCount(win), before, '数据没被破坏');
    ok($(win, '#toast-text').textContent.includes('导入失败'), '提示说明导入失败');
  });

  /* ---------------------------------------------------------------- 大列表 */
  await group('120 条任务：分批渲染也能全部落地', async () => {
    const seed = { [win.TodoCore.STORAGE_KEY]: JSON.stringify({ version: 1, tasks: [], categories: ['工作'] }) };
    const third = boot(shim.createMemoryStorage(seed));
    for (let i = 0; i < 120; i += 1) {
      third.__todoApp.state.tasks.push(
        third.TodoCore.createTask({ id: `bulk-${i}`, title: `批量任务 ${i}`, category: '工作' }, new Date())
      );
    }
    third.__todoApp.refresh();
    eq(taskCount(third), 80, '首屏先渲染一批');
    await tick(150);
    eq(taskCount(third), 120, '剩下的用 rAF 补齐');
    eq($(third, '#results-count').textContent, '显示 120 / 120 条', '计数显示全部');
  });

  /* ---------------------------------------------------------------- 收尾 */
  const total = pass + failures.length;
  console.log(`\n${failures.length ? '✗' : '✓'} 界面：${pass}/${total} 项通过\n`);
  if (failures.length) {
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\n测试本身崩了：', err);
  process.exit(1);
});
