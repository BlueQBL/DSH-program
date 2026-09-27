/* 历史统计测试
 *
 * 用法：node test/archive.test.js
 *
 * 这一块最容易出的错是"把缺报当成 0"：把没有记录的日子当 0 计入平均，
 * 平均值会偏低而且低得看不出来；把缺降水当 0 会让"雨日占比"失真。
 * 所以下面每一条都在验"缺报到底有没有被排除"。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/archive.js');

/** 造一份"行存"的日值，字段名和规范化后一致 */
const day = (date, over) => Object.assign({
  date, high: 20, low: 10, mean: 15, code: 1, precip: 0, wind: 8,
  humidity: 60, sunshine: 36000, uvMax: 5,
}, over || {});

const rows = (n, over) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 1 + i));
  return day(d.toISOString().slice(0, 10), typeof over === 'function' ? over(i) : over);
});

/* ---------------------------------------------------------------- 摘要 */

test('基本统计：均值、极值、合计都算对', () => {
  const data = [day('2026-01-01', { high: 10, low: 0, mean: 5, precip: 0 }),
    day('2026-01-02', { high: 20, low: 10, mean: 15, precip: 5 }),
    day('2026-01-03', { high: 30, low: 20, mean: 25, precip: 10 })];

  const b = A.build({ daily: data }, 'day');
  assert.equal(b.summary.days, 3);
  assert.equal(b.summary.meanTemp, 15);
  assert.equal(b.summary.meanHigh, 20);
  assert.equal(b.summary.meanLow, 10);
  assert.equal(b.summary.maxTemp, 30);
  assert.equal(b.summary.maxTempDate, '2026-01-03');
  assert.equal(b.summary.minTemp, 0);
  assert.equal(b.summary.minTempDate, '2026-01-01');
  assert.equal(b.summary.totalPrecip, 15);
  assert.equal(b.summary.wettestDay, 10);
  assert.equal(b.summary.wettestDate, '2026-01-03');
});

test('缺报不参与计算，而不是当成 0', () => {
  /* 三天里有一天没有气温记录。均温应当是 (10+20)/2 = 15，
     如果把缺报当 0 就会算成 (10+0+20)/3 ≈ 10——差了 5 度，而且看不出来。 */
  const data = [day('2026-01-01', { high: 10, low: 5, mean: 10 }),
    day('2026-01-02', { high: null, low: null, mean: null }),
    day('2026-01-03', { high: 20, low: 15, mean: 20 })];

  const b = A.build({ daily: data }, 'day');
  assert.equal(b.summary.meanTemp, 15, '缺报那天不该拉低均值');
  assert.equal(b.summary.days, 3, '天数仍然按区间算 3 天');
  assert.equal(b.summary.maxTemp, 20);
  assert.equal(b.summary.minTemp, 5, '最低来自有记录的那两天');
});

test('没有均温时用高低温的中点兜底', () => {
  const data = [day('2026-01-01', { high: 20, low: 10, mean: null }),
    day('2026-01-02', { high: 30, low: 20, mean: null })];
  const b = A.build({ daily: data }, 'day');
  assert.equal(b.summary.meanTemp, 20, '(15 + 25) / 2 = 20');
});

test('雨日与大雨日的口径', () => {
  const data = [
    day('2026-01-01', { precip: 0 }),
    day('2026-01-02', { precip: 0.05 }),   // 不足 0.1，不算雨日
    day('2026-01-03', { precip: 0.1 }),    // 刚好达到
    day('2026-01-04', { precip: 12 }),     // 达到 10 mm
  ];
  const b = A.build({ daily: data }, 'day');
  assert.equal(b.summary.rainDays, 2);
  assert.equal(b.summary.heavyDays, 1);
  assert.equal(b.summary.rainRatio, 0.5);
});

test('前后半段差只在日粒度且区间够长时给出', () => {
  // 前 10 天均温 10，后 10 天均温 20 → 差 +10
  const data = rows(20, (i) => (i < 10 ? { mean: 10, high: 15, low: 5 } : { mean: 20, high: 25, low: 15 }));
  const b = A.build({ daily: data }, 'day');
  assert.equal(b.summary.halfAnomaly, 10);

  // 月粒度不给：一个月里只有一个"前半段后半段"，没有意义
  const monthly = A.build({ daily: rows(400, { mean: 15 }) }, 'month');
  assert.equal(monthly.summary.halfAnomaly, null);
});

/* ---------------------------------------------------------------- 聚合 */

test('日粒度原样保留，每月粒度按月求均值与合计', () => {
  const data = [];
  for (let m = 1; m <= 3; m++) {
    for (let d = 1; d <= 10; d++) {
      data.push(day(`2026-0${m}-${String(d).padStart(2, '0')}`, { mean: 10, high: 15, low: 5, precip: 2 }));
    }
  }
  const byDay = A.build({ daily: data }, 'day');
  assert.equal(byDay.series.length, 30);

  const byMonth = A.build({ daily: data }, 'month');
  assert.equal(byMonth.series.length, 3);
  assert.equal(byMonth.series[0].label, '2026-01');
  assert.equal(byMonth.series[0].mean, 10);
  assert.equal(byMonth.series[0].precip, 20, '月降水是合计');
  assert.equal(byMonth.series[0].days, 10);
});

test('月聚合按时间排序，不会因为 Map 插入顺序错乱', () => {
  const data = [day('2026-03-01'), day('2026-01-01'), day('2026-02-01')];
  const b = A.build({ daily: data }, 'month');
  assert.deepEqual(b.series.map((x) => x.label), ['2026-01', '2026-02', '2026-03']);
});

/* ------------------------------------------------------------ 天气构成 */

test('天气构成按性质归类，占比加起来是 1', () => {
  const data = [
    day('2026-01-01', { code: 0 }),   // 晴
    day('2026-01-02', { code: 1 }),   // 晴间多云 → 晴
    day('2026-01-03', { code: 3 }),   // 阴 → 多云到阴
    day('2026-01-04', { code: 61 }),  // 小雨 → 雨
    day('2026-01-05', { code: 95 }),  // 雷阵雨 → 雷暴
    day('2026-01-06', { code: 71 }),  // 小雪 → 雪
  ];
  const b = A.build({ daily: data }, 'day');
  const total = b.composition.items.reduce((a, x) => a + x.ratio, 0);
  assert.equal(b.composition.total, 6);
  assert.ok(Math.abs(total - 1) < 1e-6, '占比合计应当为 1');

  const byKey = Object.fromEntries(b.composition.items.map((x) => [x.key, x.days]));
  assert.equal(byKey.clear, 2);
  assert.equal(byKey.cloud, 1);
  assert.equal(byKey.rain, 1);
  assert.equal(byKey.storm, 1);
  assert.equal(byKey.snow, 1);
});

test('天气构成按天数降序，最多的排第一', () => {
  const data = [
    day('2026-01-01', { code: 61 }), day('2026-01-02', { code: 61 }),
    day('2026-01-03', { code: 61 }), day('2026-01-04', { code: 0 }),
  ];
  const b = A.build({ daily: data }, 'day');
  assert.equal(b.composition.items[0].key, 'rain');
  assert.equal(b.composition.items[0].days, 3);
});

test('缺报的天气码不计入构成', () => {
  const data = [day('2026-01-01', { code: 0 }), day('2026-01-02', { code: null })];
  const b = A.build({ daily: data }, 'day');
  assert.equal(b.composition.total, 1);
});

/* ---------------------------------------------------------- 逐年对齐 */

test('逐年数据按"月+日"对齐，闰年不会让季节错位一天', () => {
  /* 这是刻意不用"年内第几天"的原因：2024 是闰年，3 月 1 日的年内序号是 60，
     而 2025 年的 3 月 1 日是 59。按序号对齐的话，两条曲线从 3 月起就错开一格，
     叠在一起看会以为"今年比去年暖得早"，而那只是历法差异。 */
  const data = [
    day('2024-03-01', { mean: 10 }), day('2025-03-01', { mean: 12 }),
    day('2024-12-31', { mean: 3 }), day('2025-12-31', { mean: 4 }),
  ];
  const years = A.yearOverYear(data);
  assert.deepEqual(years.map((y) => y.year), ['2024', '2025']);

  const i2024 = years[0].points.findIndex((v) => v === 10);
  const i2025 = years[1].points.findIndex((v) => v === 12);
  assert.equal(i2024, i2025, '同月同日必须落在同一下标');
  assert.equal(i2024, A.monthDayIndex('2024-03-01'));
  assert.equal(A.monthDayIndex('2025-03-01'), A.monthDayIndex('2024-03-01'));

  // 年底也要对齐，不能只对齐年初
  assert.equal(years[0].points.findIndex((v) => v === 3), years[1].points.findIndex((v) => v === 4));
});

test('月日下标可逆，且不会越界', () => {
  assert.equal(A.indexToMonthDay(A.monthDayIndex('2026-01-01')), '1/1');
  assert.equal(A.indexToMonthDay(A.monthDayIndex('2026-12-31')), '12/31');
  assert.ok(A.monthDayIndex('2026-12-31') < 372, '最大下标必须在数组长度之内');
});

test('数据不足 400 天时不做逐年对比', () => {
  // 一年内的数据叠起来没有意义（每一年只有一段），也避免白算
  const b = A.build({ daily: rows(30, { mean: 10 }) }, 'day');
  assert.deepEqual(b.years, []);
  const big = A.build({ daily: rows(500, { mean: 10 }) }, 'day');
  assert.ok(big.years.length >= 2, '跨年的数据应当给出多年序列');
});

/* ------------------------------------------------------------ 趋势与边界 */

test('趋势斜率：单调上升的数据给出正的每十年变化', () => {
  const values = Array.from({ length: 365 }, (_, i) => i * 0.01);   // 每天升 0.01 度
  const perDecade = A.trendPerDecade(values);
  assert.ok(perDecade > 30 && perDecade < 40, `每天 0.01 度约合每十年 36.5 度，实际 ${perDecade}`);
});

test('数据太少时不给趋势（避免用几个点编出一个趋势）', () => {
  assert.equal(A.trendPerDecade([1, 2, 3]), null);
  assert.equal(A.trendPerDecade([]), null);
  assert.equal(A.trendPerDecade([1, null, null, null, null, null, null, null, null, null, null]), null);
});

test('空输入与坏输入不崩，返回 null', () => {
  assert.equal(A.build(null, 'day'), null);
  assert.equal(A.build({}, 'day'), null);
  assert.equal(A.build({ daily: [] }, 'day'), null);
  assert.equal(A.build({ daily: { time: [] } }, 'day'), null);
  assert.equal(A.build({ daily: { time: ['2026-01-01'] } }, 'day').summary.days, 1);
});

test('上游原始"列存"形状也能吃', () => {
  const raw = {
    daily: {
      time: ['2026-01-01', '2026-01-02'],
      temperature_2m_max: [10, 20],
      temperature_2m_min: [0, 10],
      temperature_2m_mean: [5, 15],
      precipitation_sum: [0, 4],
      weather_code: [0, 61],
    },
  };
  const b = A.build(raw, 'day');
  assert.equal(b.summary.days, 2);
  assert.equal(b.summary.meanTemp, 10);
  assert.equal(b.summary.totalPrecip, 4);
  assert.equal(b.summary.maxTemp, 20);
});

test('摘要里的极值都带日期（只说"最高 39 度"用户不知道是哪天）', () => {
  const data = rows(5, (i) => ({ high: 20 + i, low: 10 + i, precip: i }));
  const s = A.build({ daily: data }, 'day').summary;
  assert.ok(s.maxTempDate, '最高气温要带日期');
  assert.ok(s.minTempDate, '最低气温要带日期');
  assert.ok(s.wettestDate, '最多雨的一天要带日期');
  assert.equal(s.maxTempDate, data[4].date);
  assert.equal(s.wettestDate, data[4].date);
});
