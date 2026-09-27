/* 空气质量指数与天气预警测试
 *
 * 用法：node test/aqi.test.js
 *
 * AQI 这一块特别值得测：公式是分段线性的，写错一个断点不会报错，
 * 只会让所有城市的空气质量整体偏高一档或低一档——而用户是照着这个数字
 * 决定要不要戴口罩、要不要让老人出门的。所以这里逐档对表验证。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/aqi.js');
const Alerts = require('../js/alerts.js');

/* ------------------------------------------------------------ IAQI 分段表 */

test('PM2.5 各档断点与国标一致', () => {
  // HJ 633—2012 表1：35→50、75→100、115→150、150→200、250→300、350→400、500→500
  const table = [[35, 50], [75, 100], [115, 150], [150, 200], [250, 300], [350, 400], [500, 500]];
  for (const [conc, expect] of table) {
    assert.equal(A.iaqi(conc, A.LIMITS.pm25_24h), expect, `PM2.5 ${conc} 应当对应 IAQI ${expect}`);
  }
});

test('PM10 各档断点与国标一致', () => {
  const table = [[50, 50], [150, 100], [250, 150], [350, 200], [420, 300], [500, 400], [600, 500]];
  for (const [conc, expect] of table) {
    assert.equal(A.iaqi(conc, A.LIMITS.pm10_24h), expect, `PM10 ${conc} 应当对应 IAQI ${expect}`);
  }
});

test('其余四种污染物的首档断点正确', () => {
  assert.equal(A.iaqi(50, A.LIMITS.so2_24h), 50);      // SO2 50 μg/m³
  assert.equal(A.iaqi(40, A.LIMITS.no2_24h), 50);      // NO2 40 μg/m³
  assert.equal(A.iaqi(2, A.LIMITS.co_24h), 50);        // CO 2 mg/m³
  assert.equal(A.iaqi(100, A.LIMITS.o3_8h), 50);       // O3 8 小时 100 μg/m³
  assert.equal(A.iaqi(160, A.LIMITS.o3_8h), 100);
});

test('段内线性插值', () => {
  // PM2.5 在 35–75 之间线性：55 正好是中点 → IAQI 75
  assert.equal(A.iaqi(55, A.LIMITS.pm25_24h), 75);
  // PM10 在 150–250 之间：200 是中点 → IAQI 125
  assert.equal(A.iaqi(200, A.LIMITS.pm10_24h), 125);
  assert.equal(A.iaqi(0, A.LIMITS.pm25_24h), 0);
});

test('超出最高断点时封顶 500，不外推', () => {
  assert.equal(A.iaqi(600, A.LIMITS.pm25_24h), 500);
  assert.equal(A.iaqi(9999, A.LIMITS.pm10_24h), 500);
});

test('非法浓度返回 null 而不是 0', () => {
  // 返回 0 会被当成"空气极好"，那是编出来的结论
  assert.equal(A.iaqi(null, A.LIMITS.pm25_24h), null);
  assert.equal(A.iaqi(undefined, A.LIMITS.pm25_24h), null);
  assert.equal(A.iaqi(NaN, A.LIMITS.pm25_24h), null);
  assert.equal(A.iaqi(-5, A.LIMITS.pm25_24h), null);
  assert.equal(A.iaqi('35', A.LIMITS.pm25_24h), null);
});

/* ---------------------------------------------------------------- 整体 AQI */

test('取各污染物 IAQI 的最大值作为 AQI', () => {
  const r = A.fromCurrent({ pm2_5: 75, pm10: 50 });
  assert.equal(r.aqi, 100);
  assert.equal(r.primary, 'PM2.5');

  const r2 = A.fromCurrent({ pm2_5: 35, pm10: 200 });
  assert.equal(r2.aqi, 125);
  assert.equal(r2.primary, 'PM10');
});

test('AQI ≤ 50 时不报首要污染物', () => {
  // 国标这么规定：空气够好的时候报"首要污染物"只会让人误解
  const r = A.fromCurrent({ pm2_5: 20 });
  assert.equal(r.aqi, 29);
  assert.equal(r.primary, null);
  assert.equal(r.level.name, '优');
});

test('一氧化碳按 μg/m³ 传入、换算成 mg/m³ 再查表', () => {
  // 上游给的单位是 μg/m³，国标表是 mg/m³，差了 1000 倍，弄错会严重影响 AQI
  const r = A.fromCurrent({ carbon_monoxide: 2000 });   // 2 mg/m³
  assert.equal(r.aqi, 50);
  const high = A.fromCurrent({ carbon_monoxide: 20000 }); // 20 mg/m³
  assert.ok(high.aqi > 150, `CO 20 mg/m³ 应当超过 150，实际 ${high.aqi}`);
});

test('没有可用浓度时返回 null，不编造空气质量', () => {
  assert.equal(A.fromCurrent(null), null);
  assert.equal(A.fromCurrent({}), null);
  assert.equal(A.fromCurrent({ unknown_pollutant: 99 }), null);
});

test('明细按 IAQI 从高到低排，且只列存在的污染物', () => {
  const r = A.fromCurrent({ pm2_5: 75, pm10: 50, ozone: 100, nitrogen_dioxide: 40 });
  assert.equal(r.detail.length, 4);
  for (let i = 1; i < r.detail.length; i++) {
    assert.ok(r.detail[i - 1].iaqi >= r.detail[i].iaqi, '明细必须降序');
  }
  assert.equal(r.detail[0].name, 'PM2.5');
  // 每个明细项都要带单位和数值，界面上要显示
  for (const d of r.detail) {
    assert.ok(d.name && d.unit && typeof d.value === 'number');
  }
});

/* ---------------------------------------------------------------- 六级分类 */

test('六级分类的边界值归属正确', () => {
  // 边界值最容易差一档：50 是"优"，51 就是"良"
  const cases = [[0, '优'], [50, '优'], [51, '良'], [100, '良'], [101, '轻度污染'],
    [150, '轻度污染'], [151, '中度污染'], [200, '中度污染'], [201, '重度污染'],
    [300, '重度污染'], [301, '严重污染'], [500, '严重污染']];
  for (const [aqi, name] of cases) {
    assert.equal(A.levelOf(aqi).name, name, `AQI ${aqi} 应当是「${name}」`);
  }
});

test('每一级都有配色和健康建议', () => {
  for (const lv of A.LEVELS) {
    assert.match(lv.color, /^#[0-9a-f]{6}$/i, `${lv.name} 的颜色不合法`);
    assert.ok(lv.advice.length > 5, `${lv.name} 应当有健康建议`);
  }
  // 配色要能从绿到红，不能有重复
  const colors = A.LEVELS.map((l) => l.color);
  assert.equal(new Set(colors).size, colors.length, '各级颜色不该重复');
});

/* ------------------------------------------------------------ 24 小时滑动平均 */

test('滑动平均的前 23 个位置为 null（凑不满一个窗口）', () => {
  const vals = Array.from({ length: 30 }, (_, i) => i + 1);
  const rm = A.rollingMean(vals, 24);
  assert.equal(rm.length, 30);
  for (let i = 0; i < 23; i++) assert.equal(rm[i], null, `第 ${i} 个应当还是 null`);
  assert.equal(rm[23], 12.5);              // 1..24 的均值
  assert.equal(rm[29], 18.5);              // 7..30 的均值
});

test('滑动平均跳过缺报值而不是当成 0', () => {
  // 把缺报当 0 会把均值拉低，AQI 就白白变好了
  const vals = [10, null, 10, 10];
  const rm = A.rollingMean(vals, 3);
  assert.equal(rm[2], 10);      // (10 + 10) / 2，不是 20/3
  assert.equal(rm[3], 10);
});

test('趋势序列在数据不足时退回实时值，并标注不可靠', () => {
  const hourly = {
    time: ['2026-09-27T00:00', '2026-09-27T01:00'],
    pm2_5: [75, 75],
    pm10: [50, 50],
  };
  const t = A.trendFromHourly(hourly);
  assert.equal(t.length, 2);
  assert.equal(t[0].aqi, 100);
  assert.equal(t[0].reliable, false, '不足 24 小时应当标为不可靠');
});

/* -------------------------------------------------------------------- 预警 */

/** 造一份最小可用的规范化预报 */
function forecast(over) {
  const base = {
    current: { temp: 20, wind: 10, code: 1 },
    today: { high: 25, low: 15, uvMax: 5, gust: 20 },
    daily: [
      { code: 1, high: 25, low: 15, precip: 0, snow: 0, gust: 20, uvMax: 5, wind: 10 },
      { code: 2, high: 26, low: 16, precip: 0, snow: 0, gust: 22, uvMax: 5, wind: 11 },
      { code: 3, high: 24, low: 14, precip: 0, snow: 0, gust: 25, uvMax: 4, wind: 12 },
    ],
    rawHours: [],
  };
  return Object.assign({}, base, over || {});
}

test('温和天气不产生任何预警', () => {
  assert.deepEqual(Alerts.derive(forecast()), []);
});

test('高温按 35 / 37 / 40 三档分级', () => {
  const at = (h) => Alerts.derive(forecast({
    daily: [{ code: 0, high: h, low: 20, precip: 0, snow: 0, gust: 10, uvMax: 5 }],
  }))[0];

  assert.equal(at(34), undefined, '34°C 不该报高温');
  assert.equal(at(35).level, 'yellow');
  assert.equal(at(37).level, 'orange');
  assert.equal(at(40).level, 'red');
  assert.equal(at(35).kind, 'heat');
});

test('寒潮要求「明显降温」和「确实冷」同时成立', () => {
  // 夏天一次普通降温不该报寒潮，所以最低气温必须也低
  const warmDrop = Alerts.derive(forecast({
    daily: [
      { code: 1, high: 32, low: 26, precip: 0, snow: 0, gust: 10, uvMax: 5 },
      { code: 1, high: 28, low: 24, precip: 0, snow: 0, gust: 10, uvMax: 5 },
      { code: 1, high: 22, low: 20, precip: 0, snow: 0, gust: 10, uvMax: 5 },
    ],
  })).find((a) => a.kind === 'cold');
  assert.equal(warmDrop, undefined, '最低气温 20°C 不该报寒潮');

  const realCold = Alerts.derive(forecast({
    daily: [
      { code: 1, high: 12, low: 3, precip: 0, snow: 0, gust: 10, uvMax: 3 },
      { code: 1, high: 6, low: -2, precip: 0, snow: 0, gust: 10, uvMax: 3 },
      { code: 1, high: 2, low: -6, precip: 0, snow: 0, gust: 10, uvMax: 3 },
    ],
  })).find((a) => a.kind === 'cold');
  assert.ok(realCold, '降温 10°C 且最低 -6°C，应当报寒潮');
  assert.equal(realCold.level, 'orange');
});

test('大风按蒲福风级分级，阵风优先于平均风', () => {
  const at = (gust) => Alerts.derive(forecast({
    daily: [{ code: 1, high: 20, low: 10, precip: 0, snow: 0, gust, uvMax: 3 }],
  })).find((a) => a.kind === 'wind');

  /* 蒲福风级换算：8 级 ≥62、9 级 ≥75、10 级 ≥89、11 级 ≥103、12 级 ≥118 km/h。
     预警分级按国标：8 级蓝色，9–10 级黄色/橙色，11 级以上红色。 */
  assert.equal(at(55), undefined, '55 km/h 约 7 级，不到大风预警量级');
  assert.equal(at(62).level, 'blue');     // 8 级
  assert.equal(at(75).level, 'yellow');   // 9 级
  assert.equal(at(90).level, 'orange');   // 10 级
  assert.equal(at(120).level, 'red');     // 12 级
  assert.equal(at(120).headline, '阵风可达 12 级');
});

test('暴雨按日累计降水量分级', () => {
  const at = (precip) => Alerts.derive(forecast({
    daily: [{ code: 65, high: 20, low: 10, precip, snow: 0, gust: 10, uvMax: 3 }],
  })).find((a) => a.kind === 'rain');

  assert.equal(at(20), undefined, '20 mm 不到暴雨量级');
  assert.equal(at(30).level, 'yellow');
  assert.equal(at(60).level, 'orange');
  assert.equal(at(120).level, 'red');
});

test('雷电：有雷暴码，或 CAPE 足够高', () => {
  const byCode = Alerts.derive(forecast({
    daily: [{ code: 95, high: 28, low: 18, precip: 5, snow: 0, gust: 20, uvMax: 5 }],
  })).find((a) => a.kind === 'storm');
  assert.ok(byCode, '天气码 95 应当报雷电');

  const byCape = Alerts.derive(forecast({
    rawHours: [{ cape: 1800 }],
  })).find((a) => a.kind === 'storm');
  assert.ok(byCape, 'CAPE 1800 应当报雷电');
  assert.equal(byCape.level, 'blue', '仅凭 CAPE 只给最低级别');

  const none = Alerts.derive(forecast({ rawHours: [{ cape: 200 }] }));
  assert.equal(none.find((a) => a.kind === 'storm'), undefined);
});

test('大雾按能见度分级，天气码兜底', () => {
  const at = (visibility) => Alerts.derive(forecast({
    rawHours: [{ visibility }],
  })).find((a) => a.kind === 'fog');

  assert.equal(at(3000), undefined);
  assert.equal(at(400).level, 'orange');
  assert.equal(at(150).level, 'red');
  // 没有能见度数据时，天气码 45（雾）给最低级别
  const byCode = Alerts.derive(forecast({
    daily: [{ code: 45, high: 15, low: 8, precip: 0, snow: 0, gust: 10, uvMax: 2 }],
  })).find((a) => a.kind === 'fog');
  assert.equal(byCode.level, 'yellow');
});

test('空气重污染并入预警，且必须有空气质量数据才报', () => {
  /* 注意这里传的是**浓度**不是 AQI，两者不是一回事：
     PM2.5 浓度 300 μg/m³ 对应 IAQI 400（严重污染），不是 AQI 300。
     这个换算关系最容易搞混，所以两档都验一遍。 */
  const moderate = A.fromCurrent({ pm2_5: 76 });   // IAQI ≈ 101 → 轻度污染，不该报
  assert.equal(moderate.level.name, '轻度污染');
  assert.equal(Alerts.derive(forecast(), moderate).find((a) => a.kind === 'haze'), undefined,
    '轻度污染不到预警量级');

  const heavy = A.fromCurrent({ pm2_5: 180 });     // IAQI ≈ 227 → 重度污染
  assert.equal(heavy.level.name, '重度污染');
  const warn = Alerts.derive(forecast(), heavy).find((a) => a.kind === 'haze');
  assert.ok(warn, '重度污染应当报预警');
  assert.equal(warn.level, 'orange');

  const severe = A.fromCurrent({ pm2_5: 300 });    // IAQI 400 → 严重污染
  assert.equal(severe.level.name, '严重污染');
  assert.equal(Alerts.derive(forecast(), severe).find((a) => a.kind === 'haze').level, 'red');

  assert.equal(Alerts.derive(forecast(), null).find((a) => a.kind === 'haze'), undefined,
    '没有空气质量数据时不该猜');
});

test('预警按严重程度排序，同级顺序稳定', () => {
  const list = Alerts.derive(forecast({
    daily: [
      { code: 95, high: 38, low: 22, precip: 60, snow: 0, gust: 95, uvMax: 11 },
      { code: 95, high: 38, low: 22, precip: 60, snow: 0, gust: 95, uvMax: 11 },
      { code: 95, high: 38, low: 22, precip: 60, snow: 0, gust: 95, uvMax: 11 },
    ],
  }));
  assert.ok(list.length >= 5, `应当报出多项，实际 ${list.length}`);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].rank >= list[i].rank, '必须按级别降序');
  }
  // 每一项都要能说清依据，界面上要显示为什么报这一条
  for (const a of list) {
    assert.ok(a.headline && a.detail && a.basis && a.color);
    assert.ok(a.kindName && a.levelLabel);
  }
});

test('worst 与 summary 给出最高级别和一句话概述', () => {
  assert.equal(Alerts.worst([]), null);
  assert.match(Alerts.summary([]), /没有达到预警量级/);

  const list = Alerts.derive(forecast({
    daily: [{ code: 95, high: 38, low: 22, precip: 60, snow: 0, gust: 95, uvMax: 11 }],
  }));
  const w = Alerts.worst(list);
  assert.equal(w.rank, Math.max.apply(null, list.map((a) => a.rank)));
  assert.ok(Alerts.summary(list).length > 3);
});

test('缺失字段不会让预警推导崩掉', () => {
  assert.deepEqual(Alerts.derive(null), []);
  assert.deepEqual(Alerts.derive({}), []);
  assert.deepEqual(Alerts.derive({ daily: [] }), []);
  // 日值全是 null 时也不该报任何东西
  assert.deepEqual(Alerts.derive({ daily: [{ code: null, high: null, low: null }], rawHours: [] }), []);
});
