/* 云图 · 核心逻辑测试
 *
 * 跑法：node --test test/   （或 npm test）
 *
 * 测的都是「算错了但界面照常渲染」的那类地方：
 * 单位换算、天气码到基调的映射、按当前时刻切 24 小时、公共温度轴、
 * 曲线路径的除零、收藏排重、脏数据容错。
 * 这些东西肉眼看不出来——页面上一串数字永远看着"是对的"。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

/* ------------------------------------------------------------------ 单位换算 */

test('摄氏转华氏取整，非数字返回 null', () => {
  assert.equal(C.convertTemp(0, 'c'), 0);
  assert.equal(C.convertTemp(0, 'f'), 32);
  assert.equal(C.convertTemp(100, 'f'), 212);
  assert.equal(C.convertTemp(20.4, 'c'), 20);
  assert.equal(C.convertTemp(20.5, 'c'), 21);   // 四舍五入，不是截断
  assert.equal(C.convertTemp(-40, 'f'), -40);   // 两个刻度相等的那个点
  assert.equal(C.convertTemp(NaN, 'c'), null);
  assert.equal(C.convertTemp(null, 'c'), null);      // isFinite(null) 是 true，这里必须显式挡掉
  assert.equal(C.convertTemp(undefined, 'c'), null);
  assert.equal(C.convertTemp('20', 'c'), null);      // 字符串不是数字，不静默转换
});

test('风速换算：公制原样、英制除 1.609344', () => {
  assert.equal(C.windIn(5.9, 'c'), 5.9);
  assert.equal(C.windIn(16.09344, 'f'), 10);
  assert.equal(C.windLabel('f'), 'mph');
  assert.equal(C.windLabel('c'), 'km/h');
  assert.equal(C.windIn(undefined, 'c'), null);
});

test('气压：公制给 hPa，英制给 inHg 并附带另一种单位', () => {
  assert.deepEqual(C.pressureIn(1013.2, 'c'), { value: 1013, unit: 'hPa', alt: '29.9 inHg' });
  const f = C.pressureIn(1013.2, 'f');
  assert.equal(f.unit, 'inHg');
  assert.equal(f.value, 29.9);
  assert.equal(f.alt, '1013 hPa');
  assert.equal(C.pressureIn(null, 'c'), null);
});

/* ------------------------------------------------------------------ 风 */

test('风向取 8 方位，边界落在正确的一侧', () => {
  assert.equal(C.windDir(0), '北');
  assert.equal(C.windDir(22), '北');     // 22.5 以下仍是北
  assert.equal(C.windDir(23), '东北');
  assert.equal(C.windDir(90), '东');
  assert.equal(C.windDir(180), '南');
  assert.equal(C.windDir(270), '西');
  assert.equal(C.windDir(359), '北');    // 环绕
  assert.equal(C.windDir(-10), '北');
  assert.equal(C.windDir(null), '—');
});

test('蒲福风级按风速下界取级，并给出中文名', () => {
  assert.equal(C.beaufort(0.5), 0);
  assert.equal(C.beaufort(1), 1);
  assert.equal(C.beaufort(5.9), 1);
  assert.equal(C.beaufort(6), 2);
  assert.equal(C.beaufort(20), 4);
  assert.equal(C.beaufort(120), 12);
  assert.equal(C.beaufort(null), null);
  assert.equal(C.beaufortWord(0), '无风');
  assert.equal(C.beaufortWord(4), '和风');
  assert.equal(C.beaufortWord(null), '—');
});

/* -------------------------------------------------------------- 天气码基调 */

test('天气码给出中文名与基调，未知码不编造天气', () => {
  assert.equal(C.describeCode(0).label, '晴');
  assert.equal(C.describeCode(0).tone, 'clear');
  assert.equal(C.describeCode(65).label, '大雨');
  assert.equal(C.describeCode(95).tone, 'storm');
  assert.equal(C.describeCode(1234).label, '观测缺报');
  assert.equal(C.describeCode(null).label, '观测缺报');
});

test('基调叠加昼夜：白天按天气分，夜里一律收敛到 night 系', () => {
  assert.equal(C.sky(0, true), 'clear');
  assert.equal(C.sky(3, true), 'overcast');
  assert.equal(C.sky(0, false), 'night');
  assert.equal(C.sky(3, false), 'night');
  assert.equal(C.sky(65, false), 'rain-night');
  assert.equal(C.sky(95, false), 'storm-night');
  assert.equal(C.sky(73, false), 'snow-night');
  // is_day 缺失或类型不对时，按夜间处理：
  // 宁可把晴夜画成夜空，也不要在半夜给用户一屏白天的暖色——后者是明显的错，
  // 而"把白天当夜里"最多是偏保守。
  assert.equal(C.sky(0, undefined), 'night');
  assert.equal(C.sky(0, null), 'night');
  assert.equal(C.sky(0, 1), 'night');        // 数值 1（上游给 0/1）不算 true
  assert.equal(C.sky(0, true), 'clear');
});

/* ------------------------------------------------------------ 地点规范化 */

test('正向搜索结果规范化：经纬度必须在，其余可空', () => {
  const p = C.normalizePlace({ id: 1808926, name: '杭州', latitude: 30.29, longitude: 120.16, admin1: '浙江', country: '中国', timezone: 'Asia/Shanghai' });
  assert.equal(p.name, '杭州');
  assert.equal(p.region, '浙江');
  assert.equal(p.id, '1808926');
  assert.equal(C.normalizePlace({ name: '没有坐标' }), null);
  assert.equal(C.normalizePlace(null), null);
});

test('反向地理编码字段也能吃：city / principalSubdivision / countryName', () => {
  const p = C.normalizePlace({ latitude: 30.27, longitude: 120.15, city: '杭州市', principalSubdivision: '浙江省', countryName: '中华人民共和国' });
  assert.equal(p.name, '杭州市');
  assert.equal(p.region, '浙江省');
  assert.equal(p.country, '中华人民共和国');
  assert.equal(p.id, '30.270,120.150');   // 没有上游 id 时用坐标当 id
});

test('反查结果里 locality 比 city 更具体时，取 locality 而不是市名', () => {
  // 反查的 city 是「杭州市」、locality 是「西湖区」。用户点定位是想知道自己在哪，
  // 说「杭州」不如说「西湖区」。这里锁住这个优先级，因为它很容易被顺手改错。
  const p = C.normalizePlace({
    latitude: 30.27, longitude: 120.15,
    city: '杭州市', locality: '西湖区',
    principalSubdivision: '浙江省', countryName: '中国',
  });
  assert.equal(p.name, '西湖区');
  assert.equal(p.city, '杭州市', '被跳过的 city 要转存成上级市，而不是丢掉');
});

test('地级市字段被保留下来，用于「吕梁市 · 山西省」这种层级显示', () => {
  const p = C.normalizePlace({ name: '临县', city: '吕梁市', admin1: '山西省', country: '中国', latitude: 37.95, longitude: 110.99 });
  assert.equal(p.city, '吕梁市');
  assert.equal(C.placeLabel(p), '吕梁市 · 山西省 · 中国');
});

test('地点说明会跳过与地名重复的层级', () => {
  // 查「吕梁」时地区名就是「吕梁市」，再写一遍只是啰嗦
  assert.equal(C.placeLabel({ name: '吕梁', city: '吕梁市', region: '山西省', country: '中国' }), '山西省 · 中国');
  assert.equal(C.placeLabel({ name: '吕梁市', city: null, region: '山西省', country: '中国' }), '山西省 · 中国');
  // 直辖市：省和市同名，只剩国家
  assert.equal(C.placeLabel({ name: '北京', city: null, region: '北京', country: '中国' }), '中国');
  // 什么都没有时不能返回空字符串
  assert.equal(C.placeLabel({ name: '某地', city: null, region: null, country: null }), '—');
});

test('收藏序列化带上地级市，往返之后层级信息不丢', () => {
  const place = C.normalizePlace({ name: '临县', city: '吕梁市', admin1: '山西省', country: '中国', latitude: 37.95, longitude: 110.99 });
  const back = C.parseSaved(C.serializeSaved([place]))[0];
  assert.equal(back.city, '吕梁市');
  assert.equal(C.placeLabel(back), '吕梁市 · 山西省 · 中国');
});

/* ------------------------------------------------------------ 观测规范化 */

/* 造一段和上游形状一致的数据：过去 1 小时 + 未来 29 小时。
   上游实际会给 past_hours=1 & forecast_hours=24，但既然它常返回多余的行，
   样本就故意多给几条——这样"丢弃缺报后仍能凑满 24 条"才测得到。 */
function sampleRaw() {
  const times = [];
  const start = Date.UTC(2026, 8, 27, 9);   // 2026-09-27 09:00
  for (let i = 0; i < 30; i++) {
    const d = new Date(start + i * 3600 * 1000);
    const iso = d.toISOString();
    times.push(`${iso.slice(0, 10)}T${iso.slice(11, 13)}:00`);
  }
  return {
    latitude: 30.29,
    longitude: 120.16,
    elevation: 12,
    timezone: 'Asia/Shanghai',
    utc_offset_seconds: 28800,
    current: {
      time: '2026-09-27T10:15',
      temperature_2m: 31,
      apparent_temperature: 34.2,
      relative_humidity_2m: 78,
      is_day: 1,
      weather_code: 1,
      wind_speed_10m: 5.9,
      wind_direction_10m: 20,
      surface_pressure: 1003.9,
      precipitation: 0,
    },
    hourly: {
      time: times,
      temperature_2m: times.map((_, i) => 20 + i * 0.1),
      weather_code: times.map(() => 1),
      precipitation_probability: times.map((_, i) => i * 4),
      wind_speed_10m: times.map(() => 5),
    },
    daily: {
      time: ['2026-09-27', '2026-09-28', '2026-09-29'],
      weather_code: [1, 61, 0],
      temperature_2m_max: [32.1, 28.4, 30],
      temperature_2m_min: [22.3, 20.1, 19.8],
      sunrise: ['2026-09-27T05:50', '2026-09-28T05:51', '2026-09-29T05:52'],
      sunset: ['2026-09-27T17:49', '2026-09-28T17:47', '2026-09-29T17:46'],
      precipitation_probability_max: [10, 80, 0],
      precipitation_sum: [0, 3.2, 0],
      wind_speed_10m_max: [12, 20, 9],
    },
  };
}

test('30 条逐小时数据切成「从此刻起 24 条」', () => {
  const norm = C.normalizeForecast(sampleRaw());
  assert.equal(norm.hours.length, 24);
  // 上游给的是 09:00 起 30 条，当前 10:15 → 从 10:00 开始正好 24 条
  assert.equal(norm.hours[0].time, '2026-09-27T10:00');
  assert.equal(norm.hours[23].time, '2026-09-28T09:00');
  assert.equal(norm.hours[0].temp, 20.1);
});

test('当前时刻不在 hourly 里时，退到之后的第一个整点', () => {
  const raw = sampleRaw();
  raw.current.time = '2026-09-27T10:30';   // 数据里只有整点
  const norm = C.normalizeForecast(raw);
  assert.equal(norm.hours[0].time, '2026-09-27T10:00');
});

test('缺报的小时整条丢弃，并且往后补齐，仍然凑满 24 条', () => {
  const raw = sampleRaw();
  raw.hourly.temperature_2m[5] = null;
  const norm = C.normalizeForecast(raw);
  assert.equal(norm.hours.length, 24);       // 不是 23：计数按收下的条数算
  assert.ok(norm.hours.every((h) => typeof h.temp === 'number'));
  assert.ok(!norm.hours.some((h) => h.time === raw.hourly.time[5]));
  assert.equal(norm.hours[23].time, '2026-09-28T10:00');  // 顺延一小时补上
});

test('观测规范化：current / today / daily 都拿到，缺字段置 null 而不是 NaN', () => {
  const norm = C.normalizeForecast(sampleRaw());
  assert.equal(norm.current.temp, 31);
  assert.equal(norm.current.isDay, true);
  assert.equal(norm.today.high, 32.1);
  assert.equal(norm.today.low, 22.3);
  assert.equal(norm.daily[1].weekday, '周一');
  assert.equal(norm.daily[0].monthDay, '9/27');
  assert.equal(norm.daily[1].pop, 80);
  assert.equal(norm.daily[0].sunrise, '05:50');

  const empty = C.normalizeForecast({ current: {}, hourly: {}, daily: {} });
  assert.equal(empty.current.temp, null);
  assert.equal(empty.hours.length, 0);
  assert.equal(empty.daily.length, 0);
  assert.equal(C.normalizeForecast(null), null);
});

test('is_day 为 0 时按夜间处理', () => {
  const raw = sampleRaw();
  raw.current.is_day = 0;
  assert.equal(C.normalizeForecast(raw).current.isDay, false);
});

/* -------------------------------------------------------------- 日期解析 */

test('日期解析不经过 Date 的时区转换', () => {
  const d = C.parseDay('2026-09-27');
  assert.equal(d.y, 2026);
  assert.equal(d.m, 9);
  assert.equal(d.d, 27);
  assert.equal(d.weekday, '周日');
  assert.equal(d.isWeekend, true);
  assert.equal(C.parseDay('2026-09-28').isWeekend, false);
  assert.equal(C.parseDay('2026-09-29').weekday, '周二');
  assert.equal(C.parseDay('坏数据'), null);
});

test('前三天说「今天/明天/后天」，之后回到星期', () => {
  assert.equal(C.relativeDay(0, '周日'), '今天');
  assert.equal(C.relativeDay(1, '周一'), '明天');
  assert.equal(C.relativeDay(2, '周二'), '后天');
  assert.equal(C.relativeDay(3, '周三'), '周三');
});

test('观测时间与报头文案', () => {
  assert.equal(C.formatObserved('2026-09-27T10:15'), '09/27 10:15');
  assert.equal(C.formatObserved(null), '—');
  assert.equal(C.formatDayHeading('2026-09-27'), '9月27日 · 周日');
  assert.equal(C.formatCoords(30.2936, 120.1614), '30.29°N 120.16°E');
  assert.equal(C.formatCoords(-33.87, -70.66), '33.87°S 70.66°W');
  assert.equal(C.hourOf('2026-09-27T07:00'), 7);
  assert.equal(C.hourOffsetLabel(0), '此刻');
  assert.equal(C.hourOffsetLabel(6), '+6h');
});

test('夜间判断：日出之前和日落之后都算夜里', () => {
  assert.equal(C.isNightHour('2026-09-27T03:00', '05:50', '17:49'), true);
  assert.equal(C.isNightHour('2026-09-27T12:00', '05:50', '17:49'), false);
  assert.equal(C.isNightHour('2026-09-27T20:00', '05:50', '17:49'), true);
  assert.equal(C.isNightHour('2026-09-27T12:00', null, null), false);
});

/* ------------------------------------------------------------------ 几何 */

test('数值轴对齐到 2 度一格，并保证至少有起伏', () => {
  assert.deepEqual(C.niceRange([20, 25], 1.5), { min: 18, max: 28 });
  assert.deepEqual(C.niceRange([10, 10], 1), { min: 8, max: 12 });   // 全同温也要留出量程
  assert.deepEqual(C.niceRange([], 1), { min: 0, max: 1 });          // 空数据不炸
  const r = C.niceRange([22.3, 32.1], 1.5);
  assert.ok(r.min < 22.3 && r.max > 32.1);
  assert.equal(r.min % 2, 0);
  assert.equal(r.max % 2, 0);
});

test('yAt 把温度映射到绘图区且不除零', () => {
  assert.equal(C.yAt(0, 0, 10, 100), 100);    // 最小值落在底部
  assert.equal(C.yAt(10, 0, 10, 100), 0);     // 最大值落在顶部
  assert.equal(C.yAt(5, 0, 10, 100), 50);
  assert.equal(C.yAt(5, 7, 7, 100), 50);      // 跨度为 0 → 中线
});

test('xAt 均匀分布，单点时落在 0 不除零', () => {
  assert.equal(C.xAt(0, 5, 400), 0);
  assert.equal(C.xAt(4, 5, 400), 400);
  assert.equal(C.xAt(2, 5, 400), 200);
  assert.equal(C.xAt(0, 1, 400), 0);
});

test('曲线路径：点够多时是三次贝塞尔，单点不产生曲线段', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 4 }, { x: 30, y: 12 }];
  const d = C.pathFrom(pts);
  assert.ok(d.startsWith('M 0 0'));
  assert.equal((d.match(/C/g) || []).length, 3);      // 段数 = 点数 - 1
  assert.ok(!/NaN|Infinity/.test(d));
  assert.equal(C.pathFrom([{ x: 5, y: 5 }]), 'M 5 5');
  assert.equal(C.pathFrom([]), '');
});

test('闭合区域回到起点 X 上的基线，形成可填充的封闭路径', () => {
  const pts = [{ x: 2, y: 8 }, { x: 12, y: 4 }];
  const a = C.areaFrom(pts, 20);
  assert.ok(a.endsWith('L 2 20 Z'));
  assert.ok(a.includes('L 12 20'));
});

test('游标取最近点，越界会被夹住', () => {
  assert.equal(C.nearestIndex(0, 24, 800), 0);
  assert.equal(C.nearestIndex(800, 24, 800), 23);
  assert.equal(C.nearestIndex(-50, 24, 800), 0);
  assert.equal(C.nearestIndex(9999, 24, 800), 23);
  assert.equal(C.nearestIndex(400, 24, 800), 12);   // 正中间
  assert.equal(C.nearestIndex(100, 1, 800), 0);
});

test('刻度步长随量程放大，不产生几十条刻度', () => {
  const small = C.ticks(18, 28, 5);
  assert.deepEqual(small, [20, 25]);                 // 量程 10 度 → 5 度一格
  const big = C.ticks(-10, 40, 5);
  assert.ok(big.length <= 7);
  assert.ok(big.every((v) => v % 10 === 0));
  assert.deepEqual(C.ticks(0, 0, 5), [0]);
});

/* ------------------------------------------------------------------ 收藏 */

const HZ = C.normalizePlace({ id: 1, name: '杭州', latitude: 30.2936, longitude: 120.1614, admin1: '浙江' });
const HZ_SC = C.normalizePlace({ id: 2, name: '杭州', latitude: 30.0651, longitude: 102.1952, admin1: '四川' });
const BJ = C.normalizePlace({ id: 3, name: '北京', latitude: 39.9042, longitude: 116.4074 });

test('同名的两个「杭州」互不覆盖——按经纬度排重而不是按名字', () => {
  const list = C.addSaved([], HZ);
  const both = C.addSaved(list, HZ_SC);
  assert.equal(both.length, 2);
  assert.ok(C.hasSaved(both, HZ_SC));
});

test('重复收藏只把它提到最前，不产生第二条', () => {
  let list = C.addSaved([], HZ);
  list = C.addSaved(list, BJ);
  assert.deepEqual(list.map((p) => p.name), ['北京', '杭州']);
  list = C.addSaved(list, HZ);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((p) => p.name), ['杭州', '北京']);
});

test('收藏上限 12 条，超出后挤掉最旧的', () => {
  let list = [];
  for (let i = 0; i < 20; i++) {
    list = C.addSaved(list, C.normalizePlace({ name: '城市' + i, latitude: 20 + i, longitude: 100 + i }));
  }
  assert.equal(list.length, C.MAX_SAVED);
  assert.equal(list[0].name, '城市19');
  assert.ok(!list.some((p) => p.name === '城市0'));
});

test('移除只删掉匹配的那一个', () => {
  const list = C.addSaved(C.addSaved([], HZ), HZ_SC);
  const after = C.removeSaved(list, HZ_SC);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, '杭州');
  assert.equal(C.removeSaved([], HZ).length, 0);
});

test('localStorage 里的脏数据一律退回空列表，不让一条坏记录打挂页面', () => {
  assert.deepEqual(C.parseSaved('不是 JSON'), []);
  assert.deepEqual(C.parseSaved('{"a":1}'), []);
  assert.deepEqual(C.parseSaved(null), []);
  assert.deepEqual(C.parseSaved('[]'), []);
  const ok = C.parseSaved(JSON.stringify([{ name: '杭州', latitude: 30.29, longitude: 120.16 }]));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, '杭州');
  // 混进一条没有坐标的坏数据：丢掉它，保住好的那条
  const mixed = C.parseSaved(JSON.stringify([{ name: '杭州', latitude: 30.29, longitude: 120.16 }, { name: '坏的' }]));
  assert.equal(mixed.length, 1);
});

test('收藏序列化只留必要字段，且能往返', () => {
  const json = C.serializeSaved([HZ]);
  assert.ok(!json.includes('population'));
  const back = C.parseSaved(json);
  assert.equal(back[0].name, '杭州');
  assert.ok(C.samePlace(back[0], HZ));
});

/* -------------------------------------------------------------- 观测结论 */

test('观测结论只在有依据时才说，且不超过三条', () => {
  const raw = sampleRaw();
  raw.current.temperature_2m = 32;      // 正好是今日最高
  raw.current.apparent_temperature = 36;
  raw.current.relative_humidity_2m = 90;
  const note = C.observation(C.normalizeForecast(raw), 'c');
  assert.ok(note.includes('今日最高'));
  assert.ok(note.includes('体感偏热'));
  assert.ok(note.includes('空气接近饱和'));
  assert.ok(note.split('；').length <= 3);

  const quiet = C.normalizeForecast({ current: {}, hourly: {}, daily: {} });
  assert.equal(C.observation(quiet, 'c'), '');
  assert.equal(C.observation(null, 'c'), '');
});

test('大风会在结论里点名风级', () => {
  const raw = sampleRaw();
  raw.current.wind_speed_10m = 45;
  const note = C.observation(C.normalizeForecast(raw), 'c');
  assert.ok(note.includes('风'));
  assert.ok(note.includes('注意风力'));
});

/* ------------------------------------------------------------------ 契约 */

test('上游字段清单和 server.js 请求的字段保持一致', () => {
  assert.ok(C.FORECAST_FIELDS.current.includes('surface_pressure'));
  assert.ok(C.FORECAST_FIELDS.hourly.includes('precipitation_probability'));
  assert.ok(C.FORECAST_FIELDS.daily.includes('sunrise'));
  assert.equal(C.FORECAST_DAYS, 7);
  assert.equal(C.HOURS_AHEAD, 24);
});
