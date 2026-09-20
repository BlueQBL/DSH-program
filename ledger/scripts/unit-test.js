/* ═══════════════════════════════════════════════════════════════
   流水账 · 数据层测试
   ───────────────────────────────────────────────────────────────
   node scripts/unit-test.js

   零依赖：不要浏览器，不要测试框架。给 store.js 一个最小的
   window / localStorage，然后跑一百多项断言。改了 store.js 就跑一遍。
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// store.js 是 (function(global){...})(window)，给个最小的 window / localStorage 就行
const mem = {};
global.window = global;
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

require('../store.js');
const L = global.Ledger;

const results = [];
let fails = 0;
const ok = (n, c, extra) => { if (!c) fails++; results.push((c ? 'OK   ' : 'FAIL ') + n + (extra != null ? '   「' + extra + '」' : '')); };
const eq = (n, g, w) => ok(n, g === w, g === w ? String(g) : `得到 ${JSON.stringify(g)}，期望 ${JSON.stringify(w)}`);
const throws = (n, fn) => { try { fn(); ok(n, false, '没有抛错'); } catch (e) { ok(n, true, e.constructor.name); } };

/* ── 金额解析 ───────────────────────────────────────────── */
eq('算式 128+36.5', L.parseAmount('128+36.5'), 16450);
eq('千分位 1,024.50', L.parseAmount('1,024.50'), 102450);
eq('带币符 ¥88', L.parseAmount('¥88'), 8800);
eq('乘法 3*4', L.parseAmount('3*4'), 1200);
eq('减法 10-2.5', L.parseAmount('10-2.5'), 750);
eq('优先级 2+3*4', L.parseAmount('2+3*4'), 1400);
eq('连续乘 2*3*4', L.parseAmount('2*3*4'), 2400);
eq('纯小数 .5', L.parseAmount('.5'), 50);
eq('整数 100', L.parseAmount('100'), 10000);
eq('空串 null', L.parseAmount(''), null);
eq('字母 null', L.parseAmount('abc'), null);
eq('负数 null', L.parseAmount('-5'), null);
eq('注入 null', L.parseAmount('1+alert(1)'), null);
eq('括号被拒 null', L.parseAmount('(1+2)'), null);
eq('除号被拒 null', L.parseAmount('10/2'), null);
eq('超出上限 null', L.parseAmount('9999999999'), null);
eq('尾随运算符 null', L.parseAmount('128+'), null);
eq('浮点误差被四舍五入', L.parseAmount('0.1+0.2'), 30);

/* ── 格式化 ─────────────────────────────────────────────── */
eq('分转元', L.money(102450), '1,024.50');
eq('小额补零', L.money(50), '0.50');
eq('零', L.money(0), '0.00');
eq('万元级千分位', L.money(123456789), '1,234,567.89');
eq('带符号', L.yuan(8800), '¥88.00');
eq('导出用纯数字', L.plain(102450), '1024.50');

/* ── 日期 ───────────────────────────────────────────────── */
eq('月份偏移跨年', L.ymShift('2026-01', -1), '2025-12');
eq('月份偏移跨年正', L.ymShift('2026-12', 1), '2027-01');
eq('月份偏移 12 个月', L.ymShift('2026-02', 12), '2027-02');
eq('平年二月', L.daysInMonth('2026-02'), 28);
eq('闰年二月', L.daysInMonth('2024-02'), 29);
eq('大月', L.daysInMonth('2026-01'), 31);
eq('小月', L.daysInMonth('2026-04'), 30);
eq('星期（2026-02-14）', L.weekday('2026-02-14'), '周六');
eq('星期（2024-02-29 闰日）', L.weekday('2024-02-29'), '周四');
eq('日期合法判断', L.isDate('2026-02-30'), false);
eq('日期合法判断 2', L.isDate('2026-02-28'), true);
eq('两位补零', L.pad2(7), '07');
eq('月份提取', L.ymOf('2026-02-14'), '2026-02');

/* ── 存取与规范化 ───────────────────────────────────────── */
const blank = L.blank();
eq('默认分类 17 个', blank.categories.length, 17);
eq('默认预算为 0', blank.budgets.monthly, 0);

L.save(blank);
eq('空账本可存取', L.load().records.length, 0);

const bad = L.normalize({
  records: [
    { date: '2026-02-14', amount: 100, type: 'expense', category: 'e-food' },
    { date: '2026-02-30', amount: 100, type: 'expense', category: 'e-food' },   // 不存在的日期
    { date: '2026-02-14', amount: 0, type: 'expense', category: 'e-food' },     // 0 元
    { date: '2026-02-14', amount: -5, type: 'expense', category: 'e-food' },    // 负数
    { date: '2026-02-14', amount: 'abc', type: 'expense', category: 'e-food' }, // 非数字
    null,
    { date: '2026-02-15', amount: 500, type: 'income', category: '不存在的分类' } // 分类要兜底
  ]
});
eq('脏数据被清理，只留 2 条', bad.records.length, 2);
eq('兜底分类被换成本类型默认', bad.records.some((r) => bad.categories.some((c) => c.id === r.category && c.type === r.type)), true);
eq('金额保留两位数精度', L.normalize({ records: [{ date: '2026-02-14', amount: 16450, type: 'expense', category: 'e-food' }] }).records[0].amount, 16450);

/* ── 记录增删改 ─────────────────────────────────────────── */
const st = L.blank();
const r1 = L.addRecord(st, { type: 'expense', amount: 2850, category: 'e-food', note: '午餐', date: '2026-02-14', time: '12:30' });
const r2 = L.addRecord(st, { type: 'income', amount: 1280000, category: 'i-salary', note: '月薪', date: '2026-02-10', time: '09:00' });
const r3 = L.addRecord(st, { type: 'expense', amount: 400, category: 'e-traffic', note: '地铁', date: '2026-02-14', time: '09:12' });
eq('新增三笔', st.records.length, 3);
eq('备注超长被截断到 60', L.addRecord(st, { type: 'expense', amount: 100, category: 'e-food', note: 'x'.repeat(200), date: '2026-02-14' }).note.length, 60);

const sortedIds = L.sorted(st.records).map((r) => r.id);
eq('排序：日期降序', sortedIds[0], r1.id);
const sameDay = L.sorted(st.records.filter((r) => r.date === '2026-02-14')).map((r) => r.time);
ok('同日按时刻降序', sameDay.every((t, i) => i === 0 || sameDay[i - 1] >= t), sameDay.join(' > '));
eq('最旧的在最后', sortedIds[sortedIds.length - 1], r2.id);

const s1 = L.sum(L.inMonth(st, '2026-02'));
eq('本月合计支出', s1.expense, 2850 + 400 + 100);
eq('本月合计收入', s1.income, 1280000);
eq('结余 = 收入 − 支出', s1.balance, 1280000 - 3350);
eq('笔数', s1.count, 4);

L.updateRecord(st, r1.id, { amount: 3300, note: '午餐（涨价）' });
eq('更新金额', st.records.filter((r) => r.id === r1.id)[0].amount, 3300);
eq('更新备注', st.records.filter((r) => r.id === r1.id)[0].note, '午餐（涨价）');
L.updateRecord(st, r1.id, { date: '2026-02-30' });
eq('非法日期不写进去', st.records.filter((r) => r.id === r1.id)[0].date, '2026-02-14');

const removed = L.removeRecord(st, r3.id);
eq('删除返回被删的那条', removed.id, r3.id);
eq('删除后剩三笔', st.records.length, 3);
L.restoreRecord(st, removed);
eq('恢复后回到四笔', st.records.length, 4);

/* ── 分组统计 ───────────────────────────────────────────── */
const bc = L.byCategory(st, '2026-02', 'expense');
eq('分类汇总按金额降序', bc.list[0].amount >= bc.list[bc.list.length - 1].amount, true);
eq('分类占比合计为 1', Math.round(bc.list.reduce((a, c) => a + c.pct, 0) * 100) / 100, 1);
eq('分类合计等于总支出', bc.total, L.sum(L.inMonth(st, '2026-02')).expense);

const days = L.byDay(st, '2026-02', 'expense');
eq('每日数组长度 = 当月天数', days.length, 28);
eq('14 号那天有支出', days[13].amount > 0, true);
eq('没有记录的那天是 0', days[0].amount, 0);

eq('记账天数', L.activeDaysIn(st, '2026-02'), 2);
eq('连续记账天数（含今天）', L.streak(st) >= 0, true);

const recent = L.recentMonths(st, '2026-02', 6);
eq('近 6 个月数组长度', recent.length, 6);
eq('最后一个是当月', recent[5].ym, '2026-02');
eq('第一个是半年前', recent[0].ym, '2025-09');

/* 连续天数：今天、昨天、前天都有记录时应为 3 */
const streakState = L.blank();
const d0 = new Date();
for (let i = 0; i < 3; i++) {
  const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - i);
  L.addRecord(streakState, { type: 'expense', amount: 100, category: 'e-food', date: L.todayStr(d) });
}
eq('连续三天记为 3', L.streak(streakState), 3);
L.addRecord(streakState, { type: 'expense', amount: 100, category: 'e-food', date: L.todayStr(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 5)) });
eq('中间断档不算连续', L.streak(streakState), 3);

/* 今天没记时，从前一天起算（白天不该平白断掉） */
const gapState = L.blank();
L.addRecord(gapState, { type: 'expense', amount: 100, category: 'e-food', date: L.todayStr(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1)) });
L.addRecord(gapState, { type: 'expense', amount: 100, category: 'e-food', date: L.todayStr(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 2)) });
eq('今天还没记也从昨天起算', L.streak(gapState), 2);

/* ── 预算 ───────────────────────────────────────────────── */
const bs = L.blank();
bs.budgets.monthly = 100000;
bs.budgets.byCategory = { 'e-food': 30000 };
L.addRecord(bs, { type: 'expense', amount: 25000, category: 'e-food', date: L.ymOf(L.todayStr()) + '-05' });
const status = L.budgetStatus(bs, L.ymOf(L.todayStr()));
eq('预算总额', status.total, 100000);
eq('已花', status.spent, 25000);
eq('剩余', status.remaining, 75000);
eq('占比', Math.round(status.ratio * 100), 25);
eq('分类预算被统计', status.categories.length, 1);
eq('分类已用', status.categories[0].used, 25000);
ok('分类未超支', status.categories[0].ratio < 1);
ok('日均剩余为正', status.perDayLeft > 0);

const over = L.blank();
over.budgets.monthly = 1000;
L.addRecord(over, { type: 'expense', amount: 5000, category: 'e-food', date: L.ymOf(L.todayStr()) + '-05' });
const overStatus = L.budgetStatus(over, L.ymOf(L.todayStr()));
ok('超支时剩余为负', overStatus.remaining < 0, String(overStatus.remaining));
ok('超支比例 > 1', overStatus.ratio > 1, String(overStatus.ratio));

/* ── 分类管理 ───────────────────────────────────────────── */
const cs = L.blank();
const made = L.addCategory(cs, '宠物', 'expense');
eq('新增分类', cs.categories.length, 18);
eq('重名返回已有分类', L.addCategory(cs, '宠物', 'expense').id, made.id);
eq('同名不同收支类型是两个分类', L.addCategory(cs, '宠物', 'income').id !== made.id, true);
eq('空名不创建', L.addCategory(cs, '   ', 'expense'), null);
L.renameCategory(cs, made.id, '猫粮');
eq('改名生效', cs.categories.filter((c) => c.id === made.id)[0].name, '猫粮');
eq('改名不产生新分类', cs.categories.length, 19);

const cs2 = L.blank();
L.addRecord(cs2, { type: 'expense', amount: 100, category: 'e-food', date: '2026-02-14' });
L.addRecord(cs2, { type: 'expense', amount: 200, category: 'e-food', date: '2026-02-15' });
L.addRecord(cs2, { type: 'expense', amount: 300, category: 'e-shop', date: '2026-02-15' });
const delRes = L.removeCategory(cs2, 'e-food');
eq('删除分类成功', delRes.ok, true);
eq('两笔记录被改挂而不是删掉', delRes.moved, 2);
eq('记录总数不变', cs2.records.length, 3);
eq('改挂后不再引用已删分类', cs2.records.filter((r) => r.category === 'e-food').length, 0);

const lastOne = L.blank();
lastOne.categories = lastOne.categories.filter((c) => c.type === 'income');
lastOne.categories.push({ id: 'only-exp', name: '唯一支出', type: 'expense' });
eq('同类型只剩一个时拒绝删除', L.removeCategory(lastOne, 'only-exp').ok, false);

/* ── CSV ────────────────────────────────────────────────── */
const csvState = L.blank();
L.addRecord(csvState, { type: 'expense', amount: 2850, category: 'e-food', note: '带,逗号', date: '2026-02-14', time: '12:30' });
L.addRecord(csvState, { type: 'income', amount: 1280000, category: 'i-salary', note: '带"引号"', date: '2026-02-10', time: '09:00' });

const csv = L.toCSV(csvState);
eq('CSV 有 BOM', csv.charCodeAt(0), 65279);
eq('CSV 表头', csv.split('\r\n')[0].slice(1), '日期,时间,类型,分类,金额,备注');
ok('CSV 转义逗号', csv.indexOf('"带,逗号"') >= 0);
ok('CSV 转义引号', csv.indexOf('"带""引号"""') >= 0);

const back = L.fromCSV({ categories: csvState.categories.slice(), records: [] }, csv);
eq('CSV 往返条数', back.records.length, 2);
eq('CSV 往返金额', back.records.find((r) => r.type === 'expense').amount, 2850);
eq('CSV 往返备注（含逗号）', back.records.find((r) => r.type === 'expense').note, '带,逗号');
eq('CSV 往返备注（含引号）', back.records.find((r) => r.type === 'income').note, '带"引号"');
eq('CSV 往返时间', back.records.find((r) => r.type === 'expense').time, '12:30');
eq('CSV 往返分类是同一 id', back.records.find((r) => r.type === 'expense').category, 'e-food');

const messy = L.fromCSV({ categories: csvState.categories.slice(), records: [] },
  '金额,备注,日期\n-8.50,早餐,2026/3/2\n+300,红包,2026-03-05\n0,,\n,,\nabc,,');
eq('乱序表头 + 缺列', messy.records.length, 2);
eq('0 元行和非数字金额被跳过', messy.skipped, 2);
eq('负号推支出', messy.records[0].type, 'expense');
eq('正号推收入', messy.records[1].type, 'income');
eq('斜杠日期', messy.records[0].date, '2026-03-02');
eq('没有分类列时不凭空建分类', messy.created.length, 0);
ok('没有分类列时兜底到同类型分类',
  messy.records.every((r) => csvState.categories.some((c) => c.id === r.category && c.type === r.type)));

/* 有分类列时，没见过的分类要自动建（这里要拿住 state 引用，新建的分类就落在它身上） */
const catState = { categories: csvState.categories.slice(), records: [] };
const withCat = L.fromCSV(catState,
  '日期,类型,分类,金额\n2026-03-02,支出,早餐,8.50\n2026-03-05,收入,红包,300\n2026-03-06,支出,早餐,9.00');
eq('有分类列时自动建新分类', withCat.created.length, 1);
eq('新分类的名字对', withCat.created[0], '早餐');
eq('内置同名分类被复用而不是新建',
  catState.categories.filter((c) => c.name === '红包').length, 1);
eq('新建的分类真的进了分类表',
  catState.categories.filter((c) => c.name === '早餐' || c.name === '红包').length, 2);
eq('新建的分类挂到了记录上',
  withCat.records[0].category, catState.categories.filter((c) => c.name === '早餐' && c.type === 'expense')[0].id);
eq('两条同名支出分类共用一个 id', withCat.records[0].category, withCat.records[2].category);
ok('同名但不同收支类型互不干扰',
  catState.categories.filter((c) => c.name === '早餐')[0].id !==
  catState.categories.filter((c) => c.name === '红包')[0].id);

const noHeader = L.fromCSV({ categories: csvState.categories.slice(), records: [] },
  '2026-02-14,12:30,支出,餐饮,28.50,午餐');
eq('无表头按位置猜', noHeader.records.length, 1);
eq('无表头金额对', noHeader.records[0].amount, 2850);

const noAmtCol = L.fromCSV({ categories: csvState.categories.slice(), records: [] }, '日期,备注\n2026-02-14,午餐');
ok('找不到金额列会报错', !!noAmtCol.error, noAmtCol.error);
eq('空文件会报错', !!L.fromCSV({ categories: [], records: [] }, '').error, true);

/* ── JSON 导入 ──────────────────────────────────────────── */
const target = L.blank();
const foreign = JSON.stringify({
  app: '别家记账',
  categories: [
    { id: 'X9', name: '餐饮', type: 'expense' },   // 本机已有同名 → 应复用
    { id: 'X7', name: '投资', type: 'income' }    // 本机没有 → 应新建
  ],
  records: [
    { date: '2026-01-20', time: '09:00', type: 'expense', category: 'X9', amount: 3000, note: '外来的' },
    { date: '2026-01-21', time: '10:00', type: 'income', category: 'X7', amount: 90000, note: '分红' }
  ]
});
const imp = L.parseAnyImport(target, foreign);
eq('JSON 导入无错', imp.error, null);
eq('JSON 导入两笔', imp.records.length, 2);
eq('外部分类 id 已重映射到本机 id', imp.records[0].category, 'e-food');
eq('新分类被建出来', target.categories.filter((c) => c.name === '投资').length, 1);
eq('新记录挂到新分类上', imp.records[1].category, target.categories.filter((c) => c.name === '投资')[0].id);
eq('备注保留', imp.records[0].note, '外来的');

const bareArr = L.parseAnyImport(L.blank(), JSON.stringify([
  { date: '2026-01-20', time: '09:00', type: 'expense', category: 'e-food', amount: 3000, note: '裸数组' }
]));
eq('裸数组也能导入', bareArr.records.length, 1);

eq('坏 JSON 报错', !!L.parseAnyImport(L.blank(), '{不是 JSON').error, true);
eq('没有记录数组时报错', !!L.parseAnyImport(L.blank(), '{"foo":1}').error, true);

/* ── 往返一致性（半年量级） ─────────────────────────────── */
const big = L.blank();
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let m = 0; m < 6; m++) {
  const ym = L.ymShift(L.ymOf(L.todayStr()), -m);
  for (let d = 1; d <= L.daysInMonth(ym); d++) {
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      L.addRecord(big, {
        type: rnd() > 0.9 ? 'income' : 'expense',
        amount: 100 + Math.floor(rnd() * 50000),
        category: rnd() > 0.9 ? 'i-side' : 'e-food',
        note: '第' + d + '天',
        date: ym + '-' + L.pad2(d),
        time: L.pad2(8 + Math.floor(rnd() * 12)) + ':' + L.pad2(Math.floor(rnd() * 60))
      });
    }
  }
}
ok('半年账本有足够样本', big.records.length > 150, big.records.length + ' 笔');
const bigCsv = L.toCSV(big);
const bigBack = L.fromCSV({ categories: big.categories.slice(), records: [] }, bigCsv);
eq('大账本 CSV 往返条数一致', bigBack.records.length, big.records.length);
eq('大账本 CSV 往返总分一致',
  bigBack.records.reduce((a, r) => a + r.amount, 0),
  big.records.reduce((a, r) => a + r.amount, 0));
eq('大账本 CSV 往返日期集合一致',
  bigBack.records.map((r) => r.date).sort().join(),
  big.records.map((r) => r.date).sort().join());
eq('大账本 JSON 往返条数一致',
  L.parseAnyImport({ categories: big.categories.slice(), records: [] }, L.toJSON(big)).records.length,
  big.records.length);

/* ── 持久化失败要能察觉 ─────────────────────────────────── */
const goodLocal = global.localStorage;
global.localStorage = { setItem() { throw new Error('QuotaExceededError'); }, getItem() { return null; }, removeItem() {} };
eq('存储失败时 save 返回 false', L.save(L.blank()), false);
global.localStorage = goodLocal;

/* ── 输出 ───────────────────────────────────────────────── */
console.log((fails ? '✗ ' + fails + ' 项失败' : '✓ 全部通过') + '（共 ' + results.length + ' 项）');
console.log('');
console.log(results.join('\n'));
process.exitCode = fails ? 1 : 0;
